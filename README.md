# instrumenta

An agent pipeline that autonomously works a target project's Jira backlog: picks a
task, implements or fixes it in that project's codebase, opens a PR. See
[docs/vision.md](docs/vision.md) for why, [docs/architecture.md](docs/architecture.md)
for how Foreman and Minion fit together.

## Running it

Two images: **Foreman** (this repo's root `Dockerfile`, the long-running daemon +
control API/UI) and **Minion** (`minion/Dockerfile`, spun up fresh per task). Foreman
dispatches Minion via `docker run` against the host's Docker daemon — it needs the
socket mounted in, not a daemon of its own.

### 1. Build both images

```bash
docker build -t minion:latest -f minion/Dockerfile .
docker build -t foreman:latest .
```

### 2. Set Foreman's environment

All of these are required unless marked optional — see
[src/foreman/config.mts](src/foreman/config.mts) for the exact parsing and defaults.

| Variable | Purpose |
|---|---|
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira auth, shared by the Task Provider and status mirror |
| `JIRA_JQL` | The live backlog query — ordering and "open" are this query's job, not Foreman's (architecture.md) |
| `BITBUCKET_WORKSPACE`, `BITBUCKET_REPO_SLUG`, `BITBUCKET_TOKEN` | Target repo, for the give-up check's declined-PR count and for Minion (inherited — see below). Minion derives its git clone URL from these three (`buildCloneUrl`) rather than taking one of its own — one source of truth for which repo this is |
| `MINION_COMMAND` | JSON argv array Foreman runs per task — see below |
| `FOREMAN_DB_PATH` *(optional, default `./foreman.db`)* | SQLite file |
| `MINION_TIMEOUT_MS` *(optional, default `600000`)* | Kill a Minion run past this |
| `FOREMAN_POLL_INTERVAL_MS` *(optional, default `60000`)* | Sleep between Picks when the queue is empty |
| `FOREMAN_API_PORT` *(optional, default `3000`)* | Control API + Web UI |
| `FOREMAN_BUDGET` *(optional)* | Max tasks this run — also settable live via the API/UI |
| `FOREMAN_START_TICKET` *(optional)* | Seed `start[ticket]` on first boot |

`MINION_COMMAND` is a JSON array, not a shell string, so it can carry arbitrary argv
without shell-quoting rules — e.g.:

```json
["docker","run","--rm","-i","-e","BITBUCKET_WORKSPACE","-e","BITBUCKET_REPO_SLUG","-e","BITBUCKET_TOKEN","minion:latest"]
```

`-e VAR` with no `=value` forwards that variable from whatever environment the
`docker run` call itself runs in — Foreman's own (`Bun.spawn` inherits `process.env` by
default, per `ProcessMinionRunner`) — into the Minion container. This is how
credentials reach Minion: the same env vars configured for Foreman, not a separate
secret store.

### 3. Run Foreman

```bash
docker run --rm -it \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e JIRA_BASE_URL -e JIRA_EMAIL -e JIRA_API_TOKEN -e JIRA_JQL \
  -e BITBUCKET_WORKSPACE -e BITBUCKET_REPO_SLUG -e BITBUCKET_TOKEN -e MINION_COMMAND \
  foreman:latest
```

The control API/UI is then at `http://localhost:3000` — status, queue, attempt
history, and the four ADR-003 controls (stop, continue, start[ticket], budget).

### Known gaps

- Minion's "implement the task" step is a stub — it attempts
  `claude --dangerously-skip-permissions -p <description>` if that CLI is on `PATH`,
  best-effort, but the real invocation (credentials, prompt, target-repo access from
  inside Minion) isn't wired up yet.
- No CI pipeline runs `bun run check` on push/PR yet — it's a local command for now.

## Development

```bash
bun install
bun run check   # typecheck + full test suite
```
