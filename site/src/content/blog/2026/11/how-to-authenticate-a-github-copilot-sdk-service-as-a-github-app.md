---
title: "How to Authenticate a GitHub Copilot SDK Service as a GitHub App with the Copilot Requests Permission"
description: "Run the GitHub Copilot SDK from a backend service with no signed-in user: create a GitHub App with the read-only Copilot Requests organization permission, mint a one-hour ghs_ installation token, pass it through gitHubToken with useLoggedInUser false, and rotate it before it expires. Covers the GitHub Actions shortcut, billing to the organization, the troubleshooting table, and why gitHubTokenProvider cannot hold installation tokens. @github/copilot-sdk 1.0.34, public preview since October 27, 2026."
pubDate: 2026-11-28
template: "how-to"
tags:
  - "github-copilot"
  - "ai-agents"
  - "copilot-sdk"
  - "github-apps"
  - "authentication"
---

**Short answer:** create a GitHub App, give it the **Copilot Requests** *organization* permission set to **Read-only**, and install it on the organization that should pay for the usage. Your service signs a JWT with the app's private key, exchanges it for an installation access token (a `ghs_` token) that asks for `{"organization_copilot_requests": "read"}`, and passes that token to the SDK's explicit token option (`gitHubToken` in TypeScript and .NET, `github_token` in Python, `GitHubToken` in Go) together with `useLoggedInUser: false`. The token lives for one hour, so mint a new one before it expires and restart the client with it. Inside GitHub Actions you do not need any of this: grant the job `copilot-requests: write` and use the built-in `GITHUB_TOKEN`.

