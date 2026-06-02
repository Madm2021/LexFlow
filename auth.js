'use strict';

const crypto = require('crypto');

// A senha de acesso é definida pela variável de ambiente LEXFLOW_PASSWORD.
// Se ela NÃO estiver definida (ex.: rodando no Mac local), a proteção fica
// desligada e o sistema funciona sem login. Quando publicado na web, basta
// definir LEXFLOW_PASSWORD para exigir senha.
const PASSWORD = process.env.LEXFLOW_PASSWORD || '';
const SECRET = process.env.LEXFLOW_SECRET
  || (PASSWORD ? crypto.createHash('sha256').update('lexflow|' + PASSWORD).digest('hex') : 'dev-secret');

const COOKIE = 'lexflow_auth';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function enabled() {
  return Boolean(PASSWORD);
}

function sign(ts) {
  return crypto.createHmac('sha256', SECRET).update(String(ts)).digest('hex');
}

function makeToken() {
  const ts = Date.now();
  return `${ts}.${sign(ts)}`;
}

function validToken(token) {
  if (!token) return false;
  const idx = token.indexOf('.');
  if (idx < 0) return false;
  const ts = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!/^\d+$/.test(ts)) return false;
  if (Date.now() - Number(ts) > MAX_AGE_MS) return false;
  const expected = sign(ts);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function checkPassword(pw) {
  if (!pw) return false;
  const a = crypto.createHash('sha256').update(String(pw)).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

module.exports = { enabled, makeToken, validToken, checkPassword, parseCookies, COOKIE, MAX_AGE_MS };
