"""PART A: Hyperliquid TESTNET execution-code validation. Exercises every venue op the live agent depends on,
against real HL testnet infra, with tiny sizes, cleaning up after itself. REFUSES to run on mainnet.
Run: docker exec deploy-agent-1 python -m agent.testnet_validate    (after testnet keys are in secrets.env)."""
import sys, time
from pathlib import Path
from .config import load_config
from .market_data import MarketData
from .models import Action

PASS, FAIL, WARN = "✅ PASS", "❌ FAIL", "⚠️  WARN"
results = []
def step(name, ok, detail=""):
    tag = PASS if ok else FAIL
    print(f"  {tag}  {name}" + (f" — {str(detail)[:120]}" if detail else ""))
    results.append((name, ok))

def main():
    cfg = load_config(Path("/app/config.yaml"))
    print(f"=== HYPERLIQUID TESTNET VALIDATION (mode={cfg.mode}) ===")
    # HARD SAFETY: only run on testnet
    if cfg.mode != "testnet":
        print(f"  {FAIL}  REFUSING: config mode is '{cfg.mode}', not 'testnet'. Set mode: testnet first. NO real-money test here.")
        return 1
    if not cfg.hl_api_wallet_key or not cfg.hl_account_address:
        print(f"  {FAIL}  Missing HL_API_WALLET_PRIVATE_KEY / HL_ACCOUNT_ADDRESS in secrets.env. Place the TESTNET key first.")
        return 1
    md = MarketData(cfg)
    from .venues.hyperliquid_venue import HyperliquidVenue
    try:
        v = HyperliquidVenue(cfg, md)
        v.agent_state = None
        step("venue init (testnet API URL, wallet loaded)", True)
    except Exception as e:
        step("venue init", False, e); return 1

    # 1) read account state
    try:
        prices = md.all_mids()
        snap = v.snapshot(prices)
        step("account snapshot (read testnet balance/positions)", snap is not None, f"equity=${getattr(snap,'equity_usd',0):.2f} pos={getattr(snap,'open_position_count',0)}")
    except Exception as e:
        step("account snapshot", False, e); prices = md.all_mids()

    COIN = "ETH"
    px = prices.get(COIN)
    if not px:
        step("get price", False, "no ETH mid"); return 1
    print(f"  (using {COIN} @ {px})")

    # 2) place a resting limit FAR below market (won't fill) - tests order placement + oid return
    lim = round(px * 0.80, 1)   # 20% below - safely unfilled
    oid = None
    try:
        a = Action(kind="open_perp", coin=COIN, side="long", size_usd=12.0, leverage=3,
                   order_type="limit", limit_price=lim, stop_loss_px=round(lim*0.95,1), take_profit_px=round(lim*1.1,1))
        res = v.execute(a, {COIN: px})
        oid = (res.raw or {}).get("oid") if res.raw else None
        step("place resting limit (Alo maker, unfilled)", res.ok and bool(oid), f"oid={oid} {res.detail}")
    except Exception as e:
        step("place resting limit", False, e)

    # 3) query order status
    if oid:
        try:
            status, fpx = v.order_status(COIN, oid)
            step("order_status query", status in ("open","resting","unknown","filled","canceled"), f"status={status}")
        except Exception as e:
            step("order_status", False, e)

    # 4) cancel the resting order (cleanup + tests cancel)
    if oid:
        try:
            ok = v.cancel_order(COIN, oid)
            step("cancel_order (cleanup)", ok, f"canceled oid={oid}")
        except Exception as e:
            step("cancel_order", False, e)

    # 5) housekeeping (fills reconciliation loop) runs without error
    try:
        ev = v.housekeeping(prices)
        step("housekeeping (fills reconciliation)", isinstance(ev, list), f"{len(ev)} events")
    except Exception as e:
        step("housekeeping", False, e)

    # NOTE: we deliberately do NOT open a real market position in the automated run - a resting-limit lifecycle
    # (place/status/cancel) validates the core path safely. A manual market-order+stop+close test can follow.
    print("\n=== SUMMARY ===")
    p = sum(1 for _, ok in results if ok); n = len(results)
    print(f"  {p}/{n} checks passed")
    if p == n:
        print("  ✅ Execution code works against real Hyperliquid testnet. Next: manual market-order+stop+close test, then rule-engine routing (Part B).")
    else:
        print("  ❌ Some checks failed - fix before ANY live trading. Do not proceed to mainnet.")
    print("TESTNET_VALIDATE_DONE")
    return 0 if p == n else 1

if __name__ == "__main__":
    sys.exit(main())
