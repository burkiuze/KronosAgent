---
name: meeting-notes
description: Turn meeting transcripts, recordings or rough notes into clean minutes — summary, decisions, action items with owners and dates, open questions — and optionally share them or schedule follow-ups. Use when given a transcript/recording or asked to summarise a meeting.
version: 1.0.0
category: productivity
tags: [meetings, minutes, action-items, transcript, summary]
requires:
  toolsets: [files]
---

# Meeting notes

## Input

- Audio/video: transcribe first (voice transcription in Settings → Voice, or
  `whisper`/`ffmpeg` locally if installed); keep timestamps.
- Transcript text: identify speakers; fix obvious ASR errors in names and jargon using
  context and memory.

## Output template

```
# <Meeting title> — <date>
Attendees: …

## Summary
3–5 bullets: what was discussed and concluded.

## Decisions
- <decision> (owner, rationale in a few words)

## Action items
| # | Action | Owner | Due |
|---|--------|-------|-----|

## Open questions / risks
- …

## Notable quotes (optional, with timestamps)
```

Rules: action items start with a verb and have exactly one owner; mark unknown owners/dates
as "TBD" rather than guessing; don't invent decisions that weren't made; keep it under one page.

Offer next steps: save as an artifact, send to a channel (`send_message`), or schedule
reminders for the due dates with `cron_create`.
