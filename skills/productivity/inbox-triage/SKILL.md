---
name: inbox-triage
description: Triage an email inbox or message backlog — classify by urgency and type, summarise threads, draft replies, propose archive/unsubscribe actions — using a connected mail MCP server (Gmail/Outlook) or exported messages. Use for "go through my inbox", "what needs my attention", email zero.
version: 1.0.0
category: productivity
tags: [email, inbox, triage, gmail, productivity]
requires:
  toolsets: [mcp]
---

# Inbox triage

Requires a connected mail integration (Settings → MCP, e.g. a Gmail or Outlook MCP server).
Without one, ask the user to export/paste the messages.

## Classify each thread

| Bucket | Meaning |
|---|---|
| 🔴 Act today | direct asks with deadlines, people waiting, money/legal/security |
| 🟡 Reply this week | questions, scheduling, reviews |
| 🔵 Read later | newsletters worth reading, FYIs |
| ⚪ Archive | notifications, receipts, resolved threads |
| 🗑️ Unsubscribe candidates | recurring bulk mail never opened |

Use memory (USER.md) for VIP senders and the user's priorities.

## Output

A digest: counts per bucket, then 🔴 and 🟡 items with sender, subject, one-line summary,
the ask, and a suggested reply (drafted, not sent).

## Actions

Never send, delete, archive or unsubscribe without explicit confirmation. Batch the proposed
actions into one list the user can approve ("archive these 23? y/n"). Drafts go to the mail
drafts folder when the integration supports it.
