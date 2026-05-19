# Aperium PSQL

A clean, modern PostgreSQL client served as a **web app**. Combines a real `psql` terminal with a SQL editor, structured query results, and an interactive schema viewer — with tabs for multiple simultaneous connections. Runs in Docker; access the UI from Firefox or Chrome.

![Aperium PSQL](assets/icon.png)

## Features

### Connections
- **Connection manager** — save and manage multiple PostgreSQL connections
- **Nested groups** — organise connections in collapsible groups (e.g. `cnpg/dev`, `cnpg/preprod`, `cloudsql/prod`)
- **Sidebar search** — filter by name, host, group or database; groups auto-expand on matches
- **Import** connections from a JSON or CSV file (with dedup by `host:port/database@user`)
- **Duplicate** a connection, or **open in a new tab** (`+` button or Cmd/Ctrl+click)
- **SSH tunnel (multi-hop)** — connect through an arbitrary chain of bastions (1, 2, 3+ hops). Each hop authenticates with a private key (PEM / OpenSSH), optionally passphrase-protected. The **key content never touches Aperium's config** — bastions store only the key's *path inside the container*, and the operator mounts the actual key file as a Docker volume (e.g. `-v ~/.ssh:/keys:ro`). Implemented as local port forwarding: the server opens the SSH chain, binds `127.0.0.1:<ephemeral>` as the tunnel exit, and `psql` connects to that — so `PGPASSWORD`, CSV parsing, PTY prompt and SIGTERM cancellation all behave exactly as for a direct connection.
- **Peer mode** — alternative to TCP for the psql connection: when the final SSH hop is also the PostgreSQL host, run `psql` directly on that hop over its Unix socket, relying on PostgreSQL's `peer` authentication. No TCP forwarding, no password stored. Orthogonal to *Open shell* (shell mode wins if both are set). Per connection you choose the target hop, the OS user that will own the psql process, and whether to `sudo -niu <user>` before running. Same query runner, test-connection and interactive PTY behaviour as TCP mode. See [Peer mode prerequisites](#peer-mode-prerequisites) for the server-side setup.
- **Backup & restore** — export every connection and bastion as a single JSON or YAML file, re-import anywhere. The export contains only KMS *references* to the underlying secrets (Postgres passwords, SSH passphrases) — never the plaintext. The file is safe to version-control or share, but is **useless without access to the same KMS** that produced it.
- **Deep-link** — open a specific connection straight from a URL: `http://localhost:8080/?open=<id-or-name>`. The lookup tries `id` (UUID) first, then exact `name`. Lets external tools (monitoring dashboards à la Nagstamon/Excubitor, bookmarks, OS launchers) jump directly to a connection without going through the sidebar. The `open` parameter is consumed and stripped from the URL so a reload doesn't re-open the tab. Example custom action: `xdg-open "http://aperium.lan:8080/?open=$(printf '%s' "$name" | jq -sRr @uri)"`.

### Tabs
- Each tab owns its own terminal, editor, results panel and `psql` PTY session
- Switch between tabs to work on several databases at once
- Per-tab state: query history, collapsed panels, results

### SQL editor
- **CodeMirror 6** with PostgreSQL syntax highlighting
- **Autocompletion** for keywords, tables and columns (fetched from `information_schema` on connect)
- **Query history** — navigate with `Mod+Up` / `Mod+Down` (per tab, up to 100 entries)
- **Auto-refresh** — re-run the current query on an interval

