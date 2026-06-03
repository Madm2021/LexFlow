'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.LEXFLOW_DB || path.join(__dirname, 'data', 'lexflow.db');

// Garante que a pasta do banco existe (ex.: o disco /data no Render).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
// Ajustes de desempenho para importar milhões de linhas sem ficar lento:
// - WAL + synchronous=NORMAL: seguro (não corrompe) e muito mais rápido para
//   gravar lotes, pois evita um fsync a cada transação (importante no volume
//   de rede do Railway).
// - cache_size negativo = KB: 2 GB de cache de páginas mantêm o índice de
//   duplicidade (_hash) inteiro "quente" na memória — esse índice é o que mais
//   pesa conforme a base cresce. Dimensionado para o serviço com 24 GB de RAM;
//   o SQLite só usa de fato o que precisar (cresce sob demanda).
// - mmap_size: 8 GB do banco mapeados em memória, acelerando muito a leitura.
// - temp_store=MEMORY: ordenações/temporárias na RAM em vez de disco.
// Para servidores com pouca RAM (≤1 GB), reduza cache_size para -98304 (96 MB)
// e mmap_size para 268435456 (256 MB).
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -2097152');
db.pragma('mmap_size = 8589934592');

// Modelo unificado: TODAS as planilhas alimentam uma única tabela "records".
// - "columns" é o catálogo da união de colunas vistas em todos os arquivos.
// - "imports" guarda o histórico de cada importação (quantas linhas entraram
//   e quantas foram ignoradas por já existirem).
// - "records" tem colunas fixas de controle + colunas dinâmicas (uma por
//   coluna do catálogo), adicionadas via ALTER TABLE conforme aparecem.
//   "_hash" é a impressão digital da linha, com índice único: é o que impede
//   a inserção de linhas duplicadas (INSERT OR IGNORE).
db.exec(`
  CREATE TABLE IF NOT EXISTS columns (
    column_name   TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    data_type     TEXT NOT NULL,
    position      INTEGER NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS imports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file  TEXT NOT NULL,
    sheet_name   TEXT,
    rows_added   INTEGER NOT NULL,
    rows_skipped INTEGER NOT NULL,
    imported_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS records (
    _rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
    _source_file TEXT,
    _imported_at TEXT,
    _hash        TEXT NOT NULL UNIQUE
  );
`);

// Colunas pré-calculadas para acelerar a Prospecção em bases grandes:
// _potencial (nota = taxa de êxito), _obito (0/1) e _classificado (CID consta na
// base de jurimetria? 0/1). São preenchidas em segundo plano.
const tableCols = db.prepare('PRAGMA table_info(records)').all().map((c) => c.name);
if (!tableCols.includes('_potencial')) db.exec('ALTER TABLE records ADD COLUMN _potencial INTEGER');
if (!tableCols.includes('_obito')) db.exec('ALTER TABLE records ADD COLUMN _obito INTEGER');
if (!tableCols.includes('_classificado')) db.exec('ALTER TABLE records ADD COLUMN _classificado INTEGER');
// _excluir = 1 quando o caso não deve aparecer na prospecção (óbito, ou sem
// direito: contribuinte individual/facultativo, ou aposentado).
if (!tableCols.includes('_excluir')) db.exec('ALTER TABLE records ADD COLUMN _excluir INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_prospect ON records(_obito, _potencial)');
db.exec('CREATE INDEX IF NOT EXISTS idx_prospect2 ON records(_excluir, _potencial)');

// Tabela de metadados internos (ex.: versão da lógica de pontuação).
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

// Colunas de controle que existem sempre (não vêm das planilhas).
const META_COLUMNS = new Set(['_rowid', '_source_file', '_imported_at', '_hash', '_potencial', '_obito', '_classificado', '_excluir']);

module.exports = { db, DB_PATH, META_COLUMNS };
