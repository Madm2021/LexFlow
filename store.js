'use strict';

const { db } = require('./db');
const { MAPPING } = require('./mapping');
const { lookupCid } = require('./cids');

// Versão da lógica de pontuação. Ao mudar, a base é reprocessada (re-pontuada).
const SCORING_VERSION = 'jurimetria-v3';

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

// Padroniza CPF: recupera zeros à esquerda (todo CPF tem 11 dígitos) e formata
// como 000.000.000-00. Campo vazio continua vazio; valores com >11 dígitos
// (CNPJ ou dado misturado) ficam intactos.
function formatCPF(v) {
  if (v == null) return v;
  const s = String(v).trim();
  if (s === '') return v;
  const d = s.replace(/\D/g, '');
  if (d.length === 0 || d.length > 11) return s;
  const p = d.padStart(11, '0');
  return `${p.slice(0, 3)}.${p.slice(3, 6)}.${p.slice(6, 9)}-${p.slice(9)}`;
}

function buildCleanWhere(q) {
  if (!q) return { clause: '', params: [] };
  const conds = [];
  const params = [];
  const digits = q.replace(/\D/g, '');
  for (const f of MAPPING) {
    conds.push(`${cleanExpr(f)} LIKE ? COLLATE NOCASE`);
    params.push(`%${q}%`);
    // CPF: busca robusta por dígitos (acha '355.237.088-95' e '35523708895').
    if (f.key === 'cpf' && digits) {
      conds.push(`replace(replace(replace(${cleanExpr(f)}, '.', ''), '-', ''), ' ', '') LIKE ?`);
      params.push(`%${digits}%`);
    }
  }
  conds.push('CAST("_source_file" AS TEXT) LIKE ? COLLATE NOCASE');
  params.push(`%${q}%`);
  return { clause: 'WHERE ' + conds.join(' OR '), params };
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

  for (const r of rows) if ('cpf' in r) r.cpf = formatCPF(r.cpf);

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
    lines.push([row._source_file, ...columns.map((c) => (c.column_name === 'cpf' ? formatCPF(row[c.column_name]) : row[c.column_name]))].map(escape).join(','));
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

  const fil = valOf(['filiacao', 'filiacao_a_previdencia_social', 'filiacao_segurado']);
  const apo = valOf(['aposentado']);

  // tel é só para exibição (coluna Telefone), não afeta a nota.
  return { score, tel, fil, apo, mLesaoAlta, mLesaoMedia, mCid, mAfast, mParte, isObito };
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

// Elegibilidade ao auxílio-acidente (relatório de mercado):
// contribuinte individual e facultativo NÃO têm direito; aposentado perde o direito.
function semDireitoFiliacao(filiacao) {
  const t = String(filiacao == null ? '' : filiacao).toLowerCase();
  return t.includes('contribuinte individual') || t.includes('facultativ');
}
function isAposentado(apo) {
  const t = String(apo == null ? '' : apo).toLowerCase();
  return /(^|[^a-zà-ú])sim/.test(t); // "Sim" (evita falso positivo em outras palavras)
}
function hasSequela(natLesao, cid) {
  // Relevante se o CID consta na jurimetria OU se a lesão indica sequela.
  if (lookupCid(cid)) return true;
  return textHasAny(natLesao, PROSPECT.lesaoAlta)
    || textHasAny(natLesao, PROSPECT.lesaoMedia)
    || textHasAny(cid, PROSPECT.cidGrave);
}

// Calcula a NOTA de um caso a partir da jurimetria do CID.
// Nota = taxa de êxito (%) real do CID. Se o CID não está na base, usa uma
// estimativa conservadora pela natureza da lesão e marca como não classificado.
function scoreRow(cidText, natText) {
  const info = lookupCid(cidText);
  if (info && typeof info.taxa === 'number') {
    return { potencial: Math.round(info.taxa), classificado: 1 };
  }
  // Reserva (heurística) para CIDs fora da base dos 640.
  let base = 40;
  if (textHasAny(natText, PROSPECT.lesaoAlta)) base = 65;
  else if (textHasAny(natText, PROSPECT.lesaoMedia)) base = 60;
  return { potencial: base, classificado: 0 };
}

// Helpers da tabela meta (versão de pontuação etc.).
function getMeta(key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Se a lógica de pontuação mudou, zera as notas para serem recalculadas.
function ensureScoringVersion() {
  if (getMeta('scoring_version') !== SCORING_VERSION) {
    db.exec('UPDATE records SET _potencial = NULL');
    setMeta('scoring_version', SCORING_VERSION);
    bumpData();
  }
}

// Calcula _potencial/_obito/_classificado de um lote ainda não calculado.
// Roda em segundo plano (em JS, usando a jurimetria). Retorna quantos atualizou.
function scorePending(chunk = 4000) {
  const cid = fieldVal('cid_10');
  const nat = fieldVal('nat_lesao');
  const e = prospectExprs();
  const rows = db.prepare(
    `SELECT _rowid, ${cid} AS cid, ${nat} AS nat, ${e.fil} AS fil, ${e.apo} AS apo,
            (CASE WHEN ${e.isObito} THEN 1 ELSE 0 END) AS obito
     FROM records WHERE _potencial IS NULL LIMIT ${chunk}`,
  ).all();
  if (rows.length === 0) return 0;
  const upd = db.prepare('UPDATE records SET _potencial = ?, _obito = ?, _classificado = ?, _excluir = ? WHERE _rowid = ?');
  const tx = db.transaction(() => {
    for (const r of rows) {
      const s = scoreRow(r.cid, r.nat);
      // Inelegível: óbito, sem direito (contrib. individual/facultativo) ou aposentado.
      const excluir = (r.obito || semDireitoFiliacao(r.fil) || isAposentado(r.apo)) ? 1 : 0;
      upd.run(s.potencial, r.obito, s.classificado, excluir, r._rowid);
    }
  });
  tx();
  bumpData();
  return rows.length;
}
function pendingCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM records WHERE _potencial IS NULL').get().n;
}

// Normaliza o CPF gravado em lotes (recupera zeros à esquerda + formata).
// Usa um cursor por _rowid em meta — resumível e cobre também novos imports
// (linhas com _rowid maior são processadas nas próximas execuções). Vazios
// continuam vazios. Retorna quantas linhas processou neste lote.
function cpfBackfillPending(chunk = 5000) {
  if (!columnSet().has('cpf')) return 0;
  const cursor = Number(getMeta('cpf_cursor') || 0);
  const rows = db.prepare('SELECT _rowid, cpf FROM records WHERE _rowid > ? ORDER BY _rowid LIMIT ?').all(cursor, chunk);
  if (rows.length === 0) return 0;
  const upd = db.prepare('UPDATE records SET cpf = ? WHERE _rowid = ?');
  const tx = db.transaction(() => {
    for (const r of rows) {
      const f = formatCPF(r.cpf);
      if (f !== r.cpf) upd.run(f, r._rowid);
    }
  });
  tx();
  setMeta('cpf_cursor', String(rows[rows.length - 1]._rowid));
  return rows.length;
}

// "Sem sequela" = CID não classificado na jurimetria E sem palavra-chave de lesão.
function noSequelaWhere() {
  return `(COALESCE(_classificado, 0) = 0 AND NOT ${temSequelaSql()})`;
}
function countNoSequela() {
  return db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${noSequelaWhere()}`).get().n;
}
function deleteNoSequela() {
  const info = db.prepare(`DELETE FROM records WHERE ${noSequelaWhere()}`).run();
  bumpData();
  return info.changes;
}

// ----------------------------------------------------------------------------
// DEDUPLICAÇÃO POR CPF
// Agrupa pelos 11 dígitos do CPF (ignora pontuação e formatação) e, em cada
// grupo repetido, mantém só o caso de MAIOR potencial (melhor sequela/êxito),
// removendo os demais. CPFs vazios ou incompletos (≠ 11 dígitos) NÃO entram —
// por isso deve rodar DEPOIS que a formatação/recuperação de zeros terminar.
// ----------------------------------------------------------------------------
function cpfDigitsExpr() {
  return "replace(replace(replace(replace(COALESCE(cpf, ''), '.', ''), '-', ''), ' ', ''), '/', '')";
}
function countCpfDuplicates() {
  if (!columnSet().has('cpf')) return 0;
  const d = cpfDigitsExpr();
  const r = db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT ${d}) AS uniq FROM records WHERE length(${d}) = 11`).get();
  return Math.max(0, r.total - r.uniq);
}
function dedupeByCpf() {
  if (!columnSet().has('cpf')) return 0;
  const d = cpfDigitsExpr();
  // Mantém rn=1 (maior _potencial; depois classificado; depois mais antigo) e apaga o resto.
  const info = db.prepare(
    `DELETE FROM records WHERE _rowid IN (
       SELECT _rowid FROM (
         SELECT _rowid, ROW_NUMBER() OVER (
           PARTITION BY ${d} ORDER BY _potencial DESC, _classificado DESC, _rowid ASC
         ) AS rn
         FROM records WHERE length(${d}) = 11
       ) WHERE rn > 1
     )`,
  ).run();
  bumpData();
  return info.changes;
}

