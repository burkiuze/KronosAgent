# Performance

Kronos is meant to sit open all day — in the tray, in a browser tab, on a small server — so
idle cost has to be close to zero and streaming has to stay smooth without pinning a core.
This page lists what was measured, what was changed, and how to reproduce the numbers.

Reproduce with `npm run build && npm run bench` (headless Chromium + the offline demo model;
`KRONOS_UI_DIR=<dist>` measures another UI build). Numbers below come from a shared Linux
container with software rendering, so treat them as relative, not absolute; streaming runs vary
by roughly ±25 % between runs.

## Results

**Web UI / desktop renderer** (1440×900, dark theme)

| Scenario | Before | After |
|---|---|---|
| Idle, welcome screen — main-thread time | 78 ms/s | ~1 ms/s |
| Idle, welcome screen — layout / style passes | 60 / 119 per s | 0 / 0 per s |
| Idle, welcome screen — renderer CPU | 13.7 % | 0.2–0.4 % |
| Idle, open chat — main-thread time | 101 ms/s | ~1 ms/s |
| Idle, open chat — renderer CPU | 16.2 % | 0.2–0.5 % |
| Streaming an 8 KB Markdown answer (~330 deltas/s) — main thread | 982 ms/s (saturated) | 150–190 ms/s |
| … layout passes | 180 per s | 31 per s (one per update) |
| … renderer CPU | 124 % | 30–33 % |
| … time to show a 4.1 s stream | 8.1 s (fell behind) | 4.4 s (real time) |
| … JS heap after GC | 12.9 MB | 6.2 MB |

**Gateway / runtime** (Node, 20 demo turns across 10 sessions)

| | Before | After |
|---|---|---|
| RSS after 20 turns | 177 MB | 85–90 MB |
| Heap after 20 turns (after GC) | 51 MB | 12–14 MB |
| CPU while idle | ~21 ms/s | ~0.4–1 ms/s |
| CPU while streaming a fast model (~460 deltas/s, one UI client) | 131–145 ms/s | ~104 ms/s |
| WebSocket frames for one 21 KB answer | 5,274 | 347 |
| Context-size check per model call, ~200k-token history | 3.3 ms | 0.04 ms |
| CPU of the first turn | 506 ms | 68 ms |
| Module import time | 213 ms | 163 ms |

**Desktop shell**: a window closed to the tray gives back its renderer process (~125 MB in the
smoke test) after 10 minutes hidden; the gateway, messaging platforms and automations keep
running, and the next open rebuilds the window in about a second.

## What changed

### Idle UI: nothing runs when nothing happens

- **The logo was the biggest cost.** The sidebar hourglass had an always-on SVG (SMIL) animation;
  SMIL is not composited, so it forced a full style + layout pass every frame — forever. The sand
  now only moves while an agent is running (and never with `prefers-reduced-motion`).
- A finished plan left its in-progress item showing a spinner; it now shows a static marker unless
  the run is live.
- The status-bar clock ticked every second to show the session age; it ticks per second only
  during a run and once a minute otherwise.
- The "running" pulse animated `box-shadow` (restyle + repaint per frame); it is now a scaled,
  fading pseudo-element (transform + opacity run on the compositor). "Thinking…" breathes with
  opacity instead of a repainting gradient sweep.
- `prefers-reduced-motion` turns every animation and transition off.
- An e2e check (`idle UI does no per-frame work`) fails the build if the idle UI restyles or lays
  out more than 3× per second, so this cannot quietly come back.

### Streaming: work per frame, not per token

- Token deltas are **coalesced** per session and applied at most ~30 times a second (one store
  update and one render per flush instead of one per token). Any non-delta event flushes first, so
  ordering is preserved; hidden windows flush 4× a second.
- **Block-wise Markdown**: live text is split into top-level blocks (fenced code and indented
  continuations stay whole). Finished blocks are rendered once and memoized; only the growing last
  block is re-parsed each flush, so long answers cost the same per frame as short ones.
