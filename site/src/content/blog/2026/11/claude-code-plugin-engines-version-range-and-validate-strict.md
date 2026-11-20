---
title: "How to Gate a Claude Code Plugin to a Version Range with engines and validate --strict"
description: "Claude Code 2.1.323 added engines[\"claude-code\"] to plugin.json. Here is how the range is read, what install, update and load do when it does not fit, and how to fail CI with claude plugin validate --strict."
pubDate: 2026-11-20
template: how-to
tags:
  - "claude-code"
  - "ai-agents"
  - "claude-code-plugins"
  - "ci"
  - "github-actions"
---

Since Claude Code 2.1.323 (released November 12, 2026), a plugin can declare which Claude Code versions it supports with `"engines": { "claude-code": ">=2.1.323" }` in `.claude-plugin/plugin.json`. A Claude Code build outside that semver range refuses to install or update the plugin and does not load a copy it cannot run, and `claude plugin validate <path> --strict` turns every manifest warning (including a malformed range) into exit code 1, which is what you want in CI. Everything below is checked against the Claude Code 2.1.329 docs, changelog and CLI bundle, current as of November 20, 2026.

## Why plugin authors needed a version floor

Before `engines` existed, a plugin had no way to say "I use a hook event, a manifest field or a mod API that only exists in recent builds." The plugin got installed anyway, and the failure showed up later as a hook that never fired or a component that silently did not load. Teams pinned Claude Code across a fleet (for example through managed settings or a pinned npm version in a container image) hit this the hardest: the marketplace moved forward, their CLI did not.

The `engines` field moves that failure to install time, with a message that tells the user what to do. And `claude plugin validate --strict` moves manifest mistakes to the pull request, before a marketplace ever serves them.

## The minimal manifest

Here is a plugin that relies on features from the 2.1.323 release and says so:

```json
// .claude-plugin/plugin.json -- Claude Code 2.1.323+
{
  "name": "release-notes-helper",
  "version": "1.4.0",
  "description": "Drafts release notes from merged PRs",
  "author": { "name": "Example Team" },
  "engines": {
    "claude-code": ">=2.1.323"
  }
}
```

The value is a normal npm-style semver range. Anything `semver.validRange` accepts works, including compound ranges:

```json
// Claude Code 2.1.323+: allow the 2.1 line from 2.1.323 on, but not a future 2.2
"engines": { "claude-code": ">=2.1.323 <2.2.0" }
```

```json
// Claude Code 2.1.323+: either of two windows
"engines": { "claude-code": "2.1.323 - 2.1.340 || >=2.1.360" }
```

Three constraints come from the parser in the 2.1.329 bundle: the range must be a string, at most 256 characters, and contain no control characters or bidirectional override characters. If any of those fail, or the string is not a valid range, the range is treated as unreadable. An unreadable range does not block anything. It is ignored, and Claude Code reports `Its Claude Code range "..." isn't a version range, so it's ignored`.

## Know which versions can read the field at all

