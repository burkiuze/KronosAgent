---
name: mcp-integration
description: Connect Kronos to external tools via Model Context Protocol servers (stdio or HTTP) — GitHub, Gmail, Google Drive, Slack, Notion, Postgres, filesystem, browsers — configure auth, scope tools, and troubleshoot. Use for "connect to X", "add an MCP server", or when a task needs an integration that isn't available.
version: 1.0.0
category: meta
tags: [mcp, integrations, tools, connectors]
requires:
  toolsets: [shell, files]
---

# MCP integration

Kronos is an MCP **client** (connects to servers, exposing their tools as `mcp__<server>__<tool>`)
and an MCP **server** (`kronos mcp serve` lets other apps call Kronos).

## Add a server

Settings → MCP in the app, `kronos mcp add <name> -- <command> [args…]` / `kronos mcp add <name> --url <url>`, or `config.yaml`:

```yaml
mcp:
  servers:
    github:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
    postgres:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    remote-docs:
      url: https://example.com/mcp
      headers: { Authorization: "Bearer ${DOCS_TOKEN}" }
      enabled: true
      exclude: [delete_page]     # optionally hide risky tools (glob patterns)
```

Secrets go in `~/.kronos/.env` (Settings → API Keys) and are referenced as `${VAR}`; never
paste tokens into chat history or config files that might be shared.

## Choose servers

Prefer official/vendor servers, then well-maintained community ones. Check what tools it
exposes and whether they can write/delete; restrict with `include`/`exclude` and keep the
permission mode on `ask` for destructive tools.

## Troubleshoot

- `kronos mcp` / Settings → MCP shows status and errors per server.
- stdio servers: run the exact command in a terminal — missing `npx`/`uvx`, Node version and
  missing env vars are the usual culprits.
- HTTP servers: check URL, auth header, and that the server speaks streamable HTTP.
- After changing config, reconnect (Settings → MCP → reconnect) or start a new CLI session.

## Kronos as a server

`kronos mcp serve` (stdio). Add it to Claude Desktop/Cursor/other MCP clients as a command
server; they get a `kronos_agent` tool that runs a full Kronos agent turn with its tools,
memory and skills.
