# Third-party components

The following files are included in the **source repository** and in the
firmware's embedded local web interface. They retain their separate **MIT**
licenses, not the WattPost Commons Clause. The MIT permission and disclaimer
are reproduced in [licenses/MIT.txt](licenses/MIT.txt).

| Component | Vendored file | Copyright notice | Upstream |
| --- | --- | --- | --- |
| Chart.js v4.4.6 | `esp32_monitor/web/vendor/chart.umd.js` | © 2024 Chart.js Contributors | https://github.com/chartjs/Chart.js |
| chartjs-plugin-zoom v2.2.0 | `esp32_monitor/web/vendor/chartjs-plugin-zoom.umd.min.js` | © 2016–2024 chartjs-plugin-zoom Contributors | https://github.com/chartjs/chartjs-plugin-zoom |
| Hammer.js v2.0.7 | `esp32_monitor/web/vendor/hammer.min.js` | © 2016 Jorik Tangelder | https://github.com/hammerjs/hammer.js |

Other components (including ESP-IDF 5.5.5, Apache Mynewt NimBLE and
espressif/mdns) are fetched or managed as build dependencies. Refer to the
corresponding upstream license files and dependency versions.

The right to use, modify, copy and distribute these third-party components is
governed by **their original licenses**. WattPost cannot and does not restrict
rights that upstream licensors grant separately.
