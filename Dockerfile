# syntax=docker/dockerfile:1

# Single-stage image, pinned exact base for reproducible builds.
# node:22.12.0 is the Active LTS ("Jod") line at the time this was written.
FROM node:22.12.0-bookworm-slim

WORKDIR /app

# Install dependencies first (better layer caching). package-lock.json is
# required so npm ci resolves an exact, reproducible dependency tree.
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript -> dist/. Source only, no .env/secrets are ever copied
# into the image (see .dockerignore).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies (typescript, vitest, tsx, ...) now that the build is
# done, so the final image ships only what's needed to run. This keeps the
# Dockerfile a single stage/image while still not shipping dev-only deps.
RUN npm prune --omit=dev && npm cache clean --force

ENV NODE_ENV=production

# stdio transport only - no port is exposed and no secrets are baked in.
# Run with: docker run --env-file .env keka-mcp
ENTRYPOINT ["node", "dist/index.js"]
