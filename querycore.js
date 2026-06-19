'use strict';

// Lógica de consulta e contagem, sem estado próprio: cada função recebe a
// conexão `db`. Assim o processo principal e a thread de trabalho (worker)
// compartilham exatamente a mesma lógica, cada um com sua conexão.
const { COLUMNS, COLUMN_KEYS, FILTER_KEYS, FTS_FILTER_KEYS, DISTINCT_KEYS } = require('./schema');
const { normalizeUF, variantsFor } = require('./uf');
const { classifyCid, cidTierSql } = require('./cid');

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
function buildQuery({ q = '', filters = {}, validCpf = false, excludeProspected = false, cidTier = null } = {}) {
  const where = [];
  const params = [];
  let from = 'FROM records r';
  if (validCpf) where.push('r._cpf_ok = 1');
  // "Esconder já prospectados": deixa de fora os leads já carimbados.
  if (excludeProspected) where.push('r._prospect IS NULL');
  // Clientes com contrato assinado (baixa): NUNCA entram em nenhum recorte.
  where.push('r._cliente IS NULL');
  // Triagem por potencial de sequela do CID (A/B/C).
  if (cidTier === 'A' || cidTier === 'B' || cidTier === 'C') {
    where.push(`${cidTierSql('cid_10')} = ?`);
    params.push(cidTier);
  }

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
  // "filtered" = TEM recorte do usuário (busca/filtro/triagem). O "_cliente IS
  // NULL" é base fixa (todo mundo tem) e NÃO conta — senão a distribuição sem
  // filtro cairia no caminho da tabela temporária (materializar a base inteira).
  const filtered = !!(q || validCpf || excludeProspected || cidTier
    || FILTER_KEYS.some((k) => filters[k] != null && String(filters[k]).trim() !== ''));
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
function query(db, { limit = 50, offset = 0, q = '', filters = {}, validCpf = false, excludeProspected = false, cidTier = null, sort = null, dir = 'asc' } = {}, total) {
  const columns = COLUMNS.map((c) => ({ column_name: c.key, original_name: c.label }));
  const { from, whereSql, params } = buildQuery({ q, filters, validCpf, excludeProspected, cidTier });

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

function count(db, { q = '', filters = {}, validCpf = false, excludeProspected = false, cidTier = null } = {}) {
  const { from, whereSql, params } = buildQuery({ q, filters, validCpf, excludeProspected, cidTier });
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

// --- Ano do registro ---------------------------------------------------------
// O ano sai dos 4 primeiros dígitos da CAT (ex.: "2005..."); quando o lead NÃO
// tem CAT (ou a CAT não começa por um ano plausível), cai para o ano da Data
// Atend. — os dois se complementam. Quem não tem nenhum dos dois fica "sem ano".
function yearExpr() {
  const maxY = new Date().getFullYear() + 1;
  const cat = "replace(replace(replace(replace(COALESCE(r.cat,''),'.',''),'-',''),'/',''),' ','')";
  const catY = `CAST(substr(${cat},1,4) AS INTEGER)`;
  const da = "COALESCE(r.data_atend,'')";
  const daIso = `CAST(substr(${da},1,4) AS INTEGER)`;   // aaaa-mm-dd
  const daBr = `CAST(substr(${da},7,4) AS INTEGER)`;     // dd/mm/aaaa
  // GLOB usa ? (um caractere) e * (qualquer sequência) — diferente do LIKE.
  return `CASE
    WHEN length(${cat}) >= 4 AND ${catY} BETWEEN 1990 AND ${maxY} THEN ${catY}
    WHEN ${da} GLOB '????-??*' AND ${daIso} BETWEEN 1990 AND ${maxY} THEN ${daIso}
    WHEN ${da} GLOB '??/??/????*' AND ${daBr} BETWEEN 1990 AND ${maxY} THEN ${daBr}
    ELSE NULL END`;
}

// Contagem por ano (ordenada do mais recente ao mais antigo) + os "sem ano".
function yearCounts(db, from, whereSql, params) {
  const y = yearExpr();
  const rows = db.prepare(
    `SELECT ${y} AS y, COUNT(*) AS n ${from} ${whereSql} GROUP BY y`,
  ).all(...params);
  const semAno = rows.filter((r) => r.y == null).reduce((s, r) => s + r.n, 0);
  const byAno = rows.filter((r) => r.y != null)
    .sort((a, b) => b.y - a.y)
    .map((r) => ({ value: String(r.y), n: r.n }));
  return { byAno, semAno };
}

// Quantos leads NÃO têm número de CAT.
function semCatCount(db, from, whereSql, params) {
  const base = whereSql ? `${whereSql} AND ` : 'WHERE ';
  return db.prepare(
    `SELECT COUNT(*) AS n ${from} ${base} (r.cat IS NULL OR trim(r.cat) = '')`,
  ).get(...params).n;
}

// Contagem por potencial de sequela do CID (A/B/C) — a triagem.
function cidTierCounts(db, from, whereSql, params) {
  const base = whereSql ? `${whereSql} AND ` : 'WHERE ';
  const rows = db.prepare(
    `SELECT ${cidTierSql('cid_10')} AS t, COUNT(*) AS n ${from} ${base}
       cid_10 IS NOT NULL AND cid_10 <> '' GROUP BY t`,
  ).all(...params);
  const out = { A: 0, B: 0, C: 0 };
  for (const r of rows) if (r.t) out[r.t] = r.n;
  return out;
}

// As contagens em si, dado um FROM/WHERE qualquer (a tabela real OU o recorte
// já materializado em _hits). Todas as colunas usadas têm os mesmos nomes.
function aggregateFacets(db, from, whereSql, params) {
  const { byAno, semAno } = yearCounts(db, from, whereSql, params);
  const byCid = topBy(db, 'cid_10', 40, from, whereSql, params);
  byCid.forEach((it) => { it.tier = classifyCid(it.value); }); // selo 🟢🟡🔴
  return {
    total: db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(...params).n,
    byEstado: estadoCounts(db, from, whereSql, params, 27),
    byMunicipio: topBy(db, 'municipio_funcionario', 40, from, whereSql, params),
    byCid,
    byCidTier: cidTierCounts(db, from, whereSql, params),
    byAno,
    semAno,
    semCat: semCatCount(db, from, whereSql, params),
  };
}

function aggregateFacetsCsv(db, from, whereSql, params) {
  const lines = [['Dimensão', 'Valor', 'Quantidade'].join(CSV_SEP)];
  const push = (label, rows) => rows.forEach((r) => lines.push([label, csvEscape(r.value), r.n].join(CSV_SEP)));
  const { byAno, semAno } = yearCounts(db, from, whereSql, params);
  push('Ano', byAno);
  if (semAno) lines.push(['Ano', 'Sem ano', semAno].join(CSV_SEP));
  lines.push(['CAT', 'Sem CAT', semCatCount(db, from, whereSql, params)].join(CSV_SEP));
  push('Estado', estadoCounts(db, from, whereSql, params, 100));
  push('Município', topBy(db, 'municipio_funcionario', 1000, from, whereSql, params));
  push('CID-10', topBy(db, 'cid_10', 1000, from, whereSql, params));
  return lines.join('\r\n');
}

// Só as colunas que a distribuição usa — para a tabela temporária do recorte.
const HITS_COLS = `r.estado_funcionario AS estado_funcionario,
  r.municipio_funcionario AS municipio_funcionario, r.cid_10 AS cid_10,
  r.cat AS cat, r.data_atend AS data_atend`;

// PORQUÊ: num recorte filtrado/busca, cada contagem faria FTS/índice + buscar a
// linha por rowid na tabela gigante (vários GB). Eram 6 dessas passadas — em
// milhões de linhas, leituras aleatórias demais → 502. Aqui materializamos o
// recorte UMA vez (só as 5 colunas usadas) numa tabela temporária e agregamos em
// cima dela: 1 passada na base + varreduras sequenciais baratas. TEMP funciona
// mesmo na conexão somente-leitura do worker (vai para o armazenamento temp).
function withHits(db, from, whereSql, params, fn) {
  db.exec('DROP TABLE IF EXISTS _hits');
  db.prepare(`CREATE TEMP TABLE _hits AS SELECT ${HITS_COLS} ${from} ${whereSql}`).run(...params);
  try { return fn('FROM _hits r', '', []); }
  finally { db.exec('DROP TABLE IF EXISTS _hits'); }
}

function computeFacets(db, opts = {}) {
  const { from, whereSql, params, filtered } = buildQuery(opts);
  if (!filtered) return aggregateFacets(db, from, whereSql, params);
  return withHits(db, from, whereSql, params, (f, w, p) => aggregateFacets(db, f, w, p));
}

function computeFacetsCsv(db, opts = {}) {
  const { from, whereSql, params, filtered } = buildQuery(opts);
  if (!filtered) return aggregateFacetsCsv(db, from, whereSql, params);
  return withHits(db, from, whereSql, params, (f, w, p) => aggregateFacetsCsv(db, f, w, p));
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

function streamCsv(db, { q = '', filters = {}, validCpf = false, excludeProspected = false, cidTier = null } = {}, write) {
  const { from, whereSql, params } = buildQuery({ q, filters, validCpf, excludeProspected, cidTier });
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
