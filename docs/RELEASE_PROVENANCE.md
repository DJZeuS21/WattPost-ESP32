# WattPost ESP32 — release provenance and verification

## V20.0.16 (2026-11-13)

- **Firmware/web version:** `V20.0.16`. Includes the V20.0.15 RAM changes:
  History startup buffer reduced from 4096 to 512 bytes (3584 bytes less
  static RAM); Settings/write-policy use the existing response scratch space,
  avoiding a temporary 3072-byte allocation. History startup publishes its
  cursor after a complete scan.
- **mDNS reliability:** one recovery task owns start/free operations and retains
  reconnect requests received during a restart. Official `espressif/mdns 1.15.1`
  includes the upstream queued-TX double-free fix. The unproven six-hour
  preventive teardown is removed; five-minute announcements and recovery
  after Wi-Fi reconnect remain. This does not repair router multicast filtering
  or client resolver problems. Wi-Fi power saving and task-stack budgets remain.
- **Exact firmware source / embedded build ID:**
  `d157db65fb4f3f1bc2bf31139ed440622301904f` / `d157db65fb4f`.
  The public export has its own Git commit; official images are the original
  gated firmware, not a rebuild of this export.
- **Signed app-only Cloud OTA:** 1,608,224 bytes; SHA-256
  `d7c5cbd0a2534bc3432fb7357fd0a09fbd4790da39a96942bf0a4897834d745f`.
  Detached ECDSA-P256 signature independently verified against the embedded
  public key. The signing key and matching ELF stay private.
- **Full USB installer:** `WattPost-ESP32-full.bin`, 1,739,296 bytes; SHA-256
  `5c6e1ab27cbc18a7424bff60236b068bf7722e5296188f3da65c429c8eebef62`.
  Install at `0x0` on classic ESP32 / 4 MB Flash for a **fresh installation**.
  Exact original components verified at `0x1000`, `0x8000`, `0xF000`, `0x20000`;
  the image contains no saved user NVS. Use signed Cloud OTA to update an
  already configured device and preserve settings and History.
- **Validation:** canonical release gate passed 236 Python + C suites,
  6 proxy, 265 serial Web tests and one clean ESP-IDF 5.5.5 build; upstream
  mDNS ASan/UBSan 22/22. Bench completed 1000 teardown/start cycles. Exact
  signed private OTA passed on the primary ESP32 with JK BMS, Cloud, History,
  Settings and ordinary BLE/Wi-Fi reconnect, followed by a completed 24-hour
  run and more than 41 hours without new panic/reboot. The separate 48-hour
  network observation completed; client/WLAN losses remain a known limit.
- **RAM/behavior limits:** typical free heap around 53 KB; rare low-water mark
  5420 bytes remains under investigation. Brief BLE reconnects and two recovered
  Cloud failures occurred during the 24-hour run, comparable to the previous
  firmware. No guarantee of uninterrupted RF or universal `.local` resolution.
  Existing OTA validation marks app valid after ten seconds; it does not
  automatically roll back a later regression.
- **Compatibility:** NVS/History format and partition layout, JK BMS settings,
  Cloud telemetry/poll intervals, OTA trust and shared local/cloud UI preserved.
  No private backend, infrastructure, device data or credentials are exported.

## V20.0.14 (2026-11-10)

- **Firmware/web version:** `V20.0.14`. Reads connected-link RSSI from the
  ESP32 NimBLE controller every 10 seconds, showing current Bluetooth signal
  strength in Device Settings → JK BMS. After an interruption, displays the
  last measured RSSI explicitly as *last known* with age; never treats it as
  a current signal. Initial samples are available about two seconds after
  connection. A failed RSSI read does not disconnect or change the BMS.
  No BLE connection/recovery policy, BMS settings writing, NVS, History,
  partition layout, Wi-Fi or signed OTA protocol changes.
- **Exact firmware source commit / embedded build ID:**
  `79a05fc6d5b8` / `79a05fc6d5b8`. The public source export is an independent
  Git commit; the official image uses the exact tested original build,
  not a rebuild from this public Git commit.
