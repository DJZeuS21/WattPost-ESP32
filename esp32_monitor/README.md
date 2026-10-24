# WattPost ESP32 firmware — source

[Українська — опис WattPost](../README.md) · [English — overview](../README.en.md)

This directory contains the ESP-IDF 5.5.5 firmware for the classic ESP32
(4 MB flash). It reads JK BMS telemetry over BLE, hosts the local web
interface and History storage, and optionally connects to WattPost Cloud.

The firmware includes the **device-side** WattPost Cloud transport. The
private Cloud server, web account frontend, database and infrastructure are
not part of this repository.

## Source tree

- `main/` — firmware, BLE, Wi-Fi, History, local API, Cloud client and OTA.
- `web/` — canonical Local Device web interface and shared UI code.
- `tools/package_web.py` — deterministic production web-asset bundler.
- `tests/` — host firmware tests, web-bundle checks and regression scripts.
- `VERSION` — authoritative firmware and embedded web version.
- `sdkconfig.defaults`, `partitions.csv`, `dependencies.lock` — ESP-IDF
  build defaults and flash layout.

## Build locally (Linux)

The project uses **ESP-IDF 5.5.5**, not Arduino/ESPHome. From the repository
root, install the project-local toolchain once and activate it:

~~~bash
./tools/setup-esp32-env.sh
source tools/esp32-env.sh
~~~

Create a unique **local** OTA token for your development build; it is never
committed to Git:

~~~bash
python3 tools/generate-local-ota-token.py
~~~

Then build:

~~~bash
idf.py -C esp32_monitor build
~~~

ESP-IDF will generate the bootloader, partition table, application binary
and `flasher_args.json` in `esp32_monitor/build/`. Use the flashing arguments
generated for this specific build; WattPost has a custom partition table
and the application begins at `0x20000`, not at the usual demo offset.

**Do not use a privately compiled binary for public distribution.** The
current build embeds its local `WATTPOST_OTA_TOKEN`; a production-safe
public-release credential strategy is required before publishing binaries.

Development tests (from the indicated locations):

~~~bash
cd esp32_monitor
./tests/run_parser_test.sh
python3 -m unittest discover -s tests -p test_dev_web_server.py
cd ..
node --test --test-concurrency=1 esp32_monitor/web/tests/*.mjs
~~~

The full release acceptance script also runs a fresh ESP-IDF build.
Public GitHub Releases are intended to contain a **single merged full
installation BIN**, separately from the app-only signed Cloud OTA image.
