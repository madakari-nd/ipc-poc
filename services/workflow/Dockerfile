# syntax=docker/dockerfile:1.7
# Multi-stage build for @ipc/workflow (NFR-006). Non-root, minimal runtime, healthcheck.
FROM node:22.11.0-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services/workflow ./services/workflow
RUN npm ci --workspaces --include-workspace-root=false -w @ipc/workflow -w @ipc/platform -w @ipc/contracts -w @ipc/elevate-client \
 && npm run build -w @ipc/contracts -w @ipc/platform -w @ipc/elevate-client -w @ipc/workflow \
 && npm prune --omit=dev

FROM node:22.11.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo /app
USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/workflow/dist/server.js"]
