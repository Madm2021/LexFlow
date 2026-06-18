'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { parse: parseCsvStream } = require('csv-parse');
const { db } = require('./db');
const store = require('./store');
const { MAPPING } = require('./mapping');
const { sanitizeColumnName, makeUnique, cellToValue } = require('./utils');

const BATCH_SIZE = 1000; // linhas por transação

function normalizeValue(v) {
  if (v == null) return '';
  return String(v).trim();
}

// "Impressão digital" da linha já mapeada (para descartar duplicatas idênticas).
function hashMapped(values) {
  const h = crypto.createHash('sha1');
  for (const f of MAPPING) {
    h.update(f.key);
    h.update('=');
    h.update(normalizeValue(values[f.key]));
    h.update('');
  }
  return h.digest('hex');
}

/**
 * Lê as linhas de uma planilha, mapeia cada uma para as colunas pré-definidas
 * (de-para) e insere na tabela única, ignorando duplicatas. Mantém só um lote
 * pequeno na memória.
 */
class MappedBuilder {
  constructor(sourceFile, sheetName) {
    this.sourceFile = sourceFile;
    this.sheetName = sheetName;
    this.importedAt = new Date().toISOString();
    this.header = null;
    this.width = 0;
    // Para cada coluna-destino: lista de índices de origem presentes (prioridade).
    this.fieldIdx = null;
    this.hasMapping = false;
    this.batch = [];
    this.added = 0;
    this.skipped = 0;
  }

  setHeader(header) {
    let h = header.slice();
    while (h.length > 0 && (h[h.length - 1] == null || String(h[h.length - 1]).trim() === '')) h.pop();
    this.header = h;
    this.width = h.length;
    const sqlNames = makeUnique(h.map((c, i) => sanitizeColumnName(c, i)));
    // Mapeia cada coluna-destino para os índices das colunas de origem presentes.
    this.fieldIdx = {};
    for (const f of MAPPING) {
      const idxs = [];
      for (const src of f.sources) {
        const i = sqlNames.indexOf(src);
        if (i >= 0 && !idxs.includes(i)) idxs.push(i);
      }
      if (idxs.length > 0) { this.fieldIdx[f.key] = idxs; this.hasMapping = true; }
    }
  }

  // Monta o objeto { key: valor } de uma linha, pegando o 1º valor preenchido
  // entre as colunas de origem de cada campo (COALESCE por prioridade).
  mapRow(values) {
    const out = {};
    let any = false;
    for (const f of MAPPING) {
      const idxs = this.fieldIdx[f.key];
      if (!idxs) continue;
      let val = '';
      for (const i of idxs) {
        const v = normalizeValue(values[i]);
        if (v !== '') { val = v; break; }
      }
      if (val !== '') {
        // CPF e data são higienizados no insert (store.insertRow); aqui vai cru.
        out[f.key] = val;
        any = true;
      }
    }
    return any ? out : null;
  }

  _flush() {
    if (this.batch.length === 0) return;
    const rows = this.batch;
    const tx = db.transaction(() => {
      for (const values of rows) {
        const mapped = this.mapRow(values);
        if (!mapped) continue; // nada de útil nesta linha
        const hash = hashMapped(mapped);
        const changed = store.insertRow({
          sourceFile: this.sourceFile,
          importedAt: this.importedAt,
          hash,
          values: mapped,
        });
        if (changed === 1) this.added += 1; else this.skipped += 1;
      }
    });
    tx();
    this.batch = [];
  }

  addRow(values) {
    // Linha totalmente vazia: ignora.
    if (values.every((v) => v == null || String(v).trim() === '')) return;
    this.batch.push(values);
    if (this.batch.length >= BATCH_SIZE) this._flush();
  }

  finish() {
    if (!this.header || this.width === 0 || !this.hasMapping) return null;
    this._flush();
    store.recordImport(this.sourceFile, this.sheetName, this.added, this.skipped);
    return { source_file: this.sourceFile, sheet_name: this.sheetName, added: this.added, skipped: this.skipped };
  }
}