- **Signed application-only Cloud OTA (not the USB image):** `1,604,768` bytes;
  SHA-256 `c2ce250def1921abfdf3362f3fabd5c174405735be2079b38c2f60e558a1303d`.
  Its ECDSA-P256 manifest signature was verified with the public key embedded
  in firmware. The private signing key and exact ELF remain private.
- **Full USB installer for classic ESP32 / 4 MB Flash:**
  `WattPost-ESP32-full.bin`, **1,735,840 bytes**; SHA-256
  `d0bbfa56591a0682c75967335549cea049f636ac7510f5dfe63aace750e548c7`.
  Flash at `0x0` only for a **new/fresh** installation. Its exact component
  bytes were verified at `0x1000` (bootloader), `0x8000` (partitions),
  `0xF000` (initial OTA data), `0x20000` (signed-OTA app binary).
  **Do not use this full image to update an already configured device.**
  Use WattPost Cloud signed OTA to retain configuration and History.
- **Official release gate:** 231 host/C, 6 development proxy, 265 Web tests;
  exact ESP-IDF 5.5.5 clean build; 27 production web assets; 295,776 bytes
  free in the smaller OTA slot. Standalone public checkout regression tests
  were also performed independently. No physical USB flashing was done.
- **Production Cloud OTA:** Global signed release **29** is already published
  separately; two paired ESP32 units installed it automatically and reported
  OTA `success` with exact build ID. Local physical diagnostics measured an
  RSSI of approximately −77 to −71 dBm while connected. Such a sample alone
  cannot establish the root cause of intermittent BLE timeouts.
- **Security and scope:** No private Cloud server code, user/device data,
  Wi-Fi credentials, signing material, raw coredumps or internal engineering
  documents are published. GitHub USB distribution and Cloud OTA are separate.

## V20.0.13 (2026-11-07)

- **Firmware and embedded web version:** `V20.0.13`. Relative to the previous
  GitHub V20.0.4 release, this version includes local JK BMS settings editing
  for eligible parameters, explicit change review, sequential BLE writes,
  readback verification and limited additional **read-only** `0x96` attempts
  if the first confirmation is missed. Automatic write retries are not used.
  The latest UI fix stabilizes the parameter/value/status columns while
  progress states change, including small-screen layouts.
- **Canonical source commit / exact embedded firmware build ID:**
  `993233c4fcf69d2cb94adc9c0626a0957947c382` / `993233c4fcf6`.
  The public source-export Git commit is a *different* identifier. The
  official binary is from the original exact ESP-IDF build and is not rebuilt
  from the exported source commit.
- **Signed application-only Cloud OTA:** `1,603,504` bytes; SHA-256
  `0f25f4a152e95568c437ec96be734eabea8ce051f7a7bfd039eb3e786be4949a`.
  Its detached ECDSA-P256 signature was generated off the Cloud server and
  verified against the embedded public verification key. **This image is
  not the USB installation image.**
- **Full USB installer for classic ESP32 with 4 MB Flash:**
  `WattPost-ESP32-full.bin`, `1,734,576` bytes; SHA-256
  `bb4c4fdfc5d1cfe7ff9be1699910f9ef0d160a73d1727e7f4f80e5996fff672e`.
  Install at flash offset `0x0` for a **new or deliberately reset** device.
  Verified component offsets: `0x1000` bootloader, `0x8000` partition table,
  `0xF000` initial OTA data and `0x20000` original signed-OTA application.
  Do **not** use the full image to update an already configured ESP32:
  it includes bootloader/initial OTA data, and USB flashing can overwrite
  existing configuration. Use the signed Cloud OTA instead.
- **Release validation:** 227 host/C tests, 6 development proxy tests,
  264 serial Web regression tests and one clean ESP-IDF 5.5.5 build passed.
  Chromium geometry checks at 1120/800/700/600/390/320 px verified stable
  numeric columns and no horizontal overflow. The application contains 27
  production web assets and leaves 297,040 bytes free in the smaller OTA slot.
  No partition layout, NVS or History format changes.
