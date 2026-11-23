# syntax=docker/dockerfile:1.7
# Builds the static officer app; caddy serves /app/dist (copied into a shared volume by compose).
FROM node:22.11.0-bookworm-slim AS build
WORKDIR /repo
ENV HUSKY=0
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund \
 && npm run build -w @ipc/contracts -w @ipc/officer

FROM busybox:1.36.1 AS runtime
COPY --from=build /repo/apps/officer/dist /app/dist
USER 65534
