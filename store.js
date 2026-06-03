'use strict';

const { db } = require('./db');
const { MAPPING } = require('./mapping');

// "Memória de cálculo" (cache): resultados pesados são guardados e só
// recalculados quando os dados mudam (nova importação, limpeza, etc.).
let dataVersion = 1;
function bumpData() { dataVersion += 1; }
const memo = {};
function cached(key, fn) {
  if (memo[key] && memo[key].v === dataVersion) return memo[key].value;
  const value = fn();
  memo[key] = { v: dataVersion, value };
  return value;
}

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
  bumpData();
}

/**
 * Estatísticas globais para o topo da tela (em cache).
 */
function getStats() {
  return cached('stats', () => ({
    records: db.prepare('SELECT COUNT(*) AS n FROM records').get().n,
    columns: db.prepare('SELECT COUNT(*) AS n FROM columns').get().n,
    imports: db.prepare('SELECT COUNT(*) AS n FROM imports').get().n,
  }));
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
  bumpData();
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
  bumpData();
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
  // Sem busca, o total é o mesmo sempre — usa cache (evita recontar 5M a cada clique).
  const total = q
    ? db.prepare(`SELECT COUNT(*) AS n FROM records ${clause}`).get(...params).n
    : cached('total', () => db.prepare('SELECT COUNT(*) AS n FROM records').get().n);

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

// ----------------------------------------------------------------------------
// PROSPECÇÃO (triagem inteligente para auxílio-acidente).
// Dá uma nota de potencial a cada caso a partir de sinais objetivos e exclui
// os casos de óbito. As listas de palavras-chave são ajustáveis aqui.
// ----------------------------------------------------------------------------

const PROSPECT = {
  // Lesões com sequela permanente (forte indício de auxílio-acidente).
  lesaoAlta: ['amputa', 'decep', 'avuls', 'perda', 'esmaga', 'enuclea'],
  lesaoMedia: ['fratur', 'luxa', 'ruptur'],
  cidGrave: ['amputa', 'fratur', 'perda', 'enuclea'],
  parteKeywords: ['dedo', 'mao', 'mão', 'olho', 'perna', 'braco', 'braço', 'joelho', 'coluna', 'punho', 'ombro', 'ouvid', 'audi', 'tornozelo', 'quadril', 'clavicula', 'clavícula', 'antebraco', 'antebraço'],
  // Pesos: refletem o MÉRITO jurídico (gravidade da sequela), não o contato.
  pesos: { lesaoAlta: 4, lesaoMedia: 2, cid: 3, afastamento: 2, parte: 1 },
};

// COALESCE só das colunas que existem (string vazia se nenhuma existir).
function valOf(names) {
  const s = names.filter((n) => columnSet().has(n));
  if (s.length === 0) return "''";
  return `COALESCE(${s.map((n) => `"${n}"`).join(', ')}, '')`;
}

// Valor de uma coluna-destino do de-para (para a triagem).
function fieldVal(key) {
  const f = MAPPING.find((m) => m.key === key);
  return valOf(f ? f.sources : []);
}

function likeAny(expr, kws) {
  return '(' + kws.map((k) => `lower(${expr}) LIKE '%${k}%'`).join(' OR ') + ')';
}

// Monta as expressões SQL de pontuação, sinais e exclusão de óbito.
function prospectExprs() {
  const lesao = fieldVal('nat_lesao');
  const parte = fieldVal('parte_corpo');
  const cid = fieldVal('cid_10');
  const afast = valOf(['houve_afastamento', 'devera_afastar']);
  const tel = valOf(['telefone1', 'telefone2', 'telefone3', 'celular1', 'celular2', 'celular3', 'fixo1', 'fixo2', 'fixo3', 'telefone_fun', 'telefones']);

  const mLesaoAlta = `(${likeAny(lesao, PROSPECT.lesaoAlta)})`;
  const mLesaoMedia = `(${likeAny(lesao, PROSPECT.lesaoMedia)})`;
  const mCid = `(${likeAny(cid, PROSPECT.cidGrave)})`;
  const mAfast = `(${likeAny(afast, ['sim'])})`;
  const mParte = `(${likeAny(parte, PROSPECT.parteKeywords)})`;

  // Nota = mérito jurídico (gravidade/sequela). O telefone NÃO entra na nota.
  const p = PROSPECT.pesos;
  const score = `((CASE WHEN ${mLesaoAlta} THEN ${p.lesaoAlta} WHEN ${mLesaoMedia} THEN ${p.lesaoMedia} ELSE 0 END)`
    + `+(CASE WHEN ${mCid} THEN ${p.cid} ELSE 0 END)`
    + `+(CASE WHEN ${mAfast} THEN ${p.afastamento} ELSE 0 END)`
    + `+(CASE WHEN ${mParte} THEN ${p.parte} ELSE 0 END))`;

  const obitoTxt = valOf(['morte', 'comunicacao_obito', 'houve_morte', 'indica_obito_acidente']);
  const obitoData = valOf(['data_obito', 'data_do_obito']);
  const isObito = `((${likeAny(obitoTxt, ['sim'])}) OR length(trim(${obitoData})) > 0)`;

  // tel é só para exibição (coluna Telefone), não afeta a nota.
  return { score, tel, mLesaoAlta, mLesaoMedia, mCid, mAfast, mParte, isObito };
}

// Campos (do de-para) exibidos na lista de prospecção.
const PROSPECT_FIELDS = ['nome', 'cat', 'cid_10', 'nat_lesao', 'parte_corpo', 'estado_funcionario', 'municipio_funcionario'];

// Expressão SQL: o registro tem indicação de sequela (lesão grave/média ou CID grave)?
function temSequelaSql() {
  const e = prospectExprs();
  return `(${e.mLesaoAlta} OR ${e.mLesaoMedia} OR ${e.mCid})`;
}

// Verificação em JS (usada na importação) — mesma regra do SQL.
function textHasAny(text, kws) {
  const t = String(text == null ? '' : text).toLowerCase();
  return kws.some((k) => t.includes(k));
}
function hasSequela(natLesao, cid) {
  return textHasAny(natLesao, PROSPECT.lesaoAlta)
    || textHasAny(natLesao, PROSPECT.lesaoMedia)
    || textHasAny(cid, PROSPECT.cidGrave);
}

// Calcula _potencial/_obito para um lote de registros ainda não calculados.
// Roda em segundo plano para não travar o servidor. Retorna quantos atualizou.
function scorePending(chunk = 5000) {
  const e = prospectExprs();
  const info = db.prepare(
    `UPDATE records SET _potencial = ${e.score}, _obito = (CASE WHEN ${e.isObito} THEN 1 ELSE 0 END)
     WHERE _rowid IN (SELECT _rowid FROM records WHERE _potencial IS NULL LIMIT ${chunk})`,
  ).run();
  if (info.changes > 0) bumpData(); // recalcular painel/contagens após indexar
  return info.changes;
}
function pendingCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM records WHERE _potencial IS NULL').get().n;
}

