// Window Theme Manager: panel UI.
const sc = window.sidecar;
const $ = (id) => document.getElementById(id);

const state = {
  themes: [],
  byId: new Map(),
  query: '',
  kind: 'all',
  scope: localStorage.getItem('wtm.scope') === 'frame' ? 'frame' : 'full',
  selectedId: null,
  workspace: null, // { uri, path, name, sources }
  candidates: [],
  applied: new Map(), // workspacePath -> record summary
  status: null,
  pollTimer: null,
  wasRefreshing: false,
  tab: 'library',
};

// Discover tab state.
const disc = {
  started: false,
  query: '',
  mode: null,
  results: [],
  nextOffset: null,
  loading: false,
  error: null,
  seq: 0,
  open: new Set(), // expanded result keys
  previews: new Map(), // key -> { loading, error, data, selected: Set<name> }
  library: [],
};

const SOURCE_LABELS = {
  window: 'This window',
  native: 'From Antigravity',
  conversation: 'From this conversation',
  project: 'Antigravity project',
  'ide-last-active': 'Last active IDE window',
  'ide-open': 'Open IDE window',
  'antigravity-project': 'Antigravity project',
  manual: 'Chosen manually',
  panel: 'Detected',
};

const KIND_LABELS = { dark: 'Dark', light: 'Light', 'hc-dark': 'HC Dark', 'hc-light': 'HC Light' };

const SCOPE_HINTS = {
  full: 'Workbench + syntax colors',
  frame: 'Title, activity & status bars',
};

// Abstract "code" lines for the preview: [token, width%] segments.
const CODE_LINES = [
  { segs: [['keyword', 16], ['func', 24], ['fg', 6], ['string', 30]] },
  { indent: 8, segs: [['comment', 56]] },
  { indent: 8, hl: true, segs: [['keyword', 11], ['variable', 18], ['fg', 5], ['number', 12]] },
  { indent: 8, segs: [['type', 20], ['fg', 4], ['func', 26], ['fg', 8]] },
  { indent: 16, segs: [['keyword', 13], ['string', 34]] },
  { segs: [['fg', 6]] },
  { segs: [['variable', 15], ['fg', 6], ['func', 22], ['string', 18]] },
];

const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------------------
// Helpers

const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : 'transparent');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function swatchStrip(container, colors) {
  container.replaceChildren(...colors.map((c) => {
    const s = el('span');
    s.style.background = safeColor(c);
    return s;
  }));
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await sc.fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function relTime(iso) {
  if (!iso) return 'never';
  const secs = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
  let v = secs;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return '';
}

let toastTimer;
function toast(message, detail, { error = false, action = null } = {}) {
  const t = $('toast');
  t.className = `toast${error ? ' error' : ''}`;
  t.replaceChildren(el('span', 'toast-msg', message));
  if (detail) t.append(el('span', 'toast-detail', detail));
  if (action) {
    const b = el('button', 'btn small toast-action', action.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      t.hidden = true;
      action.run();
    });
    t.append(b);
  }
  // Sit just above the footer when it is visible.
  const footer = document.querySelector('.actions');
  t.style.bottom = `${footer && footer.offsetParent ? footer.offsetHeight + 10 : 12}px`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 9000 : action ? 8000 : 5000);
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function setBusy(button, busy) {
  button.classList.toggle('busy', busy);
  button.disabled = busy || (button.id === 'apply' && !canApply());
}

// ---------------------------------------------------------------------------
// Workspace

async function detectWorkspace() {
  let uris = [];
  let source = 'panel';
  try {
    if (typeof sc.getWorkspaceUris === 'function') {
      uris = (await sc.getWorkspaceUris()) || [];
      source = sc.getWorkspaceUris.source || 'native';
    }
  } catch (err) {
    console.warn('[window-theme-manager] getWorkspaceUris failed', err);
  }
  try {
    const { candidates } = await api('/api/workspaces', {
      method: 'POST',
      body: { uris, source, projectId: sc.getWorkspaceUris?.projectId || undefined },
    });
    state.candidates = candidates;
    const detected = uris.length && candidates[0]?.sources.includes(source) ? candidates[0] : null;
    setWorkspace(detected);
    if (!detected) togglePicker(true);
  } catch (err) {
    setWorkspace(null);
    toast('Could not list workspaces', err.message, { error: true });
  }
  renderPicker();
}

function setWorkspace(ws) {
  state.workspace = ws;
  renderWorkspace();
  renderCurrent();
  updateBadges();
  updateActions();
}

function renderWorkspace() {
  const ws = state.workspace;
  const name = $('ws-name');
  const chip = $('ws-source');
  if (!ws) {
    name.textContent = 'No workspace detected';
    name.classList.add('placeholder');
    $('ws-path').textContent = 'Choose the project folder for this window below.';
    chip.hidden = true;
    return;
  }
  name.textContent = ws.name;
  name.title = ws.path;
  name.classList.remove('placeholder');
  // The path box truncates from the left (direction: rtl); the LRM marks keep
  // the path's own slashes in left-to-right order.
  $('ws-path').textContent = `‎${ws.path}‎`;
  $('ws-path').title = ws.path;
  chip.textContent = SOURCE_LABELS[ws.sources[0]] || ws.sources[0];
  chip.hidden = false;
}

