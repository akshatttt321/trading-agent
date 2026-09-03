/* mock.js - realistic demo data for the trading-agent dashboard.
 * Exposes window.MockAPI with the same shapes as agent/api.py (see API.md).
 * State is kept in memory and drifts a little on every tick() so charts move.
 */
(function () {
  'use strict';

  // Deterministic PRNG so the demo looks the same on every load until it ticks.
  let seed = 20260827;
  function rnd() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const round = (x, d) => Math.round(x * Math.pow(10, d)) / Math.pow(10, d);

  let LOOP = 300; // seconds per cycle (follows config.loop_interval_seconds)
  let startEquity = 1000.0;
  const now = () => Date.now() / 1000;

  // ---- config (mirrors config.yaml, sanitized) ----
  const config = {
    mode: 'paper',
    loop_interval_seconds: LOOP,
    paper_starting_equity_usd: startEquity,
    llm: {
      proposer: { provider: 'gemini', model: 'gemini-3.6-flash' },
      verifier: { enabled: true, provider: 'anthropic', model: 'claude-sonnet-5' },
      fallbacks: [
        { provider: 'openai', model: 'gpt-5.4-mini', enabled: true },
        { provider: 'gemini', model: 'gemini-3.6-pro', enabled: false },
      ],
      stance: 'active',
      daily_cost_cap_usd: 5.0,
      prices: { 'gemini-3.6-flash': [0.15, 0.6], 'gemini-3.6-pro': [1.25, 10.0], 'claude-sonnet-5': [3.0, 15.0], 'gpt-5.4-mini': [0.4, 1.6] },
    },
    goal: {
      target_multiple: 2.0, horizon_days: 10,
      mandate: 'Grow the account to 2x within the horizon using perps, spot and prediction markets. Prefer asymmetric setups with defined invalidation. Never exceed the risk limits; when in doubt, hold.',
    },
    universe: {
      perps: ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'XRP', 'SUI', 'AVAX', 'LINK', 'ARB'],
      spot: ['HYPE/USDC', 'PURR/USDC'],
      prediction_markets: { enabled: true, max_days_to_resolution: 14, min_liquidity_usd: 25000, max_markets_shown: 15, keywords: ['BTC', 'ETH', 'Fed', 'rate'] },
    },
    risk: {
      max_leverage: 5, max_position_pct_equity: 35, max_gross_exposure_pct: 150, max_open_positions: 4,
      max_daily_loss_pct: 8, max_drawdown_pct: 25, require_stop_loss: true, max_stop_distance_pct: 6,
      min_seconds_between_orders: 60, max_orders_per_hour: 12, min_order_usd: 10,
      prediction_market_max_pct_equity: 10, prediction_market_max_total_pct: 25, min_equity_usd: 20,
    },
    rr: { min_reward_risk: 1.5, max_risk_per_trade_pct: 5.0, kelly_fraction: 0.25, pm_min_edge: 0.05 },
    learner: { enabled: true, alpha: 0.25, min_samples: 3, min_multiplier: 0.25, max_multiplier: 1.0 },
    notify: { telegram_enabled: false, on_fill: true, on_reject: false, daily_summary: true },
  };

  // ---- prices ----
  const px = { BTC: 78900, ETH: 3420, SOL: 168.4, HYPE: 27.85, DOGE: 0.1432, XRP: 0.612, SUI: 1.87, AVAX: 24.6, LINK: 15.2, ARB: 0.71, PURR: 0.184 };
  function driftPrices() {
    for (const k of Object.keys(px)) px[k] = px[k] * (1 + gauss() * 0.0015);
  }

  // ---- equity history: ~4.4 days of 5-min cycles (gives the daily PnL chart a handful of bars) ----
  let startTs = now() - 4.4 * 86400;
  const equity = [];
  (function build() {
    let e = startEquity;
    let ts = startTs;
    const n = Math.floor((now() - startTs) / LOOP);
    for (let i = 0; i <= n; i++) {
      equity.push({ ts: round(ts, 1), equity: round(e, 2) });
      // mild positive drift, occasional stop-outs
      let step = gauss() * 1.6 + 0.06;
      if (rnd() < 0.02) step -= 9 + rnd() * 8;
      if (rnd() < 0.03) step += 6 + rnd() * 7;
      e = Math.max(600, e + step);
      ts += LOOP;
    }
  })();
  let cycleId = equity.length;

  // ---- positions ----
  const perps = [
    { coin: 'BTC', size: 0.0031, entry_px: 78400.0, leverage: 3.0, stop_px: 76800.0, tp_px: 81500.0 },
    { coin: 'SOL', size: -1.45, entry_px: 171.2, leverage: 2.0, stop_px: 179.5, tp_px: 156.0 },
    // a SHORT: stop ABOVE entry, take-profit BELOW — exercises the side-aware stop→tp bar
    { coin: 'XRP', size: -320.0, entry_px: 0.640, leverage: 2.0, stop_px: 0.680, tp_px: 0.560 },
  ];
  const spot = [{ coin: 'HYPE/USDC', amount: 3.58 }];
  const pm = [
    // a SWING: stop / target set on the token price (cents) — exit at 38¢, target 62¢
    { market_id: '514233', token_id: '0x7a1c…e9', question: 'Will BTC close above $80,000 on Aug 31?', outcome: 'Yes', shares: 50.0, avg_price: 0.42, cur_price: 0.47, stop_px: 0.38, tp_px: 0.62 },
    // a hold-to-resolution bet: no levels (stop_px / tp_px null) — rides until the market resolves
    { market_id: '518901', token_id: '0x93bd…41', question: 'Fed rate cut announced at September FOMC?', outcome: 'Yes', shares: 30.0, avg_price: 0.71, cur_price: 0.69, stop_px: null, tp_px: null },
  ];

  function markFor(coin) { return px[coin]; }
  function perpView(p) {
    const mark = markFor(p.coin);
    const notional = Math.abs(p.size) * mark;
    const upnl = (mark - p.entry_px) * p.size;
    const liq = p.size > 0 ? p.entry_px * (1 - 0.92 / p.leverage) : p.entry_px * (1 + 0.92 / p.leverage);
    return {
      coin: p.coin, size: p.size, entry_px: round(p.entry_px, 4), mark_px: round(mark, 4),
      notional_usd: round(notional, 2), unrealized_pnl: round(upnl, 2), leverage: p.leverage,
      liquidation_px: round(liq, 2), stop_px: p.stop_px, tp_px: p.tp_px,
    };
  }
  function spotView(s) {
    const base = s.coin.split('/')[0];
    return { coin: s.coin, amount: s.amount, value_usd: round(s.amount * (px[base] || 1), 2) };
  }
  function pmView(m) {
    return Object.assign({}, m, { cur_price: round(m.cur_price, 3), value_usd: round(m.shares * m.cur_price, 2) });
  }

  function snapshot() {
    const last = equity[equity.length - 1] || { ts: round(now(), 1), equity: startEquity };
    const perpsV = perps.map(perpView);
    const gross = perpsV.reduce((a, p) => a + p.notional_usd, 0);
    return {
      ts: last.ts, equity_usd: last.equity,
      available_usd: round(last.equity - gross / 3 - spot.map(spotView).reduce((a, s) => a + s.value_usd, 0) - pm.map(pmView).reduce((a, m) => a + m.value_usd, 0), 2),
      perps: perpsV, spot: spot.map(spotView), pm: pm.map(pmView),
    };
  }

  // ---- cycles / decisions ----
  const VIEWS = [
    'BTC grinding higher on rising OI and positive funding; ETH lagging. SOL showing distribution at the 172 resistance. Regime: trending, low vol. Keep BTC long, no new risk until funding resets.',
    'Choppy tape after the CPI print. Funding neutral across majors, OI flat. Nothing meets R:R 1.5 with a stop inside 6%. HOLD.',
    'SOL rejected 172 for the third time with falling OI - short setup with tight invalidation at 179.5. BTC holding above 78k VWAP; keep long.',
    'DOGE momentum breakout on 4h with funding still low - attractive but position count near cap. Considering reducing SOL first.',
    'Polymarket "BTC > 80k Aug 31" at 0.47 vs my estimate ~0.55 - edge 0.08 above pm_min_edge. Small add within PM cap.',
    'Drawdown from local high 1.8%. Daily loss well inside 8% budget. Market quiet into US close; no edge. HOLD.',
    'HYPE spot bid strong on buyback flow; holding small spot allocation. Perps: BTC trailing stop raised to 77,200 to lock in R.',
  ];
  const NOTES = ['Confidence is moderate; sizing at 0.6x Kelly fraction.', '', 'Learner says perp|SOL|short|mid is the best-performing context so far.', 'Waiting for funding reset before adding exposure.', ''];

  function mkOpen(coin, side, conf) {
    const mark = px[coin];
    const dir = side === 'long' ? 1 : -1;
    const stopDist = 0.02 + rnd() * 0.03;
    const tpDist = stopDist * (1.6 + rnd() * 1.2);
    return {
      kind: 'open_perp', coin, side, size_usd: Math.round(120 + rnd() * 220), leverage: pick([2, 3, 3, 4]),
      stop_loss_px: round(mark * (1 - dir * stopDist), coin === 'BTC' || coin === 'ETH' ? 0 : 3),
      take_profit_px: round(mark * (1 + dir * tpDist), coin === 'BTC' || coin === 'ETH' ? 0 : 3),
      reason: pick(['Momentum continuation with funding support.', 'Range rejection with clean invalidation.', 'OI flush completed, mean reversion expected.', 'Breakout retest holding.']),
      confidence: round(conf, 2),
    };
  }

  function mkCycle(id, ts, eq, scenario) {
    const orders = [];
    const actions = [];
    const push = (action, approved, risk_reason, ok, detail) => {
      actions.push(action);
      orders.push({ ts: ts + 2 + rnd() * 3, approved, risk_reason, action, result: approved ? { ok, detail } : null });
    };
    switch (scenario) {
      case 'quiet':   // attention gate skipped the cycle: no model call, no actions, no orders
        break;
      case 'hold':
        actions.push({ kind: 'hold', reason: 'No setup meets the R:R threshold.', confidence: 0.5 });
        break;
      case 'fill': {
        const a = mkOpen(pick(['BTC', 'ETH', 'SOL', 'DOGE']), pick(['long', 'long', 'short']), 0.55 + rnd() * 0.2);
        const qty = a.size_usd / px[a.coin];
        push(a, true, `approved (clamped: leverage ${a.leverage}->${Math.min(a.leverage, 3)}) | rr: RR=${(1.6 + rnd()).toFixed(2)} EV=+${(0.1 + rnd() * 0.2).toFixed(2)}R kelly=${(0.12 + rnd() * 0.1).toFixed(2)}`,
          true, `paper fill ${a.side} ${qty.toPrecision(3)} ${a.coin} @ ${px[a.coin].toPrecision(6)} (fee $${(a.size_usd * 0.00035).toFixed(2)})`);
        break;
      }
      case 'reject': {
        const a = mkOpen(pick(['HYPE', 'AVAX', 'LINK', 'XRP']), pick(['long', 'short']), 0.5 + rnd() * 0.15);
        push(a, false, pick([
          'rejected: rr: RR=1.21 < min 1.5',
          'rejected: risk: stop distance 7.4% > max 6%',
          'rejected: risk: max_open_positions (4) reached',
          'rejected: risk: gross exposure 162% > 150% cap',
          'rejected: rr: EV=-0.04R at confidence 0.52',
          'rejected: risk: daily loss halt active until next UTC day',
        ]), false, '');
        break;
      }
      case 'fail': {
        const a = mkOpen(pick(['SUI', 'ARB', 'ETH']), 'long', 0.6);
        push(a, true, `approved | rr: RR=1.84 EV=+0.17R kelly=0.14`, false,
          pick(['venue error: order rejected - insufficient margin for isolated position', 'timeout after 10s waiting for fill confirmation', 'stop order could not be placed; position closed immediately']));
        break;
      }
      case 'pm': {   // ENTRY: pm_buy — half of them are swings (stop/target on the token price)
        const swing = rnd() < 0.5;
        const a = { kind: 'pm_buy', market_id: '514233', token_id: '0x7a1c…e9', outcome: 'Yes', question: 'Will BTC close above $80,000 on Aug 31?', size_usd: 20, price: 0.47, reason: 'Estimated probability 0.55 vs market 0.47.', confidence: 0.55 };
        if (swing) { a.stop_loss_px = 0.38; a.take_profit_px = 0.62; a.reason = 'Swing the mispricing: exit if the token slips to 38¢, target 62¢.'; }
        push(a, true, 'approved | pm: edge=0.08 >= 0.05, kelly=0.15 cap 10%', true, 'paper fill 42.5 shares Yes @ 0.47');
        break;
      }
      case 'pmreject': {   // REJECTED prediction-market proposal (so PM > Rejected populates)
        const a = { kind: 'pm_buy', market_id: '520114', token_id: '0x4d21…7c', outcome: 'No', question: 'Will ETH close above $3,600 on Aug 31?', size_usd: 25, price: 0.36, reason: 'Estimated probability 0.30 vs market 0.36 — thin edge.', confidence: 0.5 };
        push(a, false, pick([
          'rejected: pm: edge 0.03 < pm_min_edge 0.05',
          'rejected: risk: PM total exposure 27% > 25% cap',
          'rejected: risk: PM position 12% > per-market cap 10% of equity',
        ]), false, '');
        break;
      }
      case 'pmupd': {   // MANAGEMENT: pm_update — move the stop/target on an open PM swing (levels on the token price)
        const a = { kind: 'pm_update', market_id: '518901', token_id: '0x93bd…41', outcome: 'Yes', question: 'Fed rate cut announced at September FOMC?', stop_loss_px: 0.6, take_profit_px: 0.82, reason: 'Token ran to 0.73; raise the stop to break-even-plus and lift the target.', confidence: 0.62 };
        push(a, true, 'approved (risk-reducing)', true, 'PM 518901 Yes: stop 0.55 -> 0.60, target 0.78 -> 0.82');
        break;
      }
      case 'spotbuy': {   // ENTRY: spot_buy
        const a = { kind: 'spot_buy', coin: 'HYPE/USDC', size_usd: Math.round(60 + rnd() * 80), reason: 'Buyback flow bid; accumulate a small spot core.', confidence: 0.58 };
        const qty = a.size_usd / px.HYPE;
        push(a, true, 'approved | rr: spot core within 35% cap', true, `paper buy ${qty.toPrecision(3)} HYPE/USDC @ ${px.HYPE.toPrecision(5)} (fee $${(a.size_usd * 0.00035).toFixed(2)})`);
        break;
      }
      case 'spotsell': {   // MANAGEMENT: spot_sell
        const a = { kind: 'spot_sell', coin: 'HYPE/USDC', size_usd: 42, reason: 'Trim the spot core into strength.', confidence: 0.6 };
        push(a, true, 'approved (risk-reducing)', true, 'paper sell 1.5 HYPE/USDC @ 28.10 (pnl +$1.92, fee $0.03)');
        break;
      }
      case 'close': {   // MANAGEMENT: close_perp
        const a = { kind: 'close_perp', coin: 'DOGE', reason: 'Momentum faded; take +1.3R.', confidence: 0.7 };
        push(a, true, 'approved (risk-reducing)', true, 'paper close long 1120 DOGE @ 0.1441 (pnl +$6.42, fee $0.06)');
        break;
      }
      case 'resting': {   // ENTRY: limit order parked on the book — approved and placed, but NOT executed yet
        const a = mkOpen('SOL', 'short', 0.62);
        a.order_type = 'limit';
        a.limit_price = round(px.SOL * 1.015, 3);
        a.reason = 'Fade the squeeze: park a limit above spot and wait for the retest.';
        push(a, true, 'approved | rr: RR=1.92 EV=+0.21R kelly=0.13 | limit resting',
          true, `resting limit short SOL @ ${a.limit_price}`);
        orders[orders.length - 1].result.resting = true;
        break;
      }
      case 'expire': {   // limit order that sat unfilled and expired — canceled, no trade happened
        const a = mkOpen('AVAX', 'long', 0.58);
        a.order_type = 'limit';
        a.limit_price = round(px.AVAX * 0.985, 3);
        a.reason = 'Bid the pullback into support with a resting limit.';
        push(a, true, 'approved | rr: RR=1.71 EV=+0.14R kelly=0.11 | limit resting',
          false, 'expired after 90m unfilled');
        break;
      }
      case 'stop': {   // MANAGEMENT: update_stop — trail the stop and lift the target on an open perp
        const a = { kind: 'update_stop', coin: 'BTC', stop_loss_px: 77200, take_profit_px: 82600, reason: 'Trail stop to lock in 0.5R and extend the target.', confidence: 0.65 };
        push(a, true, 'approved (risk-reducing)', true, 'BTC: stop 76800 -> 77200, target 81500 -> 82600');
        break;
      }
    }
    const VERIFIER = {
      fill: { verdict: 'approve', comment: 'Setup is consistent with the stated regime and the stop sits inside the max distance. Size is within the Kelly cap. Approve as proposed.' },
      reject: { verdict: 'concern', comment: 'Reward-to-risk looks thin for this volatility and the invalidation level is arbitrary. I would not take this trade at the proposed size.' },
      pmreject: { verdict: 'concern', comment: 'The probability edge here is inside the noise and PM exposure is already near the cap. Skip until the market misprices further.' },
      fail: { verdict: 'approve', comment: 'Reasonable continuation setup; approve. Note margin is getting tight, so a smaller size would be safer.' },
      resting: { verdict: 'approve', comment: 'Passive entry at a better price is sensible here; the limit is close enough to touch. Approve.' },
      expire: { verdict: 'approve', comment: 'The level was fine but price never came back; letting the unfilled limit expire costs nothing.' },
      pm: { verdict: 'approve', comment: 'The probability estimate is defensible given the current spot price and remaining time; edge clears the threshold.' },
      pmupd: { verdict: 'approve', comment: 'Raising the stop to break-even on a PM swing that has moved in your favour is prudent. Approve.' },
      spotbuy: { verdict: 'approve', comment: 'A small spot core against buyback flow is reasonable and well within the position cap. Approve.' },
      spotsell: { verdict: 'approve', comment: 'Trimming spot into strength locks in the gain. Approve.' },
      close: { verdict: 'approve', comment: 'Taking profit into fading momentum is prudent. Approve.' },
      stop: { verdict: 'approve', comment: 'Trailing the stop and lifting the target is risk-reducing. Approve.' },
    };
    const verifier = config.llm.verifier.enabled && VERIFIER[scenario] ? Object.assign({ model: config.llm.verifier.model }, VERIFIER[scenario]) : undefined;
    const QUIET = [
      'attention gate: no watched symbol moved > 0.4% in 15m; volume 0.6x of median',
      'attention gate: realized vol 0.9%/h below 1.2% threshold across the universe; no funding or OI shock',
      'attention gate: order books unchanged, no news flags; skipping the model call to save cost',
      'attention gate: BTC/ETH within 0.2% of last consult, positions unchanged, stops not near',
    ];
    // cheap position-manager review of the open positions (decision.managed) — present on a few cycles so the
    // UI shows the entry model being skipped while positions were still reviewed. actions = changes it made.
    const MANAGED = scenario === 'quiet' && id % 3 === 0
      ? { due: 'interval 10m', view: 'Both shorts are moving favorably and the stops already trail price. Nothing to adjust.', actions: 0 }
      : scenario === 'stop'
      ? { due: 'BTC moved 0.63%', view: 'BTC long pushing through the watch level; trailed the stop to lock in 0.5R.', actions: 1 }
      : scenario === 'hold' && id % 4 === 0
      ? { due: 'XRP moved 0.63%', view: 'Open positions all sit inside their stops; funding unchanged. Reviewed — all fine.', actions: 0 }
      : null;
    // why an event-fired cycle ran (decision.wake); scheduled heartbeats carry no wake
    const WAKE = {
      stop: 'watch level: BTC above 77850 [trail the stop once the breakout confirms]',
      close: 'manager: DOGE near stop/TP',
    };
    return {
      id, ts: round(ts, 1), equity: eq,
      error: scenario === 'llmerr' ? pick(['LLM call failed: 529 overloaded (retry next cycle)', 'proposer returned no parsable JSON after 2 attempts', 'venue snapshot failed: HTTP 503 from info endpoint']) : '',
      decision: scenario === 'llmerr' ? null
        : scenario === 'quiet' ? Object.assign({ skipped: pick(QUIET), actions: [] }, MANAGED ? { managed: MANAGED } : {})
        : Object.assign({ market_view: pick(VIEWS), notes: pick(NOTES), actions }, verifier ? { verifier } : {}, WAKE[scenario] ? { wake: WAKE[scenario] } : {}, MANAGED ? { managed: MANAGED } : {}),
      orders,
    };
  }

  // Mirrors the server's GET /api/cycles?venue=&kind= semantics (API.md). Two axes:
  //   venue: all | crypto (perp/spot orders) | pm (prediction-market orders)
  //   kind:  all | new (entry fills) | updates (management fills) | trades (either) | rejected | holds | quiet | errors
  // new/updates/trades/rejected are filtered to the chosen venue; holds/quiet/errors (and the venue-agnostic parts
  // of 'all') are global. Venue/category are read off each order's action.kind.
  const MK_CRYPTO = ['open_perp', 'close_perp', 'update_stop', 'spot_buy', 'spot_sell', 'modify_stop'];
  const MK_PM = ['pm_buy', 'pm_sell', 'pm_update', 'buy_pm'];
  const MK_ENTRY = ['open_perp', 'spot_buy', 'pm_buy', 'buy_pm'];
  const MK_MANAGE = ['update_stop', 'pm_update', 'close_perp', 'spot_sell', 'pm_sell', 'modify_stop'];
  function orderVenue(o) { const k = o.action && o.action.kind; return MK_CRYPTO.includes(k) ? 'crypto' : MK_PM.includes(k) ? 'pm' : null; }
  function orderCat(o) { const k = o.action && o.action.kind; return MK_ENTRY.includes(k) ? 'entry' : MK_MANAGE.includes(k) ? 'manage' : null; }
  function isFill(o) { return !!(o.approved && o.result && o.result.ok); }
  function cycleMatches(c, kind, venue) {
    const orders = c.orders || [];
    const quiet = !!(c.decision && c.decision.skipped);
    const isHold = !c.error && !quiet && orders.length === 0;
    const venueOk = (o) => venue === 'all' || !venue || orderVenue(o) === venue;
    switch (kind) {
      case 'trades': return orders.some((o) => isFill(o) && venueOk(o));
      case 'new': return orders.some((o) => isFill(o) && orderCat(o) === 'entry' && venueOk(o));
      case 'updates': return orders.some((o) => isFill(o) && orderCat(o) === 'manage' && venueOk(o));
      case 'rejected': return orders.some((o) => o.approved === false && venueOk(o));
      case 'holds': return isHold;                       // venue-agnostic
      case 'quiet': return quiet;                        // venue-agnostic
      case 'errors': return !!c.error;                   // venue-agnostic
      default:                                           // 'all': this venue's actions PLUS no-order cycles (hold/quiet/error)
        if (venue === 'all' || !venue) return true;
        return orders.some((o) => orderVenue(o) === venue) || orders.length === 0;
    }
  }

  // ~27% quiet (matches analytics.activity.quiet_skipped), ~35% holds, the rest a mix of new entries
  // (fill=open_perp, pm, spotbuy) and position updates (stop=update_stop, pmupd, close, spotsell) plus
  // rejections / failures — so both the New and Updates chips populate in demo mode.
  // The three back-to-back 'quiet's at the start guarantee the 'All' view's collapsed quiet-run row is visible in demo mode.
  const SCENARIOS = ['hold', 'quiet', 'quiet', 'quiet', 'fill', 'reject', 'stop', 'pm', 'hold', 'close', 'quiet', 'fail', 'pmupd', 'hold', 'pmreject', 'quiet', 'spotbuy', 'resting', 'expire', 'reject', 'fill', 'quiet', 'stop', 'hold', 'pm', 'quiet', 'spotsell', 'close', 'pmreject', 'hold', 'quiet', 'fill', 'llmerr', 'hold', 'quiet', 'pmupd'];
  const cycles = [];
  // Keep a deep enough pool (~240 cycles) that every kind filter can fill its 30 rows in demo mode.
  const CYCLE_POOL = 240;
  (function buildCycles() {
    const n = Math.min(CYCLE_POOL, equity.length);
    for (let i = 0; i < n; i++) {
      const pt = equity[equity.length - 1 - i];
      const id = cycleId - i;
      cycles.push(mkCycle(id, pt.ts, pt.equity, SCENARIOS[i % SCENARIOS.length]));
    }
  })();

  // ---- learner ----
  const contexts = [
    { ctx: 'perp|BTC|long|mid|trend', q: 0.31, n: 5, wins: 3, total_r: 1.55, total_pnl: 14.2, multiplier: 1.0 },
    { ctx: 'perp|SOL|short|mid|range', q: 0.48, n: 4, wins: 3, total_r: 1.92, total_pnl: 11.8, multiplier: 1.0 },
    { ctx: 'perp|ETH|long|low|chop', q: -0.62, n: 3, wins: 0, total_r: -1.85, total_pnl: -13.4, multiplier: 0.38 },
    { ctx: 'perp|DOGE|long|high|trend', q: 0.12, n: 2, wins: 1, total_r: 0.25, total_pnl: 2.1 },
    { ctx: 'pm|BTC>80k|Yes|mid|-', q: 0.0, n: 0, wins: 0, total_r: 0, total_pnl: 0 },
    { ctx: 'perp|HYPE|long|mid|chop', q: -0.35, n: 3, wins: 1, total_r: -1.05, total_pnl: -7.9, multiplier: 0.65 },
  ];
  function lessons() {
    const closed = contexts.reduce((a, c) => a + c.n, 0);
    const wins = contexts.reduce((a, c) => a + c.wins, 0);
    const pnl = contexts.reduce((a, c) => a + c.total_pnl, 0);
    const lines = [`Closed trades: ${closed}, win rate ${closed ? Math.round(100 * wins / closed) : 0}%, realized $${pnl.toFixed(2)}`];
    const sorted = contexts.slice().filter(c => c.n > 0).sort((a, b) => b.q - a.q);
    lines.push('WORKING (size up to 1.0x):');
    sorted.filter(c => c.q > 0.1 && c.n >= 3).forEach(c => lines.push(`  ${c.ctx}: Q=${c.q >= 0 ? '+' : ''}${c.q.toFixed(2)}R n=${c.n} -> mult 1.00`));
    lines.push('AVOID (size cut):');
    sorted.filter(c => c.q < -0.1 && c.n >= 3).forEach(c => lines.push(`  ${c.ctx}: Q=${c.q.toFixed(2)}R n=${c.n} -> mult ${Math.max(0.25, 1 + c.q).toFixed(2)}`));
    lines.push('EXPLORING (<3 samples): ' + contexts.filter(c => c.n < 3).map(c => c.ctx).join(', '));
    return lines.join('\n');
  }

  let killed = null;
  let dailyHalt = false;

  // ---- LLM token usage (proposer / verifier / fallback) ----
  function mkRole(model, calls, inTok, outTok) {
    const p = config.llm.prices[model] || [1, 4];
    return { model, calls, input_tokens: inTok, output_tokens: outTok, cost_usd: round((inTok * p[0] + outTok * p[1]) / 1e6, 4) };
  }
  function sumRoles(roles) {
    const t = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, by_role: roles };
    for (const r of Object.values(roles)) { t.calls += r.calls; t.input_tokens += r.input_tokens; t.output_tokens += r.output_tokens; t.cost_usd = round(t.cost_usd + r.cost_usd, 4); }
    return t;
  }
  const usage = {
    today: { proposer: mkRole(config.llm.proposer.model, 96, 96 * 9800, 96 * 900), verifier: mkRole(config.llm.verifier.model, 14, 14 * 4200, 14 * 350), fallback: mkRole(config.llm.fallbacks[0].model, 2, 2 * 9800, 2 * 900) },
    total: { proposer: mkRole(config.llm.proposer.model, 1240, 1240 * 9800, 1240 * 900), verifier: mkRole(config.llm.verifier.model, 188, 188 * 4200, 188 * 350), fallback: mkRole(config.llm.fallbacks[0].model, 21, 21 * 9800, 21 * 900) },
  };
  function addUsage(role, model, inTok, outTok) {
    for (const bucket of [usage.today, usage.total]) {
      const cur = bucket[role] || mkRole(model, 0, 0, 0);
      bucket[role] = mkRole(model, cur.calls + 1, cur.input_tokens + inTok, cur.output_tokens + outTok);
    }
  }

  // ---- admin: restart / reload bookkeeping ----
  let restartAt = null;          // set by admin PUTs; the "agent" reloads ~4 s later and runs a cycle
  let lastReloadTs = round(now() - 3600, 1);

  // ---- one poll tick: prices drift, equity appends a point every ~loop, cycles grow ----
  let lastCycleTs = equity[equity.length - 1].ts;
  function tick() {
    driftPrices();
    for (const m of pm) m.cur_price = Math.min(0.98, Math.max(0.02, m.cur_price + gauss() * 0.006));
    const t = now();
    let force = false;
    if (restartAt && t - restartAt > 4) { restartAt = null; lastReloadTs = round(t, 1); force = true; }
    if (killed) return;
    if (force || t - lastCycleTs >= LOOP * 0.98 || rnd() < 0.35) {
      const last = equity[equity.length - 1] || { equity: startEquity };
      const snap = snapshot();
      const upnl = snap.perps.reduce((a, p) => a + p.unrealized_pnl, 0);
      const e = round(Math.max(600, last.equity + gauss() * 1.4 + 0.05 + upnl * 0.05), 2);
      lastCycleTs = round(t, 1);
      cycleId += 1;
      equity.push({ ts: lastCycleTs, equity: e });
      if (equity.length > 3000) equity.shift();
      // rule engine appends its own equity point each cycle (rbEquityHist / ruleBook defined below; safe at call time).
      rbEquityHist.push([lastCycleTs, rbEquityNow()]);
      if (rbEquityHist.length > 600) rbEquityHist.shift();
      cycles.unshift(mkCycle(cycleId, lastCycleTs, e, pick(['hold', 'quiet', 'hold', 'quiet', 'hold', 'fill', 'reject', 'stop', 'fail', 'pm', 'pmupd', 'pmreject', 'spotbuy', 'spotsell', 'close', 'llmerr'])));
      if (cycles.length > CYCLE_POOL) cycles.pop();
      addUsage('proposer', config.llm.proposer.model, 9000 + Math.round(rnd() * 2000), 700 + Math.round(rnd() * 400));
      if (config.llm.verifier.enabled && rnd() < 0.2) addUsage('verifier', config.llm.verifier.model, 4000, 300);
      if (rnd() < 0.05 && config.llm.fallbacks.some((f) => f.enabled)) addUsage('fallback', config.llm.fallbacks.find((f) => f.enabled).model, 9000, 800);
      // learner drifts slowly
      const c = pick(contexts.filter(x => x.n > 0));
      if (rnd() < 0.25 && c) { const r = gauss() * 0.8; c.n += 1; if (r > 0) c.wins += 1; c.total_r = round(c.total_r + r, 2); c.total_pnl = round(c.total_pnl + r * 9, 2); c.q = round(c.q + 0.25 * (r - c.q), 2); }
    }
  }

  // One open shadow trade: mark follows the live (drifting) price, live_r = signed distance from entry in stop-units.
  function shadowOpen(coin, side, entry, stop, tp, sizeUsd, by, reason, ts) {
    const mark = round(markFor(coin), 4);
    const move = side === 'short' ? entry - mark : mark - entry;
    return {
      coin, side, entry_px: entry, mark_px: mark, live_r: round(move / Math.abs(entry - stop), 2),
      stop_px: stop, tp_px: tp, size_usd: sizeUsd, by, reason, ts: round(ts, 1),
    };
  }

  // ---- rule engine: v3 PRIMARY perp trader (status.rule_book) ----
  // Deterministic: 2h momentum on movers, 1D-trend filtered, fixed 2R exits. Two strategies — `pullback`
  // (buy the dip into trend) and `deepfade` (fade an overextended move). This is the dashboard hero in v3.
  const RB_T0 = now();
  const RB_START = 300.0;   // the rule engine runs a small $300 book at 10x leverage (risk ~2%/trade; margin = notional/10)
  const ruleBook = {
    start: RB_START,
    start_ts: round(startTs, 1),
    // 3 open: mix of pullback/deepfade and long/short.
    // notional = full exposure; at 10x leverage margin_usd = notional/10; risk_usd = notional × stop-distance (~2% of the $300 book).
    positions: {
      LINK: { side: 'long',  strat: 'pullback', entry: 15.05,  stop: 14.62,  tp: 15.91,  notional: 210.0, leverage: 10, margin_usd: 21.0, risk_usd: 6.0, opened_ts: round(RB_T0 - 26000, 1), deadline_ts: round(RB_T0 + 146800, 1) },
      XRP:  { side: 'short', strat: 'deepfade', entry: 0.628,  stop: 0.6491, tp: 0.5858, notional: 180.0, leverage: 10, margin_usd: 18.0, risk_usd: 6.0, opened_ts: round(RB_T0 - 9800, 1),  deadline_ts: round(RB_T0 + 163000, 1) },
      DOGE: { side: 'long',  strat: 'pullback', entry: 0.1402, stop: 0.1360, tp: 0.1486, notional: 200.0, leverage: 10, margin_usd: 20.0, risk_usd: 6.0, opened_ts: round(RB_T0 - 4200, 1),  deadline_ts: round(RB_T0 + 168400, 1) },
    },
    // 2 pending limits.
    pending: [
      { coin: 'SUI',  side: 'short', strat: 'deepfade', limit: 1.982, stop: 2.049, tp: 1.848, notional: 185.0, leverage: 10, margin_usd: 18.5, risk_usd: 6.2, expires_ts: round(RB_T0 + 7440, 1) },
      { coin: 'AVAX', side: 'long',  strat: 'pullback', limit: 23.9,  stop: 23.1,  tp: 25.5,  notional: 200.0, leverage: 10, margin_usd: 20.0, risk_usd: 6.7, expires_ts: round(RB_T0 + 12600, 1) },
    ],
    // 6 closed: mix of stop/tp/time, wins and losses, across both strategies.
    trades: [
      { coin: 'ARB',  side: 'long',  strat: 'pullback', entry: 0.702,  exit: 0.741,  r: 2.02,  pnl: 30.3,  why: 'tp',   ts: round(RB_T0 - 31000, 1) },
      { coin: 'DOGE', side: 'short', strat: 'deepfade', entry: 0.1452, exit: 0.1478, r: -1.05, pnl: -15.7, why: 'stop', ts: round(RB_T0 - 60000, 1) },
      { coin: 'ETH',  side: 'long',  strat: 'pullback', entry: 3391,   exit: 3405,   r: 0.31,  pnl: 4.7,   why: 'time', ts: round(RB_T0 - 92000, 1) },
      { coin: 'HYPE', side: 'long',  strat: 'deepfade', entry: 27.10,  exit: 28.72,  r: 2.01,  pnl: 29.8,  why: 'tp',   ts: round(RB_T0 - 118000, 1) },
      { coin: 'SOL',  side: 'short', strat: 'deepfade', entry: 171.8,  exit: 175.3,  r: -1.04, pnl: -15.6, why: 'stop', ts: round(RB_T0 - 128000, 1) },
      { coin: 'AVAX', side: 'long',  strat: 'pullback', entry: 24.30,  exit: 24.11,  r: -0.22, pnl: -3.3,  why: 'time', ts: round(RB_T0 - 152000, 1) },
    ],
  };
  ruleBook.cash = round(ruleBook.start + ruleBook.trades.reduce((a, t) => a + (t.pnl || 0), 0), 2);
  // Live rule-book equity = cash + open uPnL at the current (drifting) marks.
  function rbEquityNow() {
    let upnl = 0;
    for (const [coin, p] of Object.entries(ruleBook.positions)) {
      const mark = markFor(coin) != null ? markFor(coin) : p.entry;
      const dir = p.side === 'short' ? -1 : 1;
      upnl += (mark - p.entry) * dir * (p.notional / p.entry);
    }
    return round(ruleBook.cash + upnl, 2);
  }
  // Equity history: ~35 hourly points drifting from the $300 start up to the current live equity, so the
  // curve is continuous into the live tail (appended each cycle in tick()). Noise-around-trend, endpoints exact.
  const rbEquityHist = [];
  (function buildRBHist() {
    const n = 34, step = 3600;
    const end = rbEquityNow();                 // land the walk on the live equity (cash + open uPnL)
    let ts = RB_T0 - n * step;
    for (let i = 0; i <= n; i++) {
      const frac = i / n;
      const trend = ruleBook.start + (end - ruleBook.start) * frac;
      const val = i === 0 ? ruleBook.start : i === n ? end : trend + gauss() * 2.6;   // exact endpoints
      rbEquityHist.push([round(ts, 1), round(val, 2)]);
      ts += step;
    }
  })();
  // Marks follow the drifting demo prices; equity = cash + open uPnL (stamped every poll here, hourly in prod).
  function ruleBookView() {
    const positions = {};
    let upnlSum = 0;
    for (const [coin, p] of Object.entries(ruleBook.positions)) {
      const mark = round(markFor(coin) != null ? markFor(coin) : p.entry, 4);
      const dir = p.side === 'short' ? -1 : 1;
      const qty = p.notional / p.entry;
      const upnl = round((mark - p.entry) * dir * qty, 2);
      upnlSum += upnl;
      positions[coin] = Object.assign({}, p, { mark, upnl });
    }
    const equity = round(ruleBook.cash + upnlSum, 2);
    // Return a copy; the final point tracks the live (between-cycle) equity so the chart endpoint == KPI equity.
    const hist = rbEquityHist.map((p) => [p[0], p[1]]);
    if (hist.length) hist[hist.length - 1] = [round(now(), 1), equity];
    return {
      cash: ruleBook.cash, start: ruleBook.start, start_ts: ruleBook.start_ts,
      equity,
      equity_hist: hist,
      positions,
      pending: ruleBook.pending.map((o) => Object.assign({}, o)),
      trades: ruleBook.trades.map((t) => Object.assign({}, t)),
    };
  }

  function status() {
    const snap = snapshot();
    const t = now();
    return {
      mode: config.mode,
      killed,
      daily_halt: dailyHalt,
      starting_equity: startEquity,
      start_ts: round(startTs, 1),
      goal: { target_multiple: config.goal.target_multiple, horizon_days: config.goal.horizon_days },
      equity: snap.equity_usd,
      multiple: round(snap.equity_usd / startEquity, 4),
      days_elapsed: round((t - startTs) / 86400, 2),
      last_cycle_ts: lastCycleTs,
      cycles_total: cycleId,
      llm_model: config.llm.proposer.model,
      tokens_today: sumRoles(usage.today),
      tokens_total: sumRoles(usage.total),
      watch_levels: killed ? [] : [
        { coin: 'BTC', direction: 'above', px: 79600, note: 'Breakout confirmation — reassess the long if the range high clears', ts: round(t - 2100, 1) },
        { coin: 'SOL', direction: 'below', px: 165.4, note: 'Stop loss level for SOL long', ts: round(t - 6300, 1) },
        { coin: 'XRP', direction: 'above', px: 0.66, note: 'Take-profit zone for the XRP swing', ts: round(t - 11800, 1) },
      ],
      // Independent market-research brief (You.com API, refreshed ~6h). Markdown-ish text.
      market_brief: {
        ts: round(t - 7600, 1),
        content: '- **BTC — $78,089:** support **$77.4k–$78.0k**; resistance **$78.3k**, then **$80k–$81.5k** and **$83k**. [[1, 2]]\n' +
          '- **BTC liquidation zones:** reported long-liquidation interest around **$77k–$78k**, with a larger downside cluster near **$75k**; **$82.7M** liquidated over 24h, **~87.6% longs**. [[2]]\n' +
          '- **ETH — $2,449.89:** near-term support **$2,429–$2,440**; resistance **$2,458**, then **$2,471**, **$2,503–$2,528**. [[3, 4]]\n' +
          '- **ETH liquidations:** approximately **$90.65M** in 24h futures liquidations; no reliable price-cluster levels were reported in the retrieved feed. [[5]]\n' +
          '- **Funding:** BTC **+0.0086%/4h**, approximately **18.8% annualized**; positive in **42/42** periods but below the cited **+0.03%/4h** crowding threshold—bullish carry, not an extreme. [[2]]\n' +
          '- **ETH/SOL/XRP/BNB/DOGE:** no comparable live numeric extremes were reliably reported; avoid treating headline "positive funding" as a trade signal. [[6, 7]]\n' +
          '- **Next 72h:** weekend liquidity first; monitor **U.S. ISM Manufacturing PMI / construction-spending calendar entries for Sep. 1** and any Fed communication, with hawkish repricing the principal downside catalyst. [[8, 9, 10]]',
      },
      // Stop-out counterfactuals: MFE in the 4h after each exit + whether the original TP would have hit.
      exit_quality: [
        { coin: 'SOL', side: 'long', exit_ts: round(t - 5400, 1), mfe_pct: 3.8, tp_hit: true },
        { coin: 'ETH', side: 'short', exit_ts: round(t - 14200, 1), mfe_pct: 1.2, tp_hit: false },
        { coin: 'DOGE', side: 'long', exit_ts: round(t - 26400, 1), mfe_pct: -0.6, tp_hit: false },
        { coin: 'BTC', side: 'short', exit_ts: round(t - 41000, 1), mfe_pct: 0.3, tp_hit: null },
        { coin: 'SUI', side: 'long', exit_ts: round(t - 55600, 1), mfe_pct: 5.1, tp_hit: true },
        { coin: 'AVAX', side: 'short', exit_ts: round(t - 69800, 1), mfe_pct: -1.4, tp_hit: false },
      ],
      // Limit orders resting on the book, waiting for price to touch.
      resting_orders: killed ? [] : [
        { coin: 'SUI', side: 'short', size_usd: 25, limit_price: 0.725, stop_loss_px: 0.762, take_profit_px: 0.648, ts: round(t - 3300, 1) },
        { coin: 'LINK', side: 'long', size_usd: 40, limit_price: 13.62, stop_loss_px: 13.05, take_profit_px: 15.1, ts: round(t - 9800, 1) },
      ],
      // Rejected entries, paper-simulated to score the rejecter (status.shadow_trades).
      // live_r follows the drifting mark so the demo shows it updating; sign = the REJECTED trade's PoV.
      shadow_trades: killed ? { open: [], resolved: [] } : {
        open: [
          shadowOpen('DOGE', 'long', 0.1390, 0.1330, 0.1530, 45, 'verifier',
            'Verifier: breakout not confirmed - OI flat and funding already elevated; chasing here risks a fakeout above range highs.', t - 4700),
          shadowOpen('ETH', 'short', 3435, 3520, 3210, 50, 'verifier',
            'Verifier: shorting into rising OI with funding barely positive - no confirmed rejection at the level yet.', t - 8600),
          shadowOpen('LINK', 'long', 15.6, 14.9, 17.2, 60, 'risk_gate',
            'Risk gate: max_open_positions (4) reached and stop distance 4.5% leaves too little room after the cooldown window.', t - 12400),
          shadowOpen('SUI', 'short', 1.94, 2.02, 1.72, 30, 'rr_model',
            'RR model: reward:risk 1.3 below the 1.5 minimum at the proposed stop; edge too thin after fees.', t - 26900),
        ],
        resolved: [
          { coin: 'PENGU', side: 'short', entry_px: 0.0312, stop_px: 0.0331, tp_px: 0.0268, by: 'verifier', status: 'stopped', r: -1.0, ts: round(t - 31000, 1) },
          { coin: 'AVAX', side: 'long', entry_px: 23.4, stop_px: 22.6, tp_px: 25.1, by: 'risk_gate', status: 'target', r: 2.1, ts: round(t - 52000, 1) },
          { coin: 'SOL', side: 'long', entry_px: 164.8, stop_px: 160.1, tp_px: 176.2, by: 'verifier', status: 'target', r: 2.4, size_usd: 55, ts: round(t - 64000, 1) },
          { coin: 'ARB', side: 'short', entry_px: 0.744, stop_px: 0.771, tp_px: 0.688, by: 'rr_model', status: 'expired', r: 0.4, ts: round(t - 76000, 1) },
          { coin: 'HYPE', side: 'long', entry_px: 28.9, stop_px: 27.6, tp_px: 32.2, by: 'verifier', status: 'stopped', r: -1.0, ts: round(t - 103000, 1) },
        ],
      },
      // Today's prediction-market research spend (You.com calls).
      research_today: { day: new Date(t * 1000).toISOString().slice(0, 10), usd: 0.012 },
      // Proposer-only counterfactual book: the LLM book if the verifier never vetoed (status.proposer_book).
      // Equity tracks the drifting demo prices so the race strip moves between polls.
      proposer_book: {
        start: startEquity,
        equity: round(snap.equity_usd + 15.72, 2),
        vetoes_resolved: 7,
        vetoes_open: 8,
        vetoed_r: 3.53,
        note: 'counterfactual: LLM book if the verifier never vetoed (gates still applied); shadow fills are optimistic',
      },
      // Deterministic rule-based book racing the LLM book (A/B benchmark).
      rule_book: ruleBookView(),
      snapshot: snap,
    };
  }

  // =====================================================================
  // Admin API mock (see API_ADMIN.md). Errors are thrown as {status, detail}.
  // =====================================================================
  const LIVE_ACK = 'I_UNDERSTAND_THIS_IS_REAL_MONEY_AND_I_CAN_LOSE_ALL_OF_IT';
  const PUBLIC_SECRETS = ['POLY_SIGNATURE_TYPE', 'HL_ACCOUNT_ADDRESS', 'POLY_FUNDER', 'TELEGRAM_CHAT_ID'];
  const secrets = {
    GEMINI_API_KEY: 'AIza-demo-key', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: 'sk-ant-demo',
    HL_API_WALLET_PRIVATE_KEY: '', HL_ACCOUNT_ADDRESS: '',
    POLY_PRIVATE_KEY: '', POLY_FUNDER: '', POLY_SIGNATURE_TYPE: '0',
    TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', LIVE_TRADING_ACK: '',
  };
  function secretsView() {
    const out = {};
    for (const k of Object.keys(secrets)) out[k] = PUBLIC_SECRETS.includes(k) ? String(secrets[k] || '') : !!secrets[k];
    return out;
  }

  const MODELS = ['gemini-3.6-flash', 'gemini-3.6-pro', 'claude-sonnet-5', 'claude-haiku-4.5', 'gpt-5.4', 'gpt-5.4-mini'];
  const PROVIDERS = ['gemini', 'anthropic', 'openai'];
  const schema = {
    'mode': { type: 'enum', options: ['paper', 'testnet', 'live'], label: 'Mode', help: 'paper = simulated fills · testnet = Hyperliquid testnet · live = REAL MONEY', danger: true },
    'paper_starting_equity_usd': { type: 'float', min: 10, max: 1000000, label: 'Paper starting equity (USD)', help: 'Used when the journal is reset in paper mode.' },
    'goal.target_multiple': { type: 'float', min: 1.01, max: 100, label: 'Target multiple', help: 'e.g. 2.0 = double the account' },
    'goal.horizon_days': { type: 'int', min: 1, max: 365, label: 'Horizon (days)' },
    'goal.mandate': { type: 'text', label: 'Mandate (shown to the model)', help: 'Free text injected into every proposer prompt.' },
    'loop_interval_seconds': { type: 'int', min: 60, max: 3600, label: 'Cycle interval (s)', help: 'Seconds between decision cycles.' },
    'llm.proposer.provider': { type: 'enum', options: PROVIDERS, label: 'Proposer provider' },
    'llm.proposer.model': { type: 'enum', options: MODELS, label: 'Proposer model', help: 'Generates the decision every cycle.' },
    'llm.verifier.enabled': { type: 'bool', label: 'Verifier enabled', help: 'Second model reviews every non-hold decision before the risk gate.' },
    'llm.verifier.provider': { type: 'enum', options: PROVIDERS, label: 'Verifier provider' },
    'llm.verifier.model': { type: 'enum', options: MODELS, label: 'Verifier model' },
    'llm.fallbacks': { type: 'list[model]', label: 'Fallback models', help: 'Tried in order when the proposer errors or is rate-limited.' },
    'llm.stance': { type: 'enum', options: ['active', 'conservative'], label: 'Stance', help: 'conservative = hold unless the setup is unusually clean' },
    'llm.daily_cost_cap_usd': { type: 'float', min: 0, max: 1000, label: 'Daily LLM cost cap (USD)', help: 'Cycles are skipped once today\'s spend exceeds this.' },
    'llm.prices': { type: 'map[str->list[float]]', label: 'Model prices ($ / 1M tokens: input, output)', help: 'Used for the cost tiles and the cost cap.' },
    'risk.max_leverage': { type: 'int', min: 1, max: 20, label: 'Max leverage', danger: true },
    'risk.max_position_pct_equity': { type: 'float', min: 1, max: 100, label: 'Max position (% equity)', danger: true },
    'risk.max_gross_exposure_pct': { type: 'float', min: 10, max: 1000, label: 'Max gross exposure (% equity)', danger: true },
    'risk.max_open_positions': { type: 'int', min: 1, max: 20, label: 'Max open positions' },
    'risk.max_daily_loss_pct': { type: 'float', min: 0.5, max: 50, label: 'Daily loss halt (%)', danger: true },
    'risk.max_drawdown_pct': { type: 'float', min: 1, max: 90, label: 'Drawdown kill (%)', help: 'Agent flattens and stops when drawdown from peak exceeds this.', danger: true },
    'risk.require_stop_loss': { type: 'bool', label: 'Require stop loss', danger: true },
    'risk.max_stop_distance_pct': { type: 'float', min: 0.5, max: 50, label: 'Max stop distance (%)', danger: true },
    'risk.min_seconds_between_orders': { type: 'int', min: 0, max: 3600, label: 'Order cooldown (s)' },
    'risk.max_orders_per_hour': { type: 'int', min: 1, max: 200, label: 'Max orders / hour' },
    'risk.min_order_usd': { type: 'float', min: 1, max: 10000, label: 'Min order (USD)' },
    'risk.prediction_market_max_pct_equity': { type: 'float', min: 0, max: 100, label: 'PM max per market (% equity)', danger: true },
    'risk.prediction_market_max_total_pct': { type: 'float', min: 0, max: 100, label: 'PM max total (% equity)', danger: true },
    'risk.min_equity_usd': { type: 'float', min: 0, max: 100000, label: 'Min equity (USD)', help: 'Agent halts below this.' },
    'rr.min_reward_risk': { type: 'float', min: 0.5, max: 10, label: 'Min reward : risk' },
    'rr.max_risk_per_trade_pct': { type: 'float', min: 0.1, max: 25, label: 'Max risk / trade (% equity)', danger: true },
    'rr.kelly_fraction': { type: 'float', min: 0.01, max: 1, label: 'Kelly fraction' },
    'rr.pm_min_edge': { type: 'float', min: 0, max: 0.5, label: 'PM min edge' },
    'learner.enabled': { type: 'bool', label: 'Learner enabled' },
    'learner.alpha': { type: 'float', min: 0.01, max: 1, label: 'EMA alpha' },
    'learner.min_samples': { type: 'int', min: 1, max: 50, label: 'Min samples' },
    'learner.min_multiplier': { type: 'float', min: 0, max: 1, label: 'Min size multiplier' },
    'learner.max_multiplier': { type: 'float', min: 0.1, max: 3, label: 'Max size multiplier' },
    'universe.perps': { type: 'list[str]', label: 'Perp universe', help: 'Hyperliquid coin symbols.' },
    'universe.spot': { type: 'list[str]', label: 'Spot universe', help: 'Pairs like HYPE/USDC.' },
    'universe.prediction_markets.enabled': { type: 'bool', label: 'Prediction markets enabled' },
    'universe.prediction_markets.max_days_to_resolution': { type: 'int', min: 1, max: 365, label: 'PM max days to resolution' },
    'universe.prediction_markets.min_liquidity_usd': { type: 'float', min: 0, max: 10000000, label: 'PM min liquidity (USD)' },
    'universe.prediction_markets.max_markets_shown': { type: 'int', min: 1, max: 100, label: 'PM max markets shown to the model' },
    'universe.prediction_markets.keywords': { type: 'list[str]', label: 'PM keyword filter', help: 'Only markets whose question contains one of these.' },
    'notify.telegram_enabled': { type: 'bool', label: 'Telegram notifications' },
    'notify.on_fill': { type: 'bool', label: 'Notify on fill' },
    'notify.on_reject': { type: 'bool', label: 'Notify on rejected action' },
    'notify.daily_summary': { type: 'bool', label: 'Daily summary' },
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
  function deepMerge(dst, src) {
    for (const k of Object.keys(src)) {
      if (isObj(src[k]) && isObj(dst[k])) deepMerge(dst[k], src[k]);
      else dst[k] = clone(src[k]);
    }
    return dst;
  }
  function fail(status, detail) { const e = new Error(detail); e.status = status; e.detail = detail; throw e; }
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function validate(cfg) {
    for (const [path, f] of Object.entries(schema)) {
      const v = getPath(cfg, path);
      if (v === undefined) return `${path}: field required`;
      switch (f.type) {
        case 'int': if (typeof v !== 'number' || !Number.isInteger(v)) return `${path}: must be an integer`; break;
        case 'float': if (typeof v !== 'number' || isNaN(v)) return `${path}: must be a number`; break;
        case 'bool': if (typeof v !== 'boolean') return `${path}: must be true/false`; break;
        case 'str': case 'text': if (typeof v !== 'string') return `${path}: must be a string`; break;
        case 'enum': if (!f.options.includes(v)) return `${path}: must be one of ${f.options.join(', ')}`; break;
        case 'list[str]': if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) return `${path}: must be a list of non-empty strings`; break;
        case 'list[model]': if (!Array.isArray(v) || v.some((m) => !isObj(m) || !m.provider || !m.model || typeof m.enabled !== 'boolean')) return `${path}: each entry needs provider, model, enabled`; break;
        case 'map[str->list[float]]':
          if (!isObj(v)) return `${path}: must be a mapping`;
          for (const [k, arr] of Object.entries(v)) if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'number' || isNaN(x))) return `${path}.${k}: must be a list of numbers`;
          break;
      }
      if ((f.type === 'int' || f.type === 'float')) {
        if (f.min != null && v < f.min) return `${path}: ${v} is below the minimum ${f.min}`;
        if (f.max != null && v > f.max) return `${path}: ${v} is above the maximum ${f.max}`;
      }
    }
    if (cfg.learner.min_multiplier > cfg.learner.max_multiplier) return 'learner.min_multiplier: must be <= learner.max_multiplier';
    if (cfg.risk.max_daily_loss_pct >= cfg.risk.max_drawdown_pct) return 'risk.max_daily_loss_pct: must be below risk.max_drawdown_pct';
    return null;
  }

  function signalRestart() { restartAt = now(); }

  const admin = {
    health: () => ({ ok: true, mode: config.mode, ts: now(), google_client_id: 'demo-client-id.apps.googleusercontent.com', admin_email_hint: 'd…o@example.com' }),
    settings: async () => {
      await delay(250);
      return { config: clone(config), schema: clone(schema), secrets: secretsView(), live_ack_phrase: LIVE_ACK, agent: { restart_pending: !!restartAt, last_reload_ts: lastReloadTs } };
    },
    putSettings: async (body) => {
      await delay(400);
      if (!body || !isObj(body.config)) fail(422, 'config: object required');
      const next = deepMerge(clone(config), body.config);
      const err = validate(next);
      if (err) fail(422, err);
      if (next.mode === 'live' && config.mode !== 'live') {
        const missing = [];
        if (secrets.LIVE_TRADING_ACK !== LIVE_ACK) missing.push('LIVE_TRADING_ACK secret must equal the ack phrase');
        if (!secrets.HL_API_WALLET_PRIVATE_KEY) missing.push('HL_API_WALLET_PRIVATE_KEY not set');
        if (!secrets.HL_ACCOUNT_ADDRESS) missing.push('HL_ACCOUNT_ADDRESS not set');
        if (body.confirm_live !== LIVE_ACK) missing.push('request must include confirm_live with the exact phrase');
        if (missing.length) fail(409, 'refusing to switch to live: ' + missing.join('; '));
      }
      deepMerge(config, body.config);
      LOOP = config.loop_interval_seconds;
      signalRestart();
      return { ok: true, restart: true, config: clone(config) };
    },
    putSecrets: async (body) => {
      await delay(300);
      if (!isObj(body)) fail(422, 'body: object required');
      for (const [k, v] of Object.entries(body)) {
        if (!(k in secrets)) fail(422, `${k}: unknown secret`);
        if (typeof v !== 'string') fail(422, `${k}: must be a string`);
        secrets[k] = v;
      }
      signalRestart();
      return { ok: true, secrets: secretsView(), restart: true };
    },
    preflight: async () => {
      await delay(1800);
      const prov = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
      const checks = [];
      const pk = prov[config.llm.proposer.provider];
      checks.push({ name: 'LLM proposer key + model', pass: !!secrets[pk], detail: secrets[pk] ? `${config.llm.proposer.model} responded in 812 ms` : `${pk} not set` });
      if (config.llm.verifier.enabled) {
        const vk = prov[config.llm.verifier.provider];
        checks.push({ name: 'LLM verifier key + model', pass: !!secrets[vk], detail: secrets[vk] ? `${config.llm.verifier.model} responded in 1204 ms` : `${vk} not set` });
      }
      for (const f of config.llm.fallbacks.filter((x) => x.enabled)) checks.push({ name: `Fallback ${f.model}`, pass: !!secrets[prov[f.provider]], detail: secrets[prov[f.provider]] ? 'key present' : `${prov[f.provider]} not set (fallback would be skipped)` });
      const hl = !!secrets.HL_API_WALLET_PRIVATE_KEY && !!secrets.HL_ACCOUNT_ADDRESS;
      checks.push({ name: 'Hyperliquid market data', pass: true, detail: `${config.universe.perps.length} perps resolved, mids fresh (0.4 s)` });
      checks.push({ name: 'Hyperliquid API wallet', pass: config.mode === 'paper' ? true : hl, detail: hl ? 'wallet authorised, cannot withdraw (API wallet)' : config.mode === 'paper' ? 'not needed in paper mode' : 'HL_API_WALLET_PRIVATE_KEY / HL_ACCOUNT_ADDRESS missing' });
      if (config.universe.prediction_markets.enabled) {
        const poly = !!secrets.POLY_PRIVATE_KEY && !!secrets.POLY_FUNDER;
        checks.push({ name: 'Polymarket CLOB', pass: config.mode === 'paper' ? true : poly, detail: poly ? 'credentials derived, allowance OK' : config.mode === 'paper' ? 'read-only in paper mode' : 'POLY_PRIVATE_KEY / POLY_FUNDER missing' });
      }
      if (config.notify.telegram_enabled) checks.push({ name: 'Telegram', pass: !!secrets.TELEGRAM_BOT_TOKEN && !!secrets.TELEGRAM_CHAT_ID, detail: secrets.TELEGRAM_BOT_TOKEN ? 'test message sent' : 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing' });
      checks.push({ name: 'Risk limits sanity', pass: true, detail: `max lev ${config.risk.max_leverage}x · daily loss ${config.risk.max_daily_loss_pct}% · drawdown kill ${config.risk.max_drawdown_pct}%` });
      checks.push({ name: 'Live trading ack', pass: config.mode !== 'live' || secrets.LIVE_TRADING_ACK === LIVE_ACK, detail: secrets.LIVE_TRADING_ACK === LIVE_ACK ? 'LIVE_TRADING_ACK matches the phrase' : 'LIVE_TRADING_ACK not set (required for live)' });
      checks.push({ name: 'Journal writable', pass: true, detail: 'data/journal.db ok, 2.1 MB' });
      return { ok: checks.every((c) => c.pass), checks };
    },
    restart: async () => { await delay(200); signalRestart(); return { ok: true }; },
    resetJournal: async (body) => {
      await delay(500);
      if (!body || body.confirm !== 'RESET') fail(422, 'confirm: must be "RESET"');
      if (config.mode !== 'paper') fail(409, 'reset-journal is only allowed in paper mode');
      startEquity = config.paper_starting_equity_usd;
      startTs = now();
      equity.length = 0;
      cycles.length = 0;
      perps.length = 0; spot.length = 0; pm.length = 0;
      for (const c of contexts) { c.q = 0; c.n = 0; c.wins = 0; c.total_r = 0; c.total_pnl = 0; }
      cycleId = 0;
      lastCycleTs = round(now(), 1);
      equity.push({ ts: lastCycleTs, equity: startEquity });
      for (const bucket of [usage.today]) for (const k of Object.keys(bucket)) bucket[k] = mkRole(bucket[k].model, 0, 0, 0);
      killed = null; dailyHalt = false;
      signalRestart();
      return { ok: true };
    },
  };


  // =====================================================================
  // Analytics + learner extras (see API_ANALYTICS.md)
  // =====================================================================
  const T0 = now();   // closed trades / post-mortems / shadow trades are anchored to page load ("h" = hours ago)
  const CLOSED = [
    { h: 0.9,  kind: 'close_perp', venue: 'perps', coin: 'DOGE', side: 'long',  pnl: 6.42,  r: 1.3,  reason: 'agent',       closed_by: 'agent',    detail: 'paper close long 1120 DOGE @ 0.1441 (fee $0.06)' },
    { h: 3.4,  kind: 'close_perp', venue: 'perps', coin: 'ETH',  side: 'long',  pnl: -5.10, r: -1.0, reason: 'stop',        closed_by: 'STOP hit', detail: 'stop 3,362 hit; paper close long 0.058 ETH @ 3,361.2 (fee $0.07)' },
    { h: 7.2,  kind: 'close_perp', venue: 'perps', coin: 'SOL',  side: 'short', pnl: 8.35,  r: 1.9,  reason: 'take_profit', closed_by: 'TP hit',   detail: 'take-profit 158.0 hit; paper close short 1.2 SOL @ 158.1 (fee $0.07)' },
    { h: 11.6, kind: 'close_spot', venue: 'spot',  coin: 'HYPE', side: 'long',  pnl: 1.92,  r: 0.6,  reason: 'agent',       closed_by: 'agent',    detail: 'paper sell 2.4 HYPE/USDC @ 28.10 (fee $0.03)' },
    { h: 16.0, kind: 'close_perp', venue: 'perps', coin: 'HYPE', side: 'long',  pnl: -4.40, r: -1.0, reason: 'stop',        closed_by: 'STOP hit', detail: 'stop 27.02 hit; paper close long 5.3 HYPE @ 27.00 (fee $0.05)' },
    { h: 22.5, kind: 'close_perp', venue: 'perps', coin: 'BTC',  side: 'long',  pnl: 9.80,  r: 1.6,  reason: 'take_profit', closed_by: 'TP hit',   detail: 'take-profit 79,900 hit; paper close long 0.0029 BTC @ 79,905 (fee $0.08)' },
    { h: 29.0, kind: 'close_pm',   venue: 'prediction_markets', coin: 'ETH>3.5k', side: 'Yes', pnl: -3.20, r: -1.0, reason: 'stale', closed_by: 'stale', detail: 'exited "ETH above $3,500 on Aug 24?" Yes @ 0.31 after 48h without progress' },
    { h: 35.3, kind: 'close_perp', venue: 'perps', coin: 'SOL',  side: 'short', pnl: 4.05,  r: 1.1,  reason: 'agent',       closed_by: 'agent',    detail: 'paper close short 1.1 SOL @ 166.9 (fee $0.06) — momentum faded' },
    { h: 44.1, kind: 'close_perp', venue: 'perps', coin: 'ETH',  side: 'long',  pnl: -4.85, r: -1.0, reason: 'stop',        closed_by: 'STOP hit', detail: 'stop 3,348 hit; paper close long 0.055 ETH @ 3,347.1 (fee $0.06)' },
    { h: 52.8, kind: 'close_perp', venue: 'perps', coin: 'BTC',  side: 'long',  pnl: 3.10,  r: 0.5,  reason: 'stale',       closed_by: 'stale',    detail: 'closed after 30h without reaching TP; paper close long 0.0027 BTC @ 78,610' },
    { h: 61.0, kind: 'close_perp', venue: 'perps', coin: 'HYPE', side: 'long',  pnl: -3.55, r: -1.0, reason: 'stop',        closed_by: 'STOP hit', detail: 'stop 26.40 hit; paper close long 4.8 HYPE @ 26.37 (fee $0.04)' },
    { h: 70.4, kind: 'close_pm',   venue: 'prediction_markets', coin: 'FOMC cut', side: 'Yes', pnl: 2.60, r: 0.8, reason: 'agent', closed_by: 'agent', detail: 'sold 40 Yes "Fed rate cut at September FOMC?" @ 0.735 (bought 0.67)' },
    { h: 84.9, kind: 'close_perp', venue: 'perps', coin: 'ETH',  side: 'long',  pnl: -3.45, r: -1.0, reason: 'stop',        closed_by: 'STOP hit', detail: 'stop 3,390 hit; paper close long 0.04 ETH @ 3,389.0 (fee $0.05)' },
    { h: 96.2, kind: 'close_perp', venue: 'perps', coin: 'DOGE', side: 'long',  pnl: -4.32, r: -1.0, reason: 'stop',        closed_by: 'STOP hit', detail: 'stop 0.1398 hit; paper close long 1500 DOGE @ 0.1397 (fee $0.07)' },
  ];
  const POSTMORTEMS = [
    { h: 3.4, coin: 'ETH', side: 'long', R: -1.0, pnl: -5.10, closed_by: 'STOP hit',
      lesson: 'Expected continuation above the 4h SMA50 after the CPI dip was bought. Price reversed within 2h on a funding spike and swept the stop at 3,362 before recovering.\nLesson: in chop regimes wait for a 4h close above the level instead of buying the first reclaim; keep ETH longs at 0.5x size until the learner shows a positive Q for perp|ETH|long.' },
    { h: 16.0, coin: 'HYPE', side: 'long', R: -1.0, pnl: -4.40, closed_by: 'STOP hit',
      lesson: 'Bought the buyback-flow narrative into resistance at 28.4 with a 3% stop. The move had already run 9% in 24h and the stop sat inside normal noise.\nLesson: a 3% stop on a coin with a 6% daily range is a coin flip. Either widen the stop and cut size, or skip extended moves entirely.' },
    { h: 29.0, coin: 'ETH>3.5k', side: 'Yes', R: -1.0, pnl: -3.20, closed_by: 'stale',
      lesson: 'Prediction market "ETH above $3,500 on Aug 24" bought at 0.44 with an estimated 0.55 probability. Spot never got near 3,500 and the position bled as time decayed.\nLesson: PM edge estimates must include time to resolution; with under 3 days left the required move was 2.5 daily ranges. Add a distance/time check before buying.' },
    { h: 44.1, coin: 'ETH', side: 'long', R: -1.0, pnl: -4.85, closed_by: 'STOP hit',
      lesson: 'Second ETH long in a row stopped in the same 3,350-3,420 range. Regime was "low vol chop" and the setup was a range-low bounce that failed.\nLesson: the context perp|ETH|long|low|chop is now -1.85R over 3 trades. Stop trading it until the regime changes.' },
    { h: 96.2, coin: 'DOGE', side: 'long', R: -1.0, pnl: -4.32, closed_by: 'STOP hit',
      lesson: 'Chased a 4h breakout on DOGE with 4x leverage; the breakout candle was the local top and the stop was hit on the retest.\nLesson: on memecoins enter on the retest of the breakout level, not the breakout candle, and cap leverage at 3x.' },
  ];
  // Every rejected perp proposal is shadow-simulated; `by` says which layer rejected it (verifier | risk_gate | rr_model).
  const SHADOW = [
    { h: 1.2,  by: 'verifier',  coin: 'ETH',  side: 'short', entry_px: 3428,  stop_px: 3492,  tp_px: 3310,  confidence: 0.58, reason: 'VERIFIER: shorting into a reclaimed VWAP with negative funding is fighting positioning; wait for a lower high.', status: 'open',    r: null },
    { h: 3.4,  by: 'risk_gate', coin: 'SOL',  side: 'long',  entry_px: 168.2, stop_px: 163.9, tp_px: 177.0, confidence: 0.63, reason: 'GATE: gross exposure would reach 64% of equity (cap 60%).', status: 'open',    r: null },
    { h: 5.8,  by: 'verifier',  coin: 'AVAX', side: 'long',  entry_px: 24.1,  stop_px: 23.2,  tp_px: 26.0,  confidence: 0.52, reason: 'VERIFIER: thin R:R at 1.4 after slippage and no catalyst named.', status: 'open',    r: null },
    { h: 9.1,  by: 'rr_model',  coin: 'OP',   side: 'long',  entry_px: 1.62,  stop_px: 1.55,  tp_px: 1.71,  confidence: 0.56, reason: 'RR: reward:risk 1.29 after fees is below the 1.5 minimum.', status: 'stopped', r: -1.0 },
    { h: 14.5, by: 'verifier',  coin: 'XRP',  side: 'long',  entry_px: 0.618, stop_px: 0.598, tp_px: 0.66,  confidence: 0.55, reason: 'VERIFIER: breakout has no volume confirmation and OI is flat.', status: 'stopped', r: -1.0 },
    { h: 18.2, by: 'risk_gate', coin: 'BTC',  side: 'long',  entry_px: 78650, stop_px: 77900, tp_px: 80400, confidence: 0.66, reason: 'GATE: 4 open positions is the cap (max_open_positions=4).', status: 'target',  r: 2.3 },
    { h: 21.0, by: 'verifier',  coin: 'LINK', side: 'long',  entry_px: 15.4,  stop_px: 14.8,  tp_px: 16.6,  confidence: 0.6,  reason: 'VERIFIER: position count is at the cap; adding correlated beta is not diversification.', status: 'target',  r: 2.0 },
    { h: 27.6, by: 'rr_model',  coin: 'TIA',  side: 'short', entry_px: 4.85,  stop_px: 5.05,  tp_px: 4.55,  confidence: 0.53, reason: 'RR: risk per trade 2.6% of equity exceeds the 2% cap even at the minimum size.', status: 'expired', r: -0.2 },
    { h: 33.7, by: 'verifier',  coin: 'SUI',  side: 'long',  entry_px: 1.91,  stop_px: 1.82,  tp_px: 2.08,  confidence: 0.5,  reason: 'VERIFIER: 4.7% stop on a 5x proposal is outside comfort; the setup is a mean-reversion guess.', status: 'stopped', r: -1.0 },
    { h: 38.4, by: 'risk_gate', coin: 'ETH',  side: 'long',  entry_px: 3395,  stop_px: 3180,  tp_px: 3620,  confidence: 0.6,  reason: 'GATE: stop distance 6.3% exceeds max_stop_distance_pct 5%.', status: 'target',  r: 1.05 },
    { h: 41.2, by: 'verifier',  coin: 'DOGE', side: 'short', entry_px: 0.146, stop_px: 0.152, tp_px: 0.134, confidence: 0.54, reason: 'VERIFIER: shorting momentum with funding still low and no distribution evidence.', status: 'stopped', r: -1.0 },
    { h: 47.9, by: 'rr_model',  coin: 'WIF',  side: 'long',  entry_px: 1.24,  stop_px: 1.19,  tp_px: 1.31,  confidence: 0.51, reason: 'RR: Kelly-fraction size is $8.40, below min_order_usd 10.', status: 'stopped', r: -1.0 },
    { h: 55.9, by: 'verifier',  coin: 'BTC',  side: 'short', entry_px: 79400, stop_px: 80600, tp_px: 77200, confidence: 0.57, reason: 'VERIFIER: counter-trend short against the daily trend while the learner favours BTC longs.', status: 'expired', r: 0.3 },
    { h: 61.5, by: 'risk_gate', coin: 'SOL',  side: 'short', entry_px: 171.4, stop_px: 175.8, tp_px: 162.0, confidence: 0.58, reason: 'GATE: order cooldown — last order was 41 s ago (min 120 s).', status: 'stopped', r: -1.0 },
    { h: 68.3, by: 'verifier',  coin: 'ARB',  side: 'long',  entry_px: 0.72,  stop_px: 0.69,  tp_px: 0.78,  confidence: 0.51, reason: 'VERIFIER: confidence 0.51 is barely above a coin flip; the mandate says hold when in doubt.', status: 'stopped', r: -1.0 },
  ];
  const agoTs = (h) => round(T0 - h * 3600, 1);

  // Score one rejecter over its shadow trades (same shape as the legacy verifier_score); `who` names it in the verdict.
  const REJECTER_NAMES = { all: 'rejection overall', verifier: 'verifier', risk_gate: 'risk gate', rr_model: 'RR model' };
  function rejectionScore(list, who) {
    const resolved = list.filter((s) => s.status !== 'open' && s.r != null);
    const open = list.length - resolved.length;
    if (!resolved.length) return { resolved: 0, open };
    const won = resolved.filter((s) => s.r > 0).length, lost = resolved.length - won;
    const sumR = resolved.reduce((a, s) => a + s.r, 0);
    const avgR = sumR / resolved.length;
    const saved = -sumR;
    const earning = saved > 0;
    const name = REJECTER_NAMES[who] || who;
    return {
      resolved: resolved.length, open, vetoed_would_have_won: won, vetoed_would_have_lost: lost,
      avg_r_of_vetoed: round(avgR, 2), sum_r_saved: round(saved, 2),
      verdict: earning
        ? `${name} is EARNING its cost (${lost} of ${resolved.length} rejected trades would have lost; rejections saved ${saved >= 0 ? '+' : ''}${saved.toFixed(2)}R net)`
        : `${name} is TOO STRICT (${won} of ${resolved.length} rejected trades would have won; rejections cost ${(-saved).toFixed(2)}R net)`,
    };
  }
  const verifierScore = () => rejectionScore(SHADOW.filter((s) => s.by === 'verifier'), 'verifier');
  function rejectionScores() {
    const out = { all: rejectionScore(SHADOW, 'all') };
    for (const k of ['verifier', 'risk_gate', 'rr_model']) out[k] = rejectionScore(SHADOW.filter((s) => s.by === k), k);
    return out;
  }

  function analytics() {
    const t = now();
    const snap = snapshot();
    const eqNow = snap.equity_usd;
    const days = Math.max(0.01, (t - startTs) / 86400);
    // max drawdown from the equity history
    let peak = -Infinity, ddUsd = 0, ddPct = 0;
    for (const p of equity) {
      if (p.equity > peak) peak = p.equity;
      const d = peak - p.equity;
      if (d > ddUsd) { ddUsd = d; ddPct = peak ? (d / peak) * 100 : 0; }
    }
    const closed = CLOSED.map((c) => ({ ts: agoTs(c.h), kind: c.kind, venue: c.venue, coin: c.coin, side: c.side, pnl: c.pnl, r: c.r, closed_by: c.closed_by, detail: c.detail, reason: c.reason }));
    const wins = closed.filter((c) => c.pnl > 0), losses = closed.filter((c) => c.pnl <= 0);
    const sum = (arr) => arr.reduce((a, c) => a + c.pnl, 0);
    const grossW = sum(wins), grossL = -sum(losses);
    const group = (keyOf, withWins) => {
      const out = {};
      for (const c of closed) {
        const k = keyOf(c);
        const g = out[k] || (out[k] = withWins ? { trades: 0, wins: 0, pnl: 0 } : { trades: 0, pnl: 0 });
        g.trades += 1; if (withWins && c.pnl > 0) g.wins += 1; g.pnl = round(g.pnl + c.pnl, 2);
      }
      return out;
    };
    // daily buckets (UTC) from the equity curve
    const byDay = {}, order = [];
    for (const p of equity) {
      const d = new Date(p.ts * 1000).toISOString().slice(0, 10);
      let g = byDay[d];
      if (!g) { g = byDay[d] = { day: d, open: p.equity, close: p.equity, low: p.equity, high: p.equity, pnl: 0 }; order.push(d); }
      g.close = p.equity; if (p.equity < g.low) g.low = p.equity; if (p.equity > g.high) g.high = p.equity;
      g.pnl = round(g.close - g.open, 2);
    }
    const llmTotal = sumRoles(usage.total).cost_usd;
    const pnlTotal = round(eqNow - startEquity, 2);
    const realized = round(sum(closed), 2);
    const unrealized = round(snap.perps.reduce((a, p) => a + p.unrealized_pnl, 0) + snap.pm.reduce((a, m) => a + (m.cur_price - m.avg_price) * m.shares, 0), 2);
    const cyc = cycleId;
    const rejectedBy = { verifier: SHADOW.length, risk_gate: Math.round(cyc * 0.014), rr_model: Math.round(cyc * 0.009), other: 1 };
    const rejected = rejectedBy.verifier + rejectedBy.risk_gate + rejectedBy.rr_model + rejectedBy.other;
    const fills = closed.length + perps.length + spot.length + pm.length + 6; // closes + opens + stop moves
    return {
      as_of: round(t, 1), since_ts: round(startTs, 1), days: round(days, 2),
      equity: {
        start: startEquity, now: eqNow, multiple: round(eqNow / startEquity, 4), pnl_total: pnlTotal, realized, unrealized,
        max_drawdown_usd: round(ddUsd, 2), max_drawdown_pct: round(ddPct, 2), points: equity.length,
      },
      trades: {
        closed: closed.length, wins: wins.length, losses: losses.length,
        win_rate_pct: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
        avg_win: wins.length ? round(grossW / wins.length, 2) : null, avg_loss: losses.length ? round(-grossL / losses.length, 2) : null,
        largest_win: wins.length ? Math.max.apply(null, wins.map((c) => c.pnl)) : null, largest_loss: losses.length ? Math.min.apply(null, losses.map((c) => c.pnl)) : null,
        profit_factor: !closed.length ? null : grossL ? round(grossW / grossL, 2) : 'Infinity',
        expectancy_per_trade: closed.length ? round((grossW - grossL) / closed.length, 3) : null,
        by_venue: group((c) => c.venue, true),
        by_coin: group((c) => c.coin, true),
        by_close_reason: group((c) => c.reason, false),
        recent: closed.slice(0, 12).map((c) => ({ ts: c.ts, kind: c.kind, venue: c.venue, coin: c.coin, side: c.side, pnl: c.pnl, r: c.r, closed_by: c.closed_by, detail: c.detail })),
      },
      activity: {
        cycles: cyc, quiet_skipped: Math.round(cyc * 0.27), proposer_failures: Math.round(cyc / 45),
        trade_proposals: fills + rejected + 3, rejected, rejected_by: rejectedBy, fills,
      },
      cost: {
        llm_usd_total: round(llmTotal, 4), llm_usd_per_day: round(llmTotal / days, 4),
        pnl_per_llm_usd: llmTotal ? round(pnlTotal / llmTotal, 2) : null, pnl_per_day: round(pnlTotal / days, 2),
        note: 'pnl_per_llm_usd < 1 means the model costs more than it earns',
      },
      daily: order.map((d) => byDay[d]),
      calibration: {
        samples: 23, real: 14, shadow: 9,
        buckets: [
          { bucket: '0.55-0.60', n: 6, real_n: 4, stated_mid: 0.575, win_rate: 0.5, gap: -0.075 },
          { bucket: '0.60-0.65', n: 8, real_n: 5, stated_mid: 0.625, win_rate: 0.375, gap: -0.25 },
          { bucket: '0.65-0.70', n: 5, real_n: 3, stated_mid: 0.675, win_rate: 0.8, gap: 0.125 },
          { bucket: '0.70-0.75', n: 4, real_n: 2, stated_mid: 0.725, win_rate: 0.75, gap: 0.025 },
        ],
        note: 'win_rate vs stated confidence; negative gap = overconfident at that level',
      },
      paper_assumptions: config.mode === 'paper' ? { fee_bps: 4.5, slippage_bps: 8 } : null,
    };
  }

  window.MockAPI = {
    tick,
    health: () => admin.health(),
    admin,
    status,
    equity: (limit) => equity.slice(-(limit || 1000)),
    // cycles({limit, kind, venue}) like GET /api/cycles?limit=&kind=&venue=; a bare number is still accepted as the limit.
    cycles: (opts) => {
      const o = typeof opts === 'number' ? { limit: opts } : (opts || {});
      return cycles.filter((c) => cycleMatches(c, o.kind || 'all', o.venue || 'all')).slice(0, o.limit || 30);
    },
    learner: () => ({
      lessons: lessons(),
      contexts: contexts.slice(),
      open: perps.map(p => ({ key: p.coin, ctx: `perp|${p.coin}|${p.size > 0 ? 'long' : 'short'}|mid|trend`, risk_usd: round(Math.abs(p.entry_px - p.stop_px) * Math.abs(p.size), 2), ts: lastCycleTs - 1800 })),
      postmortems: POSTMORTEMS.map((p) => ({ ts: agoTs(p.h), coin: p.coin, side: p.side, R: p.R, pnl: p.pnl, closed_by: p.closed_by, lesson: p.lesson })),
      verifier_score: verifierScore(),
      rejection_scores: rejectionScores(),
      shadow_trades: SHADOW.map((s) => ({ ts: agoTs(s.h), coin: s.coin, side: s.side, entry_px: s.entry_px, stop_px: s.stop_px, tp_px: s.tp_px, by: s.by, confidence: s.confidence, reason: s.reason, status: s.status, r: s.r })),
    }),
    analytics,
    config: () => JSON.parse(JSON.stringify(config)),
    kill: () => { killed = 'manual kill via dashboard (demo)'; return { ok: true, message: 'demo: kill file written, agent flattening' }; },
  };
})();
