'use strict';

// Thread de trabalho: executa as contagens pesadas (distribuição/facetas) numa
// conexão própria, em paralelo, para NÃO travar o servidor principal. Em WAL,
// vários leitores convivem com o escritor sem bloquear.
const path = require('path');
const { parentPort } = require('worker_threads');
const Database = require('better-sqlite3');
const core = require('./querycore');

const DB_PATH = process.env.LEXFLOW_DB || path.join(__dirname, 'data', 'lexflow.db');
const db = new Database(DB_PATH, { readonly: true });
db.pragma('cache_size = -131072');
db.pragma('mmap_size = 268435456');

parentPort.on('message', (msg) => {
  const { id, type, payload } = msg;
  try {
    let result;
    if (type === 'facets') result = core.computeFacets(db, payload);
    else if (type === 'facetsCsv') result = core.computeFacetsCsv(db, payload);
    else if (type === 'distinct') result = core.computeDistinct(db, payload.col);
    else throw new Error(`Tipo desconhecido: ${type}`);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
