'use strict';

const { db, COLUMNS, COLUMN_KEYS, FILTER_KEYS } = require('./db');

// Colunas baixa-cardinalidade que viram dropdown de filtro no front-end.
const DISTINCT_KEYS = ['estado_funcionario', 'sexo'];

// ---------------------------------------------------------------------------
// Cache leve: o total de registros (sem filtro) só muda quando os dados mudam.
// ---------------------------------------------------------------------------
let dataVersion = 1;
function bumpData() { dataVersion += 1; }
const memo = {};
function cached(key, fn) {
  if (memo[key] && memo[key].v === dataVersion) return memo[key].value;
  const value = fn();
  memo[key] = { v: dataVersion, value };
  return value;
}

// ---------------------------------------------------------------------------
// CPF: recupera zeros à esquerda (todo CPF tem 11 dígitos) e formata como
// 000.000.000-00. Vazio continua vazio; >11 dígitos (CNPJ/lixo) fica intacto.
// ---------------------------------------------------------------------------
function formatCPF(v) {
  if (v == null) return v;
  const s = String(v).trim();
  if (s === '') return null;
  const d = s.replace(/\D/g, '');
  if (d.length === 0 || d.length > 11) return s;
  const p = d.padStart(11, '0');
  return `${p.slice(0, 3)}.${p.slice(3, 6)}.${p.slice(6, 9)}-${p.slice(9)}`;
}

