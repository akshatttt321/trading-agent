/* admin.js - admin panel: Google sign-in, schema-driven settings forms, secrets, maintenance.
 * Contract: API_ADMIN.md. Depends on window.Dash (exported by app.js) and window.MockAPI.admin (mock.js) in demo mode.
 */
(function () {
  'use strict';
  const D = window.Dash;
  if (!D) return;
  const { settings, state, esc, fmtTime, fmtAge, fmtClock, fmtCost, describeErr, ApiError } = D;
  const $id = (id) => document.getElementById(id);

  const SS_TOKEN = 'adminIdToken';
  const GSI_SRC = 'https://accounts.google.com/gsi/client';
  const DEMO_EMAIL = 'demo@example.com';

  // ------------------------------------------------------------------ state
  const A = {
    open: false,
    demo: false,            // snapshot of isDemo() at boot; re-boot when it flips
    health: null,           // GET /api/health
    token: sessionStorage.getItem(SS_TOKEN) || '',
    claims: null,           // decoded JWT payload (display only)
    gsiClientId: null,
    data: null,             // GET /api/admin/settings
    sections: [],
    fields: [],             // every field {path, spec, inferred}
    drafts: {},             // path -> pending value (only changed fields)
    errors: {},             // path -> validation message
    activeTab: 'mode',
    wait: null,             // {since, t0, timer} while "agent restarting…"
    live: null,             // live-switch flow state
    confirm: null,          // generic confirm modal state
    openSecret: null,       // key whose inline editor is open
  };
  A.claims = A.token ? decodeJwt(A.token) : null;

  // Demo when no API is configured, or when the viewer poll has fallen back to mock data.
  const isDemo = () => !settings.configured || (state.demo && state.lastPoll > 0);

  // ------------------------------------------------------------------ small utils
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
  function setPath(obj, path, val) {
    const ks = path.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) { if (!isObj(o[ks[i]])) o[ks[i]] = {}; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = val;
    return obj;
  }
  function deepMerge(dst, src) {
    for (const k of Object.keys(src)) {
      if (isObj(src[k]) && isObj(dst[k])) deepMerge(dst[k], src[k]);
      else dst[k] = clone(src[k]);
    }
    return dst;
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function humanize(path) {
    const k = path.split('.').pop();
    return k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
  function fmtVal(v) {
    if (v === undefined) return '(unset)';
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'on' : 'off';
    if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 6 });
    if (typeof v === 'string') return v.length > 90 ? v.slice(0, 87) + '…' : v;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(', ') || '(empty)';
    if (Array.isArray(v) && v.every((x) => isObj(x) && 'model' in x)) return v.map((m) => `${m.model}${m.enabled === false ? ' (off)' : ''}`).join(' → ') || '(none)';
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  }
  function decodeJwt(tok) {
    try {
      const part = String(tok).split('.')[1];
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) { return null; }
  }
  function fakeJwt(payload) {
    const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return b64u(JSON.stringify({ alg: 'none', typ: 'JWT' })) + '.' + b64u(JSON.stringify(payload)) + '.demo';
  }
  function tokenValid() {
    if (!A.token || !A.claims) return false;
    if (A.claims.exp && A.claims.exp * 1000 < Date.now() + 5000) return false;
    if (A.claims.demo && !isDemo()) return false;   // fake demo session is worthless against a real server
    return true;
  }
  const signedIn = () => tokenValid();

  // ------------------------------------------------------------------ admin API client
  async function adminFetch(path, opts) {
    opts = opts || {};
    if (isDemo()) return mockAdmin(path, opts);
    if (!A.token) throw new ApiError(401, 'google sign-in required', path);
    const headers = Object.assign({ 'Authorization': 'Bearer ' + A.token, 'X-Admin': 'google' }, opts.headers || {});
    try {
      return await D.apiFetch(path, Object.assign({}, opts, { headers, rawErrors: true }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) signOut('Google rejected the session (401: ' + e.detail + '). Please sign in again.');
      throw e;
    }
  }
  function mockAdmin(path, opts) {
    const M = window.MockAPI && window.MockAPI.admin;
    if (!M) return Promise.reject(new ApiError(0, 'mock admin API unavailable (mock.js failed to load)', path));
    if (!A.token) return Promise.reject(new ApiError(401, 'google sign-in required', path));
    const body = opts.body ? JSON.parse(opts.body) : null;
    const method = opts.method || 'GET';
    let p;
    if (path === '/api/admin/settings' && method === 'GET') p = M.settings();
    else if (path === '/api/admin/settings' && method === 'PUT') p = M.putSettings(body);
    else if (path === '/api/admin/secrets') p = M.putSecrets(body);
    else if (path === '/api/admin/preflight') p = M.preflight();
    else if (path === '/api/admin/restart') p = M.restart();
    else if (path === '/api/admin/reset-journal') p = M.resetJournal(body);
    else p = Promise.reject({ status: 404, detail: 'not found' });
    return p.catch((e) => { throw new ApiError(e.status || 0, e.detail || e.message || String(e), path); });
  }
  function adminErrText(e) {
    if (!(e instanceof ApiError)) return describeErr(e);
    const hint = A.health && A.health.admin_email_hint;
    switch (e.status) {
      case 401: return 'Google sign-in required (401): ' + e.detail;
      case 403: return `Forbidden (403): ${e.detail}` + (hint ? ` — sign in with the account configured as ADMIN_EMAIL (${hint}).` : '');
      case 503: return 'Admin login is not configured on the server (503). Set GOOGLE_CLIENT_ID and ADMIN_EMAIL in .env and restart the API.';
      case 409: return 'Refused (409): ' + e.detail;
      case 422: return 'Validation error (422): ' + e.detail;
      default: return describeErr(e);
    }
  }

  // ------------------------------------------------------------------ routing
  function setOpen(open) {
    if (A.open === open) { if (open) boot(); return; }
    A.open = open;
    document.body.classList.toggle('admin-open', open);
    $id('admin-panel').hidden = !open;
    $id('admin-btn').classList.toggle('active', open);
    if (open) { window.scrollTo(0, 0); boot(); }
    updateSaveBar();
  }
  function onHash() { setOpen(location.hash === '#admin'); }
  window.addEventListener('hashchange', onHash);
  $id('admin-btn').addEventListener('click', () => { location.hash = A.open ? '' : '#admin'; });
  $id('admin-back').addEventListener('click', () => { location.hash = ''; });

  let booting = false;
  async function boot() {
    if (booting) return;
    booting = true;
    try {
      A.demo = isDemo();
      $id('admin-demo-tag').hidden = !A.demo;
      if (A.claims && A.claims.demo && !A.demo) clearToken();
      renderAuth();
      if (A.demo) {
        A.health = window.MockAPI ? window.MockAPI.health() : null;
      } else {
        try { A.health = await D.apiFetch('/api/health', { timeout: 8000, rawErrors: true }); }
        catch (e) { A.health = null; gateMsg('bad', 'Could not reach /api/health: ' + describeErr(e)); }
      }
      renderAuth();
      if (signedIn()) loadSettings(); else showGate();
    } finally { booting = false; }
  }

  // ------------------------------------------------------------------ auth UI
  function gateMsg(kind, msg) {
    const m = $id('admin-gate-msg');
    if (!msg) { m.hidden = true; m.textContent = ''; return; }
    m.hidden = false; m.className = 'test-result ' + kind; m.textContent = msg;
  }
  function showGate() {
    $id('admin-gate').hidden = false;
    $id('admin-body').hidden = true;
    updateSaveBar();
    const gsiEl = $id('gsi-button'), demoBtn = $id('admin-demo-signin'), hint = $id('admin-gate-hint');
    demoBtn.hidden = !A.demo;
    gsiEl.innerHTML = '';
    if (A.demo) {
      hint.textContent = 'Demo mode: no server configured. The fake sign-in acts as ' + DEMO_EMAIL + ' and every change only updates the in-browser mock.';
      return;
    }
    if (!A.health) { hint.textContent = 'Fix the API connection in settings (gear icon) first.'; return; }
    const cid = A.health.google_client_id;
    if (!cid) {
      gateMsg('bad', 'Admin login is not configured on the server: /api/health returned google_client_id = null.');
      hint.innerHTML = 'To enable it, add to the agent\'s <code>.env</code> and restart the API:' +
        '<pre>GOOGLE_CLIENT_ID=&lt;id&gt;.apps.googleusercontent.com\nADMIN_EMAIL=you@gmail.com</pre>' +
        'Create the OAuth client (type "Web application") in Google Cloud Console and add this page\'s origin (<code>' + esc(location.origin) + '</code>) to its authorised JavaScript origins.';
      return;
    }
    hint.innerHTML = 'Only <code>' + esc(A.health.admin_email_hint || 'the configured ADMIN_EMAIL') + '</code> is accepted. The Google ID token is kept in this tab\'s sessionStorage and sent only to <code>' + esc(settings.base) + '/api/admin/*</code>.';
    ensureGsi().then(() => renderGsiButton(cid)).catch((err) => {
      gateMsg('bad', 'Could not load Google Identity Services (' + (err && err.message || err) + '). Check ad-blockers / network and reload.');
    });
  }
  let gsiPromise = null;
  function ensureGsi() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
    if (gsiPromise) return gsiPromise;
    gsiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GSI_SRC; s.async = true; s.defer = true;
      s.onload = () => (window.google && window.google.accounts && window.google.accounts.id ? resolve() : reject(new Error('gsi did not initialise')));
      s.onerror = () => { gsiPromise = null; reject(new Error('script blocked or offline')); };
      document.head.appendChild(s);
    });
    return gsiPromise;
  }
  function renderGsiButton(cid) {
    const g = window.google.accounts.id;
    if (A.gsiClientId !== cid) {
      g.initialize({ client_id: cid, callback: onCredential, auto_select: false, cancel_on_tap_outside: true, ux_mode: 'popup', itp_support: true });
      A.gsiClientId = cid;
    }
    const target = $id('gsi-button');
    target.innerHTML = '';
    g.renderButton(target, { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'rectangular', logo_alignment: 'left', width: 280 });
  }
  function onCredential(resp) {
    if (!resp || !resp.credential) { gateMsg('bad', 'Google returned no credential. Try again.'); return; }
    const claims = decodeJwt(resp.credential);
    if (!claims) { gateMsg('bad', 'Received a token that could not be decoded.'); return; }
    setToken(resp.credential, claims);
    gateMsg('', '');
    loadSettings();
  }
  function setToken(tok, claims) {
    A.token = tok; A.claims = claims;
    try { sessionStorage.setItem(SS_TOKEN, tok); } catch (_) { /* private mode */ }
    renderAuth();
  }
  function clearToken() {
    A.token = ''; A.claims = null;
    try { sessionStorage.removeItem(SS_TOKEN); } catch (_) { /* ignore */ }
  }
  function signOut(msg) {
    const wasDemo = A.claims && A.claims.demo;
    clearToken();
    if (!wasDemo && window.google && window.google.accounts && window.google.accounts.id) { try { window.google.accounts.id.disableAutoSelect(); } catch (_) { /* ignore */ } }
    A.data = null; A.drafts = {}; A.errors = {}; A.fields = []; A.sections = [];
    stopWait();
    renderAuth();
    if (A.open) { showGate(); gateMsg(msg ? 'bad' : '', msg || ''); }
  }
  $id('admin-signout').addEventListener('click', () => signOut(''));
  $id('admin-demo-signin').addEventListener('click', () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { email: DEMO_EMAIL, name: 'Demo Admin', exp: now + 3600, iat: now, demo: true };
    setToken(fakeJwt(claims), claims);
    loadSettings();
  });
  function renderAuth() {
    const box = $id('admin-user');
    if (!signedIn()) { box.hidden = true; return; }
    box.hidden = false;
    const email = A.claims.email || '(no email claim)';
    $id('admin-email').textContent = email;
    $id('admin-avatar').textContent = (email[0] || '?').toUpperCase();
    const left = A.claims.exp ? A.claims.exp - Date.now() / 1000 : null;
    $id('admin-exp').textContent = left != null ? 'expires in ' + fmtAge(left) : '';
  }
  setInterval(() => {
    if (!A.token) return;
    if (!tokenValid()) { signOut('Your Google session expired (ID tokens last ~1 h). Sign in again to continue.'); return; }
    renderAuth();
  }, 30000);

  // ------------------------------------------------------------------ settings load
  async function loadSettings() {
    $id('admin-gate').hidden = true;
    $id('admin-body').hidden = false;
    $id('admin-loading').hidden = false;
    const errBox = $id('admin-error'); errBox.hidden = true;
    try {
      const d = await adminFetch('/api/admin/settings', { timeout: 15000 });
      A.data = d;
      A.drafts = {}; A.errors = {}; A.openSecret = null;
      renderSections();
      if (d.agent && d.agent.restart_pending) startWait('Agent restart pending');
    } catch (e) {
      if (e.status === 401) return;
      errBox.hidden = false; errBox.textContent = adminErrText(e);
      $id('admin-sections').innerHTML = ''; $id('admin-tabs').innerHTML = '';
    } finally { $id('admin-loading').hidden = true; updateSaveBar(); }
  }

  // ------------------------------------------------------------------ schema -> sections / groups
  const SECTION_DEFS = [
    { id: 'mode', title: 'Mode & Goal', desc: 'Which venue mode the agent trades in and the objective it is given. Touch this when starting a new paper run or when going live.', match: (p) => p === 'mode' || p === 'paper_starting_equity_usd' || p.startsWith('goal.'), custom: 'mode' },
    { id: 'models', title: 'Models', desc: 'Which AI models propose and verify trades, what happens when they fail, and how much they may cost per day. Change when switching providers or trimming cost.', match: (p) => p.startsWith('llm.') || p === 'loop_interval_seconds', custom: 'models' },
    { id: 'risk', title: 'Risk limits', desc: 'Hard rules the risk gate applies to every proposed trade. Tighten them before going live; loosen only deliberately — each change here is confirmed before it is saved.', match: (p) => p.startsWith('risk.') },
    { id: 'rr', title: 'Risk-reward & Learner', desc: 'How trades are sized and how past results feed back into sizing. Rarely needs changing once a run has started.', match: (p) => p.startsWith('rr.') || p.startsWith('learner.') },
    { id: 'universe', title: 'Universe', desc: 'What the agent is allowed to trade: perps, spot pairs and the prediction-market filter. Edit to add or remove markets.', match: (p) => p.startsWith('universe.') },
    { id: 'secrets', title: 'Secrets', desc: 'API keys and wallet credentials, stored server-side in data/secrets.env. Values are never shown here — only whether each one is set.', custom: 'secrets' },
    { id: 'maintenance', title: 'Maintenance', desc: 'Health checks and resets. Run preflight before going live; reset the journal only to start a fresh paper run.', custom: 'maintenance' },
    { id: 'other', title: 'Other', desc: 'Settings in the schema that do not belong to a dedicated section.', match: () => true },
  ];
  // Field grouping inside a tab: [regex, group title, one-line description]
  const GROUPS = [
    [/^risk\.(max_leverage|max_position_pct_equity|max_gross_exposure_pct|max_open_positions|min_order_usd)$/, 'Position sizing', 'How big any single trade, and the whole book, may get.'],
    [/^risk\.(max_daily_loss_pct|max_drawdown_pct|min_equity_usd)$/, 'Loss limits', 'Circuit breakers that pause or stop the agent when losses mount.'],
    [/^risk\.(require_stop_loss|max_stop_distance_pct)$/, 'Stops', 'Every position must carry a protective stop within this distance.'],
    [/^risk\.(min_seconds_between_orders|max_orders_per_hour)$/, 'Order pacing', 'Prevents over-trading and runaway loops.'],
    [/^risk\.prediction_market_/, 'Prediction markets', 'Caps on Polymarket exposure.'],
    [/^rr\./, 'Position sizing model', 'Reward-to-risk and Kelly rules applied to every proposal.'],
    [/^learner\./, 'Online learner', 'Scales size per setup category based on past results.'],
    [/^universe\.(perps|spot)$/, 'Perps & spot', 'Hyperliquid markets the model may trade.'],
    [/^universe\.prediction_markets\./, 'Prediction markets', 'Which Polymarket markets are shown to the model.'],
    [/^goal\./, 'Goal', 'What the model is told to achieve, and by when.'],
    [/^paper_starting_equity_usd$/, 'Paper account', 'Only used when the journal is reset in paper mode.'],
    [/^llm\.stance$|^loop_interval_seconds$/, 'Cadence & stance', 'How often the agent thinks and how eager it is to act.'],
    [/^llm\.(daily_cost_cap_usd|prices)$/, 'Cost controls', 'Daily spend cap and the per-model prices used to compute it.'],
    [/^notify\./, 'Notifications', ''],
  ];
  function groupFor(path) {
    for (const [re, title, desc] of GROUPS) if (re.test(path)) return { title, desc };
    const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
    return { title: parent ? humanize(parent) : 'General', desc: '' };
  }
  const RISK_NOTE = 'Affects how much the agent can lose — you confirm this before it is saved.';

  function inferSpec(v, key) {
    const label = humanize(key);
    if (typeof v === 'boolean') return { type: 'bool', label };
    if (typeof v === 'number') return { type: Number.isInteger(v) ? 'int' : 'float', label };
    if (typeof v === 'string') return { type: v.length > 80 || v.includes('\n') ? 'text' : 'str', label };
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === 'string')) return { type: 'list[str]', label };
      if (v.every((x) => isObj(x) && 'model' in x)) return { type: 'list[model]', label };
    }
    if (isObj(v)) return { type: 'map[str->list[float]]', label };
    return { type: 'str', label };
  }
  const looksLikeMap = (v) => isObj(v) && Object.keys(v).length > 0 && Object.values(v).every((x) => Array.isArray(x) && x.every((n) => typeof n === 'number'));

  function allFields() {
    const schema = (A.data && A.data.schema) || {};
    const list = Object.keys(schema).map((p) => ({ path: p, spec: schema[p] || {} }));
    const covered = Object.keys(schema);
    const isCovered = (p) => covered.includes(p) || covered.some((c) => p.startsWith(c + '.'));
    const walk = (obj, prefix) => {
      for (const k of Object.keys(obj)) {
        const p = prefix ? prefix + '.' + k : k;
        if (isCovered(p)) continue;
        const v = obj[k];
        if (isObj(v) && !looksLikeMap(v)) { walk(v, p); continue; }
        list.push({ path: p, spec: inferSpec(v, k), inferred: true });
      }
    };
    walk((A.data && A.data.config) || {}, '');
    return list;
  }
  const fieldByPath = (path) => A.fields.find((f) => f.path === path);

  function renderSections() {
    A.fields = allFields();
    A.sections = SECTION_DEFS.map((def) => Object.assign({ fields: [] }, def));
    for (const f of A.fields) {
      const sec = A.sections.find((s) => s.match && s.match(f.path));
      if (sec) { sec.fields.push(f); f.section = sec.id; }
    }
    A.sections = A.sections.filter((s) => s.custom === 'secrets' || s.custom === 'maintenance' || s.fields.length);
    if (!A.sections.some((s) => s.id === A.activeTab)) A.activeTab = A.sections[0].id;

    const host = $id('admin-sections');
    host.innerHTML = '';
    for (const sec of A.sections) {
      sec.el = el('section', 'asec');
      sec.el.dataset.section = sec.id;
      sec.el.hidden = sec.id !== A.activeTab;
      host.appendChild(sec.el);
      renderSection(sec);
    }
    renderTabs();
    updateSaveBar();
  }

  function renderTabs() {
    const tabs = $id('admin-tabs');
    tabs.innerHTML = '';
    for (const sec of A.sections) {
      const dirty = (sec.fields || []).filter((f) => f.path in A.drafts).length;
      const b = el('button', 'admin-tab' + (sec.id === A.activeTab ? ' active' : ''));
      b.type = 'button';
      b.innerHTML = `<span>${esc(sec.title)}</span>${dirty ? `<span class="dirty" title="${dirty} unsaved change${dirty > 1 ? 's' : ''}">${dirty}</span>` : ''}`;
      b.addEventListener('click', () => gotoTab(sec.id));
      tabs.appendChild(b);
    }
  }
  function gotoTab(id) {
    A.activeTab = id;
    A.sections.forEach((s) => { s.el.hidden = s.id !== id; });
    renderTabs();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------ one section
  function sectionHead(sec, extraHtml) {
    return el('div', 'asec-head', `${extraHtml || ''}<h3>${esc(sec.title)}</h3>${sec.desc ? `<p>${esc(sec.desc)}</p>` : ''}`);
  }
  function renderSection(sec) {
    const host = sec.el;
    host.innerHTML = '';
    host.appendChild(sectionHead(sec));
    if (sec.custom === 'secrets') return renderSecrets(sec, host);
    if (sec.custom === 'maintenance') return renderMaintenance(sec, host);
    if (sec.custom === 'mode') return renderModeSection(sec, host);
    if (sec.custom === 'models') return renderModelsSection(sec, host);
    renderGroups(host, sec.fields);
  }
  // Render fields grouped (in schema order of first appearance).
  function renderGroups(host, fields, opts) {
    const groups = new Map();
    for (const f of fields) {
      const g = groupFor(f.path);
      if (!groups.has(g.title)) groups.set(g.title, { desc: g.desc, fields: [] });
      groups.get(g.title).fields.push(f);
    }
    for (const [title, g] of groups) host.appendChild(groupEl(title, g.desc, g.fields, opts));
  }
  function groupEl(title, desc, fields, opts) {
    const g = el('div', 'fgroup');
    if (title) g.appendChild(el('div', 'fgroup-head', `<h4>${esc(title)}</h4>${desc ? `<span class="gdesc">${esc(desc)}</span>` : ''}`));
    if (opts && opts.context) g.appendChild(el('div', 'fgroup-ctx', opts.context));
    const rows = el('div', 'frows');
    fields.forEach((f) => rows.appendChild(fieldRow(f, opts)));
    g.appendChild(rows);
    return g;
  }

  // ------------------------------------------------------------------ fields
  const WIDE_TYPES = ['text', 'list[str]', 'list[model]', 'map[str->list[float]]'];
  function fieldRow(f, opts) {
    const spec = f.spec || {}, path = f.path;
    const cur = getPath(A.data.config, path);
    const val = path in A.drafts ? A.drafts[path] : cur;
    const stack = (opts && opts.stack) || WIDE_TYPES.includes(spec.type);
    const row = el('div', 'frow' + (stack ? ' stack' : ''));
    row.dataset.path = path;
    const label = el('div', 'flabel');
    label.innerHTML = `<div class="fname"><span>${esc(spec.label || humanize(path))}</span>${spec.danger ? '<span class="risk-pill" title="Changes risk exposure">risk</span>' : ''}${f.inferred ? '<span class="inferred-pill" title="No schema entry; type inferred from the value">inferred</span>' : ''}</div>` +
      (spec.help ? `<div class="fhelp">${esc(spec.help)}</div>` : '') + `<div class="fpath">${esc(path)}</div>`;
    row.appendChild(label);
    const ctl = el('div', 'fctl');
    ctl.appendChild(control(f, val, (nv) => setDraft(f, nv, row)));
    const meta = el('div', 'fmeta');
    if ((spec.type === 'int' || spec.type === 'float') && (spec.min != null || spec.max != null)) meta.appendChild(el('span', 'range', `allowed ${spec.min != null ? spec.min : '−∞'} to ${spec.max != null ? spec.max : '∞'}`));
    meta.appendChild(el('span', 'saved'));
    meta.appendChild(el('span', 'ferr'));
    ctl.appendChild(meta);
    if (spec.danger) ctl.appendChild(el('div', 'frisk', RISK_NOTE));
    row.appendChild(ctl);
    refreshRow(f, row);
    return row;
  }
  function refreshRow(f, row) {
    const cur = getPath(A.data.config, f.path);
    const changed = f.path in A.drafts;
    row.classList.toggle('changed', changed);
    row.classList.toggle('invalid', !!A.errors[f.path]);
    const saved = row.querySelector('.saved');
    saved.innerHTML = changed ? `saved value: <b>${esc(fmtVal(cur))}</b><button type="button" class="link-btn" data-act="revert">reset to saved</button>` : '';
    const rb = saved.querySelector('[data-act="revert"]');
    if (rb) rb.addEventListener('click', () => { delete A.drafts[f.path]; delete A.errors[f.path]; rerenderRow(f, row); afterDraftChange(); });
    row.querySelector('.ferr').textContent = A.errors[f.path] || '';
  }
  function rerenderRow(f, row) {
    const fresh = fieldRow(f, { stack: row.classList.contains('stack') });
    row.replaceWith(fresh);
  }
  function setDraft(f, nv, row) {
    const cur = getPath(A.data.config, f.path);
    const err = validateValue(f.spec, nv);
    if (err) A.errors[f.path] = err; else delete A.errors[f.path];
    if (!err && deepEq(nv, cur)) delete A.drafts[f.path]; else A.drafts[f.path] = nv;
    if (row) refreshRow(f, row);
    afterDraftChange();
  }
  function afterDraftChange() {
    renderTabs();
    updateSaveBar();
    hideResult();
  }
  function validateValue(spec, v) {
    spec = spec || {};
    switch (spec.type) {
      case 'int':
        if (typeof v !== 'number' || isNaN(v)) return 'enter a number';
        if (!Number.isInteger(v)) return 'must be a whole number';
        break;
      case 'float':
        if (typeof v !== 'number' || isNaN(v)) return 'enter a number';
        break;
      case 'enum':
        if (spec.options && !spec.options.includes(v)) return 'must be one of: ' + spec.options.join(', ');
        break;
      case 'list[str]':
        if (!Array.isArray(v)) return 'must be a list';
        break;
      case 'list[model]':
        if (!Array.isArray(v)) return 'must be a list';
        if (v.some((m) => !m.provider || !m.model)) return 'every entry needs a provider and a model';
        break;
      case 'map[str->list[float]]':
        if (!isObj(v)) return 'must be a mapping';
        for (const [k, arr] of Object.entries(v)) {
          if (!k.trim()) return 'empty key';
          if (!Array.isArray(arr) || !arr.length || arr.some((x) => typeof x !== 'number' || isNaN(x))) return `"${k}": values must be numbers (comma-separated)`;
        }
        break;
    }
    if ((spec.type === 'int' || spec.type === 'float') && typeof v === 'number') {
      if (spec.min != null && v < spec.min) return `minimum is ${spec.min}`;
      if (spec.max != null && v > spec.max) return `maximum is ${spec.max}`;
    }
    return '';
  }

  function control(f, val, onChange) {
    const spec = f.spec || {};
    switch (spec.type) {
      case 'int':
      case 'float': {
        const i = el('input');
        i.type = 'number'; i.inputMode = 'decimal';
        i.step = spec.type === 'int' ? '1' : 'any';
        if (spec.min != null) i.min = spec.min;
        if (spec.max != null) i.max = spec.max;
        i.value = val == null ? '' : String(val);
        i.addEventListener('input', () => onChange(i.value.trim() === '' ? NaN : Number(i.value)));
        return i;
      }
      case 'bool': {
        const lab = el('label', 'toggle');
        const i = el('input'); i.type = 'checkbox'; i.checked = !!val;
        const track = el('span', 'track');
        const txt = el('span', 'toggle-text', i.checked ? 'On' : 'Off');
        i.addEventListener('change', () => { txt.textContent = i.checked ? 'On' : 'Off'; onChange(i.checked); });
        lab.append(i, track, txt);
        return lab;
      }
      case 'enum': {
        const s = el('select');
        const opts = (spec.options || []).slice();
        if (val != null && !opts.includes(val)) opts.unshift(val);
        opts.forEach((o) => { const op = el('option'); op.value = o; op.textContent = o; s.appendChild(op); });
        s.value = val == null ? '' : String(val);
        s.addEventListener('change', () => onChange(s.value));
        return s;
      }
      case 'text': {
        const t = el('textarea');
        t.value = val == null ? '' : String(val);
        t.addEventListener('input', () => onChange(t.value));
        return t;
      }
      case 'list[str]': return chipsEditor(val, onChange);
      case 'list[model]': return fallbackList(val, onChange, spec);
      case 'map[str->list[float]]': return mapTable(val, onChange);
      default: {
        const i = el('input'); i.type = 'text'; i.value = val == null ? '' : String(val);
        i.addEventListener('input', () => onChange(i.value));
        return i;
      }
    }
  }

  function chipsEditor(val, onChange) {
    let items = Array.isArray(val) ? val.slice() : [];
    const box = el('div', 'chips-edit');
    const input = el('input'); input.type = 'text'; input.placeholder = items.length ? 'add another (Enter or comma)' : 'type a value, press Enter';
    input.spellcheck = false; input.autocapitalize = 'characters';
    const draw = () => {
      box.querySelectorAll('.chip').forEach((c) => c.remove());
      items.forEach((it, idx) => {
        const c = el('span', 'chip', `<span>${esc(it)}</span>`);
        const x = el('button', '', '&times;'); x.type = 'button'; x.title = 'remove';
        x.addEventListener('click', (e) => { e.stopPropagation(); items.splice(idx, 1); draw(); onChange(items.slice()); });
        c.appendChild(x);
        box.insertBefore(c, input);
      });
    };
    const commit = () => {
      const parts = input.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return;
      parts.forEach((p) => { if (!items.includes(p)) items.push(p); });
      input.value = '';
      draw(); onChange(items.slice());
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
      else if (e.key === 'Backspace' && !input.value && items.length) { items.pop(); draw(); onChange(items.slice()); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('paste', () => setTimeout(commit, 0));
    box.addEventListener('click', () => input.focus());
    box.appendChild(input);
    draw();
    return box;
  }

  function optionsFromSchema(suffix) {
    const schema = (A.data && A.data.schema) || {};
    const set = new Set();
    Object.keys(schema).forEach((p) => { if (p.endsWith(suffix) && Array.isArray(schema[p].options)) schema[p].options.forEach((o) => set.add(o)); });
    return [...set];
  }
  let dlCounter = 0;
  function datalist(options) {
    if (!options.length) return null;
    const dl = el('datalist'); dl.id = 'dl-' + (++dlCounter);
    options.forEach((o) => { const op = el('option'); op.value = o; dl.appendChild(op); });
    return dl;
  }

  // Ordered fallback chain: provider · model · enabled · move up/down · remove.
  function fallbackList(val, onChange, spec) {
    const rows = Array.isArray(val) ? clone(val) : [];
    const providers = (spec.providers || spec.provider_options || optionsFromSchema('.provider')).concat(rows.map((r) => r.provider)).filter((x, i, a) => x && a.indexOf(x) === i);
    const models = (spec.models || spec.model_options || optionsFromSchema('.model')).concat(rows.map((r) => r.model)).filter((x, i, a) => x && a.indexOf(x) === i);
    const wrap = el('div');
    const dlP = datalist(providers), dlM = datalist(models);
    if (dlP) wrap.appendChild(dlP);
    if (dlM) wrap.appendChild(dlM);
    const list = el('ol', 'fb-list');
    const emit = () => onChange(clone(rows));
    const draw = () => {
      list.innerHTML = '';
      rows.forEach((r, idx) => {
        const li = el('li', 'fb-item' + (r.enabled === false ? ' off' : ''));
        li.appendChild(el('span', 'fb-idx', String(idx + 1)));
        const ip = el('input'); ip.type = 'text'; ip.value = r.provider || ''; ip.placeholder = 'provider'; ip.className = 'fb-prov'; if (dlP) ip.setAttribute('list', dlP.id);
        ip.addEventListener('input', () => { r.provider = ip.value.trim(); emit(); }); li.appendChild(ip);
        const im = el('input'); im.type = 'text'; im.value = r.model || ''; im.placeholder = 'model id'; im.className = 'fb-model mono'; if (dlM) im.setAttribute('list', dlM.id);
        im.addEventListener('input', () => { r.model = im.value.trim(); emit(); }); li.appendChild(im);
        const lab = el('label', 'toggle'); lab.title = 'enabled'; const ie = el('input'); ie.type = 'checkbox'; ie.checked = r.enabled !== false;
        ie.addEventListener('change', () => { r.enabled = ie.checked; li.classList.toggle('off', !ie.checked); emit(); });
        lab.append(ie, el('span', 'track')); li.appendChild(lab);
        const btns = el('div', 'fb-btns');
        const up = el('button', 'row-btn', '&uarr;'); up.type = 'button'; up.title = 'move up'; up.disabled = idx === 0;
        up.addEventListener('click', () => { [rows[idx - 1], rows[idx]] = [rows[idx], rows[idx - 1]]; draw(); emit(); });
        const dn = el('button', 'row-btn', '&darr;'); dn.type = 'button'; dn.title = 'move down'; dn.disabled = idx === rows.length - 1;
        dn.addEventListener('click', () => { [rows[idx + 1], rows[idx]] = [rows[idx], rows[idx + 1]]; draw(); emit(); });
        const del = el('button', 'row-btn del', '&times;'); del.type = 'button'; del.title = 'remove';
        del.addEventListener('click', () => { rows.splice(idx, 1); draw(); emit(); });
        btns.append(up, dn, del); li.appendChild(btns);
        list.appendChild(li);
      });
      if (!rows.length) list.appendChild(el('li', 'fb-empty', 'No fallbacks: if the proposer fails, the cycle is skipped.'));
    };
    draw();
    wrap.appendChild(list);
    const add = el('button', 'btn btn-ghost add-row', '+ Add fallback'); add.type = 'button';
    add.addEventListener('click', () => { rows.push({ provider: providers[0] || '', model: '', enabled: true }); draw(); emit(); list.querySelector('.fb-item:last-child .fb-model')?.focus(); });
    wrap.appendChild(add);
    return wrap;
  }

  function mapTable(val, onChange) {
    const rows = isObj(val) ? Object.keys(val).map((k) => ({ key: k, vals: (val[k] || []).map(String).join(', ') })) : [];
    const wrap = el('div', 'etbl-wrap');
    const tbl = el('table', 'etbl');
    tbl.innerHTML = '<thead><tr><th>Model</th><th>$ per 1M tokens: input, output</th><th></th></tr></thead><tbody></tbody>';
    const emit = () => {
      const out = {};
      rows.forEach((r) => { out[r.key] = r.vals.split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number); });
      onChange(out);
    };
    const draw = () => {
      const tb = tbl.querySelector('tbody'); tb.innerHTML = '';
      rows.forEach((r, idx) => {
        const tr = el('tr');
        const tdK = el('td', 'grow'); const ik = el('input'); ik.type = 'text'; ik.className = 'mono'; ik.value = r.key; ik.placeholder = 'model id';
        ik.addEventListener('input', () => { r.key = ik.value.trim(); emit(); }); tdK.appendChild(ik); tr.appendChild(tdK);
        const tdV = el('td', 'grow'); const iv = el('input'); iv.type = 'text'; iv.value = r.vals; iv.placeholder = 'e.g. 0.15, 0.60'; iv.inputMode = 'decimal';
        iv.addEventListener('input', () => { r.vals = iv.value; emit(); }); tdV.appendChild(iv); tr.appendChild(tdV);
        const tdX = el('td'); const bx = el('button', 'row-btn del', '&times;'); bx.type = 'button'; bx.title = 'remove';
        bx.addEventListener('click', () => { rows.splice(idx, 1); draw(); emit(); }); tdX.appendChild(bx); tr.appendChild(tdX);
        tb.appendChild(tr);
      });
    };
    draw();
    wrap.appendChild(tbl);
    const add = el('button', 'btn btn-ghost add-row', '+ Add model price'); add.type = 'button';
    add.addEventListener('click', () => { rows.push({ key: '', vals: '' }); draw(); emit(); });
    wrap.appendChild(add);
    return wrap;
  }

  // ------------------------------------------------------------------ Mode & Goal (mode cards)
  const MODE_INFO = {
    paper: { title: 'Paper', desc: 'Simulated fills at live prices. Nothing is sent to an exchange, so it is safe to experiment.', req: 'Requires only an LLM API key.' },
    testnet: { title: 'Testnet', desc: 'Real order flow against the Hyperliquid testnet using test funds. Good for checking wallet permissions and execution.', req: 'Requires testnet wallet keys.' },
    live: { title: 'Live', desc: 'Real money on Hyperliquid and Polymarket. Every fill is a real order.', req: 'Requires wallet keys, LIVE_TRADING_ACK, a passing preflight and a typed confirmation.' },
  };
  function renderModeSection(sec, host) {
    const modeField = sec.fields.find((f) => f.path === 'mode');
    if (modeField) {
      const spec = modeField.spec || {};
      const cur = getPath(A.data.config, 'mode');
      const sel = 'mode' in A.drafts ? A.drafts.mode : cur;
      const g = el('div', 'fgroup');
      g.appendChild(el('div', 'fgroup-head', `<h4>${esc(spec.label || 'Mode')}</h4><span class="gdesc">Currently saved: <b>${esc(String(cur || '').toUpperCase())}</b>${spec.help ? ' · ' + esc(spec.help) : ''}</span>`));
      const cards = el('div', 'mode-cards');
      cards.dataset.path = 'mode';
      const opts = (spec.options || ['paper', 'testnet', 'live']).slice();
      if (cur && !opts.includes(cur)) opts.unshift(cur);
      opts.forEach((m) => {
        const info = MODE_INFO[m] || { title: humanize(m), desc: '', req: '' };
        const c = el('button', `mode-card ${esc(m)}` + (m === sel ? ' selected' : ''));
        c.type = 'button'; c.dataset.mode = m;
        c.innerHTML = `<span class="mc-state">${m === sel ? (m === cur ? 'current' : 'selected') : (m === cur ? 'saved' : '')}</span><span class="mc-title">${esc(info.title)}</span><span class="mc-desc">${esc(info.desc)}</span><span class="mc-req">${esc(info.req)}</span>`;
        c.addEventListener('click', () => { setDraft(modeField, m, null); renderSection(sec); });
        cards.appendChild(c);
      });
      g.appendChild(cards);
      if (sel !== cur) {
        g.appendChild(el('div', 'mode-note' + (sel === 'live' ? ' live' : ''), sel === 'live'
          ? `Switching to <b>LIVE</b> is a guarded, four-step flow: secrets present → preflight passes → type the acknowledgement phrase → confirm. Click <b>Save</b> below to start it. <button type="button" class="link-btn" data-act="revert-mode">Keep ${esc(String(cur).toUpperCase())}</button>`
          : `Mode will change from <b>${esc(String(cur).toUpperCase())}</b> to <b>${esc(String(sel).toUpperCase())}</b> when you save. The agent restarts; positions are untouched. <button type="button" class="link-btn" data-act="revert-mode">Keep ${esc(String(cur).toUpperCase())}</button>`));
        g.querySelector('[data-act="revert-mode"]').addEventListener('click', () => { delete A.drafts.mode; delete A.errors.mode; afterDraftChange(); renderSection(sec); });
      }
      host.appendChild(g);
    }
    renderGroups(host, sec.fields.filter((f) => f.path !== 'mode'));
  }

  // ------------------------------------------------------------------ Models (role cards + fallback chain + cost)
  const ROLE_INFO = {
    proposer: ['Proposer', 'Reads the market snapshot, the learner\'s lessons and the mandate every cycle, and proposes the actions. This is the model that decides.'],
    verifier: ['Verifier', 'A second model that reviews every non-hold proposal for consistency and risk before the risk gate. Costs a little extra per trade; catches sloppy reasoning.'],
  };
  function renderModelsSection(sec, host) {
    const byPrefix = (pre) => sec.fields.filter((f) => f.path.startsWith(pre));
    const proposer = byPrefix('llm.proposer.'), verifier = byPrefix('llm.verifier.');
    const used = new Set([...proposer, ...verifier].map((f) => f.path));
    if (proposer.length || verifier.length) {
      const cards = el('div', 'role-cards');
      [['proposer', proposer], ['verifier', verifier]].forEach(([role, fs]) => {
        if (!fs.length) return;
        const [title, desc] = ROLE_INFO[role];
        const card = el('div', 'role-card');
        card.dataset.role = role;
        card.innerHTML = `<h4>${title}</h4><div class="role-desc">${esc(desc)}</div>`;
        const rows = el('div', 'frows');
        fs.forEach((f) => rows.appendChild(fieldRow(f, { stack: true })));
        card.appendChild(rows);
        cards.appendChild(card);
      });
      host.appendChild(cards);
    }
    const fb = sec.fields.find((f) => f.path === 'llm.fallbacks');
    if (fb) { used.add(fb.path); host.appendChild(groupEl('Fallback chain', 'Tried in this order when the proposer errors or is rate-limited. Disabled entries are skipped.', [fb])); }
    const rest = sec.fields.filter((f) => !used.has(f.path));
    // cost controls get today's spend for context
    const st = state.status || {};
    const spent = st.tokens_today && st.tokens_today.cost_usd;
    const cap = getPath(A.data.config, 'llm.daily_cost_cap_usd');
    const ctx = spent != null ? `Spent today so far: <b>${esc(fmtCost(spent))}</b>${cap ? ` of the ${esc(fmtCost(cap))} cap` : ''}${st.tokens_total && st.tokens_total.cost_usd != null ? ` · ${esc(fmtCost(st.tokens_total.cost_usd))} total` : ''} <span class="muted">(live from /api/status)</span>` : null;
    const groups = new Map();
    for (const f of rest) { const g = groupFor(f.path); if (!groups.has(g.title)) groups.set(g.title, { desc: g.desc, fields: [] }); groups.get(g.title).fields.push(f); }
    for (const [title, g] of groups) host.appendChild(groupEl(title, g.desc, g.fields, title === 'Cost controls' && ctx ? { context: ctx } : undefined));
  }

  // ------------------------------------------------------------------ save flow (global sticky bar)
  function allChanges() {
    return A.fields.filter((f) => f.path in A.drafts).map((f) => ({ path: f.path, spec: f.spec || {}, from: getPath(A.data.config, f.path), to: A.drafts[f.path], section: f.section }));
  }
  function updateSaveBar() {
    const bar = $id('admin-savebar');
    const visible = A.open && signedIn() && !!A.data;
    const changes = visible ? allChanges() : [];
    if (!changes.length) { bar.hidden = true; return; }
    bar.hidden = false;
    const errs = changes.filter((c) => A.errors[c.path]);
    const secs = [...new Set(changes.map((c) => (A.sections.find((s) => s.id === c.section) || {}).title).filter(Boolean))];
    const txt = $id('savebar-text');
    txt.className = 'savebar-text' + (errs.length ? ' bad' : '');
    txt.innerHTML = errs.length
      ? `${errs.length} invalid field${errs.length > 1 ? 's' : ''}<span class="sub">fix them before saving</span>`
      : `${changes.length} unsaved change${changes.length > 1 ? 's' : ''}<span class="sub">in ${esc(secs.join(', '))} · only changed fields are sent</span>`;
    const save = $id('savebar-save');
    save.disabled = errs.length > 0;
    const live = changes.some((c) => c.path === 'mode' && String(c.to).toLowerCase() === 'live');
    save.textContent = live ? 'Continue to live switch…' : changes.some((c) => c.spec.danger) ? 'Review & save' : 'Save';
    save.className = 'btn ' + (live ? 'btn-danger' : 'btn-primary');
  }
  $id('savebar-discard').addEventListener('click', () => {
    A.drafts = {}; A.errors = {};
    A.sections.forEach((s) => renderSection(s));
    afterDraftChange();
  });
  $id('savebar-save').addEventListener('click', () => saveAll());

  function changesHtml(changes) {
    return changes.map((c) => `<div class="chg ${c.spec.danger || c.path === 'mode' ? 'danger' : ''}"><span class="cpath" title="${esc(c.path)}">${esc(c.spec.label || c.path)}</span><span class="cval"><span class="old">${esc(fmtVal(c.from))}</span>${esc(fmtVal(c.to))}</span></div>`).join('');
  }
  async function saveAll() {
    const changes = allChanges();
    if (!changes.length) return;
    if (changes.some((c) => A.errors[c.path])) { showResult('bad', 'Fix the invalid fields first.'); return; }
    const goingLive = changes.find((c) => c.path === 'mode' && String(c.to).toLowerCase() === 'live');
    if (goingLive) {
      // Preflight runs against the *saved* config, so any other pending change is saved first (with its own
      // confirmation if risky); the live stepper then carries only the mode switch.
      const others = changes.filter((c) => c !== goingLive);
      if (!others.length) return openLiveFlow([goingLive]);
      const then = () => { if (A.drafts.mode) openLiveFlow([Object.assign({}, goingLive, { from: getPath(A.data.config, 'mode') })]); };
      if (others.some((c) => c.spec.danger)) {
        return confirmDialog({
          title: 'Save other changes before the live switch',
          danger: true,
          body: `<p>${others.length} other change${others.length > 1 ? 's' : ''} will be saved first so the preflight checks the real configuration. Risk-affecting ones are in red. The live switch itself follows in a separate, guarded step.</p><div class="changes">${changesHtml(others)}</div>`,
          confirmText: 'Save & continue',
          run: () => putConfigRaw(others, undefined, { keepMode: true }),
        }).then(then);
      }
      await putConfig(others, undefined, { keepMode: true });
      return then();
    }
    const dangerous = changes.filter((c) => c.spec.danger);
    if (dangerous.length) {
      return confirmDialog({
        title: 'Review risk-affecting changes',
        danger: true,
        body: `<p>${dangerous.length} of ${changes.length} change${changes.length > 1 ? 's' : ''} affect${dangerous.length > 1 ? '' : 's'} how much the agent can lose (in red). The agent restarts and applies them on its next cycle; open positions and their stops are untouched.</p><div class="changes">${changesHtml(changes)}</div>`,
        confirmText: 'Save & restart agent',
        run: () => putConfigRaw(changes),
      });
    }
    return putConfig(changes);
  }
  async function putConfig(changes, extra, o) {
    try { return await putConfigRaw(changes, extra, o); }
    catch (e) { showResult('bad', esc(adminErrText(e))); throw e; }
  }
  async function putConfigRaw(changes, extra, o) {
    const partial = {};
    changes.forEach((c) => setPath(partial, c.path, c.to));
    const body = Object.assign({ config: partial }, extra || {});
    $id('savebar-save').disabled = true; $id('savebar-save').textContent = 'Saving…';
    let res;
    try {
      res = await adminFetch('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body), timeout: 20000 });
    } finally { updateSaveBar(); }
    A.data.config = res && res.config ? res.config : deepMerge(A.data.config, partial);
    changes.forEach((c) => { delete A.drafts[c.path]; delete A.errors[c.path]; });
    renderSections();
    const applied = changes.map((c) => `<div class="chg ${c.spec.danger ? 'danger' : ''}"><span class="cpath">${esc(c.spec.label || c.path)}</span><span class="cval">${esc(fmtVal(getPath(A.data.config, c.path)))}</span></div>`).join('');
    showResult('ok', `<strong>Saved ${changes.length} change${changes.length > 1 ? 's' : ''}.</strong> Values as validated by the server:<div class="changes">${applied}</div>${o && o.keepMode ? '<p style="margin:8px 0 0">The mode switch is still pending — continue in the live dialog.</p>' : ''}`);
    if (!res || res.restart !== false) startWait('Settings saved');
    state.config = null;
    D.loadAll(false);
    return res;
  }
  function showResult(kind, html) {
    const r = $id('admin-result');
    r.hidden = false; r.className = 'result-card ' + kind;
    r.innerHTML = `<button type="button" class="link-btn" aria-label="Dismiss">&times;</button>${html}`;
    r.querySelector('.link-btn').addEventListener('click', hideResult);
  }
  function hideResult() { $id('admin-result').hidden = true; }

  // ------------------------------------------------------------------ "agent restarting…" notice
  function notice(kind, text) {
    const n = $id('admin-notice');
    n.hidden = false;
    n.className = 'admin-notice' + (kind === 'ok' ? ' ok' : kind === 'warn' ? ' warn' : '');
    $id('admin-notice-text').textContent = text;
  }
  function hideNotice() { $id('admin-notice').hidden = true; }
  $id('admin-notice-close').addEventListener('click', () => { hideNotice(); stopWait(); });
  function startWait(prefix) {
    const st = state.status;
    stopWait();
    A.wait = { since: (st && st.last_cycle_ts) || 0, t0: Date.now(), prefix };
    tickWait();
    A.wait.timer = setInterval(() => { D.loadAll(false); }, A.demo ? 3000 : 10000);
  }
  function stopWait() { if (A.wait && A.wait.timer) clearInterval(A.wait.timer); A.wait = null; }
  function tickWait() {
    if (!A.wait) return;
    const st = state.status;
    const loop = (state.config && state.config.loop_interval_seconds) || (A.data && A.data.config && A.data.config.loop_interval_seconds) || 300;
    const elapsed = (Date.now() - A.wait.t0) / 1000;
    if (st && st.last_cycle_ts > A.wait.since) {
      notice('ok', `Agent is back: new cycle #${st.cycles_total != null ? st.cycles_total : '?'} at ${fmtClock(st.last_cycle_ts)} (mode ${String(st.mode).toUpperCase()}).`);
      stopWait();
      setTimeout(() => { if (!A.wait) hideNotice(); }, 10000);
      refreshAgentLine();
      return;
    }
    if (elapsed > Math.max(loop * 2, 180)) notice('warn', `${A.wait.prefix} — agent restarting… no new cycle after ${fmtAge(elapsed)} (loop is ${fmtAge(loop)}). Check the agent logs.`);
    else notice('wait', `${A.wait.prefix} — agent restarting… waiting for the next cycle (${fmtAge(elapsed)} elapsed, loop ${fmtAge(loop)}).`);
  }
  setInterval(tickWait, 5000);
  D.onStatus(() => {
    if (!A.open) return;
    if (isDemo() !== A.demo) { boot(); return; }
    tickWait();
    refreshAgentLine();
  });

  // ------------------------------------------------------------------ generic confirm modal
  function confirmDialog(o) {
    A.confirm = o;
    $id('confirm-title').textContent = o.title || 'Confirm';
    $id('confirm-body').innerHTML = o.body || '';
    const card = $id('confirm-card');
    card.classList.toggle('modal-danger', !!o.danger);
    const pf = $id('confirm-phrase-field');
    pf.hidden = !o.phrase;
    $id('confirm-phrase-word').textContent = o.phrase || '';
    $id('in-confirm-phrase').value = '';
    const r = $id('confirm-result'); r.hidden = true; r.textContent = '';
    const ok = $id('confirm-ok-btn');
    ok.textContent = o.confirmText || 'Confirm';
    ok.className = 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary');
    ok.disabled = !!o.phrase;
    D.openModal('confirm-modal');
    return new Promise((resolve) => { A.confirm.resolve = resolve; });
  }
  $id('in-confirm-phrase').addEventListener('input', (e) => {
    if (A.confirm && A.confirm.phrase) $id('confirm-ok-btn').disabled = e.target.value.trim() !== A.confirm.phrase;
  });
  $id('in-confirm-phrase').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$id('confirm-ok-btn').disabled) { e.preventDefault(); $id('confirm-ok-btn').click(); } });
  $id('confirm-ok-btn').addEventListener('click', async () => {
    const o = A.confirm;
    if (!o) return;
    const ok = $id('confirm-ok-btn'), r = $id('confirm-result');
    ok.disabled = true; const label = ok.textContent; ok.textContent = 'Working…';
    r.hidden = false; r.className = 'test-result info'; r.textContent = 'Sending…';
    try {
      const res = await o.run();
      r.className = 'test-result ok'; r.textContent = o.successText || 'Done.';
      setTimeout(() => { D.closeModal('confirm-modal'); }, 700);
      o.resolve && o.resolve(res);
    } catch (e) {
      r.className = 'test-result bad'; r.textContent = adminErrText(e);
      ok.disabled = false; ok.textContent = label;
      if (o.onError) o.onError(e);
    }
  });

  // ------------------------------------------------------------------ LIVE switch flow
  function stepState(n, st, text) {
    const li = $id('live-step-' + n);
    li.dataset.state = st;
    li.querySelector('.step-state').textContent = text || { pass: 'OK', fail: 'MISSING', running: 'RUNNING…', pending: '' }[st] || '';
  }
  function liveRequired() {
    const s = (A.data && A.data.secrets) || {};
    const isSet = (k) => s[k] === true || (typeof s[k] === 'string' && s[k].trim() !== '');
    return [
      { key: 'LIVE_TRADING_ACK', ok: isSet('LIVE_TRADING_ACK'), note: 'must equal the phrase below (server checks the exact value)' },
      { key: 'HL_API_WALLET_PRIVATE_KEY', ok: isSet('HL_API_WALLET_PRIVATE_KEY'), note: 'Hyperliquid API wallet key' },
      { key: 'HL_ACCOUNT_ADDRESS', ok: isSet('HL_ACCOUNT_ADDRESS'), note: 'main account address the API wallet trades for' },
    ];
  }
  async function openLiveFlow(changes) {
    A.live = { changes, preflightOk: false, phraseOk: false, secretsOk: false };
    const phrase = (A.data && A.data.live_ack_phrase) || '';
    $id('live-phrase').textContent = phrase || '(server did not return live_ack_phrase)';
    $id('in-live-phrase').value = '';
    $id('live-preflight').innerHTML = '';
    $id('live-preflight-btn').textContent = 'Run preflight';
    $id('live-changes').innerHTML = changesHtml(changes.map((c) => Object.assign({}, c, { spec: Object.assign({}, c.spec, { danger: true }) })));
    const r = $id('live-result'); r.hidden = true; r.textContent = '';
    const go = $id('live-go-btn'); go.disabled = true; go.textContent = 'Switch to LIVE';
    [1, 2, 3, 4].forEach((n) => stepState(n, 'pending'));
    stepState(4, 'pending', 'LOCKED');
    $id('live-secrets').innerHTML = '<span class="muted">checking secrets…</span>';
    D.openModal('live-modal');
    try {
      const d = await adminFetch('/api/admin/settings', { timeout: 15000 });
      A.data.secrets = d.secrets; A.data.live_ack_phrase = d.live_ack_phrase || A.data.live_ack_phrase;
      $id('live-phrase').textContent = A.data.live_ack_phrase || '';
    } catch (e) { r.hidden = false; r.className = 'test-result bad'; r.textContent = 'Could not refresh secrets: ' + adminErrText(e); }
    renderLiveSecrets();
    updateLiveGo();
  }
  function renderLiveSecrets() {
    const req = liveRequired();
    A.live.secretsOk = req.every((x) => x.ok);
    $id('live-secrets').innerHTML = '<div class="req-list">' + req.map((x) => `<div class="req ${x.ok ? 'ok' : 'no'}"><span class="ck">${x.ok ? '✓' : '✗'}</span><span>${esc(x.key)}</span><span class="muted">${esc(x.note)}</span>${x.ok ? '' : '<button type="button" class="link-btn" data-goto="secrets">set it in Secrets</button>'}</div>`).join('') + '</div>' +
      (A.live.secretsOk ? '' : '<div class="muted small" style="margin-top:6px">Set the missing secrets, then click Save again to reopen this dialog.</div>');
    $id('live-secrets').querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { D.closeModal('live-modal'); gotoTab('secrets'); }));
    stepState(1, A.live.secretsOk ? 'pass' : 'fail');
  }
  function updateLiveGo() {
    if (!A.live) return;
    const ready = A.live.secretsOk && A.live.preflightOk && A.live.phraseOk;
    stepState(4, ready ? 'pass' : 'pending', ready ? 'READY' : 'LOCKED');
    $id('live-go-btn').disabled = !ready;
  }
  $id('live-preflight-btn').addEventListener('click', async () => {
    const btn = $id('live-preflight-btn');
    btn.disabled = true; btn.textContent = 'Running preflight…';
    stepState(2, 'running');
    try {
      const res = await adminFetch('/api/admin/preflight', { method: 'POST', body: '{}', timeout: 60000 });
      renderChecks($id('live-preflight'), res);
      A.live.preflightOk = !!(res && res.ok);
      stepState(2, A.live.preflightOk ? 'pass' : 'fail', A.live.preflightOk ? 'PASSED' : 'FAILED');
    } catch (e) {
      $id('live-preflight').innerHTML = `<div class="check fail"><span class="ck">✗</span><span class="cname">preflight request failed</span><span class="cdetail">${esc(adminErrText(e))}</span></div>`;
      A.live.preflightOk = false; stepState(2, 'fail', 'ERROR');
    } finally { btn.disabled = false; btn.textContent = 'Run preflight again'; updateLiveGo(); }
  });
  $id('in-live-phrase').addEventListener('input', (e) => {
    if (!A.live) return;
    const phrase = A.data && A.data.live_ack_phrase;
    A.live.phraseOk = !!phrase && e.target.value.trim() === phrase;
    stepState(3, A.live.phraseOk ? 'pass' : e.target.value ? 'fail' : 'pending', A.live.phraseOk ? 'MATCHES' : e.target.value ? 'NO MATCH' : '');
    updateLiveGo();
  });
  $id('live-go-btn').addEventListener('click', async () => {
    if (!A.live) return;
    const { changes } = A.live;
    const phrase = $id('in-live-phrase').value.trim();
    const btn = $id('live-go-btn'), r = $id('live-result');
    btn.disabled = true; btn.textContent = 'Switching…';
    r.hidden = false; r.className = 'test-result info'; r.textContent = 'PUT /api/admin/settings {mode: live, confirm_live: …}';
    try {
      await putConfigRaw(changes, { confirm_live: phrase });
      r.className = 'test-result ok'; r.textContent = 'Mode switched to LIVE. The agent is restarting; the dashboard badge turns red on its next cycle.';
      btn.textContent = 'Switched';
      setTimeout(() => { D.closeModal('live-modal'); A.live = null; }, 1500);
    } catch (e) {
      r.className = 'test-result bad'; r.textContent = adminErrText(e);
      btn.disabled = false; btn.textContent = 'Retry switch to LIVE';
      showResult('bad', esc(adminErrText(e)));
    }
  });

  function renderChecks(host, res) {
    const checks = (res && res.checks) || [];
    host.innerHTML = checks.map((c) => `<div class="check ${c.pass ? 'pass' : 'fail'}"><span class="ck">${c.pass ? '✓' : '✗'}</span><span class="cname">${esc(c.name)}</span>${c.detail ? `<span class="cdetail">${esc(c.detail)}</span>` : ''}</div>`).join('') +
      `<div class="checks-summary ${res && res.ok ? 'pos' : 'neg'}">${res && res.ok ? 'All checks passed.' : `${checks.filter((c) => !c.pass).length} of ${checks.length} checks failed.`}</div>`;
  }

  // ------------------------------------------------------------------ secrets (table + inline editor)
  const SECRET_GROUPS = [
    { title: 'LLM providers', keys: ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] },
    { title: 'Hyperliquid', keys: ['HL_API_WALLET_PRIVATE_KEY', 'HL_ACCOUNT_ADDRESS'] },
    { title: 'Polymarket', keys: ['POLY_PRIVATE_KEY', 'POLY_FUNDER', 'POLY_SIGNATURE_TYPE'] },
    { title: 'Telegram', keys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] },
    { title: 'Live trading', keys: ['LIVE_TRADING_ACK'] },
  ];
  const SECRET_PURPOSE = {
    GEMINI_API_KEY: 'Google Gemini key, used by Gemini proposer / fallback models.',
    OPENAI_API_KEY: 'OpenAI key, used by GPT models.',
    ANTHROPIC_API_KEY: 'Anthropic key, used by Claude models (often the verifier).',
    HL_API_WALLET_PRIVATE_KEY: 'Hyperliquid API-wallet key that signs orders. An API wallet can trade but cannot withdraw.',
    HL_ACCOUNT_ADDRESS: 'The main Hyperliquid account (0x…) the API wallet trades on behalf of.',
    POLY_PRIVATE_KEY: 'Polygon burner-wallet key that signs Polymarket orders.',
    POLY_FUNDER: 'Polygon address that holds the USDC for Polymarket.',
    POLY_SIGNATURE_TYPE: 'How the Polymarket wallet signs: 0 = plain wallet, 1 = Magic/email login, 2 = browser-wallet proxy.',
    TELEGRAM_BOT_TOKEN: 'Bot token for Telegram notifications.',
    TELEGRAM_CHAT_ID: 'Chat the bot posts notifications to.',
    LIVE_TRADING_ACK: 'Must be set to the exact acknowledgement phrase before live mode can be enabled.',
  };
  function renderSecrets(sec, host) {
    const s = (A.data && A.data.secrets) || {};
    host.appendChild(el('div', 'info-box', `<span class="ib-icon">!</span><div><strong>Wallet safety.</strong> Use a Hyperliquid <em>API wallet</em> (it can trade but cannot withdraw) and a fresh Polygon <em>burner wallet</em> holding only what the agent may trade. Never paste a key that controls other funds. Saving any secret restarts the agent.</div>`));
    const known = new Set(SECRET_GROUPS.flatMap((g) => g.keys));
    const groups = SECRET_GROUPS.map((g) => Object.assign({}, g, { keys: g.keys.filter((k) => k in s) })).filter((g) => g.keys.length);
    const other = Object.keys(s).filter((k) => !known.has(k));
    if (other.length) groups.push({ title: 'Other', keys: other });
    const tbl = el('table', 'stbl');
    tbl.innerHTML = '<thead><tr><th>Key</th><th>Purpose</th><th>Status</th><th></th></tr></thead><tbody></tbody>';
    const tb = tbl.querySelector('tbody');
    for (const g of groups) {
      tb.appendChild(el('tr', 'sgroup-row', `<td colspan="4">${esc(g.title)}</td>`));
      g.keys.forEach((k) => secretRows(sec, k, s[k]).forEach((tr) => tb.appendChild(tr)));
    }
    host.appendChild(tbl);
  }
  function secretRows(sec, key, val) {
    const isPublic = typeof val === 'string';
    const isSet = isPublic ? val.trim() !== '' : val === true;
    const tr = el('tr', 'srow'); tr.dataset.key = key;
    const pill = isPublic && isSet ? `<span class="spill val" title="${esc(val)}">${esc(val)}</span>` : `<span class="spill ${isSet ? 'set' : 'unset'}">${isSet ? 'SET' : 'NOT SET'}</span>`;
    tr.innerHTML = `<td class="skey">${esc(key)}</td><td class="spurpose">${esc(SECRET_PURPOSE[key] || '')}</td><td>${pill}</td><td class="sact"><button type="button" class="btn btn-sm" data-act="update">${isSet ? 'Update' : 'Set'}</button></td>`;
    const rows = [tr];
    tr.querySelector('[data-act="update"]').addEventListener('click', () => { A.openSecret = A.openSecret === key ? null : key; renderSection(sec); });
    if (A.openSecret === key) {
      const edit = el('tr', 'sedit'); edit.dataset.key = key;
      const td = el('td'); td.colSpan = 4;
      const box = el('div', 'sedit-box');
      const input = el('input');
      input.type = isPublic ? 'text' : 'password';
      input.autocomplete = 'off'; input.spellcheck = false;
      input.placeholder = isPublic ? 'new value' : (isSet ? 'paste the new value to replace the stored one' : 'paste the secret');
      box.appendChild(input);
      if (key === 'LIVE_TRADING_ACK' && A.data && A.data.live_ack_phrase) {
        const fill = el('button', 'btn btn-ghost', 'Use the exact phrase'); fill.type = 'button';
        fill.addEventListener('click', () => { input.type = 'text'; input.value = A.data.live_ack_phrase; });
        box.appendChild(fill);
      }
      const save = el('button', 'btn btn-primary', 'Save'); save.type = 'button';
      save.addEventListener('click', () => {
        const v = input.value;
        if (!v.trim()) { showResult('bad', `${esc(key)}: enter a value (or use Clear to delete it).`); return; }
        const send = () => putSecrets(sec, { [key]: v });
        if (/PRIVATE_KEY/.test(key)) {
          confirmDialog({ title: 'Store wallet private key', danger: true, confirmText: 'Store key & restart', body: `<p>You are about to store <code>${esc(key)}</code> on the server (<code>data/secrets.env</code>, mode 600).</p><p><strong>Use a Hyperliquid API wallet (cannot withdraw) and a fresh Polygon burner wallet.</strong> Never store a key that controls funds you cannot afford to lose.</p>`, run: send, successText: 'Secret stored. Agent restarting.' });
        } else send();
      });
      box.appendChild(save);
      if (isSet) {
        const clr = el('button', 'btn btn-ghost', 'Clear'); clr.type = 'button'; clr.title = 'Delete this secret from the server';
        clr.addEventListener('click', () => confirmDialog({ title: 'Delete secret', danger: true, confirmText: 'Delete & restart', body: `<p>Delete <code>${esc(key)}</code> from the server? Features that depend on it stop working after the restart.</p>`, run: () => putSecrets(sec, { [key]: '' }), successText: 'Secret deleted.' }));
        box.appendChild(clr);
      }
      const cancel = el('button', 'btn btn-ghost', 'Cancel'); cancel.type = 'button';
      cancel.addEventListener('click', () => { A.openSecret = null; renderSection(sec); });
      box.appendChild(cancel);
      box.appendChild(el('div', 'sedit-note', isPublic ? 'This value is not sensitive and is shown in the status column.' : 'The value is written to the server and never displayed again.'));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
      td.appendChild(box); edit.appendChild(td);
      rows.push(edit);
      setTimeout(() => input.focus(), 30);
    }
    return rows;
  }
  async function putSecrets(sec, body) {
    try {
      const res = await adminFetch('/api/admin/secrets', { method: 'PUT', body: JSON.stringify(body), timeout: 20000 });
      if (res && res.secrets) A.data.secrets = res.secrets;
      A.openSecret = null;
      renderSection(sec);
      const keys = Object.keys(body);
      showResult('ok', `Updated ${keys.map((k) => `<code>${esc(k)}</code>`).join(', ')}${keys.some((k) => body[k] === '') ? ' (deleted)' : ''}. The value is stored server-side only.`);
      if (!res || res.restart !== false) startWait('Secrets updated');
      return res;
    } catch (e) {
      showResult('bad', esc(adminErrText(e)));
      throw e;
    }
  }

  // ------------------------------------------------------------------ maintenance (three action cards)
  function renderMaintenance(sec, host) {
    const cfg = (A.data && A.data.config) || {};
    host.appendChild(el('div', 'agent-line', ''));
    host.querySelector('.agent-line').dataset.role = 'agent-info';
    const grid = el('div', 'mgrid');

    const pf = el('div', 'mcard');
    pf.innerHTML = `<h4>Preflight</h4><p>Checks the saved config and secrets end to end: LLM keys and models respond, venues reachable, wallet permissions, risk sanity. Takes 5–30 s. Run it before going live.</p><div class="row"><button type="button" class="btn btn-primary" data-act="preflight">Run preflight</button><span class="mres" data-role="pf-status"></span></div><div class="checks" data-role="pf-checks"></div>`;
    pf.querySelector('[data-act="preflight"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget, st = pf.querySelector('[data-role="pf-status"]'), out = pf.querySelector('[data-role="pf-checks"]');
      btn.disabled = true; st.className = 'mres'; st.textContent = 'running… (up to 30 s)';
      try {
        const res = await adminFetch('/api/admin/preflight', { method: 'POST', body: '{}', timeout: 60000 });
        renderChecks(out, res);
        st.className = 'mres ' + (res && res.ok ? 'ok' : 'bad'); st.textContent = res && res.ok ? 'all checks passed' : 'some checks failed';
      } catch (err) { st.className = 'mres bad'; st.textContent = adminErrText(err); }
      finally { btn.disabled = false; }
    });
    grid.appendChild(pf);

    const rs = el('div', 'mcard');
    rs.innerHTML = `<h4>Restart agent</h4><p>Re-reads config.yaml and secrets and starts a fresh cycle. Open positions and their stops are untouched. Use it if the agent looks stuck.</p><div class="row"><button type="button" class="btn" data-act="restart">Restart</button><span class="mres" data-role="restart-status"></span></div>`;
    rs.querySelector('[data-act="restart"]').addEventListener('click', () => confirmDialog({
      title: 'Restart the agent', confirmText: 'Restart', body: '<p>The agent process exits and is restarted by its supervisor within ~5 s. The current cycle (if any) is abandoned; open positions and stops are untouched.</p>',
      run: async () => { const r = await adminFetch('/api/admin/restart', { method: 'POST', body: '{}', timeout: 15000 }); rs.querySelector('[data-role="restart-status"]').className = 'mres ok'; rs.querySelector('[data-role="restart-status"]').textContent = 'restart signalled ' + fmtClock(Date.now() / 1000); startWait('Restart requested'); return r; }, successText: 'Restart signalled.',
    }));
    grid.appendChild(rs);

    const reset = el('div', 'mcard danger');
    const paper = String(cfg.mode || '').toLowerCase() === 'paper';
    reset.innerHTML = `<h4>Reset journal</h4><p>Deletes equity history, learner memory and paper positions so a paper test starts fresh at ${esc(fmtVal(cfg.paper_starting_equity_usd))} USD. Only allowed in paper mode. Cannot be undone.</p><div class="row"><button type="button" class="btn btn-danger" data-act="reset" ${paper ? '' : 'disabled'}>Reset journal</button><span class="mres ${paper ? '' : 'bad'}" data-role="reset-status">${paper ? '' : `disabled: mode is ${esc(String(cfg.mode || '?').toUpperCase())}`}</span></div>`;
    reset.querySelector('[data-act="reset"]').addEventListener('click', () => confirmDialog({
      title: 'Reset the paper journal', danger: true, phrase: 'RESET', confirmText: 'Delete journal',
      body: '<p>This permanently deletes <strong>equity history, learner memory and paper positions</strong>. The agent restarts with a fresh journal. This cannot be undone.</p>',
      run: async () => { const r = await adminFetch('/api/admin/reset-journal', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }), timeout: 20000 }); reset.querySelector('[data-role="reset-status"]').className = 'mres ok'; reset.querySelector('[data-role="reset-status"]').textContent = 'journal reset ' + fmtClock(Date.now() / 1000); startWait('Journal reset'); state.config = null; D.loadAll(false); return r; },
      successText: 'Journal deleted. Agent restarting.',
    }));
    grid.appendChild(reset);

    host.appendChild(grid);
    const reload = el('div', 'muted small', '');
    reload.style.marginTop = '12px';
    reload.innerHTML = '<button type="button" class="link-btn" data-act="reload">Reload settings from the server</button>';
    reload.querySelector('[data-act="reload"]').addEventListener('click', () => loadSettings());
    host.appendChild(reload);
    refreshAgentLine();
  }
  function refreshAgentLine() {
    const info = document.querySelector('[data-role="agent-info"]');
    if (!info) return;
    const ag = (A.data && A.data.agent) || {};
    const st = state.status || {};
    const bits = [];
    bits.push(`Restart pending: <strong>${ag.restart_pending ? 'yes' : 'no'}</strong>`);
    if (ag.last_reload_ts) bits.push(`Last reload <strong>${esc(fmtTime(ag.last_reload_ts))}</strong>`);
    if (st.last_cycle_ts) bits.push(`Last cycle <strong>${esc(fmtAge(Date.now() / 1000 - st.last_cycle_ts))} ago</strong>`);
    if (st.cycles_total != null) bits.push(`<strong>${st.cycles_total}</strong> cycles`);
    if (st.mode) bits.push(`Mode <strong>${esc(String(st.mode).toUpperCase())}</strong>`);
    if (st.killed) bits.push(`<span class="neg">KILLED: ${esc(st.killed)}</span>`);
    info.innerHTML = bits.join('<span class="muted">·</span>');
  }

  // ------------------------------------------------------------------ boot
  onHash();
})();
