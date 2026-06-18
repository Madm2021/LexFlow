'use strict';

// Constantes de esquema, derivadas do de-para (mapping.js). Módulo "puro" (sem
// abrir banco) para poder ser usado tanto pelo processo principal quanto pela
// thread de trabalho (worker) sem reexecutar a configuração do banco.
const { MAPPING } = require('./mapping');

const COLUMNS = MAPPING.map((f) => ({ key: f.key, label: f.label }));
const COLUMN_KEYS = COLUMNS.map((c) => c.key);

// Colunas com índice próprio para filtro por prefixo.
const FILTER_KEYS = ['estado_funcionario', 'municipio_funcionario'];
// Filtros resolvidos pelo índice full-text (sem índice de coluna próprio).
const FTS_FILTER_KEYS = ['cid_10'];
const ALL_FILTER_KEYS = [...FILTER_KEYS, ...FTS_FILTER_KEYS];
// Colunas que viram dropdown de filtro (baixa cardinalidade) no front.
const DISTINCT_KEYS = ['estado_funcionario'];

// Colunas de controle que existem sempre (não vêm das planilhas).
const META_COLUMNS = new Set(['_rowid', '_source_file', '_imported_at', '_hash', '_search']);

module.exports = {
  COLUMNS, COLUMN_KEYS, FILTER_KEYS, FTS_FILTER_KEYS, ALL_FILTER_KEYS, DISTINCT_KEYS, META_COLUMNS,
};
