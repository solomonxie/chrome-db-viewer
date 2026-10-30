# dbui — a database client in Chrome

A database GUI in the spirit of TablePlus and DBeaver, shipped as a **Chrome extension**
(Manifest V3) plus a small optional native **runner** written in C++. It also opens local
CSV/JSONL/Parquet files in a fast, keyboard-driven sheet view in the spirit of VisiData.

**v1:** PostgreSQL, SQLite, Redis, BigQuery, ClickHouse, DuckDB, and local data files.
**Backlog:** MongoDB, Snowflake (see §8).

Clickable mockup of the full-page app: `design/mockup.html`.

---

## 1. The constraint that shapes everything

A Chrome extension **cannot open raw TCP sockets**, and WebAssembly doesn't change that:
code in a page, compiled or not, only gets the browser's network APIs (`fetch`,
`WebSocket`, `WebTransport`, `WebRTC`), and each of those starts with a handshake that
Postgres and Redis don't speak. `chrome.sockets` existed only for the retired Chrome Apps,
and the Direct Sockets API is limited to Isolated Web Apps.

What an extension *can* do: call HTTP APIs, run WebAssembly, read files the user picks,
and start a registered local program through **Native Messaging**. So each source reaches
the extension the cheapest way that works:

| Source | Default path | Runner needed? | Runner adds |
|---|---|---|---|
| **Local files** (CSV, TSV, JSONL, JSON, Parquet) | DuckDB-WASM in the page, files read through the File System Access API | No | Native DuckDB for very large files |
| **DuckDB** (`.duckdb` files) | DuckDB-WASM in the page | No | Read-write access, extensions (httpfs, postgres, excel), no 4 GB memory cap |
| **SQLite** | `sqlite3` WASM in the page | No | — |
| **BigQuery** | REST v2 straight from the extension | No | gcloud ADC pick-up, workload identity federation, Keychain storage for keys |
| **ClickHouse** | **HTTP interface** (port 8123/8443) straight from the extension | No | Native protocol (port 9000/9440) via `clickhouse-cpp` |
| **PostgreSQL** | Native messaging → `dbui-runner` → `libpq` | **Yes** | — |
| **Redis** | Native messaging → `dbui-runner` → `hiredis` | **Yes** | — |

Everything except Postgres and Redis works with no install at all. No database driver
code for Postgres or Redis ships in the extension; the runner owns those connections.
Without the runner, those two connection types show an "Install dbui runner" card (§5).

### Alternatives considered for Postgres / Redis
| Option | Why not (for v1) |
|---|---|
| Runner in Rust or Go | Easier cross-compiling, but we chose **C++** to use the official C/C++ client libraries directly. Revisit if Windows/Linux builds get painful. |
| Thin WebSocket↔TCP relay + drivers compiled to WASM inside the extension | Moves libpq & co. into the extension. We want the extension free of driver code. |
| Cloud proxy we host | Credentials and query results pass through our servers, and it can't reach databases on private networks or `localhost`. |
| Local HTTP/WebSocket server the user runs | It's a server on a port: needs auth tokens, CORS, and the user has to start it. Native messaging gives a private pipe that Chrome starts and stops for us. |
| Team-hosted gateway (CloudBeaver model) | Good **later** as a paid team product. It can speak the same JSON protocol over a WebSocket, so the extension UI doesn't change. |

---

## 2. Stack

| Part | Choice | Why |
|---|---|---|
| Extension UI | **TypeScript + React 18 + Vite** (`@crxjs/vite-plugin`), a **full-page tab only** (`app.html`). No toolbar popup, no Chrome side panel | A full tab gives the room of a desktop app; MV3 allows it |
| Data grid | **Glide Data Grid** (canvas based) | Scrolls 1M rows smoothly and supports in-place editing; DOM grids stall past ~50k cells |
| SQL editor | **CodeMirror 6** with `@codemirror/lang-sql` (PostgreSQL, SQLite, DuckDB, ClickHouse, BigQuery dialects) | Light, extensible, schema-aware autocomplete hooks |
| DuckDB + file engine | `@duckdb/duckdb-wasm` in a Web Worker, loaded only when first used | One engine for `.duckdb` files and CSV/JSONL/Parquet sheets |
| SQLite | `@sqlite.org/sqlite-wasm` in a Web Worker, OPFS for scratch DBs | Official build |
| BigQuery | `fetch` + a `TokenProvider` per auth method (§3.8) | No runner, no backend |
| ClickHouse | `fetch` against the HTTP interface, streamed with `ReadableStream` (§3.9) | No dependency, no runner |
| Local state | IndexedDB (connections minus secrets, history, snippets, recent file handles, UI state), copied to the runner's `backup.json` (§3.16) | Survives restarts; stays on this machine; survives uninstall through the backup |
| Secrets | macOS Keychain through the runner when installed, otherwise the browser profile (§3.7) | Never synced, never in exported settings |
| Runner | **C++20**, CMake + vcpkg, one binary `dbui-runner` (static deps, universal arm64 + x86_64) | Official native client libraries; no runtime to install |
| Runner libs | `libpq`, `hiredis`, `libduckdb`, `clickhouse-cpp`, `libssh2`, OpenSSL 3, `libcurl` (Google token exchange), `nlohmann/json`, `Security.framework` | Mature C/C++ clients |

### Manifest essentials
```jsonc
{
  "manifest_version": 3,
  // Public key that pins the extension ID (dalbkdjjdgbjhoalobeikhpchkoddnpb) for unpacked
  // installs, whatever folder dist/ is loaded from (§5.1).
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr5oL…",
  // Clicking the icon opens popup.html: a searchable list of connections (§4.1). No "side_panel".
  "name": "Chrome DB Viewer",
  "action": { "default_title": "Chrome DB Viewer", "default_popup": "popup.html" },
  "permissions": ["nativeMessaging", "downloads", "downloads.open", "identity", "storage", "unlimitedStorage",
                  "declarativeNetRequestWithHostAccess"],  // data-file links (§3.12); rules only act on hosts granted below
  "host_permissions": [
    "https://bigquery.googleapis.com/*",
    "https://oauth2.googleapis.com/*",
    "https://iamcredentials.googleapis.com/*",
    // All sites, granted at install, so Browser preview (§3.12) works with no extra prompt.
    // This also satisfies the per-origin request made when saving a ClickHouse HTTP connection.
    "https://*/*", "http://*/*"
  ],
  // The preview redirect can only land on a web-accessible page (§3.12). Only app.html.
  "web_accessible_resources": [{ "resources": ["app.html"], "matches": ["<all_urls>"] }],
  "oauth2": { "client_id": "<id>.apps.googleusercontent.com", "scopes": ["https://www.googleapis.com/auth/bigquery"] },
  // WASM needs 'wasm-unsafe-eval'. Cross-origin isolation enables DuckDB-WASM threads.
  "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
  "cross_origin_embedder_policy": { "value": "require-corp" },
  "cross_origin_opener_policy": { "value": "same-origin" }
}
```
**All-sites host access is granted at install.** Browser preview is on by default (§3.12),
and its redirect rule only acts on hosts the extension has access to, so asking later meant the
feature silently did nothing for anyone who never opened Settings. The cost is Chrome's
install-time warning, **"Read and change all your data on all websites"**. What dbui actually
does with that access is narrow: there are no content scripts, so it never reads the pages you
browse; the only thing that uses it is one `declarativeNetRequest` redirect for `main_frame`
navigations to data-file URLs, which Chrome evaluates itself, plus the viewer's `fetch` of a file
you opened. Turning Browser preview off removes the rule. A user can still restrict dbui's site
access on `chrome://extensions`; Settings then shows **Site access is off for dbui in Chrome.
[Fix]**, which calls `chrome.permissions.request`.
MV3 forbids remotely loaded code, so every WASM module and DuckDB extension the
browser build uses is bundled in the package.

---

## 3. Architecture

```
┌──────────────────────────────── Chrome ──────────────────────────────────────┐
│  app.html tab (React) — one tab per open connection or file                   │
│   Sidebar · Tabs · Grid (Glide) · Editor (CodeMirror) · Sheet stack · Drawer  │
│        │                                                                      │
│  ┌─────▼────────────────── Client core (TypeScript) ──────────────────────┐   │
│  │ Driver interface                                                        │   │
│  │  In the browser:  DuckDbWasmDriver ─ FileSheetDriver (CSV/JSONL/Parquet)│   │
│  │                   SqliteDriver (WASM) · BigQueryDriver · ClickHouseHttp │   │
│  │  Via the runner:  RunnerDriver (postgres, redis, duckdb-native,         │   │
│  │                   clickhouse-native)                                    │   │
│  │ TokenProviders (Google auth) · SecretStore · ResultCache · ChangeSet    │   │
│  └─────┬──────────────────────────────────────┬────────────────────────────┘  │
│        │ connectNative("com.dbui.runner")      │ fetch (HTTPS)                 │
└────────┼───────────────────────────────────────┼──────────────────────────────┘
         │ stdin/stdout: 4-byte length + JSON     ├──► bigquery.googleapis.com
┌────────▼──────── dbui-runner (C++20) ───────┐   └──► your ClickHouse :8443
│ Framing · Router · Session (worker + cancel)│
│ PgDriver (libpq) · RedisDriver (hiredis)    │
│ DuckDbDriver (libduckdb) · ClickHouseNative │
│ GoogleAuth (ADC, WIF, SA keys → tokens)     │
│ SshTunnel · SecretStore (Keychain) · Pager  │
└───────┬───────────────┬─────────────────────┘
     Postgres         Redis       (plus local .duckdb files, ClickHouse :9440)
```

