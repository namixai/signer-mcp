# Container image for @usenami/signer-mcp — a stdio MCP server.
#
# Used by Glama (glama.ai/mcp/servers) and any other registry/host that builds
# the server to inspect it: Glama builds this image, launches it, and connects
# over stdio to enumerate tools (initialize + tools/list). No live Signer
# gateway is required for that — `list_venues` and the tool manifest work fully
# offline; gateway-dependent tools simply return a clean toolError until a
# SIGNER_GATEWAY_URL / SIGNER_API_TOKEN is provided at run time.
#
# Run locally:
#   docker build -t usenami/signer-mcp .
#   docker run -i --rm usenami/signer-mcp        # speaks MCP over stdin/stdout
#   # with a gateway:
#   docker run -i --rm -e SIGNER_GATEWAY_URL=https://signer.usenami.io \
#       -e SIGNER_API_TOKEN=sk_live_... usenami/signer-mcp

# ── build stage: install all deps + compile TypeScript ──
FROM node:20-alpine AS build
WORKDIR /app
# Install deps first (cached layer). --ignore-scripts skips the `prepare`
# build hook here; we run the build explicitly once sources are present.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

# ── runtime stage: prod deps + compiled dist only ──
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Only runtime dependencies (@modelcontextprotocol/sdk, zod) — no typescript /
# vitest / tsx. --ignore-scripts skips `prepare` (no compiler in this stage).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# stdio MCP server: the registry/host connects over stdin/stdout.
ENTRYPOINT ["node", "dist/index.js"]
