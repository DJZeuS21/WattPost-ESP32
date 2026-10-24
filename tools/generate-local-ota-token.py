#!/usr/bin/env python3
"""Generate a local build-only OTA secret without echoing it."""
from pathlib import Path
import os
import secrets

ROOT = Path(__file__).resolve().parents[1]
target = ROOT / "esp32_monitor" / "secrets.local"
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.write(f"WATTPOST_OTA_TOKEN={secrets.token_hex(32)}\n")
except BaseException:
    target.unlink(missing_ok=True)
    raise
print(f"Created private local build configuration: {target}")
