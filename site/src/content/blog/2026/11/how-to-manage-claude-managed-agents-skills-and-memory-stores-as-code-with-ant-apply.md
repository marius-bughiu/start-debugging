---
title: "How to Manage Claude Managed Agents, Skills and Memory Stores as Code with ant apply"
description: "Keep Claude Managed Agents, skills, environments and memory stores in git and reconcile them with `ant apply` (anthropic-cli 1.30.0+, current 2.9.0). The file layout for each kind, what claude-lock.json records and why you must commit it, how drift, --force and --prune behave, why memory stores attach through deployments rather than agents, and a GitHub Actions workflow that applies on merge."
pubDate: 2026-11-12
template: "how-to"
tags:
  - "ai-agents"
  - "llm"
  - "agent-skills"
  - "claude-managed-agents"
  - "anthropic-cli"
  - "github-actions"
---

To manage Claude Managed Agents as code, put each resource in its own file (`agents/*.md`, `skills/<name>/SKILL.md`, `environments/*.yaml`, `memory_stores/*.yaml`) and run `ant apply .` from the repository root. The `ant` CLI (version 1.30.0 or later; 2.9.0 is current as of November 10, 2026) shows a plan, creates or updates each resource, and writes the resulting IDs to `claude-lock.json`. Commit that lockfile. Without it, the next run creates duplicates instead of updating what already exists. In CI, run `ant apply --dry-run .` on pull requests and `ant apply --yes .` after merge.

The rest of this post covers the file format for each kind, what the lockfile actually tracks, how `ant apply` treats edits made in the Console, and the parts that catch people: memory stores are not attached to agents, renamed files leave orphans behind, and nothing locks the lockfile when two runs overlap.

## Why the Console stops scaling after the second agent

A Managed Agent is a versioned API resource: a model ID such as `claude-opus-5-5`, a system prompt, a tool list, skills, and MCP servers. Next to it you have an environment (the cloud container), custom skills (uploaded bundles with `skill_*` IDs), memory stores, and possibly vaults and scheduled deployments. Each one has an opaque ID, and those IDs have to stay in sync with whatever sessions and deployments refer to them.

Once you have a reviewer agent in staging and production, two custom skills, and a nightly deployment, editing all of this in the Console means a system prompt change has no review, no diff, and no rollback. Scripting `ant beta:agents create` calls mostly moves the problem, because you still have to track which ID belongs to which file, and a rerun creates a second agent.

`ant apply` is Anthropic's answer to that. It works like a small Terraform for the Claude Developer Platform: files describe the desired state, a lockfile maps each file to a remote ID, and every run reconciles the two. The command's own help text puts it this way: it "reconciles agents, skills, environments, memory stores, vaults and deployments declared in local files against the Claude Developer Platform, then records what it did in claude-lock.json."

## Installing the CLI and authenticating

```bash
# anthropic-cli 2.9.0 (released 2026-11-10). ant apply needs >= 1.30.0
brew install anthropics/tap/ant

# or, with Go 1.26.10+
go install github.com/anthropics/anthropic-cli/v2/cmd/ant@latest
```

For local work, `ant auth login` is the recommended path. You can also export `ANTHROPIC_API_KEY`. Some features need a newer CLI than the 1.30.0 minimum: vault files need 1.34.0, and `multiagent` agents with `predefined_agents` paths need 1.40.0. If you pin the CLI in CI, pin it to the newest version your files actually use.

## A repository layout that ant apply understands

`ant apply` infers each file's kind from its directory, from a top-level `type` field, or from a file name that starts with the kind. Follow the directory convention and you won't have to think about it:

```text
claude/
  claude-lock.json
  agents/
    reviewer.md
    tools/
      get_ci_status.json
  skills/
    pr-summary/
      SKILL.md
  environments/
    review-env.yaml
  memory_stores/
    review-notes.yaml
  deployments/
    nightly-review.md
```

Files that match no kind, such as a README or CI config, are skipped unless you name them on the command line.

### The agent file

An agent is a Markdown file. The YAML frontmatter is the agent config, and the Markdown body becomes the `system` prompt:

```markdown
---
# agents/reviewer.md -- anthropic-cli 2.9.0, beta managed-agents-2026-04-01
name: PR reviewer
description: Reviews pull requests against the team's conventions.
model:
  id: claude-opus-5-5
  effort: high
tools:
  - type: agent_toolset_20260401
    configs:
      - name: web_search
        enabled: false
  - ./tools/*.json # custom tool definitions are inserted here
skills:
  - type: anthropic
    skill_id: xlsx
  - ../skills/pr-summary # a path reference, resolved to a skill_* ID on apply
---

You review pull requests. Read the diff, run the pr-summary skill, and post
findings ordered by severity. Never approve a PR yourself.
```