function renderPicker() {
  const select = $('ws-select');
  const options = state.candidates.map((c) => {
    const o = el('option', '', `${c.name}  ·  ${SOURCE_LABELS[c.sources[0]] || c.sources[0]}`);
    o.value = c.uri;
    o.title = c.path;
    return o;
  });
  const manual = el('option', '', 'Other folder…');
  manual.value = '__manual';
  if (!state.workspace) {
    const none = el('option', '', 'Select a folder…');
    none.value = '';
    none.disabled = true;
    options.unshift(none);
  }
  select.replaceChildren(...options, manual);
  select.value = state.workspace?.uri || '';
}

function togglePicker(open) {
  const picker = $('ws-picker');
  const show = open ?? picker.hidden;
  picker.hidden = !show;
  $('ws-change').setAttribute('aria-expanded', String(show));
  $('ws-change').textContent = show ? 'Done' : 'Change';
}

// ---------------------------------------------------------------------------
// Applied themes

async function loadApplied() {
  try {
    const { records } = await api('/api/applied');
    state.applied = new Map(records.map((r) => [r.workspacePath, r]));
  } catch (err) {
    console.warn('[window-theme-manager] could not load applied themes', err);
  }
  renderCurrent();
  updateBadges();
}

function currentRecord() {
  return state.workspace ? state.applied.get(state.workspace.path) : null;
}

function renderCurrent() {
  const rec = currentRecord();
  $('current').hidden = !rec;
  if (!rec) return;
  const theme = state.byId.get(rec.themeId);
  const p = theme?.palette || rec.palette;
  swatchStrip($('current-swatches'), p ? [p.titleBg, p.activityBg, p.editorBg, p.statusBg, p.accent] : []);
  $('current-name').textContent = `${rec.themeName} · ${rec.scope === 'frame' ? 'Frame only' : 'Full theme'}`;
  $('current-name').title = `Applied ${relTime(rec.appliedAt)}`;
}

// ---------------------------------------------------------------------------
// Catalog + grid

async function loadCatalog() {
  try {
    const { status, themes } = await api('/api/catalog');
    state.themes = themes;
    state.byId = new Map(themes.map((t) => [t.id, t]));
    state.status = status;
  } catch (err) {
    state.status = { state: 'error', errors: [err.message] };
  }
  if (!state.selectedId || !state.byId.has(state.selectedId)) {
    const rec = currentRecord();
    state.selectedId = rec && state.byId.has(rec.themeId) ? rec.themeId : null;
  }
  renderGrid();
  renderCatalogInfo();
  renderSelected();
  renderCurrent();
  if (state.status?.state === 'running') startPolling();
}