// ----------------------------------------------------------------------------
// JOB DE MANUTENÇÃO COM PROGRESSO (limpeza por sequela / dedup por CPF)
// Em 2 fases: (1) "analisando" — monta uma tabela temporária com os _rowid
// alvo (uma varredura); (2) "removendo" — apaga em lotes, reportando progresso.
// Assim a tela mostra a porcentagem e o servidor não trava num DELETE gigante.
// ----------------------------------------------------------------------------
let maintJob = null;
function getMaintJob() {
  return maintJob || { running: false, phase: 'idle', total: 0, removed: 0, type: null, error: null };
}
function startMaintenance(type) {
  maintJob = { running: true, phase: 'analisando', total: 0, removed: 0, type, error: null };
  return getMaintJob();
}
function maintAnalyze() {
  if (!maintJob) return;
  try {
    db.exec('DROP TABLE IF EXISTS _todel');
    if (maintJob.type === 'dedupe-cpf') {
      if (columnSet().has('cpf')) {
        const d = cpfDigitsExpr();
        db.exec(`CREATE TEMP TABLE _todel AS
          SELECT _rowid FROM (
            SELECT _rowid, ROW_NUMBER() OVER (
              PARTITION BY ${d} ORDER BY _potencial DESC, _classificado DESC, _rowid ASC
            ) AS rn FROM records WHERE length(${d}) = 11
          ) WHERE rn > 1`);
      } else {
        db.exec('CREATE TEMP TABLE _todel (_rowid INTEGER)');
      }
    } else {
      db.exec(`CREATE TEMP TABLE _todel AS SELECT _rowid FROM records WHERE ${noSequelaWhere()}`);
    }
    maintJob.total = db.prepare('SELECT COUNT(*) AS n FROM _todel').get().n;
    if (maintJob.total > 0) {
      maintJob.phase = 'removendo';
    } else {
      maintJob.phase = 'concluido';
      maintJob.running = false;
      db.exec('DROP TABLE IF EXISTS _todel');
    }
  } catch (e) {
    maintJob.error = e.message;
    maintJob.running = false;
  }
}
function maintDeleteStep(chunk = 5000) {
  if (!maintJob || !maintJob.running || maintJob.phase !== 'removendo') return 0;
  try {
    const ids = db.prepare('SELECT _rowid FROM _todel LIMIT ?').all(chunk).map((r) => r._rowid);
    if (ids.length === 0) {
      maintJob.running = false;
      maintJob.phase = 'concluido';
      db.exec('DROP TABLE IF EXISTS _todel');
      bumpData();
      return 0;
    }
    const list = ids.join(',');
    db.transaction(() => {
      db.exec(`DELETE FROM records WHERE _rowid IN (${list})`);
      db.exec(`DELETE FROM _todel WHERE _rowid IN (${list})`);
    })();
    maintJob.removed += ids.length;
    bumpData();
    return ids.length;
  } catch (e) {
    maintJob.error = e.message;
    maintJob.running = false;
    return 0;
  }
}

