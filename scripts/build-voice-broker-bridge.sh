#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "voice broker bridge requires Linux" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ -n "${NODE_INCLUDE_DIR:-}" ]]; then
  node_include="$NODE_INCLUDE_DIR"
else
  node_prefix="$(node -p "require('node:path').dirname(require('node:path').dirname(process.execPath))")"
  node_include="$node_prefix/include/node"
fi
source_file="$repo_root/packages/app/native/aisy_voice_broker_bridge.c"
output_dir="$repo_root/packages/app/native/build"
output_file="$output_dir/aisy_voice_broker_bridge.node"

test -f "$node_include/node_api.h"
mkdir -p "$output_dir"
cc -shared -fPIC -std=c11 -O2 -Wall -Wextra -Werror -pthread \
  -I"$node_include" "$source_file" -o "$output_file"
chmod 0755 "$output_file"
