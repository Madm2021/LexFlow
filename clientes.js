'use strict';

// Extrai os CPFs de uma planilha de CLIENTES (contrato assinado), para dar baixa
// na base. Não importa registros novos: só varre as células, valida o dígito
// verificador e devolve o conjunto de CPFs (11 dígitos) para casar com a base.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { parse: parseCsvStream } = require('csv-parse');
const { isValidCPF } = require('./hygiene');
const { cellToValue } = require('./utils');

// Uma célula vira um CPF de 11 dígitos só se passar no dígito verificador.
function cpfFromCell(v) {
  if (v == null) return null;
  const d = String(v).replace(/\D/g, '');
  if (d.length < 9 || d.length > 11) return null;
  const padded = d.padStart(11, '0');
  return isValidCPF(padded) ? padded : null;
}

async function fromXlsx(filePath, set) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit',
  });
  for await (const ws of reader) {
    for await (const row of ws) {
      const raw = row.values;
      for (let c = 1; c < raw.length; c += 1) {
        const cpf = cpfFromCell(cellToValue(raw[c]));
        if (cpf) set.add(cpf);
      }
    }
  }
}

function detectDelimiter(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(64 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const sample = buf.subarray(0, n).toString('utf8');
  const lines = sample.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 10);
  let best = ',';
  let bestScore = -1;
  for (const delim of [';', ',', '\t', '|']) {
    const total = lines.reduce((a, l) => a + (l.split(delim).length - 1), 0);
    if (total > bestScore) { bestScore = total; best = delim; }
  }
  return best;
}

function fromCsv(filePath, set) {
  return new Promise((resolve, reject) => {
    const parser = parseCsvStream({
      bom: true, delimiter: detectDelimiter(filePath), skip_empty_lines: true,
      relax_column_count: true, relax_quotes: true, trim: true,
    });
    parser.on('readable', () => {
      let rec;
      // eslint-disable-next-line no-cond-assign
      while ((rec = parser.read()) !== null) {
        for (const cell of rec) { const cpf = cpfFromCell(cell); if (cpf) set.add(cpf); }
      }
    });
    parser.on('error', reject);
    parser.on('end', resolve);
    fs.createReadStream(filePath).on('error', reject).pipe(parser);
  });
}

// Lê o arquivo e devolve o conjunto de CPFs (11 dígitos) encontrados.
async function extractCpfs(filePath, filename) {
  const ext = path.extname(filename).toLowerCase();
  const set = new Set();
  if (ext === '.csv' || ext === '.txt') await fromCsv(filePath, set);
  else if (ext === '.xlsx' || ext === '.xlsm') await fromXlsx(filePath, set);
  else {
    const err = new Error(`Formato não suportado: ${ext || 'desconhecido'}. Use .xlsx, .xlsm ou .csv.`);
    err.statusCode = 400;
    throw err;
  }
  return set;
}

module.exports = { extractCpfs, cpfFromCell };
