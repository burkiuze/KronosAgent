---
name: security-audit
description: Audit an application or change for security vulnerabilities — injection, authn/authz, secrets, dependencies, configuration — and produce prioritised, verified findings. Use for security reviews, pre-release audits, "is this safe", or after a dependency alert. Defensive use only.
version: 1.0.0
category: engineering
tags: [security, owasp, audit, secrets, dependencies]
requires:
  toolsets: [files, shell]
---

# Security audit (defensive)

Scope: code and configuration the user owns. Do not attack third-party systems.

## 1. Inventory the attack surface

Entry points (HTTP routes, CLI args, message consumers, file uploads, webhooks, cron),
trust boundaries, data stores, secrets, third-party calls. `grep` for route registrations
(`app.get(`, `@app.route`, `router.`, `urls.py`, `@GetMapping`).

## 2. Automated sweeps (if available)

- Secrets: `gitleaks detect` or `trufflehog filesystem .`; also `grep -rEn "(api[_-]?key|secret|password|token)\s*[:=]" --exclude-dir=node_modules`.
- Dependencies: `npm audit --omit=dev`, `pip-audit`, `govulncheck ./...`, `cargo audit`, `bundle audit`.
- SAST: `semgrep --config auto` (fast, low noise).
Treat tool output as leads to verify, not findings.

## 3. Manual review checklist (OWASP-aligned)

- **Injection**: string-built SQL, `exec`/`spawn` with shell=true and user input, template
  rendering of user strings, LDAP/XPath, `eval`.
- **Path traversal**: user-controlled paths joined without `resolve` + prefix check.
- **AuthN**: password hashing (argon2/bcrypt), session expiry, token validation (alg, aud, exp),
  rate limiting on login/reset.
- **AuthZ**: every new endpoint checks the *resource owner*, not just "logged in" (IDOR).
- **SSRF**: server-side fetch of user URLs without allow-lists / private-range blocking.
- **XSS**: `dangerouslySetInnerHTML`, `v-html`, `innerHTML`, unescaped templates; CSP present?
- **CSRF**: cookie-authenticated state-changing requests need tokens/SameSite.
- **Deserialisation**: `pickle`, `yaml.load` (unsafe), Java serialization.
- **Crypto**: home-made crypto, ECB, static IVs, `Math.random` for secrets.
- **Config**: debug mode in prod, permissive CORS (`*` with credentials), verbose errors,
  default creds, open admin panels, missing TLS, overly broad IAM.
- **Logging**: secrets/PII in logs; missing audit trail for sensitive actions.

## 4. Verify & rate

For each finding: exploit path (input → sink), impact, likelihood → Critical/High/Medium/Low.
Prove with a safe local test where possible. Drop what you can't substantiate.

## 5. Report

Table of findings (severity, location, issue, fix), then details with concrete patches.
Offer to implement the fixes and add regression tests.