GitHub shipped this as a public preview on [October 27, 2026](https://github.blog/changelog/2026-10-27-github-copilot-supports-server-to-server-authentication/). The code below targets `@github/copilot-sdk` 1.0.34 (published November 19, 2026, bundling Copilot CLI runtime 1.0.112) and `@octokit/auth-app` 8.3.1. Both TypeScript samples in this post were type-checked with `tsc` 5.9.3 against both packages. It was not run against a live organization, because that needs a real GitHub App installation with Copilot billing, so the runtime behavior described here comes from [GitHub's server-to-server docs](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens) and the SDK's own type definitions.

## Why a service needs its own Copilot identity

Until this preview, every Copilot SDK request had to be backed by a person. The SDK starts the Copilot CLI runtime, and the runtime authenticates with whatever it can find: a stored OAuth login from `copilot login`, the `gh` CLI's token, or a token in `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`. All of those resolve to a user with a Copilot seat. That is fine for a desktop tool, and awkward for anything that runs unattended:

- A PR-review bot, a nightly triage job or an internal "summarize this incident" endpoint ends up running on some engineer's personal access token.
- Usage and spend show up against that engineer, not against the service.
- When the engineer leaves, rotates the token or loses their seat, the service breaks.
- The token usually carries far more scope than "make Copilot requests".

The usual workaround was a "machine user": a fake GitHub account with a seat and a fine-grained PAT. It costs a seat, it is a shared secret, and it is the kind of thing security reviews flag. Server-to-server auth replaces it with a GitHub App installation, which is the standard GitHub way to give software (not people) scoped, short-lived credentials. Per the changelog, usage is "attributed and billed to the organization that owns the installation", and the organization's model policies, budgets and spending controls apply to it.

## First check: are you inside GitHub Actions?

If the code that calls the SDK runs in a GitHub Actions job, skip the GitHub App entirely. The docs say the built-in `GITHUB_TOKEN` can make Copilot requests when the workflow grants the `copilot-requests` permission:

```yaml
# .github/workflows/copilot-sdk.yml
# GitHub Actions, @github/copilot-sdk 1.0.34
name: copilot-sdk-job
on: workflow_dispatch

permissions:
  contents: read
  copilot-requests: write

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: node dist/job.js
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The organization's **Allow use of Copilot CLI billed to the organization** policy must be enabled for this to work. There is no app and no stored secret. This is the same mechanism GitHub Agentic Workflows moved to when they [dropped the personal access token requirement](/2026/06/github-agentic-workflows-without-a-personal-access-token/).

Everything below is for the other case: a container on your own infrastructure, a Lambda, a Kubernetes job, a Jenkins or GitLab runner, or any long-lived backend.

## Step 1: create the GitHub App with the right permission

In the organization's settings, go to **Developer settings > GitHub Apps > New GitHub App**. For a service that only needs Copilot:

- **Webhook**: uncheck **Active**. The app never receives events.
- **Callback URL / user authorization**: leave empty. No user ever signs in through this app.
- **Organization permissions > Copilot Requests**: **Read-only**.
- **Repository permissions**: none, unless the same app also has to read code. Add them deliberately if it does.
- **Where can this GitHub App be installed?**: **Only on this account**.

Create the app, note its **Client ID** (`Iv23...`) or numeric **App ID**, and generate a private key. GitHub downloads a `.pem` file once. Store it in your secret manager, not in the repo.

The permission is organization-level and read-only. Older revisions of the doc told people to look for a *repository* permission named Copilot Requests set to Read & write, which does not exist in the GitHub App UI. That mismatch is what [Copilot SDK issue #2304](https://github.com/github/copilot-sdk/issues/2304) reported in August 2026. If a blog post or an old answer tells you to set a repository permission, it predates the current docs.

## Step 2: install the app on the organization that pays

Install the app on the organization whose Copilot budget should cover the service. Billing follows the installation, not the app's owner: if your platform team owns the app but installs it on two business-unit organizations, each installation is billed to its own organization.

After installing, grab the installation ID. It is the number at the end of the installation's settings URL (`https://github.com/organizations/<org>/settings/installations/<id>`), or you can list it with the app JWT later via `GET /app/installations`.

The docs also say "the organization must be enabled for Copilot requests from GitHub App installations". If that switch is off, the token exchange succeeds but Copilot rejects the request with a 403, which is covered in the troubleshooting section.

## Step 3: mint an installation access token

The token exchange is plain GitHub App auth. Sign a short JWT with the private key, then `POST /app/installations/{installation_id}/access_tokens`. Asking for only the Copilot permission in the request body keeps the token as narrow as possible, even if the app later gains other permissions:

```bash
# Bash + openssl + curl + jq, GitHub REST API 2022-11-28
CLIENT_ID="Iv23liExample"            # or the numeric App ID
INSTALLATION_ID="12345678"
KEY="./copilot-service.private-key.pem"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now-60)) $((now+540)) "$CLIENT_ID" | b64url)
sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$KEY" | b64url)
JWT="$header.$payload.$sig"

curl -s -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/app/installations/$INSTALLATION_ID/access_tokens" \
  -d '{"permissions":{"organization_copilot_requests":"read"}}' \
  | jq '{token, expires_at, permissions}'
```

The response carries a `ghs_...` token, an `expires_at` one hour out, and the granted `permissions` map, which should show `"organization_copilot_requests": "read"`. If the map does not include it, the app does not have the permission or the installation has not accepted the updated permissions yet. Organization owners have to approve permission changes on existing installations.

The JWT `iat` is backdated by 60 seconds to absorb clock drift, and `exp` stays under GitHub's 10-minute limit.

## Step 4: pass the token to the SDK, and turn off ambient auth

The SDK option names differ per language, but the shape is the same everywhere: an explicit token plus "do not go looking for a logged-in user". From the docs:

| Language | Token option | Disable ambient auth |
| --- | --- | --- |
| TypeScript (`@github/copilot-sdk`) | `gitHubToken` | `useLoggedInUser: false` |
| Python (`copilot`) | `github_token` | `use_logged_in_user=False` |
| Go (`github.com/github/copilot-sdk/go`) | `GitHubToken` | `UseLoggedInUser: copilot.Bool(false)` |
| .NET (`GitHub.Copilot`) | `GitHubToken` | `UseLoggedInUser = false` |
| Rust (`github_copilot_sdk`) | `.with_github_token(token)` | `.with_use_logged_in_user(false)` |
| Java (`com.github.copilot`) | `.setGitHubToken(token)` | `.setUseLoggedInUser(false)` |

`useLoggedInUser: false` matters more than it looks. The SDK's own doc comment says that when it is false, "only explicit tokens such as gitHubToken are used; environment variable tokens (COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN) are ignored." In TypeScript it already defaults to false when `gitHubToken` is set, but set it explicitly anyway. On a build agent that also has `gh` logged in, or a container with a stray `GH_TOKEN`, you want a hard failure, not a silent fallback that bills a person.

The minimal TypeScript version:

```typescript
// @github/copilot-sdk 1.0.34, Node 22+
import { CopilotClient, RuntimeConnection, approveAll } from "@github/copilot-sdk";

const token = process.env.INSTALLATION_TOKEN;
if (!token) throw new Error("INSTALLATION_TOKEN is required");

const client = new CopilotClient({
  connection: RuntimeConnection.forStdio(),
  gitHubToken: token,
  useLoggedInUser: false,
});
await client.start();

const session = await client.createSession({ onPermissionRequest: approveAll });
const reply = await session.sendAndWait({ prompt: "Say hello from a GitHub App." });
console.log(reply?.data.content);

await session.disconnect();
await client.stop();
```

Python is the same idea:

```python
# Copilot SDK for Python, same release train as @github/copilot-sdk 1.0.34
import os
from copilot import CopilotClient, RuntimeConnection

client = CopilotClient(
    connection=RuntimeConnection.for_stdio(),
    github_token=os.environ["INSTALLATION_TOKEN"],
    use_logged_in_user=False,
)
```

If your SDK client connects to an *existing* runtime by URI instead of spawning one over stdio, the docs say to set the token as `COPILOT_GITHUB_TOKEN` on the runtime process itself, because the client is not the one authenticating.

`approveAll` is used here because the example asks a plain question. A real service that lets the agent run shell commands or edit files should write a narrower permission handler. The [Copilot SDK overview](/2026/10/what-is-the-github-copilot-sdk-and-what-can-you-build-with-it/) covers the permission model and the tool surface.

## Step 5: rotate the token before the hour runs out

Installation tokens "expire after one hour", and the docs' refresh guidance is blunt: mint a new token before the current one expires, and for a child process, restart the SDK client with the new token. There is no "swap the token on a running client" API for this case.

Here is a complete service that does that. It uses `@octokit/auth-app` to sign the JWT and exchange it, and keeps one live client that is replaced ten minutes before expiry:

```typescript
// @github/copilot-sdk 1.0.34, @octokit/auth-app 8.3.1, Node 22+
import { readFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { CopilotClient, RuntimeConnection, approveAll } from "@github/copilot-sdk";

const appAuth = createAppAuth({
  appId: process.env.GH_APP_CLIENT_ID!, // client ID ("Iv23...") or numeric app ID
  privateKey: readFileSync(process.env.GH_APP_PRIVATE_KEY_PATH!, "utf8"),
  installationId: Number(process.env.GH_APP_INSTALLATION_ID),
});

async function mintInstallationToken(): Promise<{ token: string; expiresAt: Date }> {
  const auth = await appAuth({
    type: "installation",
    refresh: true, // skip the auth-app cache so we always get a full hour
    permissions: { organization_copilot_requests: "read" },
  });
  return { token: auth.token, expiresAt: new Date(auth.expiresAt) };
}

async function startClient(token: string): Promise<CopilotClient> {
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio(),
    gitHubToken: token,
    useLoggedInUser: false,
  });
  await client.start();
  return client;
}

let { token, expiresAt } = await mintInstallationToken();
let client = await startClient(token);

const ROTATE_EARLY_MS = 10 * 60 * 1000;
setInterval(async () => {
  if (expiresAt.getTime() - Date.now() > ROTATE_EARLY_MS) return;
  const next = await mintInstallationToken();
  const nextClient = await startClient(next.token);
  const old = client;
  client = nextClient;
  expiresAt = next.expiresAt;
  await old.stop();
}, 60 * 1000);

export async function summarize(text: string): Promise<string | undefined> {
  const session = await client.createSession({ onPermissionRequest: approveAll });
  try {
    const reply = await session.sendAndWait({ prompt: `Summarize:\n\n${text}` });
    return reply?.data.content;
  } finally {
    await session.disconnect();
  }
}
```

Three details in that file are deliberate:

1. **`refresh: true`.** `@octokit/auth-app` caches installation tokens for "1 minute less than GitHub expiry", measured from when it cached them. Without `refresh`, a rotation call can get back the token you are trying to replace, with a minute of life left. Forcing a fresh exchange always gives you close to a full hour.
2. **Start the new client before stopping the old one.** Sessions created on the old client keep working until it stops, and new requests go to the new client as soon as the reference is swapped. For long agent sessions that can outlive the window, either keep them under the rotation margin or accept that a rotation ends them.
3. **The private key never reaches the runtime.** Only the one-hour `ghs_` token is handed to the Copilot CLI process. If that process or its tools leak the environment, the blast radius is one hour of Copilot requests for one organization, not the app's identity.

For batch jobs that finish well inside an hour, you can skip rotation entirely: mint once at startup, run, exit.

## Why `gitHubTokenProvider` does not solve rotation here

The SDK has a session-level `gitHubTokenProvider` callback that looks like exactly the right hook: the runtime calls it for the initial token and again on refresh. It does not work with installation tokens. The SDK's type definition requires the callback to return an `expiresIn`, and its doc says "it must exceed the one-hour preflight refresh threshold, and still exceed it after the runtime validates the token". The same comment notes that "production GitHub tokens typically last eight hours".

An installation token is born with at most 3600 seconds of life, so it can never pass that check. Session creation is rejected, not downgraded to ambient auth. Stick with client-level `gitHubToken` and restart-on-rotate until GitHub changes either the threshold or the token lifetime.

Do not confuse that with the session-level `gitHubToken` either. Per the SDK, it sets the identity used for "content exclusion, model routing, and quota checks" for one session, which is meant for multitenant hosts serving several users. For a single service identity, the client-level option is the one the server-to-server docs use.

## Troubleshooting: what each error means

The docs ship a symptom table. Here it is with the fix you will most likely need:

- **`401 Unauthorized`**: the token is expired or malformed. Usually a rotation bug: a client still running on a token older than an hour.
- **`403` that says Copilot requests with GitHub App installation access tokens are not enabled**: the organization has not enabled Copilot requests from GitHub App installations. That is an organization owner setting, not something the app can fix.
- **`No GitHub OAuth token or Copilot HMAC key provided` or `Not authenticated`**: the token never reached the runtime. With `useLoggedInUser: false` the runtime ignores `COPILOT_GITHUB_TOKEN`, so setting the env var on a stdio-spawned client does nothing. Pass it through the explicit option.
- **`403 Forbidden` from the Copilot API**: the installation lacks the organization Copilot Requests permission, or the owner has not approved it yet. Approve it, then mint a new token: an existing token does not pick up new permissions.
- **Requested model is unavailable**: the organization's Copilot policy does not allow that model, or the bundled runtime does not know it. The service gets exactly the models the organization allows, not the ones your personal seat sees.
- **The wrong organization is billed**: the installation ID points at a different organization's installation. Check `GET /app/installations` with the app JWT.

## Billing, audit and turning it off

Usage lands on the organization that owns the installation, under its budgets and spending controls. In AI usage CSV reports, app-attributed usage carries an `app_client_id` field, so finance can split service spend from human spend. If you also want per-session ceilings inside the service, the [AI credit session limits in the Copilot CLI and SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/) still apply on top of organization budgets.

To cut a service off, an organization owner suspends or uninstalls the app, which ends that installation's access to Copilot. That kill switch is a large part of the case for an app over a machine user: nobody has to find and revoke a PAT.

Two caveats worth writing into your runbook while this is a public preview:

- The docs page carries no last-updated date, and its permission guidance has already changed once. Re-read it before you wire this into a production pipeline.
- The changelog presents this as organization-scoped. There is no mention of user-owned app installations or enterprise-level installations, so plan around one installation per paying organization.

## Related

- [What the GitHub Copilot SDK is and what you can build with it](/2026/10/what-is-the-github-copilot-sdk-and-what-can-you-build-with-it/)
- [The Copilot SDK GA release and embedding the runtime in C#](/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/)
- [Running GitHub Agentic Workflows without a personal access token](/2026/06/github-agentic-workflows-without-a-personal-access-token/)
- [Per-session AI credit limits in the Copilot CLI and SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/)
- [Using the Copilot CLI as a Microsoft Agent Framework agent](/2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent/)

## Sources

- [GitHub Changelog: GitHub Copilot supports server-to-server authentication (October 27, 2026)](https://github.blog/changelog/2026-10-27-github-copilot-supports-server-to-server-authentication/)
- [GitHub Docs: Server-to-server authentication for the Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens)
- [GitHub Docs: Generating an installation access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub Docs: Generating a JSON Web Token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
- [Copilot SDK issue #2304: no "Copilot Requests" permission in GitHub Apps](https://github.com/github/copilot-sdk/issues/2304)
- [`@github/copilot-sdk` on npm](https://www.npmjs.com/package/@github/copilot-sdk) and [`@octokit/auth-app` on npm](https://www.npmjs.com/package/@octokit/auth-app)
