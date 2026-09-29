---
title: "Self-Healing E2E Tests When a Coding Agent Renames Your Selectors"
description: "A coding agent refactors a component, renames a data-testid, and your Playwright suite goes red. Here is a three-layer setup, verified on Playwright 1.63.0 and Claude Code 2.1.197: locators that survive, a PreToolUse hook that blocks the rename, and a CI guard that lets the Playwright healer agent fix locators but never rewrite an assertion."
pubDate: 2026-09-29
template: how-to
tags:
  - "ai-agents"
  - "claude-code"
  - "playwright"
  - "e2e-testing"
  - "hooks"
  - "agent-skills"
---

**Short answer:** do not let "self-healing" mean "the agent edits tests until they pass". Split the problem into three layers. First, write locators that survive cosmetic refactors (`getByRole` and `getByLabel` before `getByTestId`, and no `exact: true` unless you need it). Second, stop the coding agent from removing a `data-testid` that a spec still uses, with a Claude Code `PreToolUse` hook that exits `2`. Third, when a selector does break, let the Playwright healer agent (`npx playwright init-agents --loop=claude`) patch it, but gate its diff in CI with a script that fails if any assertion matcher, or a new `test.fixme`, appeared. Everything below was run on Playwright 1.63.0, `@playwright/test` 1.63.0, Node 26 and Claude Code 2.1.197.

## Why coding agents break selectors so often

A human renaming a button usually knows the test suite exists. A coding agent working on "clean up the profile form" often does not: the spec files live in `tests/`, they are not in the context window, and nothing in the component tells the model that `data-testid="profile-save"` is a contract. So the agent does what a tidy refactor looks like. It renames the id to `save-profile-button`, changes the label from "Save" to "Save changes", swaps a `<div onClick>` for a `<button>`, and reports success because the type checker is green.

The fix everyone reaches for is an AI healer: run the suite, let an agent look at the failing page, and patch the locator. Playwright ships exactly that as the **Healer** in its Test Agents. The problem is in its system prompt. The generated `.claude/agents/playwright-test-healer.md` on 1.63.0 tells the model to focus on "fixing assertions and expected values" and to "do the most reasonable thing possible to pass the test". If the agent's refactor also introduced a real regression, the most reasonable thing to pass the test is to change `toHaveText('Saved')` into whatever the broken page now says. A healer with no guardrails turns a failing test into a passing lie.

So the goal is narrower than "self-healing": selector drift gets fixed automatically, behaviour changes still fail loudly.

## The repro: one rename, one red test

A minimal app is enough to see every layer work. This is `app/index.html`, served by `http-server`:

```html
<!-- app/index.html -->
<h1>Profile</h1>
<label>Display name <input id="name" data-testid="profile-name"></label>
<button data-testid="profile-save"
        onclick="document.getElementById('st').textContent='Saved'">Save</button>
<p id="st" role="status"></p>
```

And the spec, written the way a lot of generated suites look:

```ts
// tests/profile.spec.ts, @playwright/test 1.63.0
import { test, expect } from '@playwright/test';

test('saving the profile shows a confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('profile-name').fill('Marius');
  await page.getByTestId('profile-save').click();
  await expect(page.getByRole('status')).toHaveText('Saved');
});
```

It passes. Then I made the change an agent would make, renaming `profile-save` to `save-profile-button`, and ran it again:

```text
Error: locator.click: Test timeout of 5000ms exceeded.
Call log:
  - waiting for getByTestId('profile-save')

> 6 |   await page.getByTestId('profile-save').click();
```

Note what the failure does not tell you: whether the button is gone, renamed, or hidden behind a regression. A locator timeout looks the same in all three cases, and that is exactly why a healer needs guardrails.

## Layer 1: locators that survive a cosmetic refactor

The cheapest heal is the one you never need. Playwright's own [locator guidance](https://playwright.dev/docs/locators) ranks user-facing locators first (`getByRole`, `getByLabel`, `getByText`) and test ids as the fallback. That ordering happens to be the right one against agent refactors, because agents rename internal attributes far more readily than they rename the visible label a user clicks.

I ran the same flow with role and label locators against the renamed page, and then changed the button label to "Save changes" as well:

```ts
// tests/role.spec.ts, @playwright/test 1.63.0
test('role locator survives a test-id rename', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Display name').fill('Marius');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
});

test('exact role locator after label change', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
});
```

The first test passed after both the id rename and the label change: accessible-name matching is case-insensitive and matches substrings by default, so `name: 'Save'` still finds "Save changes". The second failed with `waiting for getByRole('button', { name: 'Save', exact: true })`. Use `exact: true` only when two elements on the page would otherwise collide, and prefer a regex like `/^save/i` when you need to be stricter without going brittle.

Two more settings help:

- If your app already uses a different attribute, point Playwright at it with `use: { testIdAttribute: 'data-qa' }` in `playwright.config.ts`, instead of letting an agent "normalise" the markup to `data-testid`.
- Tell the coding agent. A line in `CLAUDE.md` or `AGENTS.md` such as "`data-testid` values are a public contract with `tests/`; grep before renaming" costs nothing. It is a hint, not a guarantee, which is why the next layer exists. (For why one-line rules sometimes get ignored, see [how to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/).)

## Layer 2: block the rename at the tool call

When a test id is the only stable handle on an element, it should not be removable without updating the specs. A Claude Code [`PreToolUse` hook](https://code.claude.com/docs/en/hooks) can enforce that deterministically. The hook receives the `Edit`, `MultiEdit` or `Write` call on stdin, and exit code `2` blocks the call and feeds stderr back to the model as the reason.

```js
// .claude/hooks/protect-test-ids.mjs
// Claude Code 2.1.x PreToolUse hook (Edit|MultiEdit|Write). Node 20+.
// Blocks an edit that removes a data-testid still referenced by tests/.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const { file_path, old_string, new_string, content, edits } = input.tool_input;
if (/\.(spec|test)\.[jt]sx?$/.test(file_path)) process.exit(0); // spec edits are allowed

const ids = (s = '') => new Set([...s.matchAll(/data-testid=["'{]+([\w-]+)/g)].map((m) => m[1]));
let before = '', after = '';
if (edits) { before = edits.map((e) => e.old_string).join('\n'); after = edits.map((e) => e.new_string).join('\n'); }
else if (content !== undefined) { before = existsSync(file_path) ? readFileSync(file_path, 'utf8') : ''; after = content; }
else { before = old_string; after = new_string; }

const gone = [...ids(before)].filter((id) => !ids(after).has(id));
if (!gone.length) process.exit(0);

const testsDir = join(process.env.CLAUDE_PROJECT_DIR ?? input.cwd, 'tests');
const specs = readdirSync(testsDir, { recursive: true }).filter((f) => /\.spec\.[jt]s$/.test(f));
const used = gone.filter((id) => specs.some((f) =>
  readFileSync(join(testsDir, f), 'utf8').includes(`getByTestId('${id}')`)));
if (!used.length) process.exit(0);

console.error(`data-testid ${used.map((i) => `"${i}"`).join(', ')} is used by tests/. ` +
  'Keep the attribute on the new element, or update the specs first.');
process.exit(2);
```

Register it in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-test-ids.mjs" }
        ]
      }
    ]
  }
}
```

I fed it three payloads shaped like real tool calls. Renaming `profile-save` in an `Edit` exits `2` with the message above. Adding a `class` to the same button (id unchanged) exits `0`. A `Write` that rewrites the whole file without `data-testid="profile-name"` exits `2`, because for `Write` the hook diffs against the file on disk rather than trusting the payload alone.

The order matters and the message says so: the agent has to update the spec first, which makes the old id unreferenced, and then the component edit goes through. That turns "silently broke the suite" into "made a two-file change on purpose", which is the whole point. If you already have permission rules for these tools, remember that since Claude Code 2.1.77 [a hook's `allow` cannot override a deny rule](/2026/09/fix-pretooluse-hook-allow-still-blocked-by-deny-rule/); a hook that only blocks, like this one, is not affected.

## Layer 3: let the Playwright healer fix what still breaks

Some drift will get through: a human changes the markup, another agent without the hook touches it, or the element moves into a shadow root. That is where the Healer earns its keep. On Playwright 1.63.0:

```bash
npx playwright init-agents --loop=claude
```

The command wrote these files into my scratch project:

```text
specs/README.md                              # directory for test plans
seed.spec.ts                                 # environment seed test
.claude/agents/playwright-test-planner.md
.claude/agents/playwright-test-generator.md
.claude/agents/playwright-test-healer.md
.mcp.json                                    # "playwright-test": npx playwright run-test-mcp-server
```

The healer is a regular Claude Code subagent: `model: sonnet`, tools limited to file edits plus `mcp__playwright-test__test_run`, `test_debug`, `browser_snapshot`, `browser_generate_locator` and the console and network readers. It has no `browser_click` or `browser_navigate`, so it cannot drive the app around; it replays the failing test, pauses at the error, snapshots the accessibility tree and proposes a new locator. Other loops are `--loop=vscode`, `--loop=codex` and `--loop=opencode`, per the [Test Agents docs](https://playwright.dev/docs/test-agents). If you want the same agent running outside the main session's context, the setup in [how to write a Claude Code subagent that runs browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/) applies unchanged.

Before you run it, edit the prompt. Three lines in the generated file do the damage described earlier: "Fixing assertions and expected values", "do the most reasonable thing possible to pass the test", and the instruction to mark a test `test.fixme()` when it believes the test is correct. The `fixme` rule is actually sensible (it means "the app is broken, not the test"), but it silently removes the test from the next CI run. I replace the remediation section with this:

```md
<!-- .claude/agents/playwright-test-healer.md, replaces "Code Remediation" -->
5. **Code Remediation**: You may change locators only: the argument of
   page.getBy*(), page.locator(), and the locator passed to expect().
   Never change a matcher (toHaveText, toHaveURL, toBeVisible, ...) or its
   expected value. Never add test.skip, test.fixme or test.fail.
   If the only way to pass is to change what is asserted, stop and report
   "BEHAVIOUR CHANGE: <test title>: expected X, page shows Y".