### 3.1 Who does what

| Extension (browser) | Runner (native process, optional) |
|---|---|
| Draws everything | Opens and owns Postgres/Redis connections |
| Runs DuckDB, SQLite, file sheets, BigQuery and ClickHouse HTTP itself | Offers native DuckDB and ClickHouse for heavier work |
| Holds pending edits until `⌘S` | Turns a ChangeSet into statements and runs them in one transaction |
| Stores connection settings in IndexedDB | Stores passwords, SSH keys and service-account keys in Keychain |
| Shows safety warnings | **Enforces** read-only mode for the drivers it runs |

### 3.2 Runner lifecycle

You never start or stop the runner yourself.

1. A connection tab calls `chrome.runtime.connectNative("com.dbui.runner")`.
2. Chrome finds `com.dbui.runner.json` in its `NativeMessagingHosts` folder, checks that
   the dbui extension ID is in `allowed_origins`, and starts the binary at `path`.
3. The tab sends `{"op":"hello"}`. The runner answers with its version and supported drivers.
4. When the tab closes or calls `port.disconnect()`, Chrome closes the pipe. The runner
   sees EOF on stdin, closes its connections and SSH tunnels, and exits.

**One runner process per connection tab.** Closing a tab disconnects that database,
a crash in one driver affects only one tab, and the runner never routes messages between tabs.
Tabs that only need a quick runner service (a Keychain read, a Google token) open a
short-lived port and close it right after.

```ts
const port = chrome.runtime.connectNative("com.dbui.runner"); // Chrome starts the runner
port.onMessage.addListener(onRunnerMessage);
port.onDisconnect.addListener(() => {
  const err = chrome.runtime.lastError?.message;
  // "Specified native messaging host not found." → show the install card
  // "Native host has exited."                    → runner crashed; offer Reconnect
});
port.postMessage({ id: 1, op: "hello", client: "1.0.0" });
```

- **stdout carries only protocol messages.** Logs go to `~/Library/Logs/dbui/runner.log`.
- After a crash the tab offers Reconnect. Pending edits live in the tab, so nothing is lost.

### 3.3 Runner protocol

JSON-RPC-style messages over the pipe. Every request has an `id`; results stream back as
several messages with the same `id`.

```jsonc
// extension → runner
{"id": 1, "op": "hello", "client": "1.0.0"}
{"id": 7, "op": "connect", "conn": {"driver": "postgres", "host": "db.internal", "port": 5432,
          "user": "app", "db": "shop", "secretRef": "c_8f2", "readOnly": false,
          "ssh": {"host": "bastion.shop.internal", "user": "deploy", "keySecretRef": "c_8f2_ssh"}}}
{"id": 8, "op": "execute", "sql": "select * from orders", "pageSize": 2000}
{"id": 9, "op": "cancel",  "target": 8}
{"id": 10, "op": "google.token", "source": "adc"}
{"id": 11, "op": "backup.write", "json": "{\"format\":\"dbui-backup\",…}"}   // §3.16
{"id": 12, "op": "backup.read"}

// runner → extension
{"id": 1, "type": "hello", "runner": "1.0.3", "protocol": 1,
          "drivers": ["postgres", "redis", "duckdb", "clickhouse-native"], "google": ["adc", "wif", "sa-keychain"]}
{"id": 7, "type": "ok", "server": "PostgreSQL 16.4"}
{"id": 8, "type": "columns", "cols": [{"name": "id", "type": "int8"}, …]}
{"id": 8, "type": "page", "seq": 0, "rows": [[1, "paid", …], …]}   // each message < 1 MB
{"id": 8, "type": "done", "rowCount": 48211, "ms": 412}
{"id": 8, "type": "error", "code": "42P01", "message": "relation \"order\" does not exist"}
{"id": 10, "type": "token", "accessToken": "ya29…", "expiresAt": 1761660000}
{"id": 11, "type": "ok", "mtime": 1761700000000, "size": 48211}
{"id": 12, "type": "chunk", "seq": 0, "data": "{\"format\":\"dbui-backup\",…"}  // ≤ 300 KB of UTF-8 each
{"id": 12, "type": "backup", "exists": true, "mtime": 1761700000000, "size": 48211, "chunks": 1}
```

- Ops: `hello`, `connect`, `disconnect`, `listObjects`, `describe`, `execute`, `cancel`,
  `apply` (ChangeSet), `export` (writes a file directly), `secret.set` / `secret.get` /
  `secret.delete`, `backup.write` / `backup.read` (§3.16), `google.token`, `tunnel.test`.
- Chrome caps **runner → Chrome** messages at 1 MB (the other direction allows up to 4 GB).
  The Pager sends ~2,000-row pages and splits further when rows are wide. Large exports
  never go through the pipe: the runner writes the file itself and sends progress.
- `protocol` is an integer bumped on breaking changes. If the extension needs a newer
  protocol than the installed runner speaks, it shows the update card (§5).
- New ops are added without a bump when older builds can ignore them: an older runner answers
  `UNKNOWN_OP` and the extension treats that as "feature not available". `hello` lists such
  additions in `features` (e.g. `["backup"]`). `backup.*` arrived this way in protocol 1.

### 3.4 Runner internals (C++)

```cpp
// One connection per runner process, so a Session is the whole runtime state.
class Driver {
public:
    virtual ~Driver() = default;
    virtual json connect(const json& cfg, CancelToken&) = 0;
    virtual json listObjects(const json& parent, CancelToken&) = 0;   // lazy tree
    virtual json describe(const json& path, CancelToken&) = 0;
    virtual void execute(const json& stmt, PageSink&, CancelToken&) = 0;  // streams pages
    virtual json apply(const json& changeSet, CancelToken&) = 0;      // one transaction
    virtual void cancel() = 0;  // PQcancel / duckdb_interrupt / ClickHouse Cancel packet
};
```

