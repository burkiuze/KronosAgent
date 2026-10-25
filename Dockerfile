# KRONOS AGENT gateway: web UI + API + messaging platforms + automations in one container.
#   docker build -t kronos .
#   docker run -d -p 7777:7777 -v kronos:/data --env-file .env kronos
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/gateway/package.json packages/gateway/
COPY packages/cli/package.json packages/cli/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# git/python3/curl/ripgrep make the agent's shell, terminal (PTY bridge) and search tools useful
RUN apt-get update && apt-get install -y --no-install-recommends git python3 curl ca-certificates ripgrep tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production KRONOS_HOME=/data
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY --from=build /src/skills ./skills
RUN ln -s /app/packages/cli/dist/bin.js /usr/local/bin/kronos && chmod +x /app/packages/cli/dist/bin.js \
  && mkdir -p /data /workspace && chown -R node:node /data /workspace
USER node
WORKDIR /workspace
VOLUME ["/data", "/workspace"]
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:7777/api/health || exit 1
ENTRYPOINT ["tini", "--"]
# binding to 0.0.0.0 requires a token: set KRONOS_GATEWAY_TOKEN or one is generated and logged
CMD ["kronos", "gateway", "--host", "0.0.0.0", "--port", "7777"]
