#!/usr/bin/env bash
# Source to activate the firmware toolchain; no dependency on $HOME or GPT.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Source this file instead: source tools/esp32-env.sh" >&2
  exit 2
fi
_wattpost_tools_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/.local-tools"
export IDF_PATH="$_wattpost_tools_root/esp-idf"
export IDF_TOOLS_PATH="$_wattpost_tools_root/espressif"
if [[ ! -f "$IDF_PATH/export.sh" || ! -d "$IDF_TOOLS_PATH/python_env" ]]; then
  echo "WattPost ESP-IDF environment absent. Run tools/setup-esp32-env.sh." >&2
  return 2
fi
# Clear inherited virtualenv selection (e.g. old /home/GPT paths).
unset IDF_PYTHON_ENV_PATH
# shellcheck disable=SC1091
source "$IDF_PATH/export.sh" >/dev/null 2>&1 || {
  echo "WattPost: unable to activate project-local ESP-IDF." >&2
  return 2
}
export IDF_TARGET=esp32
if [[ "$(command -v xtensa-esp32-elf-gcc)" != "$IDF_TOOLS_PATH/"* ]]; then
  echo "WattPost: Xtensa compiler is not from project-local toolchain." >&2
  return 2
fi
unset _wattpost_tools_root