- **Threads:** a stdin reader decodes frames and pushes jobs; one worker runs jobs in order
  (libpq and hiredis connections aren't thread safe); a stdout writer serializes replies.
  `cancel` is handled on the reader thread so it isn't stuck behind the job it cancels.
- **Metadata:** tree expansion and autocomplete use a second, read-only connection in the
  same process, so they don't wait behind a long query.
- **Read-only:** `SET default_transaction_read_only = on` (pg), `access_mode = 'READ_ONLY'`
  (DuckDB), `readonly = 1` (ClickHouse); the Redis driver refuses write commands by name.
- **Build:** CMake + vcpkg manifest mode, static deps, `-arch arm64 -arch x86_64`, hardened
  runtime, Developer ID signed and notarized. Catch2 tests against docker-compose pg/Redis/ClickHouse.

### 3.5 Driver interface in the extension (TypeScript)

Drivers declare **capabilities**, and the UI picks views from those, never from the
database name.

```ts
type StoreKind = "relational" | "keyvalue" | "warehouse" | "file";

interface Capabilities {
  kind: StoreKind;
  transactions: boolean;   // pg, sqlite, duckdb
  editableRows: boolean;   // pg, sqlite, duckdb, redis, file sheets
  costEstimate: boolean;   // bigquery dry run
  cancel: boolean;
}

interface Driver {
  capabilities(): Capabilities;
  connect(cfg: ConnectionConfig, signal: AbortSignal): Promise<void>;
  listObjects(parent: ObjectPath, signal: AbortSignal): Promise<ObjectNode[]>;
  describe(path: ObjectPath, signal: AbortSignal): Promise<TableSchema>;
  execute(stmt: Statement, signal: AbortSignal): AsyncIterable<ResultPage>;
  estimate?(stmt: Statement, signal: AbortSignal): Promise<CostEstimate>;
  apply(changes: ChangeSet, signal: AbortSignal): Promise<ApplyResult>;
}
```

- `ResultPage`s are stored **columnar** in the tab (typed arrays where possible, plus a
  null bitmap). The grid asks for rows by index; missing pages show placeholder cells.
- Results past a cap (default 100k rows) load only on "Load all".
- 64-bit integers are kept as strings or `BigInt`, never JavaScript numbers, so IDs don't
  lose precision (matters for ClickHouse `UInt64` and BigQuery `INT64`).

### 3.6 Editing model (ChangeSet)

Edits stay local until you commit, as in TablePlus.

1. Double-click a cell to edit it in place. The cell turns amber.
2. Add row (`⌘I`) or delete row (`⌫`) mark rows green or red.
3. The footer shows "3 pending changes". `⌘⇧P` opens a drawer with the exact statements.
4. `⌘S` applies the ChangeSet in one transaction. `⌘Z` undoes one edit.

| Source | How edits are applied |
|---|---|
| Postgres, SQLite, DuckDB | `UPDATE`/`INSERT`/`DELETE` by primary key, one transaction. Tables without a key are read-only unless you opt in to "match on all columns" |
| Redis | Typed commands (`SET … KEEPTTL`, `HSET`, `ZADD` …) in `MULTI`/`EXEC` |
| File sheets | Edits change the in-memory sheet; `⌘S` writes the file back (§3.11) |
| ClickHouse | Grid allows **inserts only**. Updates and deletes are mutations that rewrite data parts, so they go through the editor with a warning |
| BigQuery | Grid is read-only; DML only through the editor, behind the cost guard |

> Browser shortcut clash: `⌘S`, `⌘P`, `⌘R` and `⌘K` normally belong to Chrome. Inside
> `app.html` we call `preventDefault()` on them, but `⌘T`/`⌘W`/`⌘N` can't be taken from
> the browser. New query tab is `⌥T`, close tab `⌥W`.

### 3.7 Secrets

| Runner installed? | Where passwords and keys live |
|---|---|
| Yes | macOS Keychain, through `secret.set` / `secret.get`. The extension keeps only a `secretRef` |
| No | Your choice per connection: **Ask every session** (kept in memory only), or **Remember in this browser** (`chrome.storage.local`, never `storage.sync`, labelled as such in the UI) |

Secrets never appear in exported or synced settings, or in backups (§3.16). BigQuery OAuth
tokens are held by Chrome or kept in memory; key files can stay on disk (§3.8).

### 3.8 BigQuery authentication

Every method produces a short-lived access token through one interface, so the BigQuery
driver doesn't care how you signed in:

```ts
interface TokenProvider { getToken(signal: AbortSignal): Promise<{ token: string; expiresAt: number }>; }
```

| Method | How it works | Runner? |
|---|---|---|
| **Chrome profile account** (default in Chrome) | `chrome.identity.getAuthToken`. Uses the Google account signed in to Chrome; one consent screen, no password | No |
| **Any Google account** (Edge, Brave, Arc, or a different account) | `chrome.identity.launchWebAuthFlow`, OAuth 2.0 authorization code + PKCE, refresh token kept per §3.7 | No |
| **Service account key** (JSON) | The extension signs a JWT with WebCrypto (RS256) and exchanges it at `oauth2.googleapis.com/token`. The key is either kept as a **file handle** (stays on disk, read on each refresh) or stored per §3.7 | No |
| **gcloud ADC** (`gcloud auth application-default login`) | Runner reads `~/.config/gcloud/application_default_credentials.json` automatically and refreshes it. Without the runner, you pick that file once and the extension keeps a handle to it | Optional |
| **Service account impersonation** | Any of the above, then `iamcredentials.generateAccessToken` for the target service account | No |
| **Workload identity federation** (`external_account` configs, AWS/Azure/OIDC) | Runner, because some configs run a local executable to get the subject token | Yes |
| **Paste an access token** | e.g. output of `gcloud auth print-access-token`; memory only, expires in ~1 h | No |

**Why not reuse the browser's Google login cookies?** The BigQuery REST API only accepts
OAuth bearer tokens; it ignores cookies. The only thing cookies unlock is the Cloud
Console's private, undocumented endpoints, which change without notice, would require the
`cookies` permission on `google.com`, and get extensions rejected from the Web Store. The
Chrome profile method above gives the same "already signed in" experience through a
supported API.

Notes:
- The `bigquery` scope is a sensitive scope, so the OAuth client needs Google's app
  verification before public launch.
- The project list comes from `bigquery/v2/projects`, so no extra Google API is needed.

### 3.9 ClickHouse

**Default: the HTTP interface, straight from the extension.** No runner and no SDK.

```
POST https://ch.example.com:8443/?database=analytics
     &default_format=JSONCompactEachRowWithNamesAndTypes
     &query_id=<uuid>&readonly=1&max_execution_time=300
X-ClickHouse-User: reader
X-ClickHouse-Key: ••••••
<body: SQL>
```

- **Streaming:** the response body is read with `ReadableStream` and split on newlines;
  line 1 is column names, line 2 is types, then one JSON array per row, batched into
  2,000-row pages. Big result sets never sit in memory as one string.
- **Cancel:** abort the `fetch`, then send `KILL QUERY WHERE query_id = '<uuid>'` on a
  second request, so the server stops work even if it doesn't notice the closed connection.
- **Read-only mode** passes `readonly=1`, which the server enforces.
- **Host access:** the extension asks for permission to that one origin
  (`chrome.permissions.request`) when you save the connection. Extension requests with host
  permission aren't blocked by CORS, so no server config is needed. Works with ClickHouse
  Cloud and with self-hosted servers reachable from your machine (VPN included).
- **Sidebar:** databases → tables (engine, rows, compressed size from `system.parts`),
  views, materialized views, dictionaries. Structure tab shows `SHOW CREATE TABLE`,
  partition key, order key and TTL.
- **Optional native protocol** (port 9000/9440) through the runner with `clickhouse-cpp`,
  for networks where the HTTP port is closed or for faster transfer of large results.
  The connection sheet has a **Protocol: HTTP (default) / Native (runner)** switch.

### 3.10 DuckDB

- **Default: DuckDB-WASM in a Web Worker.** Loaded the first time you open a DuckDB
  connection or a data file, so it doesn't slow down the rest of the extension.
- Open a `.duckdb` file through the file picker. In the browser it opens **read-only**;
  for read-write, use the runner, or copy it into browser storage (OPFS) as a scratch database.
- With cross-origin isolation (manifest keys in §2) DuckDB-WASM uses multiple threads.
  Memory is capped at 4 GB by WebAssembly.
- Only DuckDB extensions bundled with the build (`json`, `parquet`) are available in the
  browser, because MV3 forbids loading code from the network.
- **Native DuckDB in the runner** (`libduckdb`) removes those limits: read-write files,
  all cores, no memory cap, and extensions like `httpfs` (S3/GCS with credentials),
  `postgres`, `excel` and `spatial`.
- Setting **DuckDB engine: Auto / Browser / Runner.** Auto uses the runner when it's
  installed and falls back to the browser.

### 3.11 Local data files (VisiData-style sheets)

Open a CSV, TSV, JSONL/NDJSON, JSON array or Parquet file (also `.gz`) and get a fast
sheet you drive from the keyboard. It's built on DuckDB, so a 5 GB CSV doesn't need to
fit in memory.

**Opening:** drag a file onto dbui, use **Open file** on Home or in the palette, or pick from
recent files. Recent files are kept as File System Access handles in IndexedDB; Chrome
asks once per session to read them again.

**Loading:**
- DuckDB's sniffer detects the delimiter, header, quoting and column types
  (`read_csv`, `read_json`, `read_parquet`). You can override any of them in the sheet header.
- Files under ~500 MB are loaded into a temp table on open, so sorting and scrolling are instant.
- Bigger files stay as a view over the file. Each sort or filter re-scans the file, with a
  progress bar and Stop.

**Sheet stack (from VisiData):** every derived view opens as a new sheet on top of the
current one. A breadcrumb shows the stack (`orders.csv › status frequency › status = paid`)
and `Esc` (or `q` with VisiData keys) goes back one.

| Feature | What you get | dbui key | VisiData key |
|---|---|---|---|
| Column summary | Type, nulls, distinct, min, max, mean, top value and a histogram per column (DuckDB `SUMMARIZE`) | `⌘I` on header | `Shift+I` |
| Frequency table | Counts and a bar for each value of the current column; `Enter` on a value filters the source sheet to it | `⌘⇧F` | `Shift+F` |
| Sort | Ascending / descending on the current column, stackable | click header | `[` / `]` |
| Filter | Regex on the current column, or a SQL `WHERE` expression | `⌘F` | `\|` / `z\|` |
| Select rows | Select, unselect, toggle; open the selection as a new sheet | `Space` | `s` `u` `t` `"` |
| Derived column | New column from a SQL expression, e.g. `total * 0.2` | `⌘=` | `=` |
| Column type | Set as int, float, date or text | header menu | `#` `%` `@` `~` |
| Hide column | Hide or show columns | header menu | `-` |
| Pivot | Group by one column, spread another into columns, choose the aggregate | palette | `Shift+W` |
| Row detail | `Enter` opens the row; nested JSONL objects and arrays shown as a tree | `Enter` | `Enter` |
| Expand nested | Turn a nested JSON column into its own columns | header menu | `(` |
| SQL | Query the file directly: `SELECT … FROM 'orders.csv'`; join several open files | `⌥T` | — |

**Saving:** edits stay in the sheet until `⌘S`, which writes the file back in the same
format (`COPY … TO`) through the file handle. **Save as** converts between CSV, JSONL and
Parquet. Rewriting a CSV can change its quoting, so the first save to an existing file asks
before overwriting.

**Keymap:** dbui keys by default; a **VisiData keys** setting turns on `hjkl` movement and
the single-letter commands above.

### 3.12 Browser preview: opening files from the browser

When this is on, a data file (CSV, JSONL, Parquet …) you open in Chrome shows up in a dbui
file sheet instead of being downloaded. dbui only opens data files; images and video are
left to Chrome. It's **on by default**: the all-sites host access the redirect rule needs is
granted at install (§2, *Manifest essentials*), and the background worker installs rule 1 on
install and on every service-worker start. Settings → **Browser preview** turns it off
(which removes the rule) and lets you pick the file extensions.

Why on by default: the feature is the main reason to keep dbui installed for people who look at
CSV/Parquet links all day, and as an opt-in behind a permission prompt it was easy to never find.
When it was opt-in, a reinstall (which resets settings) quietly turned it off, and links
downloaded again with nothing to say why. The trade-off is the install-time "all websites"
warning; Chrome evaluates the rule itself and dbui runs no content scripts.

| How the file arrives | What dbui does |
|---|---|
| You click a link or type a URL ending in a data extension | A redirect rule sends the tab to `app.html?src=<url>`, and the viewer loads the file |
| A site starts a download (Export button, `Content-Disposition: attachment`, no extension in the URL) | `downloads.onCreated` recognises the file name or MIME type and shows an **Open in dbui** prompt |
| A local file in Chrome (`file:///…/data.csv`) | Same redirect rule. Needs **Allow access to file URLs** turned on for dbui on `chrome://extensions`; the settings page links there and says so |
| Double-clicking a file in Finder | Not possible. macOS can't make an extension the app for a file type. Drag it onto the dbui tab or use `⌘O` |

**Settings → Browser preview: choose the file extensions.** Settings lists every supported
extension as a checkbox, grouped. You pick exactly which ones dbui opens; everything else
downloads or displays the way Chrome normally does. The master switch is on by default.

| Group | Extensions (each one its own checkbox) | Checked by default |
|---|---|---|
| Tables | `.csv` `.tsv` `.psv` | Yes |
| JSON Lines | `.jsonl` `.ndjson` | Yes |
| Columnar | `.parquet` `.arrow` `.feather` | Yes |
| Databases | `.duckdb` `.sqlite` `.db` | Yes |
| JSON | `.json` | **No.** Chrome's own JSON view is often what you want for API responses |
| Compressed | `.gz` `.zst` (applies on top of the data types above, e.g. `.csv.gz`) | Yes |

Saved settings from older versions that still list image or video extensions have them
dropped on load, so they can't bring media matching back.

Below the list: **Never open from these sites** (a domain list), plus a note and link for
**Allow access to file URLs** on `chrome://extensions` for local files.

**Redirect rule** (rebuilt with `updateDynamicRules` on install, on every service-worker start
— `onStartup` doesn't fire on an extension reload — and whenever the checklist changes; removed
when the master switch is off or when site access is missing):

```jsonc
{
  "id": 1, "priority": 1,
  "condition": {
    // generated from the checked extensions, e.g. with csv, jsonl, parquet checked:
    "regexFilter": "^(https?|file)://[^?#]*\\.(csv|jsonl|parquet)(\\.gz|\\.zst)?([?#].*)?$",
    "resourceTypes": ["main_frame"],  // only tabs you navigate; sites' own fetches are untouched
    "excludedRequestDomains": []      // "Never open from these sites"
  },
  "action": { "type": "redirect",
    "redirect": { "regexSubstitution": "chrome-extension://<id>/app.html?src=\\0" } }
}
```

- Chrome evaluates the rule itself. dbui never sees the rest of your browsing.
- `syncPreviewRules` still checks `chrome.permissions.contains` for all sites. That's normally
  true from install; if the user restricted site access on `chrome://extensions`, the rule is
  removed and Settings shows **Site access is off for dbui in Chrome. [Fix]**.
- `.gz`/`.zst` only match after a checked data extension, so a plain `backup.tar.gz` still downloads.
- `app.html` is listed in `web_accessible_resources` for `<all_urls>`. Chrome refuses a DNR
  redirect from a web page to an extension page that isn't web-accessible to that origin, and
  the navigation then carries on as a plain download. Only that one page is exposed (no
  `assets/*`, no `sandbox.html`), and without `use_dynamic_url`, since the redirect target is
  the static `chrome-extension://<id>/` URL.
- Rule 1 only acts on `main_frame`, so a file a page loads itself is never affected. The rule
  only catches a file opened directly as the tab's address.
- Ids 2 and 3 belonged to the removed image/video viewer. Every sync still removes them
  (`LEGACY_RULE_IDS`), so installs that had them get them cleared.
- A **Download instead** button in the viewer calls `chrome.downloads.download(url)`. That's
  a download, not a tab navigation, so the rule doesn't catch it again.
- **Never open from this site** is also a button in the viewer; it adds the domain to the list.

**Loading the file in the viewer:**
- **Parquet** is read with HTTP range requests: DuckDB-WASM reads the footer, then only the
  columns and row groups it needs. A multi-GB file on S3 or GCS opens in about a second.
- **CSV / JSONL** are streamed through DuckDB's readers. `.gz` and `.zst` are decompressed
  while reading; a `Content-Encoding: gzip` transfer is decompressed by `fetch` itself.
- The extension's `fetch` sends your cookies for that site, so files behind a login work
  the same way they would in the tab.
- Over ~1 GB for a remote CSV/JSONL, the viewer warns before reading it all, and offers
  **Download instead** or, with the runner, **Open with native DuckDB**.
- The sheet has the full file-sheet features (§3.11). Edits can't be saved back to a URL,
  so `⌘S` becomes **Save as** to a local file.
- `.duckdb` / `.sqlite` links are downloaded into browser storage (OPFS) and opened
  read-only as a connection tab.

**When the URL can't be fetched again** (one-time links, form-POST exports, `blob:` URLs
made by a page): dbui lets Chrome finish the download, then opens the file from disk
(`downloads.onChanged` → `state: complete`). Reading it needs **Allow access to file URLs**;
without it, the prompt says **Show in Finder** and you drag the file into dbui.

