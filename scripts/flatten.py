"""Close every position on every venue right now (works whether or not the agent loop is running)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from agent.config import load_config  # noqa: E402
from agent.market_data import MarketData  # noqa: E402
from agent.main import build_venues  # noqa: E402
from agent.state import State  # noqa: E402

cfg = load_config()
cfg.validate_runtime()
md = MarketData(cfg)
market = md.gather()
prices = market["_prices"]
prices.update(md.all_mids())
venues = {id(v): v for v in build_venues(cfg, md, State()).values()}.values()
for v in venues:
    for r in v.flatten_all(prices):
        print(("OK   " if r.ok else "FAIL ") + r.detail)
print("done")
