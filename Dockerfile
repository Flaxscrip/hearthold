# Hearthold agents — offline-sandbox image.
#
# BUILD time may use the internet (npm ci pulls packages, matching this project's
# "prep online, runtime offline" pattern). NOTHING here reaches the network once
# the container is running: the built image runs the warden/emissary/sovereign
# CLIs against an Archon node addressed by container hostname (drawbridge:4222)
# on the egress-isolated archon_default network — see docker-compose.hearthold.yml.
#
# Full bookworm base (not -slim): @didcid/cipher/gatekeeper/keymaster may compile
# native bindings during install, and the full image ships the build toolchain, so
# `npm ci` can't fail for lack of python3/make/g++. Build-only cost; runtime is offline.
FROM node:22-bookworm

WORKDIR /app

# The whole monorepo is the context (npm workspaces + tsc project references need
# every package to link + build). .dockerignore keeps node_modules/dist/.git out.
COPY . .

# Deterministic install from the committed lockfile, then compile TS → dist
# (tsc --build). This is the ONLY network-using step; nothing after it needs egress.
RUN npm ci && npm run build

ENV NODE_ENV=production

# Agents are one-shot CLIs — `node packages/<role>/dist/index.js <cmd>` — except
# `warden serve`, the one long-lived process. The container idles so any agent
# command can be `docker compose exec`'d into it (Archon's own `cli`-container
# pattern); compose keeps this as the command.
CMD ["sleep", "infinity"]