**Header-based matching** (files served as `text/csv` from a URL with no extension) would
need DNR response-header conditions. Use them only on Chrome versions that support them;
check the minimum version before building. The `downloads.onCreated` prompt covers these
files on older versions.

### 3.13 Safety

- **Environment tag** per connection: `local`, `dev`, `staging`, `production`. Production
  paints the header red and turns on the checks below.
- **Read-only mode** enforced below the UI: by the runner (pg, DuckDB native, ClickHouse
  native, Redis), by the server (`readonly=1` for ClickHouse HTTP), or by the worker
  (`PRAGMA query_only` for SQLite, `READ_ONLY` attach for DuckDB-WASM).
- **Destructive statement check**: `DROP`, `TRUNCATE`, and `DELETE`/`UPDATE` with no
  `WHERE` (plus ClickHouse `ALTER TABLE … DELETE/UPDATE`) ask you to type the table name on
  production connections.
- **BigQuery cost guard**: a dry run on every edit (debounced) shows the bytes the query
  will scan. Above your limit (default 10 GB), Run becomes "Run anyway". Every job also
  sets `maximumBytesBilled`.
- **ClickHouse guard**: previews add `max_result_rows` with `result_overflow_mode=break`,
  and every query sets `max_execution_time`.

### 3.14 Collections: named queries, variables and templates

A **Collection** is a notebook of named queries, like a Postman collection, but for SQL.
Queries are **Jinja templates**. dbui fills in variables and includes, shows you the exact
SQL it will send, and only then runs it.

Collections hold only queries: folders, named queries, and the variables, environments and
scripts those queries use. **Collections and Workflows (§3.15) are separate tabs** in the
left pane (Items · Collections · Workflows · History): a collection is a library of reusable
queries, and a workflow is a pipeline that uses them. The old **Saved** tab is gone: ⌘S in
a plain query tab saves into a collection (§ below), and queries saved before this change
were moved into a **Saved queries** collection once, on first start.

**Structure**
```
Collection "Ad performance"           variables: client_id, start_date, end_date, model
├─ folder "Base"
│   ├─ sales_metrics      (connection: Acme BigQuery)
│   └─ fb_ads
├─ ad_report_daily        {% include "Base/sales_metrics" %} … joins fb_ads
└─ top_ads_by_roas        uses ad_report_daily
```
- **Folders nest to any depth** ("Reports / Weekly / Daily"). A folder's menu makes a
  subfolder; dragging a folder onto another moves it, and dbui refuses to move a folder into
  itself or one of its own subfolders. Each collection and folder row shows how many queries
  it holds and a **+** for a new query right there. An empty collection says "Add a query,
  or save one from History".
