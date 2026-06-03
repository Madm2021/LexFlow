'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');

const { importFilePath } = require('./importer');
const store = require('./store');
const auth = require('./auth');
const { DB_PATH } = require('./db');

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
  // Sem senha: o link "Sair" simplesmente volta para a página inicial.
  app.get('/logout', (req, res) => res.redirect('/'));
}

// Serve apenas os arquivos do site (não o restante da pasta, p/ não expor o banco).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Calcula a nota (_potencial/_obito) dos registros pendentes em segundo plano,
// em pequenos lotes, para não travar o servidor — usado em bases grandes.
let scoringActive = false;
function ensureScoring() {
  if (scoringActive) return;
  scoringActive = true;
  const step = () => {
    let changed = 0;
    try { changed = store.scorePending(5000); } catch (e) { console.error('scorePending:', e.message); }
    if (changed > 0) setTimeout(step, 40);
    else scoringActive = false;
  };
  setTimeout(step, 100);
}

// --- Upload e importação (alimenta a lista única, ignorando duplicatas) ---
app.post('/api/upload', upload.array('files'), wrap(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }
  const imported = [];
  const errors = [];
  for (const file of req.files) {
    try {
      imported.push(await importFilePath(file.path, file.originalname));
    } catch (err) {
      errors.push({ file: file.originalname, error: err.message });
    } finally {
      fs.unlink(file.path, () => {});
    }
  }
  ensureScoring(); // calcula a nota dos novos registros em segundo plano
  res.json({ imported, errors });
}));

// --- Indica se a proteção por senha está ativa (para mostrar o botão Sair) ---
app.get('/api/auth', (req, res) => res.json({ enabled: auth.enabled() }));

// --- Estatísticas ---
app.get('/api/stats', (req, res) => res.json(store.getStats()));

// --- Catálogo de colunas ---
app.get('/api/columns', (req, res) => res.json(store.getColumns()));

// --- Lista única de registros (paginação/busca/ordenação) ---
// view=clean (padrão): mostra as colunas-destino do de-para.
// view=raw: mostra todas as colunas originais.
app.get('/api/records', (req, res) => {
  const opts = {
    limit: req.query.limit,
    offset: req.query.offset,
    q: req.query.q || '',
    sort: req.query.sort || null,
    dir: req.query.dir || 'asc',
  };
  const fn = req.query.view === 'raw' ? store.queryRecords : store.queryRecordsClean;
  res.json(fn(opts));
});

// --- Painel analítico (BI) ---
app.get('/api/dashboard', (req, res) => res.json(store.dashboard()));

// --- Histórico de importações ---
app.get('/api/imports', (req, res) => res.json(store.listImports()));

// --- Prospecção (triagem de auxílio-acidente) ---
app.get('/api/prospects', (req, res) => {
  res.json(store.queryProspects({
    limit: req.query.limit,
    offset: req.query.offset,
    q: req.query.q || '',
    minScore: req.query.minScore != null ? req.query.minScore : 7,
  }));
});

app.get('/api/prospects.csv', (req, res) => {
  const csv = store.exportProspectsCsv({
    q: (req.query.q || '').trim(),
    minScore: req.query.minScore != null ? req.query.minScore : 7,
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lexflow_prospeccao.csv"');
  res.send('﻿' + csv);
});

// --- Exportar a lista (ou o resultado de uma busca) em CSV ---
app.get('/api/export.csv', (req, res) => {
  const q = (req.query.q || '').trim();
  const csv = req.query.view === 'raw' ? store.exportCsv(q) : store.exportCsvClean(q);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lexflow_dados.csv"');
  res.send('﻿' + csv); // BOM para o Excel reconhecer UTF-8
});

// --- Remover os dados de um arquivo específico ---
app.delete('/api/imports', (req, res) => {
  const file = (req.query.source_file || '').trim();
  if (!file) return res.status(400).json({ error: 'Informe o arquivo (source_file).' });
  const removed = store.deleteBySource(file);
  res.json({ ok: true, removed });
});

// --- Casos sem indicação de sequela (contar / excluir) ---
app.get('/api/no-sequela', (req, res) => res.json({ count: store.countNoSequela() }));
app.delete('/api/no-sequela', (req, res) => res.json({ removed: store.deleteNoSequela() }));

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
  app.listen(PORT, () => {
    console.log(`LexFlow rodando em http://localhost:${PORT}`);
    console.log(`Banco de dados: ${DB_PATH}`);
    ensureScoring(); // calcula notas pendentes (ex.: base já existente) ao subir
  });
}

module.exports = app;
