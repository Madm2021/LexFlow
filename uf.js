'use strict';

// Normalização de Unidade Federativa (UF). A coluna de estado nas planilhas vem
// inconsistente: ora "SP", ora "SAO PAULO"/"São Paulo", às vezes com lixo
// (datas, cidades). Aqui mapeamos as variações conhecidas para a sigla e
// descartamos o resto.

function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Nome próprio (acentuado) de cada UF.
const PROPER = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão',
  MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará',
  PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro',
  RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

const UFS = Object.keys(PROPER);

// Lookup por chave sem acento e em maiúsculas (ex.: "SAO PAULO" -> "SP").
const LOOKUP = {};
for (const uf of UFS) {
  LOOKUP[uf] = uf;
  LOOKUP[stripAccents(PROPER[uf]).toUpperCase()] = uf;
}

// Retorna a sigla (ex.: "SP") ou null se o valor não for um estado válido.
function normalizeUF(v) {
  if (v == null) return null;
  const key = stripAccents(String(v).trim().toUpperCase()).replace(/\s+/g, ' ');
  return LOOKUP[key] || null;
}

// Variações a casar no filtro (sigla + nome em várias grafias de acento/caixa),
// para o LIKE pegar todas as formas em que a UF pode estar gravada.
function variantsFor(uf) {
  const u = stripAccents(String(uf).trim().toUpperCase());
  if (!PROPER[u]) return [u];
  const proper = PROPER[u];
  return [...new Set([u, stripAccents(proper).toUpperCase(), proper.toUpperCase(), proper])];
}

module.exports = { normalizeUF, variantsFor, UFS, stripAccents };
