# Changelog

## Unreleased — Web app pivot + SSH tunnels

This release replaces the Electron desktop app with a Node + browser web app
served from Docker, adds a responsive layout (Firefox / Chrome on desktop,
tablet and mobile), and supports connecting to databases through arbitrary
chains of SSH bastions.

### Electron → web app

- **Server** (`server/index.js`): Express + `ws` on a single HTTP server.
  Ports the Electron IPC handlers to REST + WebSocket:
  - `GET/PUT /api/connections`
  - `GET/PUT /api/snippets`
  - `POST /api/query` (spawns `psql --csv --no-psqlrc -c …`, parses CSV)
  - `DELETE /api/query/:id` (SIGTERM on the tracked child)
  - `WS /ws/pty?tabId=…` — binary-framed PTY stream powered by `node-pty`
- **Client shim** (`src/api.js`): reimplements `window.api` on top of `fetch`
  and `WebSocket` with the **exact same contract** the old Electron preload
  exposed, so `src/renderer.js` (~2350 LoC) and `src/editor.js` are untouched.
  One WebSocket per tab; binary frames feed directly into xterm as
  `Uint8Array`.
- **Dockerfile** (multi-stage, `node:20-bookworm-slim`):
  - Stage `build` installs deps (`python3 make g++` for `node-pty`) and
    bundles the renderer with esbuild.
  - Runtime stage copies everything and installs `postgresql-client` + `tini`.
  - No Electron, no asar unpacking, no per-architecture packaging.
- **Dropped**: `electron`, `@electron/packager`, `@electron/rebuild`, the
  macOS `titleBarStyle: 'hiddenInset'` traffic-light offset, `main.js`,
  `preload.js`, `assets/icon.icns`, and all `npm run package*` scripts.

### Responsive layout (Firefox + Chrome)

- **Tablet (≤ 900 px)**: narrower sidebar (200 px), toolbars (editor +
  results) wrap so buttons don't spill off-screen.
- **Mobile (≤ 640 px)**: sidebar becomes a `80vw` drawer that slides in from
  the left, with a backdrop that dismisses on tap. A hamburger button sits
  flush in the top-left corner at the same height as the tab bar (44 × 34 px,
  `bg-overlay`, with a right + bottom border so it visually belongs to the
  bar). Mouse-only resize handles are hidden, the connection dialog goes
  near-fullscreen, the snippets menu anchors to the left to stay on-screen,
  and the auto-refresh control is hidden.
- A tiny inline script in `src/index.html` (~15 lines) handles the toggle,
  auto-closes the drawer when a connection is picked, and resets the state
  if the viewport grows past the mobile breakpoint.

### SSH tunnels (multi-hop) for database connections

Connections can now dial through an arbitrary chain of SSH bastions (1, 2,
3+ hops) before opening the Postgres session. psql itself still runs **in
the Aperium container**, so `PGPASSWORD`, CSV parsing, the PTY prompt and
SIGTERM cancellation all behave exactly as for a direct connection.

- **`server/ssh-tunnel.js`** (new): single exported function
  `openTunnelChain({ hops, dbHost, dbPort })`. Uses the `ssh2` library — pure
  JavaScript, no native compile. For each hop it opens a `Client`, awaits
  `ready`, and either forwards to the next hop's SSH port (riding on the
  previous hop's `forwardOut` stream via the `sock:` option) or, for the
  last hop, spins up a `net.createServer` bound to `127.0.0.1:0` that pipes
  every accepted socket through a `forwardOut` to `dbHost:dbPort`. Returns
  `{ localHost, localPort, close() }`; `close()` tears everything down in
  reverse order.
- **Two call-sites wrapped** in `server/index.js`:
  - `POST /api/query` awaits `maybeOpenTunnel(connection)` before spawning
    psql, rewrites `host:port` to the tunnel's local bind, and closes the
    tunnel in the same `respond()` helper that sends the HTTP response.
  - The WebSocket `spawn` handler does the same for the PTY, closing the
    tunnel on `shell.onExit`, an explicit `kill` message, or the WS
    closing.
