---
name: daily-briefing
description: Compile a concise morning briefing — weather, calendar, news on chosen topics, markets, open tasks, reminders — and deliver it on a schedule to Telegram/Discord/Slack/email or the desktop. Use for "daily briefing", "morning summary", "every morning tell me…".
version: 1.1.0
category: productivity
tags: [briefing, cron, news, weather, schedule]
requires:
  toolsets: [web, cron, messaging, memory]
---

# Daily briefing

## Set it up (once)

1. Ask (or read from USER.md memory): location (for weather), topics/sources, tickers,
   delivery channel and time, language, length.
2. Save the preferences to memory (`memory` tool, target `user`) so future runs and edits
   don't need to ask again.
3. Create the job with `cron_create`, e.g. schedule `"every weekday at 7:30"`, prompt
   `"Run the daily-briefing skill for the user and deliver it."`, `skills: ["daily-briefing"]`
   and `deliver_to` the chosen chat (e.g. `"telegram:<chat id>"`). Confirm the next run time
   back to the user.

## Each run

Keep it scannable in under 60 seconds of reading:

```
☀️ <Day, date> — <city> 14°/22°, light rain after 16:00 (☂️ take an umbrella)

📅 Today
• 10:00 Design review (45m)  • 15:30 Dentist

📰 Top stories (<topics>)
• <headline> — one-line why-it-matters [source]
…(max 5)

📈 Markets  BTC 68.2k (+1.4%) · USD/TRY 41.2 · AAPL 231 (−0.6%)

✅ Open tasks / reminders
• …
```

- Weather: `web_fetch https://wttr.in/<city>?format=j1` (no key needed).
- News: `web_search` with the topics and the current date; prefer reputable outlets; dedupe.
- Calendar/email/tasks: only if an MCP server or integration for them is connected.
- Deliver with `send_message` (or rely on the cron job's delivery target).

If a source fails, say so in one line rather than skipping silently.
