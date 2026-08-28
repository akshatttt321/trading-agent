"""
Independent watchdog for the trading agent. Runs in its own container so an agent hang can't affect it.
- Monitors the agent via the dashboard API (cycle freshness, spend, equity, killed) and Docker (container state).
- Safe automated remediation: restart the agent when it is stuck or crashed (bounded; cooldown + hourly cap).
- Emails sakshat1905@gmail.com on SEVERE incidents (crash-loop, API unreachable, runaway spend, abnormal equity drop).
- Does NOT edit code and does NOT close positions. It restarts and alerts; humans decide the rest.
- Writes data/watchdog_status.json so the dashboard can show a Watchdog tile.
"""
from __future__ import annotations

import json
import os
import smtplib
import time
from email.mime.text import MIMEText
from pathlib import Path

import httpx

API = os.getenv("WATCHDOG_API", "http://api:8000")
TOKEN = os.getenv("DASHBOARD_TOKEN", "")
DATA = Path(os.getenv("WATCHDOG_DATA", "/app/data"))
AGENT_NAME_HINT = os.getenv("AGENT_CONTAINER_HINT", "agent")

CHECK_EVERY = int(os.getenv("WD_CHECK_EVERY", "60"))
STUCK_AFTER = float(os.getenv("WD_STUCK_MULT", "3"))        # x loop_interval with no new cycle -> stuck
RESTART_COOLDOWN = float(os.getenv("WD_RESTART_COOLDOWN_MIN", "5")) * 60
MAX_RESTARTS_HR = int(os.getenv("WD_MAX_RESTARTS_HR", "4"))
AUTO_RESTART = os.getenv("WD_AUTO_RESTART", "true").lower() == "true"   # false = pure report mode
# NOTE: this watchdog NEVER triggers the kill switch and NEVER closes positions. It restarts (optional) and emails.
SPEND_RUNAWAY = float(os.getenv("WD_SPEND_RUNAWAY_USD", "3.0"))   # today's LLM $ above this = severe
EQUITY_DROP_PCT = float(os.getenv("WD_EQUITY_DROP_PCT", "12"))    # equity fall over EQUITY_WINDOW min = severe
EQUITY_WINDOW = float(os.getenv("WD_EQUITY_WINDOW_MIN", "20")) * 60

ALERT_EMAIL = os.getenv("ALERT_EMAIL", "")
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_APP_PASSWORD", "")

fail_streak = 0
FAIL_THRESHOLD = int(os.getenv("WD_FAIL_THRESHOLD", "2"))   # consecutive bad checks before acting/alerting
STARTUP_GRACE = float(os.getenv("WD_STARTUP_GRACE", "90"))
restarts: list = []
last_restart = 0.0
alert_sent: dict = {}          # incident -> last-sent ts (30 min cooldown per type)
equity_hist: list = []         # (ts, equity)


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} watchdog: {msg}", flush=True)


def email(subject: str, body: str, incident: str) -> None:
    if not (ALERT_EMAIL and SMTP_USER and SMTP_PASS):
        log(f"[email not configured] would send: {subject}")
        return
    if time.time() - alert_sent.get(incident, 0) < 1800:   # 30 min per-incident cooldown
        return
    try:
        m = MIMEText(body)
        m["Subject"] = f"[trading-agent] {subject}"
        m["From"] = SMTP_USER
        m["To"] = ALERT_EMAIL
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as srv:
            srv.starttls()
            srv.login(SMTP_USER, SMTP_PASS)
            srv.sendmail(SMTP_USER, [ALERT_EMAIL], m.as_string())
        alert_sent[incident] = time.time()
        log(f"emailed alert: {subject}")
    except Exception as e:
        log(f"email failed: {e}")


def docker_client():
    import docker
    return docker.from_env()


def find_agent():
    try:
        for c in docker_client().containers.list(all=True):
            if AGENT_NAME_HINT in c.name and "api" not in c.name and "caddy" not in c.name and "watchdog" not in c.name:
                return c
    except Exception as e:
        log(f"docker list failed: {e}")
    return None


def restart_agent(reason: str) -> bool:
    global last_restart
    now = time.time()
    restarts[:] = [t for t in restarts if now - t < 3600]
    if now - last_restart < RESTART_COOLDOWN:
        return False
    if len(restarts) >= MAX_RESTARTS_HR:
        email("SEVERE: agent crash-looping", f"The agent has been restarted {len(restarts)} times in the last hour and is still unhealthy "
              f"({reason}). Automatic restarts halted - manual attention needed.", "crashloop")
        return False
    if not AUTO_RESTART:
        email("SEVERE: agent needs attention (auto-restart off)", f"The agent is unhealthy ({reason}) and auto-restart is disabled - manual restart needed.", "manual")
        return False
    c = find_agent()
    if not c:
        email("SEVERE: agent container not found", f"Watchdog cannot find the agent container to restart ({reason}).", "nocontainer")
        return False
    try:
        c.restart(timeout=20)
        restarts.append(now)
        last_restart = now
        log(f"restarted agent ({reason})")
        email("agent restarted", f"The watchdog restarted the agent.\nReason: {reason}\nRestarts in the last hour: {len(restarts)}.", "restart")
        return True
    except Exception as e:
        email("SEVERE: agent restart failed", f"Restart attempt failed ({reason}): {e}", "restartfail")
        return False