- **Auth**: private key (PEM or OpenSSH), optionally passphrase-protected.
  No SSH password auth, no agent forwarding (v1 scope).
- **Timeouts**: `readyTimeout: 15_000 ms`, `keepaliveInterval: 10_000 ms` on
  every hop so idle PTY sessions aren't killed by NAT gateways.
- **Error reporting**: failures are prefixed with `hop N (host):` so the user
  knows which link of the chain failed.

#### Bastion library (reusable hops across connections)

Hops are **references**, not inline duplicates. This matters as soon as you
have 10 prod DBs behind the same bastion.

- **Store**: `${APERIUM_DATA_DIR}/bastions.json`, same plain-text contract as
  `connections.json`. Each bastion is `{id, name, host, port, user,
  privateKey, passphrase}`.
- **API**: `GET /api/bastions`, `PUT /api/bastions` (full array replace).
- **Resolution**: `resolveHops()` in `server/index.js` maps `{bastionId}`
  hops to full hop objects before calling `openTunnelChain`. Missing refs
  produce a clear `hop N: bastion <id> not found` error.
- **UI**:
  - Connection dialog: each hop row is a dropdown of saved bastions. A
    "Manage bastions…" button opens a dedicated `<dialog>` for CRUD (name,
    host, port, user, private key textarea, passphrase). Save writes the
    full list back via `PUT /api/bastions` and refreshes every open hop
    picker.
  - A yellow "migrate to library" banner appears on legacy inline hops,
    with a one-click **Save to library** action that creates a bastion
    from the inline fields and switches the hop to a reference.
  - An inline warning reminds users that the DB `host/port` in the
    connection form is the DB address **as seen from the last bastion**,
    not from their browser.

### Test infrastructure in `docker-compose.yml`

The provided compose file now ships a realistic three-service stack that
proves the tunnel works end-to-end:

- `aperium` — the web app, on network `public` only.
- `postgres:16` (service `postgres`) — on network `internal` only. Aperium
  cannot reach it directly; the only bridge is the bastion. Seeded with a
  `shop` schema (customers, products, orders, order_items) via
  `scripts/init-postgres.sql`.
- `bastion` (`lscr.io/linuxserver/openssh-server`) — on both networks.
  Public key auth only (no passwords). A `scripts/bastion-init/` script is
  mounted into `/custom-cont-init.d/` to flip `AllowTcpForwarding` from the
  image's default `no` to `yes` — without that, `forwardOut` opens a
  channel that immediately closes and psql reports `server closed the
  connection unexpectedly`.
- `scripts/bastion_key` / `.pub` — generated with
  `ssh-keygen -t ed25519 -f scripts/bastion_key -N ''`, both `.gitignore`d.

### Other

- `ssh2` added to `dependencies` (pure JS).
- `package-lock.json` removed — the stale Electron-era lockfile would
  otherwise bloat installs; regenerated on next `npm install`.
- `CLAUDE.md` updated to describe the server/client split, the
  `/ws/pty` protocol, the `connection.tunnel` shape, and the new
  `server/ssh-tunnel.js` module.
- `README.md` rewritten around the web-app deployment flow, with a
  dedicated section walking through the bastion test stack.

### Verified end-to-end

- `docker compose up -d --build` boots the three services on a fresh clone.
- `POST /api/query` with `tunnel.hops: [{ bastionId: "…" }]` returns
  structured rows from postgres through the bastion.
- Same payload with the hop referenced **twice** (exercising the chain
  code) also returns rows — multi-hop works.
- Saving a bastion via `PUT /api/bastions` and referencing it by id in a
  subsequent query round-trips correctly.
- Network isolation is real: direct `psql -h postgres` from inside
  `aperium-psql` fails with `could not translate host name` — the only
  way in is the tunnel.
