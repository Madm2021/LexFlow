'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { db } = require('./db');
const { COLUMNS, COLUMN_KEYS, FILTER_KEYS, FTS_FILTER_KEYS, ALL_FILTER_KEYS, DISTINCT_KEYS } = require('./schema');
const core = require('./querycore');
const { normalizeCpf, normalizeDate, recordKey } = require('./hygiene');

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
  // Limpa o cache de contagens, mas preserva os SINALIZADORES (flag:*), como o
  // "keys_built" (chave de identidade já preenchida na base) — que não deve ser
  // perdido a cada importação/remoção.
  try { db.prepare("DELETE FROM app_cache WHERE key NOT LIKE 'flag:%'").run(); } catch (e) { /* ignora */ }
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

const INSERT_COLS = ['_source_file', '_imported_at', '_hash', '_key', '_search', '_cpf_ok', ...COLUMN_KEYS];
const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO records (${INSERT_COLS.map((c) => `"${c}"`).join(', ')})
   VALUES (${INSERT_COLS.map(() => '?').join(', ')})`,
);

// ---------------------------------------------------------------------------
// ENRIQUECIMENTO no import: quando a planilha nova traz uma pessoa/caso que JÁ
// existe (mesma chave de identidade), em vez de duplicar, completa o cadastro.
//  - Campo vazio  -> preenche com o valor novo.
//  - Campo de CONTATO/endereço que já tem valor e vem outro diferente -> ACUMULA
//    os dois ("1111 / 2222"), sem repetir o que já está lá.
//  - Campos de identidade (nome, CPF, nascimento, etc.) -> mantém o atual (só
//    preenche se estiver vazio); nunca acumula, para não virar lixo.
// ---------------------------------------------------------------------------
const ACCUMULATE_KEYS = new Set([
  'telefone_funcionario', 'telefone1', 'telefone2', 'telefone3',
  'email', 'endereco_funcionario', 'observacoes',
]);
const SEP = ' / ';

const selectByKeyStmt = db.prepare(
  `SELECT _rowid, _source_file, ${COLUMN_KEYS.map((k) => `"${k}"`).join(', ')}
   FROM records WHERE _key = ? ORDER BY _rowid LIMIT 1`,
);
const updateMergeStmt = db.prepare(
  `UPDATE records SET ${COLUMN_KEYS.map((k) => `"${k}" = ?`).join(', ')}, _cpf_ok = ?, _search = ?
   WHERE _rowid = ?`,
);

// Resolve o valor final de um campo na fusão (regras acima).
function mergeField(key, oldV, newV) {
  const o = oldV == null ? '' : String(oldV).trim();
  const n = newV == null ? '' : String(newV).trim();
  if (n === '') return o === '' ? null : o;     // nada novo a acrescentar
  if (o === '') return n;                        // preenche o vazio
  if (o === n) return o;                         // idêntico: mantém
  if (!ACCUMULATE_KEYS.has(key)) return o;       // identidade: mantém o atual
  // Acumula sem repetir (compara cada pedaço já existente, sem diferenciar caixa).
  const parts = o.split(SEP).map((t) => t.trim()).filter(Boolean);
  if (parts.some((t) => t.toLowerCase() === n.toLowerCase())) return o;
  return o + SEP + n;
}

// Funde os valores novos no registro existente. Retorna true se algo mudou.
function mergeIntoExisting(existing, values) {
  const merged = {};
  let changed = false;
  for (const k of COLUMN_KEYS) {
    const before = existing[k] == null ? null : String(existing[k]);
    const after = mergeField(k, existing[k], values[k]);
    merged[k] = after;
    if ((after == null ? null : String(after)) !== before) changed = true;
  }
  if (!changed) return false;                    // a planilha nova não acrescentou nada
  const cpf = normalizeCpf(merged.cpf);
  merged.cpf = cpf.value;
  const search = buildSearchText(merged, existing._source_file);
  updateMergeStmt.run(
    ...COLUMN_KEYS.map((k) => (merged[k] == null || merged[k] === '' ? null : merged[k])),
    cpf.ok, search, existing._rowid,
  );
  return true;
}

// Retorna: 1 = novo registro adicionado · 2 = cadastro existente enriquecido ·
// 0 = nada (duplicata idêntica / sem novidade).
function insertRow({ sourceFile, importedAt, hash, values }) {
  // Higieniza já na entrada: CPF (formato + zero à esquerda + validade) e data.
  const cpf = normalizeCpf(values.cpf);
  values.cpf = cpf.value;
  if ('data_nascimento' in values) values.data_nascimento = normalizeDate(values.data_nascimento);
  const key = recordKey(values);
  if (key) {
    const existing = selectByKeyStmt.get(key);
    if (existing) return mergeIntoExisting(existing, values) ? 2 : 0;
  }
  const search = buildSearchText(values, sourceFile);
  const info = insertStmt.run(
    sourceFile, importedAt, hash, key, search, cpf.ok,
    ...COLUMN_KEYS.map((k) => (values[k] == null || values[k] === '' ? null : values[k])),
  );
  return info.changes;
}

function recordImport(sourceFile, sheetName, rowsAdded, rowsSkipped, rowsMerged = 0) {
  db.prepare(
    'INSERT INTO imports (source_file, sheet_name, rows_added, rows_skipped, rows_merged, imported_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sourceFile, sheetName || null, rowsAdded, rowsSkipped, rowsMerged, new Date().toISOString());
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

function isUnfiltered({ q = '', filters = {}, validCpf = false } = {}) {
  return !q && !validCpf && !ALL_FILTER_KEYS.some((k) => filters[k] != null && String(filters[k]).trim() !== '');
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

async function facets({ q = '', filters = {}, validCpf = false } = {}) {
  if (isUnfiltered({ q, filters, validCpf })) {
    const p = getPersist('facets_all');
    if (p) return p;
    if (facetsAllInflight) return facetsAllInflight;
    facetsAllInflight = ask('facets', { q: '', filters: {} })
      .then((r) => { setPersist('facets_all', r); facetsAllInflight = null; return r; })
      .catch((e) => { facetsAllInflight = null; throw e; });
    return facetsAllInflight;
  }
  const key = `facets:${JSON.stringify({ q, filters, validCpf })}`;
  if (memo[key] && memo[key].v === dataVersion) return memo[key].value;
  const r = await ask('facets', { q, filters, validCpf });
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
// HIGIENIZAÇÃO em lotes: normaliza CPF (zero à esquerda + dígito verificador)
// e datas, marcando _cpf_ok (1/0). Roda em pedaços por cursor de _rowid, sem
// travar (chunks com pausa), e é idempotente (pode rodar de novo a qualquer hora).
// ---------------------------------------------------------------------------
let hygiene = { running: false, cursor: 0 };
const hygieneSel = db.prepare('SELECT _rowid, cat, cpf, data_nascimento, _search FROM records WHERE _rowid > ? ORDER BY _rowid LIMIT ?');
const hygieneUpd = db.prepare('UPDATE records SET cpf = ?, data_nascimento = ?, _cpf_ok = ?, _key = ?, _search = ? WHERE _rowid = ?');

function hygieneStats() {
  const valid = db.prepare('SELECT COUNT(*) AS n FROM records WHERE _cpf_ok = 1').get().n;
  const invalid = db.prepare('SELECT COUNT(*) AS n FROM records WHERE _cpf_ok = 0').get().n;
  const total = cached('total', () => db.prepare('SELECT COUNT(*) AS n FROM records').get().n);
  return { total, valid, invalid, pendente: Math.max(0, total - valid - invalid) };
}

function getHygieneJob() {
  return { running: hygiene.running, ...hygieneStats() };
}

function startHygiene() {
  if (hygiene.running) return getHygieneJob();
  hygiene = { running: true, cursor: 0 };
  return getHygieneJob();
}

// Processa um lote; retorna quantas linhas tratou (0 = terminou).
function hygieneStep(chunk = 4000) {
  if (!hygiene.running) return 0;
  const rows = hygieneSel.all(hygiene.cursor, chunk);
  if (rows.length === 0) {
    hygiene.running = false;
    // Marca que a chave de identidade já foi preenchida em toda a base. É isso
    // que libera (e torna confiável) a etapa de "reunir duplicados".
    setPersist('flag:keys_built', true);
    bumpData();
    return 0;
  }
  const tx = db.transaction(() => {
    for (const r of rows) {
      const c = normalizeCpf(r.cpf);
      const d = normalizeDate(r.data_nascimento);
      const key = recordKey({ cat: r.cat, cpf: c.value, data_nascimento: d });
      let search = r._search || '';
      if (c.ok) {
        const dig = c.value.replace(/\D/g, '');
        if (dig && !search.includes(dig)) search += ` ${dig}`;
      }
      hygieneUpd.run(c.value, d, c.ok, key, search, r._rowid);
    }
  });
  tx();
  hygiene.cursor = rows[rows.length - 1]._rowid;
  return rows.length;
}

// ---------------------------------------------------------------------------
// DEDUP (Fase 2): reúne os duplicados ANTIGOS por chave de identidade (_key).
// Para cada grupo com a mesma chave, funde tudo no registro de menor _rowid
// (preenche vazios, acumula contatos, mantém identidade — mesmas regras do
// import) e remove as cópias. Roda em lotes, sem travar, e é resumível por
// cursor sobre o valor de _key. NÃO mexe em registros sem chave (_key NULL).
// Pré-requisito: rodar a higienização antes (ela é quem preenche _key).
// ---------------------------------------------------------------------------
let dedup = { running: false, cursor: '', removed: 0, groups: 0 };
const dedupKeysSel = db.prepare(
  `SELECT _key, COUNT(*) AS c FROM records
   WHERE _key IS NOT NULL AND _key > ?
   GROUP BY _key ORDER BY _key LIMIT ?`,
);
const dedupGroupSel = db.prepare(
  `SELECT _rowid, _source_file, ${COLUMN_KEYS.map((k) => `"${k}"`).join(', ')}
   FROM records WHERE _key = ? ORDER BY _rowid`,
);
const dedupDelStmt = db.prepare('DELETE FROM records WHERE _rowid = ?');

// Funde um grupo (mesma chave) no registro de menor _rowid e apaga os demais.
function collapseKey(key) {
  const rows = dedupGroupSel.all(key);
  if (rows.length < 2) return;
  const canon = rows[0];
  const acc = {};
  for (const k of COLUMN_KEYS) acc[k] = canon[k];
  for (let i = 1; i < rows.length; i += 1) {
    for (const k of COLUMN_KEYS) acc[k] = mergeField(k, acc[k], rows[i][k]);
  }
  const cpf = normalizeCpf(acc.cpf);
  acc.cpf = cpf.value;
  const search = buildSearchText(acc, canon._source_file);
  updateMergeStmt.run(
    ...COLUMN_KEYS.map((k) => (acc[k] == null || acc[k] === '' ? null : acc[k])),
    cpf.ok, search, canon._rowid,
  );
  for (let i = 1; i < rows.length; i += 1) dedupDelStmt.run(rows[i]._rowid);
  dedup.removed += rows.length - 1;
  dedup.groups += 1;
}

// Estado/prévia. Enquanto roda, devolve só os contadores (barato). Parado,
// calcula quantos seriam removidos (linhas com chave − chaves distintas).
function getDedupJob() {
  const base = { running: dedup.running, removed: dedup.removed, groups: dedup.groups };
  if (dedup.running) return base;
  // keysReady = a higienização já preencheu a chave de identidade em toda a
  // base. Sem isso, a contagem de duplicados é enganosa (só "enxerga" os
  // registros recém-importados, não os 11M antigos) — então a UI deve pedir
  // para rodar a higienização antes.
  const keysReady = getPersist('flag:keys_built') === true;
  const r = db.prepare(
    'SELECT COUNT(*) AS rows, COUNT(DISTINCT _key) AS keys FROM records WHERE _key IS NOT NULL',
  ).get();
  return {
    ...base, keysReady,
    duplicates: Math.max(0, r.rows - r.keys),
    hygienePending: hygieneStats().pendente,
  };
}

function startDedup() {
  if (dedup.running) return { running: true, removed: dedup.removed, groups: dedup.groups };
  dedup = { running: true, cursor: '', removed: 0, groups: 0 };
  return { running: true, removed: 0, groups: 0 };
}

// Processa um lote de chaves; retorna quantas chaves varreu (0 = terminou).
function dedupStep(chunkKeys = 2000) {
  if (!dedup.running) return 0;
  const keys = dedupKeysSel.all(dedup.cursor, chunkKeys);
  if (keys.length === 0) { dedup.running = false; bumpData(); return 0; }
  const tx = db.transaction(() => {
    for (const row of keys) { if (row.c > 1) collapseKey(row._key); }
  });
  tx();
  dedup.cursor = keys[keys.length - 1]._key;
  return keys.length;
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
  getHygieneJob,
  startHygiene,
  hygieneStep,
  hygieneStats,
  getDedupJob,
  startDedup,
  dedupStep,
  listImports,
  deleteBySource,
  clearAll,
};
