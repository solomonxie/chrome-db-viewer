# dbui-runner

Native messaging host for dbui: Postgres (libpq) and Redis (hiredis) for the extension,
Keychain storage for secrets, and the automatic backup of the extension's saved data. Design:
`design/DESIGN.md` §3.2–3.4, §3.7, §3.16, §5. Wire contract: `extension/src/core/runner-protocol.ts`.

All paths below are relative to the repo root.

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
runner/build/dbui-runner-tests            # Catch2: framing, pager (1 MB split), read-only refusal, type mapping, backup files
runner/tests/integration/run.sh           # docker postgres:17 + redis:7 on 15432/16379, pytest via uv
runner/tests/integration/run.sh --record  # re-record extension/tests/fixtures/runner/sessions.json
```

The integration test stores and deletes one Keychain item (`dbui-integration-test-ref`) and
skips that test if the Keychain refuses. The backup tests point `HOME` at a temp folder, so they
never touch your real `~/Library/Application Support/dbui/backup.json`.

## Try it in Chrome (development)

```sh
cd extension && npm run build && cd ..           # then Load unpacked → extension/dist
runner/scripts/dev-install.sh dalbkdjjdgbjhoalobeikhpchkoddnpb [browser-dir]
```

The extension ID is pinned: `extension/public/manifest.json` has a `key`, so the unpacked build
is always `dalbkdjjdgbjhoalobeikhpchkoddnpb`, whichever folder the repo lives in and across
reloads. (Without it the ID came from the folder path, and moving the repo gave a new ID with
empty storage and a runner manifest that no longer matched.) Don't change the `key`.

`dev-install.sh` builds the runner and writes `com.dbui.runner.json`, pointing at the absolute
path of `runner/build/dbui-runner` in this checkout, into
`~/Library/Application Support/<browser-dir>/NativeMessagingHosts/` (default `Google/Chrome`).
Re-run it if you move the repo. Logs go to `~/Library/Logs/dbui/runner.log` (or `$DBUI_RUNNER_LOG`).

Uninstalling the extension still deletes its IndexedDB and settings. With the runner
installed, the extension keeps a copy in `~/Library/Application Support/dbui/backup.json`
(previous one: `backup.prev.json`) a few seconds after each change, and a fresh install offers
to restore it from Home.

## Backup ops

| Request | Reply |
|---|---|
| `{"op": "backup.write", "json": "<dbui-backup JSON>"}` | `{"type": "ok", "mtime": <ms>, "size": <bytes>}` |
| `{"op": "backup.read"}` | `{"type": "chunk", "seq": n, "data": "…"}` × N, then `{"type": "backup", "exists": bool, "mtime": <ms>|null, "size": n, "chunks": N}` |

Writes go to a temp file, `fsync`, then `rename` over `backup.json`; the replaced file is kept as
`backup.prev.json`. Over 50 MB → `BACKUP_TOO_LARGE`; not a `{"format": "dbui-backup"}` object →
`BACKUP_INVALID`. Reads are split into ≤ 300 KB UTF-8-safe chunks to stay under Chrome's 1 MB
message limit. Older runners answer `UNKNOWN_OP`, which the extension treats as "no automatic
backup". `hello` lists `"features": ["backup"]`.

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