// Texto concatenado para a busca full-text: todos os campos + dígitos do CPF +
// o nome do arquivo de origem. Em minúsculas (o FTS já ignora acentos).
function buildSearchText(values, sourceFile) {
  const parts = [];
  for (const k of COLUMN_KEYS) {
    const v = values[k];
    if (v != null && v !== '') parts.push(String(v));
  }
  if (values.cpf) {
    const digits = String(values.cpf).replace(/\D/g, '');
    if (digits) parts.push(digits);
  }
  if (sourceFile) parts.push(sourceFile);
  return parts.join(' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Inserção (usada pelo importador). Schema fixo → um único INSERT preparado.
// ---------------------------------------------------------------------------
const INSERT_COLS = ['_source_file', '_imported_at', '_hash', '_search', ...COLUMN_KEYS];
const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO records (${INSERT_COLS.map((c) => `"${c}"`).join(', ')})
   VALUES (${INSERT_COLS.map(() => '?').join(', ')})`,
);

// Insere uma linha já mapeada. Retorna 1 se entrou, 0 se era duplicada.
function insertRow({ sourceFile, importedAt, hash, values }) {
  const search = buildSearchText(values, sourceFile);
  const info = insertStmt.run(
    sourceFile, importedAt, hash, search,
    ...COLUMN_KEYS.map((k) => (values[k] == null || values[k] === '' ? null : values[k])),
  );
  return info.changes;
}

function recordImport(sourceFile, sheetName, rowsAdded, rowsSkipped) {
  db.prepare(
    'INSERT INTO imports (source_file, sheet_name, rows_added, rows_skipped, imported_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sourceFile, sheetName || null, rowsAdded, rowsSkipped, new Date().toISOString());
  bumpData();
}

// ---------------------------------------------------------------------------
// Catálogo de colunas e estatísticas.
// ---------------------------------------------------------------------------
function getColumns() {
  return COLUMNS.map((c) => ({ column_name: c.key, original_name: c.label }));
}

function getStats() {
  return cached('stats', () => ({
    records: db.prepare('SELECT COUNT(*) AS n FROM records').get().n,
    columns: COLUMN_KEYS.length,
    imports: db.prepare('SELECT COUNT(*) AS n FROM imports').get().n,
  }));
}

// Valores distintos de uma coluna de filtro (para os dropdowns do front).
function distinctValues(col) {
  if (!DISTINCT_KEYS.includes(col)) return [];
  return db.prepare(
    `SELECT "${col}" AS v, COUNT(*) AS n FROM records
     WHERE "${col}" IS NOT NULL AND "${col}" <> ''
     GROUP BY "${col}" COLLATE NOCASE ORDER BY n DESC LIMIT 500`,
  ).all().map((r) => r.v);
}

// ---------------------------------------------------------------------------
// Consulta da lista: busca full-text (q) + filtros por coluna + paginação.
// ---------------------------------------------------------------------------

// Converte a busca do usuário em uma expressão FTS5 (prefixo por palavra, com
// AND implícito). Dígitos viram um termo próprio (acha CPF por números).
function ftsQuery(q) {
  const tokens = String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  const terms = tokens.map((t) => `${t}*`);
  const digits = String(q).replace(/\D/g, '');
  if (digits.length >= 3 && !tokens.includes(digits)) terms.push(`${digits}*`);
  return terms.join(' ');
}

// Monta FROM/WHERE/params a partir de q + filtros.
function buildQuery({ q = '', filters = {} } = {}) {
  const where = [];
  const params = [];
  let from = 'FROM records r';

  const fq = q ? ftsQuery(q) : null;
  if (fq) {
    from += ' JOIN records_fts ON records_fts.rowid = r._rowid';
    where.push('records_fts MATCH ?');
    params.push(fq);
  }
  for (const k of FILTER_KEYS) {
    const val = filters[k];
    if (val != null && String(val).trim() !== '') {
      // Prefixo, sem acento/maiúsculas (índice COLLATE NOCASE acelera).
      where.push(`r."${k}" LIKE ?`);
      params.push(`${String(val).trim()}%`);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const filtered = Boolean(fq) || where.length > 0;
  return { from, whereSql, params, filtered };
}

function query({ limit = 50, offset = 0, q = '', filters = {}, sort = null, dir = 'asc' } = {}) {
  const columns = getColumns();
  const { from, whereSql, params, filtered } = buildQuery({ q, filters });

  // Total: sem filtro algum, usa cache (não reconta milhões a cada clique).
  const total = filtered
    ? db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(...params).n
    : cached('total', () => db.prepare('SELECT COUNT(*) AS n FROM records').get().n);

  let orderBy = 'ORDER BY r._rowid ASC';
  if (sort && COLUMN_KEYS.includes(sort)) {
    const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    orderBy = `ORDER BY r."${sort}" COLLATE NOCASE ${direction}`;
  } else if (sort === '_source_file') {
    orderBy = `ORDER BY r."_source_file" ${String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
  }

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const selectCols = ['r._rowid', 'r._source_file', ...COLUMN_KEYS.map((k) => `r."${k}"`)].join(', ');
  const rows = db
    .prepare(`SELECT ${selectCols} ${from} ${whereSql} ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, safeLimit, safeOffset);

  return { columns, rows, total, limit: safeLimit, offset: safeOffset };
}

// ---------------------------------------------------------------------------
// Histórico de importações e remoção.
// ---------------------------------------------------------------------------
function listImports() {
  return db.prepare('SELECT * FROM imports ORDER BY imported_at DESC, id DESC').all();
}

function deleteBySource(sourceFile) {
  const info = db.prepare('DELETE FROM records WHERE _source_file = ?').run(sourceFile);
  db.prepare('DELETE FROM imports WHERE source_file = ?').run(sourceFile);
  bumpData();
  return info.changes;
}

function clearAll() {
  db.transaction(() => {
    db.exec('DELETE FROM records');
    db.exec('DELETE FROM imports');
  })();
  bumpData();
}

// ---------------------------------------------------------------------------
// Exportação CSV em streaming (não carrega tudo na memória).
// `write` recebe pedaços de texto; o servidor repassa para a resposta HTTP.
// ---------------------------------------------------------------------------
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function streamCsv({ q = '', filters = {} } = {}, write) {
  const { from, whereSql, params } = buildQuery({ q, filters });
  const header = ['Origem', ...COLUMNS.map((c) => c.label)];
  write(header.map(csvEscape).join(',') + '\r\n');

  const selectCols = ['r._source_file', ...COLUMN_KEYS.map((k) => `r."${k}"`)].join(', ');
  const stmt = db.prepare(`SELECT ${selectCols} ${from} ${whereSql} ORDER BY r._rowid ASC`);
  for (const row of stmt.iterate(...params)) {
    const cells = [row._source_file, ...COLUMN_KEYS.map((k) => row[k])];
    write(cells.map(csvEscape).join(',') + '\r\n');
  }
}

module.exports = {
  COLUMN_KEYS,
  FILTER_KEYS,
  DISTINCT_KEYS,
  formatCPF,
  buildSearchText,
  insertRow,
  recordImport,
  getColumns,
  getStats,
  distinctValues,
  query,
  listImports,
  deleteBySource,
  clearAll,
  streamCsv,
};
