---
name: api-design
description: Design or review HTTP/REST, GraphQL or RPC APIs — resources, naming, pagination, errors, versioning, auth, idempotency — and produce an OpenAPI spec. Use when creating endpoints, writing API docs, or reviewing an API for consistency.
version: 1.0.0
category: engineering
tags: [api, rest, openapi, graphql, design]
---

# API design

## Principles

- Model **resources** (nouns), not actions: `POST /invoices/{id}/payments` over `POST /payInvoice`.
- Consistent naming: plural collections, kebab- or snake-case paths, one casing for JSON fields
  (match the codebase).
- Predictable status codes: 200/201 (+`Location`)/204, 400 validation, 401 unauthenticated,
  403 forbidden, 404, 409 conflict, 422 semantic, 429 rate-limited, 5xx server.
- One error shape everywhere, e.g. RFC 9457 problem details:
  `{ "type", "title", "status", "detail", "instance", "errors": [{ "field", "message" }] }`.

## Collections

- Cursor pagination for anything that grows: `?limit=50&cursor=…` → `{ data, next_cursor }`.
- Filtering `?status=open&created_after=…`, sorting `?sort=-created_at`.
- Sparse fields/expansion only when there is a real need.

## Safety & evolution

- Idempotency keys (`Idempotency-Key` header) for POSTs that create money-moving or
  side-effectful resources; PUT/DELETE are idempotent by definition.
- Optimistic concurrency with `ETag` + `If-Match` for updates that can race.
- Versioning: additive changes are free; breaking changes need a new version
  (`/v2` or header) and a deprecation window (`Deprecation`/`Sunset` headers).
- Never remove or repurpose a field silently.

## Security

AuthN via bearer tokens/OAuth2; authZ per resource; rate limits with `RateLimit-*` headers;
validate input at the edge; no secrets in URLs; CORS allow-lists.

## Deliverable

Write an OpenAPI 3.1 document (YAML) with schemas, examples and error responses; validate it
(`npx @redocly/cli lint openapi.yaml`). For reviews, list inconsistencies with concrete fixes.