### Query execution
- **Run** (`Mod+Enter`) — executes via `psql --csv -c` and displays results in a sortable HTML table
- **Send to terminal** (`Mod+Shift+Enter`) — writes to the interactive PTY (useful for multi-statement or `\g`-suffixed queries)
- **Metacommand routing** — any query containing `\` followed by letters (e.g. `SELECT * FROM foo \gx`) is sent to the terminal automatically
- **Stop** — cancel a running query (SIGTERM on the server-side `psql` process)

### Results
- **Copy** to clipboard as CSV or JSON
- **Export** as a CSV or JSON file (triggers a browser download)
- Sortable columns, row count and duration shown

### Terminal
- **Real psql PTY** — `node-pty` on the server, xterm.js in the browser, over a WebSocket. Full interactive session with `Ctrl+C`, tab completion, `\dt`, `\dn`, `\d+` and all metacommands
- Pager disabled (`PAGER=cat`) so output flows freely
- Terminal is read-only except for `Ctrl+C` — all input goes through the SQL editor

### Schema viewer (ERD)
- Interactive force-directed database diagram (click **Schema**)
- Tables grouped by schema with background zones and a navigation bar
- Draggable tables, pan (drag background), zoom (scroll wheel, cursor-centered)
- PK columns highlighted, FK columns tooltip the referenced table
- FK edges highlight on hover; spread / compact / reset-view controls

### Snippets
- Pre-loaded investigation queries (locks, blocking, index health, table stats, connections, replication, cache)
- Stored in an editable JSON file — "Edit snippets file…" opens an in-app JSON editor; "Reload snippets" refreshes

### UI
- **Collapsible panels** — editor, results and terminal panels collapse via arrow buttons; the last expanded panel takes the remaining space
- **Catppuccin Mocha** theme throughout

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Enter` | Run query (results in table) |
| `Mod+Shift+Enter` | Send to psql terminal |
| `Mod+Up` / `Mod+Down` | Navigate query history |
| `Tab` | Accept autocompletion suggestion |
| `Ctrl+C` (in terminal) | Cancel running query in PTY |
| `Mod+click` on a connection | Open in a new tab |
| `Esc` | Close dialog |

`Mod` = Cmd on macOS, Ctrl elsewhere.

## Run with Docker

The fastest path — no local Node, Electron or `psql` install required.

```bash
docker compose up -d
```

Then open <http://localhost:8080> in **Firefox** or **Chrome**.

`docker compose down` to stop. Data (saved connections, snippets, debug log) lives in `./data` on the host.

### Prebuilt image (GHCR)

Every push to `main` publishes the image to the GitHub Container Registry:

```bash
docker pull ghcr.io/advdf/aperium-psql:latest
```

Tags:
- `latest` — head of `main`
- `sha-<shortsha>` — specific commit, useful for pinning

To use the prebuilt image with the provided compose stack, replace the
`build: .` line under the `aperium` service in `docker-compose.yml` with
`image: ghcr.io/advdf/aperium-psql:latest` (and drop the `build:` key).

### Connecting to PostgreSQL on the host

From inside the container, the host is reachable at:

- **Docker Desktop (macOS/Windows WSL2)**: `host.docker.internal`
- **Linux**: add `extra_hosts: ["host.docker.internal:host-gateway"]` to the `aperium` service in `docker-compose.yml`, or point the connection at the host's LAN IP.

### Mounting SSH keys (and reusing them across hops)

Aperium references private keys by **path inside the container**, so the key
file itself is never stored in `bastions.json` or included in backups. The
default compose file mounts `./keys` read-only at `/keys`:

```yaml
    volumes:
      - ./keys:/keys:ro
```

Drop each SSH key into `./keys/` on the host, give it a stable name, and
reference it from *Manage bastions…* — the **Private key** field is a
dropdown populated from the live directory listing (public-key `.pub`
files and dotfiles are filtered out). The path you pick is what
`bastions.json` stores; the key content itself never leaves the mounted
volume.

**Tip for multi-hop (`ProxyJump`) setups.** A key is a file, not a bastion,
so a single file can be shared by any number of bastions in the chain.
For example, a typical two-identity jump (your personal key for the outer
infra, a shared-account key for the inner infra):

```
./keys/
├── robin_id_rsa        # your laptop's ~/.ssh/id_rsa
└── support_id_rsa      # shared-account key recovered from the bastion
```

Bastions then reference the same file wherever the same user/identity is
reused:

| Bastion | Host | User | Private key |
|---|---|---|---|
| `dalibo-rp3`     | `online-rp3.dalibo.net`       | `robin`  | `/keys/robin_id_rsa`  |
| `chabichou`      | `chabichou.client.dalibo.net` | `robin`  | `/keys/robin_id_rsa`  |
| `ensam-jumphost` | `193.48.193.58`               | `dalibo` | `/keys/support_id_rsa`|
| `ensam-pgsql-1`  | `10.209.8.146`                | `dalibo` | `/keys/support_id_rsa`|

