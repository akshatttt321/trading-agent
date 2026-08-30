"""
Read-only dashboard API + kill switch. Runs as a separate process next to the agent, reading the same
SQLite journal. Auth: Authorization: Bearer $DASHBOARD_TOKEN. Contract: ui/API.md

  .venv/bin/uvicorn agent.api:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import admin
from .config import DATA_DIR, KILL_FILE, load_config

cfg = load_config()
TOKEN = os.getenv("DASHBOARD_TOKEN") or ""
ORIGIN = os.getenv("DASHBOARD_ORIGIN") or "*"
DB_PATH = DATA_DIR / "journal.sqlite"

app = FastAPI(title="trading-agent dashboard API", version="1.0", docs_url=None, redoc_url=None)


_cfg_loaded_at = 0.0


@app.middleware("http")
async def _json_errors(request, call_next):
    """JSON 500s inside the CORS layer + a 10s-TTL config refresh so admin edits reach this process without a restart."""
    from fastapi.responses import JSONResponse
    global cfg, TOKEN, _cfg_loaded_at
    if time.time() - _cfg_loaded_at > 10:
        try:
            cfg = load_config()
            _cfg_loaded_at = time.time()
        except Exception:
            pass                                        # keep serving with the last good config
    try:
        return await call_next(request)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"[:300]})


app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in ORIGIN.split(",")],
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Admin"],
)


# ---------------------------------------------------------------------------- helpers
def auth(authorization: Optional[str] = Header(None)) -> None:
    if not TOKEN:
        raise HTTPException(503, "DASHBOARD_TOKEN not configured on server")
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "invalid token")


def db() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise HTTPException(404, "no data yet")
    c = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False, timeout=5)
    c.row_factory = sqlite3.Row
    return c


def meta(c: sqlite3.Connection, key: str, default: Any = None) -> Any:
    r = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return json.loads(r[0]) if r else default


def j(s: Optional[str], default: Any) -> Any:
    try:
        return json.loads(s) if s else default
    except json.JSONDecodeError:
        return default


def orders_for(c: sqlite3.Connection, cycle_id: int) -> List[Dict]:
    rows = c.execute("SELECT ts, action, approved, risk_reason, result FROM orders WHERE cycle_id=? ORDER BY id", (cycle_id,)).fetchall()
    return [{"ts": r["ts"], "approved": bool(r["approved"]), "risk_reason": r["risk_reason"] or "",
             "action": j(r["action"], {}), "result": j(r["result"], {})} for r in rows]


# --------------------------------------------------------------------------- endpoints
@app.get("/api/watchdog")
def watchdog():
    f = DATA_DIR / "watchdog_status.json"
    if not f.exists():
        return {"state": "unknown", "detail": "watchdog has not reported yet"}
    try:
        return json.loads(f.read_text())
    except Exception:
        return {"state": "unknown", "detail": "unreadable status"}


@app.get("/api/health")
def health():
    try:
        mode = admin.read_config_dict().get("mode", cfg.mode)   # fresh: the admin panel may have changed it
    except Exception:
        mode = cfg.mode
    return {"ok": True, "mode": mode, "ts": time.time(),
            "google_client_id": cfg.google_client_id if (cfg.google_client_id and cfg.admin_email) else None,
            "admin_email_hint": admin.mask_email(cfg.admin_email) if cfg.google_client_id else None}


@app.get("/api/status", dependencies=[Depends(auth)])
def status():
    c = db()
    last = c.execute("SELECT ts, equity, snapshot FROM cycles ORDER BY id DESC LIMIT 1").fetchone()
    if not last:
        raise HTTPException(404, "no data yet")
    start_eq = meta(c, "starting_equity")
    start_ts = meta(c, "start_ts")
    total = c.execute("SELECT COUNT(*) FROM cycles").fetchone()[0]
    equity, snapshot, snap_ts = last["equity"], j(last["snapshot"], {}), last["ts"]
    live = meta(c, "live_snapshot")
    if live and live.get("ts", 0) > last["ts"]:          # 60s watch loop is fresher than the last cycle
        equity, snapshot, snap_ts = live["equity"], live["snapshot"], live["ts"]
    return {
        "snapshot_ts": snap_ts,
        "mode": cfg.mode,
        "killed": meta(c, "killed") or (KILL_FILE.read_text().strip() if KILL_FILE.exists() else None),
        "daily_halt": bool(meta(c, "daily_halt", False)),
        "starting_equity": start_eq,
        "start_ts": start_ts,
        "goal": {"target_multiple": cfg.goal.target_multiple, "horizon_days": cfg.goal.horizon_days},
        "equity": equity,
        "multiple": (equity / start_eq) if start_eq else None,
        "days_elapsed": ((time.time() - start_ts) / 86400) if start_ts else None,
        "last_cycle_ts": last["ts"],
        "last_tick_ts": (live or {}).get("ts") or last["ts"],
        "watch_levels": meta(c, "watch_levels") or [],
        "market_brief": meta(c, "market_brief"),
        "exit_quality": (meta(c, "exit_quality") or [])[-12:],
        "resting_orders": [{**{k: (r.get("action") or {}).get(k) for k in ("coin", "side", "size_usd", "limit_price", "stop_loss_px", "take_profit_px")}, "ts": r.get("ts")}
                           for r in (meta(c, "resting_orders") or [])],
        "research_today": meta(c, "research_today"),
        "shadow_trades": {
            "open": [{k: sh.get(k) for k in ("coin", "side", "entry_px", "mark_px", "live_r", "stop_px", "tp_px", "size_usd", "by", "reason", "ts")}
                     for sh in (meta(c, "shadow_trades") or []) if sh.get("status") == "open"][-15:],
            "resolved": [{k: sh.get(k) for k in ("coin", "side", "entry_px", "stop_px", "tp_px", "by", "status", "r", "ts")}
                         for sh in (meta(c, "shadow_trades") or []) if sh.get("status") != "open"][-10:],
        },
        "cycles_total": total,
        "llm_model": f"{cfg.llm.proposer.provider}:{cfg.llm.proposer.model}" + (f" + verifier {cfg.llm.verifier.provider}:{cfg.llm.verifier.model}" if cfg.llm.verifier.enabled else ""),
        "tokens_total": meta(c, "tokens_total"),
        "tokens_today": meta(c, "tokens_today"),
        "snapshot": snapshot,
    }


@app.get("/api/equity", dependencies=[Depends(auth)])
def equity(limit: int = Query(1000, ge=1, le=20000)):
    c = db()
    rows = c.execute("SELECT ts, equity FROM cycles ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{"ts": r["ts"], "equity": r["equity"]} for r in reversed(rows)]


CRYPTO_KINDS = {"open_perp", "close_perp", "update_stop", "spot_buy", "spot_sell"}
PM_ORDER_KINDS = {"pm_buy", "pm_sell", "pm_update"}
ENTRY_KINDS = {"open_perp", "spot_buy", "pm_buy"}
MANAGE_KINDS = {"update_stop", "pm_update", "close_perp", "spot_sell", "pm_sell"}


@app.get("/api/cycles", dependencies=[Depends(auth)])
def cycles(limit: int = Query(30, ge=1, le=500),
           kind: str = Query("all", pattern="^(all|trades|new|updates|rejected|holds|quiet|errors)$"),
           venue: str = Query("all", pattern="^(all|crypto|pm)$")):
    """Two axes, both server-side, each returning the `limit` most-recent matching cycles:
      venue: all | crypto (perp/spot orders) | pm (prediction-market orders)
      kind:  new (entry fills) | updates (management fills) | trades (either) | rejected | holds | quiet | errors | all
    new/updates/trades/rejected are filtered to `venue`; holds/quiet/errors are venue-agnostic (global)."""
    c = db()
    vset = CRYPTO_KINDS if venue == "crypto" else PM_ORDER_KINDS if venue == "pm" else None

    def ord_venue(o):
        return (vset is None) or (o["action"].get("kind") in vset)

    out = []
    offset = 0
    while len(out) < limit:
        rows = c.execute("SELECT id, ts, equity, decision, error FROM cycles ORDER BY id DESC LIMIT 200 OFFSET ?", (offset,)).fetchall()
        if not rows:
            break
        for r in rows:
            d = j(r["decision"], {}) or {}
            orders = orders_for(c, r["id"])
            vo = [o for o in orders if ord_venue(o)]
            filled = [o for o in vo if o["approved"] and (o["result"] or {}).get("ok")]
            new_f = any(o["action"].get("kind") in ENTRY_KINDS for o in filled)
            upd_f = any(o["action"].get("kind") in MANAGE_KINDS for o in filled)
            rej = any(not o["approved"] for o in vo)
            skipped = bool(d.get("skipped"))
            err = bool(r["error"]) or d.get("market_view") in ("(proposer failed)", "(cycle error)")
            if kind in ("holds", "quiet", "errors"):        # venue-agnostic
                match = ((kind == "holds" and orders == [] and not skipped and not err and d)
                         or (kind == "quiet" and skipped) or (kind == "errors" and err))
            elif kind == "all":
                # every action of this venue (trades + rejects) PLUS the venue-agnostic no-order cycles
                # (holds / quiet / errors); excludes cycles whose only activity is the OTHER venue.
                match = True if vset is None else (bool(vo) or orders == [])
            elif kind == "new":
                match = new_f
            elif kind == "updates":
                match = upd_f
            elif kind == "trades":
                match = new_f or upd_f
            elif kind == "rejected":
                match = rej
            else:
                match = False
            if match:
                out.append({"id": r["id"], "ts": r["ts"], "equity": r["equity"], "error": r["error"] or "", "decision": d, "orders": orders})
                if len(out) >= limit:
                    break
        offset += 200
    return out


@app.get("/api/orders", dependencies=[Depends(auth)])
def orders(limit: int = Query(200, ge=1, le=5000)):
    c = db()
    rows = c.execute("SELECT ts, cycle_id, action, approved, risk_reason, result FROM orders ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{"ts": r["ts"], "cycle_id": r["cycle_id"], "approved": bool(r["approved"]), "risk_reason": r["risk_reason"] or "",
             "action": j(r["action"], {}), "result": j(r["result"], {})} for r in rows]


@app.get("/api/learner", dependencies=[Depends(auth)])
def learner():
    c = db()
    q = meta(c, "learner_q", {}) or {}
    open_ = meta(c, "learner_open", {}) or {}
    from .learner import Learner  # lessons text needs cfg + a State-like getter
    from .state import State
    lr = Learner(cfg, State(readonly=True))
    lessons = lr.lessons_text()
    lr = Learner(cfg, State(readonly=True))
    return {
        "lessons": lessons,
        "contexts": sorted([{"ctx": k, **v} for k, v in q.items()], key=lambda x: x["q"], reverse=True),
        "open": [{"key": k, **v} for k, v in open_.items()],
        "postmortems": list(reversed(meta(c, "postmortems", []) or [])),
        "verifier_score": lr.verifier_score(),
        "rejection_scores": lr.rejection_scores(),
        "shadow_trades": list(reversed((meta(c, "shadow_trades", []) or [])[-50:])),
    }


@app.get("/api/analytics", dependencies=[Depends(auth)])
def analytics():
    """Performance statistics computed from the journal (closed trades, equity curve, costs)."""
    from .analytics import compute
    c = db()
    return compute(c, cfg)


@app.get("/api/config", dependencies=[Depends(auth)])
def config():
    return {
        "mode": cfg.mode,
        "loop_interval_seconds": cfg.loop_interval_seconds,
        "llm": {"proposer": cfg.llm.proposer.model_dump(), "verifier": cfg.llm.verifier.model_dump()},
        "goal": cfg.goal.model_dump(),
        "universe": cfg.universe.model_dump(),
        "risk": cfg.risk.model_dump(),
        "rr": cfg.rr.model_dump(),
        "learner": cfg.learner.model_dump(),
    }


class KillBody(BaseModel):
    confirm: str


@app.post("/api/kill", dependencies=[Depends(auth)])
def kill(body: KillBody):
    if body.confirm != "KILL":
        raise HTTPException(400, 'body.confirm must be "KILL"')
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    already = KILL_FILE.exists()
    if not already:
        KILL_FILE.write_text(f"{time.ctime()} kill via dashboard API\n")
    return {"ok": True, "message": "KILL file already present" if already else
            "KILL file written - agent will flatten all positions and stop within ~5s"}


# =============================================================================== ADMIN (Google sign-in)
def admin_auth(authorization: Optional[str] = Header(None), x_admin: Optional[str] = Header(None)) -> str:
    if not cfg.google_client_id or not cfg.admin_email:
        raise HTTPException(503, "admin login not configured (set GOOGLE_CLIENT_ID and ADMIN_EMAIL on the server)")
    if not authorization or not authorization.startswith("Bearer ") or x_admin != "google":
        raise HTTPException(401, "google sign-in required")
    email, err = admin.verify_google_id_token(authorization[7:], cfg.google_client_id)
    if not email:
        raise HTTPException(401, f"google sign-in required ({err})")
    if email != cfg.admin_email:
        raise HTTPException(403, f"{admin.mask_email(email)} is not the admin")
    return email


def _agent_meta() -> Dict[str, Any]:
    try:
        c = db()
        return {"restart_pending": admin.RESTART_FILE.exists(), "last_reload_ts": meta(c, "last_reload_ts")}
    except HTTPException:
        return {"restart_pending": admin.RESTART_FILE.exists(), "last_reload_ts": None}


@app.get("/api/admin/settings", dependencies=[Depends(admin_auth)])
def admin_settings_get():
    return {"config": admin.read_config_dict(), "schema": admin.config_schema(), "secrets": admin.secrets_status(),
            "live_ack_phrase": admin.LIVE_ACK, "agent": _agent_meta()}


class SettingsBody(BaseModel):
    config: Dict[str, Any]
    confirm_live: Optional[str] = None


@app.put("/api/admin/settings", dependencies=[Depends(admin_auth)])
def admin_settings_put(body: SettingsBody):
    current = admin.read_config_dict()
    merged = admin.deep_merge(current, body.config or {})
    validated, err = admin.validate_config(merged)
    if not validated:
        raise HTTPException(422, err)
    if merged.get("mode") == "live" and current.get("mode") != "live":
        problems = admin.live_prerequisites(merged, body.confirm_live)
        if problems:
            raise HTTPException(409, "cannot switch to live: " + "; ".join(problems))
    admin.write_config(merged)
    admin.request_restart("settings changed via dashboard")
    return {"ok": True, "restart": True, "config": merged}


@app.put("/api/admin/secrets", dependencies=[Depends(admin_auth)])
def admin_secrets_put(body: Dict[str, Optional[str]]):
    unknown = [k for k in body if k not in admin.SECRET_KEYS]
    if unknown:
        raise HTTPException(422, f"unknown secret keys: {unknown}")
    admin.write_secrets({k: (v or "") for k, v in body.items()})
    admin.request_restart("secrets changed via dashboard")
    return {"ok": True, "secrets": admin.secrets_status(), "restart": True}


@app.post("/api/admin/preflight", dependencies=[Depends(admin_auth)])
def admin_preflight():
    from .preflight import run_checks
    fresh = load_config()
    checks = run_checks(fresh)
    return {"ok": all(c["pass"] for c in checks), "checks": checks, "mode": fresh.mode}


@app.post("/api/admin/restart", dependencies=[Depends(admin_auth)])
def admin_restart():
    admin.request_restart("manual restart via dashboard")
    return {"ok": True}


class ResetBody(BaseModel):
    confirm: str


@app.post("/api/admin/reset-journal", dependencies=[Depends(admin_auth)])
def admin_reset_journal(body: ResetBody):
    if body.confirm != "RESET":
        raise HTTPException(400, 'confirm must be "RESET"')
    if admin.read_config_dict().get("mode") != "paper":
        raise HTTPException(409, "journal reset is only allowed in paper mode")
    for f in ("journal.sqlite", "journal.sqlite-journal", "journal.sqlite-wal"):
        (DATA_DIR / f).unlink(missing_ok=True)
    admin.request_restart("journal reset via dashboard")
    return {"ok": True}
