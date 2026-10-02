---
title: "What Is an Agent Skill, and How Is It Different from a System Prompt?"
description: "An agent skill is a folder with a SKILL.md file that the agent loads on demand: only its name and description sit in the system prompt, the instructions arrive when a task matches, and bundled scripts run without ever entering context. Here is how that differs from a system prompt in cost, scope, invocation and trust, with the exact limits from the Agent Skills spec and Claude Code."
pubDate: 2026-10-02
template: how-to
tags:
  - "agent-skills"
  - "ai-agents"
  - "claude-code"
  - "llm"
  - "prompt-engineering"
---

**Short answer:** a system prompt is text the model reads on every single turn, whether the turn needs it or not. An agent skill is a folder containing a `SKILL.md` file (plus optional scripts and reference docs) that the agent loads *progressively*: only the skill's `name` and `description`, roughly 100 tokens, are placed in the system prompt; the instruction body enters the context only when a request matches that description; and bundled files are read or executed only when the instructions call for them. So the real difference is not "where the text lives" but **when it costs you tokens and who decides to load it**. The system prompt is always-on and author-controlled. A skill is an on-demand capability the model selects itself (or that you invoke with `/name`). Everything below is pinned to the [Agent Skills specification](https://agentskills.io/specification), Claude Code 2.1.x, and the Claude API with model `claude-opus-5-5` and the `code_execution_20250825` tool.

## Two answers to "where do my instructions go?"

Every agent builder runs into the same question within a week: you have a release checklist, a migration review rubric, a house style for commit messages and a list of "never do X in this repo" rules. Where do they go?

The default answer for the last three years was "the system prompt". It is the one place you control that the model is guaranteed to see. The problem is that the guarantee is also the cost. A 4,000-token release checklist in the system prompt is paid for on every turn of every conversation, including the 95% of turns that have nothing to do with releasing. It also competes for attention: the more unrelated rules sit in front of the model, the more likely the one that matters right now gets diluted.

Agent skills are Anthropic's answer, published as an open format in late 2025 and since adopted by GitHub Copilot, Cursor, Codex CLI and others. The [Claude docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) frame them against prompts directly: prompts are "conversation-level instructions for one-off tasks", while skills "load on demand, so you don't have to repeat the same guidance across conversations".

## What a skill actually is on disk

A skill is a directory. The only required file is `SKILL.md`, which is YAML frontmatter followed by Markdown:

```text
releasing-a-version/
├── SKILL.md              # required: frontmatter + instructions
├── scripts/
│   └── next_version.py   # executed, never loaded into context
└── references/
    └── changelog-format.md  # read only when SKILL.md points to it
```

```markdown
---
name: releasing-a-version
description: Cuts a release of this repo, bumping the version, writing the changelog entry and tagging. Use when the user asks to release, ship, tag or publish a new version.
---

# Releasing a version

1. Run `scripts/next_version.py` and use the version it prints. Do not pick one yourself.
2. Add a section to `CHANGELOG.md` using the format in [references/changelog-format.md](references/changelog-format.md).
3. Commit as `release: vX.Y.Z`, then `git tag vX.Y.Z`.
4. Stop. Do not push; the user pushes tags.
```

The spec's rules for the two required fields are strict and worth memorizing, because a skill that fails them is silently skipped by some hosts and rejected on upload by others:

| Field | Rule (Agent Skills spec) |
| --- | --- |
| `name` | 1-64 chars, lowercase `a-z`, `0-9` and `-` only, no leading, trailing or consecutive hyphens, **must match the folder name** |
| `description` | 1-1024 chars, should say what the skill does **and** when to use it |
| `license`, `compatibility`, `metadata`, `allowed-tools` | optional; `allowed-tools` is marked experimental |

Anthropic's own surfaces add two more constraints: the `name` cannot contain XML tags or the reserved words "anthropic" and "claude".

Compare that with a system prompt, which has no structure at all. It is a string. Nothing validates it, nothing names it, and nothing tells the model when a given paragraph applies.

## Progressive disclosure: the mechanism that makes them different

The whole design rests on loading in three stages. The [overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) gives the numbers:

| Level | When loaded | Token cost | What |
| --- | --- | --- | --- |
| 1. Metadata | Always, at startup | ~100 tokens per skill | `name` + `description` |
| 2. Instructions | When the skill is triggered | Under 5k tokens recommended | the `SKILL.md` body |
| 3. Resources | As needed | Nothing until accessed | reference files are read; scripts are executed and only their output enters context |

Here is the part people miss: **level 1 is literally injected into the system prompt.** The docs say Claude "loads this metadata at startup and includes it in the system prompt", and the startup line for a PDF skill looks like `pdf-processing - Extract text and tables from PDF files, fill forms...`. So a skill is not the opposite of a system prompt. It is a system prompt *entry* that acts as a pointer, plus a payload the model fetches itself when the pointer matches.