function matches(t) {
  if (state.kind === 'dark' && t.kind !== 'dark') return false;
  if (state.kind === 'light' && t.kind !== 'light') return false;
  if (state.kind === 'hc' && !t.kind.startsWith('hc')) return false;
  if (!state.query) return true;
  const hay = `${t.name} ${t.family} ${t.publisher} ${KIND_LABELS[t.kind]} ${t.kind.startsWith('hc') ? 'high contrast' : ''}`.toLowerCase();
  return state.query.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function filteredThemes() {
  return state.themes.filter(matches);
}

function buildMock(p) {
  const mock = el('div', 'mock');
  const vars = {
    '--m-ed': p.editorBg, '--m-fg': p.fg, '--m-title': p.titleBg, '--m-title-fg': p.titleFg,
    '--m-act': p.activityBg, '--m-act-fg': p.activityFg, '--m-side': p.sideBarBg, '--m-accent': p.accent,
    '--m-status': p.statusBg, '--m-status-fg': p.statusFg, '--m-tabs': p.tabInactiveBg,
    '--m-tab-active': p.tabActiveBg, '--m-hl': p.lineHighlight,
  };
  for (const [k, v] of Object.entries(vars)) mock.style.setProperty(k, safeColor(v));

  const title = el('div', 'm-title');
  const dots = el('span', 'dots');
  dots.append(el('i'), el('i'), el('i'));
  title.append(dots, el('span', 't'));

  const body = el('div', 'm-body');
  const activity = el('div', 'm-activity');
  activity.append(el('i'), el('i'), el('i'), el('i'));
  const side = el('div', 'm-side');
  for (let i = 0; i < 5; i++) side.append(el('b'));
  const editor = el('div', 'm-editor');
  const tabs = el('div', 'm-tabs');
  tabs.append(el('span'));
  const code = el('div', 'm-code');
  for (const line of CODE_LINES) {
    const row = el('p', line.hl ? 'hl' : '');
    if (line.indent) row.style.paddingLeft = `${line.indent}%`;
    for (const [token, width] of line.segs) {
      const s = el('s');
      s.style.width = `${width}%`;
      s.style.background = safeColor(token === 'fg' ? p.fg : p[token]);
      if (token === 'fg') s.style.opacity = '0.55';
      row.append(s);
    }
    code.append(row);
  }
  editor.append(tabs, code);
  body.append(activity, side, editor);

  const status = el('div', 'm-status');
  status.append(el('i'), el('i'));
  mock.append(title, body, status);
  return mock;
}

function buildCard(t) {
  const card = el('div', 'card');
  card.dataset.id = t.id;
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', String(t.id === state.selectedId));
  card.tabIndex = t.id === state.selectedId ? 0 : -1;
  card.title = `${t.name}, ${t.family} (${t.license} license)`;

  const check = el('span', 'check');
  check.innerHTML = ICON_CHECK;
  const meta = el('div', 'card-meta');
  const sub = el('div', 'card-sub');
  sub.append(el('span', 'kind', KIND_LABELS[t.kind] || t.kind), el('span', '', t.family));
  const sw = el('div', 'swatches');
  const p = t.palette;
  swatchStrip(sw, [p.editorBg, p.titleBg, p.statusBg, p.accent, p.keyword, p.string, p.func]);
  meta.append(el('div', 'card-name', t.name), sub, sw);
  card.append(buildMock(p), check, meta);
  return card;
}

function renderGrid() {
  const grid = $('grid');
  const empty = $('empty');
  const list = filteredThemes();
  $('count').textContent = state.themes.length ? `${list.length} of ${state.themes.length}` : '';
  $('tab-count').textContent = state.themes.length ? String(state.themes.length) : '';

  if (!state.themes.length) {
    if (state.status?.state === 'running' || state.status === null) {
      grid.hidden = false;
      empty.hidden = true;
      grid.replaceChildren(...Array.from({ length: 8 }, () => el('div', 'skeleton')));
    } else {
      grid.hidden = true;
      empty.hidden = false;
      const retry = el('button', 'btn primary', 'Download theme catalog');
      retry.type = 'button';
      retry.addEventListener('click', refreshCatalog);
      const msg = state.status?.errors?.[0];
      empty.replaceChildren(
        el('strong', '', 'No themes cached yet'),
        el('span', '', msg ? `Last attempt failed: ${msg}` : 'The catalog is downloaded once, then works offline.'),
        retry,
      );
    }
    return;
  }

  if (!list.length) {
    grid.hidden = true;
    empty.hidden = false;
    empty.replaceChildren(el('strong', '', 'No matching themes'), el('span', '', 'Try a different search or filter.'));
    return;
  }

  grid.hidden = false;
  empty.hidden = true;
  const nodes = [];
  let family = null;
  for (const t of list) {
    if (t.family !== family) {
      family = t.family;
      const heading = el('div', 'family-heading', family);
      if (t.user) heading.append(el('span', 'tag', 'Added by you'));
      nodes.push(heading);
    }
    nodes.push(buildCard(t));
  }
  grid.replaceChildren(...nodes);
  if (!grid.querySelector('.card[tabindex="0"]')) grid.querySelector('.card').tabIndex = 0;
  updateBadges();
}

function updateBadges() {
  const here = currentRecord()?.themeId;
  const elsewhere = new Set([...state.applied.entries()]
    .filter(([path]) => path !== state.workspace?.path)
    .map(([, r]) => r.themeId));
  for (const card of document.querySelectorAll('.card')) {
    card.querySelector('.applied-badge')?.remove();
    const id = card.dataset.id;
    const label = id === here ? 'This window' : elsewhere.has(id) ? 'In use' : null;
    if (label) card.prepend(el('span', 'applied-badge', label));
  }
}

function select(id, { scroll = false, focus = false } = {}) {
  if (!state.byId.has(id)) return;
  state.selectedId = id;
  for (const card of document.querySelectorAll('.card')) {
    const on = card.dataset.id === id;
    card.setAttribute('aria-selected', String(on));
    card.tabIndex = on ? 0 : -1;
    if (on && scroll) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (on && focus) card.focus({ preventScroll: scroll });
  }
  renderSelected();
}

function renderSelected() {
  const t = state.byId.get(state.selectedId);
  if (!t) {
    $('selected-name').textContent = 'No theme selected';
    $('selected-sub').textContent = state.themes.length ? 'Pick a theme above' : '';
    swatchStrip($('selected-swatches'), []);
  } else {
    const p = t.palette;
    swatchStrip($('selected-swatches'), [p.titleBg, p.activityBg, p.editorBg, p.statusBg, p.accent]);
    $('selected-name').textContent = t.name;
    const detail = state.scope === 'full'
      ? `${t.colorCount} UI colors · ${t.tokenRuleCount} syntax rules`
      : 'Title, activity & status bars';
    $('selected-sub').textContent = `${KIND_LABELS[t.kind]} · ${detail}`;
  }
  updateActions();
}

function canApply() {
  return !!(state.workspace && state.byId.has(state.selectedId));
}

function updateActions() {
  const apply = $('apply');
  if (!apply.classList.contains('busy')) apply.disabled = !canApply();
  apply.title = state.workspace ? `Writes ${state.workspace.path}/.vscode/settings.json` : 'Choose a workspace first';
  $('random').disabled = !state.themes.length;
}

// ---------------------------------------------------------------------------
// Catalog refresh

function renderCatalogInfo() {
  const s = state.status || {};
  const info = $('catalog-info');
  const progress = $('progress');
  const refresh = $('refresh');
  if (s.state === 'running') {
    info.textContent = `Fetching themes… ${s.done}/${s.total} sources`;
    progress.hidden = false;
    $('progress-bar').style.width = `${s.total ? Math.round((s.done / s.total) * 100) : 0}%`;
    refresh.classList.add('spinning');
    refresh.disabled = true;
    return;
  }
  progress.hidden = true;
  refresh.classList.remove('spinning');
  refresh.disabled = false;
  const failed = (s.sources || []).filter((x) => !x.ok).length;
  const parts = [`${s.themeCount ?? state.themes.length} themes`, `updated ${relTime(s.fetchedAt)}`];
  if (failed) parts.push(`${failed} source${failed > 1 ? 's' : ''} unavailable`);
  info.textContent = parts.join(' · ');
  info.title = failed ? (s.sources || []).filter((x) => !x.ok).map((x) => `${x.label}: ${x.error}`).join('\n') : '';
}

function startPolling() {
  if (state.pollTimer) return;
  state.wasRefreshing = true;
  state.pollTimer = setInterval(async () => {
    try {
      const { status } = await api('/api/catalog/status');
      state.status = { ...state.status, ...status };
      renderCatalogInfo();
      if (status.state !== 'running') {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        await loadCatalog();
        if (state.wasRefreshing) {
          state.wasRefreshing = false;
          if (status.state === 'done') {
            const errs = status.errors?.length;
            toast(`Theme catalog updated: ${status.themeCount} themes`, errs ? `${errs} item(s) could not be downloaded; cached copies kept` : 'Cached locally for offline use');
          } else {
            toast('Could not update the theme catalog', status.errors?.[0], { error: true });
          }
        }
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      toast('Lost connection to the theme service', err.message, { error: true });
    }
  }, 700);
}

async function refreshCatalog() {
  try {
    const { status } = await api('/api/catalog/refresh', { method: 'POST', body: {} });
    state.status = { ...state.status, ...status };
    renderCatalogInfo();
    renderGrid();
    startPolling();
  } catch (err) {
    toast('Could not start the refresh', err.message, { error: true });
  }
}

// ---------------------------------------------------------------------------
// Actions

async function applySelected() {
  if (!canApply()) return;
  const t = state.byId.get(state.selectedId);
  const ws = state.workspace;
  const button = $('apply');
  setBusy(button, true);
  try {
    const res = await api('/api/apply', { method: 'POST', body: { workspaceUri: ws.uri, themeId: t.id, scope: state.scope } });
    state.applied.set(ws.path, res.record);
    renderCurrent();
    updateBadges();
    const what = res.tokenRuleCount ? `${res.colorCount} colors + ${res.tokenRuleCount} syntax rules` : `${res.colorCount} colors`;
    toast(`Applied ${t.name} to ${ws.name}`, `${what} → ${res.file}`);
  } catch (err) {
    toast(`Could not apply ${t.name}`, err.message, { error: true });
  } finally {
    setBusy(button, false);
  }
}

async function removeTheme() {
  const ws = state.workspace;
  if (!ws) return;
  const button = $('remove');
  setBusy(button, true);
  try {
    const res = await api('/api/remove', { method: 'POST', body: { workspaceUri: ws.uri } });
    state.applied.delete(ws.path);
    renderCurrent();
    updateBadges();
    toast(`Removed theme from ${ws.name}`, res.file ? `Previous colors restored in ${res.file}` : undefined);
  } catch (err) {
    toast('Could not remove the theme', err.message, { error: true });
  } finally {
    setBusy(button, false);
  }
}

async function randomize() {
  const button = $('random');
  setBusy(button, true);
  try {
    const ids = filteredThemes().map((t) => t.id);
    const res = await api('/api/random', {
      method: 'POST',
      body: { workspaceUri: state.workspace?.uri, themeIds: ids, excludeId: state.selectedId },
    });
    select(res.themeId, { scroll: true });
    const others = res.comparedWith.filter((n) => n !== res.themeName);
    toast(
      `Picked ${res.themeName}`,
      others.length ? `Most distinct from ${[...new Set(others)].slice(0, 4).join(', ')} (ΔE ≈ ${res.minDistance}). Press Apply to use it.` : 'Press Apply to use it.',
    );
  } catch (err) {
    toast('Could not pick a theme', err.message, { error: true });
  } finally {
    setBusy(button, false);
  }
}

// ---------------------------------------------------------------------------
// Events

function moveSelection(key) {
  const cards = [...document.querySelectorAll('.card')];
  if (!cards.length) return;
  const current = cards.find((c) => c.dataset.id === state.selectedId) || document.activeElement.closest?.('.card') || cards[0];
  const r = current.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const c of cards) {
    if (c === current) continue;
    const b = c.getBoundingClientRect();
    const dx = b.left + b.width / 2 - cx;
    const dy = b.top + b.height / 2 - cy;
    const ok = { ArrowRight: dx > 5 && Math.abs(dy) < r.height / 2, ArrowLeft: dx < -5 && Math.abs(dy) < r.height / 2, ArrowDown: dy > 5, ArrowUp: dy < -5 }[key];
    if (!ok) continue;
    const score = key === 'ArrowDown' || key === 'ArrowUp' ? Math.abs(dy) * 10 + Math.abs(dx) : Math.abs(dx);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best) select(best.dataset.id, { scroll: true, focus: true });
}

function bindEvents() {
  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) select(card.dataset.id, { focus: true });
  });
  $('grid').addEventListener('dblclick', (e) => {
    if (e.target.closest('.card')) applySelected();
  });
  $('grid').addEventListener('keydown', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      select(card.dataset.id);
      applySelected();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(card.dataset.id);
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      if (card.dataset.id !== state.selectedId) select(card.dataset.id);
      moveSelection(e.key);
    }
  });

  let searchTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value.trim();
      renderGrid();
    }, 80);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.target.value = '';
      state.query = '';
      renderGrid();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = document.querySelector('.card[aria-selected="true"]') || document.querySelector('.card');
      if (first) select(first.dataset.id, { focus: true, scroll: true });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      $(state.tab === 'discover' ? 'discover-input' : 'search').focus();
    }
  });

  $('kind-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    state.kind = b.dataset.kind;
    for (const x of $('kind-filter').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    renderGrid();
  });

  $('scope').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-scope]');
    if (b) setScope(b.dataset.scope);
  });

  $('ws-change').addEventListener('click', () => togglePicker());
  $('ws-select').addEventListener('change', (e) => {
    const value = e.target.value;
    $('ws-manual').hidden = value !== '__manual';
    if (value === '__manual') {
      $('ws-manual-input').focus();
      return;
    }
    const c = state.candidates.find((x) => x.uri === value);
    if (c) setWorkspace(c);
  });
  $('ws-manual').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('ws-manual-input').value.trim();
    if (!input) return;
    const info = await api('/api/workspace/inspect', { method: 'POST', body: { path: input } }).catch((err) => ({ ok: false, error: err.message }));
    if (!info.ok) {
      toast('Folder not usable', info.error, { error: true });
      return;
    }
    const c = { uri: info.uri, path: info.path, name: info.name, sources: ['manual'] };
    state.candidates = [c, ...state.candidates.filter((x) => x.path !== c.path)];
    setWorkspace(c);
    renderPicker();
    $('ws-manual').hidden = true;
    togglePicker(false);
  });

  $('apply').addEventListener('click', applySelected);
  $('random').addEventListener('click', randomize);
  $('remove').addEventListener('click', removeTheme);
  $('refresh').addEventListener('click', refreshCatalog);
}

