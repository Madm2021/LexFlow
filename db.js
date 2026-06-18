'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { MAPPING } = require('./mapping');

const DB_PATH = process.env.LEXFLOW_DB || path.join(__dirname, 'data', 'lexflow.db');

// Garante que a pasta do banco existe (ex.: o disco /data no Render).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Ajustes para rodar LEVE numa máquina com RAM limitada (~24 GB), sem travar.
// - WAL + synchronous=NORMAL: rápido e seguro para gravar lotes.
// - cache_size = 128 MB e mmap_size = 256 MB (modestos): o índice/FTS guiam as
//   consultas, então não precisamos de cache gigante. O sistema operacional
//   ainda faz cache de disco (reciclável) por cima.
// - NÃO usamos temp_store=MEMORY: operações grandes mandam temporárias para o
//   disco (volume de 1 TB), em vez de estourar a memória.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -131072');
db.pragma('mmap_size = 268435456');

// Constantes de esquema vêm de schema.js (compartilhadas com o worker).
const { COLUMNS, COLUMN_KEYS, FILTER_KEYS, META_COLUMNS } = require('./schema');

// SQL da tabela principal (schema fixo: controle + colunas do de-para).
function createRecordsTable(ifNotExists) {
  const dataCols = COLUMN_KEYS.map((k) => `  "${k}" TEXT`).join(',\n');
  db.exec(`
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS' : ''} records (
      _rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
      _source_file TEXT,
      _imported_at TEXT,
      _hash        TEXT NOT NULL UNIQUE,
      _search      TEXT,
${dataCols}
    );
  `);
}

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
}
function tableExists(table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

// ---------------------------------------------------------------------------
// MIGRAÇÃO da base antiga (schema "largo" + jurimetria) para o novo schema
// enxuto. Roda uma única vez, na inicialização. Mapeia as colunas de origem
// para as colunas-destino (de-para), preserva o _hash (deduplicação) e descarta
// as colunas de pontuação. Tudo numa transação: se algo falhar, nada muda.
// ATENÇÃO: durante a migração o banco chega a ocupar ~2x (cópia temporária).
// Garanta espaço em disco sobrando (ex.: aumente o disco no Render).
// ---------------------------------------------------------------------------
function migrateLegacyIfNeeded() {
  if (!tableExists('records')) return false;            // instalação nova
  const cols = tableColumns('records');
  if (cols.includes('_search')) return false;           // já está no schema novo

  console.log('LexFlow: detectada base no formato antigo — migrando para o schema enxuto...');
  const legacyCols = new Set(cols);
  const q = (s) => `"${s}"`;

  // Expressão de valor de uma coluna-destino (COALESCE das origens presentes).
  const valueExpr = (field) => {
    const present = field.sources.filter((s) => legacyCols.has(s));
    if (present.length === 0) return 'NULL';
    if (present.length === 1) return q(present[0]);
    return `COALESCE(${present.map(q).join(', ')})`;
  };

  // Expressão do texto de busca (todos os campos + dígitos do CPF + origem).
  const cpfField = MAPPING.find((f) => f.key === 'cpf');
  const cpfExpr = cpfField ? valueExpr(cpfField) : "''";
  const cpfDigits = `replace(replace(replace(replace(${cpfExpr}, '.', ''), '-', ''), ' ', ''), '/', '')`;
  const searchPieces = MAPPING.map((f) => `COALESCE(${valueExpr(f)}, '')`);
  searchPieces.push(`COALESCE(${cpfDigits}, '')`);
  searchPieces.push("COALESCE(_source_file, '')");
  const searchExpr = `lower(${searchPieces.join(" || ' ' || ")})`;

  const insertCols = ['_source_file', '_imported_at', '_hash', ...COLUMN_KEYS, '_search'];
  const selectExprs = [
    '_source_file', '_imported_at', '_hash',
    ...MAPPING.map((f) => valueExpr(f)),
    searchExpr,
  ];

  const migrate = db.transaction(() => {
    db.exec('ALTER TABLE records RENAME TO _records_legacy');
    createRecordsTable(false);
    db.exec(
      `INSERT OR IGNORE INTO records (${insertCols.map(q).join(', ')})
       SELECT ${selectExprs.join(', ')} FROM _records_legacy`,
    );
    db.exec('DROP TABLE _records_legacy');
    db.exec('DROP TABLE IF EXISTS columns');
    db.exec('DROP TABLE IF EXISTS meta');
  });
  migrate();
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignora */ }
  // Não rodamos VACUUM automático: em bases de milhões de linhas ele é lento e
  // pesado, e o espaço em disco geralmente não é o gargalo. As páginas
  // liberadas pela tabela antiga ficam reutilizáveis dentro do próprio arquivo.
  // Se algum dia quiser reduzir o arquivo, rode `VACUUM` manualmente fora do
  // horário de uso.
  const n = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
  console.log(`LexFlow: migração concluída — ${n.toLocaleString('pt-BR')} registros no novo formato.`);
  return true;
}

