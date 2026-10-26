# GitHub

Kronos works on your GitHub repositories the way you would: it clones a repository, makes a
branch, changes and tests the code, commits, pushes and opens a pull request. It reads issues,
pull requests, review comments and CI results, and answers them. With the Kronos GitHub App
installed it also works as a bot: mention `@kronos` in an issue or pull request and it does the
work and replies — with a pull request when it changed code.

## Connect

### One click: Connect GitHub

**Settings → GitHub → Connect GitHub** (or `kronos github login` in the terminal). Kronos shows a
short code and opens GitHub; paste it, approve, done — no token to create or copy. Then click
**Install Kronos on your repositories** and pick the repositories it may work on.

This signs you in through the official Kronos GitHub App with GitHub's device flow (the same
mechanism as the GitHub CLI): Kronos acts as you, only on repositories where the app is installed,
and GitHub marks what it does with the Kronos app's badge and logo. No secret is involved — only the
app's public client id, which ships with Kronos (`github.officialApp`).

The other options below are for people who prefer a token, or want their own bot.

### Your account (personal token)

Kronos acts as you. Either

- paste a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
  with **Contents**, **Pull requests** and **Issues** set to read and write (add **Checks** and
  **Commit statuses** read for CI results) and click **Connect** — or run
  `kronos github login <token>`; the token is checked with GitHub and stored in `~/.kronos/.env`;
- or log in with the GitHub CLI (`gh auth login`): Kronos uses its token automatically.

### Your own GitHub App (bot)

Kronos acts as its own bot account (`<app>[bot]`), only on the repositories you choose, with
short-lived tokens it renews itself.

1. **Settings → GitHub → Create the GitHub App.** Optionally enter the public URL of your gateway
   (needed for `@kronos` mentions, see below) and an organization. GitHub shows the new app — you
   can rename it — click **Create**. You are sent back to Kronos and the app's credentials are
   stored in `~/.kronos/github-app.json` (readable only by you).
2. **Install on repositories** — pick all or selected repositories.

That is all: every chat can now clone and change those repositories, and the bot is ready.

To give the bot the Kronos logo, download it from the same Settings page (or use
`assets/brand/github-app-logo.png`) and upload it under **Display information** in the app's
settings on GitHub — GitHub only accepts logos uploaded there.

The app asks for: Contents, Pull requests, Issues (read & write); Metadata, Checks, Commit
statuses, Actions (read). It subscribes to issue comments, issues, pull request review comments
and reviews.

## Using it in a chat

- **+ → Open a GitHub repository** lists the repositories you can work on; pick one and Kronos
  clones it (to `~/.kronos/repos/owner/repo`, or `github.reposDir`) and opens a chat in it.
- Or just ask: _"Clone acme/widgets, fix issue #42 and open a pull request."_ The agent uses the
  `github` tool:

  | Action | Does |
  |---|---|
  | `status`, `repos` | who is connected; repositories you can work on |
  | `clone` | clone or update a repository; returns the local path |
  | `push` | push the current branch (sets upstream; `force` uses `--force-with-lease`) |
  | `create_pr` | open a pull request from the current branch (base: the default branch) |
  | `pr`, `diff`, `review_comments` | a pull request with its files and comments, its diff, inline review comments |
  | `prs`, `issues`, `issue` | lists and details, with comments |
  | `comment`, `create_issue` | write on issues and pull requests |
  | `checks` | CI results for a branch, tag or commit |

- Plain `git` in the agent's shell is authenticated for GitHub checkouts too (`git pull`,
  `git push`), with the app's token where it is installed and yours otherwise.
- Pushing, opening pull requests and commenting count as outward-facing actions: in *Ask* mode
  Kronos asks before each one.

## The bot: `@kronos` in issues and pull requests

When an owner, member or collaborator writes `@kronos <request>` (or `@<your-app-name>`) in

- an issue comment or a new issue → Kronos works on a fresh branch `kronos/issue-<n>-…` and
  opens a pull request that closes the issue;
- a pull request comment, review or inline review comment → it works on the pull request's
  branch and pushes there (for pull requests from forks it opens a follow-up pull request);
- a question → it just answers.

It reacts with 👀, posts "Kronos is on it", runs the agent in a dedicated checkout with the issue
or pull request (description, recent comments, the commented code) as context, commits, pushes,
and edits its comment into the result with the link. Runs on one repository are queued.

**Requirements:** the Kronos GitHub App, and a gateway GitHub can reach (`kronos gateway` with
`gateway.publicUrl`, e.g. behind a reverse proxy or a tunnel such as Cloudflare Tunnel or ngrok).
Set the public URL before creating the app, or later under the app's **Webhook** settings on
GitHub (`https://<public-url>/hooks/github`; the secret is in `github-app.json`). Deliveries are
verified with the webhook secret; anything unsigned is rejected.

Settings (`github.bot`): `enabled`, `trigger` (default `@kronos`), `allowed` author associations
(default owner, member, collaborator), `mode` (default `yolo` — it runs unattended in its own
checkout), `model` (default: your default model), `maxMinutes` (default 30).

## GitHub Enterprise

Set `github.apiUrl` (e.g. `https://ghe.example.com/api/v3`) and `github.webUrl`
(`https://ghe.example.com`). App creation, tokens and git all follow them.

## Security notes

- Tokens are never written into git config or command lines: git receives them per command as an
  `http.extraheader` through `GIT_CONFIG_*` environment variables. Output that would show them is
  redacted.
- App installation tokens last one hour and only cover the repositories the app is installed on.
- Only people with write access (owner/member/collaborator by default) can trigger the bot; bots
  cannot trigger it, and each webhook delivery is handled once.

## Maintainers: publishing the official Kronos GitHub App

"Connect GitHub" needs one public app that everyone signs in through. Creating it takes a few
minutes, once:

1. In Kronos: **Settings → GitHub → Your own GitHub App**, tick **Public**, name it (e.g.
   `Kronos Agent`) and click **Create the GitHub App** (under an organization if it should belong
   to one).
2. On GitHub, open the app's settings:
   - **General → Display information:** upload `assets/brand/github-app-logo.png`;
   - **General → Identifying and authorizing users:** tick **Enable Device Flow**;
   - **Optional features:** opt out of **User-to-server token expiration** (device-flow tokens
     cannot be refreshed without the client secret, which must never ship);
   - **Webhook:** turn it off unless you run a public gateway for it.
3. Put the app's **slug** and **Client ID** (both on the General page) into
   `github.officialApp` in `packages/core/src/config/schema.ts` and release. Every Kronos with that
   build gets the one-click **Connect GitHub** button.