A connection's tunnel then composes these by id — `hops: [dalibo-rp3,
chabichou, ensam-jumphost, ensam-pgsql-1]` — and the server reads each
key fresh at tunnel-open time. Rotating the key is one `cp` on the host,
no edits to connections or backups.

Missing-key situations surface as clear errors:
`SSH tunnel: hop 2 (10.209.8.146): private key file not found:
/keys/support_id_rsa`. Permissions errors are reported the same way
(`EACCES`).

Override the keys dir with `APERIUM_KEYS_DIR=/somewhere/else` if you
prefer a different mount point.

### Test bastion (SSH tunnel)

The provided `docker-compose.yml` ships a three-service stack — `aperium`, a seeded `postgres:16`, and a `linuxserver/openssh-server` **bastion** — on two networks: `postgres` sits on `internal` only, so Aperium can't reach it directly and **must** go through the bastion. A fresh clone needs a test key:

```bash
ssh-keygen -t ed25519 -f scripts/bastion_key -N '' -C 'aperium-bastion-test'
# Expose the private key to the aperium container via the keys volume
mkdir -p keys && cp scripts/bastion_key keys/bastion_test_key
docker compose up -d
```

Then in the UI, open *Manage bastions…* and create one:

| Field | Value |
|---|---|
| Name | `test-bastion` |
| Host | `bastion` |
| Port | `2222` |
| User | `jump` |
| Private key path | `/keys/bastion_test_key` |

Then create a connection:

| Field | Value |
|---|---|
| Host | `postgres` |
| Port | `5432` |
| User | `aperium` |
| Password | `aperium` |
| Database | `aperium` |
| **Use SSH tunnel** | ✅ |
| **Hop 1** | `test-bastion` (from the dropdown) |

Add more hops referencing the same bastion (or new ones) to exercise the multi-hop path.

> Postgres passwords (and SSH passphrases) are stored as **opaque references** to an external KMS — see [docs/kms.md](docs/kms.md). The compose stack ships a dev-mode OpenBao sidecar so this works out of the box.

To skip the tunnel entirely (direct connection), put `postgres` on the `public` network instead and expose `5432` as needed.

### Peer mode prerequisites

Peer mode skips the TCP forwarder and runs `psql` directly on the final SSH hop, authenticating to PostgreSQL via the local Unix socket (`peer` auth — OS user identity is the PG role identity). It only makes sense when **the last bastion in the chain is also the PostgreSQL host**.

In the connection dialog, switch the *psql connection* radio from **TCP** to **Peer** and fill the *Peer target* fields (the *Open shell* checkbox is independent — leave it off to run psql, tick it to override with a plain SSH shell):

| Field | Notes |
|---|---|
| Run psql on | The hop where `psql` will execute. Defaults to the last hop, which is the typical case. |
| OS user (peer) | The OS user that will own the `psql` process. Defaults to `postgres`. Must satisfy `^[a-zA-Z_][a-zA-Z0-9_-]*$` (POSIX safe). |
| Use `sudo -niu <OS user>` | Tick this if the SSH user (e.g. `dalibo`) differs from the OS user that the PG role maps to (e.g. `postgres`). `sudo` is invoked non-interactively (`-n`) — it fails immediately if no NOPASSWD entry exists, rather than hanging on a password prompt. |

Host / Port / Password / SSL Mode are ignored in peer mode. Database and User (the PG role passed to `psql -U`) still apply.

**DBA actions required on the database host** (these are NOT automated by Aperium):

1. `psql` must be installed and on `$PATH` for the OS user that will run it.
2. If `peerOsUser` differs from the SSH user and you keep `peerSudo` ticked, add an entry like the following to `/etc/sudoers.d/aperium-peer`:

   ```
   dalibo ALL=(postgres) NOPASSWD: /usr/bin/psql
   ```

   Adjust `dalibo` (SSH user), `postgres` (target OS user) and `/usr/bin/psql` (binary path) to match your host. `visudo -cf /etc/sudoers.d/aperium-peer` to validate before saving.
3. If you'd rather connect as the SSH user directly (no `sudo`), a matching PostgreSQL role must exist (`CREATE ROLE dalibo LOGIN;`) and, if its name differs from the OS user, a `pg_ident.conf` mapping plus a `peer` line in `pg_hba.conf` referencing that map.

Cancellation works the same as TCP mode (the **Stop** button closes the SSH exec channel, which kills the remote `psql`). Errors from `sudo`, missing `psql`, or `peer` rejection are surfaced inline in the editor / terminal.

### Backup & restore

The sidebar's ⇵ button opens the backup dialog:

- **Download JSON / Download YAML** — dumps every connection and bastion as
  a single file. Bastions only carry their key *path*, so the backup is safe
  to version-control (Postgres passwords still travel inside; redact if you
  plan to commit).
- **Choose file…** — imports a backup; items with an existing `id` are
  overwritten, new ones are added, existing items absent from the file are
  kept untouched.

The backup format is stable (`version: 1` header). A minimal example:

```yaml
version: 1
exportedAt: "2026-04-22T12:34:56Z"
connections:
  - id: 4f0e...
    name: Prod DB
    host: postgres.internal
    port: "5432"
    user: reader
    passwordRef: "openbao:connections/<userId>/<connId>/<uuid>"
    database: app
    sslmode: ""
    tunnel:
      enabled: true
      hops:
        - bastionId: b-prod