This is the gotcha that bites first. The [plugins reference](https://code.claude.com/docs/en/plugins-reference) is explicit that `engines` requires Claude Code v2.1.323 or later, and that v2.0.15 through v2.1.75 reject a manifest containing it with an `Unrecognized key` error. In other words:

- **2.0.15 to 2.1.75**: the whole plugin fails to load because of the extra key. If you still support those builds, omit `engines` entirely.
- **2.1.76 to 2.1.322**: unknown manifest fields are tolerated, so the plugin loads, but nothing enforces the range.
- **2.1.323 and later**: the range is enforced.

So a floor below `2.1.323` documents intent but cannot protect anyone, because the builds you would be excluding are the ones that do not read the field. Set the floor to the oldest build you actually test against, and treat 2.1.323 as the practical minimum.

## Where Claude Code looks for the range

The range is not only read from `plugin.json`. The resolution order in the 2.1.329 bundle is:

1. `engines["claude-code"]` in the plugin's own `.claude-plugin/plugin.json`.
2. If the plugin is installed from an npm source and the manifest has no range, `engines["claude-code"]` in that package's `package.json`.
3. Otherwise, `engines["claude-code"]` on the plugin's entry in the marketplace's `marketplace.json`.

The marketplace fallback matters for marketplaces that use `strict: false` entries or that wrap third-party plugins they do not control: the marketplace maintainer can add a floor without forking the plugin. A range in `plugin.json` always wins over the marketplace entry, so the plugin author has the last word.

```json
// .claude-plugin/marketplace.json -- Claude Code 2.1.323+
{
  "name": "team-tools",
  "owner": { "name": "Platform Team" },
  "plugins": [
    {
      "name": "release-notes-helper",
      "source": "./plugins/release-notes-helper",
      "engines": { "claude-code": ">=2.1.323" }
    }
  ]
}
```

For an npm-sourced plugin, putting the range in `package.json` keeps one source of truth next to your Node `engines`:

```json
// package.json of an npm-sourced plugin -- Claude Code 2.1.323+
{
  "name": "@example/release-notes-helper",
  "version": "1.4.0",
  "engines": {
    "node": ">=20",
    "claude-code": ">=2.1.323"
  }
}
```

## What happens when the version does not fit

The [2.1.323 changelog](https://code.claude.com/docs/en/changelog) summarizes it as: plugins outside their stated range are not installed, updated or loaded, and install and update pick the newest version that fits. The details are worth knowing.

### Install and update refuse with an actionable message

A refused install throws a `PluginEngineRangeError`. The message has the shape:

```text
"release-notes-helper" was not installed: it needs Claude Code >=2.1.400, this is 2.1.329. Run `claude update`.
```

The last sentence changes depending on the range. If at least one alternative in the range starts at or above the running version (so updating Claude Code could satisfy it), the hint is ``Run `claude update` ``. If every alternative starts below the running version, so the range is an upper bound you have outgrown, the hint is `A newer version of the plugin may fit`. That second case is exactly what a range like `<2.1.300` produces on a 2.1.329 build.

If the running version itself cannot be parsed as semver, the range is treated as fitting. A custom or unusual build string will not lock you out of every plugin.

### Dependencies are checked as a closure

Plugins can depend on other plugins. Install walks the whole dependency closure and refuses the install with reason `engine-range` if any plugin in it, not only the one you asked for, has a range that excludes the running build. The error names the dependency that does not fit, so a user does not end up with half a plugin set installed.

### Install picks the newest version that fits

When a marketplace exposes several versions of a plugin (the bundle lists a plugin's git tags for this), install and update choose the newest one whose range includes the running build. That gives you a clean deprecation path: ship `2.0.0` with `"claude-code": ">=2.1.323"`, keep `1.x` without the field, and older Claude Code builds stay on `1.x` instead of failing.

### Installed copies keep working after a marketplace bump

If a marketplace publishes a new plugin version whose range no longer fits, Claude Code keeps loading the copy that is already installed, and logs that the marketplace's version needs another Claude Code version. A plugin author raising the floor does not break existing users on older builds. They simply stop receiving updates.

### Local folders are exempt, with a note

A plugin read from a local folder (the setup you use while developing a plugin) loads even when its range excludes the running build. Claude Code prints:

```text
Note: "release-notes-helper" needs Claude Code >=2.1.400, this is 2.1.329, but loads anyway because it's read from a local folder
```

That is deliberate: you can work on the next release, with its raised floor, from an older CLI. It also means a local test run is not proof that the range blocks anything. To see a refusal, install from a marketplace.

## Fail CI with claude plugin validate --strict

`claude plugin validate <path>` checks a plugin folder or a marketplace manifest without installing it. The [CLI reference](https://code.claude.com/docs/en/plugins/cli-reference) documents three verdicts and three exit codes:

| Verdict | Exit code |
|---|---|
| `Validation passed` | 0 |
| `Validation passed with warnings` | 0 (1 with `--strict`) |
| `Validation failed` / `Validation failed (--strict treats warnings as errors)` | 1 |
| `Unexpected error during validation: <reason>` | 2 |

Without `--strict`, warnings do not fail the run, and most of what the runtime tolerates is a warning: unknown top-level fields, a non-kebab-case `name`, missing `version`, `description` or `author`. The help text for `--strict` in 2.1.329 is precise about intent: "Treat warnings as errors (exit 1). Use in CI to fail on unrecognized fields, missing metadata, and other issues that the runtime tolerates."

For `engines` specifically, validate reports two kinds of mistakes (the second is attached to the `engines.claude-code` path), each ending with "It will be ignored at load time":

```text
'engines' must be an object such as { "claude-code": ">=2.1.0" }; got "2.1.323". It will be ignored at load time.
Must be a version range such as ">=2.1.0"; got "2.1.323+". It will be ignored at load time.
```

Both are exactly the class of bug you want CI to catch, because at runtime they degrade to "no range", which looks like the plugin works everywhere.

### What validate checks in hooks

Two hook checks are relevant to plugin authors:

- A shell-form hook command in `hooks.json` that uses `${CLAUDE_PLUGIN_ROOT}` without quotes draws a warning, unless the hook sets `"shell": "powershell"`. Unquoted, the path breaks as soon as the plugin cache sits under a directory with a space in its name.
- Since 2.1.323, validate also type-checks a plugin's TypeScript hooks module (the module-based hooks that mods use). Each type finding is a warning, so it only fails the run under `--strict`.

```json
// hooks/hooks.json -- Claude Code 2.1.x
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/format.sh"
          }
        ]
      }
    ]
  }
}
```

If a hook in your plugin fails at runtime rather than at validation time, the most common cause is a path problem, covered in [the fix for "Plugin directory does not exist"](/2026/10/fix-claude-code-hooks-fail-with-plugin-directory-does-not-exist/). For hooks that must block on failure, see [how to make a Claude Code hook fail closed](/2026/10/how-to-make-a-claude-code-hook-fail-closed-with-onfailure-block/).

### JSON output and the directory profile

`--json` (Claude Code 2.1.259 and later) prints the report as one JSON object with the same exit codes, which is easier to turn into PR annotations than parsing text.

`--profile directory` adds the rules of the plugin directory (the catalog plugins are submitted to) on top of the normal checks, such as a missing README. It also fails when a check could not be made: when `plugin.json` lists more than 16 MCP server files or more than 16 hooks files (only 16 of each are checked), or when one of those files is not valid JSON. Combined with `--strict`, the directory's warnings fail too. The CLI's own advice is to run `--profile directory --strict` on a fresh checkout, because a file that exists locally but is not committed would pass locally and be missing from the submission.

## A GitHub Actions job that tests the floor and the latest build

The useful CI shape is a matrix: one leg on the floor you declare in `engines`, one on the latest release. The floor leg catches manifest fields that your minimum version does not know (they are unknown-field warnings there, so `--strict` fails), and the latest leg catches new deprecations, such as the `agent` setting that 2.1.323 started warning about.

```yaml
# .github/workflows/validate-plugin.yml
# Claude Code 2.1.323 (floor) and latest; actions/setup-node v4
name: validate-plugin
on:
  pull_request:
  push:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        claude-code: ["2.1.323", "latest"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Install Claude Code ${{ matrix.claude-code }}
        run: npm install -g @anthropic-ai/claude-code@${{ matrix.claude-code }}
      - name: Validate plugin
        run: claude plugin validate ./plugins/release-notes-helper --strict
      - name: Validate marketplace
        run: claude plugin validate . --strict
```

Keep the floor in the matrix in sync with the `engines` range. A small script that reads `plugin.json` and fails if the two disagree is cheap insurance:

```bash
#!/usr/bin/env bash
# check-floor.sh -- requires jq 1.6+ and mikefarah/yq v4
set -euo pipefail
range=$(jq -r '.engines["claude-code"] // empty' plugins/release-notes-helper/.claude-plugin/plugin.json)
floor=$(yq '.jobs.validate.strategy.matrix["claude-code"][0]' .github/workflows/validate-plugin.yml)
if [[ "$range" != ">=$floor"* ]]; then
  echo "engines range '$range' does not start at the CI floor $floor" >&2
  exit 1
fi
```

If you already run Claude Code itself in Actions for reviews, the setup overlaps with [running Claude Code in a GitHub Action for PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/). The validate job does not need the review job's prompt or tools, only the CLI on the path.

## Gotchas worth writing down

- **A floor under 2.1.323 protects nobody.** Builds older than 2.1.323 do not enforce the range, and 2.0.15 through 2.1.75 reject the manifest outright.
- **The range is ignored, not enforced, when it is malformed.** `"2.1.323+"` or a number instead of a string means "works everywhere". Only `validate --strict` turns that into a red build.
- **Local folder installs bypass the check.** Test refusals through a marketplace install, not your development folder.
- **The plugin's own range beats the marketplace entry.** A marketplace maintainer cannot loosen a range the plugin declares, only add one where the plugin has none.
- **Raising the floor freezes, it does not break.** Users on older builds keep their installed copy and stop getting updates. Mention the floor change in your release notes so they know why.
- **Validate before tagging.** `claude plugin tag` creates the release tag that version-aware installs read. Run the strict validation first, so a tag never points at a manifest with an ignored range.

## Related reading

- What the shared plugin format covers versus vendor extensions like `engines`: [Agent Plugins 1.0 vs vendor-specific plugin formats](/2026/08/agent-plugins-1-0-vs-vendor-specific-plugin-formats/).
- How private marketplaces authenticate their plugin downloads: [Claude Code 2.1.238 marketplaces mint their own auth headers](/2026/08/claude-code-2-1-238-marketplaces-mint-their-own-auth-headers/).
- Deciding whether a capability should be a plugin skill, a subagent or an MCP server: [Claude Code skills vs subagents vs MCP servers](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/).

## Sources

- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference): the `engines` field, version requirements, and the validate checks.
- [Claude Code plugins CLI reference](https://code.claude.com/docs/en/plugins/cli-reference): `claude plugin validate` flags, verdicts and exit codes.
- [Claude Code changelog](https://code.claude.com/docs/en/changelog): the 2.1.323 entries for `engines` and hooks module type checking.
- The error messages, range parser and lookup order quoted above come from the strings of the `@anthropic-ai/claude-code-darwin-arm64@2.1.329` package. The examples were checked against those sources; the commands were not executed for this article.