- Streaming code blocks without a language skip highlight.js auto-detection (which tries every
  grammar) until the block settles.
- The Markdown cache is an LRU capped at ~2 M characters instead of "500 entries, then clear", and
  streaming prefixes are never cached.
- The composer, status bar and progress rail subscribe only to the fields they show and are
  memoized, so they no longer re-render on every flush.
- Off-screen turns use `content-visibility: auto` (with remembered sizes), so long threads skip
  style, layout and paint for what is not visible.

### Streaming, second pass (profiled with CPU profiles and Chrome traces)

- **Auto-scroll without forced layout.** The view used to read `scrollHeight` after every update,
  forcing a synchronous layout of the whole thread. It now relies on native scroll anchoring: a
  1 px sentinel under the thread is the only anchor candidate, so while it is in view the browser
  keeps it there as content grows; scrolled up, nothing moves. JS scrolling is kept for discrete
  changes (new message, chat switch) and for browsers without `overflow-anchor`.
- **The busy logo** animated the sand inside its SVG, which invalidated the SVG and added a
  second layout to every frame while an agent ran (found as 60 "SVG resource invalidated"
  events per second in a trace). The whole mark now breathes with opacity instead.
- **DOMPurify is configured once.** Passing options to every `sanitize()` re-parsed and cloned the
  configuration on each call — most of the sanitizing cost per update.
- **Streaming code blocks are not highlighted** until complete (re-highlighting a growing block on
  every update is quadratic).
- **Only the live turn re-renders.** It subscribes to the stream on its own; the rest of the chat
  view no longer renders on every update.
- **The Codemaster banner** blits pre-rendered layers (background gradients, sprites) instead of
  redrawing them every frame: 37 → 29 ms/s while the menu is open.

### Runtime and gateway: load what is used, keep what is needed

- **Deltas are coalesced in the gateway**, not only in the UI: consecutive token deltas of the
  same kind are merged per session and sent at most every 32 ms (any other event flushes first,
  so clients see the same sequence). One answer went from 5,274 WebSocket frames to 347, and
  broadcasts are JSON-encoded once for all clients instead of once per client.
- The OpenAI-compatible SSE parser reads each chunk in one pass instead of re-slicing its buffer
  per line.
- Token estimates are cached per message (history is append-only) and for the frozen system
  prompt and tool schemas, so the context check before each model call no longer re-scans the
  whole conversation.

- **Playwright was loaded on the first turn** just to check whether the browser tool is available —
  ~6 MB of JavaScript and ~35 MB of heap. Availability is now a `require.resolve` check; Playwright
  loads on the first real browser action.
- The **Anthropic SDK** is imported on first use (~160 ms and ~4.5 MB that sessions not using
  Claude never pay).
- **Idle agents are capped** (8, least recently used first). Every open chat used to keep a live
  agent — history, tool specs, caches — for the life of the process. Everything an agent holds is
  persisted (messages, todos, session allow-rules and now the Codemaster state), so an evicted
  session simply rebuilds its agent on the next message.

### Desktop

- A window hidden to the tray for 10 minutes is destroyed and rebuilt on demand; tray commands and
  deep links that arrive meanwhile are queued until the new page has loaded.
- The tray menu (polled every 15 s for platform status) is only rebuilt when something it shows
  changed.

## Guidelines for contributors

- Animate only `transform` and `opacity`; anything else (box-shadow, background-position,
  width, SVG attributes via SMIL) restyles or repaints every frame.
- Nothing may animate or tick while the app is idle. If something must, gate it on a running state.
- Subscribe components to the narrowest store slice they render (`useStore` reuses shallow-equal
  results), and memoize components that sit inside the chat view.
- Large optional dependencies load lazily, at the point of use.
- Run `npm run bench` before and after a change that touches rendering or the runtime's hot paths.
