# dbui-runner

Native messaging host for dbui: Postgres (libpq) and Redis (hiredis) for the extension, plus
Keychain storage for secrets. Design: `design/DESIGN.md` §3.2–3.4, §3.7, §5.2. Wire contract:
`extension/src/core/runner-protocol.ts`.

## Build (local, Homebrew)

```sh
brew install libpq hiredis nlohmann-json catch2      # openssl@3 too, if missing
cmake -S runner -B runner/build -DCMAKE_BUILD_TYPE=Release
cmake --build runner/build -j
```

CMake adds the `brew --prefix` of each dependency to `CMAKE_PREFIX_PATH`. Release builds
use vcpkg manifest mode instead (`vcpkg.json`, static deps, `-DCMAKE_OSX_ARCHITECTURES="arm64;x86_64"`
and `-DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake`).

## Tests

```sh
runner/build/dbui-runner-tests            # Catch2: framing, pager (1 MB split), read-only refusal, type mapping
runner/tests/integration/run.sh           # docker postgres:17 + redis:7 on 15432/16379, pytest via uv
runner/tests/integration/run.sh --record  # re-record extension/tests/fixtures/runner/sessions.json
```

The integration test stores and deletes one Keychain item (`dbui-integration-test-ref`) and
skips that test if the Keychain refuses.

## Try it in Chrome (development)

```sh
runner/scripts/dev-install.sh <unpacked-extension-id> [browser-dir]
```

Builds the runner and writes `com.dbui.runner.json`, pointing at `runner/build/dbui-runner`,
into `~/Library/Application Support/<browser-dir>/NativeMessagingHosts/` (default
`Google/Chrome`). The extension ID is on `chrome://extensions`. Logs go to
`~/Library/Logs/dbui/runner.log` (or `$DBUI_RUNNER_LOG`).

## Package

```sh
DBUI_EXTENSION_IDS=<id> runner/packaging/macos/build-pkg.sh   # → runner/dist/dbui-runner-<version>.pkg
```

Per-user `.pkg` (`enable_currentUserHome`): installs into `~/Library/Application Support/dbui/`,
and `postinstall` writes the manifest for Chrome, Edge, Brave, Arc and Chromium where those
folders exist. Signing and notarizing happen when `DEVELOPER_ID_APP`, `DEVELOPER_ID_INSTALLER`
and `NOTARY_PROFILE` are set. `uninstall.sh` removes the binary, the manifests and the
Keychain items (service `dev.dbui.runner`).

## Not implemented yet

- SSH tunnels: `connect` with `ssh` returns `SSH_NOT_IMPLEMENTED`.
- Native DuckDB (`driver: "duckdb"`) returns `UNSUPPORTED_DRIVER`.
