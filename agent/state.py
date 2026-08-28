"""SQLite journal: every cycle, every proposed action, every fill, plus key/value meta."""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import DATA_DIR

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL, equity REAL, snapshot TEXT, market TEXT, llm_raw TEXT, decision TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL, cycle_id INTEGER, action TEXT, approved INTEGER, risk_reason TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS paper_positions (
  key TEXT PRIMARY KEY, data TEXT
);
"""


class State:
    def __init__(self, path: Optional[Path] = None, readonly: bool = False):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.path = path or DATA_DIR / "journal.sqlite"
        if readonly:
            self.db = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=5)
        else:
            self.db = sqlite3.connect(self.path)
            self.db.executescript(SCHEMA)
            self.db.commit()

    # ---- meta -----------------------------------------------------------------
    def get(self, key: str, default: Any = None) -> Any:
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key: str, value: Any) -> None:
        self.db.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        self.db.commit()

    # ---- cycles ---------------------------------------------------------------
    def start_cycle(self, equity: float, snapshot: Dict, market: Dict) -> int:
        cur = self.db.execute(
            "INSERT INTO cycles(ts,equity,snapshot,market) VALUES(?,?,?,?)",
            (time.time(), equity, json.dumps(snapshot, default=str), json.dumps(market, default=str)),
        )
        self.db.commit()
        return int(cur.lastrowid)

    def finish_cycle(self, cycle_id: int, llm_raw: str, decision: Dict, error: str = "") -> None:
        self.db.execute(
            "UPDATE cycles SET llm_raw=?, decision=?, error=? WHERE id=?",
            (llm_raw, json.dumps(decision, default=str), error, cycle_id),
        )
        self.db.commit()

    def entries_today(self) -> int:
        """Filled NEW entries (open_perp / spot_buy / pm_buy) since UTC midnight."""
        import calendar
        t = time.gmtime()
        midnight = calendar.timegm((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, 0))
        n = 0
        for (a, res) in self.db.execute("SELECT action, result FROM orders WHERE approved=1 AND ts>=?", (midnight,)):
            try:
                ad, rd = json.loads(a), json.loads(res or "{}")
                if ad.get("kind") in ("open_perp", "spot_buy", "pm_buy") and rd.get("ok"):
                    n += 1
            except Exception:
                pass
        return n

    def chop_entries_today(self) -> int:
        """Filled perp entries tagged [chop-entry] since UTC midnight - counter-trend entries taken while the
        regime was chop. Resting-limit placements (not yet filled) are excluded; the eventual fill counts once."""
        import calendar
        t = time.gmtime()
        midnight = calendar.timegm((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, 0))
        n = 0
        for (a, res) in self.db.execute("SELECT action, result FROM orders WHERE approved=1 AND ts>=?", (midnight,)):
            try:
                ad, rd = json.loads(a), json.loads(res or "{}")
                if "[chop-entry]" in (ad.get("reason") or "") and rd.get("ok") and not rd.get("resting"):
                    n += 1
            except Exception:
                pass
        return n

    def last_cycle_id(self) -> int:
        row = self.db.execute("SELECT MAX(id) FROM cycles").fetchone()
        return int(row[0] or 0)

    def update_snapshot(self, cycle_id: int, equity: float, snapshot: Dict) -> None:
        """Overwrite the cycle's snapshot with the post-decision state so fills show up immediately."""
        self.db.execute("UPDATE cycles SET equity=?, snapshot=? WHERE id=?", (equity, json.dumps(snapshot, default=str), cycle_id))
        self.db.commit()

    def record_order(self, cycle_id: int, action: Dict, approved: bool, reason: str, result: Dict) -> None:
        self.db.execute(
            "INSERT INTO orders(ts,cycle_id,action,approved,risk_reason,result) VALUES(?,?,?,?,?,?)",
            (time.time(), cycle_id, json.dumps(action, default=str), int(approved), reason, json.dumps(result, default=str)),
        )
        self.db.commit()

    def recent_orders(self, seconds: float) -> List[Dict]:
        rows = self.db.execute(
            "SELECT ts, action, approved, risk_reason, result FROM orders WHERE ts>=? AND approved=1 ORDER BY ts DESC",
            (time.time() - seconds,),
        ).fetchall()
        return [{"ts": r[0], "action": json.loads(r[1]), "approved": r[2], "reason": r[3], "result": json.loads(r[4])} for r in rows]

    def recent_history_text(self, n_cycles: int = 8) -> str:
        """Compact text of recent decisions + fills for the LLM's context."""
        rows = self.db.execute(
            "SELECT id, ts, equity, decision FROM cycles ORDER BY id DESC LIMIT ?", (n_cycles,)
        ).fetchall()
        out = []
        for cid, ts, eq, dec in reversed(rows):
            t = time.strftime("%m-%d %H:%M", time.gmtime(ts))
            line = f"[{t} UTC] equity=${eq:,.2f}"
            if dec:
                d = json.loads(dec)
                acts = d.get("actions") or []
                summary = "; ".join(
                    f"{a.get('kind')} {a.get('coin') or a.get('outcome') or ''} ${a.get('size_usd') or ''}".strip()
                    for a in acts
                ) or "hold"
                line += f" -> {summary}"
            orders = self.db.execute(
                "SELECT action, approved, risk_reason, result FROM orders WHERE cycle_id=?", (cid,)
            ).fetchall()
            for a, ok, why, res in orders:
                a = json.loads(a)
                r = json.loads(res)
                tag = "FILLED" if ok and r.get("ok") else ("REJECTED" if not ok else "FAILED")
                line += f"\n    {tag}: {a.get('kind')} {a.get('coin') or a.get('outcome') or ''} - {why or r.get('detail','')}"
            out.append(line)
        return "\n".join(out) if out else "(no history yet)"

    # ---- paper positions store ------------------------------------------------
    def paper_load(self) -> Dict[str, Any]:
        rows = self.db.execute("SELECT key, data FROM paper_positions").fetchall()
        return {k: json.loads(v) for k, v in rows}

    def paper_save(self, data: Dict[str, Any]) -> None:
        self.db.execute("DELETE FROM paper_positions")
        for k, v in data.items():
            self.db.execute("INSERT INTO paper_positions(key,data) VALUES(?,?)", (k, json.dumps(v, default=str)))
        self.db.commit()
