'use strict';

/**
 * Funções utilitárias compartilhadas: sanitização de nomes de colunas/tabelas,
 * inferência de tipos e normalização de valores de células.
 */

// Palavras reservadas que não podem virar nome de coluna sozinhas.
const RESERVED = new Set(['_rowid', 'rowid', 'oid', '_rowid_']);

/**
 * Remove acentos de uma string (ex: "Endereço" -> "Endereco").
 */
function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Converte um cabeçalho de planilha em um identificador SQL válido.
 * Mantém legibilidade, mas garante que comece com letra e só tenha [a-z0-9_].
 */
function sanitizeColumnName(raw, fallbackIndex) {
  let name = String(raw == null ? '' : raw).trim();
  name = stripAccents(name).toLowerCase();
  name = name.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) name = `coluna_${fallbackIndex + 1}`;
  if (/^[0-9]/.test(name)) name = `c_${name}`;
  if (RESERVED.has(name)) name = `${name}_col`;
  return name;
}

/**
 * Garante nomes únicos numa lista, adicionando sufixos _2, _3, ...
 */
function makeUnique(names) {
  const seen = new Map();
  return names.map((name) => {
    if (!seen.has(name)) {
      seen.set(name, 1);
      return name;
    }
    let count = seen.get(name) + 1;
    let candidate = `${name}_${count}`;
    while (seen.has(candidate)) {
      count += 1;
      candidate = `${name}_${count}`;
    }
    seen.set(name, count);
    seen.set(candidate, 1);
    return candidate;
  });
}

/**
 * Gera um nome de tabela físico seguro a partir do id do dataset.
 */
function tableNameForDataset(id) {
  return `ds_${id}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const BR_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/**
 * Tenta interpretar um valor como número (aceitando formato brasileiro 1.234,56).
 * Retorna { ok, value }.
 */
function tryParseNumber(value) {
  if (typeof value === 'number') return { ok: Number.isFinite(value), value };
  if (typeof value !== 'string') return { ok: false };
  let s = value.trim();
  if (!s) return { ok: false };
  // Remove símbolo de moeda e espaços.
  s = s.replace(/^R\$\s?/i, '').replace(/\s+/g, '');
  // Formato brasileiro: ponto como milhar, vírgula como decimal.
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d+,\d+$/.test(s)) {
    s = s.replace(',', '.');
  }
  if (!/^-?\d*\.?\d+$/.test(s)) return { ok: false };
  const n = Number(s);
  return { ok: Number.isFinite(n), value: n };
}

/**
 * Infere o tipo de uma coluna a partir de uma amostra de valores (ignora nulos).
 * Retorna 'number', 'date' ou 'text'.
 */
function inferType(values) {
  let nonNull = 0;
  let numbers = 0;
  let dates = 0;
  for (const v of values) {
    if (v == null || v === '') continue;
    nonNull += 1;
    if (v instanceof Date) {
      dates += 1;
      continue;
    }
    // Códigos com zero à esquerda (CEP, CPF, PIS, etc.) devem ficar como texto
    // para não perder o zero inicial. Ex.: "07410020" não vira número.
    if (typeof v === 'string' && /^0\d+$/.test(v.trim())) {
      return 'text';
    }
    if (tryParseNumber(v).ok) {
      numbers += 1;
      continue;
    }
    if (typeof v === 'string' && (DATE_RE.test(v.trim()) || BR_DATE_RE.test(v.trim()))) {
      dates += 1;
    }
  }
  if (nonNull === 0) return 'text';
  if (numbers === nonNull) return 'number';
  if (dates === nonNull) return 'date';
  return 'text';
}

/**
 * Normaliza um valor de célula do exceljs para um valor primitivo simples.
 */
function cellToValue(cell) {
  if (cell == null) return null;
  if (cell instanceof Date) return cell.toISOString();
  if (typeof cell === 'object') {
    if (cell.text != null) return cell.text;
    if (cell.result != null) return cell.result instanceof Date ? cell.result.toISOString() : cell.result;
    if (Array.isArray(cell.richText)) return cell.richText.map((r) => r.text).join('');
    if (cell.hyperlink != null) return cell.hyperlink;
    if (cell.error != null) return null;
    return null;
  }
  return cell;
}

/**
 * Converte um valor para o tipo de armazenamento apropriado antes de inserir.
 */
function coerceForStorage(value, type) {
  if (value == null || value === '') return null;
  if (type === 'number') {
    const parsed = tryParseNumber(value);
    return parsed.ok ? parsed.value : null;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

module.exports = {
  stripAccents,
  sanitizeColumnName,
  makeUnique,
  tableNameForDataset,
  tryParseNumber,
  inferType,
  cellToValue,
  coerceForStorage,
};
