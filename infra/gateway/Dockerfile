# syntax=docker/dockerfile:1.7
# Render "web" gateway (replaces the compose Caddy + shared-volume static dance).
# Builds @ipc/field and @ipc/officer, then serves them and proxies /ipc + /ipc-evidence-*
# through Caddy. SPAs stay same-origin (base /field/, /officer/), so no frontend code change.
FROM node:22.11.0-bookworm-slim AS build
WORKDIR /repo
ENV HUSKY=0
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund \
 && npm run build -w @ipc/contracts -w @ipc/field -w @ipc/officer

FROM caddy:2.8.4-alpine
COPY --from=build /repo/apps/field/dist /srv/field
COPY --from=build /repo/apps/officer/dist /srv/officer
COPY --from=build /repo/infra/gateway/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080