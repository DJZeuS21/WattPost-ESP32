#!/usr/bin/env python3
"""Build the production-only WattPost web bundle for ESP32."""

import argparse
import gzip
import json
import re
from pathlib import Path


RUNTIME_ASSETS = (
    ("/", "index.html", "text/html; charset=utf-8"),
    ("/setup.html", "setup.html", "text/html; charset=utf-8"),
    ("/css/styles.css", "css/styles.css", "text/css; charset=utf-8"),
    ("/css/setup.css", "css/setup.css", "text/css; charset=utf-8"),
    ("/assets/dither-noise.png", "assets/dither-noise.png", "image/png"),
    ("/assets/logo.svg", "assets/logo.svg", "image/svg+xml"),
    ("/js/transport.js", "js/transport.js", "text/javascript; charset=utf-8"),
    ("/js/api.js", "js/api.js", "text/javascript; charset=utf-8"),
    ("/js/app.js", "js/app.js", "text/javascript; charset=utf-8"),
    ("/js/battery-colors.js", "js/battery-colors.js", "text/javascript; charset=utf-8"),
    ("/js/charts.js", "js/charts.js", "text/javascript; charset=utf-8"),
    ("/js/dashboard.js", "js/dashboard.js", "text/javascript; charset=utf-8"),
    ("/js/data-normalizer.js", "js/data-normalizer.js", "text/javascript; charset=utf-8"),
    ("/js/device-settings.js", "js/device-settings.js", "text/javascript; charset=utf-8"),
    ("/js/energy-flow.js", "js/energy-flow.js", "text/javascript; charset=utf-8"),
    ("/js/history-cache.js", "js/history-cache.js", "text/javascript; charset=utf-8"),
    ("/js/history.js", "js/history.js", "text/javascript; charset=utf-8"),
    ("/js/settings-schema.js", "js/settings-schema.js", "text/javascript; charset=utf-8"),
    ("/js/settings.js", "js/settings.js", "text/javascript; charset=utf-8"),
    ("/js/setup-api.js", "js/setup-api.js", "text/javascript; charset=utf-8"),
    ("/js/setup.js", "js/setup.js", "text/javascript; charset=utf-8"),
    ("/vendor/chart.umd.js", "vendor/chart.umd.js", "text/javascript; charset=utf-8"),
    ("/vendor/chartjs-plugin-zoom.umd.min.js", "vendor/chartjs-plugin-zoom.umd.min.js", "text/javascript; charset=utf-8"),
    ("/vendor/hammer.min.js", "vendor/hammer.min.js", "text/javascript; charset=utf-8"),
)

DEV_START = b"<!-- DEV_ONLY_START -->"
DEV_END = b"<!-- DEV_ONLY_END -->"
VERSION_TOKEN = b"__WATTPOST_WEB_VERSION__"


def production_bytes(relative: str, source: Path, version: str) -> bytes:
    source_relative = (
        "js/transports/local-transport.js"
        if relative == "js/transport.js"
        else relative
    )
    data = (source / source_relative).read_bytes()

    if relative == "index.html":
        start = data.find(DEV_START)
        end = data.find(DEV_END)
        if start < 0 or end < start:
            raise ValueError("index.html DEV_ONLY markers are missing or invalid")
        end += len(DEV_END)
        data = data[:start] + data[end:]

    if relative.endswith(".html"):
        if VERSION_TOKEN not in data:
            raise ValueError(f"{relative} web-version token is missing")
        data = data.replace(VERSION_TOKEN, version.encode("ascii"))
        if VERSION_TOKEN in data:
            raise ValueError(
                f"{relative} web-version token was not fully replaced"
            )

    return data


def write_gzip(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0) as archive:
            archive.write(data)


def symbol_name(relative: str) -> str:
    return re.sub(r"\W", "_", Path(f"{relative}.gz").name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()

    if not re.fullmatch(r"V[0-9]+(?:\.[0-9]+){1,2}", args.version):
        raise ValueError(f"invalid web version: {args.version!r}")

    routes = {}
    include_lines = []
    for uri, relative, content_type in RUNTIME_ASSETS:
        write_gzip(args.output / f"{relative}.gz", production_bytes(relative, args.source, args.version))
        routes[uri] = [f"{relative}.gz", content_type]
        include_lines.append(f'WEB_ASSET("{uri}", {symbol_name(relative)}, "{content_type}")')

    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "web_assets.json").write_text(
        json.dumps(routes, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (args.output / "web_assets.inc").write_text("\n".join(include_lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
