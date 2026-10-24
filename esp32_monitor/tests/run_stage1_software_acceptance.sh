#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_ROOT/.." && pwd)"
IDF_ENV="$REPO_ROOT/tools/esp32-env.sh"

release_mode=false
case "${1:-}" in
  "") ;;
  --release) release_mode=true ;;
  --help|-h)
    cat <<'EOF'
Usage: tests/run_stage1_software_acceptance.sh [--release]

Default: full regression + clean disposable ESP-IDF build in /tmp.
--release: require a clean Git worktree and perform the same full regression plus
           the one exact release build in esp32_monitor/build/. Use this after the
           implementation commit; do not run another fullclean/build afterwards.
EOF
    exit 0
    ;;
  *) echo "Unknown argument: $1" >&2; exit 2 ;;
esac

if [[ ! -f "$PROJECT_ROOT/secrets.local" ]]; then
  echo "Stage 1 acceptance: missing local secrets.local; build cannot proceed." >&2
  exit 2
fi
if [[ ! -r "$PROJECT_ROOT/secrets.local" ]]; then
  echo "Stage 1 acceptance: secrets.local is not readable by the build user; preserving existing build artifacts." >&2
  exit 2
fi
if [[ ! -f "$IDF_ENV" || ! -f "$REPO_ROOT/.local-tools/esp-idf/export.sh" ]]; then
  echo "Stage 1 acceptance: project-local ESP-IDF missing; run ./tools/setup-esp32-env.sh." >&2
  exit 2
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/wattpost-stage1-acceptance.XXXXXX")"
sdkconfig="$work_dir/sdkconfig"
expected_partition="$work_dir/partition-table.bin"
trap 'rm -rf "$work_dir"' EXIT

if [[ "$release_mode" == true ]]; then
  if [[ -n "$(git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" status --porcelain)" ]]; then
    echo "Stage 1 release: Git worktree must be clean before exact build." >&2
    exit 2
  fi
  build_dir="$PROJECT_ROOT/build"
  rm -rf "$build_dir"
  echo "== Release mode: one exact clean build will be kept at $build_dir =="
else
  build_dir="$work_dir/build"
fi

echo "== Stage 1 host/C regression =="
(
  cd "$PROJECT_ROOT"
  ./tests/run_parser_test.sh
)

echo "== Stage 1 development proxy regression =="
(
  cd "$PROJECT_ROOT"
  python3 -m unittest discover -s tests -p 'test_dev_web_server.py'
)

echo "== Stage 1 Web regression (serial headless runner) =="
(
  cd "$REPO_ROOT"
  node --test --test-concurrency=1 esp32_monitor/web/tests/*.mjs
)

echo "== Stage 1 clean ESP-IDF 5.5.5 build =="
# shellcheck disable=SC1090
source "$IDF_ENV"
idf.py \
  -C "$PROJECT_ROOT" \
  -B "$build_dir" \
  -D "SDKCONFIG=$sdkconfig" \
  -D "SDKCONFIG_DEFAULTS=$PROJECT_ROOT/sdkconfig.defaults" \
  build

version="$(tr -d '\r\n' < "$PROJECT_ROOT/VERSION")"
grep -Fx "#define WATTPOST_FIRMWARE_VERSION \"$version\"" "$build_dir/wattpost_build.h" >/dev/null
grep -Fx "#define WATTPOST_WEB_VERSION \"$version\"" "$build_dir/wattpost_build.h" >/dev/null

python3 "$IDF_PATH/components/partition_table/gen_esp32part.py" \
  "$PROJECT_ROOT/partitions.csv" "$expected_partition" >/dev/null
cmp "$expected_partition" "$build_dir/partition_table/partition-table.bin"

asset_count="$(find "$build_dir/generated_web" -type f -name '*.gz' | wc -l | tr -d ' ')"
if [[ "$asset_count" != "24" ]]; then
  echo "Stage 1 acceptance: expected 24 production gzip assets, got $asset_count." >&2
  exit 1
fi

if gzip -dc "$build_dir/generated_web/index.html.gz" | grep -qE 'hero-dev-panel|DEV_ONLY'; then
  echo "Stage 1 acceptance: DEV_ONLY content leaked into production index." >&2
  exit 1
fi

app_size="$(wc -c < "$build_dir/wattpost_mini.bin" | tr -d ' ')"
slot_size=$((0x1D0000))
if (( app_size > slot_size )); then
  echo "Stage 1 acceptance: app image exceeds minimum OTA slot." >&2
  exit 1
fi
free_bytes=$((slot_size - app_size))

printf 'Stage 1 acceptance PASS: version=%s app=%d bytes free=%d bytes assets=%s\n' \
  "$version" "$app_size" "$free_bytes" "$asset_count"
if [[ "$release_mode" == true ]]; then
  build_id="$(git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  sha256="$(sha256sum "$build_dir/wattpost_mini.bin" | awk '{print $1}')"
  printf 'Exact release artifact: build_id=%s sha256=%s bin=%s\n' \
    "$build_id" "$sha256" "$build_dir/wattpost_mini.bin"
fi
