# syntax=docker/dockerfile:1.7
# Builds the static officer app; caddy serves /app/dist (copied into a shared volume by compose).
FROM node:22.11.0-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/officer ./apps/officer
RUN npm ci -w @ipc/officer -w @ipc/design-system -w @ipc/contracts && npm run build -w @ipc/contracts -w @ipc/design-system -w @ipc/officer

FROM busybox:1.36.1 AS runtime
COPY --from=build /repo/apps/officer/dist /app/dist
USER 65534