- **A query** has a name, SQL template, connection (or "the collection's default"),
  description, and variable defaults.
- **A query can hold several statements** separated by `;`. **Run** (`⌘↵`) runs the
  selection or the statement at the cursor; **Run all** (`⌘⇧↵`) renders the template, splits
  the rendered SQL on `;` outside strings and comments, and runs every statement in order.
  Each gets its own result tab (**Result 1**, **Result 2** …, with the statement's first line
  as a tooltip), and the run stops at the first error, marking the statement that failed.
  The Rendered tab shows all statements, the Parameters panel collects variables across
  them, and the BigQuery dry run estimates each statement and shows the total.
- **A collection** has a default connection, collection variables, and **environments**
  (like Postman): named sets of values, e.g. `dev` → `client_id = 1111…`, `prod-client-A` →
  `client_id = 4c1e…`. A dropdown picks the active one.
- **Storage:** IndexedDB on this machine. Collections export and import as one JSON file, or
  as a folder of `.sql` files plus `collection.yaml`, so they can live in git.
- **Never in exports:** variable values marked **secret** are kept in the SecretStore and
  left out of exports.

**Saving a query: one click from History, or `⌘S`.** Every History row has a **Save**
button (on hover), and `⌘S` in a plain query tab opens the same dialog:
1. the collection and folder default to the last ones used, or to a **Saved queries**
   collection created on the first save; the folder picker shows nested paths and can make a
   new subfolder in place. The name defaults to the first table plus the date (`orders
   2026-10-30`), or the first 40 characters of the SQL. Save is then one click. After `⌘S`
   the tab is bound to the new named query, so the next `⌘S` just saves it. Each save is one
   query; History entries are never merged;
2. optionally, under **Make it reusable…** (collapsed), dbui offers to **turn literals into
   variables**. It finds string, number and date
   literals in the SQL (e.g. `'2026-10-01'`, `'last_touch'`) and lists them with a
   suggested name, so `WHERE localdate >= '2026-10-01'` becomes
   `WHERE localdate >= {{ start_date | sql }}` with the old value as the default;
3. dataset or schema names that look like a tenant (`production__<uuid>`) are offered as a
   variable too, so the same query works for every client.

**Template syntax: Jinja2**, rendered in the browser with a Jinja engine
(`@huggingface/jinja`, pinned), plus a few dbui helpers:

| Syntax | Meaning |
|---|---|
| `{{ start_date }}` | Variable, inserted as is (for identifiers and fragments) |
| `{{ start_date \| sql }}` | Variable as a **SQL literal** in the connection's dialect: quoted and escaped strings, `NULL`, numbers, `DATE '…'` |
| `{{ ids \| sql_list }}` | List → `(1, 2, 3)` / `('a', 'b')` |
| `{{ table \| ident }}` | Quoted identifier (`` `x` `` in BigQuery, `"x"` in Postgres) |
| `{% include "Base/sales_metrics" %}` | Paste another query's rendered SQL (same variables) |
| `{{ ref("ad_report_daily") }}` | Use another query **as a table**: becomes a CTE, a subquery, or a materialised table name (workflows, §3.15) |
| `{% if model %} … {% endif %}`, `{% for … %}` | Normal Jinja control flow |
| `{{ var("days", 7) }}` | Variable with a default |

- **Includes and `ref`** resolve by path within the collection, are rendered recursively,
  and a cycle (`a` includes `b` includes `a`) is an error naming the loop.
- `{{ x }}` without `| sql` is allowed but the editor underlines it in amber when it sits where a
  value belongs (after `=`, `IN`, `>`…), because pasting raw text there is an injection risk.
  For values, the `| sql` filter is the safe default, and the "turn literals into variables"
  step always uses it.

**Detecting parameters.** As you type, dbui parses the template (Jinja AST, including inside
includes) and lists every variable it uses. Before Run:
- A **Parameters** panel shows each one with its value from the active environment, the query
  default, or empty. Types are inferred from the default or name (`*_date` → date picker,
  `*_ids` → list, `limit`/`days` → number), and can be set by hand.
- Missing values block Run and the panel opens. Values you fill in can be kept for the
  session, saved as the query default, or saved to the active environment.
- Plain SQL parameters (`@start_date` in BigQuery, `$1` in Postgres, `?` in SQLite) are
  detected too and get the same panel. Those values are sent as real query parameters, not
  pasted into the text.

**Rendered SQL, always visible.** Next to the template, a **Rendered** tab shows the final SQL
exactly as it will be sent, updated live, with includes expanded and literals inlined. That's
the same text the SQL strip and History record. For BigQuery the dry-run estimate runs on
the rendered SQL. **Copy rendered SQL** is one click.

**Pre-run and post-run scripts (like Postman).** Any named query, folder or collection can
have two optional JavaScript scripts. They run in the script sandbox (§3.15) with a small
`db` object, like Postman's `pm`:

| Script | Runs | Typical uses |
|---|---|---|
| **Pre-run** | After variables are resolved, before rendering | Compute variables (`db.vars.set("end_date", today())`, `start_date = end_date - 7 days`); pick an environment value; check inputs and stop with a message (`db.fail("client_id is required")`) |
| **Post-run** | After the result arrives | Assertions (`db.test("has rows", rowCount > 0)`); pull values out of the result into variables for the next query (`db.vars.set("top_ids", db.result.column("ad_hash"))`); reshape rows for display; summarise |

- **Order**, as in Postman: collection pre → folder pre → query pre → **render and run** →
  query post → folder post → collection post. A script can only see and change variables
  and the result. It can't change the SQL text directly, so the Rendered tab always shows
  exactly what ran.
- **The `db` API:**
  - `db.vars.get/set/unset` and `db.env.get/set` (writing to the environment asks first)
  - `db.result.rows`, `db.result.columns`, `db.result.column(name)` and `db.result.rowCount`
    (post-run only). For a query with several statements, `db.result` is the last
    statement's result and `db.results` is the array of all of them (`[db.result]` otherwise).
    Pre and post scripts run once around the whole query, not per statement
  - `db.test(name, bool)`, `db.fail(msg)`, `db.log(...)`, and date helpers
- **Results:** test results appear in a **Tests** tab next to the results (pass/fail per
  assertion), and `db.log` output in a **Console** tab. A failed pre-run script stops the run.
- **Variables carry over:** variables set in post-run scripts persist for the session, so
  running query A then query B in the same collection works like a two-step flow without
  building a workflow. Workflows reuse the same scripts: a query step runs its pre and post scripts too.

### 3.15 Workflows: multi-step pipelines (dbt-style)

A **Workflow** runs several steps in order, where later steps use earlier steps' output, like a
small dbt project inside dbui.

> Naming note: the code calls workflows **chains** (`src/chains/`, the `Chain` type, the
> `chains` IndexedDB store). The UI always says "workflow".

**Where they live.** Workflows have their own **Workflows** tab in the left pane, next to
Collections, not inside a collection. It's a flat list of every workflow with a filter, **New
workflow**, rename, duplicate and delete. Each row shows the step count, the last run (passed,
failed, stopped or blocked, and when), and small tags for the collection(s) its query steps
use. A workflow opens at `#workflow/<id>` (old `#chain/<id>` links still work).

**Home collection.** Every workflow has one home collection, whose variables, environments and
named queries its steps use. **New workflow** asks for it, defaulting to the only collection
or to a **Workflows** collection created on demand. It shows as a tag, never as nesting. In
the workflow view the header reads **Workflow**, the tag opens that collection's settings, and
**Change…** picks another collection. Deleting a collection keeps its workflows; their view
then asks for a new home.

**Step kinds**

| Kind | What it does | Output |
|---|---|---|
| **Query** | Runs a named query (or inline SQL) on a connection, with workflow variables | A result table |
| **Transform: SQL** | Runs SQL over earlier steps' results **locally in DuckDB-WASM**, e.g. `SELECT … FROM {{ ref("sales") }} JOIN {{ ref("ads") }}` even when `sales` came from BigQuery and `ads` from Postgres | A result table |
| **Transform: script** | Runs a JavaScript function on earlier results, in a sandboxed Web Worker: `(inputs, vars) => rows \| { rows, vars }` | A result table and/or new variables |
| **Set variables** | Picks values out of a result for later steps, e.g. `top_ad_ids = column "ad_hash" of step "top_ads"`, `max_date = max(localdate)` | Variables |
| **Export** | Writes a result to a file (CSV, JSONL, Parquet) through the file picker | A file |
| **Assert** | A check, e.g. "row count > 0" or "no NULL ad_id". Fails the workflow when not met | Pass/fail |

