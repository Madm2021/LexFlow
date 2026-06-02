'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.LEXFLOW_DB || path.join(DATA_DIR, 'lexflow.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Modelo unificado: TODAS as planilhas alimentam uma única tabela "records".
// - "columns" é o catálogo da união de colunas vistas em todos os arquivos.
// - "imports" guarda o histórico de cada importação (quantas linhas entraram
//   e quantas foram ignoradas por já existirem).
// - "records" tem colunas fixas de controle + colunas dinâmicas (uma por
//   coluna do catálogo), adicionadas via ALTER TABLE conforme aparecem.
//   "_hash" é a impressão digital da linha, com índice único: é o que impede
//   a inserção de linhas duplicadas (INSERT OR IGNORE).
db.exec(`
  CREATE TABLE IF NOT EXISTS columns (
    column_name   TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    data_type     TEXT NOT NULL,
    position      INTEGER NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS imports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file  TEXT NOT NULL,
    sheet_name   TEXT,
    rows_added   INTEGER NOT NULL,
    rows_skipped INTEGER NOT NULL,
    imported_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS records (
    _rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
    _source_file TEXT,
    _imported_at TEXT,
    _hash        TEXT NOT NULL UNIQUE
  );
`);

// Colunas de controle que existem sempre (não vêm das planilhas).
const META_COLUMNS = new Set(['_rowid', '_source_file', '_imported_at', '_hash']);

module.exports = { db, DB_PATH, META_COLUMNS };
