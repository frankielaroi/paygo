# Production image for the PayGo API.
#
# Two stages: the build stage keeps the dev dependencies (Nest CLI, Prisma CLI,
# the toolchain argon2 needs) and the runtime stage carries only what the process
# needs to serve traffic.
#
# The image serves both servers in one process: the HTTP API on PORT and the raw
# Teltonika listener on TCP_DEVICE_PORT. That is deliberate (see CLAUDE.md) and is
# why the container is run as a single replica.

# ---------- build ----------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# argon2 is a native module. Prebuilt binaries cover most platforms, but the
# toolchain has to be present for the cases they do not, or npm ci fails here
# rather than at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# The install is the longest network operation in the build and a single reset
# fails the whole image, so it retries rather than giving up on the first one.
ENV NPM_CONFIG_FETCH_RETRIES=5 \
  NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=10000 \
  NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
  NPM_CONFIG_FETCH_TIMEOUT=600000
RUN npm ci --no-audit --no-fund

COPY . .

# The generated Prisma client is git-ignored TypeScript under src/generated, so it
# has to be generated before the build, not copied in.
RUN npm run prisma:generate \
  && npm run build \
  && test -f dist/main.js \
  && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

# dumb-init reaps zombies and forwards SIGTERM, so "docker compose down" closes the
# device sockets through Nest's shutdown hooks instead of killing the process.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

USER node

EXPOSE 3000 5027

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
