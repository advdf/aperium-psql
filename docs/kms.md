# KMS integration (OpenBao)

Aperium does not store sensitive values on disk or in environment
variables. Postgres passwords, SSH bastion passphrases, inline private
keys, the session secret, and the app DB password all live in an open-
source KMS (OpenBao) and are resolved on-demand by the server.

This page covers:

1. [What gets stored where](#1-what-gets-stored-where)
2. [Dev sidecar (the shipped compose)](#2-dev-sidecar-the-shipped-compose)
3. [Production setup](#3-production-setup)
4. [Migrating an existing install](#4-migrating-an-existing-install)
5. [Operating: rotation, backup, recovery](#5-operating-rotation-backup-recovery)

---

## 1. What gets stored where

After the migration:

- `data/<userId>/connections.json` carries `passwordRef` per connection,
  never `password`.
- `data/<userId>/bastions.json` carries `passphraseRef` and
  `privateKeyRef`. The actual SSH key content lives in the KMS too —
  `privateKeyPath` is only kept as a transitional fallback for bastions
  whose key file was unreadable at migration time. The `./keys` volume
  becomes a one-time staging area: drop a key in there, pick it via
  the UI, the server uploads the content to the KMS on save and the
  bastion record converges to `privateKeyRef` only.
- The `aperium-psql` container env has `PG_PASSWORD` and
  `SESSION_SECRET` either empty (server falls back to the well-known
  default ref) or set to a ref. The KMS auth token is read from
  `OPENBAO_TOKEN_FILE` (default `/openbao/state/root-token`, mounted
  read-only from the openbao-state volume) rather than carried in
  the env — `docker inspect aperium-psql | grep -i token` returns
  nothing.

A "ref" is an opaque string of the shape `openbao:<path>`.
Examples:

- `openbao:server/session-secret`
- `openbao:server/pg-password`
- `openbao:connections/<userId>/<connId>/<uuid>`

The selector env var is `APERIUM_KMS=openbao`. Any other value is
fatal at boot.

---

## 2. Dev sidecar (the shipped compose)

The shipped `docker-compose.yml` runs OpenBao with **persistent file
storage** and a wrapper script (`scripts/openbao/init.sh`) that
auto-initialises and auto-unseals the container on every boot so it
survives `docker compose down/up` without manual intervention.

Two named Docker volumes underpin the setup:

- `openbao-data` — the OpenBao file backend (`/openbao/data` inside
  the container). Holds every secret ever written.
- `openbao-state` — `init.json` (Shamir unseal key + root token) plus
  a `root-token` file that aperium and the bootstrap container read
  via a read-only bind mount.

The init script's flow on each container start:

1. Start `bao server -config=/openbao/config/config.hcl` in background.
2. Wait for the listener.
3. If not yet initialized: `bao operator init -key-shares=1
   -key-threshold=1` and persist `init.json` + `root-token` to
   `openbao-state`.
4. Unseal using the cached Shamir key.
5. Enable the KV v2 mount at `secret/` once.
6. `wait` on the server so signals propagate.

Aperium reads the root token via `OPENBAO_TOKEN_FILE=/openbao/state/root-token`
rather than via env — `docker inspect aperium-psql` never shows the
token in plaintext.

The KV v2 mount stays at the default path `secret/`, with the prefix
`aperium/` for everything aperium writes.

A separate `openbao-bootstrap` one-shot service reads the root token
from the same volume and seeds the well-known `server/pg-password`
ref from the Postgres init password before aperium starts. The
`session-secret` ref is auto-seeded by aperium itself with 32 random
bytes if missing.

**Security caveats of the dev pattern:**

- The unseal key lives next to the data it unseals (single Docker
  volume). Anyone with read access to the host's docker volume root
  can read every secret.
- Single Shamir share, threshold 1 — designed for localhost only.
- The `OPENBAO_TOKEN_FILE` is the root token, with full privileges.
  Production should use AppRole or another scoped auth method instead.

In production: split unseal keys across operators (or auto-unseal via
transit/AWS KMS), use AppRole / OIDC / Kubernetes ServiceAccount auth,
put TLS on `OPENBAO_ADDR`, restrict ACLs to `secret/data/aperium/*`.
The skeleton in section 3 below shows the swap.

---

## 3. Production setup

In production you want:

- A persistent storage backend (file, integrated raft, S3, etc.).
- A real authentication method (AppRole, JWT/OIDC, Kubernetes
  ServiceAccount). Strip the root token from disk after init.
- Auto-unseal (KMS-based or transit) so restarts don't require a
  human.
- TLS on `OPENBAO_ADDR`.
- Network ACLs restricting which clients can read which paths.

A minimal `docker-compose.override.yml` for a persistent OpenBao
might look like:

```yaml
services:
  openbao:
    command:
      - server
      - -config=/openbao/config.hcl
    volumes:
      - ./openbao/config.hcl:/openbao/config.hcl:ro
      - openbao-data:/openbao/file
    environment: []   # no -dev variables
volumes:
  openbao-data:
```

With `config.hcl`:

```hcl
storage "file" { path = "/openbao/file" }
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true   # put a reverse proxy in front; do NOT expose this raw
}
ui = true
```

After first boot: `bao operator init`, persist the unseal keys + root
token off-host, then unseal three times. Enable KV v2:
`bao secrets enable -version=2 -path=secret kv`. Create a policy
`aperium-readwrite` granting `read,create,update,delete` on
`secret/data/aperium/*` and `secret/metadata/aperium/*`. Then create
an AppRole, write its role-id + secret-id, and use those instead of
the root token.

The aperium KMS client currently accepts only a static
`OPENBAO_TOKEN`. If you want AppRole login, you can renew the token
externally (e.g. a sidecar that calls
`POST /v1/auth/approle/login` and writes the response token to a
volume that aperium reads on startup).

---

## 4. Migrating an existing install

When you upgrade from a pre-KMS version of aperium:

1. **Stop the aperium container.**
2. **Set `APERIUM_KMS=openbao`** plus the OpenBao env vars (the
   shipped `docker-compose.yml` already has the dev defaults wired).
3. **Restart aperium.** On boot the server walks every
   `data/<userId>/{connections,bastions}.json`, pushes any
   plaintext `password` / `passphrase` / inline `privateKey` into
   the KMS, and rewrites the file with `*Ref` strings. Look for
   `[migrate] user=<uuid> connections: N migrated, …` log lines.
4. **Verify** that no plaintext remains:

   ```sh
   grep -rE '"password"|"passphrase"|"privateKey"\s*:\s*"-' data/
   ```

   should return nothing (only `*Ref` fields).

5. **Boot secrets**. The first time the server starts with KMS
   configured:

   - If `SESSION_SECRET` is **unset** and the well-known ref is
     missing, the server seeds 32 random bytes and uses them.
     Subsequent boots resolve the ref.
   - If `SESSION_SECRET` was set to a **literal** value before the
     migration, the server pushes that value to the KMS once and
     logs a warning. Remove the env var (or replace it with the
     printed ref) on the next boot.
   - `PG_PASSWORD` cannot be auto-generated (Postgres has its own
     copy in the data volume). The shipped compose handles this via
     the `openbao-bootstrap` one-shot which seeds the value from
     `POSTGRES_PASSWORD`. For self-managed deployments, seed
     manually with `bao kv put secret/aperium/server/pg-password
     value=<your-password>` before the first aperium boot.

---

## 5. Operating: rotation, backup, recovery

- **Rotation.** Push a new value at the same ref. `putAt` is
  idempotent. The next time the server reads the ref (next query
  spawn, next session validation), the new value takes effect.
  Active queries keep using the cached env they spawned with.
- **Backup.** The aperium JSON/YAML backup (sidebar → "Backup /
  restore") is now a **real, restorable backup**. The server resolves
  every `*Ref` against the KMS, packs the cleartext payload, and
  encrypts it with AES-256-GCM using a key derived from the
  passphrase you provide (scrypt, N=2¹⁵, r=8, p=1). Anyone with the
  passphrase can read every secret — store it like you'd store any
  master credential (password manager, off-host). Lose the
  passphrase and the dump is unrecoverable.
  Importing a v2 dump on another aperium install: the server
  decrypts, re-pushes every secret to **that** install's KMS, and
  merges the resulting refs by id. No coordination between the
  source and destination KMS is required — the encrypted file is the
  contract.
  Legacy v1 dumps (refs only, no encryption) are still accepted on
  import; they restore the connection / bastion shells but the
  secrets stay broken unless the original KMS is reachable.
- **Disaster recovery.** Restoring requires three things, in order:
  (1) the KMS data (including unseal/admin tokens), (2) the
  aperium data volume (`data/`), and (3) the aperium image. Any of
  them alone is insufficient.
- **Auditing.** Every read/write is a normal HTTP call to OpenBao,
  which logs them. Enable the audit log for who-read-what trails.
