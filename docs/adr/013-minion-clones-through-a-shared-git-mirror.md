# 013 — Minion clones through a shared bare git mirror

Date: 2026-08-22

## Context

Every attempt begins by cloning the target repository, and the container is `--rm`, so
the clone is thrown away with it and paid again in full next time. Measured on a live
attempt against `CGS/webui`:

| | |
|---|---|
| Repository, cloned | 186 MB |
| Time to clone | 5–7 minutes |
| Typical attempt, end to end | ~25 minutes |

So roughly a quarter of every attempt is git downloading history the previous attempt
already had. It costs no tokens — Claude Code has not started — but it is a quarter of
the pipeline's throughput, and it grows with the repository.

## Options considered

- **A** — Leave it. Simple, and correct; just slow.
- **B** — `--depth 1`. Smallest download.
- **C** — `--filter=blob:none`, a blobless partial clone.
- **D** — A persistent bare mirror on a Docker volume, shared by every Minion: fetch into
  it once per attempt, then clone the work tree from it locally.

## Decision

**D.** When `MINION_GIT_CACHE` names a directory, `cloneAndBranch` clones through a bare
mirror kept there:

- `${MINION_GIT_CACHE}/<host>-<path>.git`, created with `git clone --mirror` the first
  time and updated with `git fetch --prune <url> '+refs/heads/*:refs/heads/*'` after.
- The work tree is then `git clone <mirrorPath> <workDir>` — a local clone, which
  hardlinks objects rather than copying them, so it is near-instant and costs almost no
  disk.
- `origin` is repointed at the real remote immediately afterwards. Without that, `git
  push` would update the mirror on the cache volume and Bitbucket would never see the
  branch.
- Credentials are passed on each command line and never written into the mirror's
  config: the volume outlives the container, and a token stored there would outlive it
  too. The one place `--mirror` writes the URL itself is scrubbed straight after.
- Any failure — cache unset, mirror corrupt, volume unwritable — logs and falls back to
  a direct clone. `make clean-cache` drops the volume.

**Why not B, `--depth 1`:** shallow single-branch clones do not fetch `origin/<branch>`
for other branches, which `reuseExisting` depends on to find an earlier attempt's work
(the collision ADR-009's neighbouring comment describes). Shallow history also breaks
`git describe`, changelog generation, and anything version-from-git in the *target*
project — whose toolchain is not ours to constrain.

**Why not C, blobless partial clone:** it trades one delay for another. History and refs
stay intact, but blobs are then fetched on demand while the agent reads files, and an
agent exploring an unfamiliar repository reads widely. It may well be slower overall, and
the cost moves to where it is hardest to see.

D is the only option that gets *faster* with repetition instead of moving the cost, and
the only one that changes nothing about what the agent sees: it gets an ordinary full
clone with complete history and every ref.

## Consequences

- **Minion is no longer fully self-contained.** ADR-002 calls it "ephemeral, sandboxed";
  it now shares mutable state — a volume — with every other Minion, past and future. The
  sandbox is intact (the mirror holds nothing but the target's own git objects, and no
  credentials), but "ephemeral" is now true of the container and not of everything it
  touches.
- **Concurrency is unguarded.** Two Minions fetching the same mirror at once is not safe,
  and nothing prevents it. Safe today only because Foreman dispatches one at a time and
  waits (architecture.md). Anything that makes dispatch parallel must add locking first.
- A mirror can serve stale refs if a fetch fails and the fallback does not trigger. The
  fetch is `--prune`, so deleted branches do not linger.
- First attempt after `make clean-cache`, or against a new target repo, pays the full
  clone as before.
- The volume grows with the target repository and is never garbage-collected.

## Reversibility

Two-way door, and unusually cheap: unset `MINION_GIT_CACHE` and every attempt clones
directly again, with no code change and no volume to clean up beyond `make clean-cache`.

## Revisit trigger

If Foreman ever dispatches more than one Minion at a time, this needs locking before that
ships — see Consequences. If the mirror is ever found serving stale or corrupt objects to
an attempt, prefer deleting it per-attempt on any fetch failure over debugging the volume.