`name` and `model` are required. `model` can be a plain string or an object with `id`, `effort` (`low`, `medium`, `high`, `xhigh`, `max`), `speed` and `inference_geo`. Note the update semantics. `model`, `system`, `name` and `description` are replaced on each apply. The arrays `tools`, `mcp_servers` and `skills` are replaced whole, not merged. `metadata` merges key by key, and setting a key to `null` deletes it.

Keep custom tool JSON files out of the `agents/` directory itself. Anything under `agents/` is read as an agent, which is why the docs put them in `agents/tools/`. A tool file is a normal custom tool definition:

```json
{
  "type": "custom",
  "name": "get_ci_status",
  "description": "Return the latest CI status for a branch.",
  "input_schema": {
    "type": "object",
    "properties": { "branch": { "type": "string" } },
    "required": ["branch"]
  }
}
```

### The skill directory

A custom skill is a directory with a `SKILL.md` at its root. `ant apply` uploads the whole directory as one bundle, so scripts and reference files next to `SKILL.md` go with it:

```markdown
---
name: pr-summary
description: Summarize a pull request's changes and risks in the team's review format.
---

# PR summary

List what changed, why, and anything a reviewer should look at closely,
in three short sections.
```

If you haven't written one before, [what an agent skill is and how it differs from a system prompt](/2026/10/what-is-an-agent-skill-and-how-is-it-different-from-a-system-prompt/) covers the loading model. The useful part here is how agents refer to skills. A path such as `../skills/pr-summary` is resolved on apply and pinned to the version that apply just uploaded. A glob such as `../skills/*` pulls in every skill directory and skips non-skill matches like a README. You can also reference a GitHub URL (`https://github.com/<owner>/<repo>/tree/<branch>/<dir>`). That reference is pinned to the resolved commit in the lockfile, and it stays pinned until you run `ant apply --upgrade`. For private repositories, set `GITHUB_TOKEN`.

When you edit a skill and apply again, the lockfile entry is what makes `ant apply` upload a new version of the same `skill_*` resource instead of creating a new skill.

### The environment file

```yaml
# environments/review-env.yaml
# yaml-language-server: $schema=https://platform.claude.com/schemas/ant/beta/environment.json
name: review-env
description: Cloud container with limited networking for review sessions.
config:
  type: cloud
  networking:
    type: limited
    allowed_hosts:
      - api.github.com
    allow_package_managers: true
  packages:
    npm:
      - "@biomejs/biome"
```

One rule produces a 400 more often than any other: if networking is `limited` and you list `packages`, you also need `allow_package_managers: true`. Also keep in mind that agents never reference environments. A session receives an environment ID when it is created, and a deployment file refers to the environment by path.

### The memory store file, and where it actually attaches

```yaml
# memory_stores/review-notes.yaml
# yaml-language-server: $schema=https://platform.claude.com/schemas/ant/beta/memory_store.json
name: Review notes
description: Recurring issues and house-style decisions the reviewer has recorded between runs.
```

This is the part of the queue topic that most people get wrong: there is no `memory_stores:` field on an agent. A memory store attaches to a **session** at creation time, through the session's `resources` array, with `access` set to `read_write` (the default) or `read_only`. A store can't be added to or removed from a running session. So in a declarative repo, the place that wires a store to an agent is a deployment:

```markdown
---
# deployments/nightly-review.md -- anthropic-cli 2.9.0
name: Nightly review
agent: ../agents/reviewer.md          # sent as {type: agent, id, version}
environment_id: ../environments/review-env.yaml
resources:
  - path: ../memory_stores/review-notes.yaml
    access: read_write
schedule:
  type: cron
  expression: "0 3 * * *"
  timezone: America/Los_Angeles
---

Review any open pull requests. Start with the oldest.
```

The deployment's frontmatter is the request body, and its prose becomes the session's first message. Every cross-reference is a relative path, and `ant apply` turns each one into the right ID. That's the main reason to put deployments under `ant apply` too: the agent version, environment ID and store ID can't drift apart, because none of them is ever typed by hand.

`ant apply` manages the store resource (its name and description). It does not manage the memories inside it. Those are written by the agent at runtime under `/mnt/memory/<store-slug>/`, or managed with `ant beta:memory-stores:memories create|list|update|delete`. Limits worth knowing: 8 stores per session, 10,000 memories per store, 100 kB per memory. For a store you want to seed with house rules, check a seeding script in next to the YAML. Don't expect `ant apply` to sync file contents into memories.

## The first apply and what claude-lock.json records

Run the first apply locally, from the directory where you want the lockfile to live:

```bash
cd claude
ant apply .
```

At a terminal it prints a plan (`+ ./agents/reviewer.md  create` and so on), asks `Apply these changes? (y)es / (n)o / (d)etails`, then writes `./claude-lock.json`. The file looks like this:

```json
{
  "version": 1,
  "origin": {
    "base_url": "https://api.anthropic.com",
    "organization_id": "1b0c2a4d-6c1f-4f0e-9a57-2e8d1c3b4a5f",
    "workspace_id": "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ"
  },
  "resources": {
    "./agents/reviewer.md": {
      "kind": "agent",
      "id": "agent_011CYm1BLqPXpQRk5khsSXrs",
      "version": "1",
      "hash": "d23251c8d99b3613a64f3f8d87f5fad4",
      "remote_hash": "1b771bee5bdbf600a5ad972fdac32d94"
    }
  }
}
```

(The IDs above are the documentation's sample values.) The `kind` values match the directory names in singular form: `agent`, `skill`, `environment`, `memory_store`, and so on. Each entry has two fingerprints. `hash` covers what was last sent, and `remote_hash` covers what the API returned. On the next run, a changed `hash` means you edited the file. A changed `remote_hash` means someone changed the resource outside your files.

Three consequences follow from this design:

1. **Commit the lockfile, always.** It is the only link between a file and its remote ID. `ant apply` cannot adopt a resource created in the Console or with `ant beta:agents create`. If you apply a file that describes an agent that already exists, you get a second agent.
2. **The lockfile is bound to one org and workspace.** `origin` records both, and `ant apply` refuses credentials that resolve to a different organization or workspace. For staging and production, keep two lockfiles and select one with `--lock-file`:

   ```bash
   ant apply --lock-file claude-lock.staging.json .
   ant apply --lock-file claude-lock.prod.json .
   ```

3. **The path is the identity.** Resources are keyed by relative file path. Rename `reviewer.md` to `pr-reviewer.md` and you have declared a new resource, while the old one stays live until you prune it.

## Day two: edits, drift, deletes

After the first run, `ant apply` with no arguments reconciles everything the lockfile already tracks. At a terminal, it also offers to add untracked resource files it finds under the lockfile's directory. `ant apply .` is explicit and also picks up new files, which is why CI should always pass the path.

Edits work the way you'd expect. Change the system prompt, run `ant apply`, and the plan shows an update. `ant apply` sends the agent's current `version` for optimistic concurrency, so a concurrent edit returns a 409 rather than silently overwriting it. If you delete a field from a file, `ant apply` clears it on the resource where the API allows that. A field you never set, or one the API can't clear, keeps its remote value.

**Drift.** If someone edits, archives or deletes a resource in the Console, the plan ends with `This plan cannot be applied:` and a reason, and the command exits with `refusing to apply`. You have two options:

```bash
# overwrite the out-of-band edit with what is in git (or recreate a deleted resource)
ant apply --force .

# or copy the Console change into the file first, then apply normally
```

There is no `--refresh` flag that accepts the remote state into your files, despite what some third-party write-ups claim. The complete flag set in the v2.9.0 source (`pkg/cmd/apply.go`) is `--yes`, `--dry-run`, `--force`, `--prune`, `--upgrade`, `--lock-file` and `--verbose`. To keep a Console edit, copy it into the file by hand.

**Deletes.** If you delete a file, the resource stays in place and the plan shows a warning. `--prune` removes anything in the lockfile that is no longer declared on disk. Agents and other resources are archived, and skills are deleted. Run it with `--dry-run` first:

```bash
ant apply --dry-run --prune .
ant apply --prune .
```

## Running ant apply from GitHub Actions

The pattern is a plan on pull requests and an apply on merge to `main`. Without a terminal, `ant apply` won't prompt. It stops with `cannot ask for confirmation without a terminal; re-run with --yes to apply, or --dry-run to see the plan only`.

For the PR check:

```yaml
# .github/workflows/ant-plan.yml -- anthropic-cli 2.9.0
name: ant plan
on:
  pull_request:
    paths: ["claude/**"]
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: anthropics/setup-ant@v1
      - name: Plan
        working-directory: claude
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_PLAN }}
        run: ant apply --dry-run --verbose .
```

`--dry-run` exits 0 even when the plan is blocked by drift, so read the output rather than trusting the green check. If you want blocked plans to fail the PR, grep the output for `cannot be applied` and exit 1.

For the apply job, Anthropic's docs recommend Workload Identity Federation over a stored API key. The workflow exchanges its GitHub OIDC token for Anthropic credentials, scoped to a protected GitHub environment:

```yaml
# .github/workflows/ant-apply.yml -- adapted from the ant apply reference
name: ant apply
on:
  push:
    branches: [main]
    paths-ignore: [claude/claude-lock.json] # the lockfile commit must not retrigger this
jobs:
  apply:
    runs-on: ubuntu-latest
    environment: agents-prod   # require reviewers on this environment
    concurrency: ant-apply     # nothing locks the lockfile, so serialize runs here
    permissions:
      id-token: write
      contents: write
    env:
      ANTHROPIC_FEDERATION_RULE_ID: fdrl_...
      ANTHROPIC_ORGANIZATION_ID: 00000000-0000-0000-0000-000000000000
      ANTHROPIC_SERVICE_ACCOUNT_ID: svac_...
      ANTHROPIC_IDENTITY_TOKEN_FILE: /tmp/gha-jwt
    steps:
      - uses: actions/checkout@v5
        with:
          ref: main # pick up the previous run's lockfile commit
      - uses: anthropics/setup-ant@v1
      - name: Fetch GitHub OIDC token
        run: |
          curl -fsS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://api.anthropic.com" \
            | jq -r .value > "$ANTHROPIC_IDENTITY_TOKEN_FILE"
      - name: Apply
        working-directory: claude
        run: ant apply --yes .
      - name: Commit the lockfile
        if: always() # a partial apply still recorded what it created
        run: |
          git diff --quiet claude/claude-lock.json && exit 0
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git commit -am "Update claude-lock.json [skip ci]"
          git pull --rebase
          git push
```

A few of these lines matter more than they look:

- **`if: always()` on the commit step.** If apply fails halfway, it has still created some resources. If you don't commit their IDs, the next run creates them again.
- **`concurrency: ant-apply`.** The docs say plainly that nothing locks the lockfile. Two overlapping applies can both create the same new agent.
- **`ant apply --yes .`, not `ant apply --yes`.** Without a path, apply only reconciles tracked resources and silently skips files added in the merged PR.
- **Do the first apply locally** and commit the lockfile before you enable the workflow. That way CI starts from a known mapping instead of creating everything from scratch.

If you'd rather not build federation yet, a scoped API key in an environment secret also works. Just keep it out of anything the agent itself can read. The same reasoning appears in [keeping API keys out of a coding agent's context](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/), which also covers Managed Agents vaults. Vaults are another kind `ant apply` can manage (`vaults/*.yaml`, CLI 1.34.0+).