function queryProspects({ limit = 50, offset = 0, q = '', minScore = 70, maxScore = null } = {}) {
  const e = prospectExprs();
  const select = [
    '_rowid', '_source_file', '_classificado',
    '_potencial AS potencial',
    `${e.tel} AS telefone`,
    `${e.mAfast} AS m_afast`,
    ...PROSPECT_FIELDS.map((k) => `${fieldVal(k)} AS "${k}"`),
  ].join(', ');

  // Usa as colunas pré-calculadas (com índice) — rápido mesmo com milhões.
  // _excluir cobre óbito + sem direito (filiação) + aposentado.
  // minScore = piso (inclusive); maxScore = teto (exclusivo) para faixa exata.
  const where = ['COALESCE(_excluir, _obito, 0) = 0', '_potencial >= ?'];
  const params = [Number(minScore) || 0];
  if (maxScore != null && maxScore !== '') { where.push('_potencial < ?'); params.push(Number(maxScore)); }
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

  // Enriquece cada linha com a jurimetria do CID.
  for (const r of rows) {
    const info = lookupCid(r.cid_10);
    r.classe = info ? info.classe : 'Não classif.';
    r.taxa = info && typeof info.taxa === 'number' ? Math.round(info.taxa * 10) / 10 : null;
    r.exigencia = info ? info.exig : '';
    r.decisoes = info && info.fav != null && info.total != null ? `${info.fav}/${info.total}` : '';
    r.doc_reforcada = info ? (info.docref || '') : '';
    r.tribunais = info ? (info.tribunais || '') : '';
    r.obs = info ? (info.obs || '') : '';
    const motivos = [];
    if (info) {
      const dec = r.decisoes ? ` (${r.decisoes} decisões)` : '';
      motivos.push(`${r.classe} · ${r.taxa}% êxito${dec}`);
    } else motivos.push('CID não classificado — revisar');
    if (r.m_afast) motivos.push('afastamento');
    r.motivos = motivos;
    delete r.m_afast;
  }

  return { rows, total, limit: safeLimit, offset: safeOffset, minScore: Number(minScore) || 0, pending: pendingCount() };
}

