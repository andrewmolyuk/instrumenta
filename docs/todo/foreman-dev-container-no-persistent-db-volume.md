---
type: bug
status: resolved
date: 2026-08-16
source: session db97cd55-f412-44b1-9715-e64f9becbf9f
---

# `make dev`'s Foreman container has no persistent volume for its SQLite DB

`Makefile`'s `dev` target (`docker run --rm -i -p 3000:3000 -v /var/run/docker.sock:...
--env-file ... $(FOREMAN_IMAGE)`) mounts the Docker socket but has no volume for
`FOREMAN_DB_PATH`. `docs/architecture.md` says the SQLite task-state DB should live on a
persistent Docker volume — right now every Foreman restart during local `make dev` use
silently wipes attempt/dispatch history, which is verifiable and was observed repeatedly
in this session (`"history":[]` resetting on every restart). Add a named volume mount for
the DB path to the `dev` target so restarts don't lose history.

**Fixed**: `Makefile`'s `dev` target now creates/mounts a named volume
(`instrumenta-foreman-db`) at `/data` and sets `FOREMAN_DB_PATH=/data/foreman.db` via
`-e` (placed after `--env-file` so it wins even if a human's own `.env` also sets it).
Verified directly: set `budget: 7` via the API, stopped the container, restarted via
`make dev`, `budget` was still `7`. New `make clean-db` target wipes the volume
explicitly — not folded into `make clean`, since losing persisted history silently would
defeat the point of this fix.
