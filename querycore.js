'use strict';

// Lógica de consulta e contagem, sem estado próprio: cada função recebe a
// conexão `db`. Assim o processo principal e a thread de trabalho (worker)
// compartilham exatamente a mesma lógica, cada um com sua conexão.
const { COLUMNS, COLUMN_KEYS, FILTER_KEYS, FTS_FILTER_KEYS, DISTINCT_KEYS } = require('./schema');
const { normalizeUF, variantsFor } = require('./uf');

// Tokens de prefixo para o FTS5 (cada palavra vira "palavra*", com AND implícito).
function prefixTerms(text) {
  const tokens = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.map((t) => `${t}*`).join(' ');
}

// Converte a busca do usuário em expressão FTS5; dígitos viram termo (CPF).
function ftsQuery(q) {
  let terms = prefixTerms(q);
  const digits = String(q).replace(/\D/g, '');
  if (digits.length >= 3 && !terms.includes(`${digits}*`)) terms += ` ${digits}*`;
  return terms.trim() || null;
}

// Monta FROM/WHERE/params a partir de q + filtros (+ apenas CPF válido).
function buildQuery({ q = '', filters = {}, validCpf = false } = {}) {
  const where = [];
  const params = [];
  let from = 'FROM records r';
  if (validCpf) where.push('r._cpf_ok = 1');

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
      const vars = variantsFor(v);
      where.push(`(${vars.map(() => `r."${k}" LIKE ?`).join(' OR ')})`);
      vars.forEach((x) => params.push(`${x}%`));
    } else {
      where.push(`r."${k}" LIKE ?`);
      params.push(`${v}%`);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const filtered = where.length > 0;
  return { from, whereSql, params, filtered };
}

// Separador ";" (ponto-e-vírgula): o Excel em português (pt-BR) usa ";" como
// separador de listas, então o arquivo abre com as colunas já separadas. Bônus:
// valores com vírgula decimal (ex.: "1.252,00") ficam intactos numa só célula.
const CSV_SEP = ';';
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Preserva o ZERO À ESQUERDA e evita notação científica no Excel. Valores que
// são só dígitos e (a) começam com zero (CPF sem máscara, CEP, CTPS, telefone)
// ou (b) são bem longos (Excel mostraria 1.23E+11), saem como texto forçado
// (=\"...\"), então o Excel mantém exatamente como está, sem cortar o zero.
function excelCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/^\d+$/.test(s) && (s[0] === '0' || s.length >= 12)) return `="${s}"`;
  return s;
}

// --- Busca paginada (rápida: usa FTS/índices) ---
function query(db, { limit = 50, offset = 0, q = '', filters = {}, validCpf = false, sort = null, dir = 'asc' } = {}, total) {
  const columns = COLUMNS.map((c) => ({ column_name: c.key, original_name: c.label }));
  const { from, whereSql, params } = buildQuery({ q, filters, validCpf });

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

function count(db, { q = '', filters = {}, validCpf = false } = {}) {
  const { from, whereSql, params } = buildQuery({ q, filters, validCpf });
  return db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(...params).n;
}

// --- Contagens / distribuição ---
function topBy(db, col, limit, from, whereSql, params) {
  const base = whereSql ? `${whereSql} AND ` : 'WHERE ';
  return db.prepare(
    `SELECT r."${col}" AS value, COUNT(*) AS n ${from} ${base}
       r."${col}" IS NOT NULL AND r."${col}" <> ''
     GROUP BY r."${col}" COLLATE NOCASE ORDER BY n DESC LIMIT ?`,
  ).all(...params, limit);
}

// Contagem por Estado já normalizada (junta "SP"/"SAO PAULO", descarta lixo).
function estadoCounts(db, from, whereSql, params, limit) {
  const raw = topBy(db, 'estado_funcionario', 200, from, whereSql, params);
  const m = new Map();
  for (const r of raw) { const uf = normalizeUF(r.value); if (uf) m.set(uf, (m.get(uf) || 0) + r.n); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, n]) => ({ value, n }));
}

function computeFacets(db, { q = '', filters = {}, validCpf = false } = {}) {
  const { from, whereSql, params } = buildQuery({ q, filters, validCpf });
  return {
    total: db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(...params).n,
    byEstado: estadoCounts(db, from, whereSql, params, 40),
    byMunicipio: topBy(db, 'municipio_funcionario', 12, from, whereSql, params),
    byCid: topBy(db, 'cid_10', 12, from, whereSql, params),
  };
}

function computeFacetsCsv(db, { q = '', filters = {}, validCpf = false } = {}) {
  const { from, whereSql, params } = buildQuery({ q, filters, validCpf });
  const lines = [['Dimensão', 'Valor', 'Quantidade'].join(CSV_SEP)];
  const push = (label, rows) => rows.forEach((r) => lines.push([label, csvEscape(r.value), r.n].join(CSV_SEP)));
  push('Estado', estadoCounts(db, from, whereSql, params, 100));
  push('Município', topBy(db, 'municipio_funcionario', 1000, from, whereSql, params));
  push('CID-10', topBy(db, 'cid_10', 1000, from, whereSql, params));
  return lines.join('\r\n');
}

function computeDistinct(db, col) {
  if (!DISTINCT_KEYS.includes(col)) return [];
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
}

function streamCsv(db, { q = '', filters = {}, validCpf = false } = {}, write) {
  const { from, whereSql, params } = buildQuery({ q, filters, validCpf });
  // Sem a coluna "Origem": exporta de CAT em diante, na ordem do schema.
  write(COLUMNS.map((c) => csvEscape(c.label)).join(CSV_SEP) + '\r\n');
  const selectCols = COLUMN_KEYS.map((k) => `r."${k}"`).join(', ');
  const stmt = db.prepare(`SELECT ${selectCols} ${from} ${whereSql} ORDER BY r._rowid ASC`);
  for (const row of stmt.iterate(...params)) {
    write(COLUMN_KEYS.map((k) => csvEscape(excelCell(row[k]))).join(CSV_SEP) + '\r\n');
  }
}

module.exports = {
  prefixTerms, ftsQuery, buildQuery, csvEscape,
  query, count, topBy, estadoCounts,
  computeFacets, computeFacetsCsv, computeDistinct, streamCsv,
};
