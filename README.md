# Aperium PSQL

A clean, modern PostgreSQL desktop client built with Electron. Combines a real `psql` terminal with a SQL editor, structured query results, and an interactive schema viewer — with tabs for multiple simultaneous connections.

![Aperium PSQL](assets/icon.png)

## Features

### Connections
- **Connection manager** — save and manage multiple PostgreSQL connections
- **Nested groups** — organise connections in collapsible groups (e.g. `cnpg/dev`, `cnpg/preprod`, `cloudsql/prod`)
- **Sidebar search** — filter by name, host, group or database; groups auto-expand on matches
- **Import** connections from a JSON or CSV file (with dedup by `host:port/database@user`)
- **Duplicate** a connection, or **open in a new tab** (`+` button or Cmd+click)

### Tabs
- Each tab owns its own terminal, editor, results panel and `psql` PTY session
- Switch between tabs to work on several databases at once
- Per-tab state: query history, collapsed panels, results

### SQL editor
- **CodeMirror 6** with PostgreSQL syntax highlighting
- **Autocompletion** for keywords, tables and columns (fetched from `information_schema` on connect)
- **Query history** — navigate with `Cmd+Up` / `Cmd+Down` (per tab, up to 100 entries)
- **Auto-refresh** — re-run the current query on an interval

### Query execution
- **Run** (`Cmd+Enter`) — executes via `psql --csv -c` and displays results in a sortable HTML table
- **Send to terminal** (`Cmd+Shift+Enter`) — writes to the interactive PTY (useful for multi-statement or `\g`-suffixed queries)
- **Metacommand routing** — any query containing `\` followed by letters (e.g. `SELECT * FROM foo \gx`) is sent to the terminal automatically
- **Stop** — cancel a running query (SIGTERM on the `psql` process)

### Results
- **Copy** to clipboard as CSV or JSON
- **Export** to a CSV or JSON file via save dialog
- Sortable columns, row count and duration shown

### Terminal
- **Real psql PTY** — full interactive session with `Ctrl+C`, tab completion, `\dt`, `\dn`, `\d+` and all metacommands
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
- Stored in an editable JSON file — "Edit snippets file…" opens it in the default editor, "Reload snippets" refreshes

### UI
- **Collapsible panels** — editor, results and terminal panels collapse via arrow buttons; the last expanded panel takes the remaining space
- **Catppuccin Mocha** theme throughout

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Enter` | Run query (results in table) |
| `Cmd+Shift+Enter` | Send to psql terminal |
| `Cmd+Up` / `Cmd+Down` | Navigate query history |
| `Tab` | Accept autocompletion suggestion |
| `Ctrl+C` (in terminal) | Cancel running query in PTY |
| `Cmd+click` on a connection | Open in a new tab |
| `Esc` | Close dialog |

## Install

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- `psql` (PostgreSQL client) installed and available — resolved via PATH, with fallbacks to `/opt/homebrew/bin/psql`, `/usr/local/bin/psql`, `/usr/bin/psql`
- Python `setuptools` (`pip3 install setuptools`) — required for node-gyp when building `node-pty`

### From source

```bash
git clone https://github.com/advdf/aperium-psql.git
cd aperium-psql
npm install
npx @electron/rebuild
npm start
```

### Package as macOS app

```bash
npm run package
# Output: ./Aperium PSQL-darwin-arm64/Aperium PSQL.app
# Copy to Applications:
cp -r "Aperium PSQL-darwin-arm64/Aperium PSQL.app" /Applications/
```

## Architecture

```
main.js          Electron main process: window, IPC, PTY management,
                 query execution (spawn psql), connections/snippets JSON store,
                 import/export file dialogs, file logging
preload.js       Context bridge — exposes window.api (IPC wrappers)
src/
  index.html     Layout: sidebar + tab bar + editor + results + terminal + ERD overlay
  renderer.js    UI logic: tabs (Map<tabId, tabState>), connections, terminal,
                 results, schema fetching, ERD viewer, snippets, search, panel collapse
  editor.js      CodeMirror 6 setup: PostgreSQL dialect, autocompletion, Catppuccin
                 theme, keymaps (with Prec.highest so Cmd+Enter wins)
  styles.css     Catppuccin Mocha theme
assets/
  icon.icns      macOS app icon (boar + database, 8-bit alpha)
  icon.png       Icon (PNG)
```

### Data directories

- **Connections**: `~/Library/Application Support/Aperium PSQL/connections.json`
- **Snippets**: `~/Library/Application Support/Aperium PSQL/snippets.json`
- **Debug log**: `~/Library/Application Support/Aperium PSQL/aperium.log`

> ⚠️ Connection passwords are stored in plain text, protected only by filesystem permissions. Exports (CSV/JSON) include passwords when the source connection has one.

## How it works

- **Run** spawns `psql --csv --no-psqlrc -c "…"` and parses the CSV output into an HTML table
- **Send to terminal** writes directly to the interactive `psql` PTY session (via `node-pty`)
- **Metacommand detection**: queries containing `\` followed by letters are routed to the terminal — this lets `\dt`, `\dn`, `\d+`, and also `SELECT … \gx` work correctly
- Schema (tables + columns across all schemas including `pg_catalog`) is fetched on connection for autocompletion
- Each tab keeps its own PTY; switching tabs moves the xterm element into view and restores editor/results/collapse state

## License

MIT
