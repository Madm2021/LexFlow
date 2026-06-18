'use strict';

const { db, COLUMNS, COLUMN_KEYS, FILTER_KEYS } = require('./db');
const { normalizeUF, variantsFor } = require('./uf');

// Filtros resolvidos pelo índice full-text (sem índice de coluna próprio).
const FTS_FILTER_KEYS = ['cid_10'];
// Todos os filtros aceitos (coluna indexada + full-text) — usado pelo servidor.
const ALL_FILTER_KEYS = [...FILTER_KEYS, ...FTS_FILTER_KEYS];
// Colunas baixa-cardinalidade que viram dropdown de filtro no front-end.
const DISTINCT_KEYS = ['estado_funcionario'];

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
// Para Estado, normaliza para a sigla (junta "SP"/"SAO PAULO") e descarta lixo
// (datas, cidades, valores que não são UF). Em cache (não muda sem reimport).
function distinctValues(col) {
  if (!DISTINCT_KEYS.includes(col)) return [];
  return cached(`distinct:${col}`, () => {
    const raw = db.prepare(
      `SELECT "${col}" AS v, COUNT(*) AS n FROM records
       WHERE "${col}" IS NOT NULL AND "${col}" <> ''
       GROUP BY "${col}" COLLATE NOCASE ORDER BY n DESC LIMIT 2000`,
    ).all();
    if (col === 'estado_funcionario') {
      const m = new Map();
      for (const r of raw) { const uf = normalizeUF(r.v); if (uf) m.set(uf, (m.get(uf) || 0) + r.n); }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([uf]) => uf);
    }
    return raw.map((r) => r.v);
  });
}

// ---------------------------------------------------------------------------
// Consulta da lista: busca full-text (q) + filtros por coluna + paginação.
// ---------------------------------------------------------------------------

// Tokens de prefixo para o FTS5 (cada palavra vira "palavra*", com AND implícito).
function prefixTerms(text) {
  const tokens = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.map((t) => `${t}*`).join(' ');
}

// Converte a busca do usuário em uma expressão FTS5. Além dos prefixos por
// palavra, se houver muitos dígitos junta-os num termo (acha CPF por números).
function ftsQuery(q) {
  let terms = prefixTerms(q);
  const digits = String(q).replace(/\D/g, '');
  if (digits.length >= 3 && !terms.includes(`${digits}*`)) terms += ` ${digits}*`;
  return terms.trim() || null;
}

// Monta FROM/WHERE/params a partir de q + filtros.
// - q + filtros full-text (ex.: CID-10) viram uma única expressão MATCH no FTS.
// - filtros com índice de coluna (estado, município) viram LIKE por prefixo.
function buildQuery({ q = '', filters = {} } = {}) {
  const where = [];
  const params = [];
  let from = 'FROM records r';

  const ftsTerms = [];
  if (q) { const fq = ftsQuery(q); if (fq) ftsTerms.push(fq); }
  for (const k of FTS_FILTER_KEYS) {
    const val = filters[k];
    if (val != null && String(val).trim() !== '') {
      const t = prefixTerms(String(val).trim());
      if (t) ftsTerms.push(t);
    }
  }
  if (ftsTerms.length) {
    from += ' JOIN records_fts ON records_fts.rowid = r._rowid';
    where.push('records_fts MATCH ?');
    params.push(ftsTerms.join(' '));
  }

  for (const k of FILTER_KEYS) {
    const val = filters[k];
    if (val == null || String(val).trim() === '') continue;
    const v = String(val).trim();
    if (k === 'estado_funcionario') {
      // Casa todas as variações da UF (ex.: "SP" e "SAO PAULO").
      const vars = variantsFor(v);
      where.push(`(${vars.map(() => `r."${k}" LIKE ?`).join(' OR ')})`);
      vars.forEach((x) => params.push(`${x}%`));
    } else {
      // Prefixo, sem acento/maiúsculas (índice COLLATE NOCASE acelera).
      where.push(`r."${k}" LIKE ?`);
      params.push(`${v}%`);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const filtered = where.length > 0;
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

// ---------------------------------------------------------------------------
// FACETAS / DISTRIBUIÇÃO: quantidades por valor (Estado, Município, CID),
// respeitando a busca/filtros atuais. Pesado em bases grandes, então o caso
// "sem filtro" fica em cache (só recalcula quando os dados mudam).
// ---------------------------------------------------------------------------
function topBy(col, limit, from, whereSql, params) {
  const base = whereSql ? `${whereSql} AND ` : 'WHERE ';
  return db.prepare(
    `SELECT r."${col}" AS value, COUNT(*) AS n ${from} ${base}
       r."${col}" IS NOT NULL AND r."${col}" <> ''
     GROUP BY r."${col}" COLLATE NOCASE ORDER BY n DESC LIMIT ?`,
  ).all(...params, limit);
}

// Contagem por Estado já normalizada (junta "SP"/"SAO PAULO", descarta lixo).
function estadoCounts(from, whereSql, params, limit) {
  const raw = topBy('estado_funcionario', 200, from, whereSql, params);
  const m = new Map();
  for (const r of raw) { const uf = normalizeUF(r.value); if (uf) m.set(uf, (m.get(uf) || 0) + r.n); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, n]) => ({ value, n }));
}

function facets({ q = '', filters = {} } = {}) {
  // Cacheia por recorte (busca + filtros). Some quando os dados mudam.
  return cached(`facets:${JSON.stringify({ q, filters })}`, () => {
    const { from, whereSql, params, filtered } = buildQuery({ q, filters });
    return {
      total: filtered
        ? db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(...params).n
        : cached('total', () => db.prepare('SELECT COUNT(*) AS n FROM records').get().n),
      byEstado: estadoCounts(from, whereSql, params, 40),
      byMunicipio: topBy('municipio_funcionario', 12, from, whereSql, params),
      byCid: topBy('cid_10', 12, from, whereSql, params),
    };
  });
}

// Exporta a distribuição (contagens por Estado/Município/CID) em CSV.
function facetsCsv({ q = '', filters = {} } = {}) {
  const { from, whereSql, params } = buildQuery({ q, filters });
  const lines = ['Dimensão,Valor,Quantidade'];
  const push = (label, rows) => rows.forEach((r) => lines.push([label, csvEscape(r.value), r.n].join(',')));
  push('Estado', estadoCounts(from, whereSql, params, 100));
  push('Município', topBy('municipio_funcionario', 1000, from, whereSql, params));
  push('CID-10', topBy('cid_10', 1000, from, whereSql, params));
  return lines.join('\r\n');
}

// Pré-aquece o cache (distribuição sem filtro + dropdown de Estado) para que a
// primeira abertura do painel seja instantânea. Chamado na inicialização.
function warm() {
  try { distinctValues('estado_funcionario'); } catch (e) { console.error('warm distinct:', e.message); }
  try { facets(); } catch (e) { console.error('warm facets:', e.message); }
}

module.exports = {
  COLUMN_KEYS,
  FILTER_KEYS,
  FTS_FILTER_KEYS,
  ALL_FILTER_KEYS,
  DISTINCT_KEYS,
  facets,
  facetsCsv,
  warm,
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