That is why the best-practices guide insists descriptions be written in the third person ("Processes Excel files", not "I can help you process Excel files"): the description is read as part of the system prompt, and a sudden "I" or "you" in the middle of it confuses the model about who is speaking.

Level 3 is where skills do something a system prompt cannot do at any price. When `SKILL.md` says "run `scripts/next_version.py`", the agent executes the script through bash and only `1.8.0` comes back into context. The script's source never does. A system prompt can only *describe* a procedure and hope the model reproduces it correctly; a skill can ship the procedure as deterministic code.

## Measuring the always-on cost of your skills

You can see the split for your own skills with a few lines of Python. This script reads every `SKILL.md` under a folder, validates the two required fields against the spec, and estimates what each skill costs before it is ever used versus when it triggers:

```python
# skill_cost.py - Python 3.9+, no dependencies. Agent Skills spec (agentskills.io).
import pathlib, re, sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".claude/skills")
NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

for skill_md in sorted(root.glob("*/SKILL.md")):
    text = skill_md.read_text(encoding="utf-8")
    _, front, body = text.split("---", 2)
    meta = dict(
        line.split(":", 1) for line in front.strip().splitlines() if ":" in line
    )
    name = meta.get("name", "").strip()
    desc = meta.get("description", "").strip()
    problems = []
    if not NAME.match(name) or len(name) > 64:
        problems.append("bad name")
    if name != skill_md.parent.name:
        problems.append("name != folder")
    if not 1 <= len(desc) <= 1024:
        problems.append("description length")
    # ~4 chars per token is a rough English estimate, good enough for budgeting
    always = len(name) + len(desc)
    on_use = len(body)
    print(f"{name:24} always-loaded ~{always // 4:>4} tok   "
          f"on-trigger ~{on_use // 4:>5} tok   {' '.join(problems) or 'ok'}")
```

Run against a repo with the release skill above and a migration-review skill:

```text
$ python3 skill_cost.py .claude/skills
releasing-a-version      always-loaded ~  45 tok   on-trigger ~   83 tok   ok
reviewing-migrations     always-loaded ~  48 tok   on-trigger ~   53 tok   ok
```

