'use strict';

const state = { limit: 50, offset: 0, q: '', sort: null, dir: 'asc', view: 'clean', mode: 'list', minScore: 70 };

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

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#stat-records').textContent = fmt(s.records);
    $('#stat-columns').textContent = fmt(s.columns);
    $('#stat-imports').textContent = fmt(s.imports);
  } catch (e) { /* silencioso */ }
}

// --- Lista única de registros ---
async function loadRecords() {
  const viewer = $('#viewer');
  const params = new URLSearchParams({ limit: state.limit, offset: state.offset, q: state.q, dir: state.dir, view: state.view });
  if (state.sort) params.set('sort', state.sort);

  // Atualiza o link de exportação para respeitar a busca e a visão atuais.
  const exp = new URLSearchParams({ view: state.view });
  if (state.q) exp.set('q', state.q);
  $('#export-link').href = `/api/export.csv?${exp}`;

  let data;
  try {
    data = await api(`/api/records?${params}`);
  } catch (e) { viewer.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }

  const { columns, rows, total, limit, offset } = data;

  if (columns.length === 0) {
    viewer.innerHTML = '<div class="empty-state"><p>Sua lista está vazia. Suba planilhas acima para começar.</p></div>';
    return;
  }

  // Cabeçalho: "Origem" + colunas do catálogo (todas ordenáveis).
  const headerCells = [{ column_name: '_source_file', original_name: 'Origem', data_type: 'text' }, ...columns];
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
    }, [
      document.createTextNode(c.original_name + arrow),
      c.data_type !== 'text' ? el('span', { class: 'type-badge', text: c.data_type }) : null,
    ]);
  }))]);

  const tbody = el('tbody', {}, rows.map((row) => el('tr', {}, headerCells.map((c) => {
    const v = row[c.column_name];
    const td = el('td', { class: c.data_type === 'number' ? 'num' : (c.column_name === '_source_file' ? 'origin' : '') });
    if (v == null || v === '') td.appendChild(el('span', { class: 'null', text: '—' }));
    else td.textContent = String(v);
    return td;
  }))));

  const table = el('div', { class: 'table-wrap' }, [el('table', {}, [thead, tbody])]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const pager = el('div', { class: 'pager' }, [
    el('div', { class: 'info', text: `Mostrando ${fmt(from)}–${fmt(to)} de ${fmt(total)} registro(s)${state.q ? ` (filtro: "${state.q}")` : ''}` }),
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
    await Promise.all([loadStats(), loadRecords()]);
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

    // Manutenção: limpar casos sem indicação de sequela.
    const maint = el('div', { class: 'maint-row' }, [
      el('div', {}, [
        el('strong', { text: '🧹 Limpeza por sequela' }),
        el('div', { class: 'imp-meta', text: 'Remove casos sem indicação de sequela (lesão/CID). Mostra a contagem antes.' }),
      ]),
      el('button', { class: 'ghost small', text: 'Verificar e limpar', onClick: cleanupNoSequela }),
    ]);
    panel.appendChild(maint);

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

async function cleanupNoSequela() {
  try {
    const { count } = await api('/api/no-sequela');
    if (count === 0) { toast('Nenhum caso sem sequela para remover. 👍', 'ok'); return; }
    const ok = confirm(`Foram encontrados ${fmt(count)} caso(s) SEM indicação de sequela (lesão/CID).\n\nDeseja EXCLUIR esses ${fmt(count)} registros da base? Esta ação não pode ser desfeita.`);
    if (!ok) return;
    const r = await api('/api/no-sequela', { method: 'DELETE' });
    toast(`${fmt(r.removed)} caso(s) sem sequela removido(s).`, 'ok');
    await Promise.all([loadStats(), refresh()]);
    $('#imports-panel').hidden = true;
  } catch (e) { toast(e.message, 'err'); }
}

async function removeImport(file) {
  if (!confirm(`Remover todos os registros do arquivo "${file}"?`)) return;
  try {
    const r = await api(`/api/imports?source_file=${encodeURIComponent(file)}`, { method: 'DELETE' });
    toast(`${fmt(r.removed)} registro(s) removido(s).`, 'ok');
    await Promise.all([loadStats(), loadRecords(), toggleImports()]);
    $('#imports-panel').hidden = false;
    toggleImports();
  } catch (e) { toast(e.message, 'err'); }
}

// --- Prospecção (triagem de auxílio-acidente) ---
function scoreClass(p) {
  if (p >= 85) return 'pot-alta';
  if (p >= 70) return 'pot-media';
  return 'pot-baixa';
}

async function loadProspects() {
  const viewer = $('#viewer');
  viewer.innerHTML = '<div class="spinner">Analisando casos...</div>';
  const params = new URLSearchParams({ limit: state.limit, offset: state.offset, q: state.q, minScore: state.minScore });

  let data;
  try { data = await api(`/api/prospects?${params}`); }
  catch (e) { viewer.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }

  const { rows, total, limit, offset } = data;

  // Cabeçalho com seletor de rigor e exportação.
  const exp = new URLSearchParams({ minScore: state.minScore });
  if (state.q) exp.set('q', state.q);
  const head = el('div', { class: 'prospect-head' }, [
    el('div', {}, [
      el('strong', { text: '🎯 Prospecção — auxílio-acidente' }),
      el('div', { class: 'sub', text: `${fmt(total)} candidato(s)${state.q ? ` para "${state.q}"` : ''} · excluídos: óbitos, aposentados e sem direito (contrib. individual/facultativo)` }),
      data.pending > 0 ? el('div', { class: 'sub', text: `⏳ Indexando ${fmt(data.pending)} registro(s)... a contagem ainda vai aumentar. Recarregue em instantes.` }) : null,
    ]),
    el('div', { class: 'prospect-actions' }, [
      el('label', { text: 'Rigor: ' }, [
        (() => {
          const sel = el('select', { onChange: (ev) => { state.minScore = Number(ev.target.value); state.offset = 0; loadProspects(); } });
          [['90', 'Muito alta (≥90%)'], ['80', 'Alta (≥80%)'], ['70', 'Média (≥70%)'], ['1', 'Todos']].forEach(([v, t]) => {
            const o = el('option', { value: v, text: t });
            if (Number(v) === state.minScore) o.selected = true;
            sel.appendChild(o);
          });
          return sel;
        })(),
      ]),
      el('a', { href: `/api/prospects.csv?${exp}` }, [el('button', { class: 'ghost', text: '⤓ Exportar lista' })]),
    ]),
  ]);

  const cols = [
    ['potencial', '% Êxito'], ['classe', 'Classe'], ['motivos', 'Por quê'], ['telefone', 'Telefone'], ['nome', 'Nome'],
    ['cid_10', 'CID-10'], ['nat_lesao', 'Nat. Lesão'], ['exigencia', 'Exigência documental'],
    ['municipio_funcionario', 'Município'], ['estado_funcionario', 'UF'], ['cat', 'CAT'],
  ];
  const thead = el('thead', {}, [el('tr', {}, cols.map(([, label]) => el('th', { text: label })))]);
  const tbody = el('tbody', {}, rows.map((r) => el('tr', {}, cols.map(([key]) => {
    if (key === 'potencial') {
      return el('td', {}, [el('span', { class: `pot-badge ${scoreClass(r.potencial)}`, text: r.potencial + '%' })]);
    }
    if (key === 'classe') return el('td', {}, [el('span', { class: `classe-tag classe-${(r.classe || '').toLowerCase().replace(/[^a-z]/g, '')}`, text: r.classe || '—' })]);
    if (key === 'motivos') return el('td', { class: 'motivos', text: (r.motivos || []).join(' · ') });
    const v = r[key];
    const td = el('td', {});
    if (v == null || v === '') td.appendChild(el('span', { class: 'null', text: '—' }));
    else td.textContent = String(v);
    return td;
  }))));
  const table = el('div', { class: 'table-wrap' }, [el('table', {}, [thead, tbody])]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const pager = el('div', { class: 'pager' }, [
    el('div', { class: 'info', text: `Mostrando ${fmt(from)}–${fmt(to)} de ${fmt(total)} (ordenado por maior potencial)` }),
    el('div', { class: 'controls' }, [
      el('button', { class: 'ghost small', text: '◀ Anterior', disabled: offset <= 0 ? '' : null, onClick: () => { state.offset = Math.max(0, offset - limit); loadProspects(); } }),
      el('button', { class: 'ghost small', text: 'Próxima ▶', disabled: to >= total ? '' : null, onClick: () => { state.offset = offset + limit; loadProspects(); } }),
    ]),
  ]);

  viewer.innerHTML = '';
  viewer.append(head, table, pager);
}

// --- Painel analítico (BI) ---
function card(label, value) {
  return el('div', { class: 'dash-card' }, [el('strong', { text: value }), el('span', { text: label })]);
}
function barList(title, items) {
  const max = items.reduce((m, x) => Math.max(m, x.n), 0) || 1;
  const rows = items.map((x) => el('div', { class: 'bar-row' }, [
    el('span', { class: 'bar-label', title: String(x.label), text: String(x.label).slice(0, 40) }),
    el('span', { class: 'bar-track' }, [el('span', { class: 'bar-fill', style: `width:${Math.max(4, (x.n / max) * 100)}%` })]),
    el('span', { class: 'bar-val', text: Number(x.n).toLocaleString('pt-BR') }),
  ]));
  return el('div', { class: 'dash-section' }, [el('h4', { text: title }), ...rows]);
}

async function loadDashboard() {
  const viewer = $('#viewer');
  viewer.innerHTML = '<div class="spinner">Calculando o painel... (pode levar alguns segundos em bases grandes)</div>';
  let d;
  try { d = await api('/api/dashboard'); }
  catch (e) { viewer.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
  const t = d.totals;
  const cards = el('div', { class: 'cards' }, [
    card('Registros', fmt(t.total)),
    card('Com sequela', fmt(t.comSequela)),
    card('Candidatos (≥ 70%)', fmt(t.candidatos)),
    card('Com telefone', fmt(t.comTelefone)),
    card('Óbitos', fmt(t.obitos)),
    card('Inelegíveis', fmt(t.inelegiveis || 0)),
  ]);
  const parts = [el('h3', { text: '📊 Painel analítico' }), cards];
  if (t.pending > 0) parts.push(el('div', { class: 'sub', text: `⏳ Indexando ${fmt(t.pending)} registro(s)... alguns números ainda vão se ajustar.` }));
  parts.push(el('div', { class: 'dash-grid' }, [
    barList('Faixa de potencial', d.faixas),
    barList('Top estados (UF do funcionário)', d.porUF),
    barList('Top partes do corpo atingidas', d.porParte),
    barList('Top CID-10', d.porCID),
    barList('Top naturezas da lesão', d.porLesao),
  ]));
  viewer.innerHTML = '';
  parts.forEach((p) => viewer.appendChild(p));
}

function refresh() {
  if (state.mode === 'dashboard') loadDashboard();
  else if (state.mode === 'prospect') loadProspects();
  else loadRecords();
}

function setMode(target) {
  state.mode = state.mode === target ? 'list' : target;
  state.offset = 0;
  const m = state.mode;
  $('#prospect-btn').textContent = m === 'prospect' ? '← Voltar à lista' : '🎯 Prospecção';
  $('#prospect-btn').classList.toggle('active', m === 'prospect');
  $('#dash-btn').textContent = m === 'dashboard' ? '← Voltar à lista' : '📊 Painel';
  $('#dash-btn').classList.toggle('active', m === 'dashboard');
  $('#view-btn').hidden = m !== 'list';
  refresh();
}

// --- Wiring ---
function init() {
  const dz = $('#dropzone');
  const input = $('#file-input');
  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { uploadFiles(input.files); input.value = ''; });
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

  const runSearch = () => { state.q = $('#search').value.trim(); state.offset = 0; $('#search-clear').hidden = !state.q; refresh(); };
  $('#search-btn').addEventListener('click', runSearch);
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  $('#search-clear').addEventListener('click', () => { $('#search').value = ''; state.q = ''; $('#search-clear').hidden = true; state.offset = 0; refresh(); });
  $('#imports-btn').addEventListener('click', toggleImports);
  $('#view-btn').addEventListener('click', () => {
    state.view = state.view === 'clean' ? 'raw' : 'clean';
    state.sort = null; state.offset = 0;
    $('#view-btn').textContent = state.view === 'clean' ? '🧩 Colunas: enxuta' : '🧩 Colunas: todas';
    loadRecords();
  });
  $('#prospect-btn').addEventListener('click', () => setMode('prospect'));
  $('#dash-btn').addEventListener('click', () => setMode('dashboard'));

  // Mostra o botão "Sair" apenas quando o acesso é protegido por senha.
  api('/api/auth').then((a) => { if (a.enabled) $('#logout-link').hidden = false; }).catch(() => {});

  loadStats();
  // Atalhos por URL: #prospeccao abre a triagem, #painel abre o BI.
  if (location.hash === '#prospeccao') $('#prospect-btn').click();
  else if (location.hash === '#painel') $('#dash-btn').click();
  else loadRecords();
}

document.addEventListener('DOMContentLoaded', init);
