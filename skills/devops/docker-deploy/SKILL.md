---
name: docker-deploy
description: Containerise and deploy applications — production Dockerfiles (multi-stage, non-root, small), docker compose for local stacks, health checks, env/secrets handling, and deploy targets (VPS, Fly.io, Render, Railway, Kubernetes). Use for Dockerfile/compose work or "deploy this".
version: 1.0.0
category: devops
tags: [docker, compose, deploy, containers, kubernetes]
requires:
  toolsets: [shell, files]
---

# Docker & deployment

## Dockerfile checklist

- Pin a slim base by version (`node:22-slim`, `python:3.12-slim`, distroless for Go).
- **Multi-stage**: build deps in a builder stage, copy only artefacts into the runtime stage.
- Order layers for caching: copy lockfiles → install deps → copy source → build.
- `npm ci --omit=dev` / `pip install --no-cache-dir -r requirements.txt`.
- Run as non-root (`USER node` / create a user); `WORKDIR /app`.
- `EXPOSE` the port; read config from env; **no secrets baked into images**.
- `HEALTHCHECK` or an HTTP `/healthz` the orchestrator probes.
- `.dockerignore`: `node_modules`, `.git`, `dist`, `.env*`, tests, local data.
- Handle SIGTERM for graceful shutdown (exec-form `CMD ["node","server.js"]`, or `tini`).

Build and check: `docker build -t app .`, `docker run --rm -p 8080:8080 --env-file .env app`,
`docker image ls app` (size), `docker scout cves app` / `trivy image app` if available.

## Compose for local stacks

Services for app + db + cache, named volumes, `depends_on` with `condition: service_healthy`,
an `.env.example`. `docker compose up -d --build`, `docker compose logs -f app`.

## Deploy targets

- **VPS**: compose + Caddy (automatic HTTPS) reverse proxy; systemd or `restart: unless-stopped`.
- **Fly.io** `fly launch` · **Render/Railway**: connect repo, set env, health check path.
- **Kubernetes**: Deployment (resources, probes, rolling update), Service, Ingress, Secret;
  `kubectl rollout status`.

Before deploying to anything shared, show the plan (what will change, downtime, rollback)
and get confirmation.
