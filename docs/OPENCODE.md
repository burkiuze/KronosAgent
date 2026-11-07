# Embedded opencode engine

Kronos bundles the open-source [opencode](https://opencode.ai) CLI as a background engine so the
apps work **with no provider sign-in**: on first launch the desktop app installs opencode silently,
runs it in the background, and uses opencode's **Zen** free models. The UI only ever shows Kronos
branding — opencode is an implementation detail.

opencode is MIT/Apache-licensed; its license and copyright notices are retained by its own
installer under the Kronos home. This integration rebrands the experience, it does not relicense
opencode.

## How it works

- **Provider.** A provider `opencode` (shown as *Kronos Free*) is an OpenAI-compatible client of the
  Zen endpoint (`https://opencode.ai/zen/v1`). It is `keyRequired: false`, so it is always
  "connected" and the apps never show a provider screen. It is first in the auto-selection order, so
  a fresh install resolves `model.default: auto` to a free Zen model.
- **Engine manager** (`packages/core/src/backends/opencode.ts`, `OpencodeManager`):
  - locates an `opencode` binary, or installs one into `<kronos home>/opencode` (official installer,
    falling back to npm);
  - reads the Zen credential opencode stores on disk and exports it as `OPENCODE_API_KEY`, so the
    provider is authenticated without the user doing anything;
  - optionally runs `opencode serve` in the background.
- **Where it runs.** Only a host that opts in (`opencode.autoInstall` / `opencode.serve`) installs
  and serves — that is the **desktop app**. The CLI, gateway and tests only reuse an existing
  credential and never shell out to an installer or hit the network.

## Configuration (`config.yaml`)

```yaml
opencode:
  enabled: true       # provide the Kronos Free provider + credential discovery
  autoInstall: true   # (desktop) download + install opencode when missing
  serve: true         # (desktop) run `opencode serve` in the background
  port: 4096
model:
  default: auto        # resolves to a free Zen model
```

Env overrides: `OPENCODE_API_KEY` (Zen credential), `OPENCODE_BASE_URL` (Zen endpoint).

## Updates — always with permission

opencode's own auto-update is disabled (`OPENCODE_DISABLE_AUTOUPDATE`). The desktop app checks for a
newer engine on a delay after launch and **asks the user before updating** (also under
*Help → Check for Engine Updates…*). Nothing is updated silently.

## Model sync

The model picker stays in step with opencode:

- the live Zen catalog is fetched from the endpoint (`/models`) and merged into the picker;
- models declared in opencode's own `opencode.json` are read and registered too;
- opencode's config is watched, so adding or changing a model there updates the Kronos picker
  automatically (a `config_changed` event refreshes the UI).

## Caveat

opencode Zen's free line-up and whether a given model needs a one-time `opencode auth login` change
over time and are outside Kronos's control. The default model id is a best-effort seed; the live
`/models` list is authoritative, and the model can be changed in the picker or with
`OPENCODE_BASE_URL` / `model.default`.