// ---------------------------------------------------------------------------
// Tabs

function setTab(tab) {
  state.tab = tab === 'discover' ? 'discover' : 'library';
  document.querySelector('.app').dataset.tab = state.tab;
  for (const b of document.querySelectorAll('.tabs [role="tab"]')) {
    const on = b.dataset.tab === state.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('library-view').hidden = state.tab !== 'library';
  $('discover-view').hidden = state.tab !== 'discover';
  $('toast').hidden = true;
  if (state.tab === 'discover') {
    if (!disc.started) {
      disc.started = true;
      loadLibrary();
      discoverSearch();
    }
    $('discover-input').focus({ preventScroll: true });
  }
}

/** Switches to the Themes tab showing one family, with a theme selected. */
function showInLibrary(family, themeId) {
  setTab('library');
  state.kind = 'all';
  for (const x of $('kind-filter').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.kind === 'all'));
  $('search').value = family;
  state.query = family;
  renderGrid();
  if (themeId && state.byId.has(themeId)) select(themeId, { scroll: true, focus: true });
}

// ---------------------------------------------------------------------------
// Discover: search online, preview, add to the library

async function loadLibrary() {
  try {
    const { sources } = await api('/api/library');
    disc.library = sources;
  } catch (err) {
    console.warn('[window-theme-manager] could not load the library', err);
  }
  renderMySources();
}

