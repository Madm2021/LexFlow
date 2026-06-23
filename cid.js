'use strict';

// ---------------------------------------------------------------------------
// TRIAGEM POR CID-10 — potencial de SEQUELA (chance de êxito no processo).
//
// A régua abaixo classifica a CATEGORIA do CID (os 3 primeiros caracteres, ex.:
// "S68") em três níveis, pela probabilidade de deixar sequela permanente que
// reduza a capacidade laboral:
//   A = Alta   (amputação, lesão de nervo/medula, esmagamento, fratura grande)
//   B = Média  (fratura/luxação/tendão/ferimento aberto — depende da gravidade)
//   C = Baixa  (contusão, entorse leve, ferimento superficial — costuma curar)
//
// É uma HEURÍSTICA de priorização, não um parecer médico/jurídico. Foi feita
// para ser EDITADA pelo escritório: é só mover um código de um conjunto para
// outro (ou acrescentar) que a triagem inteira passa a respeitar.
// ---------------------------------------------------------------------------

const TIER_A = new Set([
  // Amputações traumáticas (e ausência adquirida de membro)
  'S48', 'S58', 'S68', 'S78', 'S88', 'S98', 'S28', 'T05', 'Z89',
  // Lesões de nervos e da medula espinhal
  'S04', 'S14', 'S24', 'S34', 'S44', 'S54', 'S64', 'S74', 'S84', 'S94',
  // Esmagamentos
  'S07', 'S17', 'S47', 'S57', 'S67', 'S77', 'S87', 'S97', 'T04',
  // Fraturas de ossos longos / coluna (risco de consolidação viciosa)
  'S12', 'S22', 'S32', 'S42', 'S52', 'S72', 'S82',
  // Olho e perdas sensoriais
  'S05', 'H54', 'H90', 'H91',
]);

const TIER_B = new Set([
  // Fraturas menores
  'S62', 'S92', 'S02',
  // Luxações
  'S43', 'S53', 'S63', 'S73', 'S83',
  // Lesões de músculo/tendão
  'S46', 'S56', 'S66', 'S76', 'S86', 'S96',
  // Ferimentos abertos (podem atingir tendão/nervo)
  'S41', 'S51', 'S61', 'S71', 'S81', 'S91',
  // Traumatismo cranioencefálico
  'S06',
  // Queimaduras (sequela depende do grau/área)
  'T20', 'T21', 'T22', 'T23', 'T24', 'T25', 'T26', 'T27', 'T28', 'T29', 'T30', 'T31', 'T32',
]);

const TIER_C = new Set([
  // Contusões e traumatismos superficiais
  'S00', 'S10', 'S20', 'S30', 'S40', 'S50', 'S60', 'S70', 'S80', 'S90',
  // Entorses / distensões leves
  'S03', 'S13', 'S23', 'S33', 'S93',
]);

const TIER_LABELS = { A: 'Alta', B: 'Média', C: 'Baixa' };

// Extrai a categoria (3 primeiros caracteres do código) de um valor de CID-10.
// Aceita formatos como "S68 1 - Amputação...", "S68.1", "s681".
function categoryOf(value) {
  if (value == null) return null;
  const m = String(value).trim().toUpperCase().match(/^([A-Z]\d{2})/);
  return m ? m[1] : null;
}

// Classifica um valor de CID-10 em 'A' | 'B' | 'C' | null (não classificado).
function classifyCid(value) {
  const cat = categoryOf(value);
  if (!cat) return null;
  if (TIER_A.has(cat)) return 'A';
  if (TIER_B.has(cat)) return 'B';
  if (TIER_C.has(cat)) return 'C';
  return null;
}

// Expressão SQL equivalente (mesma régua), para filtrar/agrupar/indexar no banco
// sem precisar trazer milhões de linhas para o JS. Use a MESMA string na criação
// do índice e no WHERE para o índice por expressão ser aproveitado.
function cidTierSql(col = 'cid_10') {
  const cat = `upper(substr(trim(${col}), 1, 3))`;
  const inList = (set) => [...set].map((c) => `'${c}'`).join(', ');
  return `CASE
    WHEN ${cat} IN (${inList(TIER_A)}) THEN 'A'
    WHEN ${cat} IN (${inList(TIER_B)}) THEN 'B'
    WHEN ${cat} IN (${inList(TIER_C)}) THEN 'C'
    ELSE NULL END`;
}

// Categorias (prefixos de 3 caracteres) de um nível — para filtrar via
// "cid_10 LIKE 'S68%'", que usa o índice idx_cid_10 (rápido, sem varrer tudo).
function tierCategories(t) {
  if (t === 'A') return [...TIER_A];
  if (t === 'B') return [...TIER_B];
  if (t === 'C') return [...TIER_C];
  return [];
}

module.exports = { TIER_A, TIER_B, TIER_C, TIER_LABELS, classifyCid, categoryOf, cidTierSql, tierCategories };
