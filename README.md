# Instrumenta

A personal toolkit for building and maintaining software: a Coding agent, a Review agent,
an orchestrator that drives a task from a GitHub issue to a verified Pull Request, and a
Cockpit for watching and steering it.

The bet is **knowledge that accumulates**. Architectural decisions, how the codebase
works, and what review has already caught feed into later tasks, so the maintainer stops
re-supplying the same context every session. Specialised agents are held in check by
deterministic gates — tests, lint, security — rather than trusted to grade themselves.

> **Status: scaffold.** No product code yet. The toolchain and the repository gates are
> in place; the orchestrator, knowledge layer, and Cockpit are not.

See [`docs/vision.md`](docs/vision.md) for scope, the measured baselines, and how success
will be judged, and [`docs/decisions/`](docs/decisions/) for why things are the way they
are.

## Commands

```bash
bun install         # install dependencies
bun run lint        # oxlint
bun run format      # oxfmt, writes
bun run format:check
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun run check       # everything CI runs
```

## Licence

[MIT](LICENSE.md)
