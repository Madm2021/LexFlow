'use strict';

const FILTER_KEYS = ['estado_funcionario', 'municipio_funcionario', 'cid_10'];

const state = { limit: 50, offset: 0, q: '', sort: null, dir: 'asc', filters: {}, validCpf: false, excludeProspected: false, cidTier: '', distOpen: false, lastData: null };

// Agrupamento dos campos na "ficha do registro".
const FIELD_GROUPS = [
  { title: '👤 Dados pessoais', keys: ['nome', 'cpf', 'data_nascimento', 'nome_mae', 'sexo', 'identidade', 'ctps', 'remuneracao', 'cbo'] },
  { title: '📞 Contato', keys: ['telefone_funcionario', 'telefone1', 'telefone2', 'telefone3', 'email'] },
  { title: '📍 Endereço', keys: ['endereco_funcionario', 'bairro_funcionario', 'municipio_funcionario', 'estado_funcionario', 'cep_funcionario'] },
  { title: '🩹 Acidente / CID', keys: ['cat', 'data_atend', 'local_acidente', 'parte_corpo', 'agente_causador', 'nat_lesao', 'cid_10', 'sit_gerador', 'unidade', 'observacoes'] },
];

let allColumns = null;       // catálogo completo de colunas (para o seletor)
let colLabels = {};          // chave -> rótulo amigável
function loadHiddenCols() { try { return new Set(JSON.parse(localStorage.getItem('lexflow-hidden-cols') || '[]')); } catch (e) { return new Set(); } }
function saveHiddenCols() { try { localStorage.setItem('lexflow-hidden-cols', JSON.stringify([...hiddenCols])); } catch (e) { /* ignora */ } }
const hiddenCols = loadHiddenCols();

// Tamanho de página (registros por página): lembrado entre sessões.
const PAGE_SIZES = [50, 100, 200, 500];
(function loadPageSize() {
  const s = parseInt(localStorage.getItem('lexflow-page-size'), 10);
  if (PAGE_SIZES.includes(s)) state.limit = s;
}());
function savePageSize() { try { localStorage.setItem('lexflow-page-size', String(state.limit)); } catch (e) { /* ignora */ } }

// "Esconder já prospectados": LIGADO por padrão. Vale para a lista, a
// distribuição e a EXPORTAÇÃO — assim, por padrão, não se puxa de novo quem já
// está em prospecção. O usuário pode desligar para ver/baixar tudo.
(function loadHideProspected() {
  const v = localStorage.getItem('lexflow-hide-prospected');
  state.excludeProspected = v === null ? true : v === '1';
}());
function saveHideProspected() { try { localStorage.setItem('lexflow-hide-prospected', state.excludeProspected ? '1' : '0'); } catch (e) { /* ignora */ } }

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
};

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 4000);
}

const fmt = (n) => Number(n).toLocaleString('pt-BR');

// ===== Tema claro/escuro =====
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#theme-toggle').textContent = theme === 'light' ? '☀️' : '🌙';
  try { localStorage.setItem('lexflow-theme', theme); } catch (e) { /* ignora */ }
}
function initTheme() {
  let theme;
  try { theme = localStorage.getItem('lexflow-theme'); } catch (e) { /* ignora */ }
  if (!theme) theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(theme);
}

// ===== Querystring com busca + filtros =====
function queryParams(extra = {}) {
  const p = new URLSearchParams({ q: state.q, ...extra });
  for (const k of FILTER_KEYS) if (state.filters[k]) p.set(k, state.filters[k]);
  if (state.validCpf) p.set('valid_cpf', '1');
  if (state.excludeProspected) p.set('esconder_prospectados', '1');
  if (state.cidTier) p.set('cid_tier', state.cidTier);
  return p;
}
function hasFilters() { return state.validCpf || !!state.cidTier || FILTER_KEYS.some((k) => state.filters[k]); }

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#stat-records').textContent = fmt(s.records);
    $('#stat-imports').textContent = fmt(s.imports);
  } catch (e) { /* silencioso */ }
  try {
    const h = await api('/api/hygiene');
    const node = $('#stat-validcpf');
    if (node) node.textContent = fmt(h.valid || 0);
  } catch (e) { /* silencioso */ }
}