- **Cloud rollout:** published as public-to-all-devices signed Cloud release
  ID `28`. Two reachable paired devices independently installed and reported
  `V20.0.13 / 993233c4fcf6`, OTA `success`; an offline third device had not
  yet installed at release verification. Cloud OTA and GitHub distribution
  are separate. No test writes to BMS settings were performed during rollout.
- **History, secrets and scope:** official matching ELF and signing material
  remain private; no Cloud backend, database, device credentials, signing key,
  private coredumps or internal engineering notes belong in this repository.

## V20.0.4 (2026-11-04)

- **Firmware/web version:** `V20.0.4`. When a JK BMS BLE connection fails,
  First Setup and Device Settings explain two possible causes: an existing
  connection from a phone and weak Bluetooth signal. Guidance is available in
  Ukrainian and English. No BLE authentication/protocol, Wi-Fi, NVS, History,
  Flash partitions or OTA behavior changed.
- **Exact canonical private-source commit / embedded build ID:**
  `69e6742b5073` (the standalone export has its own different Git commit).
- **Signed app-only Cloud OTA image:** 1,580,576 bytes; SHA-256
  `060611da035f18c305f17006582963ce43b55ba29459681933f58557f8029d13`.
  ECDSA-P256 detached signature was created offline and checked against the
  public verification key embedded in the tested firmware.
- **Full USB installation image (flash at `0x0`):** 1,711,648 bytes; SHA-256
  `4b1e1b861831a74081ce0fd1dfc1385431dacf4d6356eb82c3c3144800200255`.
  The contents at offsets `0x1000`, `0x8000`, `0xF000`, `0x20000` match the
  exact tested bootloader, partition table, OTA initializer and app bytes.
- **Release acceptance:** 223 host/C tests, 6 development proxy tests,
  219 serial Web tests and one clean ESP-IDF 5.5.5 release build passed;
  27 production web assets; minimum OTA partition headroom 319,968 bytes.
  GitHub distribution and Cloud OTA installation are distinct operations;
  verify installation from device telemetry rather than release metadata.

## V20.0.3 (2026-11-01)

- **Firmware/web version:** `V20.0.3`, with explicit Ukrainian/English
  localization for the ESP32 local interface and First Setup (925 matching
  translation keys). The Dashboard places Discharging above Charging.
- **Exact private canonical source commit / embedded build ID:**
  `d2b76a65d2fe`. The public source export has its own Git commit ID;
  it must not be confused with the signed firmware's `build_id`.
- **Signed application-only Cloud OTA:** 1,580,384 bytes, SHA-256
  `e397663c0d919d6a17a5a35bb619dccf33ef6d92add2ea88f0ee1b34f1de865b`.
  An offline ECDSA-P256 detached signature over the canonical manifest was
  verified against the ESP32-embedded verification key. The OTA BIN is *not*
  the complete USB installer.
- **USB full-installation image:** 1,711,456 bytes, SHA-256
  `d8afef0a9522201ba432e07e0745c2c3cbd9eb0bc18b5cd7fb16318c888899eb`,
  ready to flash at offset `0x0` on classic ESP32 with at least 4 MB Flash.
  Offsets `0x1000`, `0x8000`, `0xF000`, `0x20000` match the exact tested
  bootloader, partition table, initial OTA data, and app components.
- **Release acceptance:** 223 host/C tests, 6 proxy tests, 218 Web tests,
  a single exact ESP-IDF 5.5.5 clean release build, 27 embedded production
  assets, unchanged partition layout and 320,160 bytes free in the minimum
  OTA partition. Physical install success must be verified from device
  telemetry after signed OTA is offered; release publication alone is not
  evidence of installation.

## V20.0.2 (2026-11-01)

- **Firmware/web version:** `V20.0.2`, with a compact GitHub link beside the
  WattPost brand in the local and Cloud navigation headers.
- **Private canonical source commit and exact embedded build ID:**
  `8a02d96e5094`. The standalone public source commit differs because the
  Cloud backend and internal build environment are deliberately not exported.
