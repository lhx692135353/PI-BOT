FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts --workspace=@pi-bot/server --workspace=@pi-bot/agent --workspace=@pi-bot/bot-face --workspace=@pi-bot/a2ui --workspace=@pi-bot/admin --include-workspace-root
RUN npm rebuild argon2 && npm run build --workspace=@pi-bot/admin && npm run build --workspace=@pi-bot/server

# Minimal Linux the bot works in: the API runs cloud-computer tasks inside this container.
FROM debian:bookworm-slim
# Optional: supply a virtctl version matching your KubeVirt cluster at build time.
ARG VIRTCTL_VERSION
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl bash coreutils findutils grep sed gawk diffutils file less procps \
      tar gzip xz-utils bzip2 zip unzip jq \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /bin/bash --create-home node
RUN if [ -n "$VIRTCTL_VERSION" ]; then curl -fL "https://github.com/kubevirt/kubevirt/releases/download/${VIRTCTL_VERSION}/virtctl-${VIRTCTL_VERSION}-linux-${TARGETARCH:-amd64}" -o /usr/local/bin/virtctl && chmod 755 /usr/local/bin/virtctl; fi
COPY --from=build /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production
WORKDIR /app
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY packages/agent/src/hermes-memory/LICENSE ./licenses/pi-hermes-memory-LICENSE
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/remote-guest/desktop.html ./server/remote-guest/desktop.html
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/server/scripts/wait.mjs ./server/scripts/wait.mjs
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/admin/dist ./admin/dist
COPY --chmod=755 server/scripts/docker-entrypoint.sh /usr/local/bin/pibot-entrypoint
# Cloud library: mount a host directory here so the bot's cloud files live on the host.
RUN mkdir -p /data/workspaces && chown -R node:node /data
USER node
EXPOSE 8000
ENTRYPOINT ["pibot-entrypoint"]
CMD ["node", "server/dist/main.mjs"]
