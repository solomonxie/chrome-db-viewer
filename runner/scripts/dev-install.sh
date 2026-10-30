#!/bin/bash
# Local development install of dbui-runner, without the .pkg.
#
#   runner/scripts/dev-install.sh <extension-id> [browser-dir]
#
# The dev extension ID is pinned by the manifest key: dalbkdjjdgbjhoalobeikhpchkoddnpb.
#
# Builds runner/build/dbui-runner and writes com.dbui.runner.json pointing straight at it
# into the browser's NativeMessagingHosts folder. browser-dir is relative to
# ~/Library/Application Support and defaults to "Google/Chrome". The extension ID is shown
# on chrome://extensions for the unpacked dbui extension.
#
# This writes into your browser profile; remove it with:
#   rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.dbui.runner.json
set -euo pipefail

ext_id="${1:?usage: dev-install.sh <unpacked-extension-id> [browser-dir]}"
browser="${2:-Google/Chrome}"
runner_dir="$(cd "$(dirname "$0")/.." && pwd)"

cmake -S "$runner_dir" -B "$runner_dir/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$runner_dir/build" -j

binary="$runner_dir/build/dbui-runner"
hosts="$HOME/Library/Application Support/$browser/NativeMessagingHosts"
mkdir -p "$hosts"
sed -e "s|__RUNNER_PATH__|$binary|" -e "s|__EXTENSION_ID__|$ext_id|" \
  "$runner_dir/packaging/macos/com.dbui.runner.json" > "$hosts/com.dbui.runner.json"
echo "wrote $hosts/com.dbui.runner.json → $binary"
echo "reload the extension, then open a Postgres or Redis connection. Logs: ~/Library/Logs/dbui/runner.log"
