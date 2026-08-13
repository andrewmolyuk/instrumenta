# Foreman: the long-running daemon container (architecture.md, ADR-002).
# Ships the `docker` CLI so it can `docker run` Minion — talks to the host's
# daemon through a mounted socket, not one running inside this container
# (see README's run instructions for the required volume mount).
FROM oven/bun:1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

EXPOSE 3000

ENTRYPOINT ["bun", "src/foreman/main.mts"]
