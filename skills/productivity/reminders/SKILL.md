---
name: reminders
description: Create, list, change and cancel reminders and recurring nudges in natural language ("remind me tomorrow at 9 to call mom", "every Friday 5pm ask me for my weekly review") delivered to the user's chat platform or desktop. Use for any reminder, alarm or recurring check-in request.
version: 1.0.0
category: productivity
tags: [reminders, cron, schedule, nudges]
requires:
  toolsets: [cron, messaging]
---

# Reminders

1. **Parse** the time in the user's time zone (config `cron.timezone`, else the system's).
   Relative times ("in 20 minutes", "tomorrow morning" → 09:00) — state the absolute time you
   chose in your reply.
2. **Create** with `cron_create`:
   - One-off: `"in 20 minutes"`, `"tomorrow at 9am"`, `"today at 18:30"` or an ISO time
     `"2026-03-14T09:00"` — these run once and then disable themselves.
   - Recurring: `"every friday at 17:00"`, `"every weekday at 8:30"`, or a cron expression.
   - Prompt: what Kronos should do when it fires — for a plain reminder, a short instruction
     such as `"Remind the user: call mom. Keep it to one friendly line."`
   - Delivery: `deliver_to` the chat the user is talking from (`"telegram:<chat id>"`,
     `"discord:<channel>"`, `"slack:<channel>"`, …); omit it to keep the result in Kronos,
     where the desktop app shows a notification.
3. **Confirm** in one line: what, when (absolute date/time + time zone), where.

Manage: `cron_list` to show reminders; `cron_update` to pause/resume/change/delete. When the
user says "cancel the dentist reminder", find it by name/prompt and confirm before deleting.

Smart nudges: for habits ("drink water", "stretch"), propose sensible hours (not at night)
and a way to stop ("reply 'stop water' anytime").
