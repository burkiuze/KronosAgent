---
name: skill-authoring
description: Create, improve and test Kronos skills (SKILL.md + scripts/references) — including turning a workflow that just succeeded into a reusable skill. Use when the user asks to "make a skill", "remember how to do this", or after solving a non-trivial, repeatable task.
version: 1.2.0
category: meta
tags: [skills, self-improvement, procedural-memory, authoring]
requires:
  toolsets: [skills, files]
---

# Skill authoring

Skills are Kronos's **procedural memory**: memory stores facts, skills store *how to do things*.
A good skill turns a 30-step discovery into a 5-step recipe next time.

## When to create one

- You just completed a task that took real exploration and is likely to recur
  (deploying this app, the user's report format, a tricky API integration).
- The user corrected your approach — encode the corrected approach.
- The user explicitly asks.
Don't create skills for one-off facts (use `memory`) or for things any model already knows.

## Anatomy

```
<skill-name>/
  SKILL.md          # frontmatter + instructions (required)
  scripts/          # deterministic helpers the agent runs (optional)
  references/       # long docs loaded only when needed (optional)
  templates/        # files to copy/fill (optional)
```

Frontmatter:

```yaml
---
name: kebab-case-name            # unique, ≤ 64 chars
description: What it does AND when to use it — include trigger phrases users actually say.
version: 1.0.0
category: engineering            # folder/category in the Skills view
tags: [short, keywords]
requires:
  toolsets: [shell, web]         # toolsets the procedure needs
---
```

The **description is the trigger**: Kronos sees only names + descriptions until it decides to
load a skill, so make it specific ("Use when … / for …").

## Body guidelines

- Imperative steps in the order to execute them; numbered when order matters.
- Exact commands, file paths, API endpoints, flags — the details you had to discover.
- Decision points ("if X, do Y; otherwise Z") and known pitfalls with fixes.
- Verification step: how to know it worked.
- Keep SKILL.md under ~300 lines; push long reference material into `references/*.md` and
  mention when to read it.
- Put repeatable logic into `scripts/` (deterministic, idempotent, `--help`), so the agent
  runs code instead of re-deriving it.

## Create / update

Use `skill_manage`:
- `create` with name, description, category, body (and optional files).
- `patch` for small corrections (old → new text) — prefer this when a skill was wrong.
- `update` to rewrite. Bump `version` when behaviour changes.

## Test it

Start a fresh session (or `delegate` a subagent) with a realistic request that should trigger
the skill. Check it was picked, the steps worked as written, and nothing relied on context
from the original conversation. Refine the description if it didn't trigger.
