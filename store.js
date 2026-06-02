'use strict';

const { db } = require('./db');
const { MAPPING } = require('./mapping');

/**
 * Retorna o catálogo de colunas (a união de colunas de todas as planilhas),
 * já na ordem de exibição.
 */
function getColumns() {
  return db.prepare('SELECT column_name, original_name, data_type, position FROM columns ORDER BY position').all();
}

let columnCache = null;
function columnSet() {
  if (!columnCache) columnCache = new Set(db.prepare('SELECT column_name FROM columns').all().map((r) => r.column_name));
  return columnCache;
}

/**
 * Garante que uma coluna existe no catálogo e na tabela "records".
 * Se for nova, registra no catálogo e adiciona fisicamente (ALTER TABLE).
 */
function ensureColumn(sqlName, originalName, dataType) {
  const set = columnSet();
  if (set.has(sqlName)) return;
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM columns').get().p;
  db.prepare(
    'INSERT INTO columns (column_name, original_name, data_type, position, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sqlName, originalName, dataType, pos, new Date().toISOString());
  db.exec(`ALTER TABLE records ADD COLUMN "${sqlName}" TEXT`);
  set.add(sqlName);
}

/**
 * Prepara um INSERT OR IGNORE para um conjunto de colunas de um arquivo.
 * O OR IGNORE faz a deduplicação: se o _hash já existe, a linha é descartada.
 */
function buildInsert(sqlNames) {
  const cols = ['_source_file', '_imported_at', '_hash', ...sqlNames];
  const placeholders = cols.map(() => '?').join(', ');
  const colList = cols.map((c) => `"${c}"`).join(', ');
  return db.prepare(`INSERT OR IGNORE INTO records (${colList}) VALUES (${placeholders})`);
}

/**
 * Registra uma importação no histórico.
 */
function recordImport(sourceFile, sheetName, rowsAdded, rowsSkipped) {
  db.prepare(
    'INSERT INTO imports (source_file, sheet_name, rows_added, rows_skipped, imported_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sourceFile, sheetName || null, rowsAdded, rowsSkipped, new Date().toISOString());
}

/**
 * Estatísticas globais para o topo da tela.
 */
function getStats() {
  const records = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
  const columns = db.prepare('SELECT COUNT(*) AS n FROM columns').get().n;
  const imports = db.prepare('SELECT COUNT(*) AS n FROM imports').get().n;
  return { records, columns, imports };
}

// Colunas pelas quais é permitido ordenar (catálogo + controle).
function sortableColumns() {
  const set = new Set(['_source_file', '_imported_at']);
  for (const c of db.prepare('SELECT column_name FROM columns').all()) set.add(c.column_name);
  return set;
}

function buildWhere(q) {
  if (!q) return { clause: '', params: [] };
  const cols = getColumns();
  const targets = ['_source_file', ...cols.map((c) => c.column_name)];
  const clause = 'WHERE ' + targets.map((c) => `CAST("${c}" AS TEXT) LIKE ? COLLATE NOCASE`).join(' OR ');
  const params = targets.map(() => `%${q}%`);
  return { clause, params };
}

/**
 * Consulta a lista única de registros, com paginação, busca e ordenação.
 */
function queryRecords({ limit = 50, offset = 0, q = '', sort = null, dir = 'asc' } = {}) {
  const columns = getColumns();
  const { clause, params } = buildWhere(q);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM records ${clause}`).get(...params).n;

  let orderBy = 'ORDER BY _rowid ASC';
  if (sort && sortableColumns().has(sort)) {
    const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const col = getColumns().find((c) => c.column_name === sort);
    // Colunas numéricas ordenam por valor; demais, alfabeticamente.
    orderBy = col && col.data_type === 'number'
      ? `ORDER BY CAST("${sort}" AS REAL) ${direction}`
      : `ORDER BY "${sort}" ${direction}`;
  }

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const rows = db
    .prepare(`SELECT * FROM records ${clause} ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, safeLimit, safeOffset);

  return { columns, rows, total, limit: safeLimit, offset: safeOffset };
}

/**
 * Lista o histórico de importações (planilhas que já entraram).
 */
function listImports() {
  return db.prepare('SELECT * FROM imports ORDER BY imported_at DESC, id DESC').all();
}

/**
 * Remove todos os registros vindos de um determinado arquivo.
 */
function deleteBySource(sourceFile) {
  const info = db.prepare('DELETE FROM records WHERE _source_file = ?').run(sourceFile);
  db.prepare('DELETE FROM imports WHERE source_file = ?').run(sourceFile);
  return info.changes;
}

/**
 * Apaga TODOS os dados (registros, colunas e histórico). Recria a tabela.
 */
function clearAll() {
  const cols = db.prepare('SELECT column_name FROM columns').all();
  const tx = db.transaction(() => {
    db.exec('DELETE FROM records');
    db.exec('DELETE FROM columns');
    db.exec('DELETE FROM imports');
    // Remove fisicamente as colunas dinâmicas.
    for (const c of cols) {
      try { db.exec(`ALTER TABLE records DROP COLUMN "${c.column_name}"`); } catch (e) { /* ignora */ }
    }
  });
  tx();
  columnCache = null;
}

/**
 * Gera o CSV de todos os registros (ou dos que casam com a busca q).
 */
function exportCsv(q = '') {
  const columns = getColumns();
  const { clause, params } = buildWhere(q);
  const rows = db.prepare(`SELECT * FROM records ${clause} ORDER BY _rowid ASC`).all(...params);

  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const headerCells = ['Origem', ...columns.map((c) => c.original_name)];
  const lines = [headerCells.map(escape).join(',')];
  for (const row of rows) {
    const cells = [row._source_file, ...columns.map((c) => row[c.column_name])];
    lines.push(cells.map(escape).join(','));
  }
  return lines.join('\r\n');
}

// ----------------------------------------------------------------------------
// VISÃO LIMPA (de-para): mostra as colunas-destino aprovadas, montadas a partir
// das colunas de origem com COALESCE (primeiro valor preenchido).
// ----------------------------------------------------------------------------

function existingSources(field) {
  const set = columnSet();
  return field.sources.filter((s) => set.has(s));
}

// Expressão SQL que produz o valor de uma coluna-destino.
function cleanExpr(field) {
  const srcs = existingSources(field);
  if (srcs.length === 0) return 'NULL';
  if (srcs.length === 1) return `"${srcs[0]}"`;
  return `COALESCE(${srcs.map((s) => `"${s}"`).join(', ')})`;
}

function getCleanColumns() {
  return MAPPING.map((f) => ({ column_name: f.key, original_name: f.label, data_type: 'text' }));
}

function buildCleanWhere(q) {
  if (!q) return { clause: '', params: [] };
  const exprs = MAPPING.map((f) => `${cleanExpr(f)} LIKE ? COLLATE NOCASE`);
  exprs.push('CAST("_source_file" AS TEXT) LIKE ? COLLATE NOCASE');
  return { clause: 'WHERE ' + exprs.join(' OR '), params: exprs.map(() => `%${q}%`) };
}

function cleanSelect() {
  const parts = ['_rowid', '_source_file'];
  for (const f of MAPPING) parts.push(`${cleanExpr(f)} AS "${f.key}"`);
  return parts.join(', ');
}

function queryRecordsClean({ limit = 50, offset = 0, q = '', sort = null, dir = 'asc' } = {}) {
  const columns = getCleanColumns();
  const { clause, params } = buildCleanWhere(q);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM records ${clause}`).get(...params).n;

  let orderBy = 'ORDER BY _rowid ASC';
  const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const sortField = MAPPING.find((f) => f.key === sort);
  if (sortField) orderBy = `ORDER BY ${cleanExpr(sortField)} ${direction}`;
  else if (sort === '_source_file') orderBy = `ORDER BY "_source_file" ${direction}`;

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const rows = db
    .prepare(`SELECT ${cleanSelect()} FROM records ${clause} ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, safeLimit, safeOffset);

  return { columns, rows, total, limit: safeLimit, offset: safeOffset, view: 'clean' };
}

function exportCsvClean(q = '') {
  const columns = getCleanColumns();
  const { clause, params } = buildCleanWhere(q);
  const rows = db.prepare(`SELECT ${cleanSelect()} FROM records ${clause} ORDER BY _rowid ASC`).all(...params);

  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Origem', ...columns.map((c) => c.original_name)].map(escape).join(',')];
  for (const row of rows) {
    lines.push([row._source_file, ...columns.map((c) => row[c.column_name])].map(escape).join(','));
  }
  return lines.join('\r\n');
}

// Permite que o importador invalide o cache de colunas se necessário.
function resetColumnCache() {
  columnCache = null;
}

module.exports = {
  getColumns,
  ensureColumn,
  buildInsert,
  recordImport,
  getStats,
  queryRecords,
  queryRecordsClean,
  getCleanColumns,
  listImports,
  deleteBySource,
  clearAll,
  exportCsv,
  exportCsvClean,
  resetColumnCache,
};
