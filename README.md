# Aperium PSQL

A clean, modern PostgreSQL desktop client built with Electron. Combines a real `psql` terminal with a SQL editor and structured query results.

![Aperium PSQL](assets/icon.png)

## Features

- **Real psql terminal** — full PTY with Ctrl+C, tab completion, `\dt`, `\dn`, `\d+` and all psql metacommands
- **SQL editor** — CodeMirror 6 with PostgreSQL syntax highlighting, autocompletion (keywords, tables, columns)
- **Structured results** — query results displayed in a sortable HTML table
- **Copy results** — export as CSV or JSON with one click
- **Database selector** — switch databases on the fly without reconnecting manually
- **Connection manager** — save and manage multiple PostgreSQL connections
- **Catppuccin Mocha** theme throughout

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Enter` | Run query (results in table) |
| `Cmd+Shift+Enter` | Send to psql terminal |
| `Tab` | Accept autocompletion suggestion |
| `Ctrl+C` | Cancel running query in terminal |

## Install

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- `psql` (PostgreSQL client) installed and available
- Python `setuptools` (`pip3 install setuptools`)

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
main.js          Electron main process (PTY, IPC, connections store)
preload.js       Context bridge (window.api)
src/
  index.html     App layout
  renderer.js    UI logic (connections, terminal, results)
  editor.js      CodeMirror SQL editor setup
  styles.css     Catppuccin Mocha theme
assets/
  icon.icns      macOS app icon
  icon.png       Icon (PNG)
```

## How it works

- **Run** executes queries via a one-shot `psql --csv -c "..."` and parses the CSV output into an HTML table
- **Send to terminal** writes directly to the interactive psql PTY session
- Metacommands (`\dt`, `\dn`, etc.) are automatically routed to the terminal
- Schema (tables + columns) is fetched on connection for autocompletion

## License

MIT
