FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts --workspace=@pi-bot/server --workspace=@pi-bot/agent --workspace=@pi-bot/bot-face --workspace=@pi-bot/a2ui --workspace=@pi-bot/admin --include-workspace-root
RUN npm rebuild argon2 && npm run build --workspace=@pi-bot/admin && npm run build --workspace=@pi-bot/server
FROM node:24-bookworm-slim
# Optional: supply a virtctl version matching your KubeVirt cluster at build time.
ARG VIRTCTL_VERSION
ARG TARGETARCH
RUN if [ -n "$VIRTCTL_VERSION" ]; then apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && curl -fL "https://github.com/kubevirt/kubevirt/releases/download/${VIRTCTL_VERSION}/virtctl-${VIRTCTL_VERSION}-linux-${TARGETARCH:-amd64}" -o /usr/local/bin/virtctl && chmod 755 /usr/local/bin/virtctl && rm -rf /var/lib/apt/lists/*; fi
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
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8000
CMD ["node", "server/dist/main.mjs"]
