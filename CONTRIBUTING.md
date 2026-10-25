# Contributing to Kronos

Thanks for helping! Kronos is a TypeScript monorepo; you need Node.js 22 (20.19+ works) and git.

```bash
git clone https://github.com/burkiuze/KronosAgent && cd KronosAgent
npm install
npm run build          # packages (tsc -b) + web UI (vite)
npm test               # vitest: core + gateway
npm run typecheck
```

## Day-to-day loops

| You are working on | Run |
|---|---|
| core / tools / agent loop | `npx tsc -b packages/core -w` and `npx vitest packages/core` |
| gateway | `npx vitest packages/gateway` |
| CLI | `npm run build:packages && node packages/cli/dist/bin.js` |
| web UI | `node packages/cli/dist/bin.js gateway` in one terminal, `npm run dev:web` in another (Vite proxies `/api` and `/ws` to `KRONOS_GATEWAY` or `127.0.0.1:7777`) |
| desktop | `npm run build && npm run start -w @kronos/desktop` |
| end-to-end UI | `npm install --no-save playwright && npx playwright install chromium && npm run test:e2e` |

Use a throwaway home while developing so you don't touch your real memory and sessions:
`KRONOS_HOME=$(mktemp -d) node packages/cli/dist/bin.js`. With no API keys Kronos uses the
offline demo model, which is also what the tests use.

## Guidelines

- **Tests with every behaviour change.** The demo provider (`packages/core/src/providers/demo.ts`)
  drives real tools deterministically; extend its routing when a new feature needs coverage.
- **Keep the surfaces thin.** Logic belongs in `@kronos/core`; the gateway, CLI, web and
  desktop should only translate between the runtime and their medium.
- **Safety first.** New tools declare an honest `risk`; anything with side effects outside the
  workspace is `external`. Never weaken a default without discussion.
- **Prompt-cache friendly.** Don't make the system prompt or tool list depend on per-turn state;
  deliver mid-session changes as notes on the next user message.
- **Open formats.** Prefer Markdown/YAML/JSON on disk and standards (SKILL.md, MCP, OpenAI API).
- Match the surrounding code style; run `npm run typecheck` before pushing.

## Adding things

- **A tool**: implement a `ToolDefinition` in `packages/core/src/tools/`, register it in the
  registry with its toolset, add a demo route + test.
- **A provider**: OpenAI-compatible ones are a catalog entry in `providers/catalog.ts`; others
  implement the `Provider` interface (`stream()`), see `anthropic.ts`.
- **A messaging platform**: extend `PlatformAdapter` in `packages/gateway/src/platforms/`, add a
  stateless sender in `packages/core/src/messaging/senders.ts`, a card in
  `apps/web/src/pages/Messaging.tsx` and docs in `docs/MESSAGING.md`.
- **A bundled skill**: a folder under `skills/<category>/<name>/` with `SKILL.md`; keep
  commands accurate and test any scripts.

## Commits & PRs

Conventional Commits (`feat(core): …`, `fix(gateway): …`, `docs: …`). PRs should describe the
change, how it was tested, and include screenshots for UI changes. CI runs typecheck, unit
tests on Node 20/22 (Linux + macOS), the Playwright UI test, the desktop bundle and a Docker
smoke test.

## Security

Please report vulnerabilities privately — see [docs/SECURITY.md](docs/SECURITY.md).
