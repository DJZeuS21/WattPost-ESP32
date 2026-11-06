#!/usr/bin/env python3
"""Long-running read-only health monitor for a WattPost ESP32."""

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError, HTTPError
from urllib.request import urlopen


def fetch_json(url: str, timeout: float = 8.0):
    started = time.monotonic()
    with urlopen(url, timeout=timeout) as response:
        body = response.read()
    return json.loads(body), round((time.monotonic() - started) * 1000, 1)


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def sample(base_url: str):
    live, live_ms = fetch_json(f"{base_url}/api/live", 5.0)
    history, history_ms = fetch_json(f"{base_url}/api/history?limit=2", 8.0)
    newest_history = history[-1].get("t") if history else None
    now_epoch = int(time.time())
    return {
        "ts": now_iso(),
        "ok": True,
        "latency_ms": {"live": live_ms, "history": history_ms},
        "firmware_version": live.get("firmware_version"),
        "web_version": live.get("web_version"),
        "build_id": live.get("build_id"),
        "ota_state": live.get("ota_state"),
        "ota_rollback_configured": live.get("ota_rollback_configured"),
        "online": live.get("online"),
        "ble_state": live.get("ble_state"),
        "ble_phase": live.get("ble_phase"),
        "last_valid_bms_frame_age": live.get("last_valid_bms_frame_age"),
        "connection_uptime": live.get("connection_uptime"),
        "last_disconnect_reason": live.get("last_disconnect_reason"),
        "wifi_disconnect_count": live.get("wifi_disconnect_count"),
        "wifi_reconnect_count": live.get("wifi_reconnect_count"),
        "ble_recovery_count": live.get("ble_recovery_count"),
        "disconnect_count": live.get("disconnect_count"),
        "mdns_recovery_count": live.get("mdns_recovery_count"),
        "mdns_announce_count": live.get("mdns_announce_count"),
        "last_restart_reason": live.get("last_restart_reason"),
        "history_records_seen": len(history),
        "history_latest_t": newest_history,
        "history_age_seconds": (now_epoch - newest_history) if newest_history else None,
    }


def counter_delta(samples, key):
    values = [s.get(key) for s in samples if s.get("ok") and isinstance(s.get(key), int)]
    return (values[-1] - values[0]) if len(values) >= 2 else None


def summarize(samples):
    good = [s for s in samples if s.get("ok")]
    failures = [s for s in samples if not s.get("ok")]
    # connection_uptime is BLE-session uptime, so a reconnect must not be counted as an ESP reboot.
    # Runtime counters are monotonic for the lifetime of one ESP boot and reset only after reboot.
    restart_counters = (
        "wifi_disconnect_count", "wifi_reconnect_count", "ble_recovery_count",
        "disconnect_count", "mdns_recovery_count", "mdns_announce_count",
    )
    restarts = 0
    previous = None
    for entry in good:
        if previous is not None:
            if any(
                isinstance(previous.get(key), int) and isinstance(entry.get(key), int)
                and entry[key] < previous[key]
                for key in restart_counters
            ):
                restarts += 1
        previous = entry
    history_ages = [s["history_age_seconds"] for s in good if isinstance(s.get("history_age_seconds"), int)]
    return {
        "generated_at": now_iso(),
        "samples": len(samples),
        "successful_samples": len(good),
        "failed_samples": len(failures),
        "inferred_restarts": restarts,
        "counter_deltas": {
            key: counter_delta(good, key)
            for key in (
                "wifi_disconnect_count", "wifi_reconnect_count", "ble_recovery_count",
                "disconnect_count", "mdns_recovery_count", "mdns_announce_count",
            )
        },
        "max_history_age_seconds": max(history_ages) if history_ages else None,
        "first": good[0] if good else None,
        "last": good[-1] if good else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://bms.local")
    parser.add_argument("--duration-hours", type=float, default=48.0)
    parser.add_argument("--interval-seconds", type=float, default=300.0)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    summary_path = args.output.with_suffix(args.output.suffix + ".summary.json")
    deadline = time.monotonic() + args.duration_hours * 3600
    samples = []

    with args.output.open("a", encoding="utf-8", buffering=1) as log:
        while True:
            tick = time.monotonic()
            try:
                entry = sample(base_url)
            except (URLError, HTTPError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
                entry = {"ts": now_iso(), "ok": False, "error": f"{type(exc).__name__}: {exc}"}
            samples.append(entry)
            log.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
            summary_path.write_text(json.dumps(summarize(samples), ensure_ascii=False, indent=2) + "\n")

            if time.monotonic() >= deadline:
                break
            sleep_for = max(0.0, args.interval_seconds - (time.monotonic() - tick))
            time.sleep(min(sleep_for, max(0.0, deadline - time.monotonic())))


if __name__ == "__main__":
    main()
