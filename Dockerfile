ARG NODE_VERSION=20
ARG DEBIAN_SUITE=bookworm

# ---- build stage: install deps, compile node-pty, bundle renderer ----
FROM node:${NODE_VERSION}-${DEBIAN_SUITE}-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund

# CodeMirror / esbuild are dependencies (used by the bundled renderer), so the
# build can run against the production install above.
COPY src ./src
COPY assets ./assets
RUN npx esbuild src/renderer.js \
    --bundle --outfile=dist/renderer.bundle.js \
    --platform=browser --format=iife --target=chrome120

COPY server ./server

# ---- runtime stage ----
FROM node:${NODE_VERSION}-${DEBIAN_SUITE}-slim
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/assets ./assets
COPY --from=build /app/server ./server
COPY package.json ./package.json

ENV NODE_ENV=production \
    APERIUM_DATA_DIR=/data \
    PORT=8080

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
