# syntax=docker/dockerfile:1.7
# Multi-stage build for @ipc/workflow (NFR-006). Non-root, minimal runtime, healthcheck.
FROM node:22.11.0-bookworm-slim AS build
WORKDIR /repo
ENV HUSKY=0
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund \
 && npm run build -w @ipc/contracts -w @ipc/platform -w @ipc/elevate-client -w @ipc/workflow \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf apps packages/design-system tests specs docs

FROM node:22.11.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo /app
USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/workflow/dist/server.js"]
