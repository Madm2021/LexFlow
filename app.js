'use strict';

const FILTER_KEYS = ['estado_funcionario', 'municipio_funcionario', 'cid_10'];

const state = { limit: 50, offset: 0, q: '', sort: null, dir: 'asc', filters: {}, validCpf: false, distOpen: false };

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
  return p;
}
function hasFilters() { return state.validCpf || FILTER_KEYS.some((k) => state.filters[k]); }

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#stat-records').textContent = fmt(s.records);
    $('#stat-imports').textContent = fmt(s.imports);
  } catch (e) { /* silencioso */ }
}

// ===== Lista de registros =====
async function loadRecords() {
  const viewer = $('#viewer');
  const meta = $('#results-meta');
  const params = queryParams({ limit: state.limit, offset: state.offset, dir: state.dir });
  if (state.sort) params.set('sort', state.sort);
  $('#export-link').href = `/api/export.csv?${queryParams()}`;

  let data;
  try {
    data = await api(`/api/records?${params}`);
  } catch (e) { viewer.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }

  const { columns, rows, total, limit, offset } = data;
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

  const headerCells = columns;
  const thead = el('thead', {}, [el('tr', {}, headerCells.map((c) => {
    const arrow = state.sort === c.column_name ? (state.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return el('th', {
      title: 'Clique para ordenar',
      onClick: () => {
        if (state.sort === c.column_name) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = c.column_name; state.dir = 'asc'; }
        state.offset = 0;
        loadRecords();
      },
    }, [c.original_name + arrow]);
  }))]);

  const tbody = el('tbody', {}, rows.map((row) => el('tr', {}, headerCells.map((c) => {
    const v = row[c.column_name];
    let cls = '';
    if (c.column_name === 'cpf') cls = 'cpf';
    const td = el('td', { class: cls });
    if (v == null || v === '') td.appendChild(el('span', { class: 'null', text: '—' }));
    else td.textContent = String(v);
    return td;
  }))));

  const table = el('div', { class: 'table-wrap' }, [el('table', {}, [thead, tbody])]);

  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  const pager = el('div', { class: 'pager' }, [
    el('div', { class: 'info', text: `Mostrando ${fmt(from)}–${fmt(to)} de ${fmt(total)}` }),
    el('div', { class: 'controls' }, [
      el('button', { class: 'btn ghost small', text: '◀ Anterior', disabled: offset <= 0 ? '' : null, onClick: () => { state.offset = Math.max(0, offset - limit); loadRecords(); } }),
      el('button', { class: 'btn ghost small', text: 'Próxima ▶', disabled: to >= total ? '' : null, onClick: () => { state.offset = offset + limit; loadRecords(); } }),
    ]),
  ]);

  viewer.innerHTML = '';
  viewer.append(table, pager);
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
  state.filters = {};
  state.validCpf = false;
  const vc = $('#f-valid-cpf'); if (vc) vc.checked = false;
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
    const total = j.total || 1;
    const done = j.valid + j.invalid;
    const pct = Math.min(100, Math.round((done / total) * 100));
    const box = $('#hygiene-progress');
    box.hidden = false;
    box.innerHTML = `<div class="maint-prog-label">Higienizando... ${fmt(done)} de ${fmt(total)}</div>`
      + `<div class="maint-prog-track"><div class="maint-prog-fill" style="width:${pct}%"></div></div>`
      + `<div class="maint-prog-pct">${pct}%</div>`;
    $('#hygiene-stats').innerHTML = hygieneStatsHtml(j);
    if (j.running) { setTimeout(tick, 1500); return; }
    box.hidden = true;
    $('#hygiene-btn').disabled = false;
    toast('Higienização concluída! 🧼', 'ok');
    loadStats();
  };
  tick();
}
async function startHygiene() {
  if (!confirm('Higienizar a base agora?\n\nRoda UMA vez, em segundo plano — você pode continuar usando o sistema normalmente. Pode levar alguns minutos numa base grande. Além de limpar CPF e datas, prepara a chave de identidade (CAT/CPF) que evita duplicatas e permite enriquecer cadastros nas próximas planilhas. Não apaga nada.')) return;
  try { await api('/api/hygiene', { method: 'POST' }); } catch (e) { toast(e.message, 'err'); return; }
  toast('Higienização iniciada (em segundo plano).', 'ok');
  pollHygiene();
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
function distBars(title, items) {
  const max = items.reduce((m, x) => Math.max(m, x.n), 0) || 1;
  const rows = items.map((x) => el('div', { class: 'bar-row' }, [
    el('span', { class: 'bar-label', title: String(x.value || '—'), text: String(x.value || '—') }),
    el('span', { class: 'bar-track' }, [el('span', { class: 'bar-fill', style: `width:${Math.max(3, (x.n / max) * 100)}%` })]),
    el('span', { class: 'bar-val', text: fmt(x.n) }),
  ]));
  return el('div', { class: 'dist-col' }, [el('h4', { text: title }), ...rows]);
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
  panel.append(
    el('div', { class: 'dist-head' }, [
      el('div', {}, [el('strong', { text: '📊 Distribuição' }), el('span', { class: 'meta-sub', text: ` · ${fmt(d.total)} registro(s) no recorte atual` })]),
      el('a', { href: `/api/facets.csv?${queryParams()}`, class: 'btn ghost small' }, ['⤒ Exportar contagem']),
    ]),
    el('div', { class: 'dist-grid' }, [
      distBars('Por Estado', d.byEstado),
      distBars('Top Municípios', d.byMunicipio),
      distBars('Top CID-10', d.byCid),
    ]),
  );
  annotateEstado(d.byEstado);
}
function toggleDist() {
  state.distOpen = !state.distOpen;
  $('#dist-panel').hidden = !state.distOpen;
  $('#dist-btn').classList.toggle('active', state.distOpen);
  if (state.distOpen) loadFacets();
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
  $('#hygiene-btn').addEventListener('click', startHygiene);

  // Importação
  $('#dist-btn').addEventListener('click', toggleDist);
  $('#import-btn').addEventListener('click', openImport);
  document.querySelectorAll('[data-close-modal]').forEach((n) => n.addEventListener('click', closeImport));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeImport(); });
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
