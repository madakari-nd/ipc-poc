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
# The official caddy image ships /usr/bin/caddy with a cap_net_bind_service file
# capability and runs as non-root; executing a cap-bearing binary is denied on
# Render free ("exec /usr/bin/caddy: operation not permitted"). The gateway only
# binds :8080, so drop the capability and run as root.
USER root
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy
COPY --from=build /repo/apps/field/dist /srv/field
COPY --from=build /repo/apps/officer/dist /srv/officer
COPY --from=build /repo/infra/gateway/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080