def api_get(path: str):
    h = {"Authorization": f"Bearer {TOKEN}"}
    return httpx.get(f"{API}{path}", headers=h, timeout=15)


def write_status(state: str, detail: str, extra: dict) -> None:
    try:
        (DATA / "watchdog_status.json").write_text(json.dumps({
            "ts": time.time(), "state": state, "detail": detail,
            "restarts_last_hour": len([t for t in restarts if time.time() - t < 3600]),
            "last_restart_ts": last_restart or None, **extra}))
    except Exception as e:
        log(f"status write failed: {e}")


def check() -> None:
    global fail_streak
    # 1) API reachable? (tolerate transient failures - only act after FAIL_THRESHOLD in a row)
    try:
        health = api_get("/api/health")
        if health.status_code != 200:
            raise RuntimeError(f"health {health.status_code}")
        fail_streak = 0
    except Exception as e:
        fail_streak += 1
        log(f"API check failed ({fail_streak}/{FAIL_THRESHOLD}): {e}")
        write_status("degraded", f"api check {fail_streak}/{FAIL_THRESHOLD}: {e}", {})
        if fail_streak < FAIL_THRESHOLD:
            return
        c = find_agent()
        if not c or c.status != "running":
            restart_agent(f"API unreachable and container {getattr(c,'status','missing')}")
        else:
            email("SEVERE: dashboard API unreachable", f"The API has not responded for {fail_streak} checks though the agent container is up.", "apidown")
        write_status("unreachable", str(e), {})
        return

    try:
        s = api_get("/api/status").json()
    except Exception as e:
        write_status("degraded", f"status fetch failed: {e}", {})
        return

    now = time.time()
    interval = 300
    try:
        cfg = api_get("/api/config").json(); interval = cfg.get("loop_interval_seconds", 300)
    except Exception:
        pass

    incidents = []
    # 2) stuck? (container up but no cycle for > STUCK_AFTER x interval) - but a KILLED agent is stopped on purpose
    age = now - (s.get("last_cycle_ts") or now)
    if age > STUCK_AFTER * interval and not s.get("killed"):
        c = find_agent()
        if c and c.status != "running":
            restart_agent(f"container {c.status}")
        else:
            if restart_agent(f"stuck: no cycle for {age/60:.0f}m (> {STUCK_AFTER}x interval)"):
                incidents.append(f"agent was stuck {age/60:.0f}m, restarted")
    # 3) killed?
    if s.get("killed"):
        email("SEVERE: agent KILLED", f"The agent hit its kill switch and stopped.\nReason: {s['killed']}\nEquity: ${s.get('equity')}", "killed")
        incidents.append(f"killed: {s['killed']}")
    # 4) runaway spend
    spend = ((s.get("tokens_today") or {}).get("cost_usd")) or 0
    if spend >= SPEND_RUNAWAY:
        email("SEVERE: runaway LLM spend", f"Today's LLM spend is ${spend:.2f} (threshold ${SPEND_RUNAWAY}).", "spend")
        incidents.append(f"spend ${spend:.2f}")
    # 5) abnormal equity drop
    eq = s.get("equity")
    if eq:
        equity_hist.append((now, eq))
        equity_hist[:] = [(t, e) for t, e in equity_hist if now - t < EQUITY_WINDOW * 1.2]
        old = [e for t, e in equity_hist if now - t >= EQUITY_WINDOW]
        if old:
            drop = (old[0] - eq) / old[0] * 100
            if drop >= EQUITY_DROP_PCT:
                email("SEVERE: equity dropping fast", f"Equity fell {drop:.1f}% in ~{EQUITY_WINDOW/60:.0f} min "
                      f"(${old[0]:.2f} -> ${eq:.2f}).", "equity")
                incidents.append(f"equity -{drop:.1f}%")

    state = "incident" if incidents else "healthy"
    write_status(state, "; ".join(incidents) or f"cycle {age:.0f}s ago, equity ${eq}, spend ${spend:.3f}",
                 {"equity": eq, "cycle_age_s": round(age), "spend_today": round(spend, 4), "mode": s.get("mode")})
    log(f"{state}: cycle {age:.0f}s ago, equity ${eq}, spend ${spend:.3f}" + (f" | {incidents}" if incidents else ""))


def main() -> None:
    log(f"starting (api={API}, alert={'on' if ALERT_EMAIL else 'off'}, stuck>{STUCK_AFTER}x interval); {STARTUP_GRACE:.0f}s grace")
    time.sleep(STARTUP_GRACE)                                  # let the stack come up before the first check
    if ALERT_EMAIL and SMTP_USER and SMTP_PASS:
        email("watchdog online", "The trading-agent watchdog started and is monitoring the agent.", "online")
    while True:
        try:
            check()
        except Exception as e:
            log(f"check error: {e}")
        time.sleep(CHECK_EVERY)


if __name__ == "__main__":
    main()