// Contagem e exclusão de casos SEM indicação de sequela.
function countNoSequela() {
  return db.prepare(`SELECT COUNT(*) AS n FROM records WHERE NOT ${temSequelaSql()}`).get().n;
}
function deleteNoSequela() {
  const info = db.prepare(`DELETE FROM records WHERE NOT ${temSequelaSql()}`).run();
  bumpData();
  return info.changes;
}

function queryProspects({ limit = 50, offset = 0, q = '', minScore = 7 } = {}) {
  const e = prospectExprs();
  const select = [
    '_rowid', '_source_file',
    '_potencial AS potencial',
    `${e.tel} AS telefone`,
    `${e.mLesaoAlta} AS m_lesao_alta`, `${e.mLesaoMedia} AS m_lesao_media`, `${e.mCid} AS m_cid`,
    `${e.mAfast} AS m_afast`, `${e.mParte} AS m_parte`,
    ...PROSPECT_FIELDS.map((k) => `${fieldVal(k)} AS "${k}"`),
  ].join(', ');

  // Usa as colunas pré-calculadas (com índice) — rápido mesmo com milhões.
  const where = ['_obito = 0', '_potencial >= ?'];
  const params = [Number(minScore) || 0];
  if (q) {
    const cols = ['nome', 'cat', 'cid_10', 'nat_lesao', 'parte_corpo', 'municipio_funcionario'];
    where.push('(' + cols.map((k) => `${fieldVal(k)} LIKE ? COLLATE NOCASE`).join(' OR ') + ')');
    cols.forEach(() => params.push(`%${q}%`));
  }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM records ${whereSql}`).get(...params).n;
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const rows = db
    .prepare(`SELECT ${select} FROM records ${whereSql} ORDER BY _potencial DESC, _rowid ASC LIMIT ? OFFSET ?`)
    .all(...params, safeLimit, safeOffset);

  // Monta os "motivos" legíveis a partir dos sinais.
  for (const r of rows) {
    const motivos = [];
    if (r.m_lesao_alta) motivos.push('Lesão grave (amputação/perda)');
    else if (r.m_lesao_media) motivos.push('Lesão (fratura/luxação)');
    if (r.m_cid) motivos.push('CID de lesão grave');
    if (r.m_afast) motivos.push('Houve afastamento');
    if (r.m_parte) motivos.push('Parte do corpo-chave');
    r.motivos = motivos;
    delete r.m_lesao_alta; delete r.m_lesao_media; delete r.m_cid;
    delete r.m_afast; delete r.m_parte;
  }

  return { rows, total, limit: safeLimit, offset: safeOffset, minScore: Number(minScore) || 0, pending: pendingCount() };
}

function exportProspectsCsv({ q = '', minScore = 7 } = {}) {
  const all = queryProspects({ q, minScore, limit: 500, offset: 0 });
  // Reúne todas as páginas.
  const total = all.total;
  let rows = all.rows;
  let off = 500;
  while (off < total) {
    rows = rows.concat(queryProspects({ q, minScore, limit: 500, offset: off }).rows);
    off += 500;
  }
  const labels = { nome: 'Nome', cat: 'CAT', cid_10: 'CID-10', nat_lesao: 'Nat. Lesão', parte_corpo: 'Parte do Corpo', estado_funcionario: 'UF', municipio_funcionario: 'Município' };
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Potencial', 'Motivos', 'Telefone', ...PROSPECT_FIELDS.map((k) => labels[k]), 'Origem'];
  const lines = [header.map(escape).join(',')];
  for (const r of rows) {
    lines.push([r.potencial, r.motivos.join(' | '), r.telefone, ...PROSPECT_FIELDS.map((k) => r[k]), r._source_file].map(escape).join(','));
  }
  return lines.join('\r\n');
}

// Painel analítico (BI): números-chave e principais distribuições (em cache).
function dashboard() {
  return cached('dashboard', () => computeDashboard());
}
function computeDashboard() {
  const e = prospectExprs();
  const total = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
  const candidatos = db.prepare('SELECT COUNT(*) AS n FROM records WHERE _obito = 0 AND _potencial >= 7').get().n;
  const obitos = db.prepare('SELECT COUNT(*) AS n FROM records WHERE _obito = 1').get().n;
  const comTelefone = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE length(trim(${e.tel})) > 0`).get().n;
  const semSequela = countNoSequela();
  const pending = pendingCount();

  // Top-N de uma expressão (ignora vazios).
  const topBy = (expr, limit = 10) => db.prepare(
    `SELECT ${expr} AS label, COUNT(*) AS n FROM records WHERE trim(${expr}) <> '' GROUP BY label ORDER BY n DESC LIMIT ${limit}`,
  ).all();

  // Faixas de potencial (usa a coluna indexada).
  const porNota = db.prepare('SELECT _potencial AS p, COUNT(*) AS n FROM records WHERE _potencial IS NOT NULL GROUP BY _potencial').all();
  const faixas = { 'Alto (9-10)': 0, 'Médio (6-8)': 0, 'Baixo (1-5)': 0, 'Sem sinais (0)': 0 };
  for (const r of porNota) {
    if (r.p >= 9) faixas['Alto (9-10)'] += r.n;
    else if (r.p >= 6) faixas['Médio (6-8)'] += r.n;
    else if (r.p >= 1) faixas['Baixo (1-5)'] += r.n;
    else faixas['Sem sinais (0)'] += r.n;
  }

  return {
    totals: { total, comSequela: total - semSequela, semSequela, candidatos, obitos, comTelefone, pending },
    faixas: Object.entries(faixas).map(([label, n]) => ({ label, n })),
    porUF: topBy(fieldVal('estado_funcionario'), 15),
    porParte: topBy(fieldVal('parte_corpo'), 10),
    porCID: topBy(fieldVal('cid_10'), 10),
    porLesao: topBy(fieldVal('nat_lesao'), 10),
  };
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
  queryProspects,
  exportProspectsCsv,
  scorePending,
  pendingCount,
  countNoSequela,
  deleteNoSequela,
  hasSequela,
  dashboard,
  listImports,
  deleteBySource,
  clearAll,
  exportCsv,
  exportCsvClean,
  resetColumnCache,
};
