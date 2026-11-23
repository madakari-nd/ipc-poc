# syntax=docker/dockerfile:1.7
# Builds the static field app; caddy serves /app/dist (copied into a shared volume by compose).
FROM node:22.11.0-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/field ./apps/field
RUN npm ci -w @ipc/field -w @ipc/design-system -w @ipc/contracts && npm run build -w @ipc/contracts -w @ipc/design-system -w @ipc/field

FROM busybox:1.36.1 AS runtime
COPY --from=build /repo/apps/field/dist /app/dist
USER 65534
