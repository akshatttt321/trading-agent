"""Emergency stop. Creates data/KILL; the running agent flattens all positions and exits within 5s."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from agent.config import KILL_FILE  # noqa: E402

KILL_FILE.parent.mkdir(parents=True, exist_ok=True)
KILL_FILE.write_text(f"{time.ctime()} manual kill via scripts/kill.py\n")
print(f"KILL file written: {KILL_FILE}\nRunning agent will flatten and stop within ~5 seconds.\n"
      f"If the agent is NOT running, run: python scripts/flatten.py")
