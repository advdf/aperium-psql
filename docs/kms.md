# KMS integration

Aperium does not store sensitive values on disk or in environment
variables. Postgres passwords, SSH bastion passphrases, inline private
keys, the session secret, and the app DB password all live in an open-
source KMS and are resolved on-demand by the server.

This page covers:

1. [What gets stored where](#1-what-gets-stored-where)
2. [Choosing an adapter](#2-choosing-an-adapter)
3. [OpenBao (recommended for self-host)](#3-openbao-recommended-for-self-host)
4. [Infisical](#4-infisical)
5. [Migrating an existing install](#5-migrating-an-existing-install)
6. [Operating: rotation, backup, recovery](#6-operating-rotation-backup-recovery)

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
  `SESSION_SECRET` set to refs (or unset, in which case the server
  uses well-known default refs). `docker inspect` shows refs, not
  values.

A "ref" is an opaque string of the shape `${adapter}:<adapter-path>`.
Examples:

- `openbao:server/session-secret`
- `openbao:server/pg-password`
- `openbao:connections/<userId>/<connId>/<uuid>`
- `infisical:prod:aperium__server__session_secret`

---

## 2. Choosing an adapter

|                          | OpenBao | Infisical |
|--------------------------|---------|-----------|
| License                  | MPL-2.0 (Vault fork) | MIT |
| Self-host story          | Single binary; built-in dev mode; HA via storage backend | Multi-service (API + frontend + Postgres + Redis); docker-compose recipe upstream |
| API style                | Vault HTTP API (KV v2) | REST + Universal-Auth |
| Aperium ref format       | `openbao:<path>` | `infisical:<env>:<name>` |
| Aperium env vars         | `OPENBAO_ADDR`, `OPENBAO_TOKEN`, `OPENBAO_MOUNT` | `INFISICAL_ADDR`, `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID`, `INFISICAL_ENV` |
| Best for                 | Operators who already run Vault or want a single-binary deploy | Teams who want a web UI for secret browsing and per-environment overrides |

Either is fine — pick the one your operators already know. Switching
later is possible but requires re-pushing every secret.

Set `APERIUM_KMS=openbao` or `APERIUM_KMS=infisical`. Any other value
is fatal at boot.

---

## 3. OpenBao (recommended for self-host)

### 3.1 Dev sidecar (already in `docker-compose.yml`)

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

This is **enough to develop and demo** the app. Do not run it in
production.

### 3.2 Production setup

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

## 4. Infisical

Self-hosting Infisical needs more moving parts than OpenBao: a
backing Postgres, Redis, the API container, and the frontend. The
upstream `docker-compose.yml`
(<https://github.com/Infisical/infisical>) is the recommended
starting point. Aperium does not ship an Infisical sidecar — bring
your own.

### 4.1 Setup checklist

1. Stand up Infisical (self-hosted) and create an account.
2. Create a project. Note the **project ID**.
3. Create an environment slug (default in aperium: `prod`). The
   Infisical UI calls these "environments".
4. Settings → Machine Identities → create a new universal-auth
   identity. Add it to the project with `Member` permissions plus
   custom access to `Read / Create / Update / Delete` on the `prod`
   environment.
5. Copy the `clientId` and `clientSecret` for the identity.
6. Set the aperium env vars:

   ```
   APERIUM_KMS=infisical
   INFISICAL_ADDR=https://infisical.yourdomain.tld
   INFISICAL_CLIENT_ID=<from-step-5>
   INFISICAL_CLIENT_SECRET=<from-step-5>
   INFISICAL_PROJECT_ID=<from-step-2>
   INFISICAL_ENV=prod
   ```

7. Bootstrap the boot secrets: see section 5.

### 4.2 Name shape

Infisical does not allow `/` in secret names, so user secrets are
flattened with double underscores. Examples:

- `aperium__server__session_secret`
- `aperium__server__pg_password`
- `aperium__connections__<userId>__<connId>__<uuid>`

You can browse them in the Infisical UI under the chosen environment.

---

## 5. Migrating an existing install

When you upgrade from a pre-KMS version of aperium:

1. **Stop the aperium container.**
2. **Decide on an adapter** and bring it up (OpenBao dev sidecar is
   the fastest path).
3. **Set the env vars** in `docker-compose.yml` (the shipped file
   already has the OpenBao defaults wired).
4. **Restart aperium.** On boot the server walks every
   `data/<userId>/{connections,bastions}.json`, pushes any
   plaintext `password` / `passphrase` / inline `privateKey` into
   the KMS, and rewrites the file with `*Ref` strings. Look for
   `[migrate] user=<uuid> connections: N migrated, …` log lines.
5. **Verify** that no plaintext remains:

   ```sh
   grep -rE '"password"|"passphrase"|"privateKey"\s*:\s*"-' data/
   ```

   should return nothing (only `*Ref` fields).

6. **Boot secrets**. The first time the server starts with KMS
   configured:

   - If `SESSION_SECRET` is **unset** and the well-known ref is
     missing, the server seeds 32 random bytes and uses them.
     Subsequent boots resolve the ref.
   - If `SESSION_SECRET` was set to a **literal** value before the
     migration, the server pushes that value to the KMS once and
     logs a warning. Remove the env var (or replace it with the
     printed ref) on the next boot.
   - `PG_PASSWORD` cannot be auto-generated (Postgres has its own
     copy in the data volume). Provide the existing literal once;
     the server pushes it to the KMS and warns. Remove the env var
     on the next boot.

---

## 6. Operating: rotation, backup, recovery

- **Rotation.** Push a new value at the same ref. `putAt` is
  idempotent. The next time the server reads the ref (next query
  spawn, next session validation), the new value takes effect.
  Active queries keep using the cached env they spawned with.
- **Backup.** The aperium JSON/YAML backup
  (sidebar → "Backup / restore") now contains only refs. Keep it as
  part of your normal backup — but remember the file is **useless
  without the KMS**.
  Back up the KMS itself separately:
  - OpenBao: snapshot the storage volume (`/openbao/file`) and the
    unseal keys.
  - Infisical: follow upstream documentation (the secrets live in
    Infisical's Postgres).
- **Disaster recovery.** Restoring requires three things, in order:
  (1) the KMS data (including unseal/admin tokens), (2) the
  aperium data volume (`data/`), and (3) the aperium image. Any of
  them alone is insufficient.
- **Auditing.** Every read/write is a normal HTTP call to the KMS,
  which logs them. Use the KMS's audit log for who-read-what trails.
