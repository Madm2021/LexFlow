'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');

const { importFilePath } = require('./importer');
const store = require('./store');
const auth = require('./auth');
const { db, DB_PATH } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// Upload em disco (arquivo temporário): suporta arquivos grandes sem estourar
// a memória. Até 2 GB por arquivo, vários arquivos por vez.
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-uploads-'));
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 20 },
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- Autenticação por senha (ativa só quando LEXFLOW_PASSWORD está definida) ---
function loginPage(message) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LexFlow — Entrar</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0f1419;color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}
  form{background:#1a2129;border:1px solid #2c3845;border-radius:14px;padding:32px;width:320px;text-align:center}
  .logo{font-size:40px;color:#4f9cf9}
  h1{font-size:20px;margin:6px 0 2px} p{color:#8b9bb0;font-size:13px;margin:0 0 18px}
  input{width:100%;padding:12px;border-radius:10px;border:1px solid #2c3845;background:#0f1419;color:#e6edf3;font-size:15px;box-sizing:border-box}
  button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#4f9cf9;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .err{color:#e5534b;font-size:13px;margin-top:12px;min-height:16px}
</style></head><body>
<form method="POST" action="/login">
  <div class="logo">⬡</div>
  <h1>LexFlow</h1>
  <p>Digite a senha de acesso</p>
  <input type="password" name="password" placeholder="Senha" autofocus required />
  <button type="submit">Entrar</button>
  <div class="err">${message || ''}</div>
</form></body></html>`;
}

if (auth.enabled()) {
  app.get('/login', (req, res) => res.send(loginPage('')));
  app.post('/login', (req, res) => {
    if (!auth.checkPassword(req.body.password)) {
      return res.status(401).send(loginPage('Senha incorreta. Tente novamente.'));
    }
    res.setHeader('Set-Cookie', `${auth.COOKIE}=${auth.makeToken()}; HttpOnly; Path=/; Max-Age=${auth.MAX_AGE_MS / 1000}; SameSite=Lax${req.secure ? '; Secure' : ''}`);
    res.redirect('/');
  });
  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${auth.COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    res.redirect('/login');
  });
  // Protege todo o resto.
  app.use((req, res, next) => {
    const cookies = auth.parseCookies(req);
    if (auth.validToken(cookies[auth.COOKIE])) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado.' });
    return res.redirect('/login');
  });
} else {
  app.get('/logout', (req, res) => res.redirect('/'));
}

// Serve apenas os arquivos do site (não a pasta inteira, p/ não expor o banco).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Lê os filtros da query string (apenas as colunas permitidas).
function readFilters(req) {
  const filters = {};
  for (const k of store.ALL_FILTER_KEYS) {
    if (req.query[k] != null && String(req.query[k]).trim() !== '') filters[k] = String(req.query[k]).trim();
  }
  return filters;
}

// --- Upload e importação (alimenta a base única, ignorando duplicatas) ---
app.post('/api/upload', upload.array('files'), wrap(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }
  const imported = [];
  const errors = [];
  try {
    for (const file of req.files) {
      try {
        imported.push(await importFilePath(file.path, file.originalname));
      } catch (err) {
        errors.push({ file: file.originalname, error: err.message });
      } finally {
        fs.unlink(file.path, () => {});
      }
    }
  } finally {
    // Consolida o WAL no banco e libera espaço após o lote de importação.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('checkpoint:', e.message); }
  }
  res.json({ imported, errors });
}));

// --- Indica se a proteção por senha está ativa (para mostrar o botão Sair) ---
app.get('/api/auth', (req, res) => res.json({ enabled: auth.enabled() }));

// --- Estatísticas ---
app.get('/api/stats', (req, res) => res.json(store.getStats()));

// --- Catálogo de colunas ---
app.get('/api/columns', (req, res) => res.json(store.getColumns()));

// --- Valores distintos de uma coluna (para os dropdowns de filtro) ---
app.get('/api/distinct', wrap(async (req, res) => res.json(await store.distinctValues(req.query.col || ''))));

const validCpfParam = (req) => req.query.valid_cpf === '1';

// --- Lista de registros (paginação / busca full-text / filtros / ordenação) ---
app.get('/api/records', (req, res) => {
  res.json(store.query({
    limit: req.query.limit,
    offset: req.query.offset,
    q: req.query.q || '',
    filters: readFilters(req),
    validCpf: validCpfParam(req),
    sort: req.query.sort || null,
    dir: req.query.dir || 'asc',
  }));
});

// --- Higienização da base (CPF + datas), em lotes, sem travar ---
function driveHygiene() {
  if (!store.getHygieneJob().running) return;
  let n = 0;
  try { n = store.hygieneStep(4000); } catch (e) { console.error('hygiene:', e.message); }
  // Lotes com pausa: deixa o servidor respirar (não trava nem pesa a memória).
  if (store.getHygieneJob().running) setTimeout(driveHygiene, n > 0 ? 120 : 1000);
  else { try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignora */ } }
}
app.post('/api/hygiene', (req, res) => {
  if (store.getHygieneJob().running) return res.status(409).json({ error: 'Higienização já em andamento.' });
  store.startHygiene();
  setTimeout(driveHygiene, 50);
  res.json({ ok: true });
});
app.get('/api/hygiene', (req, res) => res.json(store.getHygieneJob()));

// --- Reunir duplicados antigos (Fase 2), em lotes, sem travar ---
let dedupChunks = 0;
function driveDedup() {
  if (!store.getDedupJob().running) return;
  let n = 0;
  try { n = store.dedupStep(2000); } catch (e) { console.error('dedup:', e.message); }
  dedupChunks += 1;
  // Descarrega o WAL periodicamente (TRUNCATE): numa remoção de milhões de linhas
  // o WAL cresce e a memória sobe (pode reiniciar). Esvaziar de tempos em tempos
  // mantém a memória baixa.
  if (dedupChunks % 20 === 0) { try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignora */ } }
  if (store.getDedupJob().running) setTimeout(driveDedup, n > 0 ? 120 : 1000);
  else { dedupChunks = 0; try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignora */ } }
}
app.post('/api/dedup', (req, res) => {
  if (store.getDedupJob().running) return res.status(409).json({ error: 'Já em andamento.' });
  store.startDedup();
  setTimeout(driveDedup, 50);
  res.json({ ok: true });
});
app.get('/api/dedup', (req, res) => res.json(store.getDedupJob()));

// --- Distribuição / facetas (quantidades por Estado, Município, CID) ---
// Roda na thread de trabalho (worker), então não trava o servidor.
app.get('/api/facets', wrap(async (req, res) => {
  res.json(await store.facets({ q: (req.query.q || '').trim(), filters: readFilters(req), validCpf: validCpfParam(req) }));
}));
app.get('/api/facets.csv', wrap(async (req, res) => {
  const csv = await store.facetsCsv({ q: (req.query.q || '').trim(), filters: readFilters(req), validCpf: validCpfParam(req) });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lexflow_distribuicao.csv"');
  res.send('﻿' + csv);
}));

// --- Histórico de importações ---
app.get('/api/imports', (req, res) => res.json(store.listImports()));

// --- Exportar a lista (respeitando busca e filtros) em CSV, via streaming ---
app.get('/api/export.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lexflow_dados.csv"');
  res.write('﻿'); // BOM para o Excel reconhecer UTF-8
  store.streamCsv({ q: (req.query.q || '').trim(), filters: readFilters(req), validCpf: validCpfParam(req) }, (chunk) => res.write(chunk));
  res.end();
});

// --- Remover os dados de um arquivo específico ---
app.delete('/api/imports', (req, res) => {
  const file = (req.query.source_file || '').trim();
  if (!file) return res.status(400).json({ error: 'Informe o arquivo (source_file).' });
  const removed = store.deleteBySource(file);
  res.json({ ok: true, removed });
});

// --- Apagar tudo ---
app.delete('/api/records', (req, res) => {
  store.clearAll();
  res.json({ ok: true });
});

// Tratamento de erros (inclui limites do multer).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Erro interno.' });
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`LexFlow rodando em http://localhost:${PORT}`);
    console.log(`Banco de dados: ${DB_PATH}`);
    // Pré-calcula a distribuição no worker (não trava o servidor).
    setTimeout(() => { try { store.warmStart(); } catch (e) { console.error('warmStart:', e.message); } }, 2000);
    // Auto-retoma o "reunir duplicados" se ficou pendente (ex.: reinício no meio):
    // continua do ponto exato salvo, sem precisar clicar de novo.
    setTimeout(() => {
      try {
        if (store.dedupPending() && store.resumeDedup()) {
          console.log('LexFlow: retomando o reunir-duplicados de onde parou...');
          driveDedup();
        }
      } catch (e) { console.error('auto-resume dedup:', e.message); }
    }, 4000);
  });
  // Uploads grandes e lentos podem passar do limite padrão de 5 min do Node.
  server.requestTimeout = 60 * 60 * 1000;
  server.headersTimeout = 10 * 60 * 1000;
  server.keepAliveTimeout = 10 * 60 * 1000;
}

module.exports = app;
