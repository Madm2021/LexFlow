'use strict';

// Higienização de dados: CPF (recupera zero à esquerda + valida dígito
// verificador) e datas (converte o número de série do Excel para dd/mm/aaaa).

// --- CPF ---------------------------------------------------------------------

// Valida o dígito verificador de um CPF de 11 dígitos (string).
function isValidCPF(cpf) {
  if (!/^\d{11}$/.test(cpf)) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // todos iguais (000..., 111...)
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

const onlyDigits = (s) => String(s).replace(/\D/g, '');

// Normaliza um valor de CPF.
// Retorna { value, ok }:
//  - ok=1: CPF válido → value formatado "000.000.000-00" (com zero à esquerda).
//  - ok=0: não é CPF válido → value mantém o original (para você ver o que veio).
function normalizeCpf(raw) {
  if (raw == null) return { value: null, ok: 0 };
  const s = String(raw).trim();
  if (s === '') return { value: null, ok: 0 };
  // Remove o ".0"/",0" de número do Excel (ex.: "99999706304.0").
  const noFloat = s.replace(/[.,]0+$/, '');
  const digits = onlyDigits(noFloat);
  if (digits.length === 0 || digits.length > 11) return { value: s, ok: 0 };
  const padded = digits.padStart(11, '0'); // recupera zeros à esquerda
  if (!isValidCPF(padded)) return { value: s, ok: 0 };
  const f = `${padded.slice(0, 3)}.${padded.slice(3, 6)}.${padded.slice(6, 9)}-${padded.slice(9)}`;
  return { value: f, ok: 1 };
}

// --- Datas -------------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }

// Converte o número de série de data do Excel (dias desde 1899-12-30) em data.
function excelSerialToDate(n) {
  const ms = Date.UTC(1899, 11, 30) + n * 86400000;
  const d = new Date(ms);
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

// Normaliza uma data de nascimento para dd/mm/aaaa quando possível.
// Mantém o valor original se não reconhecer (sem inventar).
function normalizeDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;                 // já dd/mm/aaaa
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);                    // aaaa-mm-dd
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(s);                 // dd/mm/aa
  if (m) {
    const yy = Number(m[3]);
    const year = yy <= 30 ? 2000 + yy : 1900 + yy;
    return `${pad2(m[1])}/${pad2(m[2])}/${year}`;
  }
  if (/^\d+([.,]0+)?$/.test(s)) {                                 // número serial Excel
    const n = parseInt(s, 10);
    if (n >= 3653 && n <= 73415) return excelSerialToDate(n);   // ~1910 a ~2100
  }
  return s; // não reconhecido: mantém
}

// --- Chave de identidade (deduplicação flexível) -----------------------------

// Decide, para cada registro, qual identificador usar — em cascata, do mais
// forte ao mais fraco. Retorna a chave (string) ou null quando não há
// identificador confiável (aí o registro só junta cópias idênticas, via _hash).
//
//   1) Tem CAT?            -> "cat:<digitos>"  (1 caso por CAT; mesma pessoa com
//                              2 CATs vira 2 registros, como deve ser)
//   2) Não tem CAT, CPF
//      válido?             -> "cpf:<digitos>"  (CPF identifica a pessoa; junta
//                              os acidentes/registros dela sem CAT)
//   3) Nenhum dos dois     -> null             (sem identidade forte)
function recordKey(values) {
  const cat = onlyDigits(values && values.cat != null ? values.cat : '');
  if (cat) return `cat:${cat}`;
  const cpf = normalizeCpf(values ? values.cpf : null);
  if (cpf.ok) return `cpf:${onlyDigits(cpf.value)}`;
  return null;
}

module.exports = { isValidCPF, normalizeCpf, normalizeDate, excelSerialToDate, recordKey };
