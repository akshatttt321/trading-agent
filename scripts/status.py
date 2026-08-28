"""Print current account, goal progress, learner table and the last N decisions from the journal."""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from agent.config import load_config  # noqa: E402
from agent.learner import Learner  # noqa: E402
from agent.state import State  # noqa: E402

cfg = load_config()
st = State()
start = st.get("starting_equity")
start_ts = st.get("start_ts")
row = st.db.execute("SELECT ts, equity, snapshot, decision FROM cycles ORDER BY id DESC LIMIT 1").fetchone()
print(f"mode: {cfg.mode}   killed: {st.get('killed') or 'no'}   daily_halt: {st.get('daily_halt')}")
if not row:
    print("no cycles yet")
    sys.exit()
ts, eq, snap, dec = row
print(f"last cycle: {time.ctime(ts)}   equity ${eq:,.2f}", end="")
if start:
    print(f"   start ${start:,.2f}   {eq/start:.3f}x   day {(time.time()-start_ts)/86400:.1f}/{cfg.goal.horizon_days}", end="")
print()
snap = json.loads(snap)
for p in snap.get("perps", []):
    print(f"  perp {p['coin']:<6} size={p['size']:+.5g} entry={p['entry_px']:.6g} mark={p['mark_px']:.6g} upnl=${p['unrealized_pnl']:+.2f} sl={p.get('stop_px')} tp={p.get('tp_px')}")
for s in snap.get("spot", []):
    print(f"  spot {s['coin']:<10} {s['amount']:.5g} = ${s['value_usd']:.2f}")
for q in snap.get("pm", []):
    print(f"  pm   {q['outcome']:<6} {q['shares']:.1f}sh @ {q['avg_price']:.3f} -> {q['cur_price']:.3f}  ${q['value_usd']:.2f}  {q['question'][:60]}")
tt = st.get("tokens_total") or {}
td = st.get("tokens_today") or {}
if tt:
    print(f"\nLLM usage ({cfg.llm.proposer.provider}:{cfg.llm.proposer.model}{' + verifier' if cfg.llm.verifier.enabled else ''}): total {tt.get('calls',0)} calls, {tt.get('input',0):,} in + {tt.get('cache_read',0):,} cached / {tt.get('output',0):,} out"
          f"   today: {td.get('calls',0)} calls, {td.get('input',0):,} in / {td.get('output',0):,} out, est ${td.get('cost_usd',0):.3f} (total est ${tt.get('cost_usd',0):.3f})")
print("\n" + Learner(cfg, st).lessons_text())
print("\nrecent:\n" + st.recent_history_text(6))
