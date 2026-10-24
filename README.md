# Kronos Agent — website

Landing page for **Kronos Agent**, the open-source agent that grows with you.

Static site, no build step:

| File | Purpose |
| --- | --- |
| `index.html` | The page |
| `styles.css` | All styling |
| `main.js` | Install tabs, copy buttons, OS detection, terminal demo, scroll reveal |
| `assets/img/` | Optimised artwork (WebP), favicons, Open Graph image |
| `install.sh`, `install.ps1` | Placeholder installers served at `/install.sh` and `/install.ps1` |
| `vercel.json` | Caching and header config for Vercel |

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

The site is deployed on Vercel as a static project (no framework, no build command).
Install commands on the page use the current domain automatically, so they stay correct on any custom domain.

## Before launch

- Replace `install.sh` / `install.ps1` with the real installers.
- Point the desktop download buttons in `index.html` (`#desktop` section) at the real release assets.