## Gotchas collected in one place

- **Arrays replace, they don't merge.** If you remove one MCP server from `mcp_servers`, the next apply sends the shorter list. That's correct, but it surprises people who expect patch semantics.
- **Skills referenced by GitHub URL don't float.** They stay on the commit in the lockfile until `--upgrade`, which is usually what you want for production and confusing when a fix "isn't picked up".
- **Memory headers differ.** If you script memory store calls next to `ant apply`, memory store endpoints take `anthropic-beta: agent-memory-2026-07-22`, and sending it together with `managed-agents-2026-04-01` returns a 400. Session endpoints, including attaching a store, still use `managed-agents-2026-04-01`.
- **Repository skills need no entry.** If a session mounts a GitHub repo, skills under its `.claude/skills/<name>/SKILL.md` are discovered at session start. You don't need to declare them again in `skills:`. (This doesn't work in self-hosted sandboxes.)
- **The lockfile lives where you run the command.** Run `ant apply` from a subdirectory once without `--lock-file` and you get a second, empty lockfile, followed by a full set of duplicate resources.

What was verified for this post: the flag list and the usage text come from the `anthropics/anthropic-cli` v2.9.0 source, and the `memory_store` kind name comes from `internal/declarative/claude/kinds.go`. The file formats, lockfile sample and workflow come from Anthropic's documentation. None of these examples was applied against a live workspace for this article.

## Related

- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) compares Routines, GitHub Actions cron and `/loop`, which is useful context before you choose `ant apply` deployments for scheduled work.
- [What is an agent skill, and how is it different from a system prompt?](/2026/10/what-is-an-agent-skill-and-how-is-it-different-from-a-system-prompt/)
- [Claude Code skills vs subagents vs MCP servers: when to build each](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) helps decide what belongs in `skills/` and what belongs in `mcp_servers`.
- [How to keep API keys out of a coding agent's context with a credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/)

## Sources

- [`ant apply` reference](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/apply), Claude Platform Docs
- [Define your agent](https://platform.claude.com/docs/en/managed-agents/agent-setup), [Cloud environment setup](https://platform.claude.com/docs/en/managed-agents/environments), [Skills](https://platform.claude.com/docs/en/managed-agents/skills) and [Memory](https://platform.claude.com/docs/en/managed-agents/memory) in the Managed Agents docs
- [Get started with Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/quickstart) (CLI install and auth)
- [Workload Identity Federation for GitHub Actions](https://platform.claude.com/docs/en/manage-claude/wif-providers/github-actions)
- [anthropics/anthropic-cli `pkg/cmd/apply.go` at v2.9.0](https://github.com/anthropics/anthropic-cli/blob/v2.9.0/pkg/cmd/apply.go)