So a **middle step that converts one step's output into the next step's input** is either:
- **Transform: SQL**, for reshaping, joining, filtering or aggregating with SQL. It runs on
  this machine in DuckDB, so it works across different databases and costs nothing on the warehouse;
- **Transform: script**, for logic that's awkward in SQL (parsing JSON, calling a formula,
  building a list);
- **Set variables**, when the next step needs *values* rather than a table (a list of IDs, a
  date). For example, step 1 finds yesterday's top 50 ads in BigQuery, a Set variables step
  turns them into `top_ad_ids`, and step 3 runs `WHERE ad_hash IN {{ top_ad_ids | sql_list }}`
  on Postgres.

**How data flows between steps**
- Each step's result is loaded into the workflow's **local DuckDB** as table `step_<name>`, which
  `{{ ref("name") }}` points at in transforms.
- When a **Query** step refers to an earlier step on the **same warehouse connection**, dbui
  inlines it as a CTE, so BigQuery does the work and nothing is downloaded. Across
  connections, the earlier result is passed as values (`sql_list`, a `VALUES` list, or a
  BigQuery `UNNEST` array parameter), up to a size limit (default 10,000 values). Above
  that, the step must be a local transform.
- **Graph:** steps form a graph from their `ref`s. dbui orders them, runs independent steps
  in parallel, and refuses a cycle.

**Running**
- **Run all**, **Run from here**, or **Run only this step**. Each step shows status,
  row count, time and bytes billed (BigQuery). Click a step to see its rendered SQL and a result preview.
- **Results are cached** per step by rendered SQL plus input hashes, so changing step 4 doesn't
  re-run steps 1–3. Clearing the cache forces a full run.
- **Cost guard:** before Run all, BigQuery steps are dry-run together and the total
  estimate is shown. The run stops if any single step is over the connection's cost guard.
- **Safety:** write statements in a workflow step follow the connection's Read-only and production
  rules. A workflow can't bypass them.
- **Query steps with several statements:** when a step's named query holds several statements
  (§3.14), the earlier ones run first as setup and the **last** statement's result is the
  step's output. Such a step is never inlined as a CTE. The step editor says so.

**Script sandbox.** Script steps run in a dedicated Web Worker with no network (`fetch`,
`XMLHttpRequest` and `importScripts` are removed), no access to extension APIs, secrets or
other tabs, a time limit (default 30 s) and a row limit. They see only their declared inputs
and workflow variables. MV3 forbids `eval`, so scripts run in a sandboxed extension page
(`"sandbox"` in the manifest), which is the supported way to run user code in an extension.

**Not in v1:** schedules, incremental models, writing results back to a warehouse table
(`materialized: table` in dbt terms), and Python steps. Python could come later via Pyodide in
the same sandbox.

### 3.16 Backup: surviving uninstall

Chrome deletes an extension's IndexedDB and `chrome.storage.local` when it is uninstalled (and
used to, for unpacked builds, whenever the folder moved and the ID changed; §5.1). Connections,
collections, workflows and history would be lost with it, so dbui keeps a copy outside Chrome.

**Backup file** (`src/app/store/backup.ts`):

```jsonc
{ "format": "dbui-backup", "version": 1, "exportedAt": 1761700000000,
  "stores": { "connections": […], "history": […], "queries": […], "recentFiles": […], "groups": […],
              "collections": […], "folders": […], "namedQueries": […], "chains": […] },  // every store but "handles"
  "settings": { "previewSettings": {…}, "theme": "dark" } }                            // chrome.storage.local keys dbui owns
```

- **No secrets.** Password, token and key fields are stripped from connection options (refs
  such as `secretRef` and `keySecretRef` stay), secret collection/query/workflow variables lose
  their values, and nothing the SecretStore keeps (`secret:*`) is read. Secrets stay in Keychain
  or are typed again.
- **No file handles.** `FileSystemFileHandle`s can't be serialised, so the `handles` store is
  skipped, and connections and recent files that used one get `needsRepick: true`. A restore
  on the same profile re-attaches handles that are still there.
- **Import** validates `format` and `version` (older, newer, collection exports and broken
  files are refused with a message saying which). **Merge** matches rows by id and keeps the
  newer one by `updatedAt` (else `lastUsedAt` / `openedAt` / `at` / `createdAt`), ties keep the
  local row, and only fills settings that aren't set. **Replace** clears each store first.

