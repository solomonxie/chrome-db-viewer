#!/bin/bash
# Removes dbui-runner for the current user: the binary, the native messaging manifests in
# every browser folder, the logs, and every Keychain item dbui stored (service dev.dbui.runner).
set -euo pipefail

app_dir="$HOME/Library/Application Support/dbui"
browsers=(
  "Google/Chrome"
  "Google/Chrome Beta"
  "Google/Chrome Canary"
  "Microsoft Edge"
  "BraveSoftware/Brave-Browser"
  "Arc/User Data"
  "Chromium"
)

for b in "${browsers[@]}"; do
  m="$HOME/Library/Application Support/$b/NativeMessagingHosts/com.dbui.runner.json"
  if [[ -f "$m" ]]; then
    rm -f "$m"
    echo "removed $m"
  fi
done

# Keychain: delete items one at a time until none are left.
removed=0
while security delete-generic-password -s dev.dbui.runner >/dev/null 2>&1; do
  removed=$((removed + 1))
done
echo "removed $removed Keychain item(s)"

rm -rf "$HOME/Library/Logs/dbui"
pkgutil --forget com.dbui.runner >/dev/null 2>&1 || true
rm -rf "$app_dir"
echo "removed $app_dir"
