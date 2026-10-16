# Fleet: server, agents, scheduling, RBAC, revisions

`pimg` scales from one machine to many without changing the CLI you already
know. The same `get / apply / scale / delete` commands run **locally** or
**remotely** — remote mode just needs a server.

## Quickstart: two terminals, one fleet

```sh
# Terminal 1 — API server (prints the admin token once on first run)
node ./bin/pimg.js --home ~/.pimg-fleet serve --port 8443

# Terminal 2 — log in (like kubectl context)
node ./bin/pimg.js login --server http://127.0.0.1:8443 --token <admin-token>

# Deploy; the scheduler places units (Pending until an agent joins)
node ./bin/pimg.js apply -f app.json
node ./bin/pimg.js get units

# Terminal 3 — agent joins and executes the units locally
node ./bin/pimg.js agent --server http://127.0.0.1:8443 \
  --token <agent-token> --node n1 --labels zone=a

node ./bin/pimg.js get units   # Running on n1
node ./bin/pimg.js top         # combined cpu/mem pool
```

Agent tokens: `pimg rbac user agent1` → `pimg rbac grant agent1 node-agent`
→ `pimg rbac token agent1` (run these against the **server's** home, or via
the API as admin).

## Server / client

- `serve [--port 8443] [--bind 127.0.0.1]` — JSON API over HTTP, Bearer
  tokens, RBAC on every route except `/api/healthz` and `/api/version`.
  First run creates `admin` + default roles and prints the admin token once
  (only the hash is stored, `auth.json` is chmod 600 where supported).
- Server choice per command: `--server URL` flag → `PIMG_SERVER` env →
  saved `login`; `--token` / `PIMG_TOKEN` likewise. `--local` forces local
  mode even when logged in.
- Remote-capable commands: `get`, `describe`, `apply`, `delete`, `diff`,
  `scale`, `cluster`, `nodes`, `revision`, `rbac`.

## Load distribution (scheduler + agents)

- Agents heartbeat `{capacity, used}` every `--interval` (default 5s);
  nodes go `NotReady` after 30s of silence and their units reschedule.
- `src/scheduler.js` (pure, tested): Ready nodes only, `nodeSelector`
  label match, then least-loaded weighted by CPU capacity; stable units keep
  their node across re-reconciles; no capacity anywhere → `Pending`.
- Manifests accept `"nodeSelector": {"gpu": "yes"}` per deployment.
- `top` aggregates the **combined pool**: ready nodes, assigned units,
  used/total cpu+mem, per-node rows.
- Honest limit: agents execute units with the emulated runtime on their own
  host. There is no cross-host image shipping yet — pull the image on each
  agent host (or a shared registry) before scheduling there.

## Git-like revisions

Every `apply`/`scale` records a revision (cap 10 per deployment):

```sh
pimg revision list web        # newest first, like git log
pimg revision diff web 1 2    # field diff between commits (no git needed)
pimg revision rollback web 1  # revert: restores the manifest AND replicas,
                              # recorded as a new revision (history preserved)
```

## Roles (RBAC)

Built-ins: `admin` (`*/*`), `deployer` (deployments/units/revisions),
`viewer` (read-only), `node-agent` (register/heartbeat/report own units).

```sh
pimg rbac list                 # users + bindings (add --json for machines)
pimg rbac user dev             # create user
pimg rbac grant dev deployer   # bind role
pimg rbac token dev            # mint token (shown once, hash stored)
```

The server returns 401 (bad token) / 403 (lacks `verb` on `resource`) with
the missing permission named. Plugins run client-side and never bypass this:
the server only sees HTTP.