```

A prompt is still a request, though. The guard below is what makes it binding.

## The CI guard: locator changes pass, assertion changes fail

The rule the guard enforces is simple: across the diff of `tests/`, the multiset of assertion matchers (the `.toSomething(...)` tail of every `expect(` line) must be identical before and after. Locators can change freely, including the locator inside `expect(...)`. New `test.fixme`, `test.skip` or `test.fail` calls fail the build.

```js
// scripts/heal-guard.mjs, Node 20+, Playwright 1.63
// Fails if a test diff changes what is asserted.
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? 'HEAD';
const diff = execFileSync('git', ['diff', '-U0', base, '--', 'tests/'], { encoding: 'utf8' });

const matcher = /\.(?:not\.)?to[A-Z]\w*\(.*$/;      // .toHaveText('Saved') and friends
const skip = /\btest(?:\.describe)?\.(fixme|skip|fail)\b/;

const removed = [], added = [], problems = [];
for (const line of diff.split('\n')) {
  if (line.startsWith('---') || line.startsWith('+++')) continue;
  const sign = line[0], body = line.slice(1);
  if (sign !== '-' && sign !== '+') continue;
  if (sign === '+' && skip.test(body)) problems.push(`new skip/fixme: ${body.trim()}`);
  if (!body.includes('expect(')) continue;
  const m = body.match(matcher);
  (sign === '-' ? removed : added).push(m ? m[0].trim() : '<expect without matcher>');
}

const key = (xs) => [...xs].sort().join('\n');
if (key(removed) !== key(added)) {
  problems.push(`assertions changed:\n  - ${removed.join('\n  - ')}\n  + ${added.join('\n  + ')}`);
}
if (problems.length) {
  console.error('heal-guard: this is not a selector-only fix.\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`heal-guard: ok (${removed.length} assertion line(s) rewritten, matchers unchanged)`);
```

I committed the passing suite and then applied four healer-style patches to `tests/profile.spec.ts`, running the guard after each:

| Patch | Guard | Exit |
| --- | --- | --- |
| `getByTestId('profile-save')` to `getByTestId('save-profile-button')` | `ok (0 assertion line(s) rewritten, matchers unchanged)`, and the test passes again | 0 |
| `toHaveText('Saved')` to `toHaveText('Saving failed')` | `assertions changed: - .toHaveText('Saved'); + .toHaveText('Saving failed');` | 1 |
| `expect(page.getByRole('status'))` to `expect(page.locator('#st'))` | `ok (1 assertion line(s) rewritten, matchers unchanged)` | 0 |
| `test('saving...` to `test.fixme('saving...` | `new skip/fixme: test.fixme('saving the profile shows a confirmation', ...` | 1 |

Row two is the case that matters: a healer that "fixed" the test by agreeing with a regression is rejected with the old and new expectation side by side, which is also exactly what a reviewer needs to see.

Wire it into the pull request workflow next to the suite:

```yaml
# .github/workflows/e2e.yml, Playwright 1.63.0
name: e2e
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: node scripts/heal-guard.mjs origin/${{ github.base_ref }}
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
```

`fetch-depth: 0` is required, otherwise `origin/main` does not exist in the shallow clone and `git diff` fails before the guard can say anything useful. If a PR legitimately changes behaviour, the guard failing is correct: a human changes the assertion in a separate commit, or you add a `heal-guard: allow` label check around the step. The default should stay closed.

## Gotchas and edge cases

**The guard is line-based.** An assertion split across lines (`await expect(locator)` on one line, `.toHaveText('Saved')` on the next) records `<expect without matcher>` on both sides, so a changed expected value on the second line slips through. Either keep `expect(...).toX(...)` on one line (Prettier does that for short assertions) or upgrade the script to parse the file with the TypeScript compiler API and compare `CallExpression` nodes whose callee starts with `to`.

**A locator change can still change meaning.** Row three passed, and it should, but the guard cannot tell whether `#st` is the same element the old locator found. A healer that repoints `expect(page.getByRole('status'))` at some other paragraph that happens to contain "Saved" is a semantic regression the guard allows. Keep locator diffs visible in review, and prefer role-based locators so there are fewer places for this to hide.

**The hook only protects Claude Code.** Cursor, Copilot CLI and Codex have their own hook systems with different payloads. The CI guard is the tool-agnostic layer; the hook is a faster, earlier signal for the agent you run most. The same "deterministic check beats a prompt" argument is behind [rule-based evals being the floor for a coding agent](/2026/06/llm-as-judge-vs-rule-based-evals-for-a-coding-agent/).

**The hook's grep is literal.** It looks for `getByTestId('id')` with single quotes. If your specs use double quotes, template strings or page objects that build ids dynamically, widen the check (for example, grep for the bare id string across `tests/` and page-object folders) and accept a few false positives.

**Healing costs tokens on every red build.** The healer runs on `sonnet` and replays each failing test with a browser snapshot per step. On a suite where one rename breaks forty tests, that is forty debug sessions for one root cause. Layers one and two exist to keep that number near zero. The idea is the same as the [assertion gate in Microsoft's unit-test agent](/2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate/): the agent is allowed to write test code, not to decide what "correct" means.

**What I did not run.** I verified the generated agent files, the failure output, the locator behaviour, the hook and the guard locally. I did not run the healer end-to-end against a live model for this post, so I make no claim about how often it attempts an assertion change on its own; the guard is designed so that the answer does not matter.

### Read next

- [How to write a Claude Code subagent that runs browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/)
- [The new .NET unit-test agent's best idea is not writing tests](/2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate/)
- [LLM-as-judge vs rule-based evals for a coding agent](/2026/06/llm-as-judge-vs-rule-based-evals-for-a-coding-agent/)
- [Fix: a PreToolUse hook returns "allow" but a deny rule still blocks the tool call](/2026/09/fix-pretooluse-hook-allow-still-blocked-by-deny-rule/)
- [How to run a coding agent in a disposable VM or container](/2026/09/run-coding-agents-in-disposable-vms-and-containers/)

### Sources

- [Playwright Test Agents: planner, generator, healer](https://playwright.dev/docs/test-agents)
- [Playwright locators and the recommended locator priority](https://playwright.dev/docs/locators)
- [Playwright `testIdAttribute` option](https://playwright.dev/docs/api/class-testoptions#test-options-test-id-attribute)
- [Claude Code hooks reference: PreToolUse input and exit code 2](https://code.claude.com/docs/en/hooks)
- [`@playwright/test` on npm](https://www.npmjs.com/package/@playwright/test)