// Destaca o termo buscado dentro de uma célula (sem risco de HTML injetado).
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function highlightInto(node, text) {
  const q = (state.q || '').trim();
  const terms = q ? q.split(/\s+/).filter((t) => t.length >= 2).map(escapeRegExp) : [];
  if (!terms.length) { node.textContent = text; return; }
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  let last = 0; let m; let any = false;
  while ((m = re.exec(text)) !== null) {
    any = true;
    if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
    node.appendChild(el('mark', {}, [m[0]]));
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  if (!any) { node.textContent = text; return; }
  if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
}

// ===== Lista de registros =====
async function loadRecords() {
  const params = queryParams({ limit: state.limit, offset: state.offset, dir: state.dir });
  if (state.sort) params.set('sort', state.sort);
  const exLink = $('#export-link');
  exLink.href = `/api/export.csv?${queryParams()}`;
  exLink.title = state.excludeProspected
    ? 'Baixa só os NÃO prospectados (modo padrão). Desmarque “Esconder já prospectados” para baixar tudo.'
    : 'Baixa TUDO do recorte, inclusive os já prospectados.';
  let data;
  try {
    data = await api(`/api/records?${params}`);
  } catch (e) { $('#viewer').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
  renderResults(data);
}

// Sort no cabeçalho.
function sortBy(col) {
  if (state.sort === col) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
  else { state.sort = col; state.dir = 'asc'; }
  state.offset = 0;
  loadRecords();
}

function renderResults(data) {
  if (!data) return;
  state.lastData = data;
  const viewer = $('#viewer');
  const meta = $('#results-meta');
  const { columns, rows, total, limit, offset } = data;
  allColumns = columns;
  colLabels = {};
  columns.forEach((c) => { colLabels[c.column_name] = c.original_name; });
  renderChips();

  const filtered = state.q || hasFilters();
  if (total === 0) {
    meta.textContent = '';
    viewer.innerHTML = filtered
      ? '<div class="empty-state"><p>Nenhum registro encontrado para essa busca/filtro.</p></div>'
      : '<div class="empty-state"><p>Use a busca acima ou os filtros para consultar a base. Para adicionar dados, clique em <strong>⤓ Importar</strong>.</p></div>';
    return;
  }

  const ctx = state.q ? ` para “${state.q}”` : '';
  meta.innerHTML = `<span class="big-total">${fmt(total)}</span> <span class="meta-sub">registro(s)${ctx}${hasFilters() ? ' (filtrado)' : ''}</span>`;
  if (state.distOpen) loadFacets();

  let visible = columns.filter((c) => !hiddenCols.has(c.column_name));
  if (visible.length === 0) visible = columns; // nunca esconde tudo

  const thead = el('thead', {}, [el('tr', {}, visible.map((c, i) => {
    const arrow = state.sort === c.column_name ? (state.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return el('th', {
      class: i === 0 ? 'sticky-col' : '',
      title: 'Clique para ordenar',
      onClick: () => sortBy(c.column_name),
    }, [c.original_name + arrow]);
  }))]);

  const tbody = el('tbody', {}, rows.map((row) => el('tr', {
    class: 'rowclick', title: 'Ver ficha completa', onClick: () => openRecord(row),
  }, visible.map((c, i) => {
    const v = row[c.column_name];
    const cls = `${c.column_name === 'cpf' ? 'cpf ' : ''}${i === 0 ? 'sticky-col' : ''}`.trim();
    const td = el('td', { 'data-label': c.original_name, class: cls });
    if (v == null || v === '') td.appendChild(el('span', { class: 'null', text: '—' }));
    else highlightInto(td, String(v));
    return td;
  }))));

  const table = el('div', { class: 'table-wrap' }, [el('table', {}, [thead, tbody])]);

  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  const sizeSel = el('select', {
    class: 'page-size', title: 'Registros por página',
    onChange: (e) => { state.limit = parseInt(e.target.value, 10); state.offset = 0; savePageSize(); loadRecords(); },
  }, PAGE_SIZES.map((s) => el('option', s === limit ? { value: s, selected: '' } : { value: s }, [`${s} / página`])));
  const pager = el('div', { class: 'pager' }, [
    el('div', { class: 'info' }, [`Mostrando ${fmt(from)}–${fmt(to)} de ${fmt(total)}`, el('span', { class: 'sep', text: '·' }), sizeSel]),
    el('div', { class: 'controls' }, [
      el('button', { class: 'btn ghost small', text: '◀ Anterior', disabled: offset <= 0 ? '' : null, onClick: () => { state.offset = Math.max(0, offset - limit); loadRecords(); } }),
      el('button', { class: 'btn ghost small', text: 'Próxima ▶', disabled: to >= total ? '' : null, onClick: () => { state.offset = offset + limit; loadRecords(); } }),
    ]),
  ]);

  viewer.innerHTML = '';
  viewer.append(table, pager);
}

// ===== Ficha do registro (clique na linha) =====
function openRecord(row) {
  $('#record-title').textContent = row.nome || row.cpf || 'Registro';
  const body = $('#record-body');
  body.innerHTML = '';
  let any = false;
  FIELD_GROUPS.forEach((g) => {
    const fields = g.keys.filter((k) => row[k] != null && row[k] !== '');
    if (fields.length === 0) return;
    any = true;
    const grid = el('div', { class: 'ficha-grid' }, fields.map((k) => el('div', { class: 'ficha-field' }, [
      el('span', { class: 'ficha-label', text: colLabels[k] || k }),
      el('span', { class: k === 'cpf' ? 'ficha-value cpf' : 'ficha-value', text: String(row[k]) }),
    ])));
    body.append(el('div', { class: 'ficha-group' }, [el('h3', { class: 'ficha-gtitle', text: g.title }), grid]));
  });
  if (!any) body.appendChild(el('div', { class: 'spinner', text: 'Sem dados preenchidos neste registro.' }));
  $('#record-modal').hidden = false;
}
function closeRecord() { $('#record-modal').hidden = true; }

// ===== Seletor de colunas =====
function toggleColMenu() {
  const p = $('#col-panel');
  if (p.hidden) buildColMenu();
  p.hidden = !p.hidden;
}
function buildColMenu() {
  const p = $('#col-panel');
  p.innerHTML = '';
  if (!allColumns) { p.appendChild(el('div', { class: 'spinner', text: '—' })); return; }
  p.appendChild(el('div', { class: 'col-panel-head' }, [
    el('strong', { text: 'Mostrar colunas' }),
    el('button', { class: 'btn ghost small', text: 'Todas', onClick: () => { hiddenCols.clear(); saveHiddenCols(); buildColMenu(); renderResults(state.lastData); } }),
  ]));
  allColumns.forEach((c) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !hiddenCols.has(c.column_name);
    cb.addEventListener('change', () => {
      if (cb.checked) hiddenCols.delete(c.column_name); else hiddenCols.add(c.column_name);
      saveHiddenCols();
      renderResults(state.lastData);
    });
    p.appendChild(el('label', { class: 'col-item' }, [cb, ` ${c.original_name}`]));
  });
}

// ===== Etiquetas (chips) dos filtros ativos =====
function renderChips() {
  const box = $('#filter-chips');
  if (!box) return;
  box.innerHTML = '';
  const chips = [];
  if (state.q) chips.push(['Busca', state.q, () => { $('#search').value = ''; state.q = ''; $('#search-clear').hidden = true; state.offset = 0; loadRecords(); }]);
  const labels = { estado_funcionario: 'Estado', municipio_funcionario: 'Município', cid_10: 'CID-10' };
  FILTER_KEYS.forEach((k) => {
    if (!state.filters[k]) return;
    chips.push([labels[k], state.filters[k], () => {
      delete state.filters[k];
      const n = $(`[data-filter="${k}"]`); if (n) n.value = '';
      $('#filter-clear').hidden = !hasFilters();
      state.offset = 0; loadRecords();
    }]);
  });
  if (state.validCpf) chips.push(['Filtro', 'Apenas CPF válido', () => {
    state.validCpf = false;
    const vc = $('#f-valid-cpf'); if (vc) vc.checked = false;
    $('#filter-clear').hidden = !hasFilters();
    state.offset = 0; loadRecords();
  }]);
  if (state.cidTier) {
    const nome = { A: '🟢 Alta', B: '🟡 Média', C: '🔴 Baixa' }[state.cidTier] || state.cidTier;
    chips.push(['Potencial', nome, () => {
      state.cidTier = '';
      const ct = $('#f-cid-tier'); if (ct) ct.value = '';
      $('#filter-clear').hidden = !hasFilters();
      state.offset = 0; loadRecords();
    }]);
  }
  if (state.excludeProspected) chips.push(['Modo', 'Esconder já prospectados', () => {
    state.excludeProspected = false; saveHideProspected();
    const hp = $('#f-hide-prospected'); if (hp) hp.checked = false;
    state.offset = 0; loadRecords();
  }]);
  if (chips.length === 0) { box.hidden = true; return; }
  box.hidden = false;
  chips.forEach(([k, v, onRemove]) => box.appendChild(el('span', { class: 'chip' }, [
    el('span', { class: 'chip-k', text: `${k}: ` }),
    el('span', { class: 'chip-v', text: v }),
    el('button', { class: 'chip-x', title: 'Remover', onClick: onRemove }, ['×']),
  ])));
}

// ===== Filtros =====
function applyFilters() {
  for (const k of FILTER_KEYS) {
    const node = $(`[data-filter="${k}"]`);
    const v = node ? node.value.trim() : '';
    if (v) state.filters[k] = v; else delete state.filters[k];
  }
  $('#filter-clear').hidden = !hasFilters();
  state.offset = 0;
  loadRecords();
}
function clearFilters() {
  // Não mexe no modo "esconder prospectados" (é uma preferência persistente).
  state.filters = {};
  state.validCpf = false;
  state.cidTier = '';
  const vc = $('#f-valid-cpf'); if (vc) vc.checked = false;
  const ct = $('#f-cid-tier'); if (ct) ct.value = '';
  FILTER_KEYS.forEach((k) => { const n = $(`[data-filter="${k}"]`); if (n) n.value = ''; });
  $('#filter-clear').hidden = true;
  state.offset = 0;
  loadRecords();
}

// ===== Higienização da base =====
function hygieneStatsHtml(j) {
  return `<span class="hg-ok">✓ ${fmt(j.valid)} com CPF válido</span> · `
    + `<span class="hg-bad">${fmt(j.invalid)} inválidos</span>`
    + (j.pendente ? ` · <span class="hg-pend">${fmt(j.pendente)} a processar</span>` : '');
}
async function loadHygiene() {
  try {
    const j = await api('/api/hygiene');
    $('#hygiene-stats').innerHTML = hygieneStatsHtml(j);
    if (j.running) pollHygiene();
  } catch (e) { /* silencioso */ }
}
function pollHygiene() {
  $('#hygiene-btn').disabled = true;
  const tick = async () => {
    let j;
    try { j = await api('/api/hygiene'); } catch (e) { setTimeout(tick, 2000); return; }
    // Fase rápida (keys): mostra o avanço do preenchimento da chave; senão, o
    // avanço da normalização (CPF/datas).
    let label; let pct;
    if (j.phase === 'keys') {
      pct = Math.min(100, Math.round(((j.keyDone || 0) / (j.keyTotal || 1)) * 100));
      label = `Preparando a chave de identidade... ${fmt(j.keyDone || 0)} de ${fmt(j.keyTotal || 0)}`;
    } else {
      const total = j.total || 1;
      const done = j.valid + j.invalid;
      pct = Math.min(100, Math.round((done / total) * 100));
      label = `Higienizando... ${fmt(done)} de ${fmt(total)}`;
    }
    const box = $('#hygiene-progress');
    box.hidden = false;
    box.innerHTML = `<div class="maint-prog-label">${label}</div>`
      + `<div class="maint-prog-track"><div class="maint-prog-fill" style="width:${pct}%"></div></div>`
      + `<div class="maint-prog-pct">${pct}%</div>`;
    $('#hygiene-stats').innerHTML = hygieneStatsHtml(j);
    if (j.running) { setTimeout(tick, 1500); return; }
    box.hidden = true;
    $('#hygiene-btn').disabled = false;
    toast('Higienização concluída! 🧼', 'ok');
    loadStats();
    loadDedup();
  };
  tick();
}
async function startHygiene() {
  if (!confirm('Higienizar a base agora?\n\nRoda UMA vez, em segundo plano — você pode continuar usando o sistema normalmente. Pode levar alguns minutos numa base grande. Além de limpar CPF e datas, prepara a chave de identidade (CAT/CPF) que evita duplicatas e permite enriquecer cadastros nas próximas planilhas. Não apaga nada.')) return;
  try { await api('/api/hygiene', { method: 'POST' }); } catch (e) { toast(e.message, 'err'); return; }
  toast('Higienização iniciada (em segundo plano).', 'ok');
  pollHygiene();
}
// ===== Reunir duplicados antigos (Fase 2) =====
function dedupStatsHtml(j) {
  if (j.running) return `<span class="hg-pend">Reunindo... ${fmt(j.removed)} duplicado(s) removido(s)</span>`;
  // Sem a chave de identidade preenchida na base inteira, a contagem é enganosa.
  if (!j.keysReady || j.hygienePending > 0) {
    return '<span class="hg-bad">⚠ Rode a 🧼 Higienização primeiro</span> · '
      + '<span class="hg-pend">ela prepara a chave de identidade dos registros já existentes</span>';
  }
  if (!j.duplicates) return '<span class="hg-ok">✓ Nenhum duplicado antigo a reunir</span>';
  return `<span class="hg-pend">${fmt(j.duplicates)} duplicado(s) antigo(s) podem ser reunidos</span>`;
}
async function loadDedup() {
  try {
    const j = await api('/api/dedup');
    $('#dedup-stats').innerHTML = dedupStatsHtml(j);
    $('#dedup-btn').disabled = j.running || (!j.running && (!j.keysReady || j.hygienePending > 0 || !j.duplicates));
    if (j.running) pollDedup();
  } catch (e) { /* silencioso */ }
}
function pollDedup() {
  $('#dedup-btn').disabled = true;
  const box = $('#dedup-progress');
  const tick = async () => {
    let j;
    try { j = await api('/api/dedup'); } catch (e) { setTimeout(tick, 2000); return; }
    if (j.running) {
      box.hidden = false;
      box.innerHTML = `<div class="maint-prog-label">Reunindo duplicados... ${fmt(j.removed)} removido(s) em ${fmt(j.groups)} grupo(s)</div>`
        + '<div class="maint-prog-track"><div class="maint-prog-fill" style="width:100%;animation:pulse 1.2s infinite"></div></div>';
      $('#dedup-stats').innerHTML = dedupStatsHtml(j);
      setTimeout(tick, 1500);
      return;
    }
    box.hidden = true;
    $('#dedup-stats').innerHTML = dedupStatsHtml(j);
    $('#dedup-btn').disabled = !j.duplicates;
    toast(`Duplicados reunidos! ${fmt(j.removed)} removido(s). 🧹`, 'ok');
    loadStats();
    loadRecords();
  };
  tick();
}
async function startDedup() {
  let j;
  try { j = await api('/api/dedup'); } catch (e) { toast(e.message, 'err'); return; }
  if (!j.keysReady || j.hygienePending > 0) { toast('Rode a higienização primeiro (ela prepara a chave de identidade).', 'err'); return; }
  if (!j.duplicates) { toast('Nenhum duplicado antigo a reunir.', 'ok'); return; }
  const msg = `Reunir ${fmt(j.duplicates)} duplicado(s) antigo(s) agora?\n\n`
    + 'Os dados são FUNDIDOS num único registro (preenche vazios e acumula contatos) e as cópias são REMOVIDAS. '
    + 'Esta etapa apaga linhas e não pode ser desfeita — exporte um backup (⤓) antes, se quiser. '
    + 'Roda em segundo plano, sem travar.';
  if (!confirm(msg)) return;
  try { await api('/api/dedup', { method: 'POST' }); } catch (e) { toast(e.message, 'err'); return; }
  toast('Reunião de duplicados iniciada (em segundo plano).', 'ok');
  pollDedup();
}
async function loadFilterOptions() {
  for (const col of ['estado_funcionario']) {
    const sel = $(`[data-filter="${col}"]`);
    if (!sel || sel.tagName !== 'SELECT') continue;
    try {
      const values = await api(`/api/distinct?col=${col}`);
      const current = state.filters[col] || '';
      sel.innerHTML = '<option value="">Todos</option>';
      values.forEach((v) => sel.appendChild(el('option', { value: v, text: v })));
      sel.value = current;
    } catch (e) { /* silencioso */ }
  }
}

// ===== Importação (modal) =====
function openImport() {
  $('#import-modal').hidden = false;
  loadImports();
  loadHygiene();
  loadDedup();
}
function closeImport() { $('#import-modal').hidden = true; }

async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  const fb = $('#upload-feedback');
  fb.innerHTML = '<div class="line">Enviando e importando... (arquivos grandes podem levar alguns segundos)</div>';
  const form = new FormData();
  Array.from(files).forEach((f) => form.append('files', f));
  try {
    const res = await api('/api/upload', { method: 'POST', body: form });
    fb.innerHTML = '';
    (res.imported || []).forEach((r) => {
      const enr = r.merged > 0 ? ` · ${fmt(r.merged)} cadastro(s) enriquecido(s)` : '';
      const dup = r.skipped > 0 ? ` · ${fmt(r.skipped)} duplicada(s) ignorada(s)` : '';
      const useful = r.added > 0 || r.merged > 0;
      const cls = useful ? 'ok' : 'warn';
      const icon = useful ? '✓' : '🔁';
      fb.appendChild(el('div', { class: `line ${cls}`, text: `${icon} ${r.file}: ${fmt(r.added)} nova(s)${enr}${dup}` }));
    });
    (res.errors || []).forEach((e) => fb.appendChild(el('div', { class: 'line err', text: `✕ ${e.file}: ${e.error}` })));
    state.offset = 0;
    await Promise.all([loadStats(), loadRecords(), loadFilterOptions(), loadImports()]);
  } catch (e) {
    fb.innerHTML = `<div class="line err">✕ ${e.message}</div>`;
  }
}

async function loadImports() {
  const panel = $('#imports-panel');
  panel.innerHTML = '<div class="spinner">Carregando...</div>';
  try {
    const list = await api('/api/imports');
    panel.innerHTML = '';
    if (list.length === 0) { panel.innerHTML = '<div class="spinner">Nenhuma planilha importada ainda.</div>'; return; }
    panel.appendChild(el('h3', { text: 'Planilhas importadas' }));
    list.forEach((imp) => {
      panel.appendChild(el('div', { class: 'import-row' }, [
        el('div', {}, [
          el('div', { class: 'imp-name', text: imp.source_file }),
          el('div', { class: 'imp-meta', text: `${fmt(imp.rows_added)} adicionadas${imp.rows_merged > 0 ? ` · ${fmt(imp.rows_merged)} enriquecidas` : ''} · ${fmt(imp.rows_skipped)} ignoradas · ${new Date(imp.imported_at).toLocaleString('pt-BR')}` }),
        ]),
        el('button', { class: 'btn ghost small danger-text', text: 'Remover', onClick: () => removeImport(imp.source_file) }),
      ]));
    });
  } catch (e) { panel.innerHTML = `<div class="spinner">${e.message}</div>`; }
}

async function removeImport(file) {
  if (!confirm(`Remover todos os registros do arquivo "${file}"?`)) return;
  try {
    const r = await api(`/api/imports?source_file=${encodeURIComponent(file)}`, { method: 'DELETE' });
    toast(`${fmt(r.removed)} registro(s) removido(s).`, 'ok');
    await Promise.all([loadStats(), loadRecords(), loadFilterOptions(), loadImports()]);
  } catch (e) { toast(e.message, 'err'); }
}

// ===== Distribuição (quantidades por valor) =====
// Clicar numa barra aplica o filtro daquela dimensão (drill-down).
function applyFacetFilter(key, value) {
  if (value == null || value === '') return;
  const node = $(`[data-filter="${key}"]`);
  if (node) node.value = String(value);
  applyFilters();
}
function applyTierFilter(t) {
  state.cidTier = t;
  const ct = $('#f-cid-tier'); if (ct) ct.value = t;
  applyFilters();
}
function distBars(title, icon, items, total, filterKey) {
  const max = items.reduce((m, x) => Math.max(m, x.n), 0) || 1;
  const rows = items.map((x) => {
    const pct = total ? Math.round((x.n / total) * 100) : 0;
    const w = Math.max(2, (x.n / max) * 100);
    const props = { class: `dbar${filterKey ? ' clickable' : ''}` };
    if (filterKey) { props.onClick = () => applyFacetFilter(filterKey, x.value); props.title = `Filtrar por “${x.value || '—'}”`; }
    const tierName = { A: 'alto', B: 'médio', C: 'baixo' }[x.tier];
    return el('div', props, [
      el('div', { class: 'dbar-top' }, [
        el('span', { class: 'dbar-label' }, [
          x.tier ? el('span', { class: `tier-dot tier-${x.tier}`, title: `Potencial ${tierName} de sequela` }) : null,
          String(x.value || '—'),
        ]),
        el('span', { class: 'dbar-val' }, [fmt(x.n), el('em', { text: ` ${pct}%` })]),
      ]),
      el('div', { class: 'dbar-track' }, [el('span', { class: 'dbar-fill', style: 'width:0', 'data-w': String(w) })]),
    ]);
  });
  return el('div', { class: 'dist-col' }, [el('h4', {}, [icon ? el('span', { class: 'dist-ico', text: icon }) : null, title]), ...rows]);
}
function animateBars() {
  requestAnimationFrame(() => {
    document.querySelectorAll('#dist-panel .dbar-fill').forEach((f) => { f.style.width = `${f.getAttribute('data-w') || 0}%`; });
  });
}
function annotateEstado(byEstado) {
  const sel = $('[data-filter="estado_funcionario"]');
  if (!sel) return;
  const map = {};
  (byEstado || []).forEach((x) => { if (x.value) map[String(x.value).toUpperCase()] = x.n; });
  Array.from(sel.options).forEach((o) => { if (o.value) o.textContent = `${o.value} (${fmt(map[o.value.toUpperCase()] || 0)})`; });
}
async function loadFacets() {
  if (!state.distOpen) return;
  const panel = $('#dist-panel');
  panel.innerHTML = '<div class="spinner">Calculando as quantidades... (pode levar alguns segundos em bases grandes)</div>';
  let d;
  try { d = await api(`/api/facets?${queryParams()}`); }
  catch (e) { panel.innerHTML = `<div class="spinner">${e.message}</div>`; return; }
  panel.innerHTML = '';
  const semAno = d.semAno || 0;
  const semCat = d.semCat || 0;
  const anoItems = (d.byAno || []).slice();
  if (semAno) anoItems.push({ value: 'Sem ano', n: semAno });
  // Todas as colunas com a MESMA quantidade de linhas (a altura da coluna "Por
  // ano"), para a leitura ficar uniforme e sem vãos vazios.
  const linhas = Math.max(anoItems.length, 10);
  const trim = (arr) => (arr || []).slice(0, linhas);
  const tiers = d.byCidTier || { A: 0, B: 0, C: 0 };
  const tierNote = (t, emoji, label) => el('span', {
    class: `dist-note tier-note tier-${t}${state.cidTier === t ? ' on' : ''}`,
    title: `Filtrar pelos casos de potencial ${label.toLowerCase()}`,
    onClick: () => applyTierFilter(state.cidTier === t ? '' : t),
  }, [`${emoji} ${label}: `, el('strong', { text: fmt(tiers[t]) })]);
  panel.append(
    el('div', { class: 'dist-head' }, [
      el('div', { class: 'dist-title' }, [el('strong', { text: '📊 Distribuição' }), el('span', { class: 'meta-sub', text: ` · ${fmt(d.total)} registro(s) no recorte atual` })]),
      el('a', { href: `/api/facets.csv?${queryParams()}`, class: 'btn ghost small' }, ['⤒ Exportar contagem']),
    ]),
    el('div', { class: 'dist-notes' }, [
      el('span', { class: 'dist-note muted', text: 'Potencial de sequela:' }),
      tierNote('A', '🟢', 'Alta'),
      tierNote('B', '🟡', 'Média'),
      tierNote('C', '🔴', 'Baixa'),
      el('span', { class: 'dist-note' }, ['🔢 ', el('strong', { text: fmt(semCat) }), ` sem CAT`]),
      semAno ? el('span', { class: 'dist-note' }, ['📅 ', el('strong', { text: fmt(semAno) }), ` sem ano`]) : null,
    ]),
    el('div', { class: 'dist-grid' }, [
      distBars('Por ano', '📅', anoItems, d.total, null),
      distBars('Por estado', '🗺️', trim(d.byEstado), d.total, 'estado_funcionario'),
      distBars('Por município', '🏙️', trim(d.byMunicipio), d.total, 'municipio_funcionario'),
      distBars('Por CID-10', '🩹', trim(d.byCid), d.total, 'cid_10'),
    ]),
  );
  annotateEstado(d.byEstado);
  animateBars();
}
function toggleDist() {
  state.distOpen = !state.distOpen;
  $('#dist-panel').hidden = !state.distOpen;
  $('#dist-btn').classList.toggle('active', state.distOpen);
  if (state.distOpen) loadFacets();
}

// ===== Prospecção =====
// Descreve, em texto, o recorte que será marcado (busca + filtros ativos).
function recorteDescricao() {
  const parts = [];
  if (state.q) parts.push(`busca “${state.q}”`);
  const labels = { estado_funcionario: 'Estado', municipio_funcionario: 'Município', cid_10: 'CID-10' };
  FILTER_KEYS.forEach((k) => { if (state.filters[k]) parts.push(`${labels[k]}: ${state.filters[k]}`); });
  if (state.validCpf) parts.push('apenas CPF válido');
  return parts.length ? parts.join(' · ') : 'Toda a base (sem filtro)';
}
function renderProspect(d) {
  const sum = $('#prospect-summary');
  sum.innerHTML = '';
  sum.append(
    el('div', { class: 'stat-card' }, [el('span', { class: 'stat-num', text: fmt(d.totalMarcados || 0) }), el('span', { class: 'stat-label', text: 'leads em prospecção' })]),
    el('div', { class: 'stat-card' }, [el('span', { class: 'stat-num', text: fmt((d.regioes || []).length) }), el('span', { class: 'stat-label', text: 'regiões marcadas' })]),
  );
  const list = $('#prospect-regioes-list');
  list.innerHTML = '';
  if (!d.regioes || d.regioes.length === 0) { list.innerHTML = '<div class="spinner">Nenhuma região marcada ainda.</div>'; return; }
  d.regioes.forEach((r) => {
    const nome = r.escopo === 'municipio' ? `${r.municipio || '—'}${r.uf ? ` / ${r.uf}` : ''}` : (r.uf || '—');
    const tipo = r.escopo === 'municipio' ? '🏙️ Município' : '🗺️ Estado';
    list.appendChild(el('div', { class: 'import-row' }, [
      el('div', {}, [
        el('div', { class: 'imp-name', text: `${tipo}: ${nome}` }),
        el('div', { class: 'imp-meta', text: `marcada em ${new Date(r.criado_em).toLocaleString('pt-BR')}` }),
      ]),
      el('button', { class: 'btn ghost small danger-text', text: 'Remover', onClick: () => removeRegiao(r.id) }),
    ]));
  });
}
async function loadProspect() {
  const desc = $('#prospect-recorte-desc');
  desc.innerHTML = '';
  desc.append(el('span', { class: 'chip-k', text: 'Recorte atual: ' }), el('strong', { text: recorteDescricao() }));
  const p = new URLSearchParams(queryParams());
  p.set('esconder_prospectados', '1');
  $('#prospect-export-link').href = `/api/export.csv?${p}`;
  try { renderProspect(await api('/api/prospect')); } catch (e) { /* silencioso */ }
}
function openProspect() { $('#prospect-modal').hidden = false; loadProspect(); }
function closeProspect() { $('#prospect-modal').hidden = true; }
async function markRecorte() {
  if (!confirm(`Marcar como EM PROSPECÇÃO os leads de:\n\n${recorteDescricao()}\n\nDepois é só ligar “Esconder já prospectados” para não puxar a mesma lista de novo.`)) return;
  try {
    const d = await api(`/api/prospect/marcar?${queryParams()}`, { method: 'POST' });
    toast(`${fmt(d.marked)} lead(s) marcado(s) em prospecção. 🎯`, 'ok');
    renderProspect(d);
    loadRecords();
  } catch (e) { toast(e.message, 'err'); }
}
async function unmarkRecorte() {
  if (!confirm(`Desmarcar (liberar) os leads de:\n\n${recorteDescricao()}?`)) return;
  try {
    const d = await api(`/api/prospect/desmarcar?${queryParams()}`, { method: 'POST' });
    toast(`${fmt(d.unmarked)} lead(s) liberado(s).`, 'ok');
    renderProspect(d);
    loadRecords();
  } catch (e) { toast(e.message, 'err'); }
}
async function removeRegiao(id) {
  try { renderProspect(await api(`/api/prospect/regioes?id=${id}`, { method: 'DELETE' })); }
  catch (e) { toast(e.message, 'err'); }
}

// ===== Wiring =====
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function init() {
  initTheme();
  $('#theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  });

  // Busca
  const runSearch = () => { state.q = $('#search').value.trim(); state.offset = 0; $('#search-clear').hidden = !state.q; loadRecords(); };
  $('#search-btn').addEventListener('click', runSearch);
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  $('#search-clear').addEventListener('click', () => { $('#search').value = ''; state.q = ''; $('#search-clear').hidden = true; state.offset = 0; loadRecords(); });

  // Filtros
  const debApply = debounce(applyFilters, 350);
  FILTER_KEYS.forEach((k) => {
    const node = $(`[data-filter="${k}"]`);
    if (!node) return;
    if (node.tagName === 'SELECT') node.addEventListener('change', applyFilters);
    else node.addEventListener('input', debApply);
  });
  $('#filter-clear').addEventListener('click', clearFilters);
  $('#f-valid-cpf').addEventListener('change', (e) => { state.validCpf = e.target.checked; $('#filter-clear').hidden = !hasFilters(); state.offset = 0; loadRecords(); });
  $('#f-hide-prospected').checked = state.excludeProspected;
  $('#f-hide-prospected').addEventListener('change', (e) => { state.excludeProspected = e.target.checked; saveHideProspected(); state.offset = 0; loadRecords(); });
  $('#f-cid-tier').addEventListener('change', (e) => { state.cidTier = e.target.value; applyFilters(); });
  $('#hygiene-btn').addEventListener('click', startHygiene);
  $('#dedup-btn').addEventListener('click', startDedup);

  // Prospecção
  $('#prospect-btn').addEventListener('click', openProspect);
  document.querySelectorAll('[data-close-prospect]').forEach((n) => n.addEventListener('click', closeProspect));
  $('#prospect-mark-btn').addEventListener('click', markRecorte);
  $('#prospect-unmark-btn').addEventListener('click', unmarkRecorte);

  // Seletor de colunas + ficha do registro
  $('#col-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleColMenu(); });
  document.querySelectorAll('[data-close-record]').forEach((n) => n.addEventListener('click', closeRecord));
  document.addEventListener('click', (e) => {
    const cm = $('#col-panel');
    if (cm && !cm.hidden && !e.target.closest('.colmenu')) cm.hidden = true;
  });

  // Importação
  $('#dist-btn').addEventListener('click', toggleDist);
  $('#import-btn').addEventListener('click', openImport);
  document.querySelectorAll('[data-close-modal]').forEach((n) => n.addEventListener('click', closeImport));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeImport(); closeRecord(); closeProspect(); const cm = $('#col-panel'); if (cm) cm.hidden = true; } });
  const dz = $('#dropzone');
  const input = $('#file-input');
  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { uploadFiles(input.files); input.value = ''; });
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

  // Mostra "Sair" só quando há senha
  api('/api/auth').then((a) => { if (a.enabled) $('#logout-link').hidden = false; }).catch(() => {});

  loadStats();
  loadFilterOptions();
  loadRecords();
}

document.addEventListener('DOMContentLoaded', init);