function renderMySources() {
  const box = $('my-sources');
  box.hidden = !disc.library.length;
  $('my-count').textContent = String(disc.library.length);
  $('my-list').replaceChildren(...disc.library.map((src) => {
    const li = el('li', 'my-item');
    const text = el('div', 'my-text');
    text.append(el('div', 'my-name', src.family || src.id || src.url));
    const where = src.type === 'openvsx' ? `Open VSX · ${src.id}` : src.type === 'github-repo' ? `GitHub · ${src.repo}` : src.url;
    const count = `${src.themes} theme${src.themes === 1 ? '' : 's'}${src.include ? ' (selected)' : ''}`;
    const sub = el('div', 'my-sub', `${count} · ${where}`);
    sub.title = where;
    text.append(sub);
    const show = el('button', 'btn ghost small', 'Show');
    show.type = 'button';
    show.disabled = !src.themes;
    show.addEventListener('click', () => showInLibrary(src.family));
    const remove = el('button', 'btn ghost small danger', 'Remove');
    remove.type = 'button';
    remove.title = 'Remove these themes from your catalog';
    remove.addEventListener('click', () => removeSource(src, remove));
    li.append(text, show, remove);
    return li;
  }));
}

async function discoverSearch({ append = false } = {}) {
  const seq = ++disc.seq;
  disc.loading = true;
  disc.error = null;
  if (!append) {
    disc.results = [];
    disc.nextOffset = null;
  }
  renderResults();
  try {
    const res = await api('/api/discover/search', {
      method: 'POST',
      body: { query: disc.query, offset: append ? disc.nextOffset : 0 },
    });
    if (seq !== disc.seq) return;
    const known = new Set(disc.results.map((r) => r.key));
    disc.results = [...disc.results, ...res.results.filter((r) => !known.has(r.key))];
    disc.nextOffset = res.nextOffset;
    disc.mode = res.mode;
    if (res.mode === 'direct' && res.results.length === 1) disc.open.add(res.results[0].key);
  } catch (err) {
    if (seq === disc.seq) disc.error = err.message;
  } finally {
    if (seq === disc.seq) {
      disc.loading = false;
      renderResults();
      for (const key of disc.open) {
        const r = disc.results.find((x) => x.key === key);
        if (r && !disc.previews.has(key)) loadPreview(r);
      }
    }
  }
}