migrateLegacyIfNeeded();

// Tabela principal (cria se ainda não existir) e histórico de importações.
createRecordsTable(true);
db.exec(`
  CREATE TABLE IF NOT EXISTS imports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file  TEXT NOT NULL,
    sheet_name   TEXT,
    rows_added   INTEGER NOT NULL,
    rows_skipped INTEGER NOT NULL,
    imported_at  TEXT NOT NULL
  );

  -- Cache persistente (ex.: distribuição sem filtro já calculada). Sobrevive a
  -- reinícios; é limpo quando os dados mudam (import/remoção).
  CREATE TABLE IF NOT EXISTS app_cache (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Índice full-text para busca global (qualquer palavra, sem acento). Usa
// "external content" (não duplica os dados) e triggers para manter sincronia.
// Se a tabela FTS ainda não existia (1ª vez / pós-migração), precisamos
// reconstruí-la a partir dos dados já presentes em "records".
const ftsExisted = tableExists('records_fts');
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
    _search,
    content='records',
    content_rowid='_rowid',
    tokenize="unicode61 remove_diacritics 2"
  );

  CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts(rowid, _search) VALUES (new._rowid, new._search);
  END;
  CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, _search) VALUES('delete', old._rowid, old._search);
  END;
  CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, _search) VALUES('delete', old._rowid, old._search);
    INSERT INTO records_fts(rowid, _search) VALUES (new._rowid, new._search);
  END;
`);

// Índices para filtro por coluna (estado, município, bairro, sexo). COLLATE
// NOCASE permite que o filtro por prefixo (LIKE 'x%') use o índice.
for (const k of FILTER_KEYS) {
  if (COLUMN_KEYS.includes(k)) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${k} ON records("${k}" COLLATE NOCASE)`);
  }
}

// Higienização: _cpf_ok marca a validade do CPF (1 válido, 0 inválido, NULL =
// ainda não processado). Índice parcial só sobre os já processados (fica vazio
// e instantâneo até a higienização rodar) — acelera o filtro "Apenas CPF válido".
if (!tableColumns('records').includes('_cpf_ok')) {
  db.exec('ALTER TABLE records ADD COLUMN _cpf_ok INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_cpf_ok ON records(_cpf_ok) WHERE _cpf_ok IS NOT NULL');

// Popula o índice full-text a partir dos dados existentes quando a tabela FTS
// acabou de ser criada (1ª vez ou logo após a migração). Em reinícios normais
// o índice já está populado (mantido pelos triggers), então não reconstrói.
if (!ftsExisted) {
  try {
    const rc = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
    if (rc > 0) {
      console.log('LexFlow: construindo o índice de busca (full-text)...');
      db.exec("INSERT INTO records_fts(records_fts) VALUES('rebuild')");
      console.log('LexFlow: índice de busca pronto.');
    }
  } catch (e) {
    console.error('LexFlow: falha ao construir o índice de busca:', e.message);
  }
}

module.exports = { db, DB_PATH, COLUMNS, COLUMN_KEYS, FILTER_KEYS, META_COLUMNS };
