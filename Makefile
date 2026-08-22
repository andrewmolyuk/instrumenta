MINION_IMAGE := minion:latest
FOREMAN_IMAGE := foreman:latest
ENV_FILE := .env
DB_VOLUME := instrumenta-foreman-db
CACHE_VOLUME := instrumenta-minion-git-cache

.PHONY: build build-minion build-foreman dev check clean clean-db

build: build-minion build-foreman

build-minion:
	docker build -t $(MINION_IMAGE) -f minion/Dockerfile .

build-foreman:
	docker build -t $(FOREMAN_IMAGE) .

# Builds both images, then runs Foreman locally with the Web UI/API on
# :3000. Needs the host's Docker socket mounted in — Foreman dispatches
# Minion via `docker run` against it (see README.md). The SQLite DB lives on
# a named volume, not the container's own writable layer — `--rm` destroys
# that layer (and with it attempt/dispatch history, give-up counts, budget)
# every time this exits, which is the opposite of what a long-running daemon
# needs. `-e FOREMAN_DB_PATH` after `--env-file` so it wins even if a human's
# own .env also sets it.
dev: build
	@test -f $(ENV_FILE) || { \
		echo "Missing $(ENV_FILE) — copy .env.example to $(ENV_FILE) and fill in real values."; \
		exit 1; \
	}
	docker volume create $(DB_VOLUME) >/dev/null
	docker volume create $(CACHE_VOLUME) >/dev/null
	docker run --rm -i \
		-p 3000:3000 \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v $(DB_VOLUME):/data \
		--env-file $(ENV_FILE) \
		-e FOREMAN_DB_PATH=/data/foreman.db \
		$(FOREMAN_IMAGE)

check:
	bun run check

clean:
	docker rmi -f $(MINION_IMAGE) $(FOREMAN_IMAGE) 2>/dev/null || true

# Wipes Foreman's persisted history (attempts, give-up counts, budget) — not
# run by `clean`, since losing that silently would defeat the point of
# persisting it in the first place. Explicit opt-in only.
clean-db:
	docker volume rm -f $(DB_VOLUME) 2>/dev/null || true

# Drops the shared git mirror (ADR-013). Safe at any time — the next attempt
# re-clones it — but the first attempt after this pays the full clone again.
.PHONY: clean-cache
clean-cache:
	docker volume rm -f $(CACHE_VOLUME) 2>/dev/null || true