- **Exact signed Cloud OTA application image:** 1,542,064 bytes, SHA-256
  `b8d5eccfc70d2b4b4337de35279ef685c5058bcfbfeb394a981d108ef1ac8e75`.
  An ECDSA-P256 detached signature was generated off the Cloud host and
  verified against the public verification key embedded in the firmware.
- **USB full-installation image:** 1,673,136 bytes, SHA-256
  `c782c8af46b539abf949a25ee54088e40dd3206fd36e912e823c487d76c1f4b2`,
  install at Flash offset `0x0` for classic ESP32 with at least 4 MB Flash.
- **Release acceptance:** all Stage 1 host/C, development-proxy and 188 web
  regression tests; one exact clean ESP-IDF 5.5.5 release build; 24 embedded
  production web assets; unchanged partition layout; 358,480 bytes minimum
  OTA slot headroom. Cloud disposable browser flow also passed.
- **Production Cloud OTA:** deployment is separate from GitHub publication;
  a GitHub installer release does not itself update any ESP32. Physical OTA
  installation must be confirmed by live device version/build and Cloud status.

## V20.0.1

- **User-facing version:** `V20.0.1`, read from `esp32_monitor/VERSION`.
- **Firmware build ID embedded into the official BIN:** `179f5098c6ac`.
- **Firmware source commit in the private development monorepo:** `179f509`.
  The build ID is not a GitHub-public-repository commit ID.
- **Published standalone source/tag commit:** `ce9390da26be`
  ([V20.0.1](https://github.com/DJZeuS21/WattPost-ESP32/releases/tag/V20.0.1)).
- **Application-only signed Cloud OTA image SHA-256:**
  `364aa960d051e4a6115807febf99baf50dccfcd88f159a037e3240796c4f0366`,
  length `1541472` bytes.
- **GitHub USB full image SHA-256:**
  `8adc41dfa968417d848c4d554989d752306d2918cc3bb89292b8288ca4120277`,
  length `1672544` bytes.
- **Flash installation offset:** `0x0` (classic ESP32, 4 MB Flash).
- **Production WattPost Cloud OTA release:** `release_id=18` (successfully
  installed on both owner devices as of 2026-10-24).

The official app BIN and exact matching ELF were retained privately by the
maintainer for build-ID-specific diagnostics. The publicly exported firmware
C files and build configuration match the original release source; only
the documentation and a local-web development-only HTML block differ.
The production web bundler excludes development-only markup. The public
source checkout uses a different Git commit ID, so compiling it normally
produces a **different embedded build ID**. This does not make it another
product version.

**Do not assume byte-for-byte binary reproducibility from the exported Git
checkout.** The verified official binary was built from the private project
at the original build ID. Future releases should record both the source-export
commit and the exact original build commit, verify the bytes and keep an
unmodified matching ELF in private backup.

## Release checklist for future versions

1. Build and test in the private canonical WattPost source project. Keep the
   tested app BIN and matching ELF, and record `VERSION`, `build_id` and SHA-256.
2. Export only ESP32 firmware, canonical production web source, source build
   configuration and necessary tests/tools; never include Cloud backend,
   private agent docs, private keys, credentials, NVS, raw coredumps, or
   generated development assets.
3. Compare each exported source file against the private original, documenting
   intentional web-development/docs exclusions. Test standalone build without
   `secrets.local`. Audit the **full Git history**, not just the checkout.
4. Prepare a merged USB `full` image from the same exact verified build's
   bootloader, partition table, initial OTA data and app. Compare each range
   with the original flash arguments. Publish only **one installation BIN**.
5. Check third-party notices, repository license, installation guides and
   SHA-256 sums; tag the exported source commit and make a private GitHub
   Release. Never rewrite a published version/tag to hide differences.
6. Sign app-only Cloud OTA with the private key **off the Cloud host**,
   back up production DB, verify the signature and exact artifact and publish
   separately. Observe device installation and report success only after
   fresh firmware/build ID and confirmed OTA success.
7. Make PUBLIC only after a new explicit owner decision. The main developer
   monorepo and Cloud backend stay PRIVATE.

Source-only or legal-document updates do not change the embedded firmware
version. Do not republish physical OTA solely to update documentation.