bastions:
  - id: b-prod
    name: Prod bastion
    host: bastion.example.com
    port: "22"
    user: jump
    privateKeyPath: /keys/prod-bastion_id_rsa
    passphraseRef: "openbao:bastions/<userId>/b-prod/passphrase/<uuid>"
```

### Remote deployment

The server binds `0.0.0.0:8080` inside the container; `docker-compose.yml` maps it to the host's `8080`. There is **no built-in auth** — put it behind a reverse proxy with TLS and auth (nginx, Caddy, Traefik, oauth2-proxy, Tailscale…) before exposing it publicly. For single-user local use, bind to `127.0.0.1` instead:

```yaml
    ports:
      - "127.0.0.1:8080:8080"
```

## Run without Docker (development)

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- `psql` in `PATH` (`apt install postgresql-client` on Debian/Ubuntu, `brew install libpq` on macOS)
- Build tools for `node-pty` native compilation: `python3`, `make`, `g++`

### From source

```bash
git clone https://github.com/advdf/aperium-psql.git
cd aperium-psql
npm install
npm start    # runs the esbuild bundle + the Node server on http://localhost:8080
```

`APERIUM_DATA_DIR` (default `./data`) controls where `connections.json`, `snippets.json` and `aperium.log` are written. `PORT` (default `8080`) controls the listen port.

## Architecture

```
server/
  index.js       Express + ws server. Serves the static bundle and handles:
                 - GET/PUT /api/connections, /api/snippets
                 - POST   /api/query          (spawns psql --csv, parses CSV)
                 - DELETE /api/query/:id      (SIGTERM on tracked child process)
                 - WS     /ws/pty?tabId=…     (node-pty session per tab)
src/
  index.html     Layout: sidebar + tab bar + editor + results + terminal + ERD overlay
  api.js         Client-side replacement for the old Electron preload bridge.
                 Exposes window.api over fetch + WebSocket with the same contract.
  renderer.js    UI logic: tabs (Map<tabId, tabState>), connections, terminal,
                 results, schema fetching, ERD viewer, snippets, search, panel collapse
  editor.js      CodeMirror 6 setup: PostgreSQL dialect, autocompletion, Catppuccin
                 theme, keymaps (with Prec.highest so Mod+Enter wins)
  styles.css     Catppuccin Mocha theme
assets/icon.png  Favicon + schema image
Dockerfile       Multi-stage: build (compile node-pty + bundle renderer) → runtime
                 (node + postgresql-client)
docker-compose.yml
```

### Data directory

Default host path when using the provided compose file: `./data/`.

- `<userId>/connections.json` — connection records with `passwordRef`
- `<userId>/bastions.json` — bastion records with `passphraseRef` / `privateKeyRef`
- `<userId>/snippets.json`
- `aperium.log` — server debug log

> All sensitive values live in the configured KMS (OpenBao) — never on disk. See [docs/kms.md](docs/kms.md). The default `docker-compose.yml` runs an OpenBao dev sidecar so the install works without any extra setup; production deployments should swap it for a real KMS.

## How it works

- **Run** → `POST /api/query` → server spawns `psql --csv --no-psqlrc -c "…"` → CSV parsed into a `{columns, rows}` JSON response → rendered as an HTML table
- **Send to terminal** → writes directly to the interactive `psql` PTY session on the server (via `node-pty`), streamed to xterm in the browser over WebSocket
- **Metacommand detection**: queries containing `\` followed by letters are routed to the terminal — this lets `\dt`, `\dn`, `\d+`, and also `SELECT … \gx` work correctly
- Schema (tables + columns across all schemas including `pg_catalog`) is fetched on connection for autocompletion
- Each tab keeps its own PTY WebSocket; switching tabs moves the xterm element into view and restores editor/results/collapse state

## License

MIT