function rowToValues(row) {
  const raw = row.values;
  const out = [];
  for (let c = 1; c < raw.length; c += 1) out[c - 1] = cellToValue(raw[c]);
  return out;
}

/** Importa um .xlsx/.xlsm em streaming. */
async function importXlsxStream(filePath, sourceFile) {
  const results = [];
  let reader;
  try {
    reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
      worksheets: 'emit',
    });
    for await (const worksheet of reader) {
      const builder = new MappedBuilder(sourceFile, worksheet.name);
      for await (const row of worksheet) {
        const values = rowToValues(row);
        if (!builder.header) {
          if (values.length === 0) continue;
          builder.setHeader(values);
        } else {
          builder.addRow(values);
        }
      }
      const result = builder.finish();
      if (result) results.push(result);
    }
  } catch (cause) {
    if (results.length === 0) {
      const err = new Error('Não foi possível ler o arquivo: ele parece corrompido ou não é um .xlsx válido.');
      err.statusCode = 400;
      throw err;
    }
    throw cause;
  }
  return results;
}

/** Detecta o separador de um CSV (; , tab ou |). */
function detectDelimiter(buffer) {
  const sample = buffer.toString('utf8', 0, Math.min(buffer.length, 64 * 1024));
  const lines = sample.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 10);
  const candidates = [';', ',', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const delim of candidates) {
    const counts = lines.map((l) => l.split(delim).length - 1);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const avg = total / counts.length;
    if (avg > bestScore) { bestScore = avg; best = delim; }
  }
  return best;
}

function detectDelimiterFromFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(64 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return detectDelimiter(buf.subarray(0, n));
}

/** Importa um CSV em streaming (arquivos grandes, sem carregar tudo). */
function importCsvStream(filePath, sourceFile) {
  const delimiter = detectDelimiterFromFile(filePath);
  const builder = new MappedBuilder(sourceFile, null);
  let isHeader = true;
  return new Promise((resolve, reject) => {
    const parser = parseCsvStream({
      bom: true,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
    });
    parser.on('readable', () => {
      let rec;
      // eslint-disable-next-line no-cond-assign
      while ((rec = parser.read()) !== null) {
        if (isHeader) { builder.setHeader(rec); isHeader = false; } else builder.addRow(rec);
      }
    });
    parser.on('error', reject);
    parser.on('end', () => {
      const result = builder.finish();
      resolve(result ? [result] : []);
    });
    fs.createReadStream(filePath).on('error', reject).pipe(parser);
  });
}

/** Importa um arquivo a partir do caminho em disco. */
async function importFilePath(filePath, filename) {
  const ext = path.extname(filename).toLowerCase();
  let results;
  if (ext === '.csv' || ext === '.txt') {
    results = await importCsvStream(filePath, filename);
  } else if (ext === '.xlsx' || ext === '.xlsm') {
    results = await importXlsxStream(filePath, filename);
  } else if (ext === '.xls') {
    const err = new Error('Formato .xls (Excel antigo) não é suportado. Abra no Excel e salve como .xlsx.');
    err.statusCode = 400;
    throw err;
  } else {
    const err = new Error(`Formato não suportado: ${ext || 'desconhecido'}. Use .xlsx, .xlsm ou .csv.`);
    err.statusCode = 400;
    throw err;
  }
  if (results.length === 0) {
    const err = new Error('Nenhuma coluna reconhecida (CPF, Nome, Cidade, etc.) foi encontrada no arquivo.');
    err.statusCode = 400;
    throw err;
  }
  const added = results.reduce((a, r) => a + r.added, 0);
  const skipped = results.reduce((a, r) => a + r.skipped, 0);
  return { file: filename, added, skipped, sheets: results };
}

async function importFile(buffer, filename) {
  const tmp = path.join(os.tmpdir(), `lexflow_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(filename)}`);
  fs.writeFileSync(tmp, buffer);
  try {
    return await importFilePath(tmp, filename);
  } finally {
    fs.unlink(tmp, () => {});
  }
}

module.exports = { importFile, importFilePath, detectDelimiter, hashMapped };
