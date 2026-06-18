'use strict';

const FILTER_KEYS = ['estado_funcionario', 'sexo', 'municipio_funcionario', 'bairro_funcionario'];

const state = { limit: 50, offset: 0, q: '', sort: null, dir: 'asc', filters: {} };

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

// Junta busca + filtros num querystring (usado na lista e na exportação).
function queryParams(extra = {}) {
  const p = new URLSearchParams({ q: state.q, ...extra });
  for (const k of FILTER_KEYS) if (state.filters[k]) p.set(k, state.filters[k]);
  return p;
}

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#stat-records').textContent = fmt(s.records);
    $('#stat-columns').textContent = fmt(s.columns);
    $('#stat-imports').textContent = fmt(s.imports);
  } catch (e) { /* silencioso */ }
}

// --- Lista de registros ---
async function loadRecords() {
  const viewer = $('#viewer');
  const params = queryParams({ limit: state.limit, offset: state.offset, dir: state.dir });
  if (state.sort) params.set('sort', state.sort);

  // Mantém o link de exportação coerente com busca + filtros atuais.
  $('#export-link').href = `/api/export.csv?${queryParams()}`;

  let data;
  try {
    data = await api(`/api/records?${params}`);
  } catch (e) { viewer.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }

  const { columns, rows, total, limit, offset } = data;

  if (total === 0 && !state.q && !hasFilters()) {
    viewer.innerHTML = '<div class="empty-state"><p>Sua lista está vazia. Suba planilhas acima para começar.</p></div>';
    return;
  }

  const headerCells = [{ column_name: '_source_file', original_name: 'Origem' }, ...columns];
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
    }, [document.createTextNode(c.original_name + arrow)]);
  }))]);

  const tbody = el('tbody', {}, rows.map((row) => el('tr', {}, headerCells.map((c) => {
    const v = row[c.column_name];
    const td = el('td', { class: c.column_name === '_source_file' ? 'origin' : '' });
    if (v == null || v === '') td.appendChild(el('span', { class: 'null', text: '—' }));
    else td.textContent = String(v);
    return td;
  }))));

  const table = el('div', { class: 'table-wrap' }, [el('table', {}, [thead, tbody])]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const filterNote = (state.q || hasFilters()) ? ' (filtrado)' : '';
  const pager = el('div', { class: 'pager' }, [
    el('div', { class: 'info', text: `Mostrando ${fmt(from)}–${fmt(to)} de ${fmt(total)} registro(s)${filterNote}` }),
    el('div', { class: 'controls' }, [
      el('button', { class: 'ghost small', text: '◀ Anterior', disabled: offset <= 0 ? '' : null, onClick: () => { state.offset = Math.max(0, offset - limit); loadRecords(); } }),
      el('button', { class: 'ghost small', text: 'Próxima ▶', disabled: to >= total ? '' : null, onClick: () => { state.offset = offset + limit; loadRecords(); } }),
    ]),
  ]);

  viewer.innerHTML = '';
  viewer.append(table, pager);
}

// --- Upload ---
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
      const dup = r.skipped > 0 ? ` · ${fmt(r.skipped)} duplicada(s) ignorada(s)` : '';
      const cls = r.added > 0 ? 'ok' : 'warn';
      const icon = r.added > 0 ? '✓' : '🔁';
      fb.appendChild(el('div', { class: `line ${cls}`, text: `${icon} ${r.file}: ${fmt(r.added)} nova(s)${dup}` }));
    });
    (res.errors || []).forEach((e) => fb.appendChild(el('div', { class: 'line err', text: `✕ ${e.file}: ${e.error}` })));
    state.offset = 0;
    await Promise.all([loadStats(), loadRecords(), loadFilterOptions()]);
  } catch (e) {
    fb.innerHTML = `<div class="line err">✕ ${e.message}</div>`;
  }
}