The "always-loaded" column is the only part that behaves like a system prompt. For the official validator, the spec ships [`skills-ref`](https://github.com/agentskills/agentskills/tree/main/skills-ref) (`skills-ref validate ./my-skill`), which checks the full frontmatter rather than this quick subset.

## The listing is a budget, and it can overflow

Because every installed skill puts its description in front of the model, a large skill library eventually becomes a large system prompt. Claude Code handles this with an explicit budget. Per the [Claude Code skills docs](https://code.claude.com/docs/en/skills), the listing of names and descriptions "scales at 1% of the model's context window". When it overflows, Claude Code keeps every skill name but "drops descriptions starting with the skills you invoke least". A skill whose description got dropped is still invocable by `/name`, but the model has lost the keywords it would have matched on, so automatic triggering quietly stops working.

Two more limits matter:

- The combined `description` and `when_to_use` text is truncated at **1,536 characters** in the listing. Put the trigger phrases first.
- After auto-compaction, Claude Code re-attaches the most recent invocation of each skill, keeping the first **5,000 tokens** of each, with a combined **25,000 token** budget across all re-attached skills.

This is the inverse of the system prompt failure mode. An overlong system prompt degrades everything a little. An overlong skill library degrades the *least used* skills to "manual only", which is a much more predictable failure. If you want to see which of your skills are paying listing cost without ever being used, [Claude Code 2.1.261's `/skill-doctor`](/2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context/) reports exactly that.

## Who decides when the text applies

A system prompt has one invocation mode: always. Skills have three, and choosing among them is most of the design work:

1. **Model-invoked** (the default). The model reads the description and loads the skill when the request matches. This is what makes "a release skill" different from "a release section in the system prompt": the model only reads the procedure when someone actually asks to release.
2. **User-invoked only.** In Claude Code, `disable-model-invocation: true` keeps the skill out of the model's automatic selection; you trigger it with `/releasing-a-version`. Use it for anything with side effects you want a human to start, such as releases, deploys, or bulk edits.
3. **Model-invoked only.** `user-invocable: false` hides the skill from the slash menu, for background knowledge that only makes sense when the model decides it needs it.

Note that `disable-model-invocation` and `user-invocable` are Claude Code extensions, not spec fields. Upload a skill containing them to claude.ai or the Skills API and it is rejected with an `Unexpected key(s) in SKILL.md frontmatter` error. If you share skills across surfaces, keep the frontmatter to the spec fields: `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`.

## Using a skill through the Claude API

Outside an IDE agent, the same split shows up in the API. You do not paste the skill into `system`; you attach it to the code execution container and the model loads it from the container's filesystem:

```python
# Claude API, model claude-opus-5-5, code execution tool code_execution_20250825
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=4096,
    system="You are the release assistant for the acme/widgets repo.",
    container={
        "skills": [
            {"type": "custom", "skill_id": "skill_01ReleasingAVersion", "version": "latest"},
            {"type": "anthropic", "skill_id": "xlsx", "version": "latest"},
        ]
    },
    tools=[{"type": "code_execution_20250825", "name": "code_execution"}],
    messages=[{"role": "user", "content": "Ship 1.8.0 and give me a spreadsheet of what changed."}],
)
```

The `system` string stays short and stable. The two skills contribute only their metadata until the model decides to read them. Custom skills are uploaded once through the `/v1/skills` endpoints and are shared workspace-wide, and you can attach up to 20 skills per request, per the [skills guide](https://platform.claude.com/docs/en/build-with-claude/skills-guide). The container has no network access and no runtime package installation, so skill scripts must use pre-installed packages.

There is a caching consequence too. A short, stable system prompt is an ideal prompt-cache prefix, while a skill body arrives later as part of the conversation instead of rewriting that prefix. Adding or removing an installed skill does change the metadata listing, so treat your skill set like any other part of the cached prefix and avoid churning it per request. If you are tuning this, the breakpoint placement rules in [caching multi-turn Claude conversations](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/) apply unchanged.

## A side-by-side comparison

| | System prompt | Agent skill |
| --- | --- | --- |
| Loaded | Every turn, in full | Metadata every turn; body on trigger; files on demand |
| Cost of an unused rule | Full tokens, every turn | ~100 tokens of description |
| Who decides it applies | The author, by including it | The model (description match) or the user (`/name`) |
| Can ship executable code | No | Yes, scripts run and only output enters context |
| Portable across agents | No standard format | Yes, the agentskills.io format is read by Claude Code, Copilot, Cursor, Codex CLI |
| Validated | Never | Frontmatter rules, `skills-ref validate` |
| Survives compaction | Always present | Re-attached up to 5,000 tokens each in Claude Code |
| Trust model | You wrote it | Treat like installed software |

## What should stay in the system prompt

Skills are not a replacement for the system prompt, and moving everything into them is a mistake. Keep in the always-on layer (the API `system` field, or `CLAUDE.md` / `AGENTS.md` in a coding agent):

- **Identity and scope.** Who the agent is, which repo or product it serves.
- **Rules that apply to every turn.** "Never commit to `main`", "all SQL goes through the repository layer". A rule that must hold on a turn where no skill triggers cannot live in a skill.
- **Short facts the model needs to even recognize that a skill applies.** If the model does not know your repo has a migrations folder, it cannot match a migration skill to "is this PR safe?"

Move into skills anything that is a **procedure** (multi-step, only relevant sometimes), anything that is **reference material** (schemas, API docs, format specs), and anything that would be more reliable as a **script** than as prose. The Claude Code docs give a good trigger for the move: when "you keep pasting the same instructions into chat" or a section of `CLAUDE.md` "grows into a multi-step procedure". The [CLAUDE.md guide](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) covers the always-on side; for the boundary between skills, subagents and MCP servers, see [when to build each](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/).

## Gotchas when you move instructions out of the prompt

**A vague description means the skill never loads.** "Helps with releases" will lose to almost any other context. The description must name the task and the trigger words users actually type: "release, ship, tag or publish a new version". This is the single most common reason a skill "doesn't work".

**Nested references get partially read.** The best-practices guide warns that when a reference file points to another reference file, Claude may preview it with something like `head -100` rather than read it fully. Keep every reference one level deep from `SKILL.md`, and keep `SKILL.md` itself under 500 lines.

**Skills are code, so they are an attack surface.** A system prompt is text you wrote. A skill can bundle scripts and instruct the agent to run tools, and a skill that fetches external URLs can pull in injected instructions. Anthropic's guidance is to use skills only from trusted sources and audit every bundled file, the same way you would vet a dependency.

**Skills do not sync across surfaces.** A skill uploaded to claude.ai is not available to the API, and Claude Code's filesystem skills are separate from both. In Claude Code the scopes are `~/.claude/skills/` (personal) and `.claude/skills/` (project), and they can also be distributed through plugins. If you need the same skill everywhere, keep one source folder and publish it to each surface, or package it as an [agent plugin](/2026/08/package-skills-and-an-mcp-server-as-one-agent-plugin/).

**Migrating prompt files is not a rename.** If you are coming from Copilot `.prompt.md` files, some of them should become skills and some should stay manual; the [prompt-files-to-skills checklist](/2026/07/migrate-copilot-prompt-files-to-agent-skills/) walks through the split.

The useful mental model is this: the system prompt is what the agent *always knows*, and skills are what the agent *knows how to look up*. Put the smallest possible set of always-true rules in the first, write sharp descriptions for the second, and let progressive disclosure keep the context window for the actual work.

### Sources

- [Agent Skills specification](https://agentskills.io/specification)
- [Agent Skills overview, Claude docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Using Agent Skills with the API](https://platform.claude.com/docs/en/build-with-claude/skills-guide)
- [Extend Claude with skills, Claude Code docs](https://code.claude.com/docs/en/skills)
- [Equipping agents for the real world with Agent Skills, Anthropic Engineering](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
