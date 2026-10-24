#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
LOCAL_ROOT="$REPO_ROOT/.local-tools"
IDF_DIR="$LOCAL_ROOT/esp-idf"
export IDF_TOOLS_PATH="$LOCAL_ROOT/espressif"
IDF_COMMIT=b774170ff46c393eeb5e495ea37936038d3f4f4f

mkdir -p "$LOCAL_ROOT" "$IDF_TOOLS_PATH"
if [[ ! -d "$IDF_DIR/.git" ]]; then
  if [[ -e "$IDF_DIR" ]]; then
    echo "ESP-IDF target exists but is not a Git clone: $IDF_DIR" >&2
    exit 2
  fi
  git clone --depth 1 --branch v5.5.5 --recurse-submodules \
    https://github.com/espressif/esp-idf.git "$IDF_DIR"
fi
if [[ "$(git -C "$IDF_DIR" rev-parse HEAD)" != "$IDF_COMMIT" ]]; then
  echo "Unexpected ESP-IDF revision in $IDF_DIR (expected v5.5.5)." >&2
  exit 2
fi
if [[ -n "$(git -C "$IDF_DIR" status --porcelain)" ]]; then
  echo "ESP-IDF checkout has local changes; aborting tool installation." >&2
  exit 2
fi
# Installs just the esp32 target, not RISC-V, Clang, other SoC toolchains.
"$IDF_DIR/install.sh" esp32
# Test selection rather than trusting the calling user's HOME.
# shellcheck disable=SC1091
source "$REPO_ROOT/tools/esp32-env.sh"
[[ "$(idf.py --version)" == 'ESP-IDF v5.5.5' ]]
# Downloaded tool archives are installation-only; reclaim their space.
# Keep the installed compilers, Python environment and target metadata.
if [[ -d "$IDF_TOOLS_PATH/dist" ]]; then
  rm -rf -- "$IDF_TOOLS_PATH/dist"
fi
printf 'WattPost ESP-IDF ready: SDK=%s, tools=%s, target=%s\n' \
  "$IDF_PATH" "$IDF_TOOLS_PATH" "$IDF_TARGET"