// --- Painel de planilhas importadas ---
async function toggleImports() {
  const panel = $('#imports-panel');
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<div class="spinner">Carregando...</div>';
  try {
    const list = await api('/api/imports');
    panel.innerHTML = '';
    if (list.length === 0) { panel.appendChild(el('p', { class: 'spinner', text: 'Nenhuma planilha importada ainda.' })); return; }
    panel.appendChild(el('h3', { text: 'Planilhas importadas' }));
    list.forEach((imp) => {
      panel.appendChild(el('div', { class: 'import-row' }, [
        el('div', {}, [
          el('div', { class: 'imp-name', text: imp.source_file }),
          el('div', { class: 'imp-meta', text: `${fmt(imp.rows_added)} adicionadas · ${fmt(imp.rows_skipped)} ignoradas · ${new Date(imp.imported_at).toLocaleString('pt-BR')}` }),
        ]),
        el('button', { class: 'danger small', text: 'Remover dados', onClick: () => removeImport(imp.source_file) }),
      ]));
    });
  } catch (e) { panel.innerHTML = `<div class="spinner">${e.message}</div>`; }
}

async function removeImport(file) {
  if (!confirm(`Remover todos os registros do arquivo "${file}"?`)) return;
  try {
    const r = await api(`/api/imports?source_file=${encodeURIComponent(file)}`, { method: 'DELETE' });
    toast(`${fmt(r.removed)} registro(s) removido(s).`, 'ok');
    $('#imports-panel').hidden = true;
    await Promise.all([loadStats(), loadRecords(), loadFilterOptions()]);
  } catch (e) { toast(e.message, 'err'); }
}

// --- Filtros por coluna ---
function hasFilters() {
  return FILTER_KEYS.some((k) => state.filters[k]);
}

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
  FILTER_KEYS.forEach((k) => { const n = $(`[data-filter="${k}"]`); if (n) n.value = ''; });
  $('#filter-clear').hidden = true;
  state.offset = 0;
  loadRecords();
}

// Preenche os dropdowns (estado, sexo) com os valores existentes na base.
async function loadFilterOptions() {
  for (const col of ['estado_funcionario', 'sexo']) {
    const sel = $(`[data-filter="${col}"]`);
    if (!sel || sel.tagName !== 'SELECT') continue;
    try {
      const values = await api(`/api/distinct?col=${col}`);
      const current = state.filters[col] || '';
      sel.innerHTML = '<option value="">todos</option>';
      values.forEach((v) => sel.appendChild(el('option', { value: v, text: v })));
      sel.value = current;
    } catch (e) { /* silencioso */ }
  }
}

// --- Wiring ---
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function init() {
  const dz = $('#dropzone');
  const input = $('#file-input');
  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { uploadFiles(input.files); input.value = ''; });
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

  const runSearch = () => { state.q = $('#search').value.trim(); state.offset = 0; $('#search-clear').hidden = !state.q; loadRecords(); };
  $('#search-btn').addEventListener('click', runSearch);
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  $('#search-clear').addEventListener('click', () => { $('#search').value = ''; state.q = ''; $('#search-clear').hidden = true; state.offset = 0; loadRecords(); });
  $('#imports-btn').addEventListener('click', toggleImports);

  // Filtros: selects mudam na hora; campos de texto com pequeno atraso.
  const debApply = debounce(applyFilters, 350);
  FILTER_KEYS.forEach((k) => {
    const node = $(`[data-filter="${k}"]`);
    if (!node) return;
    if (node.tagName === 'SELECT') node.addEventListener('change', applyFilters);
    else node.addEventListener('input', debApply);
  });
  $('#filter-clear').addEventListener('click', clearFilters);

  // Mostra o botão "Sair" apenas quando o acesso é protegido por senha.
  api('/api/auth').then((a) => { if (a.enabled) $('#logout-link').hidden = false; }).catch(() => {});

  loadStats();
  loadFilterOptions();
  loadRecords();
}

document.addEventListener('DOMContentLoaded', init);
