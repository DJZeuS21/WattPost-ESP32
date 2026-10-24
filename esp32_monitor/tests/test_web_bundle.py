import gzip
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGER = PROJECT_ROOT / "tools" / "package_web.py"
SOURCE = PROJECT_ROOT / "web"
VERSION = (PROJECT_ROOT / "VERSION").read_text().strip()

EXPECTED_FILES = {
    "index.html.gz",
    "setup.html.gz",
    "css/styles.css.gz",
    "css/setup.css.gz",
    "assets/dither-noise.png.gz",
    "assets/logo.svg.gz",
    "js/transport.js.gz",
    "js/api.js.gz",
    "js/app.js.gz",
    "js/battery-colors.js.gz",
    "js/charts.js.gz",
    "js/dashboard.js.gz",
    "js/data-normalizer.js.gz",
    "js/device-settings.js.gz",
    "js/energy-flow.js.gz",
    "js/history-cache.js.gz",
    "js/history.js.gz",
    "js/settings-schema.js.gz",
    "js/settings.js.gz",
    "js/setup-api.js.gz",
    "js/setup.js.gz",
    "vendor/chart.umd.js.gz",
    "vendor/chartjs-plugin-zoom.umd.min.js.gz",
    "vendor/hammer.min.js.gz",
}

EXPECTED_ROUTES = {
    "/": ["index.html.gz", "text/html; charset=utf-8"],
    "/setup.html": ["setup.html.gz", "text/html; charset=utf-8"],
    "/css/styles.css": ["css/styles.css.gz", "text/css; charset=utf-8"],
    "/css/setup.css": ["css/setup.css.gz", "text/css; charset=utf-8"],
    "/assets/dither-noise.png": ["assets/dither-noise.png.gz", "image/png"],
    "/assets/logo.svg": ["assets/logo.svg.gz", "image/svg+xml"],
    "/js/transport.js": ["js/transport.js.gz", "text/javascript; charset=utf-8"],
    "/js/api.js": ["js/api.js.gz", "text/javascript; charset=utf-8"],
    "/js/app.js": ["js/app.js.gz", "text/javascript; charset=utf-8"],
    "/js/battery-colors.js": ["js/battery-colors.js.gz", "text/javascript; charset=utf-8"],
    "/js/charts.js": ["js/charts.js.gz", "text/javascript; charset=utf-8"],
    "/js/dashboard.js": ["js/dashboard.js.gz", "text/javascript; charset=utf-8"],
    "/js/data-normalizer.js": ["js/data-normalizer.js.gz", "text/javascript; charset=utf-8"],
    "/js/device-settings.js": ["js/device-settings.js.gz", "text/javascript; charset=utf-8"],
    "/js/energy-flow.js": ["js/energy-flow.js.gz", "text/javascript; charset=utf-8"],
    "/js/history-cache.js": ["js/history-cache.js.gz", "text/javascript; charset=utf-8"],
    "/js/history.js": ["js/history.js.gz", "text/javascript; charset=utf-8"],
    "/js/settings-schema.js": ["js/settings-schema.js.gz", "text/javascript; charset=utf-8"],
    "/js/settings.js": ["js/settings.js.gz", "text/javascript; charset=utf-8"],
    "/js/setup-api.js": ["js/setup-api.js.gz", "text/javascript; charset=utf-8"],
    "/js/setup.js": ["js/setup.js.gz", "text/javascript; charset=utf-8"],
    "/vendor/chart.umd.js": ["vendor/chart.umd.js.gz", "text/javascript; charset=utf-8"],
    "/vendor/chartjs-plugin-zoom.umd.min.js": ["vendor/chartjs-plugin-zoom.umd.min.js.gz", "text/javascript; charset=utf-8"],
    "/vendor/hammer.min.js": ["vendor/hammer.min.js.gz", "text/javascript; charset=utf-8"],
}


class ProductionWebBundleTest(unittest.TestCase):
    def package(self, output: Path) -> None:
        subprocess.run(
            [sys.executable, PACKAGER, "--source", SOURCE, "--output", output, "--version", VERSION],
            check=True,
        )

    def test_bundle_contains_only_runtime_v18_assets_as_deterministic_gzip(self):
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first = Path(first_dir)
            second = Path(second_dir)
            self.package(first)
            self.package(second)

            first_files = {str(path.relative_to(first)) for path in first.rglob("*.gz")}
            self.assertEqual(first_files, EXPECTED_FILES)
            self.assertEqual(json.loads((first / "web_assets.json").read_text()), EXPECTED_ROUTES)
            self.assertEqual(
                (first / "web_assets.inc").read_bytes(),
                (second / "web_assets.inc").read_bytes(),
            )

            total_size = 0
            for relative in EXPECTED_FILES:
                packaged = first / relative
                duplicate = second / relative
                total_size += packaged.stat().st_size
                self.assertEqual(packaged.read_bytes(), duplicate.read_bytes())

                source_relative = relative.removesuffix(".gz")
                unpacked = gzip.decompress(packaged.read_bytes())
                if source_relative.endswith(".html"):
                    self.assertNotIn(b"__WATTPOST_WEB_VERSION__", unpacked)
                    html = unpacked.decode("utf-8")
                    self.assertIn(
                        f'<meta name="app-version" content="{VERSION}"',
                        html,
                    )
                    versions = set(
                        re.findall(
                            r'(?:src|href)="[^"]*[?&]v=([^"&]+)',
                            html,
                        )
                    )
                    self.assertEqual(versions, {VERSION})

                    if source_relative == "index.html":
                        self.assertNotIn(b"hero-dev-panel", unpacked)
                        self.assertNotIn(b"DEV_ONLY", unpacked)
                        self.assertIn(
                            f'<div class="app-version" id="app-version">{VERSION}</div>',
                            html,
                        )
                    else:
                        self.assertEqual(source_relative, "setup.html")
                        lowered = html.lower()
                        self.assertIn("js/setup-api.js", lowered)
                        self.assertIn("js/setup.js", lowered)
                        self.assertIn("css/setup.css", lowered)
                        self.assertNotIn("vendor/chart", lowered)
                        self.assertNotIn("js/history", lowered)
                        self.assertNotIn("js/dashboard", lowered)
                        self.assertNotIn('src="js/api.js', lowered)
                else:
                    expected_source = (
                        SOURCE / "js/transports/local-transport.js"
                        if source_relative == "js/transport.js"
                        else SOURCE / source_relative
                    )
                    self.assertEqual(unpacked, expected_source.read_bytes())

            self.assertLess(total_size, 250_000)

    def test_static_assets_do_not_use_immutable_cache_without_hashed_urls(self):
        server_source = (PROJECT_ROOT / "main" / "main.c").read_text()
        self.assertNotIn("immutable", server_source)
        self.assertIn('"public, max-age=3600"', server_source)


if __name__ == "__main__":
    unittest.main()
