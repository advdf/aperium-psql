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
- `data/<userId>/bastions.json` carries `passphraseRef` and (when the
  bastion used an inline key) `privateKeyRef`. The `privateKeyPath`
  field is unchanged — key files on the mounted `/keys` volume are
  out of scope for the KMS.
- The `aperium-psql` container env has `PG_PASSWORD` and
  `SESSION_SECRET` either empty (server falls back to the well-known
  default ref) or set to a ref. `docker inspect` shows refs, not
  values. The only plaintext credential in the env is
  `OPENBAO_TOKEN` — the bootstrap credential to the KMS itself. In
  production, swap this for a Docker secret mount or an external
  auth method (AppRole / OIDC / k8s SA).

A "ref" is an opaque string of the shape `openbao:<adapter-path>`.
Examples:

- `openbao:server/session-secret`
- `openbao:server/pg-password`
- `openbao:connections/<userId>/<connId>/<uuid>`

The selector env var is `APERIUM_KMS=openbao`. Any other value is
fatal at boot.

---

## 2. Dev sidecar (the shipped compose)

The shipped `docker-compose.yml` runs OpenBao in **dev mode** alongside
the app:

```yaml
openbao:
  image: openbao/openbao:latest
  command:
    - server
    - -dev
    - -dev-root-token-id=aperium-dev-root
    - -dev-listen-address=0.0.0.0:8200
```

- The KV v2 mount is `secret` (default).
- The root token is fixed at `aperium-dev-root`.
- Data is in memory only — **restarting the container loses every
  secret**.
- Listens on `0.0.0.0:8200` inside the `internal` network. Not
  exposed to the host.

The aperium service is wired to it via:

```yaml
APERIUM_KMS=openbao
OPENBAO_ADDR=http://openbao:8200
OPENBAO_TOKEN=aperium-dev-root
OPENBAO_MOUNT=secret
```

A small `openbao-bootstrap` one-shot container seeds the well-known
`server/pg-password` ref from the postgres init password before
aperium starts. The `session-secret` ref is auto-seeded by aperium
itself with 32 random bytes if missing.

This is **enough to develop and demo** the app. The "dev mode" label
refers to OpenBao's run flag — the binary itself is the production
binary, just configured for localhost convenience (no TLS, no
persistence, single fixed token). Do not run this configuration in
production.

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

The aperium adapter currently accepts only a static
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
- **Backup.** The aperium JSON/YAML backup
  (sidebar → "Backup / restore") now contains only refs. Keep it as
  part of your normal backup — but remember the file is **useless
  without the KMS**.
  Back up the KMS itself separately: snapshot the OpenBao storage
  volume (`/openbao/file`) and the unseal keys.
- **Disaster recovery.** Restoring requires three things, in order:
  (1) the KMS data (including unseal/admin tokens), (2) the
  aperium data volume (`data/`), and (3) the aperium image. Any of
  them alone is insufficient.
- **Auditing.** Every read/write is a normal HTTP call to OpenBao,
  which logs them. Enable the audit log for who-read-what trails.

---

## A note on other adapters

The `SecretStore` interface in `server/secrets/index.js` is
deliberately small (`get` / `put` / `putAt` / `delete` /
`healthcheck`). Plugging in a different KMS (Infisical, AWS Secrets
Manager, Doppler, …) is roughly one new file under `server/secrets/`
and a branch in the `getSecretStore()` switch. None ship today —
PRs welcome.
