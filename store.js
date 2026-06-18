'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { db } = require('./db');
const { COLUMNS, COLUMN_KEYS, FILTER_KEYS, FTS_FILTER_KEYS, ALL_FILTER_KEYS, DISTINCT_KEYS } = require('./schema');
const core = require('./querycore');

// ---------------------------------------------------------------------------
// Caches: memória (por versão dos dados) + persistente em app_cache (sobrevive
// a reinícios; usado para a distribuição sem filtro e os dropdowns).
// ---------------------------------------------------------------------------
let dataVersion = 1;
const memo = {};
function cached(key, fn) {
  if (memo[key] && memo[key].v === dataVersion) return memo[key].value;
  const value = fn();
  memo[key] = { v: dataVersion, value };
  return value;
}
function getPersist(key) {
  const r = db.prepare('SELECT value FROM app_cache WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : null;
}
function setPersist(key, val) {
  db.prepare('INSERT INTO app_cache(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(val));
}
function bumpData() {
  dataVersion += 1;
  for (const k of Object.keys(memo)) delete memo[k];
  facetsAllInflight = null;
  try { db.prepare('DELETE FROM app_cache').run(); } catch (e) { /* ignora */ }
}

// ---------------------------------------------------------------------------
// Worker de contagem (thread separada): não trava o servidor principal.
// ---------------------------------------------------------------------------
let worker = null;
let reqSeq = 0;
const pending = new Map();
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'facets-worker.js'));
  worker.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  worker.on('error', (e) => {
    console.error('facets-worker:', e.message);
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    worker = null;
  });
  worker.on('exit', () => { worker = null; });
  return worker;
}
function ask(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++reqSeq;
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, type, payload });
  });
}

// ---------------------------------------------------------------------------
// CPF e texto de busca (usados pelo importador).
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

const INSERT_COLS = ['_source_file', '_imported_at', '_hash', '_search', ...COLUMN_KEYS];
const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO records (${INSERT_COLS.map((c) => `"${c}"`).join(', ')})
   VALUES (${INSERT_COLS.map(() => '?').join(', ')})`,
);
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
// Catálogo, estatísticas e busca (rápidas, no processo principal).
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

function isUnfiltered({ q = '', filters = {} } = {}) {
  return !q && !ALL_FILTER_KEYS.some((k) => filters[k] != null && String(filters[k]).trim() !== '');
}

function query(opts = {}) {
  const total = isUnfiltered(opts)
    ? cached('total', () => db.prepare('SELECT COUNT(*) AS n FROM records').get().n)
    : core.count(db, opts);
  return core.query(db, opts, total);
}

function streamCsv(opts, write) {
  return core.streamCsv(db, opts, write);
}

// ---------------------------------------------------------------------------
// Distribuição / facetas / dropdowns — SEMPRE no worker (não trava a tela).
// Sem filtro: usa cache persistente (instantâneo após o 1º cálculo).
// ---------------------------------------------------------------------------
let facetsAllInflight = null;

async function facets({ q = '', filters = {} } = {}) {
  if (isUnfiltered({ q, filters })) {
    const p = getPersist('facets_all');
    if (p) return p;
    if (facetsAllInflight) return facetsAllInflight;
    facetsAllInflight = ask('facets', { q: '', filters: {} })
      .then((r) => { setPersist('facets_all', r); facetsAllInflight = null; return r; })
      .catch((e) => { facetsAllInflight = null; throw e; });
    return facetsAllInflight;
  }
  const key = `facets:${JSON.stringify({ q, filters })}`;
  if (memo[key] && memo[key].v === dataVersion) return memo[key].value;
  const r = await ask('facets', { q, filters });
  memo[key] = { v: dataVersion, value: r };
  return r;
}

function facetsCsv(opts) {
  return ask('facetsCsv', opts);
}

async function distinctValues(col) {
  if (!DISTINCT_KEYS.includes(col)) return [];
  const pk = `distinct_${col}`;
  const p = getPersist(pk);
  if (p) return p;
  const r = await ask('distinct', { col });
  setPersist(pk, r);
  return r;
}

// Pré-calcula (no worker, sem travar) a distribuição sem filtro e os dropdowns,
// para a 1ª abertura do painel ser instantânea. Chamado após o servidor subir.
function warmStart() {
  if (getPersist('facets_all')) return; // já está pronto (persistido)
  console.log('LexFlow: pré-calculando a distribuição em 2º plano...');
  facets()
    .then(() => distinctValues('estado_funcionario'))
    .then(() => console.log('LexFlow: distribuição pronta (cache).'))
    .catch((e) => console.error('warmStart:', e.message));
}

// ---------------------------------------------------------------------------
// Histórico e remoção.
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

module.exports = {
  COLUMN_KEYS,
  FILTER_KEYS,
  FTS_FILTER_KEYS,
  ALL_FILTER_KEYS,
  DISTINCT_KEYS,
  formatCPF,
  buildSearchText,
  insertRow,
  recordImport,
  getColumns,
  getStats,
  query,
  streamCsv,
  facets,
  facetsCsv,
  distinctValues,
  warmStart,
  listImports,
  deleteBySource,
  clearAll,
};