function exportProspectsCsv({ q = '', minScore = 70, maxScore = null } = {}) {
  const all = queryProspects({ q, minScore, maxScore, limit: 500, offset: 0 });
  // Reúne todas as páginas.
  const total = all.total;
  let rows = all.rows;
  let off = 500;
  while (off < total) {
    rows = rows.concat(queryProspects({ q, minScore, maxScore, limit: 500, offset: off }).rows);
    off += 500;
  }
  const labels = { nome: 'Nome', cat: 'CAT', cid_10: 'CID-10', nat_lesao: 'Nat. Lesão', parte_corpo: 'Parte do Corpo', estado_funcionario: 'UF', municipio_funcionario: 'Município' };
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Potencial (%)', 'Classe', 'Taxa êxito (%)', 'Decisões (fav/total)', 'Exigência documental', 'Documentação reforçada', 'Tribunais', 'Observações estratégicas', 'Telefone', ...PROSPECT_FIELDS.map((k) => labels[k]), 'Origem'];
  const lines = [header.map(escape).join(',')];
  for (const r of rows) {
    lines.push([r.potencial, r.classe, r.taxa, r.decisoes, r.exigencia, r.doc_reforcada, r.tribunais, r.obs, r.telefone, ...PROSPECT_FIELDS.map((k) => r[k]), r._source_file].map(escape).join(','));
  }
  return lines.join('\r\n');
}

// Painel analítico (BI): números-chave e principais distribuições.
// Cache inteligente: se os dados não mudaram, serve na hora. Durante a
// indexação (quando bumpData dispara a cada lote), recalcula no máximo a cada
// 30s — senão o painel (consultas pesadas em 11M) recalcularia a cada clique,
// travando a tela e consumindo memória. Defasagem de até 30s é aceitável
// (a tela já mostra o aviso "Indexando...").
let dashCache = null;
function dashboard() {
  const now = Date.now();
  if (dashCache) {
    if (dashCache.version === dataVersion) return dashCache.value; // dados estáveis
    if (now - dashCache.t < 30000) return dashCache.value;          // indexando: no máx. 1x/30s
  }
  const value = computeDashboard();
  dashCache = { t: now, version: dataVersion, value };
  return value;
}
function computeDashboard() {
  const e = prospectExprs();
  const total = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
  const candidatos = db.prepare('SELECT COUNT(*) AS n FROM records WHERE COALESCE(_excluir, _obito, 0) = 0 AND _potencial >= 70').get().n;
  const obitos = db.prepare('SELECT COUNT(*) AS n FROM records WHERE _obito = 1').get().n;
  const inelegiveis = db.prepare('SELECT COUNT(*) AS n FROM records WHERE _excluir = 1 AND COALESCE(_obito,0) = 0').get().n;
  const comTelefone = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE length(trim(${e.tel})) > 0`).get().n;
  const semSequela = countNoSequela();
  const pending = pendingCount();

  // Top-N de uma expressão (ignora vazios).
  const topBy = (expr, limit = 10) => db.prepare(
    `SELECT ${expr} AS label, COUNT(*) AS n FROM records WHERE trim(${expr}) <> '' GROUP BY label ORDER BY n DESC LIMIT ${limit}`,
  ).all();

  // Faixas de potencial (usa a coluna indexada).
  const porNota = db.prepare('SELECT _potencial AS p, COUNT(*) AS n FROM records WHERE _potencial IS NOT NULL GROUP BY _potencial').all();
  const faixas = { 'Muito alta (≥85%)': 0, 'Alta (70-84%)': 0, 'Média (55-69%)': 0, 'Baixa (40-54%)': 0, 'Muito baixa (<40%)': 0 };
  for (const r of porNota) {
    if (r.p >= 85) faixas['Muito alta (≥85%)'] += r.n;
    else if (r.p >= 70) faixas['Alta (70-84%)'] += r.n;
    else if (r.p >= 55) faixas['Média (55-69%)'] += r.n;
    else if (r.p >= 40) faixas['Baixa (40-54%)'] += r.n;
    else faixas['Muito baixa (<40%)'] += r.n;
  }

  return {
    totals: { total, comSequela: total - semSequela, semSequela, candidatos, obitos, inelegiveis, comTelefone, pending },
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
  ensureScoringVersion,
  pendingCount,
  cpfBackfillPending,
  formatCPF,
  countNoSequela,
  deleteNoSequela,
  countCpfDuplicates,
  dedupeByCpf,
  getMaintJob,
  startMaintenance,
  maintAnalyze,
  maintDeleteStep,
  hasSequela,
  dashboard,
  listImports,
  deleteBySource,
  clearAll,
  exportCsv,
  exportCsvClean,
  resetColumnCache,
};
