/* app.js - trading-agent dashboard (vanilla JS, no build step). See API.md. */
(function () {
  'use strict';

  const POLL_MS = 30000;
  const ANALYTICS_MS = 60000;   // GET /api/analytics cadence (see API_ANALYTICS.md)
  const FEED_LIMIT = 30;        // GET /api/cycles?limit=… per filter chip
  const LS_BASE = 'apiBase';
  const LS_TOKEN = 'token';

  const $ = (sel) => document.querySelector(sel);
  const $id = (id) => document.getElementById(id);

  // -------------------------------------------------------------- settings
  const settings = {
    get base() { return (localStorage.getItem(LS_BASE) || '').trim().replace(/\/+$/, ''); },
    get token() { return (localStorage.getItem(LS_TOKEN) || '').trim(); },
    set(base, token) {
      base = (base || '').trim().replace(/\/+$/, '');
      if (base) localStorage.setItem(LS_BASE, base); else localStorage.removeItem(LS_BASE);
      if (token) localStorage.setItem(LS_TOKEN, token.trim()); else localStorage.removeItem(LS_TOKEN);
    },
    clear() { localStorage.removeItem(LS_BASE); localStorage.removeItem(LS_TOKEN); },
    get configured() { return !!this.base; },
  };

  // -------------------------------------------------------------- state
  const state = {
    demo: true,               // true when rendering mock data
    demoReason: '',
    mode: 'paper',
    status: null,
    equity: [],
    feedCycles: {},           // decision feed: "venue|kind" -> cycles from GET /api/cycles?limit=30&venue=&kind=
    feedAt: {},               // decision feed: "venue|kind" -> ms timestamp of that fetch (fresh for one POLL_MS)
    feedLoading: '',          // "venue|kind" being fetched after a tab/chip click ('' = none)
    feedErr: '',              // error from the last tab/chip-click fetch of the active view (shown in the panel)
    learner: null,
    config: null,
    analytics: null,          // GET /api/analytics payload (null = none yet / 404)
    analyticsAt: 0,           // when analytics was last fetched (ms)
    analyticsErr: '',         // last non-404 analytics error, shown in the panel meta line
    dailyRows: [],            // analytics.daily as rendered (tooltips + fallback redraw)
    lastPoll: 0,
    timer: null,
    chart: null,
    reChart: null,            // rule-engine equity curve (Chart.js instance; sibling of state.chart)
    dailyChart: null,
    feedVenue: 'crypto',      // decision-feed top tab: crypto | pm
    feedKind: 'all',          // decision-feed sub-chip: all | new | updates | rejected | holds | quiet | errors
    shadowTab: 'live',        // shadow & learner panel view tab: live | scoreboard | lessons (survives re-render)
    raceTab: 'rule',          // architecture race: which book's detail view is open (rule | llm | prop); JS-only, resets on reload
    shlCtxAll: false,         // lessons view: show all setup contexts (vs top 6)
    shlPmAll: false,          // lessons view: show all post-mortems (vs latest 3)
    feedOpen: new Set(),      // cycle ids the user expanded (survive re-render)
    feedQuietOpen: new Set(), // 'All' view: collapsed quiet-run rows the user expanded, keyed by the run's newest cycle id (survive re-render)
  };

  // -------------------------------------------------------------- formatting
  const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmtUSD(x, signed) {
    if (x == null || isNaN(x)) return '—';
    const s = usdFmt.format(Math.abs(x));
    if (x < 0) return '-' + s;
    return (signed && x > 0 ? '+' : '') + s;
  }
  function fmtPx(x) {
    if (x == null || isNaN(x)) return '—';
    const a = Math.abs(x);
    let d;
    if (a >= 10000) d = 0;
    else if (a >= 1000) d = 1;
    else if (a >= 100) d = 2;
    else if (a >= 1) d = 3;
    else if (a >= 0.01) d = 4;
    else d = 6;
    return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtNum(x, d) {
    if (x == null || isNaN(x)) return '—';
    if (d == null) {
      const a = Math.abs(x);
      d = a >= 1000 ? 0 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
    }
    return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtPct(x, d) {
    if (x == null || isNaN(x)) return '—';
    d = d == null ? 2 : d;
    return (x > 0 ? '+' : '') + x.toFixed(d) + '%';
  }
  function fmtMult(x) { return x == null || isNaN(x) ? '—' : x.toFixed(x >= 10 ? 2 : 3) + 'x'; }
  function fmtAge(sec) {
    if (sec == null || isNaN(sec)) return '—';
    if (sec < 0) sec = 0;
    sec = Math.round(sec);
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
  }
  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function fmtClock(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function signClass(x) { return x > 0 ? 'pos' : x < 0 ? 'neg' : ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // -------------------------------------------------------------- API client
  class ApiError extends Error {
    constructor(status, detail, url) { super(detail); this.status = status; this.detail = detail; this.url = url; }
  }
  async function apiFetch(path, opts) {
    opts = opts || {};
    const url = settings.base + path;
    const headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
    // Admin calls pass their own Authorization (Google ID token); viewer calls use the dashboard token.
    if (settings.token && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + settings.token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
    let res;
    try {
      res = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body, signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      clearTimeout(t);
      throw new ApiError(0, e.name === 'AbortError' ? 'timeout after ' + Math.round((opts.timeout || 12000) / 1000) + 's' : 'network error: ' + (e.message || 'unreachable (CORS or offline?)'), url);
    }
    clearTimeout(t);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    if (!res.ok) {
      let detail = (body && body.detail) || text || res.statusText;
      if (opts.rawErrors) throw new ApiError(res.status, String(detail).slice(0, 400), url);
      if (res.status === 401) detail = 'Unauthorized (401): ' + ((body && body.detail) || 'invalid token') + ' — check the Bearer token in settings';
      else if (res.status === 404) detail = 'Not found (404): ' + ((body && body.detail) || 'no data yet') + (path.startsWith('/api/health') ? ' — is the API base URL right?' : ' — the agent may not have completed a cycle yet');
      else detail = 'HTTP ' + res.status + ': ' + String(detail).slice(0, 300);
      throw new ApiError(res.status, detail, url);
    }
    return body;
  }
  function describeErr(e) {
    if (e instanceof ApiError) return e.detail;
    return e && e.message ? e.message : String(e);
  }

  // -------------------------------------------------------------- data loading
  async function loadAll(first) {
    setConn('loading');
    if (!settings.configured) {
      enterDemo('No API configured. Open settings to connect to the agent.');
      return;
    }
    try {
      // status + equity are the primary poll; cycles/learner are cheap and keep the feed live.
      // Analytics is heavier and only needs a 60 s cadence: fetch it on every other poll (and on the first).
      const wantAnalytics = first || Date.now() - state.analyticsAt >= ANALYTICS_MS - 1500;
      const [status, equity, cycles, learner, analytics] = await Promise.all([
        apiFetch('/api/status'),
        apiFetch('/api/equity?limit=1000'),
        // Only the active (venue,kind) view is polled; others are re-fetched on their next click (see feed cache below).
        apiFetch(feedPath(state.feedVenue, state.feedKind)).catch((e) => { if (e.status === 404) return []; throw e; }),
        apiFetch('/api/learner').catch((e) => { if (e.status === 404) return null; throw e; }),
        // Never let the analytics endpoint break the core dashboard: errors are captured and shown in the panel.
        wantAnalytics ? apiFetch('/api/analytics').then((a) => ({ ok: true, a })).catch((e) => ({ ok: false, e })) : Promise.resolve(null),
      ]);
      if (analytics) {
        state.analyticsAt = Date.now();
        if (analytics.ok) { state.analytics = analytics.a && typeof analytics.a === 'object' ? analytics.a : null; state.analyticsErr = ''; }
        else if (analytics.e && analytics.e.status === 404) { state.analytics = null; state.analyticsErr = ''; }
        else { state.analyticsErr = describeErr(analytics.e); /* keep the last good payload */ }
      }
      if (first || !state.config) {
        state.config = await apiFetch('/api/config').catch(() => null);
      }
      if (state.demo) clearFeedCache();   // never mix mock cycles with live ones
      state.demo = false;
      state.demoReason = '';
      state.status = status;
      state.equity = Array.isArray(equity) ? equity : [];
      setFeedCycles(feedKey(), cycles);
      state.learner = learner;
      state.mode = (status && status.mode) || (state.config && state.config.mode) || 'paper';
      state.lastPoll = Date.now();
      hideError();
      setConn('ok');
      renderAll();
    } catch (e) {
      const msg = describeErr(e);
      if (e instanceof ApiError && e.status === 404) {
        // Reachable, authorized, but no cycle yet: show an empty live dashboard, not demo data.
        state.demo = false;
        state.status = null; state.equity = []; state.learner = null; state.analytics = null; state.analyticsErr = '';
        clearFeedCache();
        if (!state.config) state.config = await apiFetch('/api/config').catch(() => null);
        state.mode = (state.config && state.config.mode) || 'paper';
        state.lastPoll = Date.now();
        setConn('ok');
        showError('Connected, but the agent has no data yet (404 "no data yet"). Waiting for the first cycle…', 'info');
        renderAll();
        return;
      }
      if (e instanceof ApiError && e.status === 401) {
        showError(msg);
        setConn('error');
        enterDemo('API rejected the token (401). Showing demo data until settings are fixed.');
        return;
      }
      showError('API unreachable: ' + msg);
      setConn('error');
      enterDemo('API unreachable (' + msg + '). Showing demo data; retrying every 30 s.');
    }
  }

  function enterDemo(reason) {
    const M = window.MockAPI;
    if (!state.demo) clearFeedCache();  // live -> demo: drop cached live cycles
    state.demo = true;
    state.demoReason = reason;
    if (!M) { showError('mock.js failed to load and no API is configured.'); return; }
    M.tick();
    state.status = M.status();
    state.equity = M.equity(1000);
    setFeedCycles(feedKey(), M.cycles({ limit: FEED_LIMIT, venue: state.feedVenue, kind: state.feedKind }));
    state.learner = M.learner();
    state.analytics = typeof M.analytics === 'function' ? M.analytics() : null;
    state.analyticsAt = Date.now();
    state.analyticsErr = '';
    state.config = M.config();
    state.mode = state.status.mode;
    state.lastPoll = Date.now();
    if (settings.configured) { /* keep error banner: it explains why we fell back */ } else { hideError(); setConn('demo'); }
    renderAll();
  }

  function schedule() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => loadAll(false), POLL_MS);
  }

  // -------------------------------------------------------------- decision feed data (per venue+kind cache)
  // The feed has two server-side axes: a venue tab (crypto | pm) over a kind sub-chip. Each combination maps to
  // GET /api/cycles?limit=30&venue=<venue>&kind=<kind> (API.md), so every view shows up to 30 cycles of that exact
  // venue+kind — the SERVER does the splitting now, not the client. Responses are cached per "venue|kind" and kept
  // fresh for one poll interval: the 30 s poll re-fetches only the active view; clicking a tab/chip whose cache is
  // older than POLL_MS (or missing) fetches it once. In demo mode the same params read from MockAPI.cycles().
  const FEED_KINDS = {
    all:      { label: 'decision',        global: false },
    new:      { label: 'new-position',    global: false },  // entry fills (server kind=new)
    updates:  { label: 'position-update', global: false },  // management fills (server kind=updates)
    rejected: { label: 'rejected',        global: false },  // gate / RR / verifier rejections
    holds:    { label: 'hold',            global: true },   // venue-agnostic: model consulted, no trade
    quiet:    { label: 'quiet',           global: true },   // venue-agnostic: attention gate skipped the cycle
    errors:   { label: 'error',           global: true },   // venue-agnostic: cycle / proposer failure
  };
  // Action-kind taxonomy. Used only for ROW-level rendering now (which order rows to show within a cycle); the
  // cycle SET itself is chosen server-side by venue+kind.
  const ENTRY_KINDS = ['open_perp', 'spot_buy', 'pm_buy', 'buy_pm'];         // fresh positions ("New")
  const UPDATE_KINDS = ['update_stop', 'pm_update', 'close_perp', 'spot_sell', 'pm_sell', 'modify_stop']; // management ("Updates")
  const CRYPTO_KINDS = ['open_perp', 'close_perp', 'update_stop', 'spot_buy', 'spot_sell', 'modify_stop']; // perps + spot
  const PM_KINDS = ['pm_buy', 'pm_sell', 'pm_update', 'buy_pm'];             // prediction markets
  // Venue / category of an ACTION by its kind (independent of fill status, so rejected proposals classify too).
  function actionVenue(a) {
    const k = a && a.kind;
    if (CRYPTO_KINDS.includes(k)) return 'crypto';
    if (PM_KINDS.includes(k)) return 'pm';
    return null;
  }
  function actionCat(a) {
    const k = a && a.kind;
    if (ENTRY_KINDS.includes(k)) return 'entry';
    if (UPDATE_KINDS.includes(k)) return 'manage';
    return null;
  }
  // Row predicate for the active view: keep only venue-appropriate order rows (and, for new/updates, the matching
  // category). Venue-agnostic kinds (holds/quiet/errors) carry no order rows, so no row filtering. null = show all.
  function feedRowPred() {
    const venue = state.feedVenue, kind = state.feedKind;
    if (FEED_KINDS[kind] && FEED_KINDS[kind].global) return null;
    const cat = kind === 'new' ? 'entry' : kind === 'updates' ? 'manage' : null;
    return (o) => {
      const a = o && o.action;
      const v = actionVenue(a);
      if (v && v !== venue) return false;          // drop the other venue's rows
      if (cat && actionCat(a) !== cat) return false; // new/updates: keep only the matching category
      return true;
    };
  }
  function feedKey() { return state.feedVenue + '|' + state.feedKind; }
  function feedPath(venue, kind) {
    return `/api/cycles?limit=${FEED_LIMIT}&venue=${encodeURIComponent(venue)}&kind=${encodeURIComponent(kind)}`;
  }
  function clearFeedCache() { state.feedCycles = {}; state.feedAt = {}; state.feedErr = ''; }
  function setFeedCycles(key, cycles) {
    state.feedCycles[key] = Array.isArray(cycles) ? cycles : [];
    state.feedAt[key] = Date.now();
    state.feedErr = '';
  }
  function feedFresh(key) { return key in state.feedCycles && Date.now() - (state.feedAt[key] || 0) < POLL_MS; }
  function fetchFeed(venue, kind) {
    if (state.demo) {
      const M = window.MockAPI;
      return Promise.resolve(M ? M.cycles({ limit: FEED_LIMIT, venue, kind }) : []);
    }
    return apiFetch(feedPath(venue, kind)).catch((e) => { if (e.status === 404) return []; throw e; });
  }
  // Re-fetch the active view after a tab/chip switch (or serve the cache if it is still fresh).
  async function selectFeed() {
    if (!FEED_KINDS[state.feedKind]) state.feedKind = 'all';
    if (state.feedVenue !== 'pm') state.feedVenue = 'crypto';
    const venue = state.feedVenue, kind = state.feedKind, key = feedKey();
    if (feedFresh(key) || state.feedLoading === key) { renderFeed(); return; }
    state.feedLoading = key;
    renderFeed();
    try {
      const cycles = await fetchFeed(venue, kind);
      if (feedKey() !== key) return;   // user moved on; that view's own fetch owns the panel now
      setFeedCycles(key, cycles);
    } catch (e) {
      if (feedKey() !== key) return;
      state.feedErr = describeErr(e);
    } finally {
      if (state.feedLoading === key) state.feedLoading = '';
    }
    renderFeed();
  }

  // -------------------------------------------------------------- render: chrome
  function setConn(s) {
    const el = $id('conn-dot');
    el.dataset.state = s;
    $id('conn-text').textContent = s === 'ok' ? 'live' : s === 'demo' ? 'demo' : s === 'loading' ? 'polling' : 'error';
  }
  function showError(msg, kind) {
    const b = $id('error-banner');
    b.hidden = false;
    b.className = 'banner ' + (kind === 'info' ? 'banner-demo' : 'banner-error');
    b.querySelector('.banner-tag').textContent = kind === 'info' ? 'WAITING' : 'ERROR';
    $id('error-banner-text').textContent = msg;
  }
  function hideError() { $id('error-banner').hidden = true; }

  function renderChrome() {
    const banner = $id('demo-banner');
    banner.hidden = !state.demo;
    $id('demo-banner-text').textContent = state.demoReason;
    const badge = $id('mode-badge');
    const mode = String(state.mode || 'paper').toLowerCase();
    badge.dataset.mode = ['paper', 'testnet', 'live'].includes(mode) ? mode : 'paper';
    badge.textContent = mode.toUpperCase() + (state.demo ? ' · DEMO' : '');
    const kill = $id('kill-btn');
    kill.disabled = state.demo;
    kill.title = state.demo ? 'Disabled in demo mode - configure an API base URL and token in settings' : 'Emergency stop: flatten everything and halt the agent';
    $id('foot-api').textContent = settings.configured ? 'API: ' + settings.base + (settings.token ? ' (token set)' : ' (no token!)') : 'API: not configured (demo)';
    $id('last-poll').textContent = state.lastPoll ? 'updated ' + fmtClock(state.lastPoll / 1000) : '';
  }

  // -------------------------------------------------------------- render: status
  function renderStatus() {
    const s = state.status;
    const alerts = $id('alerts');
    alerts.innerHTML = '';
    if (!s) {
      ['st-equity', 'st-pnl', 'st-today', 'st-today-pct', 'st-npos', 'st-exposure', 'st-multiple', 'st-day', 'st-days-left', 'st-cycle-age', 'st-cycles', 'st-available', 'st-margin-note', 'st-multiple-note'].forEach((id) => { $id(id).textContent = '—'; });
      $id('st-start').textContent = '—';
      $id('multiple-fill').style.width = '0%';
      $id('st-llm-tile').hidden = true;
      $id('st-health-dot').dataset.state = 'warn';
      $id('st-health').textContent = 'No data yet';
      $id('st-health').className = 'warn';
      return;
    }
    const goal = s.goal || (state.config && state.config.goal) || { target_multiple: 2.0, horizon_days: 10 };
    const target = goal.target_multiple || 2.0;
    const horizon = goal.horizon_days || 10;
    const nowS = Date.now() / 1000;
    const isLive = String(s.mode).toLowerCase() === 'live';
    const modeWord = String(s.mode || 'paper').toUpperCase();

    if (s.killed) alerts.insertAdjacentHTML('beforeend', `<div class="alert alert-bad"><strong>STOPPED</strong><span>The agent was killed and will not restart on its own. Reason: ${esc(s.killed)}</span></div>`);
    if (s.daily_halt) alerts.insertAdjacentHTML('beforeend', `<div class="alert alert-warn"><strong>DAILY HALT</strong><span>Today's loss limit was hit. No new risk until the next UTC day; the agent may still reduce positions.</span></div>`);
    const loop = (state.config && state.config.loop_interval_seconds) || 300;
    const age = s.last_cycle_ts ? nowS - s.last_cycle_ts : null;
    const stale = age != null && age > loop * 2.5 && !s.killed;
    if (stale && !state.demo) alerts.insertAdjacentHTML('beforeend', `<div class="alert alert-warn"><strong>STALE</strong><span>Last cycle was ${esc(fmtAge(age))} ago (it should run every ${esc(fmtAge(loop))}). The agent may be down.</span></div>`);
    if (isLive) alerts.insertAdjacentHTML('beforeend', `<div class="alert alert-bad"><strong>LIVE</strong><span>Real money. Every fill here is a real order on Hyperliquid / Polymarket.</span></div>`);

    // equity + since start
    const eq = s.equity != null ? s.equity : (s.snapshot && s.snapshot.equity_usd);
    const start = s.starting_equity;
    const pnl = eq != null && start != null ? eq - start : null;
    const pnlPct = pnl != null && start ? (pnl / start) * 100 : null;
    $id('st-equity').textContent = fmtUSD(eq);
    const pnlEl = $id('st-pnl');
    pnlEl.textContent = pnl == null ? '—' : `${fmtUSD(pnl, true)} (${fmtPct(pnlPct)})`;
    pnlEl.className = signClass(pnl);
    $id('st-start').textContent = fmtUSD(start);

    // today's PnL (since 00:00 UTC), from the equity history unless the API provides it
    const today = todayPnl(s, eq);
    const tEl = $id('st-today');
    tEl.textContent = today ? fmtUSD(today.usd, true) : '—';
    tEl.className = 'stat-value ' + (today ? signClass(today.usd) : '');
    $id('st-today-pct').textContent = today ? `${fmtPct(today.pct)} since ${today.label}` : 'no equity points yet today';

    // positions + exposure
    const snap = s.snapshot || {};
    const gross = (snap.perps || []).reduce((a, p) => a + (p.notional_usd || 0), 0) + (snap.spot || []).reduce((a, p) => a + (p.value_usd || 0), 0) + (snap.pm || []).reduce((a, p) => a + (p.value_usd || 0), 0);
    const nPos = (snap.perps || []).length + (snap.spot || []).length + (snap.pm || []).length;
    $id('st-npos').textContent = String(nPos);
    $id('st-exposure').textContent = nPos ? (eq ? `gross ${fmtUSD(gross)} · ${(gross / eq * 100).toFixed(0)}% of equity` : `gross ${fmtUSD(gross)}`) : 'nothing open · waiting for a setup';

    // agent health
    let hs = 'ok', hl = 'Healthy';
    if (s.killed) { hs = 'bad'; hl = 'Stopped'; }
    else if (age == null) { hs = 'warn'; hl = 'No cycle yet'; }
    else if (age > loop * 2.5) { hs = 'bad'; hl = 'Unresponsive'; }
    else if (age > loop * 1.5) { hs = 'warn'; hl = 'Running late'; }
    else if (s.daily_halt) { hs = 'warn'; hl = 'Halted today'; }
    $id('st-health-dot').dataset.state = hs;
    const hEl = $id('st-health'); hEl.textContent = hl; hEl.className = hs;
    const ageEl = $id('st-cycle-age');
    ageEl.textContent = age == null ? 'no cycle yet' : `last cycle ${fmtAge(age)} ago`;
    ageEl.className = 'muted' + (stale ? ' warn' : '');
    $id('st-cycles').textContent = `${s.cycles_total != null ? s.cycles_total.toLocaleString('en-US') : '—'} cycles · every ${fmtAge(loop)} · ${modeWord}${modeWord === 'PAPER' ? ' (simulated)' : ''}`;

    // goal row
    const mult = s.multiple != null ? s.multiple : (eq && start ? eq / start : null);
    $id('st-multiple').textContent = fmtMult(mult);
    $id('st-multiple').className = mult != null ? (mult >= 1 ? 'pos' : 'neg') : '';
    $id('st-target').textContent = fmtMult(target);
    const fill = $id('multiple-fill');
    const meter = $id('multiple-meter');
    const frac = mult != null ? Math.max(0, Math.min(1, mult / target)) : 0;
    fill.style.width = (frac * 100).toFixed(2) + '%';
    fill.className = 'meter-fill ' + (mult != null && mult < 1 ? 'loss' : 'gain');
    $id('multiple-start-tick').style.left = ((1 / target) * 100).toFixed(2) + '%';
    meter.setAttribute('aria-valuemax', String(target));
    meter.setAttribute('aria-valuenow', mult != null ? mult.toFixed(4) : '0');
    const toGo = mult != null ? (target / mult - 1) * 100 : null;
    $id('st-multiple-note').textContent = mult == null ? '—' : mult >= target ? 'Target reached' : `needs ${fmtPct(toGo)} more to reach ${fmtMult(target)}`;

    const days = s.days_elapsed != null ? s.days_elapsed : (s.start_ts ? (nowS - s.start_ts) / 86400 : null);
    const dayNum = days != null ? Math.min(horizon, Math.max(1, Math.floor(days) + 1)) : null;
    $id('st-day').textContent = dayNum != null ? `Day ${dayNum}/${horizon}` : '—';
    const left = days != null ? horizon - days : null;
    $id('st-days-left').textContent = left == null ? '—' : left > 0 ? `${left.toFixed(1)} days remaining · started ${fmtTime(s.start_ts)}` : `horizon exceeded by ${(-left).toFixed(1)} d`;

    $id('st-available').textContent = fmtUSD(snap.available_usd);
    $id('st-margin-note').textContent = snap.available_usd != null && eq ? `${(snap.available_usd / eq * 100).toFixed(0)}% of equity free for new trades` : 'free margin for new trades';

    renderLLMTile(s);
  }

  // Today's PnL since 00:00 UTC. Prefers status.pnl_today_usd if the API ever provides it.
  function todayPnl(s, eq) {
    if (s.pnl_today_usd != null) {
      const base = eq != null ? eq - s.pnl_today_usd : null;
      return { usd: s.pnl_today_usd, pct: base ? (s.pnl_today_usd / base) * 100 : null, label: '00:00 UTC' };
    }
    const pts = state.equity || [];
    if (!pts.length || eq == null) return null;
    const d = new Date();
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
    let base = null;
    for (const p of pts) { if (p.ts < dayStart) base = p; else break; }
    const label = base ? '00:00 UTC' : 'start';
    if (!base) base = pts[0];
    return { usd: eq - base.equity, pct: base.equity ? (eq / base.equity - 1) * 100 : null, label };
  }

  // LLM cost tile: tokens_today / tokens_total ({cost_usd, calls?, input_tokens?, output_tokens?, by_role?}) + llm_model.
  function fmtCost(x) {
    if (x == null || isNaN(x)) return '—';
    const a = Math.abs(x);
    const d = a === 0 ? 2 : a < 0.01 ? 4 : a < 1 ? 3 : 2;
    return '$' + a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtTokens(n) {
    if (n == null || isNaN(n)) return null;
    return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
  }
  // Accepts several plausible shapes for per-role usage: tokens_today.by_role / .roles / .by_model {name: {calls, cost_usd}},
  // or top-level tokens_today.verifier / .fallback objects. Returns [] when nothing is present.
  function llmRoles(t) {
    if (!t || typeof t !== 'object') return [];
    const src = t.by_role || t.roles || t.by_model || null;
    const out = [];
    const push = (name, r) => { if (r && typeof r === 'object') out.push({ name, calls: r.calls, cost: r.cost_usd, model: r.model }); };
    if (src && typeof src === 'object') Object.keys(src).forEach((k) => push(k, src[k]));
    else ['proposer', 'verifier', 'fallback'].forEach((k) => push(k, t[k]));
    return out.filter((r) => r.name !== 'proposer' && (r.calls || r.cost));
  }
  function renderLLMTile(s) {
    const tile = $id('st-llm-tile');
    const today = s.tokens_today, total = s.tokens_total;
    const research = s.research_today && s.research_today.usd != null ? s.research_today.usd : null;
    if (!today && !total && !s.llm_model && research == null) { tile.hidden = true; return; }
    tile.hidden = false;
    const cap = state.config && state.config.llm && state.config.llm.daily_cost_cap_usd;
    const tCost = today && today.cost_usd;
    const el = $id('st-llm-today');
    el.textContent = fmtCost(tCost);
    el.className = 'stat-value' + (cap && tCost != null && tCost >= cap * 0.8 ? ' stale' : '');
    const bits = [];
    if (research != null) bits.push('+ ' + fmtCost(research) + ' research');
    if (total && total.cost_usd != null) bits.push('total ' + fmtCost(total.cost_usd));
    if (cap) bits.push('cap ' + fmtCost(cap) + '/day');
    const model = s.llm_model || (state.config && state.config.llm && (state.config.llm.model || (state.config.llm.proposer && state.config.llm.proposer.model)));
    if (model) bits.push(model);
    $id('st-llm-total').textContent = bits.join(' · ') || '—';
    const det = [];
    if (today && today.calls != null) det.push(`${today.calls} calls`);
    const roles = llmRoles(today);
    roles.forEach((r) => det.push(`${esc(r.name)} ${r.calls != null ? r.calls : ''}${r.cost != null ? ` (${fmtCost(r.cost)})` : ''}`));
    const detEl = $id('st-llm-detail');
    detEl.innerHTML = det.join(' · ');
    const tip = [];
    if (today && fmtTokens(today.input_tokens)) tip.push(`today: ${fmtTokens(today.input_tokens)} input / ${fmtTokens(today.output_tokens)} output tokens`);
    roles.forEach((r) => tip.push(`${r.name}${r.model ? ' = ' + r.model : ''}: ${r.calls != null ? r.calls + ' calls' : ''}${r.cost != null ? ', ' + fmtCost(r.cost) : ''}`));
    detEl.title = tip.join('\n');
  }

  // -------------------------------------------------------------- render: market brief
  // status.market_brief {ts, content} — independent research brief refreshed ~6h. The content is
  // markdown-ish. Per line: escape EVERYTHING first, then strip [[n]] / [[n, m]] citation markers,
  // **x** → <b>x</b> (non-greedy, multiple pairs per line). "- " lines become a compact <ul>;
  // anything else becomes a paragraph. No markdown lib.
  function briefHTML(md) {
    const inline = (s) => esc(s)
      .replace(/\s*\[\[[\d\s,]+\]\]/g, '')            // [[1]] / [[1, 2]] citation markers → gone
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    let html = '';
    let items = [];
    const flush = () => {
      if (!items.length) return;
      html += '<ul class="brief-list">' + items.map((s) => '<li>' + s + '</li>').join('') + '</ul>';
      items = [];
    };
    for (const line of String(md == null ? '' : md).split('\n')) {
      const m = /^\s*[-*•]\s+(\S.*)/.exec(line);
      if (m) { items.push(inline(m[1])); continue; }
      flush();
      if (line.trim()) html += '<p class="brief-p">' + inline(line.trim()) + '</p>';
    }
    flush();
    return html;
  }
  function renderMarketBrief() {
    const b = state.status && state.status.market_brief;
    const panel = $id('brief-panel');
    if (!b || !b.content) { panel.hidden = true; return; }
    panel.hidden = false;
    $id('brief-age').textContent = b.ts ? fmtAge(Date.now() / 1000 - b.ts) + ' ago' : '';
    const body = $id('brief-body');
    const key = (b.ts || 0) + '|' + b.content;
    if (state.briefKey !== key) { state.briefKey = key; body.innerHTML = briefHTML(b.content); }
    body.classList.toggle('collapsed', !state.briefOpen);
    const btn = $id('brief-toggle');
    // Offer the toggle only when the collapsed clamp actually hides something.
    btn.hidden = !state.briefOpen && body.scrollHeight <= body.clientHeight + 2;
    btn.textContent = state.briefOpen ? 'show less' : 'show more';
  }
  $id('brief-toggle').addEventListener('click', () => { state.briefOpen = !state.briefOpen; renderMarketBrief(); });

  // -------------------------------------------------------------- render: chart
  function ensureChart() {
    if (state.chart || typeof window.Chart === 'undefined') return state.chart;
    const ctx = $id('equity-chart').getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#3987e5';
    const grid = css.getPropertyValue('--border').trim() || '#262b36';
    const text2 = css.getPropertyValue('--text-2').trim() || '#a4abb8';
    const text3 = css.getPropertyValue('--text-3').trim() || '#6e7684';
    const good = css.getPropertyValue('--good').trim() || '#22b14c';
    const surface2 = css.getPropertyValue('--surface-2').trim() || '#1b1f27';
    const bg = css.getPropertyValue('--bg').trim() || '#0c0e12';
    const text = css.getPropertyValue('--text').trim() || '#e8eaee';

    // Reference lines: start equity (neutral dashed) and target (green dashed).
    const refLines = {
      id: 'refLines',
      afterDatasetsDraw(chart) {
        const { ctx: c, chartArea: area, scales: { y } } = chart;
        const refs = chart.options.plugins.refLines || {};
        c.save();
        c.setLineDash([4, 4]);
        c.lineWidth = 1;
        c.font = '11px ' + (css.getPropertyValue('--mono').trim() || 'monospace');
        c.textBaseline = 'bottom';
        [{ v: refs.start, color: text3, label: 'start' }, { v: refs.target, color: good, label: 'target ' + (refs.targetMult || '') }].forEach((r) => {
          if (r.v == null || r.v < y.min || r.v > y.max) return;
          const yy = y.getPixelForValue(r.v);
          c.strokeStyle = r.color;
          c.beginPath(); c.moveTo(area.left, yy); c.lineTo(area.right, yy); c.stroke();
          c.fillStyle = r.color;
          c.textAlign = 'right';
          c.fillText(r.label, area.right - 4, yy - 3);
        });
        c.restore();
      },
    };

    state.chart = new window.Chart(ctx, {
      type: 'line',
      data: { datasets: [{
        label: 'Equity', data: [], parsing: false,
        borderColor: accent, borderWidth: 2, tension: 0.15,
        pointRadius: 0, pointHitRadius: 12, pointHoverRadius: 4, pointHoverBackgroundColor: accent, pointHoverBorderColor: bg, pointHoverBorderWidth: 2,
        fill: { target: 'origin', above: 'rgba(57,135,229,0.10)' },
      }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          refLines: {},
          tooltip: {
            backgroundColor: surface2, borderColor: grid, borderWidth: 1, titleColor: text2, bodyColor: text,
            displayColors: false, padding: 10,
            callbacks: {
              title: (items) => items.length ? fmtTime(items[0].parsed.x / 1000) : '',
              label: (item) => {
                const start = state.status && state.status.starting_equity;
                const v = item.parsed.y;
                const extra = start ? `  (${fmtMult(v / start)}, ${fmtPct((v / start - 1) * 100)})` : '';
                return fmtUSD(v) + extra;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear', bounds: 'data',
            grid: { color: grid, drawTicks: false }, border: { color: grid },
            ticks: { color: text3, maxTicksLimit: 8, maxRotation: 0, autoSkip: true, font: { size: 11 }, callback: (v) => {
              const d = new Date(v);
              const span = (state.equity.length ? (state.equity[state.equity.length - 1].ts - state.equity[0].ts) : 0);
              return span > 2 * 86400 ? d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
            } },
          },
          y: {
            position: 'right', grace: '5%',
            grid: { color: grid, drawTicks: false }, border: { display: false },
            ticks: { color: text3, maxTicksLimit: 6, font: { size: 11 }, callback: (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }) },
          },
        },
      },
      plugins: [refLines],
    });
    return state.chart;
  }

  function renderChart() {
    const pts = state.equity || [];
    $id('equity-empty').hidden = pts.length > 0;
    const range = $id('eq-range');
    if (pts.length) {
      const first = pts[0], last = pts[pts.length - 1];
      let lo = Infinity, hi = -Infinity;
      for (const p of pts) { if (p.equity < lo) lo = p.equity; if (p.equity > hi) hi = p.equity; }
      range.textContent = `${pts.length} pts · ${fmtTime(first.ts)} → ${fmtTime(last.ts)} · lo ${fmtUSD(lo)} · hi ${fmtUSD(hi)}`;
    } else range.textContent = '';

    const start = state.status && state.status.starting_equity;
    const goal = (state.status && state.status.goal) || (state.config && state.config.goal) || {};
    const target = start && goal.target_multiple ? start * goal.target_multiple : null;

    const chart = ensureChart();
    if (chart) {
      chart.data.datasets[0].data = pts.map((p) => ({ x: p.ts * 1000, y: p.equity }));
      chart.options.plugins.refLines = { start, target, targetMult: goal.target_multiple ? fmtMult(goal.target_multiple) : '' };
      // Include the start line in the visible y-range so drawdowns read against it.
      const ys = pts.map((p) => p.equity);
      if (start) ys.push(start);
      if (ys.length) {
        const lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
        const pad = Math.max((hi - lo) * 0.08, hi * 0.004);
        chart.options.scales.y.min = lo - pad; chart.options.scales.y.max = hi + pad;
      }
      chart.update('none');
    } else {
      drawFallbackChart(pts, start, target);
    }
  }

  // Minimal canvas renderer used only if the Chart.js CDN is blocked.
  function drawFallbackChart(pts, start, target) {
    const canvas = $id('equity-chart');
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const c = canvas.getContext('2d');
    c.scale(dpr, dpr);
    c.clearRect(0, 0, W, H);
    if (!pts.length) return;
    const padL = 8, padR = 64, padT = 10, padB = 24;
    const xs = pts.map((p) => p.ts), ys = pts.map((p) => p.equity);
    if (start) ys.push(start);
    const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
    let lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    const pad = Math.max((hi - lo) * 0.08, 1); lo -= pad; hi += pad;
    const X = (t) => padL + ((t - x0) / Math.max(1, x1 - x0)) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    c.strokeStyle = '#262b36'; c.lineWidth = 1; c.fillStyle = '#6e7684'; c.font = '11px monospace'; c.textAlign = 'left';
    for (let i = 0; i <= 4; i++) {
      const v = lo + (i / 4) * (hi - lo), yy = Y(v);
      c.beginPath(); c.moveTo(padL, yy); c.lineTo(W - padR, yy); c.stroke();
      c.fillText('$' + Math.round(v).toLocaleString('en-US'), W - padR + 6, yy + 4);
    }
    const ref = (v, color, label) => {
      if (v == null || v < lo || v > hi) return;
      c.save(); c.setLineDash([4, 4]); c.strokeStyle = color; c.beginPath(); c.moveTo(padL, Y(v)); c.lineTo(W - padR, Y(v)); c.stroke();
      c.fillStyle = color; c.textAlign = 'right'; c.fillText(label, W - padR - 4, Y(v) - 3); c.restore();
    };
    ref(start, '#6e7684', 'start'); ref(target, '#22b14c', 'target');
    c.beginPath();
    pts.forEach((p, i) => { const x = X(p.ts), y = Y(p.equity); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
    c.strokeStyle = '#3987e5'; c.lineWidth = 2; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke();
    c.lineTo(X(x1), Y(lo)); c.lineTo(X(x0), Y(lo)); c.closePath(); c.fillStyle = 'rgba(57,135,229,0.10)'; c.fill();
    c.fillStyle = '#6e7684'; c.textAlign = 'left'; c.fillText(fmtTime(x0), padL, H - 6); c.textAlign = 'right'; c.fillText(fmtTime(x1), W - padR, H - 6);
  }

  // -------------------------------------------------------------- render: positions
  function emptyRow(cols, text) { return `<tr><td class="empty-row" colspan="${cols}">${esc(text)}</td></tr>`; }

  function renderPositions() {
    const snap = (state.status && state.status.snapshot) || {};
    const perps = snap.perps || [], spot = snap.spot || [], pm = snap.pm || [];
    const eq = state.status && state.status.equity;
    const mode = String(state.mode || 'paper').toLowerCase();
    const sim = $id('pos-sim');
    sim.hidden = mode === 'live';
    sim.textContent = mode === 'paper' ? 'PAPER · simulated' : mode === 'testnet' ? 'TESTNET · not real money' : '';
    sim.dataset.mode = mode;

    const total = perps.length + spot.length + pm.length;
    $id('pos-empty').hidden = total > 0;
    // Hide empty sub-tables when something else is open; show all three (with row hints) only when nothing is open at all.
    $id('perps-block').hidden = total > 0 && !perps.length;
    $id('spot-block').hidden = total > 0 && !spot.length;
    $id('pm-block').hidden = total > 0 && !pm.length;
    if (!total) { $id('perps-block').hidden = $id('spot-block').hidden = $id('pm-block').hidden = true; }

    $id('perps-count').textContent = perps.length ? `(${perps.length})` : '';
    // v3: the LLM no longer trades perps — any perp here is a legacy/held position, flag it as such.
    { const lg = $id('perps-legacy'); if (lg) lg.hidden = !perps.length; }
    $id('perps-table').querySelector('tbody').innerHTML = perps.length ? perps.map((p) => {
      const side = p.side ? String(p.side).toLowerCase() : (p.size < 0 ? 'short' : 'long');
      const margin = p.entry_px && p.size ? Math.abs(p.size) * p.entry_px / (p.leverage || 1) : null;
      const upnlPct = margin ? (p.unrealized_pnl / margin) * 100 : null;
      const mv = p.mark_px && p.entry_px ? (p.mark_px / p.entry_px - 1) * 100 : null;
      return `<tr class="${sim.hidden ? '' : 'sim'}">
        <td data-l="Coin"><div class="coin">${esc(p.coin)}</div><div class="small"><span class="side-pill ${side}">${side.toUpperCase()}</span> <span class="muted">${p.leverage != null ? fmtNum(p.leverage, 1) + 'x' : ''}</span></div></td>
        <td class="r" data-l="Size">${fmtUSD(p.notional_usd)}<br><span class="small muted">${fmtNum(Math.abs(p.size))} ${esc(p.coin)}</span></td>
        <td class="r" data-l="Entry → Mark">${fmtPx(p.entry_px)} →<br>${fmtPx(p.mark_px)}${mv != null ? ` <span class="small ${signClass(mv)}">${fmtPct(mv, 2)}</span>` : ''}</td>
        <td class="r ${signClass(p.unrealized_pnl)}" data-l="uPnL">${fmtUSD(p.unrealized_pnl, true)}${upnlPct != null ? `<br><span class="small">${fmtPct(upnlPct, 1)} on margin</span>` : ''}</td>
        <td class="span2 bar-cell" data-l="Stop → TP">${rangeBar(p, side)}</td>
      </tr>`;
    }).join('') : emptyRow(5, 'No open perp positions');

    $id('spot-count').textContent = spot.length ? `(${spot.length})` : '';
    $id('spot-table').querySelector('tbody').innerHTML = spot.length ? spot.map((sp) => `<tr class="${sim.hidden ? '' : 'sim'}">
        <td class="coin" data-l="Pair">${esc(sp.coin)}</td>
        <td class="r" data-l="Amount">${fmtNum(sp.amount)}</td>
        <td class="r" data-l="Value">${fmtUSD(sp.value_usd)}${eq ? `<br><span class="small muted">${(sp.value_usd / eq * 100).toFixed(1)}% of equity</span>` : ''}</td>
      </tr>`).join('') : emptyRow(3, 'No spot holdings');

    $id('pm-count').textContent = pm.length ? `(${pm.length})` : '';
    $id('pm-table').querySelector('tbody').innerHTML = pm.length ? pm.map((m) => {
      const upnl = m.shares != null && m.avg_price != null && m.cur_price != null ? (m.cur_price - m.avg_price) * m.shares : null;
      const upnlPct = m.avg_price ? (m.cur_price / m.avg_price - 1) * 100 : null;
      const outNo = String(m.outcome).toLowerCase() === 'no';
      const hasLevels = m.stop_px != null || m.tp_px != null;
      return `<tr class="${sim.hidden ? '' : 'sim'}">
        <td class="wrap span2" data-l="Market" title="market ${esc(m.market_id)} · token ${esc(m.token_id)}"><span class="side-pill ${outNo ? 'short' : 'long'}">${esc(m.outcome)}</span> ${esc(m.question)}${hasLevels ? ' <span class="atag atag-swing" title="Swing PM trade: stop / target set on the token price">SWING</span>' : ''}</td>
        <td class="r" data-l="Shares">${fmtNum(m.shares, 1)}</td>
        <td class="r" data-l="Avg → Cur">${m.avg_price != null ? (m.avg_price * 100).toFixed(1) + '¢' : '—'} → ${m.cur_price != null ? (m.cur_price * 100).toFixed(1) + '¢' : '—'}</td>
        <td class="r" data-l="Value">${fmtUSD(m.value_usd)}</td>
        <td class="r ${signClass(upnl)}" data-l="uPnL">${fmtUSD(upnl, true)}${upnlPct != null ? `<br><span class="small">${fmtPct(upnlPct, 1)}</span>` : ''}</td>
        <td class="span2 bar-cell" data-l="Stop → Target">${pmRangeBar(m)}</td>
      </tr>`;
    }).join('') : emptyRow(6, 'No prediction-market positions');

    const totalU = perps.reduce((a, p) => a + (p.unrealized_pnl || 0), 0) + pm.reduce((a, m) => a + ((m.cur_price - m.avg_price) * m.shares || 0), 0);
    $id('pos-summary').innerHTML = total ? `${total} open · unrealized <span class="${signClass(totalU)} num">${fmtUSD(totalU, true)}</span>` : '';

    // "watching" strip — one-shot price alarms the model set for itself (status.watch_levels)
    const watches = Array.isArray(state.status && state.status.watch_levels) ? state.status.watch_levels : [];
    const strip = $id('watch-strip');
    strip.hidden = !watches.length;
    strip.innerHTML = watches.length ? `<span class="watch-label">watching</span>` + watches.map((w) => {
      const below = String(w.direction).toLowerCase() === 'below';
      return `<span class="watch-pill" title="${esc(w.note || '')}">👁 ${esc(w.coin)} <span class="watch-dir">${below ? '▼' : '▲'}</span> ${fmtPx(w.px)}</span>`;
    }).join('') : '';

    // "resting limits" strip — limit orders waiting for price to touch (status.resting_orders)
    const resting = Array.isArray(state.status && state.status.resting_orders) ? state.status.resting_orders : [];
    const rstrip = $id('resting-strip');
    rstrip.hidden = !resting.length;
    rstrip.innerHTML = resting.length ? `<span class="watch-label">resting limits</span>` + resting.map((o) => {
      const side = String(o.side || '').toLowerCase();
      const tip = [
        o.stop_loss_px != null ? 'stop ' + fmtPx(o.stop_loss_px) : 'no stop',
        o.take_profit_px != null ? 'tp ' + fmtPx(o.take_profit_px) : 'no take-profit',
        o.ts ? 'resting ' + fmtAge(Date.now() / 1000 - o.ts) : '',
      ].filter(Boolean).join(' · ');
      return `<span class="watch-pill" title="${esc(tip)}">⏳ ${esc(o.coin)} ${esc(side)} ${fmtUSD(o.size_usd)} @ ${fmtPx(o.limit_price)}</span>`;
    }).join('') : '';
  }

  // Stop → TP track: where the current price sits between the stop and the take-profit, with distances from the mark.
  function rangeBar(p, side, opts) {
    const stop = p.stop_px || null, tp = p.tp_px || null, mark = p.mark_px, entry = p.entry_px;
    if (!mark || !entry) return '<span class="small muted">—</span>';
    if (!stop && !tp) return `<span class="small neg">NO STOP</span> <span class="small muted">· no take-profit</span>${p.liquidation_px ? `<div class="small muted">liq ${fmtPx(p.liquidation_px)}</div>` : ''}`;
    const vals = [stop, tp, mark, entry].filter((v) => v != null);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const padR = (hi - lo) * 0.04 || Math.abs(mark) * 0.001; lo -= padR; hi += padR;
    const X = (v) => (((v - lo) / (hi - lo)) * 100).toFixed(1);
    const a = Math.min(entry, mark), b = Math.max(entry, mark);
    const toStop = stop ? (stop / mark - 1) * 100 : null, toTp = tp ? (tp / mark - 1) * 100 : null;
    const stopDist = stop ? Math.abs(stop - entry) : null, mv = mark - entry;
    const rNow = stopDist ? (side === 'short' ? -mv : mv) / stopDist : null;
    // Label the endpoints by price order (low on the left), not by fixed position:
    // a long has its stop below and tp above, a short has its stop ABOVE and tp BELOW.
    const stopLabel = `<span class="neg">${stop ? `stop ${fmtPx(stop)} <span class="muted">(${fmtPct(toStop, 1)})</span>` : 'NO STOP'}</span>`;
    const tpLabel = tp ? `<span class="pos">tp ${fmtPx(tp)} <span class="muted">(${fmtPct(toTp, 1)})</span></span>` : '<span class="muted">no tp</span>';
    const stopOnLeft = stop && tp ? stop <= tp : side !== 'short';
    const leftLabel = stopOnLeft ? stopLabel : tpLabel;
    const rightLabel = stopOnLeft ? tpLabel : stopLabel;
    return `<div class="rbar" title="stop ${stop ? fmtPx(stop) : 'none'} · entry ${fmtPx(entry)} · mark ${fmtPx(mark)} · tp ${tp ? fmtPx(tp) : 'none'}">
      <div class="rtrack">
        <div class="rfill ${signClass(p.unrealized_pnl)}" style="left:${X(a)}%;width:${(X(b) - X(a)).toFixed(1)}%"></div>
        ${stop ? `<i class="rmark stop" style="left:${X(stop)}%"></i>` : ''}
        ${tp ? `<i class="rmark tp" style="left:${X(tp)}%"></i>` : ''}
        <i class="rmark entry" style="left:${X(entry)}%"></i>
        <i class="rmark now" style="left:${X(mark)}%"></i>
      </div>
      <div class="rlabels small">
        ${leftLabel}
        ${rNow != null && !(opts && opts.noR) ? `<span class="muted">${(rNow >= 0 ? '+' : '') + rNow.toFixed(2)}R</span>` : ''}
        ${rightLabel}
      </div>
      ${p.liquidation_px ? `<div class="small muted">liq ${fmtPx(p.liquidation_px)} (${fmtPct((p.liquidation_px / mark - 1) * 100, 0)})</div>` : ''}
    </div>`;
  }

  // Stop → Target track for a PM swing: token-price levels (0–1) shown in cents, with the current price marker
  // between the stop and the target. Null stop_px/tp_px = a hold-to-resolution bet (no levels), rendered as "—".
  function pmRangeBar(m) {
    const stop = m.stop_px != null ? m.stop_px : null;
    const tp = m.tp_px != null ? m.tp_px : null;
    const cur = m.cur_price != null ? m.cur_price : null;
    const entry = m.avg_price != null ? m.avg_price : null;
    const ct = (v) => (v * 100).toFixed(0) + '¢';
    if (stop == null && tp == null) return '<span class="small muted">— <span class="k">hold to resolution</span></span>';
    if (cur == null || entry == null) return `<span class="small">${stop != null ? `stop ${ct(stop)}` : 'no stop'} <span class="arrow">→</span> ${tp != null ? `target ${ct(tp)}` : 'no target'}</span>`;
    const vals = [stop, tp, cur, entry].filter((v) => v != null);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const padR = (hi - lo) * 0.06 || 0.02; lo = Math.max(0, lo - padR); hi = Math.min(1, hi + padR);
    const span = (hi - lo) || 1;
    const X = (v) => (((v - lo) / span) * 100).toFixed(1);
    const a = Math.min(entry, cur), b = Math.max(entry, cur);
    const upnl = (cur - entry) * (m.shares || 0);
    const stopDist = stop != null ? Math.abs(stop - entry) : null;
    const rNow = stopDist ? (cur - entry) / stopDist : null;   // token price up = profit for the held outcome token
    const toStop = stop != null && cur ? (stop / cur - 1) * 100 : null, toTp = tp != null && cur ? (tp / cur - 1) * 100 : null;
    return `<div class="rbar" title="stop ${stop != null ? ct(stop) : 'none'} · avg ${ct(entry)} · cur ${ct(cur)} · target ${tp != null ? ct(tp) : 'none'}">
      <div class="rtrack">
        <div class="rfill ${signClass(upnl)}" style="left:${X(a)}%;width:${(X(b) - X(a)).toFixed(1)}%"></div>
        ${stop != null ? `<i class="rmark stop" style="left:${X(stop)}%"></i>` : ''}
        ${tp != null ? `<i class="rmark tp" style="left:${X(tp)}%"></i>` : ''}
        <i class="rmark entry" style="left:${X(entry)}%"></i>
        <i class="rmark now" style="left:${X(cur)}%"></i>
      </div>
      <div class="rlabels small">
        <span class="neg">${stop != null ? `stop ${ct(stop)}${toStop != null ? ` <span class="muted">(${fmtPct(toStop, 0)})</span>` : ''}` : 'no stop'}</span>
        ${rNow != null ? `<span class="muted">${(rNow >= 0 ? '+' : '') + rNow.toFixed(2)}R</span>` : ''}
        <span class="pos">${tp != null ? `tp ${ct(tp)}${toTp != null ? ` <span class="muted">(${fmtPct(toTp, 0)})</span>` : ''}` : '<span class="muted">no target</span>'}</span>
      </div>
    </div>`;
  }



  // -------------------------------------------------------------- render: rule engine (status.rule_book) — v3 PRIMARY perp trader
  // v3: the deterministic rule engine trades ALL perps (2h momentum on movers, 1D-trend filtered, fixed 2R exits).
  // Its book (status.rule_book) is the dashboard HERO. Fields may be null/absent (equity/mark/upnl are stamped
  // periodically, trades[] can be empty at start) — every access is null-guarded and the whole body is wrapped
  // in try/catch so a malformed payload only hides this panel, never crashes renderAll.
  const RE_STRATS = ['pullback', 'deepfade'];
  function stratChip(strat) {
    const s = String(strat == null ? '' : strat).toLowerCase();
    const cls = RE_STRATS.includes(s) ? s : '';
    return `<span class="strat-chip ${cls}">${esc(strat == null || strat === '' ? '—' : strat)}</span>`;
  }
  function rbSidePill(side) {
    const sd = String(side || 'long').toLowerCase() === 'short' ? 'short' : 'long';
    return `<span class="side-pill ${sd}">${sd.toUpperCase()}</span>`;
  }
  const RE_WHY_TAG = { stop: 'tag-stop', tp: 'tag-tp', time: 'tag-stale' };

  // ---- rule-engine equity curve: a sibling of ensureChart()/renderChart() that reads rb.equity_hist
  // instead of /api/equity. Same Chart.js theme (grid/tooltip/axes), same canvas fallback, but the line
  // is green when the book is above start and red when below, with a single dashed `start` baseline.
  function ensureREChart() {
    if (state.reChart || typeof window.Chart === 'undefined') return state.reChart;
    const canvas = $id('re-equity-chart');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--border').trim() || '#262b36';
    const text2 = css.getPropertyValue('--text-2').trim() || '#a4abb8';
    const text3 = css.getPropertyValue('--text-3').trim() || '#6e7684';
    const good = css.getPropertyValue('--good').trim() || '#22b14c';
    const surface2 = css.getPropertyValue('--surface-2').trim() || '#1b1f27';
    const bg = css.getPropertyValue('--bg').trim() || '#0c0e12';
    const text = css.getPropertyValue('--text').trim() || '#e8eaee';

    const reRef = {
      id: 'reRef',
      afterDatasetsDraw(chart) {
        const { ctx: c, chartArea: area, scales: { y } } = chart;
        const start = chart.options.plugins.reRef && chart.options.plugins.reRef.start;
        if (start == null || start < y.min || start > y.max) return;
        c.save();
        c.setLineDash([4, 4]); c.lineWidth = 1;
        c.font = '11px ' + (css.getPropertyValue('--mono').trim() || 'monospace');
        c.textBaseline = 'bottom';
        const yy = y.getPixelForValue(start);
        c.strokeStyle = text3;
        c.beginPath(); c.moveTo(area.left, yy); c.lineTo(area.right, yy); c.stroke();
        c.fillStyle = text3; c.textAlign = 'right';
        c.fillText('start', area.right - 4, yy - 3);
        c.restore();
      },
    };

    state.reChart = new window.Chart(ctx, {
      type: 'line',
      data: { datasets: [{
        label: 'Equity', data: [], parsing: false,
        borderColor: good, borderWidth: 2, tension: 0.15,
        pointRadius: 0, pointHitRadius: 12, pointHoverRadius: 4, pointHoverBackgroundColor: good, pointHoverBorderColor: bg, pointHoverBorderWidth: 2,
        fill: { target: 'origin', above: 'rgba(34,177,76,0.10)' },
      }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          reRef: {},
          tooltip: {
            backgroundColor: surface2, borderColor: grid, borderWidth: 1, titleColor: text2, bodyColor: text,
            displayColors: false, padding: 10,
            callbacks: {
              title: (items) => items.length ? fmtTime(items[0].parsed.x / 1000) : '',
              label: (item) => {
                const start = state.status && state.status.rule_book && state.status.rule_book.start;
                const v = item.parsed.y;
                const extra = start ? `  (${fmtMult(v / start)}, ${fmtPct((v / start - 1) * 100)})` : '';
                return fmtUSD(v) + extra;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear', bounds: 'data',
            grid: { color: grid, drawTicks: false }, border: { color: grid },
            ticks: { color: text3, maxTicksLimit: 8, maxRotation: 0, autoSkip: true, font: { size: 11 }, callback: (v) => {
              const d = new Date(v);
              const pts = (state.reChart && state.reChart.data.datasets[0].data) || [];
              const span = pts.length ? (pts[pts.length - 1].x - pts[0].x) / 1000 : 0;
              return span > 2 * 86400 ? d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
            } },
          },
          y: {
            position: 'right', grace: '5%',
            grid: { color: grid, drawTicks: false }, border: { display: false },
            ticks: { color: text3, maxTicksLimit: 6, font: { size: 11 }, callback: (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }) },
          },
        },
      },
      plugins: [reRef],
    });
    return state.reChart;
  }

  // pts: [{ts, equity}] (seconds). up = current >= start (green) vs below (red).
  function renderREChart(pts, start, up) {
    const css = getComputedStyle(document.documentElement);
    const good = css.getPropertyValue('--good').trim() || '#22b14c';
    const bad = css.getPropertyValue('--bad').trim() || '#e5484d';
    const color = up ? good : bad;
    const fillRgba = up ? 'rgba(34,177,76,0.10)' : 'rgba(229,72,77,0.10)';
    const chart = ensureREChart();
    if (chart) {
      const ds = chart.data.datasets[0];
      ds.data = pts.map((p) => ({ x: p.ts * 1000, y: p.equity }));
      ds.borderColor = color; ds.pointHoverBackgroundColor = color;
      ds.fill = { target: 'origin', above: fillRgba };
      chart.options.plugins.reRef = { start };
      const ys = pts.map((p) => p.equity);
      if (start != null) ys.push(start);
      if (ys.length) {
        const lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
        const pad = Math.max((hi - lo) * 0.08, hi * 0.004);
        chart.options.scales.y.min = lo - pad; chart.options.scales.y.max = hi + pad;
      }
      chart.update('none');
    } else {
      drawFallbackREChart(pts, start, color, fillRgba);
    }
  }

  // Minimal canvas renderer used only if the Chart.js CDN is blocked (sibling of drawFallbackChart).
  function drawFallbackREChart(pts, start, color, fillRgba) {
    const canvas = $id('re-equity-chart');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const c = canvas.getContext('2d');
    c.scale(dpr, dpr);
    c.clearRect(0, 0, W, H);
    if (!pts.length) return;
    const padL = 8, padR = 64, padT = 10, padB = 24;
    const xs = pts.map((p) => p.ts), ys = pts.map((p) => p.equity);
    if (start != null) ys.push(start);
    const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
    let lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    const pad = Math.max((hi - lo) * 0.08, 1); lo -= pad; hi += pad;
    const X = (t) => padL + ((t - x0) / Math.max(1, x1 - x0)) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    c.strokeStyle = '#262b36'; c.lineWidth = 1; c.fillStyle = '#6e7684'; c.font = '11px monospace'; c.textAlign = 'left';
    for (let i = 0; i <= 4; i++) {
      const v = lo + (i / 4) * (hi - lo), yy = Y(v);
      c.beginPath(); c.moveTo(padL, yy); c.lineTo(W - padR, yy); c.stroke();
      c.fillText('$' + Math.round(v).toLocaleString('en-US'), W - padR + 6, yy + 4);
    }
    if (start != null && start >= lo && start <= hi) {
      c.save(); c.setLineDash([4, 4]); c.strokeStyle = '#6e7684'; c.beginPath(); c.moveTo(padL, Y(start)); c.lineTo(W - padR, Y(start)); c.stroke();
      c.fillStyle = '#6e7684'; c.textAlign = 'right'; c.fillText('start', W - padR - 4, Y(start) - 3); c.restore();
    }
    c.beginPath();
    pts.forEach((p, i) => { const x = X(p.ts), y = Y(p.equity); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
    c.strokeStyle = color; c.lineWidth = 2; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke();
    c.lineTo(X(x1), Y(lo)); c.lineTo(X(x0), Y(lo)); c.closePath(); c.fillStyle = fillRgba; c.fill();
    c.fillStyle = '#6e7684'; c.textAlign = 'left'; c.fillText(fmtTime(x0), padL, H - 6); c.textAlign = 'right'; c.fillText(fmtTime(x1), W - padR, H - 6);
  }

  function renderRuleEngine() {
    const panel = $id('rule-engine-panel');
    if (!panel) return;   // stale cached index.html without the panel skeleton: skip quietly
    try {
      const rb = state.status && state.status.rule_book;
      if (!rb || typeof rb !== 'object') { panel.hidden = true; return; }
      panel.hidden = false;
      const nowS = Date.now() / 1000;
      const num = (v) => (typeof v === 'number' && !isNaN(v) ? v : null);

      // ---- hero header: equity (fallback cash), multiple vs start ----
      const start = num(rb.start);
      const equity = num(rb.equity) != null ? num(rb.equity) : num(rb.cash);
      $id('re-equity').textContent = fmtUSD(equity);
      const mult = equity != null && start ? equity / start : null;
      const mEl = $id('re-mult');
      mEl.textContent = mult != null ? mult.toFixed(3) + 'x' : '—';
      mEl.className = 're-mult ' + (mult != null ? (mult >= 1 ? 'pos' : 'neg') : 'muted');
      $id('re-start').textContent = fmtUSD(start);

      // ---- collections ----
      const posEntries = rb.positions && typeof rb.positions === 'object' && !Array.isArray(rb.positions)
        ? Object.entries(rb.positions).filter(([, p]) => p && typeof p === 'object') : [];
      const pend = (Array.isArray(rb.pending) ? rb.pending : []).filter((o) => o && typeof o === 'object');
      const trades = (Array.isArray(rb.trades) ? rb.trades.filter((t) => t && typeof t === 'object') : [])
        .slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));

      // ---- KPI row ----
      const realizedNet = trades.reduce((a, t) => a + (num(t.pnl) || 0), 0);
      const wins = trades.filter((t) => num(t.pnl) != null && t.pnl > 0).length;
      const winRate = trades.length ? (wins / trades.length) * 100 : null;
      const grossNotional = posEntries.reduce((a, [, p]) => a + (num(p.notional) || 0), 0);
      const grossPct = equity ? (grossNotional / equity) * 100 : null;
      const kpis = [
        { l: 'Open', v: String(posEntries.length) },
        { l: 'Pending', v: String(pend.length) },
        { l: 'Closed', v: String(trades.length) },
        { l: 'Realized net', v: fmtUSD(realizedNet, true), cls: signClass(realizedNet) },
        { l: 'Win rate', v: winRate != null ? Math.round(winRate) + '%' : '—', sub: trades.length ? `${wins}/${trades.length} wins` : 'no closed trades yet' },
        { l: 'Gross notional', v: fmtUSD(grossNotional), cls: grossPct != null && grossPct > 250 ? 'warn' : '', sub: grossPct != null ? `${grossPct.toFixed(0)}% of equity` : '' },
      ];
      $id('re-kpis').innerHTML = kpis.map((k) => `<div class="re-kpi">
        <div class="re-kpi-l">${esc(k.l)}</div>
        <div class="re-kpi-v ${k.cls || ''}">${k.v}</div>
        ${k.sub ? `<div class="re-kpi-s muted">${esc(k.sub)}</div>` : ''}
      </div>`).join('');

      // ---- equity curve (rb.equity_hist: array of [ts_seconds, equity]) ----
      // Reuses the main equity chart's Chart.js style via renderREChart(); green above start, red below.
      const hist = Array.isArray(rb.equity_hist) ? rb.equity_hist
        .map((pt) => (Array.isArray(pt) && pt.length >= 2 && num(pt[0]) != null && num(pt[1]) != null ? { ts: pt[0], equity: pt[1] } : null))
        .filter(Boolean) : [];
      const eqEmpty = $id('re-equity-empty');
      const rangeEl = $id('re-eq-range');
      const swatch = $id('re-swatch-line');
      if (hist.length >= 2) {
        if (eqEmpty) eqEmpty.hidden = true;
        let lo = Infinity, hi = -Infinity;
        for (const p of hist) { if (p.equity < lo) lo = p.equity; if (p.equity > hi) hi = p.equity; }
        const cur = hist[hist.length - 1].equity;
        const up = start == null ? cur >= (hist[0].equity) : cur >= start;
        if (swatch) swatch.className = 'swatch re-swatch-line' + (up ? '' : ' neg');
        if (rangeEl) rangeEl.textContent = `${hist.length} pts · lo ${fmtUSD(lo)} · hi ${fmtUSD(hi)} · now ${fmtUSD(cur)}`;
        renderREChart(hist, start, up);
      } else {
        if (eqEmpty) eqEmpty.hidden = false;
        if (rangeEl) rangeEl.textContent = hist.length === 1 ? '1 pt so far' : '';
        if (swatch) swatch.className = 'swatch re-swatch-line';
      }

      // ---- realized vs unrealized split ----
      const unrealized = posEntries.reduce((a, [, p]) => a + (num(p.upnl) || 0), 0);
      const totalPnl = equity != null && start != null ? equity - start : (realizedNet + unrealized);
      const splitCells = [
        { l: 'Realized', v: realizedNet, s: trades.length ? `${trades.length} closed trade${trades.length === 1 ? '' : 's'}` : 'no closed trades' },
        { l: 'Unrealized', v: unrealized, s: posEntries.length ? `${posEntries.length} open position${posEntries.length === 1 ? '' : 's'}` : 'nothing open' },
        { l: 'Total P&L', v: totalPnl, s: start != null ? 'equity − start' : 'realized + unrealized' },
      ];
      $id('re-split').innerHTML = splitCells.map((c) => `<div class="re-split-cell">
        <div class="re-split-l">${esc(c.l)}</div>
        <div class="re-split-v ${signClass(c.v)}">${fmtUSD(c.v, true)}</div>
        <div class="re-split-s">${esc(c.s)}</div>
      </div>`).join('');

      // ---- live per-coin cards (mark + uPnL refresh each poll) ----
      $id('re-live-count').textContent = posEntries.length ? `(${posEntries.length})` : '';
      $id('re-live-cards').innerHTML = posEntries.length ? posEntries.map(([coin, p]) => {
        const mark = num(p.mark), entry = num(p.entry), upnl = num(p.upnl);
        const dir = String(p.side || 'long').toLowerCase() === 'short' ? -1 : 1;
        const pct = mark != null && entry ? (mark / entry - 1) * 100 * dir : null;   // P&L% from the position's side
        const notion = num(p.notional);
        const upnlPct = upnl != null && notion ? (upnl / notion) * 100 : null;
        const cls = upnl == null ? '' : signClass(upnl);
        return `<div class="re-live-card ${cls}">
          <div class="re-live-top">
            <span class="re-live-coin">${esc(coin)}</span>${rbSidePill(p.side)}${stratChip(p.strat)}
          </div>
          <div class="re-live-mark">${fmtPx(mark)}</div>
          <div class="re-live-upnl ${cls}">${fmtUSD(upnl, true)}${upnlPct != null ? ` <span class="small">(${fmtPct(upnlPct)})</span>` : ''}</div>
          <div class="re-live-sub">entry ${fmtPx(entry)}${pct != null ? ` · ${fmtPct(pct)}` : ''} · ${fmtUSD(notion)} notl</div>
        </div>`;
      }).join('') : '<div class="re-live-empty">No open positions — waiting for a setup.</div>';

      // ---- open positions ----
      $id('re-pos-count').textContent = posEntries.length ? `(${posEntries.length})` : '';
      $id('re-pos-table').querySelector('tbody').innerHTML = posEntries.length ? posEntries.map(([coin, p]) => {
        const mv = num(p.mark) != null && num(p.entry) ? (p.mark / p.entry - 1) * 100 : null;
        const opened = num(p.opened_ts), deadline = num(p.deadline_ts);
        const ageTxt = opened != null ? fmtAge(nowS - opened) : '—';
        const expTxt = deadline != null ? (deadline - nowS <= 0 ? 'due' : 'exp ' + fmtAge(deadline - nowS)) : '';
        return `<tr>
          <td data-l="Coin"><div class="coin">${esc(coin)}</div><div class="small">${rbSidePill(p.side)}</div></td>
          <td data-l="Strat">${stratChip(p.strat)}</td>
          <td class="r" data-l="Entry → Mark">${fmtPx(p.entry)} →<br>${fmtPx(p.mark)}${mv != null ? ` <span class="small ${signClass(mv)}">${fmtPct(mv, 2)}</span>` : ''}</td>
          <td class="r neg" data-l="Stop">${fmtPx(p.stop)}</td>
          <td class="r pos" data-l="TP">${fmtPx(p.tp)}</td>
          <td class="r" data-l="Notional">${fmtUSD(p.notional)}</td>
          <td class="r ${signClass(p.upnl)}" data-l="uPnL">${fmtUSD(p.upnl, true)}</td>
          <td class="r muted small" data-l="Age / expires">${esc(ageTxt)}${expTxt ? `<br>${esc(expTxt)}` : ''}</td>
        </tr>`;
      }).join('') : emptyRow(8, 'No open positions');

      // ---- pending limits ----
      $id('re-pending-count').textContent = pend.length ? `(${pend.length})` : '';
      $id('re-pending-table').querySelector('tbody').innerHTML = pend.length ? pend.map((o) => {
        const left = num(o.expires_ts) != null ? o.expires_ts - nowS : null;
        return `<tr>
          <td data-l="Coin"><span class="coin">${esc(o.coin || '—')}</span> ${rbSidePill(o.side)}</td>
          <td data-l="Strat">${stratChip(o.strat)}</td>
          <td class="r" data-l="Limit">${fmtPx(o.limit)}</td>
          <td class="r neg" data-l="Stop">${fmtPx(o.stop)}</td>
          <td class="r pos" data-l="TP">${fmtPx(o.tp)}</td>
          <td class="r" data-l="Expires in">${left == null ? '—' : left <= 0 ? 'expired' : fmtAge(left)}</td>
        </tr>`;
      }).join('') : emptyRow(6, 'No resting limits');

      // ---- closed trades (most recent first, cap 15) ----
      $id('re-trades-count').textContent = trades.length ? `(${trades.length})` : '';
      $id('re-trades-table').querySelector('tbody').innerHTML = trades.length ? trades.slice(0, 15).map((t) => {
        const why = String(t.why || '—').toLowerCase();
        return `<tr>
          <td data-l="Coin"><span class="coin">${esc(t.coin || '—')}</span> ${rbSidePill(t.side)}</td>
          <td data-l="Strat">${stratChip(t.strat)}</td>
          <td class="r" data-l="Entry → Exit">${fmtPx(t.entry)} → ${fmtPx(t.exit)}</td>
          <td data-l="Why"><span class="tag ${RE_WHY_TAG[why] || 'tag-pending'}">${esc(why.toUpperCase())}</span></td>
          <td class="r ${signClass(t.r)}" data-l="R">${fmtR(t.r)}</td>
          <td class="r ${signClass(t.pnl)}" data-l="PnL">${fmtUSD(t.pnl, true)}</td>
          <td class="r muted small" data-l="When">${fmtTime(t.ts)}</td>
        </tr>`;
      }).join('') : emptyRow(7, 'No closed trades yet');

      const netR = trades.reduce((a, t) => a + (num(t.r) || 0), 0);
      $id('re-trades-sum').innerHTML = trades.length
        ? `${trades.length} closed · net <span class="${signClass(netR)}">${(netR > 0 ? '+' : '') + netR.toFixed(1)}R</span> · <span class="${signClass(realizedNet)}">${fmtUSD(realizedNet, true)}</span>`
        : '';

      // ---- per-strategy breakdown ----
      const byStrat = {};
      for (const t of trades) {
        const k = String(t.strat == null || t.strat === '' ? '—' : t.strat).toLowerCase();
        const g = byStrat[k] || (byStrat[k] = { n: 0, r: 0, pnl: 0, label: t.strat == null || t.strat === '' ? '—' : t.strat });
        g.n += 1; g.r += num(t.r) || 0; g.pnl += num(t.pnl) || 0;
      }
      const stratRows = Object.values(byStrat).sort((a, b) => b.pnl - a.pnl);
      $id('re-strat-table').querySelector('tbody').innerHTML = stratRows.length ? stratRows.map((g) => `<tr>
        <td data-l="Strat">${stratChip(g.label)}</td>
        <td class="r" data-l="Trades">${g.n}</td>
        <td class="r ${signClass(g.r)}" data-l="Net R">${(g.r > 0 ? '+' : '') + g.r.toFixed(1)}R</td>
        <td class="r ${signClass(g.pnl)}" data-l="Net $">${fmtUSD(g.pnl, true)}</td>
      </tr>`).join('') : emptyRow(4, 'no closed trades yet');

      // ---- per-coin net $ (top 3 / bottom 3) ----
      const byCoin = {};
      for (const t of trades) {
        const k = t.coin || '—';
        const g = byCoin[k] || (byCoin[k] = { coin: k, n: 0, pnl: 0 });
        g.n += 1; g.pnl += num(t.pnl) || 0;
      }
      const coinAll = Object.values(byCoin).sort((a, b) => b.pnl - a.pnl);
      let coinRows = coinAll;
      if (coinAll.length > 6) coinRows = coinAll.slice(0, 3).concat(coinAll.slice(-3));
      $id('re-coin-table').querySelector('tbody').innerHTML = coinRows.length ? coinRows.map((g) => `<tr>
        <td data-l="Coin"><span class="coin">${esc(g.coin)}</span></td>
        <td class="r" data-l="Trades">${g.n}</td>
        <td class="r ${signClass(g.pnl)}" data-l="Net $">${fmtUSD(g.pnl, true)}</td>
      </tr>`).join('') : emptyRow(3, 'no closed trades yet');
    } catch (e) {
      try { console.error('rule-engine panel failed to render; hiding it', e); } catch (_) { /* noop */ }
      panel.hidden = true;
    }
  }

  // -------------------------------------------------------------- render: shadow trades & learner (one panel, three views)
  // Live shadows come from status.shadow_trades (rejected entries the agent paper-simulates to score the
  // rejecter); the Scoreboard and Lessons views come from GET /api/learner. live_r / r read from the REJECTED
  // trade's point of view: positive = it would be winning, i.e. the veto is costing money (bad for the rejecter).
  // The three layers that can reject a proposal (API_ANALYTICS.md: rejection_scores keys / shadow_trades[].by).
  const REJECTERS = [['all', 'All', 'all rejecters'], ['verifier', 'Verifier', 'the verifier'], ['risk_gate', 'Risk gate', 'the risk gate'], ['rr_model', 'RR model', 'the RR model']];
  const BY_SHORT = { verifier: 'verifier', risk_gate: 'gate', rr_model: 'RR' };
  // Who rejected a shadow trade: the `by` field, else inferred from the reason prefix (older payloads), else 'other'.
  function rejecterOf(t) {
    const by = String(t.by || '').toLowerCase();
    if (BY_SHORT[by]) return by;
    const r = String(t.reason || '');
    return /^verifier/i.test(r) ? 'verifier' : /^(risk[ _-]?)?gate/i.test(r) ? 'risk_gate' : /^rr/i.test(r) ? 'rr_model' : 'other';
  }
  const SHL_VIEWS = { live: 'shl-live', scoreboard: 'shl-scoreboard', lessons: 'shl-lessons' };
  const SHL_LABELS = { live: 'Live shadows', scoreboard: 'Scoreboard', lessons: 'Lessons' };

  function renderShadowLearner() {
    // The served page may predate this panel (stale index.html cached against a newer app.js):
    // if its skeleton is missing, skip quietly instead of throwing and killing renderAll.
    const panel = $id('shadowtr-panel'), tabs = $id('shl-tabs');
    if (!panel || !tabs) return;
    const st = (state.status && state.status.shadow_trades) || {};
    const open = Array.isArray(st.open) ? st.open.slice().sort((a, b) => n0(b.ts) - n0(a.ts)) : [];
    const resolved = Array.isArray(st.resolved) ? st.resolved.slice().sort((a, b) => n0(b.ts) - n0(a.ts)) : [];
    const L = state.learner || {};
    // Rejection scores; falls back to the legacy verifier_score shape when rejection_scores is absent.
    const rs = L.rejection_scores && typeof L.rejection_scores === 'object' ? L.rejection_scores
      : L.verifier_score && typeof L.verifier_score === 'object' ? { verifier: L.verifier_score } : null;
    const ctxs = (Array.isArray(L.contexts) ? L.contexts : []).slice().sort((a, b) => (b.n || 0) - (a.n || 0) || (b.q || 0) - (a.q || 0));
    const pms = Array.isArray(L.postmortems) ? L.postmortems.slice().sort((a, b) => n0(b.ts) - n0(a.ts)) : [];
    const lessonsTxt = typeof L.lessons === 'string' ? L.lessons.trim() : '';
    const openScored = Array.isArray(L.open) ? L.open : [];
    // Confidence calibration lives in GET /api/analytics (`calibration`), not /api/learner. The API already
    // omits empty buckets, but filter defensively so a zero-n bucket can't render a blank row.
    const calib = state.analytics && state.analytics.calibration && typeof state.analytics.calibration === 'object' ? state.analytics.calibration : null;
    const calibBuckets = calib && Array.isArray(calib.buckets) ? calib.buckets.filter((b) => n0(b.n) > 0) : [];

    const hasLive = open.length > 0 || resolved.length > 0;
    const hasScore = !!rs;
    const hasLessons = ctxs.length > 0 || pms.length > 0 || !!lessonsTxt || openScored.length > 0 || calibBuckets.length > 0;
    panel.hidden = !hasLive && !hasScore && !hasLessons;
    if (panel.hidden) return;

    // Tab row: active chip + counts. state.shadowTab survives the poll re-render (same pattern as state.feedKind).
    if (!SHL_VIEWS[state.shadowTab]) state.shadowTab = 'live';
    const counts = { live: open.length, scoreboard: 0, lessons: ctxs.length };
    tabs.querySelectorAll('.fchip').forEach((b) => {
      const v = b.dataset.view;
      const on = v === state.shadowTab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.innerHTML = esc(SHL_LABELS[v] || v) + (counts[v] ? ` <span class="count">&middot; ${counts[v]}</span>` : '');
    });
    Object.keys(SHL_VIEWS).forEach((v) => { const el = $id(SHL_VIEWS[v]); if (el) el.hidden = v !== state.shadowTab; });

    renderShadowLive(open, resolved);
    renderRejScoreboard(rs);
    renderLearnerLessons(ctxs, pms, lessonsTxt, openScored, calib, calibBuckets);
  }

  // View 1: the open-shadows ghost table + resolved strip (behavior unchanged from the old panel).
  function renderShadowLive(open, resolved) {
    const nowS = Date.now() / 1000;
    const emptyEl = $id('shl-live-empty');
    if (emptyEl) emptyEl.hidden = open.length > 0 || resolved.length > 0;

    const openBlock = $id('shadowtr-open-block');
    if (openBlock) openBlock.hidden = !open.length;
    const openTable = $id('shadowtr-open-table');
    const openBody = openTable && openTable.querySelector('tbody');
    if (openBody) openBody.innerHTML = open.length ? open.map((t) => {
      const side = String(t.side || '').toLowerCase() === 'short' ? 'short' : 'long';
      const who = rejecterOf(t);
      // Reuse the positions' stop->TP track when we have mark+entry; else a compact text fallback.
      const bar = t.mark_px != null && t.entry_px != null
        ? rangeBar({ stop_px: t.stop_px, tp_px: t.tp_px, mark_px: t.mark_px, entry_px: t.entry_px, unrealized_pnl: t.live_r }, side, { noR: true })
        : `<span class="small"><span class="neg">stop ${fmtPx(t.stop_px)}</span> <span class="arrow">→</span> <span class="pos">tp ${fmtPx(t.tp_px)}</span></span>`;
      return `<tr class="ghost-row" title="${esc(t.reason || '')}">
        <td data-l="Coin"><div class="coin">${esc(t.coin || '—')}</div><div class="small"><span class="side-pill ${side}">${side.toUpperCase()}</span>${t.size_usd != null ? ` <span class="muted">${fmtUSD(t.size_usd)}</span>` : ''}</div></td>
        <td data-l="Rejected by"><span class="by-pill ${esc(who)}" title="rejected by ${esc(who === 'other' ? 'unknown' : (REJECTERS.find((r) => r[0] === who) || [])[2] || who)}">${esc(BY_SHORT[who] || (t.by ? String(t.by) : '?'))}</span></td>
        <td class="r" data-l="Entry">${fmtPx(t.entry_px)}</td>
        <td class="r" data-l="Mark">${fmtPx(t.mark_px)}</td>
        <td class="r ${signClass(t.live_r)}" data-l="R now" title="running R-multiple of the rejected trade: positive = it would be winning (the veto is costing money)">${fmtR(t.live_r)}</td>
        <td class="span2 bar-cell" data-l="Stop → TP">${bar}</td>
        <td class="r muted small" data-l="Age" title="${esc(fmtTime(t.ts))}">${t.ts ? esc(fmtAge(nowS - t.ts)) : '—'}</td>
      </tr>`;
    }).join('') : emptyRow(7, 'No open shadow trades — nothing rejected recently.');

    // Resolved strip: the last few finished simulations. ✓ = the rejecter was right (r < 0, veto saved
    // money); ✗ = it blocked a winner (r > 0).
    const strip = $id('shadowtr-resolved-strip');
    if (!strip) return;
    const last = resolved.slice(0, 6);
    strip.hidden = !last.length;
    strip.innerHTML = last.length ? `<span class="watch-label">resolved</span>` + last.map((t) => {
      const short = String(t.side || '').toLowerCase() === 'short';
      const who = rejecterOf(t);
      const right = t.r != null && t.r < 0, wrong = t.r != null && t.r > 0;
      const mark = right ? '✓' : wrong ? '✗' : '·';
      const stt = String(t.status || '').toLowerCase();
      const tip = `${who === 'other' ? (t.by || 'unknown') : who} rejected this ${short ? 'short' : 'long'} (entry ${fmtPx(t.entry_px)}, stop ${fmtPx(t.stop_px)}, tp ${fmtPx(t.tp_px)}) · ${stt} at ${fmtR(t.r)} — ${right ? 'the veto saved money' : wrong ? 'the veto blocked a winner' : 'a wash'}`;
      return `<span class="watch-pill ghost-pill ${right ? 'right' : wrong ? 'wrong' : ''}" title="${esc(tip)}">${esc(t.coin || '?')} ${short ? 'S' : 'L'} → ${esc(stt || '?')} <span class="${signClass(t.r)}">${fmtR(t.r)}</span> <span class="ghost-verdict">(${esc(BY_SHORT[who] || (t.by ? String(t.by) : '?'))} ${mark})</span></span>`;
    }).join('') : '';
  }

  // View 2: rejection scoreboard - one compact card per rejecter (✓ saved money vs ✗ blocked winners).
  function renderRejScoreboard(rs) {
    const cards = $id('rej-cards');
    if (!cards) return;
    const emptyEl = $id('shl-score-empty');
    if (emptyEl) emptyEl.hidden = !!rs;
    cards.hidden = !rs;
    if (!rs) { cards.innerHTML = ''; return; }
    cards.innerHTML = REJECTERS.map(([key, label]) => {
      const s = rs[key];
      const pill = `<span class="by-pill ${key === 'all' ? '' : key}">${esc(key === 'all' ? 'all' : BY_SHORT[key] || key)}</span>`;
      const head = `<div class="rej-head">${pill}<span class="rej-title">${esc(label)}</span></div>`;
      if (!s || typeof s !== 'object') return `<div class="rej-card">${head}<div class="muted small rej-empty">no data yet</div></div>`;
      if (!n0(s.resolved)) return `<div class="rej-card">${head}<div class="muted small rej-empty">nothing resolved yet &middot; ${n0(s.open)} open</div></div>`;
      const won = n0(s.vetoed_would_have_won), lost = n0(s.vetoed_would_have_lost);
      const netSaved = s.sum_r_saved != null ? Number(s.sum_r_saved) : s.avg_r_of_vetoed != null ? -s.avg_r_of_vetoed * n0(s.resolved) : null;
      const verdict = String(s.verdict || '').trim();
      const vShort = /EARNING/i.test(verdict) ? '✓ earning its cost' : /TOO STRICT/i.test(verdict) ? '✗ too strict' : '';
      const vcls = /EARNING/i.test(verdict) ? 'good' : /TOO STRICT/i.test(verdict) ? 'warn' : '';
      return `<div class="rej-card">
        ${head}
        <div class="rej-stats">
          <div class="rej-stat" title="rejections that saved money: the trade would have lost"><div class="v ${lost ? 'pos' : ''}">✓ ${lost}</div><div class="l">saved money</div></div>
          <div class="rej-stat" title="rejections that cost a winner: the trade would have won"><div class="v ${won ? 'neg' : ''}">✗ ${won}</div><div class="l">blocked winners</div></div>
          <div class="rej-stat" title="net R the rejections avoided losing (negative = blocking cost money)"><div class="v ${netSaved != null ? signClass(netSaved) : ''}">${netSaved != null ? fmtR(netSaved) : '—'}</div><div class="l">net R saved</div></div>
        </div>
        <div class="rej-meta muted small">${n0(s.resolved)} scored &middot; ${n0(s.open)} open &middot; avg ${fmtR(s.avg_r_of_vetoed)} / rejected trade</div>
        ${vShort ? `<div class="verdict-tag ${vcls}" title="${esc(verdict)}">${esc(vShort)}</div>` : ''}
      </div>`;
    }).join('');
  }

  // Confidence calibration (GET /api/analytics `calibration`): when the model states a confidence bucket,
  // how often is it actually right? negative gap = overconfident. Returns true when the block is shown, so
  // the Lessons tab counts as non-empty even when the learner itself has nothing yet.
  function renderCalibration(calib, buckets) {
    const block = $id('shl-cal-block');
    if (!block) return false;  // served page predates the calibration skeleton
    const body = block.querySelector('#shl-cal-table tbody');
    const sum = $id('shl-cal-sum');
    block.hidden = !buckets.length;
    if (!buckets.length) { if (body) body.innerHTML = ''; if (sum) sum.innerHTML = ''; return false; }
    // red = overconfident by more than 10 pts at that stated level, green = at or above what it claimed.
    const gapCls = (g) => g == null || isNaN(g) ? '' : g < -0.10 ? 'neg' : g >= 0 ? 'pos' : '';
    if (body) body.innerHTML = buckets.map((b) => {
      const nb = n0(b.n);
      const realN = b.real_n != null && !isNaN(b.real_n) ? n0(b.real_n) : null;
      const split = realN != null ? `${realN} real + ${Math.max(0, nb - realN)} shadow` : `${nb} trades`;
      const wr = b.win_rate != null && !isNaN(b.win_rate) ? Math.round(Number(b.win_rate) * 100) : null;
      const gap = b.gap != null && !isNaN(b.gap) ? Number(b.gap) : null;
      const cls = gapCls(gap);
      return `<tr>
        <td data-l="Stated">${esc(b.bucket == null ? '?' : String(b.bucket))}</td>
        <td class="r" data-l="Trades" title="${esc(split)}">${nb}</td>
        <td class="r ${cls}" data-l="Actual win%" title="realized win rate of the ${esc(split)} at this stated confidence">${wr != null ? wr + '%' : '\u2014'}</td>
        <td class="r ${cls}" data-l="Gap" title="actual win rate minus stated confidence; negative = overconfident">${gap != null ? (gap > 0 ? '+' : '') + (gap * 100).toFixed(1) + '%' : '\u2014'}</td>
      </tr>`;
    }).join('');
    if (sum) {
      const samples = calib && calib.samples != null && !isNaN(calib.samples) ? n0(calib.samples) : buckets.reduce((a, b) => a + n0(b.n), 0);
      const split = calib && calib.real != null && calib.shadow != null ? ` (${n0(calib.real)} real + ${n0(calib.shadow)} shadow)` : '';
      let worst = null;  // most overconfident bucket beyond the -10 pt threshold
      for (const b of buckets) { const g = Number(b.gap); if (!isNaN(g) && g < -0.10 && (worst == null || g < worst.g)) worst = { b, g }; }
      if (samples >= 8 && worst) {
        const wwr = Math.round(n0(worst.b.win_rate) * 100), pts = Math.round(-worst.g * 100);
        sum.innerHTML = `${samples} samples${esc(split)} &middot; <span class="cal-warn">&#9888; at stated ${esc(worst.b.bucket == null ? '?' : String(worst.b.bucket))} it wins only ${wwr}% &mdash; overconfident by ${pts} pts</span>`;
      } else {
        sum.innerHTML = `collecting data &mdash; ${samples} sample${samples === 1 ? '' : 's'} so far`;
      }
    }
    return true;
  }

  // View 3: what the learner has extracted - setup scores, the lessons text fed to the LLM, post-mortems.
  const SHL_CTX_N = 6, SHL_PM_N = 3;
  function renderLearnerLessons(ctxs, pms, lessonsTxt, openScored, calib, calibBuckets) {
    const block = $id('shl-ctx-block');
    if (!block) return;
    const calShown = renderCalibration(calib, calibBuckets || []);
    const any = ctxs.length > 0 || pms.length > 0 || !!lessonsTxt || openScored.length > 0 || calShown;
    const emptyEl = $id('shl-lessons-empty');
    if (emptyEl) emptyEl.hidden = any;

    // One-line summary next to the caption.
    const scored = ctxs.filter((c) => n0(c.n) > 0);
    const closed = scored.reduce((a, c) => a + n0(c.n), 0);
    const wins = scored.reduce((a, c) => a + n0(c.wins), 0);
    const pnl = scored.reduce((a, c) => a + (c.total_pnl || 0), 0);
    $id('shl-learn-sum').innerHTML = closed
      ? ` &middot; ${ctxs.length} setups &middot; ${closed} closed &middot; win ${Math.round(wins / closed * 100)}% &middot; realized <span class="${signClass(pnl)} num">${fmtUSD(pnl, true)}</span>`
      : ctxs.length ? ` &middot; ${ctxs.length} setups seen, none closed yet` : '';

    // Setup contexts: compact rows, top N with a "show all" toggle (state.shlCtxAll survives re-render).
    block.hidden = !ctxs.length;
    if (ctxs.length) {
      const showAll = state.shlCtxAll || ctxs.length <= SHL_CTX_N;
      const list = showAll ? ctxs : ctxs.slice(0, SHL_CTX_N);
      const maxQ = Math.max(0.01, ...ctxs.map((c) => Math.abs(c.q || 0)));
      const more = ctxs.length > SHL_CTX_N
        ? `<button type="button" class="shl-more" data-more="ctx">${state.shlCtxAll ? `show top ${SHL_CTX_N}` : `show all ${ctxs.length} setups`}</button>` : '';
      $id('shl-ctx-list').innerHTML = list.map((c) => {
        const n = n0(c.n);
        const wr = n ? Math.round((n0(c.wins) / n) * 100) : null;
        const avgR = n ? (c.total_r || 0) / n : null;
        const w = Math.round((Math.abs(c.q || 0) / maxQ) * 40);
        const mult = c.multiplier != null ? c.multiplier : c.size_multiplier != null ? c.size_multiplier : null;
        return `<div class="ctx-row">
          <span class="ctx-name">${esc(c.ctx)}</span>
          <span class="ctx-q ${signClass(c.q)}" title="the learner's running score for this setup, in R units">${c.q != null ? (c.q > 0 ? '+' : '') + Number(c.q).toFixed(2) + 'R' : '—'}<span class="q-bar" style="width:${w}px;background:${(c.q || 0) >= 0 ? 'var(--good)' : 'var(--bad)'}"></span></span>
          <span class="ctx-meta muted small">${n ? `${n} trade${n === 1 ? '' : 's'} &middot; win ${wr}%${avgR != null ? ` &middot; avg ${fmtR(avgR)}` : ''}` : 'no closed trades yet'}${mult != null ? ` &middot; <span class="ctx-mult" title="size multiplier the learner applies to this setup">size ${Number(mult).toFixed(2)}x</span>` : ''}</span>
        </div>`;
      }).join('') + more;
    } else $id('shl-ctx-list').innerHTML = '';

    // Lessons text fed to the LLM.
    const lb = $id('shl-lessons-block');
    if (lb) lb.hidden = !lessonsTxt;
    if (lessonsTxt) $id('lessons').textContent = lessonsTxt;

    // Open trades still being scored.
    $id('shl-open-note').innerHTML = openScored.length
      ? 'Open trades being scored: ' + openScored.map((o) => `<code>${esc(o.key)}</code> ${esc(o.ctx)} (risk ${fmtUSD(o.risk_usd)})`).join(' &middot; ') : '';

    // Post-mortems (newest first, latest N with a "show all" toggle; state.shlPmAll survives re-render).
    const pb = $id('shl-pmort-block');
    if (pb) pb.hidden = !pms.length;
    if (pms.length) {
      $id('pmort-count').textContent = `(${pms.length})`;
      const showAll = state.shlPmAll || pms.length <= SHL_PM_N;
      const list = showAll ? pms : pms.slice(0, SHL_PM_N);
      const more = pms.length > SHL_PM_N
        ? `<button type="button" class="shl-more" data-more="pm">${state.shlPmAll ? `show latest ${SHL_PM_N}` : `show all ${pms.length}`}</button>` : '';
      $id('postmortems').innerHTML = list.map((p) => {
        const R = p.R != null ? p.R : p.r;
        const side = String(p.side || '').toLowerCase();
        const parts = String(p.lesson || '').split(/\n\s*lesson:\s*/i);
        const body = esc(parts[0].trim()) + (parts.length > 1 ? `<div class="pmort-lesson"><span class="k">Lesson</span>${esc(parts.slice(1).join(' ').trim())}</div>` : '');
        return `<article class="pmort ${R != null ? (R > 0 ? 'win' : 'loss') : ''}">
          <div class="pmort-head">
            <span class="coin">${esc(p.coin || '—')}</span>
            ${side ? `<span class="side-pill ${side === 'short' || side === 'no' ? 'short' : 'long'}">${esc(side.toUpperCase())}</span>` : ''}
            <span class="rtag ${signClass(R)}">${fmtR(R)}</span>
            <span class="num ${signClass(p.pnl)}">${fmtUSD(p.pnl, true)}</span>
            ${p.closed_by ? `<span class="tag tag-${closeClass(p.closed_by)}">${esc(p.closed_by)}</span>` : ''}
            <span class="muted small pmort-when" title="${esc(fmtTime(p.ts))}">${p.ts ? esc(fmtAge(Date.now() / 1000 - p.ts)) + ' ago' : ''}</span>
          </div>
          <div class="pmort-body">${body || '<span class="muted">(no text)</span>'}</div>
        </article>`;
      }).join('') + more;
    }
  }

  // -------------------------------------------------------------- render: decision feed
  function classify(order) {
    if (!order) return 'pending';
    if (order.approved === false) return 'rejected';
    if (order.result && order.result.ok === false) {
      // A limit order that timed out or was canceled at its trigger never traded — soften it from FAILED.
      const d = String(order.result.detail || '');
      return /expired|canceled at trigger/i.test(d) ? 'canceled' : 'failed';
    }
    // ok=true with result.resting means the limit order is parked on the book — nothing has executed yet.
    if (order.result && order.result.ok) return order.result.resting ? 'resting' : 'filled';
    return 'pending';
  }
  const TAG_TEXT = { filled: 'FILLED', resting: 'RESTING', canceled: 'CANCELED', rejected: 'REJECTED', failed: 'FAILED', pending: 'PENDING', hold: 'HOLD', quiet: 'QUIET' };
  const TAG_TITLE = {
    resting: 'Limit order parked on the book, waiting for price to touch — nothing has executed yet',
    canceled: 'Limit order expired or was canceled before filling — no trade happened',
  };
  function tagHTML(cls) { return `<span class="tag tag-${cls}"${TAG_TITLE[cls] ? ` title="${TAG_TITLE[cls]}"` : ''}>${TAG_TEXT[cls]}</span>`; }

  function actionKey(a) { return a ? [a.kind, a.coin || a.market_id || '', a.side || a.outcome || ''].join('|') : ''; }

  // Small coloured tag naming the action type: ENTRY (green), STOP/TARGET (blue), CLOSE (grey). '' when none applies.
  function actionTypeTag(a) {
    const k = a && a.kind;
    if (!k) return '';
    if (ENTRY_KINDS.includes(k)) return '<span class="atag atag-entry" title="Opens a fresh position">ENTRY</span>';
    if (k === 'update_stop' || k === 'pm_update' || k === 'modify_stop') return '<span class="atag atag-level" title="Moves the stop / take-profit on an open position">STOP/TARGET</span>';
    if (['close_perp', 'spot_sell', 'pm_sell'].includes(k)) return '<span class="atag atag-close" title="Reduces or closes an open position">CLOSE</span>';
    return '';
  }

  function actionLine(a) {
    if (!a) return '';
    const k = a.kind || '?';
    const isPM = /^pm_/.test(k) || k === 'buy_pm';
    const isLevelUpd = k === 'update_stop' || k === 'pm_update' || k === 'modify_stop';
    const hasLevels = a.stop_loss_px != null || a.take_profit_px != null;
    const parts = [`<span class="kind">${esc(k)}</span>`];
    if (a.coin) parts.push(`<span>${esc(a.coin)}</span>`);
    if (isPM && a.token_id) parts.push(`<span class="k" title="token">${esc(a.token_id)}</span>`);
    if (a.question && !a.coin) parts.push(`<span>${esc(a.question)}</span>`);
    if (a.side) parts.push(`<span class="${esc(String(a.side).toLowerCase())}">${esc(String(a.side).toUpperCase())}</span>`);
    if (a.outcome) parts.push(`<span><span class="k">outcome</span> ${esc(a.outcome)}</span>`);
    if (a.size_usd != null) parts.push(`<span><span class="k">size</span> ${fmtUSD(a.size_usd)}</span>`);
    if (a.leverage != null) parts.push(`<span><span class="k">lev</span> ${fmtNum(a.leverage, 0)}x</span>`);
    if (a.price != null) parts.push(`<span><span class="k">px</span> ${(a.price * 100).toFixed(1)}¢</span>`);
    if (isLevelUpd && hasLevels) {
      // Show the new stop → target the update sets (label as ¢ on the token price for PM swings).
      const pm = isPM;
      const s = a.stop_loss_px != null ? (pm ? (a.stop_loss_px * 100).toFixed(1) + '¢' : fmtPx(a.stop_loss_px)) : '—';
      const t = a.take_profit_px != null ? (pm ? (a.take_profit_px * 100).toFixed(1) + '¢' : fmtPx(a.take_profit_px)) : '—';
      parts.push(`<span class="lvl-upd"><span class="k">new stop</span> ${s} <span class="arrow">→</span> <span class="k">target</span> ${t}</span>`);
    } else {
      if (a.stop_loss_px != null) parts.push(`<span><span class="k">stop</span> ${isPM ? (a.stop_loss_px * 100).toFixed(1) + '¢' : fmtPx(a.stop_loss_px)}</span>`);
      if (a.take_profit_px != null) parts.push(`<span><span class="k">tp</span> ${isPM ? (a.take_profit_px * 100).toFixed(1) + '¢' : fmtPx(a.take_profit_px)}</span>`);
    }
    if (isPM && hasLevels) parts.push('<span class="atag atag-swing" title="Swing PM trade: stop / target set on the token price">SWING</span>');
    if (a.confidence != null) parts.push(`<span><span class="k">conf</span> ${(a.confidence * 100).toFixed(0)}%</span>`);
    return `<div class="action-line">${parts.join('')}</div>`;
  }

  function renderAction(a, order, cls) {
    let why = '';
    if (cls === 'rejected') why = `<div class="action-why rej">${esc(order.risk_reason || 'rejected by risk gate')}</div>`;
    else if (cls === 'failed') why = `<div class="action-why fail">${esc((order.result && order.result.detail) || 'venue error')}${order.risk_reason ? `\n<span class="muted">${esc(order.risk_reason)}</span>` : ''}</div>`;
    else if (cls === 'canceled') why = `<div class="action-why ok">${esc((order.result && order.result.detail) || 'limit order canceled unfilled')}${order.risk_reason ? `\n${esc(order.risk_reason)}` : ''}</div>`;
    else if (cls === 'filled' || cls === 'resting') why = `<div class="action-why ok">${esc((order.result && order.result.detail) || '')}${order.risk_reason ? `\n${esc(order.risk_reason)}` : ''}</div>`;
    else if (cls === 'pending' && order && order.risk_reason) why = `<div class="action-why ok">${esc(order.risk_reason)}</div>`;
    return `<div class="action ${cls}" data-venue="${esc(actionVenue(a) || '')}">
      <span class="tag-col">${tagHTML(cls)}${actionTypeTag(a)}</span>
      <div class="action-body">
        ${actionLine(a)}
        ${a && a.reason ? `<div class="action-reason">${esc(a.reason)}</div>` : ''}
        ${why}
      </div>
    </div>`;
  }

  function isQuiet(c) { const d = c && c.decision; return !!(d && d.skipped); }
  function skipReason(c) {
    const d = c.decision || {};
    const s = d.skipped;
    if (typeof s === 'string' && s.trim()) return s;
    if (s && typeof s === 'object') return String(s.reason || s.detail || s.why || JSON.stringify(s));
    return d.skip_reason || d.reason || d.notes || 'skipped by the attention gate: market too quiet';
  }
  function cycleKind(c) {
    if (isQuiet(c)) return 'quiet';
    const orders = Array.isArray(c.orders) ? c.orders : [];
    const kinds = orders.map(classify);
    if (kinds.some((k) => k === 'filled' || k === 'resting' || k === 'canceled' || k === 'failed' || k === 'pending')) return 'trade';
    if (kinds.some((k) => k === 'rejected')) return 'rejected';
    if (c.error) return 'error';
    return 'hold';
  }
  function verifierOf(c) {
    const d = c.decision || {};
    const v = d.verifier != null ? d.verifier : d.verifier_comment != null ? d.verifier_comment : d.verification != null ? d.verification : c.verifier;
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() ? { verdict: '', comment: v } : null;
    if (typeof v === 'object') {
      const comment = v.comment || v.notes || v.reason || v.text || '';
      const verdict = v.verdict || v.decision || (v.approved === true ? 'approve' : v.approved === false ? 'reject' : '');
      return comment || verdict ? { verdict: String(verdict || ''), comment: String(comment), model: v.model } : null;
    }
    return null;
  }
  function shortAction(a, cls, order) {
    const bits = [];
    if (a) {
      if (a.kind && !/^(open_perp|buy_pm|hold)$/.test(a.kind)) bits.push(String(a.kind).replace(/_/g, ' '));
      if (a.coin) bits.push(a.coin);
      if (a.side) bits.push(String(a.side).toUpperCase());
      if (a.outcome) bits.push(a.outcome + (a.question ? ' · ' + a.question.slice(0, 40) + (a.question.length > 40 ? '…' : '') : ''));
      if (a.size_usd != null) bits.push(fmtUSD(a.size_usd));
      if (a.leverage != null) bits.push(fmtNum(a.leverage, 0) + 'x');
      if (a.stop_loss_px != null && /stop/.test(a.kind || '')) bits.push('→ ' + fmtPx(a.stop_loss_px));
    }
    let why = '';
    if (cls === 'rejected') why = String((order && order.risk_reason) || 'blocked by risk gate').replace(/^rejected:?\s*/i, '').split('|')[0].trim();
    else if (cls === 'failed') why = (order && order.result && order.result.detail) || 'venue error';
    else if (cls === 'resting' || cls === 'canceled') why = (order && order.result && order.result.detail) || '';
    else if (cls === 'hold') why = (a && a.reason) || '';
    return `${tagHTML(cls)}<span class="sum-text">${esc(bits.join(' '))}${why ? `<span class="sum-why">${bits.length ? ' · ' : ''}${esc(why.length > 70 ? why.slice(0, 68) + '…' : why)}</span>` : ''}</span>`;
  }

  // Empty-state copy per venue+kind combination.
  function feedEmptyHTML() {
    const kind = state.feedKind, venue = state.feedVenue;
    const vl = venue === 'pm' ? 'PM' : 'crypto';
    const loop = (state.config && state.config.loop_interval_seconds) || 300;
    let title, sub;
    switch (kind) {
      case 'new':
        title = `No new ${vl} trades yet`;
        sub = venue === 'pm' ? 'Filled Polymarket entries (pm_buy) show up here as soon as the agent opens a prediction-market position.'
                             : 'Filled Hyperliquid entries (open_perp, spot_buy) show up here as soon as the agent opens a position.';
        break;
      case 'updates':
        title = `No ${vl} stop/target updates yet`;
        sub = venue === 'pm' ? 'PM management fills — stop/target moves, sells and closes — appear here once the agent adjusts an open prediction-market position.'
                             : 'Perp/spot management fills — stop/target moves, closes and sells — appear here once the agent adjusts an open position.';
        break;
      case 'rejected':
        title = `No rejected ${vl} trades yet`;
        sub = `${vl === 'PM' ? 'Prediction-market' : 'Perp/spot'} proposals blocked by the verifier, the risk gate or the reward-risk check show up here.`;
        break;
      case 'holds':
        title = 'No holds yet';
        sub = 'Cycles where the model was consulted and chose not to trade appear here (all markets — the same across Crypto and PM).';
        break;
      case 'quiet':
        title = 'No quiet cycles yet';
        sub = 'Cycles skipped by the attention gate because the market was too quiet appear here (all markets — the same across Crypto and PM).';
        break;
      case 'errors':
        title = 'No errors yet';
        sub = 'Cycles where the cycle itself or the proposer model failed appear here (all markets — the same across Crypto and PM).';
        break;
      default:
        title = `No ${vl} decisions yet`;
        sub = `Cycles appear here as the agent runs — the first within ${fmtAge(loop)} of it starting, each with the model's reasoning.`;
    }
    return `<div class="empty-state"><div class="empty-title">${esc(title)}</div><div class="empty-sub">${esc(sub)}</div></div>`;
  }

  function renderFeed() {
    const feed = $id('feed');
    const key = feedKey();
    const meta = FEED_KINDS[state.feedKind] || FEED_KINDS.all;
    if (!(key in state.feedCycles)) {
      if (state.feedLoading === key) {
        feed.innerHTML = `<div class="empty-state"><div class="empty-title">Loading…</div><div class="empty-sub">Fetching the latest ${FEED_LIMIT} ${esc(meta.label)} cycles for ${state.feedVenue === 'pm' ? 'PM' : 'Crypto'}.</div></div>`;
        return;
      }
      if (state.feedErr) {
        feed.innerHTML = `<div class="empty-state"><div class="empty-title">Could not load this view</div><div class="empty-sub">${esc(state.feedErr)}. Tap the chip again to retry.</div></div>`;
        return;
      }
    }
    // Cycle SET is server-filtered by venue+kind; here we only filter ROWS within each cycle to the venue/category.
    const pred = feedRowPred();
    const cycles = state.feedCycles[key] || [];
    if (!cycles.length) {
      feed.innerHTML = feedEmptyHTML();
      return;
    }
    // Only the 'All' sub-chip collapses runs of consecutive quiet cycles; dedicated views render every card.
    feed.innerHTML = state.feedKind === 'all'
      ? renderAllFeedHTML(cycles, pred)
      : cycles.map((c) => cycleCardHTML(c, pred)).join('');
  }

  // One cycle card (<details>) — extracted from renderFeed so the 'All' view's expanded quiet runs reuse it.
  function cycleCardHTML(c, pred) {
      const d = c.decision || {};
      const actions = Array.isArray(d.actions) ? d.actions : [];
      const orders = Array.isArray(c.orders) ? c.orders : [];
      const kind = cycleKind(c);
      // Orders are the authoritative record; decision actions without an order render as HOLD / PENDING.
      const used = new Set();
      const items = [];
      for (const o of orders) items.push({ a: o.action, o, cls: classify(o) });
      for (const a of actions) {
        const k = actionKey(a);
        const matched = orders.find((o, i) => !used.has(i) && actionKey(o.action) === k);
        if (matched) { used.add(orders.indexOf(matched)); continue; }
        const isHold = !a.kind || /hold|wait|none|noop/i.test(a.kind);
        items.push({ a, o: null, cls: isHold ? 'hold' : 'pending' });
      }
      if (!items.length) items.push({ a: null, o: null, cls: kind === 'quiet' ? 'quiet' : c.error ? 'failed' : 'hold', synthetic: true });
      // Row filter: within the selected venue, hide the other venue's order rows (and, for New/Updates, the wrong
      // category). Synthetic and decision-only (order-less) rows — holds/quiet/errors — are always kept.
      const viewItems = pred ? items.filter((it) => it.synthetic || !it.o || pred(it.o)) : items;
      const shown = viewItems.slice(0, 2);
      const skip = kind === 'quiet' ? skipReason(c) : '';
      // cheap position-manager review of the open positions this cycle (decision.managed)
      const mg = d.managed && typeof d.managed === 'object' ? d.managed : null;
      const mgActs = mg ? (Number(mg.actions) || 0) : 0;
      let summary = shown.map((it) => !it.synthetic ? shortAction(it.a, it.cls, it.o)
        : kind === 'quiet' ? (mg
          ? `<span class="tag tag-quiet">QUIET</span><span class="sum-text sum-why" title="${esc(skip)}">entry quiet · manager reviewed</span>`
          : `<span class="tag tag-quiet">QUIET</span><span class="sum-text sum-why">${esc(skip.length > 70 ? skip.slice(0, 68) + '…' : skip)}</span>`)
        : c.error ? `<span class="tag tag-failed">ERROR</span><span class="sum-text sum-why">${esc(c.error.slice(0, 70))}</span>`
        : `<span class="tag tag-hold">HOLD</span><span class="sum-text sum-why">no actions this cycle</span>`).join('');
      if (viewItems.length > 2) summary += `<span class="sum-more">+${viewItems.length - 2} more</span>`;
      // event-fired cycle: decision.wake says why it ran (empty/missing = scheduled heartbeat)
      const wake = d.wake ? String(d.wake).trim() : '';
      if (wake) summary += `<span class="wake-badge" title="${esc(wake)}">⚡ ${esc(wake.length > 60 ? wake.slice(0, 59) + '…' : wake)}</span>`;
      // position manager reviewed the open positions this cycle (cheap model; actions = changes it made)
      if (mg) summary += `<span class="managed-badge" title="${esc((mg.due ? String(mg.due) : '') + ' — ' + (mg.view ? String(mg.view) : ''))}">🛡 manager${mgActs > 0 ? ` · ${mgActs} action${mgActs === 1 ? '' : 's'}` : ''}</span>`;
      const rows = viewItems.filter((it) => !it.synthetic).map((it) => renderAction(it.a, it.o, it.cls));
      if (!rows.length) rows.push(kind === 'quiet'
        ? `<div class="action quiet"><span class="tag tag-quiet">QUIET</span><div class="action-body muted">${mg ? 'Entry model skipped' : 'Skipped'} by the attention gate — ${esc(skip)}${mg ? ` · position manager reviewed${mgActs > 0 ? ` (${mgActs} action${mgActs === 1 ? '' : 's'})` : ' — all fine'}` : ''}</div></div>`
        : `<div class="action hold"><span class="tag tag-hold">HOLD</span><div class="action-body muted">No actions this cycle.</div></div>`);
      const ver = verifierOf(c);
      const open = state.feedOpen.has(String(c.id));
      return `<details class="cycle kind-${kind}" data-id="${esc(c.id)}"${open ? ' open' : ''}>
        <summary class="cycle-sum">
          <span class="ctime" title="${esc(fmtTime(c.ts))}">${esc(fmtClock(c.ts))}</span>
          <span class="csummary">${summary}</span>
          <span class="ceq" title="equity after this cycle">${fmtUSD(c.equity)}</span>
          <span class="chev" aria-hidden="true"></span>
        </summary>
        <div class="cycle-body">
          <div class="cycle-head"><span class="cid">cycle #${esc(c.id)}</span><span>${esc(fmtTime(c.ts))}</span><span class="muted">${esc(fmtAge(Date.now() / 1000 - c.ts))} ago</span></div>
          ${c.error ? `<div class="cycle-error">error: ${esc(c.error)}</div>` : ''}
          ${d.market_view ? `<div class="market-view"><span class="k">Model's view</span>${esc(d.market_view)}</div>` : kind === 'quiet' ? `<div class="market-view muted">(entry model not consulted — the attention gate skipped this cycle${mg ? '; the position manager reviewed the open positions' : ''})</div>` : (!c.error ? '<div class="market-view muted">(no market view recorded)</div>' : '')}
          ${d.notes ? `<div class="notes"><span class="k">Notes</span>${esc(d.notes)}</div>` : ''}
          ${ver ? `<blockquote class="verifier ${esc(ver.verdict.toLowerCase().replace(/[^a-z]/g, ''))}"><span class="vlabel">Verifier${ver.model ? ' · ' + esc(ver.model) : ''}${ver.verdict ? ` · <b>${esc(ver.verdict.toUpperCase())}</b>` : ''}</span>${esc(ver.comment)}</blockquote>` : ''}
          <div class="actions">${rows.join('')}</div>
        </div>
      </details>`;
  }

  // ---- 'All' view only: collapse each run of 2+ consecutive quiet cycles into one compact expandable row ----
  // Quiet = skipped by the attention gate with no order rows to render (single quiet cycles render normally).
  function isCollapsibleQuiet(c, pred) {
    if (!isQuiet(c)) return false;
    const orders = Array.isArray(c.orders) ? c.orders : [];
    return !(pred ? orders.some(pred) : orders.length > 0);
  }
  function renderAllFeedHTML(cycles, pred) {
    const out = [];
    let i = 0;
    while (i < cycles.length) {
      if (!isCollapsibleQuiet(cycles[i], pred)) { out.push(cycleCardHTML(cycles[i], pred)); i += 1; continue; }
      let j = i + 1;
      while (j < cycles.length && isCollapsibleQuiet(cycles[j], pred)) j += 1;
      const run = cycles.slice(i, j);
      out.push(run.length >= 2 ? quietRunHTML(run, pred) : cycleCardHTML(run[0], pred));
      i = j;
    }
    return out.join('');
  }
  function quietRunHTML(run, pred) {
    // The feed is newest-first: run[0] is the newest cycle, run[run.length - 1] the oldest.
    const key = String(run[0].id);
    const open = state.feedQuietOpen.has(key);
    const from = fmtClock(run[run.length - 1].ts), to = fmtClock(run[0].ts);
    const managed = run.filter((c) => c.decision && c.decision.managed && typeof c.decision.managed === 'object').length;
    const label = `${run.length} quiet cycles · ${from}–${to}` + (managed ? ` · ${managed} manager review${managed === 1 ? '' : 's'}` : '');
    return `<div class="quiet-run${open ? ' open' : ''}">
      <button type="button" class="quiet-run-row muted small" data-run="${esc(key)}" aria-expanded="${open ? 'true' : 'false'}" title="${open ? 'Collapse' : 'Expand'} ${run.length} consecutive quiet cycles">
        <span class="qr-chev" aria-hidden="true">${open ? '▾' : '▸'}</span><span>${esc(label)}</span>
      </button>
      ${open ? run.map((c) => cycleCardHTML(c, pred)).join('') : ''}
    </div>`;
  }
  // Remember which cycles the user expanded so polling re-renders don't collapse them ('toggle' does not bubble: use capture).
  $id('feed').addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement)) return;
    if (d.open) state.feedOpen.add(d.dataset.id); else state.feedOpen.delete(d.dataset.id);
  }, true);
  // 'All' view: expand/collapse a compact quiet-run row in place (state survives the 60s poll re-render).
  $id('feed').addEventListener('click', (e) => {
    const b = e.target.closest('.quiet-run-row');
    if (!b) return;
    const key = b.dataset.run;
    if (state.feedQuietOpen.has(key)) state.feedQuietOpen.delete(key); else state.feedQuietOpen.add(key);
    renderFeed();
  });
  // Shadow & learner panel: view tabs (active tab survives the poll re-render, like the feed chips).
  $id('shl-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.fchip');
    if (!b) return;
    state.shadowTab = b.dataset.view || 'live';
    renderShadowLearner();
  });
  // "Show all / show top" toggles inside the Lessons view (also survive the poll re-render).
  $id('shadowtr-panel').addEventListener('click', (e) => {
    const b = e.target.closest('.shl-more');
    if (!b) return;
    if (b.dataset.more === 'ctx') state.shlCtxAll = !state.shlCtxAll;
    else if (b.dataset.more === 'pm') state.shlPmAll = !state.shlPmAll;
    renderShadowLearner();
  });
  // Venue tabs (Crypto / PM) — the feed's top axis.
  $id('feed-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.ftab');
    if (!b) return;
    $id('feed-tabs').querySelectorAll('.ftab').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
    state.feedVenue = b.dataset.venue === 'pm' ? 'pm' : 'crypto';
    selectFeed();
  });
  // Kind sub-chips (All / New / Updates / Rejected / Holds / Quiet / Errors) — the feed's second axis.
  $id('feed-subchips').addEventListener('click', (e) => {
    const b = e.target.closest('.fchip');
    if (!b) return;
    $id('feed-subchips').querySelectorAll('.fchip').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
    state.feedKind = b.dataset.kind;
    selectFeed();
  });

  // -------------------------------------------------------------- render: performance (GET /api/analytics)
  const NO_TRADES = 'No closed trades yet — stats appear after the first stop/TP/close';
  const VENUE_LABEL = { perps: 'Perps', spot: 'Spot', prediction_markets: 'Prediction mkts', pm: 'Prediction mkts' };
  const VENUE_ORDER = ['perps', 'spot', 'prediction_markets', 'pm'];
  const REASON_LABEL = { stop: 'Stop hit', take_profit: 'Take-profit', tp: 'Take-profit', agent: 'Agent close', stale: 'Stale / timeout', kill: 'Kill switch', liquidation: 'Liquidated' };
  const REASON_ORDER = ['stop', 'take_profit', 'tp', 'agent', 'stale', 'kill', 'liquidation'];

  function fmtR(r) { return r == null || isNaN(r) ? '—' : (r > 0 ? '+' : '') + Number(r).toFixed(2) + 'R'; }
  // profit_factor may be null (no trades), a number, or a non-number standing in for Infinity (no losses yet).
  function fmtPF(pf) {
    if (pf == null) return '—';
    if (typeof pf === 'number') return isFinite(pf) ? pf.toFixed(2) : '∞';
    const n = parseFloat(String(pf));
    return isNaN(n) || !isFinite(n) ? '∞' : n.toFixed(2);
  }
  function closeClass(cb) {
    const s = String(cb || '').toLowerCase();
    if (/stop/.test(s)) return 'stop';
    if (/take.?profit|\btp\b|target/.test(s)) return 'tp';
    if (/stale|expir|timeout|time-out/.test(s)) return 'stale';
    if (/kill|liquidat|halt/.test(s)) return 'kill';
    return 'agent';
  }
  function setTile(id, value, cls, sub) {
    const v = $id(id); v.textContent = value; v.className = 'stat-value' + (cls ? ' ' + cls : '');
    const s = $id(id + '-sub'); if (s) s.textContent = sub || '';
  }
  function n0(x) { return x == null || isNaN(x) ? 0 : Number(x); }

  // Rows for the by-venue / by-coin / by-close-reason tables. Returns null when there is nothing to show.
  function breakdownRows(map, order, labels, colLabel) {
    if (!map || typeof map !== 'object') return null;
    const keys = Object.keys(map).filter((k) => map[k] && typeof map[k] === 'object' && n0(map[k].trades) > 0);
    if (!keys.length) return null;
    const rank = (k) => { const i = order ? order.indexOf(k) : -1; return i < 0 ? 99 : i; };
    keys.sort((a, b) => (rank(a) - rank(b)) || (n0(map[b].trades) - n0(map[a].trades)) || (n0(map[b].pnl) - n0(map[a].pnl)));
    return keys.map((k) => {
      const r = map[k], n = n0(r.trades);
      const wr = r.wins != null && n ? (n0(r.wins) / n) * 100 : null;
      return `<tr>
        <td class="coin" data-l="${esc(colLabel)}">${esc((labels && labels[k]) || k.replace(/_/g, ' '))}</td>
        <td class="r" data-l="Trades">${n}</td>
        <td class="r" data-l="Win %">${wr == null ? '<span class="muted">—</span>' : wr.toFixed(0) + '%'}</td>
        <td class="r ${signClass(r.pnl)}" data-l="PnL">${fmtUSD(r.pnl, true)}</td>
      </tr>`;
    }).join('');
  }

  function renderPerformance() {
    const A = state.analytics;
    const meta = $id('perf-meta');
    const empty = $id('perf-empty');
    empty.hidden = !!A;
    $id('perf-body').hidden = !A;
    if (!A) {
      meta.textContent = '';
      empty.querySelector('.empty-sub').textContent = state.analyticsErr
        ? `GET /api/analytics failed: ${state.analyticsErr}. Retrying every 60 s.`
        : 'Stats appear after the agent\'s first cycle. Closed-trade statistics need at least one stop, take-profit or close.';
      state.dailyRows = [];
      return;
    }
    const E = A.equity || {}, T = A.trades || {}, C = A.cost || {}, ACT = A.activity || {};
    const closed = n0(T.closed);

    const bits = [];
    if (A.days != null) bits.push(`${fmtNum(A.days, 1)} d${A.since_ts ? ' since ' + fmtTime(A.since_ts) : ''}`);
    bits.push(`${closed} closed trade${closed === 1 ? '' : 's'}`);
    if (E.points != null) bits.push(`${E.points} equity pts`);
    if (A.paper_assumptions) bits.push(`paper fills: fee ${fmtNum(A.paper_assumptions.fee_bps, 1)} bps · slippage ${fmtNum(A.paper_assumptions.slippage_bps, 0)} bps`);
    if (A.as_of) bits.push('as of ' + fmtClock(A.as_of));
    if (state.analyticsErr) bits.push(`stale — last refresh failed: ${state.analyticsErr}`);
    meta.textContent = bits.join(' · ');
    meta.classList.toggle('warn', !!state.analyticsErr);

    // --- stat tiles
    setTile('pf-realized', fmtUSD(E.realized, true), signClass(E.realized),
      E.pnl_total != null ? `total ${fmtUSD(E.pnl_total, true)}${E.multiple != null ? ' · ' + fmtMult(E.multiple) : ''}` : 'locked in on closed trades');
    setTile('pf-unrealized', fmtUSD(E.unrealized, true), signClass(E.unrealized), 'open positions at current mark');
    const wins = n0(T.wins), losses = n0(T.losses);
    const wr = closed ? (T.win_rate_pct != null ? T.win_rate_pct : (wins / closed) * 100) : null;
    setTile('pf-winrate', wr == null ? '—' : wr.toFixed(0) + '%', wr == null ? '' : wr >= 50 ? 'pos' : wr < 35 ? 'neg' : '',
      closed ? `${wins} W / ${losses} L · ${closed} closed` : 'no closed trades yet');
    const pf = fmtPF(closed ? T.profit_factor : null);
    setTile('pf-pf', pf, pf === '—' ? '' : (pf === '∞' || parseFloat(pf) >= 1) ? 'pos' : 'neg',
      closed ? `avg win ${fmtUSD(T.avg_win, true)} · avg loss ${fmtUSD(T.avg_loss, true)}` : 'gross wins ÷ gross losses');
    setTile('pf-expect', closed ? fmtUSD(T.expectancy_per_trade, true) : '—', closed ? signClass(T.expectancy_per_trade) : '',
      closed ? `best ${fmtUSD(T.largest_win, true)} · worst ${fmtUSD(T.largest_loss, true)}` : 'average result per closed trade');
    const dd = E.max_drawdown_usd != null ? Math.abs(E.max_drawdown_usd) : null;
    setTile('pf-dd', dd == null ? '—' : dd === 0 ? fmtUSD(0) : '-' + fmtUSD(dd), dd ? 'neg' : '',
      E.max_drawdown_pct != null ? `${fmtPct(-Math.abs(E.max_drawdown_pct))} peak → trough` : 'largest peak-to-trough dip');
    setTile('pf-llm-day', fmtCost(C.llm_usd_per_day), '',
      C.llm_usd_total != null ? `total ${fmtCost(C.llm_usd_total)}${A.days != null ? ' over ' + fmtNum(A.days, 1) + ' d' : ''}` : 'model calls, all roles');
    const ratio = C.pnl_per_llm_usd;
    const ratioNum = typeof ratio === 'number' && isFinite(ratio) ? ratio : null;
    const ratioInf = ratio != null && ratioNum == null;   // e.g. "Infinity" when nothing was spent
    setTile('pf-pnl-llm', ratio == null ? '—' : ratioInf ? '∞' : (ratioNum >= 0 ? '+' : '-') + '$' + Math.abs(ratioNum).toFixed(2),
      ratio == null ? '' : (ratioInf || ratioNum >= 1) ? 'pos' : 'neg',
      ratio == null ? 'needs LLM spend and PnL' : `per $1 of LLM · ${fmtUSD(C.pnl_per_day, true)}/day PnL vs ${fmtCost(C.llm_usd_per_day)}/day LLM`);
    const rTile = $id('pf-pnl-llm-tile');
    rTile.title = C.note || 'pnl_per_llm_usd < 1 means the model costs more than it earns';
    rTile.classList.toggle('tile-good', ratio != null && (ratioInf || ratioNum >= 1));
    rTile.classList.toggle('tile-bad', ratioNum != null && ratioNum < 1);

    // --- activity strip
    const rb = ACT.rejected_by || {};
    const actItems = A.activity ? [
      ['cycles', ACT.cycles, 'decision cycles run', ''],
      ['quiet-skipped', ACT.quiet_skipped, 'market too quiet to trade', ''],
      ['proposals', ACT.trade_proposals, 'times the model wanted to trade', ''],
      ['rejected', ACT.rejected, `verifier ${n0(rb.verifier)} · gate ${n0(rb.risk_gate)} · RR ${n0(rb.rr_model)}${rb.other ? ' · other ' + n0(rb.other) : ''}`, n0(ACT.rejected) ? 'warn' : ''],
      ['fills', ACT.fills, 'orders executed', n0(ACT.fills) ? 'good' : ''],
      ['proposer failures', ACT.proposer_failures, 'model errors / bad output', n0(ACT.proposer_failures) ? 'bad' : ''],
    ] : [];
    $id('perf-activity').innerHTML = actItems.length ? actItems.map(([l, v, sub, cls]) =>
      `<div class="act ${cls}"><div class="act-v">${v == null ? '—' : Number(v).toLocaleString('en-US')}</div><div class="act-l">${esc(l)}</div><div class="act-s">${esc(sub)}</div></div>`).join('')
      : '<div class="empty-state compact"><div class="empty-sub">No activity recorded yet — counters fill in after the first cycle.</div></div>';

    // --- breakdown tables
    const fillTbl = (id, rows) => { $id(id).querySelector('tbody').innerHTML = rows || emptyRow(4, NO_TRADES); };
    fillTbl('bv-venue-table', breakdownRows(T.by_venue, VENUE_ORDER, VENUE_LABEL, 'Venue'));
    fillTbl('bv-coin-table', breakdownRows(T.by_coin, null, null, 'Coin'));
    fillTbl('bv-reason-table', breakdownRows(T.by_close_reason, REASON_ORDER, REASON_LABEL, 'Reason'));

    // --- daily PnL bars
    renderDailyChart(Array.isArray(A.daily) ? A.daily : []);

    // --- recent closed trades (newest first)
    const rec = Array.isArray(T.recent) ? T.recent.slice().sort((a, b) => n0(b.ts) - n0(a.ts)) : [];
    $id('recent-count').textContent = rec.length ? `(${rec.length})` : '';
    $id('recent-table').querySelector('tbody').innerHTML = rec.length ? rec.map((t) => {
      const cb = String(t.closed_by || '').trim();
      const cls = closeClass(cb || t.reason);
      const kind = String(t.kind || '').replace(/_/g, ' ');
      const venue = t.venue ? (VENUE_LABEL[t.venue] || t.venue) : '';
      return `<tr>
        <td class="muted small nowrap" data-l="When" title="${esc(fmtTime(t.ts))} · ${esc(fmtAge(Date.now() / 1000 - n0(t.ts)))} ago">${esc(fmtTime(t.ts))}</td>
        <td class="span2" data-l="Trade"><span class="coin">${esc(t.coin || t.market || t.question || '—')}</span>${t.side ? ` <span class="side-pill ${esc(String(t.side).toLowerCase())}">${esc(String(t.side).toUpperCase())}</span>` : ''} <span class="muted small">${esc([kind, venue].filter(Boolean).join(' · '))}</span>${t.detail ? `<div class="small muted trade-detail">${esc(t.detail)}</div>` : ''}</td>
        <td class="r ${signClass(t.pnl)}" data-l="PnL">${fmtUSD(t.pnl, true)}${t.r != null ? `<br><span class="small">${fmtR(t.r)}</span>` : ''}</td>
        <td data-l="Closed by"><span class="tag tag-${cls}">${esc(cb || REASON_LABEL[t.reason] || '—')}</span></td>
      </tr>`;
    }).join('') : emptyRow(4, NO_TRADES);
  }

  // Exit quality: stop-out counterfactuals from status.exit_quality — for each stop-out, the max
  // favorable excursion in the 4h AFTER the exit and whether the original TP would still have hit.
  function renderExitQuality() {
    const rows = Array.isArray(state.status && state.status.exit_quality) ? state.status.exit_quality : [];
    const block = $id('exit-quality-block');
    block.hidden = !rows.length;
    if (!rows.length) return;
    $id('xq-count').textContent = `(${rows.length})`;
    $id('xq-table').querySelector('tbody').innerHTML = rows.map((r) => {
      const side = String(r.side || '').toLowerCase();
      const tp = r.tp_hit === true ? '<span class="pos">✓</span>' : r.tp_hit === false ? '<span class="neg">✗</span>' : '<span class="muted">—</span>';
      return `<tr>
        <td class="coin" data-l="Coin">${esc(r.coin)}</td>
        <td data-l="Side">${side ? `<span class="side-pill ${esc(side)}">${esc(side.toUpperCase())}</span>` : '<span class="muted">—</span>'}</td>
        <td class="muted small nowrap" data-l="When" title="${esc(fmtTime(r.exit_ts))} · ${esc(fmtAge(Date.now() / 1000 - n0(r.exit_ts)))} ago">${r.exit_ts ? esc(fmtClock(r.exit_ts)) : '—'}</td>
        <td class="r ${signClass(r.mfe_pct)}" data-l="MFE after exit" title="max favorable move in the 4h after the exit — positive = the trade kept going the right way">${fmtPct(r.mfe_pct, 1)}</td>
        <td class="r" data-l="TP would have hit">${tp}</td>
      </tr>`;
    }).join('');
  }

  function chartColors() {
    const css = getComputedStyle(document.documentElement);
    const g = (k, d) => css.getPropertyValue(k).trim() || d;
    return { grid: g('--border', '#262b36'), text2: g('--text-2', '#a4abb8'), text3: g('--text-3', '#6e7684'), good: g('--good', '#22b14c'), bad: g('--bad', '#e04b4b'), surface2: g('--surface-2', '#1b1f27'), text: g('--text', '#e8eaee'), mono: g('--mono', 'monospace') };
  }
  function dayLabel(d) {
    if (!d) return '';
    const dt = new Date(String(d.day || d.date || '') + 'T00:00:00Z');
    return isNaN(dt) ? String(d.day || '') : dt.toLocaleDateString(undefined, { month: 'short', day: '2-digit', timeZone: 'UTC' });
  }
  function ensureDailyChart() {
    if (state.dailyChart || typeof window.Chart === 'undefined') return state.dailyChart;
    const c = chartColors();
    state.dailyChart = new window.Chart($id('daily-chart').getContext('2d'), {
      type: 'bar',
      data: { labels: [], datasets: [{ label: 'Daily PnL', data: [], backgroundColor: [], borderColor: [], borderWidth: 1, borderRadius: 3, maxBarThickness: 46 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: c.surface2, borderColor: c.grid, borderWidth: 1, titleColor: c.text2, bodyColor: c.text, displayColors: false, padding: 10,
            callbacks: {
              title: (items) => items.length ? `${items[0].label} (UTC day)` : '',
              label: (item) => {
                const d = state.dailyRows[item.dataIndex] || {};
                const pct = d.open ? ` (${fmtPct((d.close / d.open - 1) * 100)})` : '';
                return [`PnL ${fmtUSD(d.pnl, true)}${pct}`, `open ${fmtUSD(d.open)} → close ${fmtUSD(d.close)}`, `low ${fmtUSD(d.low)} · high ${fmtUSD(d.high)}`];
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { color: c.grid }, ticks: { color: c.text3, font: { size: 11 }, maxRotation: 0, autoSkip: true } },
          y: { position: 'right', beginAtZero: true, grace: '10%', grid: { color: c.grid, drawTicks: false }, border: { display: false },
               ticks: { color: c.text3, maxTicksLimit: 5, font: { size: 11 }, callback: (v) => (v > 0 ? '+' : v < 0 ? '-' : '') + '$' + Math.abs(Number(v)).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 10 ? 2 : 0 }) } },
        },
      },
    });
    return state.dailyChart;
  }
  function renderDailyChart(rows) {
    rows = (rows || []).filter((d) => d && (d.day || d.date)).slice().sort((a, b) => String(a.day || a.date).localeCompare(String(b.day || b.date)));
    state.dailyRows = rows;
    $id('daily-empty').hidden = rows.length > 0;
    const chart = ensureDailyChart();
    const c = chartColors();
    if (chart) {
      chart.data.labels = rows.map(dayLabel);
      const ds = chart.data.datasets[0];
      ds.data = rows.map((d) => n0(d.pnl));
      ds.backgroundColor = rows.map((d) => n0(d.pnl) >= 0 ? c.good + 'aa' : c.bad + 'aa');
      ds.borderColor = rows.map((d) => n0(d.pnl) >= 0 ? c.good : c.bad);
      chart.update('none');
      return;
    }
    // Chart.js unavailable (CDN blocked): draw plain bars so the panel still reads.
    const canvas = $id('daily-chart'), wrap = canvas.parentElement, dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const x = canvas.getContext('2d'); x.scale(dpr, dpr); x.clearRect(0, 0, W, H);
    if (!rows.length) return;
    const padT = 8, padB = 20, padR = 56, padL = 8;
    const maxAbs = Math.max(0.01, ...rows.map((d) => Math.abs(n0(d.pnl))));
    const zeroY = padT + (H - padT - padB) / 2, half = (H - padT - padB) / 2;
    x.strokeStyle = c.grid; x.beginPath(); x.moveTo(padL, zeroY); x.lineTo(W - padR, zeroY); x.stroke();
    const slot = (W - padL - padR) / rows.length, bw = Math.min(46, slot * 0.6);
    x.font = '11px ' + c.mono; x.fillStyle = c.text3; x.textAlign = 'left';
    x.fillText('+' + fmtUSD(maxAbs), W - padR + 6, padT + 10); x.fillText('-' + fmtUSD(maxAbs), W - padR + 6, H - padB);
    rows.forEach((d, i) => {
      const v = n0(d.pnl), h = (Math.abs(v) / maxAbs) * half, bx = padL + slot * i + (slot - bw) / 2;
      x.fillStyle = v >= 0 ? c.good : c.bad;
      x.fillRect(bx, v >= 0 ? zeroY - h : zeroY, bw, Math.max(1, h));
      x.fillStyle = c.text3; x.textAlign = 'center'; x.fillText(dayLabel(d), bx + bw / 2, H - 6);
    });
    canvas.title = rows.map((d) => `${d.day}: ${fmtUSD(d.pnl, true)} (open ${fmtUSD(d.open)} → close ${fmtUSD(d.close)})`).join('\n');
  }

  // -------------------------------------------------------------- render: risk / config
  const RISK_LABELS = {
    max_leverage: ['Max leverage', 'x'], max_position_pct_equity: ['Max position', '% eq'], max_gross_exposure_pct: ['Max gross exposure', '% eq'],
    max_open_positions: ['Max open positions', ''], max_daily_loss_pct: ['Daily loss halt', '%'], max_drawdown_pct: ['Drawdown kill', '%'],
    require_stop_loss: ['Stop required', ''], max_stop_distance_pct: ['Max stop distance', '%'], min_seconds_between_orders: ['Order cooldown', 's'],
    max_orders_per_hour: ['Max orders / hour', ''], min_order_usd: ['Min order', 'USD'], prediction_market_max_pct_equity: ['PM max per market', '% eq'],
    prediction_market_max_total_pct: ['PM max total', '% eq'], min_equity_usd: ['Min equity', 'USD'],
  };
  const RR_LABELS = { min_reward_risk: ['Min reward:risk', ''], max_risk_per_trade_pct: ['Max risk / trade', '% eq'], kelly_fraction: ['Kelly fraction', ''], pm_min_edge: ['PM min edge', ''] };
  const LEARNER_LABELS = { enabled: ['Enabled', ''], alpha: ['EMA alpha', ''], min_samples: ['Min samples', ''], min_multiplier: ['Min multiplier', 'x'], max_multiplier: ['Max multiplier', 'x'] };

  function kvCards(obj, labels, eq) {
    if (!obj) return '<div class="empty-state compact"><div class="empty-sub">Limits load from the agent\'s config once it is reachable.</div></div>';
    const keys = Object.keys(labels).filter((k) => k in obj).concat(Object.keys(obj).filter((k) => !(k in labels)));
    return keys.map((k) => {
      const [label, unit] = labels[k] || [k.replace(/_/g, ' '), ''];
      const v = obj[k];
      if (typeof v === 'boolean') return `<div class="kv kv-flag ${v ? '' : 'off'}"><div class="k">${esc(label)}</div><div class="v">${v ? 'YES' : 'NO'}</div></div>`;
      let extra = '';
      if (eq && unit === '% eq' && typeof v === 'number') extra = `<span class="unit">= ${fmtUSD(eq * v / 100)}</span>`;
      return `<div class="kv"><div class="k">${esc(label)}</div><div class="v">${typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : esc(String(v))}<span class="unit">${esc(unit)}</span>${extra}</div></div>`;
    }).join('');
  }

  function renderConfig() {
    const cfg = state.config;
    const eq = state.status && state.status.equity;
    $id('risk-grid').innerHTML = kvCards(cfg && cfg.risk, RISK_LABELS, eq);
    $id('rr-grid').innerHTML = kvCards(cfg && cfg.rr, RR_LABELS, eq);
    $id('learner-cfg-grid').innerHTML = kvCards(cfg && cfg.learner, LEARNER_LABELS);
    const meta = [];
    if (cfg) {
      if (cfg.mode) meta.push('mode ' + cfg.mode);
      if (cfg.loop_interval_seconds) meta.push('loop ' + fmtAge(cfg.loop_interval_seconds));
      const model = cfg.llm && (cfg.llm.model || (cfg.llm.proposer && cfg.llm.proposer.model));
      if (model) meta.push(model);
      if (cfg.goal) meta.push(`goal ${fmtMult(cfg.goal.target_multiple)} in ${cfg.goal.horizon_days}d`);
    }
    $id('risk-meta').textContent = meta.join(' · ');
    const u = (cfg && cfg.universe) || {};
    const chips = [];
    (u.perps || []).forEach((c) => chips.push(`<span class="chip">${esc(c)}-PERP</span>`));
    (u.spot || []).forEach((c) => chips.push(`<span class="chip">${esc(c)}</span>`));
    const pmc = u.prediction_markets;
    if (pmc) chips.push(`<span class="chip chip-label">Polymarket ${pmc.enabled ? 'on' : 'off'}${pmc.enabled ? ` · ≤${pmc.max_days_to_resolution}d · liq ≥ ${fmtUSD(pmc.min_liquidity_usd)}` : ''}</span>`);
    $id('universe').innerHTML = chips.join('') || '<span class="muted small">No universe configured yet — the agent has nothing it is allowed to trade.</span>';
  }

  function renderAll() {
    renderChrome();
    renderStatus();
    renderMarketBrief();
    renderChart();
    renderPositions();
    renderRuleEngine();   // v3 HERO: self-contained try/catch: a malformed rule_book payload never blanks the dashboard
    // Isolated: a bad shadow-trades payload or a stale page must never blank the rest of the dashboard
    // (before this guard, one exception here also killed the demo fallback's renderAll — total wipeout).
    try {
      renderShadowLearner();
    } catch (e) {
      try { console.error('shadow & learner panel failed to render; hiding it', e); } catch (_) { /* noop */ }
      const sp = $id('shadowtr-panel');
      if (sp) sp.hidden = true;
    }
    renderFeed();
    renderPerformance();
    renderExitQuality();
    renderConfig();
    markScrollable();
    listeners.status.forEach((cb) => { try { cb(state.status); } catch (_) { /* admin hook errors must not break the dashboard */ } });
  }

  // Wide tables scroll inside .table-wrap; flag the ones that overflow so CSS can draw an edge fade.
  function markScrollable() {
    document.querySelectorAll('.table-wrap').forEach((w) => {
      const more = w.scrollWidth > w.clientWidth + 1;
      w.classList.toggle('scrollable', more);
      w.classList.toggle('at-end', !more || w.scrollLeft + w.clientWidth >= w.scrollWidth - 1);
    });
  }
  document.querySelectorAll('.table-wrap').forEach((w) => w.addEventListener('scroll', () => {
    w.classList.toggle('at-end', w.scrollLeft + w.clientWidth >= w.scrollWidth - 1);
  }, { passive: true }));
  window.addEventListener('resize', markScrollable);

  const listeners = { status: [] };

  // -------------------------------------------------------------- modals
  function openModal(id) { $id(id).hidden = false; const f = $id(id).querySelector('input'); if (f) setTimeout(() => f.focus(), 30); }
  function closeModal(id) { $id(id).hidden = true; }
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModal(m.id); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal:not([hidden])').forEach((m) => closeModal(m.id)); });

  // Settings
  function openSettings() {
    $id('in-api-base').value = settings.base;
    $id('in-token').value = settings.token;
    const r = $id('test-result'); r.hidden = true; r.textContent = '';
    openModal('settings-modal');
  }
  $id('settings-btn').addEventListener('click', openSettings);
  $id('demo-banner-settings').addEventListener('click', openSettings);

  $id('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    settings.set($id('in-api-base').value, $id('in-token').value);
    closeModal('settings-modal');
    state.config = null;
    state.chart && (state.chart.options.scales.y.min = undefined);
    loadAll(true);
    schedule();
  });
  $id('clear-settings-btn').addEventListener('click', () => {
    settings.clear();
    $id('in-api-base').value = ''; $id('in-token').value = '';
    closeModal('settings-modal');
    hideError();
    state.config = null;
    loadAll(true);
    schedule();
  });
  $id('test-conn-btn').addEventListener('click', async () => {
    const base = $id('in-api-base').value.trim().replace(/\/+$/, '');
    const token = $id('in-token').value.trim();
    const r = $id('test-result');
    r.hidden = false; r.className = 'test-result info'; r.textContent = 'Testing ' + (base || '(empty)') + '/api/health …';
    if (!base) { r.className = 'test-result bad'; r.textContent = 'Enter an API base URL first.'; return; }
    // Test with the values in the form (not yet saved).
    const saved = { base: settings.base, token: settings.token };
    settings.set(base, token);
    try {
      const h = await apiFetch('/api/health', { timeout: 8000 });
      let msg = `health OK · mode=${h.mode || '?'} · server time ${fmtTime(h.ts)}`;
      // Health is unauthenticated; also probe an authed route so a bad token is caught here.
      try {
        await apiFetch('/api/status', { timeout: 8000 });
        msg += '\ntoken OK · /api/status reachable';
        r.className = 'test-result ok';
      } catch (e2) {
        if (e2.status === 404) { msg += '\ntoken OK · agent has no data yet (404)'; r.className = 'test-result ok'; }
        else { msg += '\n' + describeErr(e2); r.className = e2.status === 401 ? 'test-result bad' : 'test-result info'; }
      }
      r.textContent = msg;
    } catch (e) {
      r.className = 'test-result bad';
      r.textContent = 'Health check failed: ' + describeErr(e);
    } finally {
      settings.set(saved.base, saved.token);
    }
  });

  // Kill switch
  $id('kill-btn').addEventListener('click', () => {
    if (state.demo) return;
    $id('in-kill-confirm').value = '';
    $id('kill-confirm-btn').disabled = true;
    const r = $id('kill-result'); r.hidden = true; r.textContent = '';
    const ml = $id('kill-mode-line');
    const mode = String(state.mode || '').toUpperCase();
    ml.textContent = `Mode: ${mode}` + (mode === 'LIVE' ? ' — this will close REAL positions at market.' : mode === 'PAPER' ? ' — paper positions only.' : '');
    ml.className = 'kill-mode-line' + (mode === 'LIVE' ? ' live' : '');
    openModal('kill-modal');
  });
  $id('in-kill-confirm').addEventListener('input', (e) => {
    $id('kill-confirm-btn').disabled = e.target.value.trim() !== 'KILL';
  });
  $id('in-kill-confirm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$id('kill-confirm-btn').disabled) { e.preventDefault(); $id('kill-confirm-btn').click(); }
  });
  $id('kill-confirm-btn').addEventListener('click', async () => {
    if ($id('in-kill-confirm').value.trim() !== 'KILL' || state.demo) return;
    const btn = $id('kill-confirm-btn');
    const r = $id('kill-result');
    btn.disabled = true; btn.textContent = 'Sending…';
    r.hidden = false; r.className = 'test-result info'; r.textContent = 'POST /api/kill …';
    try {
      const res = await apiFetch('/api/kill', { method: 'POST', body: JSON.stringify({ confirm: 'KILL' }), timeout: 15000 });
      r.className = res && res.ok ? 'test-result ok' : 'test-result bad';
      r.textContent = (res && res.ok ? 'KILL accepted. ' : 'Unexpected response. ') + ((res && res.message) || JSON.stringify(res));
      btn.textContent = 'Sent';
      setTimeout(() => loadAll(false), 1500);
    } catch (e) {
      r.className = 'test-result bad';
      r.textContent = 'Kill request failed: ' + describeErr(e);
      btn.disabled = false; btn.textContent = 'Retry';
    }
  });

  $id('refresh-btn').addEventListener('click', () => { loadAll(false); schedule(); });

  // Live "ago" counters between polls
  setInterval(() => {
    if (!state.status || !state.status.last_cycle_ts) return;
    const el = $id('st-cycle-age');
    const age = Date.now() / 1000 - state.status.last_cycle_ts;
    el.textContent = `last cycle ${fmtAge(age)} ago`;
  }, 5000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastPoll > POLL_MS) loadAll(false);
  });
  window.addEventListener('resize', () => { if (!state.chart) renderChart(); if (!state.dailyChart) renderDailyChart(state.dailyRows); });

  // -------------------------------------------------------------- plain-English help (hover title + tap popover)
  const HELP = {
    equity: ['Equity', 'Total account value right now: cash plus the current value of every open position, including unrealized profit or loss.'],
    pnl_today: ["Today's PnL", 'How much equity changed since 00:00 UTC today, in dollars and as a percent of where the day started.'],
    positions: ['Open positions', 'Trades the agent currently holds: perpetual futures, spot coins and prediction-market shares. "Gross" is their combined size compared with equity.'],
    llm_cost: ['LLM cost', 'What the AI model calls cost today and in total. The agent skips cycles once the daily cap is hit. The "verifier" is a second model that double-checks trades before they go to the risk gate; a "fallback" model is used when the main one fails.'],
    health: ['Agent health', 'Green: a decision cycle completed recently. Amber: the last cycle is running late. Red: the agent has not reported for a long time, or was stopped by the kill switch / drawdown limit.'],
    multiple: ['Multiple vs target', 'Equity divided by the starting equity. 1.00x means break-even, 2.00x means the account doubled. The bar shows progress toward the goal.'],
    horizon: ['Horizon', 'How many days the goal allows, and where we are in that window.'],
    available: ['Available', 'Cash not tied up as margin: what the agent can still put into new positions.'],
    feed: ['Decision feed', 'One line per decision cycle. FILLED = a trade was executed. REJECTED = the model wanted to trade but a risk rule blocked it. FAILED = the exchange refused the order. HOLD = the model chose to do nothing. QUIET = the market was too quiet, so the model was not even asked. ERROR = the cycle itself failed. Each filter chip shows the latest 30 cycles of that kind. Tap a line for the full reasoning.'],
    perps: ['Perps', 'Perpetual futures on Hyperliquid: leveraged long (price up) or short (price down) bets on a coin with no expiry date.'],
    pm: ['Prediction markets', 'Polymarket shares that pay $1 if the outcome happens and $0 if it does not. The price is roughly the market\'s probability.'],
    upnl: ['Unrealized PnL', 'What you would gain or lose if the position were closed at the current price. The percent is relative to the margin put up for the trade.'],
    stop_tp: ['Stop and take-profit', 'Stop = the price where the position is closed automatically to cap the loss. TP (take-profit) = the price where it is closed to lock in the gain. The white marker is the current price; grey is the entry. "R" is how far the trade has moved in units of the risk to the stop.'],
    pm_stop_tp: ['PM stop and target', 'For a prediction-market SWING, the stop and target are levels on the token price (in cents). The position is exited if the token slips to the stop or reaches the target. "—" means it is a hold-to-resolution bet with no levels — it rides until the market resolves.'],
    learner: ['Online learner', 'A simple memory that scores each kind of setup by how it has performed, then tells the model to size up what works and cut what does not.'],
    context: ['Context', 'A setup category written as venue | coin | direction | volatility | regime. Trades in the same context share one score.'],
    q: ['Q score', 'The learner\'s running score for a context, in R units. Positive means this kind of trade has been making money; negative means it has been losing. The bar length shows the size of the score.'],
    r: ['R (risk units)', '1R is the amount risked to the stop on a trade. A trade that made +2R earned twice what it risked; -1R means the stop was hit.'],
    risk: ['Risk limits', 'Hard limits the risk gate applies to every proposed trade. They are changed in the Admin panel and directly control how much the agent can lose.'],
    rr: ['Risk-reward model', 'Sizing rules: a trade must offer at least this reward-to-risk ratio, may risk at most this share of equity, and is sized using a fraction of the Kelly criterion (a formula that scales bets with edge).'],
    perf: ['Performance', 'Statistics computed from the agent\'s closed trades, equity history and model costs since the run started. Refreshes every 60 seconds.'],
    realized: ['Realized PnL', 'Profit or loss that has been locked in by closing trades. It ignores positions that are still open; "total" adds the unrealized part back in.'],
    win_rate: ['Win rate', 'Share of closed trades that made money. A low win rate can still be profitable if the winners are much bigger than the losers, so read it together with profit factor.'],
    profit_factor: ['Profit factor', 'Total money made on winning trades divided by total money lost on losing trades. Above 1 means the strategy is net profitable; 2.0 means it makes $2 for every $1 it loses. "∞" means there have been no losing trades yet.'],
    expectancy: ['Expectancy per trade', 'The average dollar result of one closed trade, wins and losses combined. Positive means each trade adds money on average; negative means the agent is bleeding a little on each one.'],
    drawdown: ['Max drawdown', 'The biggest drop in equity from a peak to the low that followed, in dollars and as a percent of that peak. It is the worst dip the account has suffered so far.'],
    llm_cost_day: ['LLM cost per day', 'Average daily spend on AI model calls (proposer, verifier and fallbacks) since the run started.'],
    pnl_per_llm: ['PnL per $ of LLM', 'Dollars of profit for every dollar spent on model calls. Green ($1 or more) means the agent earns more than the model costs; red (below $1) means the model costs more than it earns.'],
    activity: ['Activity', 'What the agent did each cycle: cycles run, cycles skipped because the market was too quiet, trades the model proposed, how many were rejected (by the verifier model, the risk gate or the reward-risk check), orders filled, and cycles where the model call itself failed.'],
    close_reason: ['Close reason', 'Why a trade ended. Stop = the loss cap was hit. Take-profit = the target was hit. Agent = the model chose to close it. Stale = closed because it sat too long without going anywhere.'],
    daily_pnl: ['Daily PnL', 'Equity change for each UTC day: green bars are days that ended up, red bars days that ended down. Hover a bar for the day\'s open → close and its low / high.'],
    rejection_scores: ['Rejection scoreboard', 'Three layers can block a trade the model proposes. The verifier is a second AI model that double-checks the idea. The risk gate applies hard limits (leverage, position count, stop distance, cooldowns). The RR model is the reward-to-risk check that demands enough upside for the risk taken. Every blocked trade is followed as a "shadow trade" that is never placed. "Would have lost" means blocking it saved money; "would have won" means it cost a winner. A layer that mostly blocks losers is EARNING its cost; one that mostly blocks winners is TOO STRICT. The All row combines every rejection.'],
    shadow: ['Shadow trades', 'Trades that were rejected (by the verifier, the risk gate or the RR check), followed as if they had been taken so we can tell whether rejecting was right. By = who rejected it. open = still running; stopped = would have hit the stop; target = would have hit take-profit; expired = ran out of time. The Scoreboard tab tallies each rejecter; the Lessons tab shows what the learner took away.'],
    postmortem: ['Post-mortems', 'After a trade closes the model writes a short review: what it expected, what actually happened and the lesson. R is the result in risk units (-1R = the stop was hit). Lessons are fed back into future prompts.'],
  };
  const helpPop = $id('help-pop');
  document.querySelectorAll('.help').forEach((b) => { const h = HELP[b.dataset.help]; if (h) b.title = h[1]; });
  function hideHelp() { helpPop.hidden = true; helpPop.dataset.key = ''; }
  function showHelp(btn) {
    const key = btn.dataset.help, h = HELP[key];
    if (!h) return;
    if (!helpPop.hidden && helpPop.dataset.key === key) { hideHelp(); return; }
    helpPop.dataset.key = key;
    helpPop.innerHTML = `<strong>${esc(h[0])}</strong>${esc(h[1])}`;
    helpPop.hidden = false;
    const r = btn.getBoundingClientRect();
    const pw = Math.min(320, window.innerWidth - 20);
    helpPop.style.width = pw + 'px';
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - pw - 10));
    let top = r.bottom + 8;
    if (top + helpPop.offsetHeight > window.innerHeight - 10) top = Math.max(10, r.top - helpPop.offsetHeight - 8);
    helpPop.style.left = left + 'px';
    helpPop.style.top = top + 'px';
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.help');
    if (b) { e.preventDefault(); e.stopPropagation(); showHelp(b); return; }
    if (!helpPop.hidden && !e.target.closest('#help-pop')) hideHelp();
  });
  window.addEventListener('scroll', hideHelp, { passive: true });
  window.addEventListener('resize', hideHelp);

  // -------------------------------------------------------------- theme (dark default, optional light)
  function applyTheme(t) {
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light'); else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('theme', t); } catch (_) { /* ignore */ }
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    if (state.reChart) { state.reChart.destroy(); state.reChart = null; }
    if (state.dailyChart) { state.dailyChart.destroy(); state.dailyChart = null; }
    renderChart();
    renderRuleEngine();   // rebuilds the rule-engine equity chart with the new theme's colors
    renderDailyChart(state.dailyRows);
  }
  $id('theme-btn').addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  });

  // -------------------------------------------------------------- bridge for admin.js
  window.Dash = {
    settings, state, apiFetch, ApiError, describeErr,
    esc, fmtUSD, fmtCost, fmtTime, fmtAge, fmtClock, fmtNum, fmtPct, fmtR,
    loadAll, schedule, openModal, closeModal,
    onStatus(cb) { listeners.status.push(cb); },
  };

  // -------------------------------------------------------------- boot
  loadAll(true);
  schedule();
})();