**Manual:** Settings → **Backup** → **Export…** (`showSaveFilePicker`, else `chrome.downloads`
with a blob URL) and **Import…** (file picker → summary such as "12 connections, 3 collections,
5 workflows" → **Merge** or **Replace…** with an in-page confirm).

**Automatic, through the runner** (`src/app/store/autoBackup.ts`):

- The db wrapper emits a change event after every `put`/`del`; about 5 s after the last one (or
  a change to a backed-up setting, or when the page is hidden with one pending), the app sends
  `exportAll()` with `backup.write` over a short-lived native port. Writes never wait for it.
  No runner, or a runner without `backup.*` (`UNKNOWN_OP`): it stops trying for that page.
- The runner writes `~/Library/Application Support/dbui/backup.json` atomically (temp file,
  `fsync`, `rename`), keeps the file it replaces as `backup.prev.json`, refuses more than 50 MB,
  and checks that the payload is a `dbui-backup` object. `backup.read` sends the file back in
  UTF-8-safe chunks of ≤ 300 KB, so each message stays under Chrome's 1 MB limit.
- **A fresh profile never overwrites a backup it hasn't seen.** Automatic writes start only once
  this profile is *linked* to the file: it wrote it, restored it, the user pressed **Back up
  now**, or there was no file yet. The link flag is in `chrome.storage.local`, which uninstall
  clears, so a reinstall starts unlinked and its first edits can't destroy the backup it is
  about to be offered. Settings → Backup says when automatic backup is paused for this reason.
- **Restore on a fresh install:** when Home loads with no connections, collections or history
  and the runner has a backup, Home shows **Found a backup from <date>: 12 connections,
  3 collections… Restore?** with **Restore** / **Not now**. Restore imports in replace mode.
  Never silent, never over existing data.
- Settings → Backup shows the last automatic backup time and a **Back up now** button.

---

## 4. UI

### 4.1 Surfaces
The extension is named **Chrome DB Viewer** in Chrome (manifest `name`); the app itself still calls
itself dbui. All work happens in full-page tabs; the only other surface is the toolbar popup.
There's no Chrome side panel.

- **Toolbar icon**: opens a popup (`popup.html`, `src/popup/Popup.tsx`, 380px wide) listing
  the saved connections. They're grouped and sorted like Home's picker, with a search box
  focused on open. Clicking a connection (or pressing Enter) opens it in a new tab
  (`#c_<id>`), records `lastUsedAt` and closes the popup. Its footer has **Open app**, which
  focuses an app tab already on Home or opens a new one, and **New connection**, which does
  the same at `#home/new` so Home starts with the engine picker open. Tabs showing a
  connection or a file are never taken over. Finding the tabs with `tabs.query` on our own
  extension URL needs no `tabs` permission.
- **Home** (`app.html#home`), modelled on TablePlus's welcome window:
  - A search box across the top ("Search for connection…", focused on open, `↑↓` + `Enter` connects).
  - Connections as a compact list: a round two-letter engine badge (`Pg`, `Ch`, `Bq`, `Du`, `Re`, `Sl`),
    name, env tag in its colour (`production` in red), and `host : database` underneath.
    Connections can be put in **groups** (folders) and dragged between them.
  - **+** opens the **new connection picker**: a grid of engine badges with a search box,
    arrow keys to move, `Enter` to pick. The backlog engines (MongoDB, Snowflake) appear greyed
    out with "Coming later". Buttons: Cancel, **Import connection** (paste a URL such as
    `postgres://user@host:5432/db`, or a TablePlus/DBeaver export), **New group**, **Create**.
  - A side column with recent files, **Open file**, runner status and Settings.
- **App tab** (`chrome-extension://…/app.html#c_8f2`): one tab per open connection or file,
  so Chrome's own tab strip acts as the switcher. Inside the page there's an object tree
  on the left (tables, keys, files). That's part of the page layout, not a Chrome side panel,
  and it can be collapsed (`⌘\`) to give the grid the full width.
- Users who want even more room can use Chrome's full screen (`⌃⌘F`). dbui doesn't need its own full-screen mode.
- **Connection sheet**: a form per driver, "Test connection", env tag, color. BigQuery shows
  the auth methods from §3.8; ClickHouse shows URL, user, password and the protocol switch.

### 4.2 Connection tab layout (TablePlus-style, three panes)

```
┌ [≡][⏻]  [🔒][🗄][SQL]  ┃ PRODUCTION │ PostgreSQL 17.9 : shop-prod : shop : public.orders ┃ [⚠][⟳][⌘K]  [▭][◨] ┐
├ [Items│Queries│History]─┬ ‹ › ┃          orders          ┃ ◫ ─────────────────────┬ [Details│Assistant] ─┤
│ 🔍 orde            ⊗ ☰ │ ☑ [status ▾][= ▾][ paid        ] [Apply] [−][+]       │ 🔍 Search for field   │
│ ▸ Functions            │ ☑ [total  ▾][> ▾][ 100         ]         [−][+]       │ id              int8  │
│ ▾ Tables               │ [Export][SQL] Show:⌘F Insert:⌘I Remove:⌘⌫ [Clear][Apply All ▾] │ 10421         │
│   ▸ ▦ orders      ◀sel │ ⟲ │ id    │ customer_id  │ status  │ total  │ …       │ customer_id     int8  │
│   ▸ ▦ order_items      │ 1 │ 10421 │ 4821 →       │ paid    │ 129.00 │         │ 4821  → customers     │
│   ▸ ▦ customers        │ 2 │ 10422 │ 3307 →       │ paid    │  54.50 │         │ status          text  │
│ ▸ Views                │ … │       │              │         │        │         │ paid             ▾    │
│                        │                                                      │ metadata       jsonb  │
│                        │                                                      │ { "source": "web",    │
│                        │                                                      │   "coupon": null }    │
├ [+][▾] [ public    ⇕ ] ┼ [Data│Structure│Index][+]   1 of 200 rows selected  🔍 ⊜  ‹ ☰ › ┴────────────────────┤
└────────────────────────┴───────────────────────────────────────────────────────────────────────────────────┘
```

**Top bar**
- Left: toggle the left pane, open the connection list (Home), read-only lock, switch database, open a SQL query tab.
- Centre: a **status capsule in the env colour** (green for local, blue for dev, amber for staging, red for production).
  It reads `ENV │ Engine version : connection : database : schema.table`. Click it to open connection settings.
- Right: refresh (`⌘R`), command palette (`⌘K`), toggle the bottom panel, toggle the right pane.
  The statement log (every statement dbui ran, with timings) is toggled from a terminal icon at
  the right end of the view's bottom bar. It opens just below that bar as a fixed-height strip
  (132px, scrolls inside), so it never pushes the grid around.

**Left pane**
- Four folding sections stacked down the pane, each header an uppercase label with no chevron.
  One section is open at a time: its header is a full-width accent bar and its body fills the
  remaining height. The folded ones sit below it, divided by hairlines. Clicking the open
  section folds it.
  - **Items**: object tree with search; matched text is highlighted. A filter menu chooses which object types to show.
  - **Collections**: named queries in collections and folders (§3.14).
  - **Workflows**: multi-step pipelines (§3.15).
  - **History**: every statement you ran, searchable, with time, duration and rows, and a **Save** button per row.
- Bottom: **+** (new table, view or query), and a **schema / database picker** (`public ⇕`).

**Centre pane**
- A tab row with **back/forward** (`⌘[` `⌘]`) through tables you've visited, the current table
  name, and a split button that shows two tables side by side.
- **Filter rows**, toggled with `⌘F`. Each row is `☑ [column ▾] [operator ▾] [value]` with `−`/`+`.
  - The checkbox turns that condition on or off without deleting it.
  - The column list starts with **Raw SQL**, for a free `WHERE` expression.
  - Operators: `=`, `≠`, `<`, `>`, `≤`, `≥`, `contains`, `starts with`, `in`, `between`, `is null`, `is not null`.
  - **Apply** runs one condition, **Apply All** (`⌘↵`) runs all of them joined with AND. The `▾` beside it switches to OR.
  - **Clear** removes them all. **SQL** shows the generated query in a query tab.
- A shortcut hint line: `Show: ⌘F  Insert: ⌘I  Remove: ⌘⌫  Apply All: ⌘↵`. **Export** saves the current result as CSV, JSON or SQL.
- **Grid:**
  - row numbers; the selected row is highlighted and the selected cell outlined
  - sticky header; click a header to sort, drag its edge to resize, drag the header to reorder
  - the corner button resets column widths
- **Foreign keys:** cells show a small **→**. Click it to open the referenced row (in the same tab;
  `⌥`-click opens a new tab), and **back** returns.
- Bottom bar:
  - **Data / Structure / Index** tabs, plus **+** for a new query tab
  - "1 of 200 rows selected"
  - quick search in the loaded rows (🔍)
  - row-count options (⊜): page size 200, 500, 1000, or all
  - previous/next page arrows

**Right pane: Details** (toggle `⌘⌥R`)
- Shows the selected row as a vertical form. There's one field per column, with its name and type on
  the right (`uuid`, `jsonb`, `timestamptz`).
- A search box filters the fields, which helps on wide tables.
- Editors fit the type:
  - JSON / `jsonb` is pretty-printed with colours and can be folded
  - `bool` is a TRUE / FALSE / NULL menu
  - enums are a menu of their values
  - timestamps get a date-time picker
  - long text expands
  - foreign keys show **→ table**
- Editing here is the same as editing the cell: the field turns amber and joins the pending ChangeSet.
- With several rows selected, fields that differ show `(multiple values)`. Editing one sets it on all of them.
- **Assistant** tab: asks an LLM to write or explain SQL using this connection's schema. It's **off until
  you add an API key in Settings**, and it never sends row data unless you click "Include selected rows".

**Keys in the grid**

| Action | Keys |
|---|---|
| Edit cell | `Enter` or double-click |
| Insert row / Remove selected rows | `⌘I` / `⌘⌫` |
| Copy selection as TSV / as `INSERT` / as JSON | `⌘C` / `⌘⇧C` / right-click menu |
| Set cell to NULL / to default | right-click menu, or `⌘⇧N` |
| Open foreign key | `⌘→` on the cell |
| Toggle Details pane | `⌘⌥R` |
| Back / forward | `⌘[` / `⌘]` |

### 4.3 File sheet layout
```
┌ orders.csv › status frequency                         CSV · 1.2 GB · 9.4M rows ┐
├────────────────────────────────────────────────────────────────────────────────┤
│ status      count      %      ███████████████████████████                      │
│ paid        6,102,331  64.9%  █████████████████                                │
│ pending     2,011,804  21.4%  ██████                                           │
│ refunded      880,112   9.4%  ██                                               │
├────────────────────────────────────────────────────────────────────────────────┤
│ Enter: filter source · Esc: back · ⌘⇧F: frequency · ⌘I: summary   4 values     │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 4.4 Views for each kind of source
| Kind | Sidebar | Main views |
|---|---|---|
| Relational (pg, sqlite, duckdb) | schemas → tables / views / functions | Data grid + filter bar, Structure (columns, indexes, FKs, DDL), Query editor |
| Key-value (Redis) | db 0–15, keys grouped by `:` prefix | Key list (SCAN, type, TTL, memory) + value editor per type |
| Warehouse (BigQuery, ClickHouse) | projects/databases → datasets → tables, with partition and size info | Query editor (BigQuery: live dry-run estimate), schema view, job/query history with bytes read |
| File | open files and recent files | Sheet stack, column summary, frequency, pivot, SQL over files |

### 4.5 Keyboard map
| Action | Keys |
|---|---|
| Command palette | `⌘K` |
| Open file | `⌘O` |
| Go to Home | `⌘⇧H` |
| Collapse / show the left pane | `⌘\` |
| Show / hide the Details pane | `⌘⌥R` |
| Show / hide the filter rows | `⌘F` |
| Run statement / run all | `⌘↵` / `⌘⇧↵` |
| Stop | `⌘.` |
| Commit / review changes (file sheets: save) | `⌘S` / `⌘⇧P` |
| New / close query tab | `⌥T` / `⌥W` |
| Refresh | `⌘R` (taken inside the app tab) |

---

## 5. Install and distribution

### 5.1 Extension
Chrome Web Store. Also works in Edge, Brave and Arc (same MV3 + native messaging).
Everything except Postgres and Redis works right after installing the extension.

**Stable extension ID.** An unpacked extension's ID normally comes from its folder path, so
moving the repo (or loading `dist/` from somewhere else) gave it a new ID. Chrome then treated it
as a different extension, with empty IndexedDB and storage, and the runner's `allowed_origins`
no longer matched. `public/manifest.json` therefore carries a `key` (the public half of a key
pair), which pins the ID to **`dalbkdjjdgbjhoalobeikhpchkoddnpb`** wherever it is loaded from
and across reloads. Don't change or remove it. Register the dev runner for that ID with
`runner/scripts/dev-install.sh dalbkdjjdgbjhoalobeikhpchkoddnpb`.

**Uninstalling still clears Chrome's storage** for the extension, whatever the ID. That's why
the automatic backup exists (§3.16): with the runner installed, reinstalling offers to restore
from `~/Library/Application Support/dbui/backup.json`.

### 5.2 Runner: one click from the extension
The runner is installed once, per macOS user, with no admin password and no brew.

1. You open a Postgres or Redis connection (or turn on a runner-only feature).
   `connectNative` fails with "Specified native messaging host not found", so the tab
   shows the **Install dbui runner** card.
2. You click **Install runner**. The extension calls `chrome.downloads.download()` for the
   signed `dbui-runner-<version>.pkg`, then `chrome.downloads.open()` when it finishes.
3. macOS Installer opens. The package is **per-user only**, so you click Continue → Install
   and never type an admin password.
4. The card's **Check again** button sends `hello`. From now on Chrome starts the runner on every connect.

What the `.pkg` installs, all inside your home folder:

| File | Path |
|---|---|
| Runner binary | `~/Library/Application Support/dbui/dbui-runner` |
| Uninstall script | `~/Library/Application Support/dbui/uninstall.sh` |
| Automatic backup (written later, §3.16) | `~/Library/Application Support/dbui/backup.json`, `backup.prev.json` |
| Chrome manifest | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dbui.runner.json` |
| Other browsers (if installed) | the same file under `Microsoft Edge/`, `BraveSoftware/Brave-Browser/`, `Arc/User Data/`, `Chromium/` |

```json
{
  "name": "com.dbui.runner",
  "description": "dbui database runner",
  "path": "/Users/<you>/Library/Application Support/dbui/dbui-runner",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<dbui-extension-id>/"]
}
```

- `path` must be absolute, so the package's `postinstall` script writes the manifests with
  the real home path, for each browser folder it finds.
- Package build: `pkgbuild` + `productbuild` with
  `<domains enable_currentUserHome="true" enable_localSystem="false"/>`, signed with a
  Developer ID Installer certificate and notarized. Without notarization Gatekeeper blocks
  the binary and Chrome only reports "Native host has exited."
- **Updates:** the Web Store doesn't update the runner. If `hello` reports an older
  `protocol` than the extension needs, the card changes to **Update runner** and runs the
  same download-and-open flow.
- **Uninstall:** `uninstall.sh`, also linked from the extension's settings page, removes the
  binary, the manifests and dbui's Keychain items.
- **Developer alternative:** `curl -fsSL https://<dbui-site>/install.sh | sh` does the same
  two steps from a terminal.
- **Windows later:** same flow; the manifest location is a registry key under
  `HKEY_CURRENT_USER`, which needs no admin rights.

---

## 6. Repo layout

```
chrome-db-viewer/
  extension/                 TypeScript, Vite, React
    manifest.config.ts
    src/app/                 app.html UI (sidebar, tabs, grid, editor, sheet stack, drawer)
    src/background.ts        preview redirect rules (the toolbar icon opens src/popup/)
    src/core/                driver interface, ChangeSet, dialects, caches, SecretStore
    src/auth/google/         TokenProviders: chromeIdentity, webAuthFlow, serviceAccount, adcFile, impersonate, pasted
    src/drivers/  duckdb/  files/  sqlite/  bigquery/  clickhouse/  runner/
    tests/                   vitest; reads fixture .sqlite, .duckdb, .csv, .jsonl, .parquet files
  runner/                    C++20, CMake, vcpkg
    CMakeLists.txt  vcpkg.json
    src/main.cpp             framing + router
    src/session.cpp          worker thread, job queue, cancel
    src/drivers/  postgres/  redis/  duckdb/  clickhouse/
    src/google_auth.cpp      ADC, workload identity federation, SA keys from Keychain
    src/ssh_tunnel.cpp  src/secret_store_keychain.mm  src/pager.cpp
    src/backup.cpp           backup.write / backup.read: ~/Library/Application Support/dbui/backup.json (§3.16)
    tests/                   Catch2; docker-compose pg/redis/clickhouse
    packaging/macos/         pkgbuild/productbuild scripts, postinstall, uninstall.sh,
                             host manifest template, notarize script
  design/  DESIGN.md  mockup.html
```

---

## 7. Milestones

| # | Scope | Done when |
|---|---|---|
| M0 | MV3 skeleton (Vite + React), full-page app tab with Home, toolbar click opens or focuses it, CSP/COOP/COEP set, CI build | Extension loads unpacked and opens the app tab |
| M1 | Grid + **DuckDB-WASM** + **file sheets** (CSV/JSONL/Parquet open, sort, filter, summary, frequency, sheet stack) | Open a 5 GB CSV and get a frequency table without the tab running out of memory |
| M1b | **Browser preview** (§3.12): settings with per-extension checkboxes + permission request, redirect rule, `?src=` loading with Parquet range reads, download prompt, `file://` support (data files only; images and video are left to Chrome) | Click a `.parquet` link on S3 and see the sheet in about a second; turn the setting off and the same link downloads |
| M2 | **SQLite** and **DuckDB** files, SQL editor (CodeMirror, autocomplete, history), cancel; file sheet editing and save | Query across a `.duckdb` file and two CSVs in one statement |
| M3 | **BigQuery**: Chrome account, web auth flow, service account key, pasted token, impersonation; dry-run cost guard; job history | Same query works signed in three different ways, with the bytes cap enforced |
| M4 | **ClickHouse** over HTTP: streaming, cancel, sidebar, structure | Stream 10M rows from ClickHouse Cloud and cancel mid-query |
| M5 | **dbui-runner**: framing, `hello`, **PostgreSQL**, Keychain, SSH tunnel; per-user `.pkg` + install card | Fresh Mac: click Install runner, connect to pg through a bastion host |
| M6 | ChangeSet editing + review drawer + env tags + read-only mode across drivers | Edit, review and commit rows on pg, SQLite and DuckDB |
| M7 | **Redis** key browser + value editors (runner) | SCAN 1M keys, edit hash/zset values |
| M8 | Runner extras: native DuckDB, ClickHouse native protocol, gcloud ADC, workload identity federation | DuckDB engine "Auto" switches to the runner when it's installed |
| M9 | Export (runner writes files), runner update flow, polish, Web Store listing, OAuth verification | Public beta |
| M10 | **Collections** (§3.14): collections, folders, environments, Jinja templates with `sql`/`ident`/`sql_list` filters, `include`, parameter detection and panel, Rendered tab, History → named query with literal-to-variable, JSON and folder export | Save a History query as a named query with `start_date` turned into a variable, run it in two environments, and see the rendered SQL each time |
| M11 | **Workflows** (§3.15): Query, Transform SQL, Set variables, Export and Assert steps, `ref()` graph, local DuckDB step tables, CTE inlining on the same connection, step cache, combined dry run | A 3-step workflow: BigQuery top ads → Set variables → Postgres lookup by those IDs, re-running only the last step after an edit |
| M12 | **Scripts**: pre-run and post-run scripts on queries, folders and collections (the `db` API, Tests and Console tabs); workflow **Transform: script** steps; all in the sandboxed page. Collection import/export as a git-friendly folder | A post-run script asserts a row count and sets `top_ids`, the next query uses them, and a script step reshapes JSON into rows |

Everything before M5 needs no runner, so the extension is useful from the first release.

---

## 8. Backlog

| Item | Plan |
|---|---|
| **MongoDB** | Runner driver on `mongo-cxx-driver` (or `libmongoc` to save ~15 MB). Document view (JSON or flattened table), filter as a Mongo query, aggregation pipeline editor; edits become `updateOne({_id}, {$set: …})` inside `withTransaction`. The current mockup already shows this view. |
| **Snowflake** | Default: **SQL API v2** (`POST /api/v2/statements`) straight from the extension, like ClickHouse HTTP. Auth with key-pair JWT (signed with WebCrypto) or OAuth; results arrive in partitions that map onto pages. Host permission requested for `https://<account>.snowflakecomputing.com`. A runner driver (ADBC) only if the SQL API proves too limited. |
| Excel files | `.xlsx` sheets through the DuckDB `excel` extension (runner), or a bundled JS parser in the browser |
| Workflow schedules and write-back | Run a workflow on a schedule (needs the runner or the team gateway to run without a tab open); write a step's result to a warehouse table, dbt `materialized: table` style |
| Python steps | Pyodide in the workflow sandbox, for pandas-style transforms |
| Team gateway | Self-hosted server speaking the runner protocol over WebSocket, for shared connections, SSO and audit |
| Vendor HTTP drivers | Neon serverless Postgres, Supabase, Upstash Redis REST: Postgres/Redis without the runner for those vendors |
| Windows / Linux runner | Same code, registry or `~/.config` manifest location |

## 9. Open questions
- Who owns the Apple Developer certificate ($99/year) for signing and notarizing the runner?
- Who owns the Google OAuth client and goes through app verification for the `bigquery` scope?
- File sheets: is ~500 MB the right cut-off between "load into a temp table" and "query the file in place"?
- ClickHouse: should the grid allow updates and deletes through lightweight `UPDATE`/`DELETE`
  on servers that support them, instead of inserts only?
- Browser preview asks for all-sites access. Will the Web Store review accept
  that for an opt-in feature, or should we ask per site the first time a data link is clicked?