function renderResults() {
  const heading = $('discover-heading');
  const empty = $('discover-empty');
  const list = $('results');
  const more = $('more');

  if (disc.mode === 'popular' || (!disc.query && !disc.mode)) heading.textContent = 'Popular color themes on Open VSX';
  else if (disc.mode === 'direct') heading.textContent = 'From your link';
  else heading.textContent = `Results for “${disc.query}”`;

  list.replaceChildren(...disc.results.map(buildResult));
  more.hidden = disc.loading || disc.nextOffset == null || !!disc.error;

  if (disc.loading) {
    empty.hidden = true;
    list.append(...Array.from({ length: disc.results.length ? 2 : 5 }, () => el('li', 'skeleton result-skeleton')));
  } else if (disc.error) {
    empty.hidden = false;
    const retry = el('button', 'btn small', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => discoverSearch());
    empty.replaceChildren(el('strong', '', 'Search failed'), el('span', '', disc.error), retry);
  } else if (!disc.results.length) {
    empty.hidden = false;
    empty.replaceChildren(
      el('strong', '', 'No color themes found'),
      el('span', '', 'Try another name, or paste a link to the theme on GitHub, Open VSX or the VS Code Marketplace.'),
    );
  } else {
    empty.hidden = true;
  }
}

function statusTag(status) {
  if (status === 'builtin') return el('span', 'tag', 'Built in');
  if (status === 'added') return el('span', 'tag ok', 'In your library');
  return null;
}

function kindsText(r) {
  if (!r.themeCount) return null;
  const k = r.kinds || {};
  const parts = [k.dark && `${k.dark} dark`, k.light && `${k.light} light`, k.hc && `${k.hc} high contrast`].filter(Boolean);
  const n = `${r.themeCount} theme${r.themeCount === 1 ? '' : 's'}`;
  return parts.length > 1 ? `${n} (${parts.join(', ')})` : parts.length ? `${n}, ${parts[0].replace(/^\d+ /, '')}` : n;
}

function buildResult(r) {
  const li = el('li', 'result');
  li.dataset.key = r.key;
  const open = disc.open.has(r.key);

  const head = el('div', 'result-head');
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.setAttribute('aria-expanded', String(open));
  head.title = open ? 'Hide preview' : 'Preview these themes';

  const icon = el('div', 'result-icon');
  icon.textContent = (r.title || '?').trim().charAt(0).toUpperCase();
  if (r.iconUrl && /^https:\/\//.test(r.iconUrl)) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', () => icon.classList.add('has-img'));
    img.addEventListener('error', () => img.remove());
    img.src = r.iconUrl;
    icon.append(img);
  }

  const text = el('div', 'result-text');
  const title = el('div', 'result-title');
  title.append(el('span', 'result-name', r.title));
  const tag = statusTag(r.status);
  if (tag) title.append(tag);
  const meta = [r.publisher, r.downloads != null ? `${compact.format(r.downloads)} installs` : null, r.rating ? `★ ${r.rating.toFixed(1)}` : null, kindsText(r)]
    .filter(Boolean).join(' · ');
  text.append(title, el('div', 'result-sub', meta));
  if (r.description && !r.direct) text.append(el('div', 'result-desc', r.description));

  const chevron = el('span', 'chevron');
  chevron.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  head.append(icon, text, chevron);
  li.append(head);
  if (open) li.append(buildPreview(r));
  return li;
}

function rerenderResult(key) {
  const r = disc.results.find((x) => x.key === key);
  const node = [...$('results').children].find((n) => n.dataset.key === key);
  if (r && node) node.replaceWith(buildResult(r));
}

function togglePreview(key) {
  const r = disc.results.find((x) => x.key === key);
  if (!r) return;
  if (disc.open.has(key)) disc.open.delete(key);
  else {
    disc.open.add(key);
    if (!disc.previews.has(key) || disc.previews.get(key).error) loadPreview(r);
  }
  rerenderResult(key);
}

