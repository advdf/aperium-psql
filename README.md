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
- **SSH tunnel (multi-hop)** — connect through an arbitrary chain of bastions (1, 2, 3+ hops). Each hop authenticates with a private key (PEM / OpenSSH), optionally passphrase-protected. Implemented as local port forwarding: the server opens the SSH chain, binds `127.0.0.1:<ephemeral>` as the tunnel exit, and `psql` connects to that — so `PGPASSWORD`, CSV parsing, PTY prompt and SIGTERM cancellation all behave exactly as for a direct connection.

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

### Connecting to PostgreSQL on the host

From inside the container, the host is reachable at:

- **Docker Desktop (macOS/Windows WSL2)**: `host.docker.internal`
- **Linux**: add `extra_hosts: ["host.docker.internal:host-gateway"]` to the `aperium` service in `docker-compose.yml`, or point the connection at the host's LAN IP.

### Test bastion (SSH tunnel)

The provided `docker-compose.yml` ships a three-service stack — `aperium`, a seeded `postgres:16`, and a `linuxserver/openssh-server` **bastion** — on two networks: `postgres` sits on `internal` only, so Aperium can't reach it directly and **must** go through the bastion. A fresh clone needs a test key:

```bash
ssh-keygen -t ed25519 -f scripts/bastion_key -N '' -C 'aperium-bastion-test'
docker compose up -d
```

Then in the UI, create a connection:

| Field | Value |
|---|---|
| Host | `postgres` |
| Port | `5432` |
| User | `aperium` |
| Password | `aperium` |
| Database | `aperium` |
| **Use SSH tunnel** | ✅ |
| **Hop 1** | host `bastion`, port `2222`, user `jump`, private key = contents of `scripts/bastion_key`, no passphrase |

Add more hops (Hop 2 → bastion again, etc.) to exercise the multi-hop path. Keys and passphrases are stored in `./data/connections.json` **in plain text**, same contract as the Postgres password.

To skip the tunnel entirely (direct connection), put `postgres` on the `public` network instead and expose `5432` as needed.

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

- `connections.json`
- `snippets.json`
- `aperium.log` — server debug log

> ⚠️ Connection passwords are stored in plain text, protected only by filesystem (and volume) permissions. Exports (CSV/JSON) include passwords when the source connection has one.

## How it works

- **Run** → `POST /api/query` → server spawns `psql --csv --no-psqlrc -c "…"` → CSV parsed into a `{columns, rows}` JSON response → rendered as an HTML table
- **Send to terminal** → writes directly to the interactive `psql` PTY session on the server (via `node-pty`), streamed to xterm in the browser over WebSocket
- **Metacommand detection**: queries containing `\` followed by letters are routed to the terminal — this lets `\dt`, `\dn`, `\d+`, and also `SELECT … \gx` work correctly
- Schema (tables + columns across all schemas including `pg_catalog`) is fetched on connection for autocompletion
- Each tab keeps its own PTY WebSocket; switching tabs moves the xterm element into view and restores editor/results/collapse state

## License

MIT
