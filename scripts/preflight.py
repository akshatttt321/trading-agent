"""
Preflight: prove the agent can run correctly on THIS machine before it is allowed to trade.
Exit code 0 = all checks passed for the configured mode. Anything else = do not start the agent.

  .venv/bin/python scripts/preflight.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from agent.config import load_config  # noqa: E402
from agent.preflight import run_checks  # noqa: E402

cfg = load_config()
v = cfg.llm.verifier
print(f"preflight for mode={cfg.mode} proposer={cfg.llm.proposer.provider}:{cfg.llm.proposer.model} "
      f"verifier={v.provider}:{v.model if v.enabled else 'off'}")
results = run_checks(cfg)
for r in results:
    print(f"  {'PASS' if r['pass'] else 'FAIL'}  {r['name']:<38} {r['detail']}  ({r['seconds']}s)")
fails = [r for r in results if not r["pass"]]
print()
if fails:
    print(f"{len(fails)} check(s) FAILED - do not start the agent on this machine.")
    sys.exit(1)
print("ALL CHECKS PASSED - this machine can run the agent in mode=" + cfg.mode)