async function loadPreview(r) {
  const p = { loading: true, error: null, data: null, selected: new Set() };
  disc.previews.set(r.key, p);
  rerenderResult(r.key);
  try {
    p.data = await api('/api/discover/preview', { method: 'POST', body: { source: r.source } });
    if (p.data.status) r.status = p.data.status;
    // Pre-select everything, or what is already in the library for this source.
    const mine = disc.library.find((s) => s.key === p.data.key);
    const names = p.data.themes.map((t) => t.name);
    p.selected = new Set(mine?.include ? names.filter((n) => mine.include.includes(n)) : names);
    if (r.direct && p.data.meta?.title) {
      r.title = p.data.meta.title;
      r.publisher = p.data.meta.publisher || r.publisher;
    }
  } catch (err) {
    p.error = err.message;
  } finally {
    p.loading = false;
    rerenderResult(r.key);
  }
}

function buildPreviewCard(t, checked) {
  const card = el('div', 'card pcard');
  card.dataset.name = t.name;
  card.setAttribute('role', 'checkbox');
  card.setAttribute('aria-checked', String(checked));
  card.tabIndex = 0;
  card.title = `${t.name} (${KIND_LABELS[t.kind] || t.kind}). Click to ${checked ? 'skip' : 'include'} it.`;
  const check = el('span', 'check');
  check.innerHTML = ICON_CHECK;
  const meta = el('div', 'card-meta');
  const sub = el('div', 'card-sub');
  sub.append(el('span', 'kind', KIND_LABELS[t.kind] || t.kind));
  meta.append(el('div', 'card-name', t.name), sub);
  card.append(buildMock(t.palette), check, meta);
  return card;
}

function buildPreview(r) {
  const box = el('div', 'preview');
  const p = disc.previews.get(r.key);
  if (!p || p.loading) {
    const grid = el('div', 'preview-grid');
    grid.append(...Array.from({ length: Math.min(r.themeCount || 2, 4) }, () => el('div', 'skeleton pskeleton')));
    box.append(grid, el('div', 'preview-note', 'Downloading theme files…'));
    return box;
  }
  if (p.error) {
    const retry = el('button', 'btn small', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => loadPreview(r));
    box.append(el('div', 'preview-error', p.error), retry);
    return box;
  }

  const d = p.data;
  const grid = el('div', 'preview-grid');
  grid.append(...d.themes.map((t) => buildPreviewCard(t, p.selected.has(t.name))));
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.pcard');
    if (card) togglePick(r, card.dataset.name);
  });
  grid.addEventListener('keydown', (e) => {
    const card = e.target.closest('.pcard');
    if (card && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      togglePick(r, card.dataset.name, true);
    }
  });

  const notes = [];
  if (d.truncated) notes.push(`Showing the first ${d.themes.length} of ${d.total} themes.`);
  if (d.errors?.length) notes.push(`${d.errors.length} theme file(s) could not be loaded.`);

  const info = el('div', 'preview-info');
  const license = d.meta?.license ? `License: ${d.meta.license}` : 'License not stated';
  info.append(el('span', '', license));
  if (d.meta?.page) {
    const a = el('a', '', d.meta.page.includes('open-vsx.org') ? 'Open VSX page' : 'Source');
    a.href = d.meta.page;
    a.target = '_blank';
    a.rel = 'noopener';
    info.append(document.createTextNode(' · '), a);
  }

  const actions = el('div', 'preview-actions');
  const n = p.selected.size;
  if (r.status === 'builtin') {
    const show = el('button', 'btn small', 'Show in Themes');
    show.type = 'button';
    show.addEventListener('click', () => showInLibrary(d.themes[0]?.family || r.title, d.themes[0]?.id));
    actions.append(el('span', 'preview-note', 'Already in the built-in catalog.'), show);
  } else {
    const add = el('button', 'btn primary small', r.status === 'added' ? `Update library (${n})` : `Add ${n === d.themes.length && n > 1 ? `all ${n}` : n} theme${n === 1 ? '' : 's'}`);
    add.type = 'button';
    add.disabled = !n;
    add.addEventListener('click', () => addToLibrary(r, add));
    if (d.themes.length > 1) {
      const all = el('button', 'link', n === d.themes.length ? 'Select none' : 'Select all');
      all.type = 'button';
      all.addEventListener('click', () => {
        p.selected = n === d.themes.length ? new Set() : new Set(d.themes.map((t) => t.name));
        rerenderResult(r.key);
      });
      actions.append(all);
    }
    actions.append(add);
  }

  box.append(grid);
  if (notes.length) box.append(el('div', 'preview-note', notes.join(' ')));
  box.append(info, actions);
  return box;
}

function togglePick(r, name, keepFocus = false) {
  const p = disc.previews.get(r.key);
  if (!p?.data) return;
  if (p.selected.has(name)) p.selected.delete(name);
  else p.selected.add(name);
  rerenderResult(r.key);
  if (keepFocus) {
    const node = [...$('results').children].find((x) => x.dataset.key === r.key);
    [...(node?.querySelectorAll('.pcard') || [])].find((c) => c.dataset.name === name)?.focus();
  }
}

