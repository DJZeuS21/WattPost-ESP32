# WattPost ESP32 — release provenance and verification

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
