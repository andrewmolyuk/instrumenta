MINION_IMAGE := minion:latest
FOREMAN_IMAGE := foreman:latest
ENV_FILE := .env

.PHONY: build build-minion build-foreman dev check clean

build: build-minion build-foreman

build-minion:
	docker build -t $(MINION_IMAGE) -f minion/Dockerfile .

build-foreman:
	docker build -t $(FOREMAN_IMAGE) .

# Builds both images, then runs Foreman locally with the Web UI/API on
# :3000. Needs the host's Docker socket mounted in — Foreman dispatches
# Minion via `docker run` against it (see README.md).
dev: build
	@test -f $(ENV_FILE) || { \
		echo "Missing $(ENV_FILE) — copy .env.example to $(ENV_FILE) and fill in real values."; \
		exit 1; \
	}
	docker run --rm -i \
		-p 3000:3000 \
		-v /var/run/docker.sock:/var/run/docker.sock \
		--env-file $(ENV_FILE) \
		$(FOREMAN_IMAGE)

check:
	bun run check

clean:
	docker rmi -f $(MINION_IMAGE) $(FOREMAN_IMAGE) 2>/dev/null || true