async function addToLibrary(r, button) {
  const p = disc.previews.get(r.key);
  if (!p?.data) return;
  const include = p.data.themes.map((t) => t.name).filter((name) => p.selected.has(name));
  setBusy(button, true);
  try {
    const res = await api('/api/library/add', {
      method: 'POST',
      body: { source: p.data.source, include: include.length === p.data.themes.length ? null : include },
    });
    r.status = 'added';
    await Promise.all([loadLibrary(), loadCatalog()]);
    rerenderResult(r.key);
    const n = res.themeIds.length;
    toast(`Added ${n} ${res.family} theme${n === 1 ? '' : 's'}`, 'Saved to your catalog; available offline in every window.', {
      action: { label: 'Show', run: () => showInLibrary(res.family, res.themeIds[0]) },
    });
  } catch (err) {
    toast('Could not add the themes', err.message, { error: true });
    setBusy(button, false);
  }
}

async function removeSource(src, button) {
  setBusy(button, true);
  try {
    const res = await api('/api/library/remove', { method: 'POST', body: { key: src.key } });
    for (const r of disc.results) if (r.key === src.key) r.status = null;
    await Promise.all([loadLibrary(), loadCatalog()]);
    for (const r of disc.results) if (r.key === src.key) rerenderResult(r.key);
    const inUse = [...state.applied.values()].filter((a) => a.family === src.family).length;
    toast(
      `Removed ${src.family}`,
      `${res.removed} theme${res.removed === 1 ? '' : 's'} removed from your catalog.${inUse ? ' Windows already using them keep their colors.' : ''}`,
    );
  } catch (err) {
    toast('Could not remove the themes', err.message, { error: true });
    setBusy(button, false);
  }
}

function bindDiscoverEvents() {
  $('tab-library').addEventListener('click', () => setTab('library'));
  $('tab-discover').addEventListener('click', () => setTab('discover'));
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setTab(state.tab === 'library' ? 'discover' : 'library');
    $(`tab-${state.tab}`).focus();
  });

  let timer;
  const input = $('discover-input');
  const run = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q === disc.query && disc.results.length) return;
    disc.query = q;
    discoverSearch();
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    // Links are resolved on Enter/paste; plain text searches as you type.
    if (!/^[a-z]+:\/\//i.test(input.value.trim())) timer = setTimeout(run, 450);
  });
  input.addEventListener('paste', () => setTimeout(run, 0));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      run();
    }
  });
  $('discover-form').addEventListener('submit', (e) => {
    e.preventDefault();
    disc.results = [];
    run();
  });

  $('results').addEventListener('click', (e) => {
    const head = e.target.closest('.result-head');
    if (head) togglePreview(head.parentElement.dataset.key);
  });
  $('results').addEventListener('keydown', (e) => {
    const head = e.target.closest('.result-head');
    if (head && (e.key === 'Enter' || e.key === ' ') && e.target === head) {
      e.preventDefault();
      togglePreview(head.parentElement.dataset.key);
      [...$('results').children].find((n) => n.dataset.key === head.parentElement.dataset.key)?.querySelector('.result-head')?.focus();
    }
  });
  $('more').addEventListener('click', () => discoverSearch({ append: true }));
}

async function reloadCatalogIfChanged() {
  try {
    const { status } = await api('/api/catalog/status');
    if (status.state === 'running') {
      state.status = { ...state.status, ...status };
      startPolling();
    } else if (status.revision !== state.status?.revision) {
      await loadCatalog();
    }
  } catch { /* the next action will report it */ }
}

// Events from the editor extension host (see extension/media/bridge.js).
function bindHostEvents() {
  window.addEventListener('wtm-host', (e) => {
    const ev = e.detail || {};
    if (ev.type === 'workspace-changed') detectWorkspace();
    else if (ev.type === 'applied-changed') loadApplied();
    else if (ev.type === 'visible') {
      // Another window may have applied a theme or changed the catalog.
      loadApplied();
      reloadCatalogIfChanged();
      if (disc.started) loadLibrary();
    } else if (ev.type === 'catalog-changed') loadCatalog();
    else if (ev.type === 'show-tab') setTab(ev.tab);
  });
}

function setScope(scope) {
  state.scope = scope === 'frame' ? 'frame' : 'full';
  localStorage.setItem('wtm.scope', state.scope);
  for (const x of $('scope').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.scope === state.scope));
  $('scope-hint').textContent = SCOPE_HINTS[state.scope];
  renderSelected();
}

// ---------------------------------------------------------------------------

async function init() {
  if (!sc || typeof sc.fetch !== 'function') {
    document.body.textContent = 'window.sidecar is not available: /preload.js failed to load.';
    return;
  }
  bindEvents();
  bindDiscoverEvents();
  bindHostEvents();
  setScope(state.scope);
  setTab('library');
  renderGrid();
  await Promise.all([detectWorkspace(), loadApplied()]);
  await loadCatalog();
}

init();
