---
title: "Fix: GitHub Copilot can't see a file because a content exclusion rule excludes it"
description: "\"File is configured to be ignored by Copilot\" or \"Some files were excluded from the context\" means a content exclusion rule matched. How to find the rule, why globs over-match, and how to narrow it."
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "github-copilot"
  - "ai-agents"
  - "content-exclusion"
  - "security"
---

If Copilot answers as if a file doesn't exist, its agent tool fails with `File <path> is configured to be ignored by Copilot`, or chat adds "Some files were excluded from the context due to content exclusion rules", then a content exclusion rule matched that file. It is not an indexing bug and reindexing won't bring the file back. Hover the Copilot status bar icon to see which level set the rule. Then read the rule text in the repository's **Settings > Copilot > Content exclusion** page, or ask an org owner to pull it with `GET /orgs/{org}/copilot/content_exclusion`. Fix the pattern (the usual culprit is a bare file name such as `config.json` that matches in every folder), then run **Developer: Reload Window** instead of waiting up to 30 minutes.

Versions this applies to: VS Code 1.138 (the Copilot Chat extension now lives in the `microsoft/vscode` repo, and the matching code quoted below is from its `extensions/copilot` folder as of September 2026), Copilot CLI 1.0.85, and the GitHub Copilot app. Content exclusion became [generally available in the Copilot app and CLI on 2026-09-02](https://github.blog/changelog/2026-09-02-content-exclusions-generally-available-in-copilot-app-and-cli/). The management REST API is still in public preview under `X-GitHub-Api-Version: 2026-03-10`. Content exclusion only exists on Copilot Business and Copilot Enterprise.

## What an excluded file looks like on each surface

The rule is set on GitHub, but each client has its own way of telling you it applied. None of these messages include the pattern that matched, which is why the problem usually gets reported as "Copilot can't find my file".

| Surface | What you see |
| --- | --- |
| VS Code inline suggestions | No ghost text in that file. The Copilot status bar icon is crossed out, and the completions status reads "Inactive". Internally the document is rejected with "Document is blocked by repository policy" |
| VS Code chat, file attached with `#file` | The reference is dropped from the request and the file path is cut out of your prompt text. When the prompt had to leave excluded files out, the reply ends with **Note:** "Some files were excluded from the context due to content exclusion rules" |
| VS Code agent file tools (read, edit, apply patch) | The tool call fails with `File <path> is configured to be ignored by Copilot` and the agent usually reports it can't access the file |
| VS Code `#codebase` / workspace search | Excluded files are never indexed and are filtered out of search results, so semantic search behaves as if they don't exist |
| VS Code local code review | "All input documents are ignored by configuration. Check your .copilotignore file." when every changed file is excluded |
| Copilot code review on github.com | Excluded files are not reviewed, so a PR that only touches excluded files gets no useful comments |
| Copilot CLI and the Copilot app | Excluded files are not used as context. The CLI also refuses shell commands that reference an excluded path |

The strings for VS Code come from the extension source, which is MIT-licensed and public, so you can grep for them yourself.

## Confirm it's content exclusion and not something else

Three other things produce the same "Copilot ignores this file" symptom: `files.exclude` or `search.exclude` hiding the file from workspace search, the file being too large for inline suggestions, and the file sitting outside the workspace folder. Rule those out quickly:

1. **Status bar tooltip.** Open the file and hover the Copilot icon. For content exclusion, [GitHub's troubleshooting page](https://docs.github.com/en/copilot/how-tos/troubleshoot-copilot/troubleshoot-common-issues) says the icon has a diagonal line and the tooltip names the settings that applied the restriction (repository or organization).
2. **Chat Debug view.** Every time VS Code fetches rules it adds a `contentExclusion` entry to the Chat Debug view titled "Content Exclusion Rules". It lists how many repositories were queried and the total glob rules (`totalGlobRules`). A count of zero means content exclusion is not your problem.
3. **Debug log.** Run **Developer: Set Log Level...**, set **GitHub Copilot Chat** to **Debug**, reproduce, and open the Output panel. A match logs the exact pattern:

```text
File /Users/dev/code/payments-api/src/Config/Secrets.json is ignored by content exclusion rule secrets.json
```

That log line is the fastest way to answer "which rule?" without admin access, because the Copilot client downloads the rules for your repository and matches them locally.

One more source to check if the log shows no rule: VS Code also honours a local `.copilotignore` file in the workspace whenever content exclusion is enabled for your account. It isn't in GitHub's docs, but it's in the extension's ignore service and it's what that code review message refers to. Run `git ls-files '*.copilotignore'` and look in untracked folders too.

## Find the rule and who owns it

Rules come from three levels, and the level decides who can change them:

- **Repository**: repository admins, under **Settings > Copilot > Content exclusion** in that repo. Applies to every Copilot user in the enterprise working in that repo.
- **Organization**: org owners, under the org's **Settings > Copilot > Content exclusion**. Applies only to users who get their Copilot seat from that organization.
- **Enterprise**: enterprise owners, under **AI controls > Copilot > Content exclusion**. Applies to every Copilot user in the enterprise.

On the repository page, inherited org and enterprise rules show up as gray boxes at the top that you can't edit. If the matching pattern is in a gray box, a repository admin can't fix it. Send it to an org or enterprise owner.

An org owner can dump the org-level rules with the REST API. Classic tokens need the `copilot` or `read:org` scope:

```bash
# GitHub REST API version 2026-03-10, endpoint in public preview
gh api \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  /orgs/my-org/copilot/content_exclusion
```

The response is an object whose keys are repository references (or `"*"`) and whose values are arrays of paths. Two caveats from the endpoint docs: comments in the rules are not returned, and if the configuration has duplicate keys only the last one comes back. If someone wrote `payments-api:` twice in the settings box, the API output is not the whole story, so compare it with the settings page before concluding a rule is absent.

To find out when a rule changed and who changed it, the org audit log records every save as `copilot.content_exclusion_changed`, with the full `excluded_paths` after the change. The "last edited" link at the bottom of the content exclusion page jumps straight there.

## Why the rule matches more files than you meant

The exclusion syntax is documented as "fnmatch pattern matching notation". In VS Code, the matcher is `minimatch` with these options:

```ts
// microsoft/vscode extensions/copilot/src/platform/ignore/node/remoteContentExclusion.ts (2026-09)
const MINIMATCH_OPTIONS = {
	nocase: true,
	matchBase: true,
	nonegate: true,
	dot: true
};
```

Each file is tested twice: once against its path relative to the repository root, lowercased and with a leading `/` (for example `/src/config/secrets.json`), and once against its full absolute path. `matchBase: true` means a pattern *without* a slash is matched against the file name alone, in any directory. That's the setting behind most "why is this file excluded?" reports.

I reproduced that matching logic with `minimatch` 10.2.1 (the version range the extension declares) against a fake repository to see which patterns hit what:

```js
// probe.mjs - Node 22, minimatch 10.2.1
// Mirrors RemoteContentExclusion.isIgnored glob matching in VS Code's Copilot code
import { Minimatch } from 'minimatch';
const OPTS = { nocase: true, matchBase: true, nonegate: true, dot: true };
const repoRoot = '/Users/dev/code/payments-api';
const files = ['src/Config/Secrets.json', 'secrets.json', 'src/app.cfg', 'deploy/prod/.env',
  'scripts/build.sh', 'scripts/tools/seed.sh', 'src/generated/Client.g.cs', 'docs/README.md'];
const patterns = ['/src/config/secrets.json', 'src/config/secrets.json', 'secrets.json', '*.cfg',
  '.env', '/scripts/*', '/scripts/**', 'scripts/', '/scripts', '**/generated/**', '*.md', '!docs/README.md'];

for (const p of patterns) {
  const g = new Minimatch(p, OPTS);
  const hits = files.filter(f => {
    const full = `${repoRoot}/${f}`;
    const rel = full.toLowerCase().replace(repoRoot.toLowerCase(), '');
    return g.match(rel) || g.match(full);
  });
  console.log(`${p.padEnd(28)} -> ${hits.join(', ') || '(nothing)'}`);
}
```

Output:

| Pattern | Files it excludes |
| --- | --- |
| `/src/config/secrets.json` | `src/Config/Secrets.json` |
| `src/config/secrets.json` | nothing |
| `secrets.json` | `src/Config/Secrets.json`, `secrets.json` |
| `*.cfg` | `src/app.cfg` |
| `.env` | `deploy/prod/.env` |
| `/scripts/*` | `scripts/build.sh` |
| `/scripts/**` | `scripts/build.sh`, `scripts/tools/seed.sh` |
| `scripts/` | nothing |
| `/scripts` | nothing |
| `**/generated/**` | `src/generated/Client.g.cs` |
| `*.md` | `docs/README.md` |
| `!docs/README.md` | nothing |

What that table tells you:

- **A bare file name excludes that name everywhere.** `secrets.json`, `.env`, `config.json`, and `*.md` all match in every directory, and matching ignores case (`Secrets.json` in `src/Config/` is caught). Someone who wanted to hide one root `appsettings.json` and wrote `appsettings.json` has hidden every `appsettings.json` in a monorepo.
- **A path without a leading slash matches nothing.** `src/config/secrets.json` contains a slash, so `matchBase` doesn't kick in, and it isn't anchored the way the relative path string is. The rule looks right in review and does nothing. If a file you *expected* to be excluded is still visible, check for this.
- **A directory name alone doesn't exclude its contents.** `scripts/` and `/scripts` match nothing. Use `/scripts/**` for the whole tree or `/scripts/*` for direct children only.
- **Negation is not supported.** With `nonegate`, `!docs/README.md` is a literal pattern that matches nothing. You can't carve a file back out of a broad rule. Narrow the broad rule instead.

## Fix the rule

Rewrite the over-matching rule so it's anchored to the path you meant. A before and after for a repository-level rule:

```yaml
# Before: hides every appsettings.json and every file under any "secrets" folder
- "appsettings.json"
- "**/secrets/**"

# After: only the root production settings file and the one secrets folder
- "/src/Payments.Api/appsettings.Production.json"
- "/deploy/secrets/**"
```

For an org-level rule, the same fix goes under the repository key:

```yaml
payments-api:
  - "/src/Payments.Api/appsettings.Production.json"
  - "/deploy/secrets/**"
```

If you manage org rules through the API, be careful with the `PUT` endpoint. It replaces the whole rule set, deletes any comments that were in the settings box, and keeps only the last occurrence of a duplicate key:

```bash
# GitHub REST API version 2026-03-10, endpoint in public preview
# Replaces ALL org-level rules. GET first and merge, or you will drop other repos' rules.
gh api --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  /orgs/my-org/copilot/content_exclusion \
  --input rules.json
```

```json
{
  "payments-api": [
    "/src/Payments.Api/appsettings.Production.json",
    "/deploy/secrets/**"
  ],
  "*": ["**/.env"]
}
```

## Make your client pick up the change

Rules are cached on the client. [GitHub's docs](https://docs.github.com/en/copilot/how-tos/configure-content-exclusion/exclude-content-from-copilot#propagate-content-exclusion-changes-to-your-ide) say a change can take up to 30 minutes to reach an IDE that already loaded the old ones. That matches the code, where `RULE_TTL_MS` is `30 * 60 * 1000`. To skip the wait:

- **VS Code**: run **Developer: Reload Window**.
- **Visual Studio and JetBrains IDEs**: close and reopen the application.
- **Vim/Neovim**: nothing to do, rules are fetched each time you open a file.
- **Copilot CLI and the Copilot app**: GitHub doesn't document a refresh interval. Starting a new session is the safe way to be sure the new rules were fetched.

Then test the way the docs suggest: open the file, close every other editor, make sure it's the attached context file, and ask chat to "explain this file". If the exclusion is gone, the file shows up as a reference in the answer.

## Gotchas that make this harder to diagnose

**Multi-root workspaces share globs.** In the current VS Code code, glob rules fetched for every repository in the window are compiled into one list and every file is tested against all of them. A bare `README.md` rule scoped to repo A can hide `README.md` in repo B if both are open in the same window. Anchored paths (`/docs/README.md`) keep the overlap small. Open the repositories in separate windows to confirm.

**Repository rules are keyed by git remote.** The client finds the repository's rules through its remote fetch URLs. A folder with no remote, a clone whose remote points at an internal mirror, or a copy downloaded as a ZIP gets only the `"*"` rules. That explains "the exclusion works for my teammate but not for me".

**Symlinks and remote filesystems are officially out of scope.** The [content exclusion docs](https://docs.github.com/en/copilot/concepts/context/content-exclusion) say rules don't apply to symbolic links or to repositories on remote filesystems. VS Code's agent file tools do check both the link and its resolved target now, but don't rely on that for anything sensitive.

**VS Code agent mode is not a supported surface.** The docs still list Edit and Agent modes in VS Code as unsupported. In practice the file tools refuse excluded paths, but nothing stops the agent from running `cat` in the terminal. The Copilot CLI is stricter: it inspects shell commands for excluded paths, and its changelog shows several rounds of false positives being fixed (PowerShell redirects in 1.0.62, command names, phantom paths and `$()` sub-expressions in 1.0.64). If a CLI shell command is refused for no obvious reason, update the CLI first.

**Outages used to fail open.** Before VS Code 1.132, a rate-limited rules fetch looked the same as "no rules", and a file checked during that window stayed allowed ([microsoft/vscode#328268](https://github.com/microsoft/vscode/pull/328268)). Copilot CLI 1.0.64 went the other way: it used to block every file when the rules service was unreachable, and now allows access until rules can be fetched. So an exclusion that seems to come and go on a flaky network may be a client version issue, not a rule issue.

**The IDE can still leak semantic information.** Type information, hover definitions, and build configuration that the IDE hands to Copilot can come from an excluded file. Content exclusion limits what Copilot reads directly. It is not a hard boundary.

**Third-party agents ignore it.** The [supported surfaces table](https://docs.github.com/en/copilot/reference/supported-surfaces-for-policies) marks content exclusion as supported for IDEs, Copilot cloud agent, Copilot CLI, the Copilot app, Copilot Chat on GitHub, and Copilot code review, and not supported for third-party agents or Spark.

Finally, don't work around a rule you can't change by pasting the file into chat. The rule exists because someone with admin rights decided that content shouldn't reach the model. If the rule is wrong, fix the rule.

## Related

- If Copilot ignores your instructions rather than your files, see [why GitHub Copilot ignores repository custom instructions in VS Code](/2026/05/fix-github-copilot-ignores-repository-custom-instructions-in-vs-code/).
- For what Copilot does read by default, see [Copilot Memory vs repository custom instructions vs AGENTS.md](/2026/09/copilot-memory-vs-repository-custom-instructions-vs-agents-md/).
- The same enterprise policy layer also controls tools: [Copilot MCP allowlists in enterprise managed settings](/2026/08/copilot-mcp-allowlists-enterprise-managed-settings/).
- Claude Code's take on keeping secrets away from an agent's shell: [blocking credentials from Bash with the sandbox](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/).
- For a side-by-side of the agents themselves: [Claude Code vs Cursor vs Copilot agent mode](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/).

## Sources

- [Content exclusions generally available in Copilot app and CLI](https://github.blog/changelog/2026-09-02-content-exclusions-generally-available-in-copilot-app-and-cli/) (GitHub Changelog, 2026-09-02)
- [Content exclusion for GitHub Copilot](https://docs.github.com/en/copilot/concepts/context/content-exclusion)
- [Excluding content from GitHub Copilot](https://docs.github.com/en/copilot/how-tos/configure-content-exclusion/exclude-content-from-copilot)
- [Reviewing changes to content exclusions](https://docs.github.com/en/copilot/how-tos/configure-content-exclusion/review-changes)
- [REST API endpoints for Copilot content exclusion management](https://docs.github.com/en/rest/copilot/copilot-content-exclusion-management)
- [Supported surfaces for GitHub Copilot policies](https://docs.github.com/en/copilot/reference/supported-surfaces-for-policies)
- [`remoteContentExclusion.ts` in microsoft/vscode](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/ignore/node/remoteContentExclusion.ts)
- [microsoft/vscode#328268: coalesce content exclusion fetches and fix fail-open caching](https://github.com/microsoft/vscode/pull/328268)
- [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
