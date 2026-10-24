#!/usr/bin/env sh
set -eu
base="${1:-http://127.0.0.1:8081}"

# 1. Check root / serves V18 and relative assets
http --timeout 5 --check-status GET "$base/" | rg 'content="V18"' >/dev/null
http --timeout 5 --check-status GET "$base/css/styles.css" | rg "\.hero-card" >/dev/null
http --timeout 5 --check-status GET "$base/js/app.js" | rg "new App\(\)\.init" >/dev/null
http --timeout 5 --check-status GET "$base/vendor/chart.umd.js" >/dev/null
http --timeout 5 --check-status GET "$base/assets/logo.svg" >/dev/null
http --timeout 5 --check-status GET "$base/assets/dither-noise.png" >/dev/null

# 2. Check old test routes return 404
curl -s -o /dev/null -w "%{http_code}\n" "$base/v16-alt" | rg -q "404"
curl -s -o /dev/null -w "%{http_code}\n" "$base/v16-alt/" | rg -q "404"
curl -s -o /dev/null -w "%{http_code}\n" "$base/v17" | rg -q "404"
curl -s -o /dev/null -w "%{http_code}\n" "$base/v17/" | rg -q "404"
curl -s -o /dev/null -w "%{http_code}\n" "$base/v18" | rg -q "404"
curl -s -o /dev/null -w "%{http_code}\n" "$base/v18/" | rg -q "404"

# 3. Check API endpoints
http --timeout 5 --check-status GET "$base/api/live" | jq -e '.online and .cell_count > 0' >/dev/null
http --timeout 5 --check-status GET "$base/api/history" | jq -e 'type == "array"' >/dev/null

echo "wattpost-dev-web: ok (root serves V18, old test routes /v16-alt, /v17, /v18 return 404)"
