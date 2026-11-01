# WattPost ESP32 — release provenance and verification

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
