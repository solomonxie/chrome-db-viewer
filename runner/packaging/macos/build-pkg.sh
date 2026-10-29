#!/bin/bash
# Builds dbui-runner-<version>.pkg, a per-user installer (no admin password).
#
#   runner/packaging/macos/build-pkg.sh
#
# Env vars:
#   DBUI_EXTENSION_IDS   space-separated extension IDs for allowed_origins (required)
#   DBUI_VERSION         package version (default: from CMakeLists.txt)
#   DBUI_BUILD_DIR       existing CMake build dir with dbui-runner (default: runner/build-pkg, built here)
#   DBUI_UNIVERSAL=1     build arm64 + x86_64 (needs universal deps, i.e. the vcpkg release build)
#   DEVELOPER_ID_APP     "Developer ID Application: …" to sign the binary (hardened runtime)
#   DEVELOPER_ID_INSTALLER "Developer ID Installer: …" to sign the .pkg
#   NOTARY_PROFILE       notarytool keychain profile; when set, the .pkg is notarized and stapled
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
runner_dir="$(cd "$here/../.." && pwd)"
: "${DBUI_EXTENSION_IDS:?set DBUI_EXTENSION_IDS to the dbui extension ID(s)}"
version="${DBUI_VERSION:-$(sed -n 's/^project(dbui-runner VERSION \([0-9.]*\).*/\1/p' "$runner_dir/CMakeLists.txt")}"
build_dir="${DBUI_BUILD_DIR:-$runner_dir/build-pkg}"
out_dir="$runner_dir/dist"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ -z "${DBUI_BUILD_DIR:-}" ]]; then
  args=(-DCMAKE_BUILD_TYPE=Release -DDBUI_BUILD_TESTS=OFF)
  [[ "${DBUI_UNIVERSAL:-0}" == 1 ]] && args+=("-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64")
  cmake -S "$runner_dir" -B "$build_dir" "${args[@]}"
  cmake --build "$build_dir" -j
fi

# Payload, laid out relative to the user's home folder.
root="$work/root"
app="$root/Library/Application Support/dbui"
mkdir -p "$app"
cp "$build_dir/dbui-runner" "$app/dbui-runner"
cp "$here/uninstall.sh" "$app/uninstall.sh"
cp "$here/com.dbui.runner.json" "$app/com.dbui.runner.json.template"
printf '%s\n' $DBUI_EXTENSION_IDS > "$app/extension-ids"
chmod 755 "$app/dbui-runner" "$app/uninstall.sh"

if [[ -n "${DEVELOPER_ID_APP:-}" ]]; then
  codesign --force --options runtime --timestamp --sign "$DEVELOPER_ID_APP" "$app/dbui-runner"
fi

scripts="$work/scripts"
mkdir -p "$scripts"
cp "$here/postinstall" "$scripts/postinstall"
chmod 755 "$scripts/postinstall"

pkgbuild --root "$root" --scripts "$scripts" --identifier com.dbui.runner --version "$version" \
  --install-location "/" "$work/dbui-runner-component.pkg"

sed "s/__VERSION__/$version/" "$here/distribution.xml" > "$work/distribution.xml"
mkdir -p "$out_dir"
pkg="$out_dir/dbui-runner-$version.pkg"
sign_args=()
[[ -n "${DEVELOPER_ID_INSTALLER:-}" ]] && sign_args=(--sign "$DEVELOPER_ID_INSTALLER" --timestamp)
productbuild --distribution "$work/distribution.xml" --package-path "$work" ${sign_args[@]+"${sign_args[@]}"} "$pkg"

if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "$pkg" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$pkg"
fi
echo "built $pkg"
