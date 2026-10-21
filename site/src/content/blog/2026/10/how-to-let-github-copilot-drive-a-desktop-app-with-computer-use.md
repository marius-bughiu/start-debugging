---
title: "How to Let GitHub Copilot Drive a Desktop App With Computer Use"
description: "Turn on GitHub Copilot computer use in Copilot CLI and the Copilot app on macOS and Windows, grant the macOS Accessibility and Screen Recording permissions, approve apps per session or always, write prompts that keep the agent read-only, and lock it down with deny rules and the features.computerUse managed setting."
pubDate: 2026-10-21
template: how-to
tags:
  - "github-copilot"
  - "ai-agents"
  - "copilot-cli"
  - "computer-use"
  - "security"
---

**Short answer:** in an interactive Copilot CLI session run `/computer on`, or in the GitHub Copilot app open **Settings > Computer Use** and turn on **Enable Computer Use**. On macOS, grant the computer-use helper **Accessibility** and **Screen Recording** when the setup flow asks. Then describe the outcome, the app, and the limits in plain language ("Open APP_NAME and summarize the status shown in the main window. Do not change any values or submit any forms."), and answer the per-app approval prompt with **Allow** (this session) rather than **Always allow** until you trust the workflow. Computer use is a [public preview announced on October 1, 2026](https://github.blog/changelog/2026-10-01-github-copilot-can-now-interact-with-desktop-apps/), available for local sessions on macOS and Windows only. Everything below was checked against Copilot CLI 1.0.101 (October 20, 2026) and the GitHub docs as of October 21, 2026.

## What computer use adds, and what it does not replace

Until this preview, a Copilot agent could reach a system in four ways: shell commands, file tools, MCP servers, and web fetch. That covers anything with a CLI or an API. It does not cover the expense tool your company bought in 2011, a vendor's Windows-only configuration utility, a presentation you want updated, or the native build of your own app that you want clicked through after a change.

Computer use is the fifth channel. Per the [concept docs](https://docs.github.com/en/copilot/concepts/agents/computer-use), the agent can:

- read accessible application content through the OS accessibility tree, and take screenshots when it needs visual context,
- click controls,
- enter and edit text,
- press keys, scroll, and drag,
- move between applications as part of one workflow.

Mechanically it ships as a **bundled plugin called `computer-use`** that registers its own MCP server and skills. That matters for troubleshooting, because the plugin, the MCP server, and the `/computer` toggle are three things that can disagree. Copilot CLI 1.0.85 fixed one such case ("Computer Use now stays in sync across /computer and whole-plugin /plugin toggles"), per the [CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md).

GitHub's own guidance is blunt about when not to use it: if an API, MCP server, terminal command, file tool, or browser tool can do the job, that tool gives more structured output and more predictable results. Driving a GUI is the slowest, least deterministic option an agent has. Use it for the last mile that has no other door, not as a general-purpose automation layer. If your target is a web app, the browser and Playwright-style tooling in [self-healing E2E tests](/2026/09/self-healing-e2e-tests-when-a-coding-agent-renames-selectors/) is still the better fit.

## Turn it on in Copilot CLI

Computer use is off by default. Start an interactive session in a local terminal on macOS or Windows and check the state first:

```text
# Copilot CLI 1.0.101, macOS or Windows, local session
/computer show
```

`/computer show` reports whether the computer-use plugin, its MCP server, and the associated skills are enabled. Turn it on:

```text
/computer on
```

The CLI saves the preference and enables the bundled plugin. If your organization has disabled the feature, the command reports that it is blocked by managed settings, and no local setting gets around that.

On macOS the first enable walks you through two system permissions:

- **Accessibility**, so the helper can interact with controls.
- **Screen Recording**, so it can inspect windows when the accessibility tree is not enough.

Grant both to the **computer-use helper** that the setup flow names, not to Terminal, iTerm, or your IDE. This is the most common reason the feature is "on" but does nothing: the terminal has Accessibility, the helper does not. The troubleshooting section of the CLI docs points at exactly this check.

To turn it off again:

```text
/computer off
/computer show   # confirm plugin and MCP server are both disabled
```

## Turn it on in the GitHub Copilot app

In the desktop app:

1. Open the app settings.
2. Select **Computer Use** in the sidebar.
3. Under **Enable Computer Use**, turn on **Enable Computer Use**.
4. On macOS, under **Prerequisites**, grant **Accessibility** and **Screen Recording**.
5. If macOS does not register the change, click **Check again**.

`/computer on`, `/computer show`, and `/computer off` also work inside an app session. If the **Computer Use** page is missing entirely, the feature is not available for your account or your OS (Linux is not supported in this preview, in either surface).

## Write a prompt that keeps the agent on rails

The docs give one example prompt, and its shape is the whole lesson: outcome, application, constraints.

```text
Open APP_NAME and summarize the status information shown in the
main window. Do not change any values or submit any forms.
```

The constraint sentence is not decoration. The agent picks its own tools as it goes, and "summarize" plus a visible **Save** button is an ambiguity you do not want resolved by the model. I write computer-use prompts in three blocks:

```text
Goal: Copy the five most recent invoice numbers and totals from the
"Invoices" tab of LegacyBilling into a new file invoices.csv in this repo.

Apps: LegacyBilling (read only), the terminal/file tools for the CSV.

Constraints:
- Do not click Save, Post, Approve, Delete, or anything in the File menu
  inside LegacyBilling.
- If a dialog appears that you did not expect, stop and tell me what it says.
- If the Invoices tab has fewer than five rows, write what is there and stop.
```

Three things in that prompt do real work:

- **Split read and write across channels.** The agent reads from the GUI and writes with file tools. The GUI is the one place you cannot easily diff, so keep its side read-only whenever the task allows.
- **Name the forbidden controls.** "Do not change anything" is vaguer than a list of button labels the model can match against what it sees.
- **Define the stop condition.** Unexpected dialogs are where GUI automation goes wrong: a "Save changes?" prompt with a default button is one Enter key away from a write.

For your own app under test, the pattern is the same with the constraint flipped: let it click freely inside a disposable build, against a test account, with the expected end state described ("the Settings screen shows Dark theme selected and the preview pane is dark").

## Approvals: Allow, Always allow, and the allow-all trap

Computer use follows the permission settings of whatever surface the session runs in. In the CLI that is the active permission mode (`/permissions show` prints it). In the app it is the **Tool Permissions** setting under **Settings > Sessions**.

When approval is required, the prompt names an application, and you choose:

- **Allow**: access to that app for the current computer-use session.
- **Always allow**: saved locally, reused in future sessions.
- Decline or cancel.

Two details from the docs change how you should use **Always allow**:

1. **It is shared across surfaces.** An app you always-allow in the CLI is also always-allowed in the Copilot app on the same machine, and the reverse.
2. **Removing it does not stop a running session.** In the app, **Settings > Computer Use > Always allowed apps** lets you delete an entry, which removes the saved approval for future sessions in both the app and the CLI. Access already granted to a running session stays until you stop the operation and end the session.

Avoid **Always allow** for anything that holds sensitive data or can do something high-impact: mail, chat, banking, admin consoles, your password manager. The docs say this directly, and it is the right default.

Now the trap. Copilot CLI 1.0.64 added "Skip computer-use consent prompts in full allow-all sessions" ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)). If you start with `--allow-all` / `--yolo`, or type `/yolo` mid-session, the per-app question disappears, and the agent can take control of any application on the desktop without asking. That is exactly what allow-all promises, but it is easy to forget that it now covers your whole GUI, not just shell commands. Do not combine allow-all with computer use on your daily machine. If you use [local sandboxing](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/) to make allow-all feel safe, note that the sandbox is documented in terms of processes, files, network, and credentials; the computer-use docs do not describe it as a fence around GUI actions, so treat the two as separate controls.

To stop an operation that is going wrong:

- Copilot CLI: press `Esc` twice.
- Copilot app: click **Stop** or press `Esc`.

## Deny rules beat every approval

Computer use is exposed as an MCP server from the bundled plugin, so the CLI's normal permission patterns apply to it. Per the [command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), a bare server name matches every tool from that server, and deny rules take precedence over allow rules, saved approvals, and `--allow-all`.

First, get the server name the plugin registered on your machine:

```text
/mcp list
```

Then you can run a session where computer use is unavailable no matter what was approved before, without touching your saved preference:

```bash
# Copilot CLI 1.0.101: replace SERVER-NAME with the name /mcp list printed
copilot --deny-tool='SERVER-NAME'

# or keep the server from starting at all for this session
copilot --disable-mcp-server=SERVER-NAME
```

The reverse is also possible: `--allow-tool='SERVER-NAME'` pre-approves every computer-use tool for one session. I would only do that in a throwaway VM, for the same reason as allow-all. Command-line flags apply to the current session only and are never written to `~/.copilot/permissions-config.json`.

## Turn it off for a whole organization

Enterprise admins control this with one key in [enterprise managed settings](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings):

```json
{
  "features": {
    "computerUse": false
  }
}
```

With `false`, users cannot enable computer use in Copilot CLI or the Copilot app, and a local setting cannot override it. `true`, or omitting the key, leaves the decision to each user's local setting. The key is supported in Copilot CLI and the GitHub Copilot app; VS Code, JetBrains, and Copilot cloud agent do not read it, which is consistent with computer use not existing there.

For server-managed rollout the file lives at `copilot/managed-settings.json` in your enterprise's `.github-private` repository, and clients pick up changes within about an hour (a restart or re-sign-in forces it), per [Getting started with enterprise-managed settings](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/use-managed-settings/get-started).

A middle ground many teams will prefer: leave the feature allowed, but set `permissions.disableBypassPermissionsMode` to `"disable"` in the same file. That blocks the allow-all / YOLO mode in the CLI and the app, which is the mode that skips the per-app consent prompt. Note that the managed `permissions.deny` / `ask` / `allow` lists only take `Shell(...)`, `Read(...)`, `Edit(...)` and `Domain(...)` selectors, so you cannot target the computer-use MCP server from there; `features.computerUse` is the only managed switch for this feature.

```json
{
  "features": {
    "computerUse": true
  },
  "permissions": {
    "disableBypassPermissionsMode": "disable"
  }
}
```

## Gotchas and failure modes

**It acts on the real desktop.** This is your logged-in machine, with your accounts. If a notification, a chat window, or a browser tab with your email is on screen, it is visual context that can end up in the model's input. Close or minimize what you would not paste into a chat yourself before you start.

**Timing and window state change results.** The docs list it plainly: it can click the wrong control, type in the wrong field, struggle with custom-drawn or dynamic controls, repeat an action when a window is slow, or stop. Because the agent prefers the accessibility tree and only falls back to screenshots, the general rule of accessibility tooling applies: apps built with standard native controls (Win32, WinForms, WPF, AppKit) expose more structure than canvas-drawn UIs or apps with poor accessibility labels, and you should expect the latter to be less reliable.

**On-screen text is untrusted input.** A document or web page open in the target app can contain instructions. The agent reads it, just as it reads a README. Keep the prompt explicit about which app and which action is in scope, and answer approval prompts by checking that the named app and action match what you asked for.

**"Enabled but nothing happens."** Work through it in this order: `/computer show` (is it on?), `/plugin` (is the bundled `computer-use` plugin enabled?), `/mcp list` (is its MCP server connected?), then on macOS check that the helper, not your terminal, holds both Accessibility and Screen Recording.

**Remote and cloud sessions do not get it.** It is for local sessions on macOS and Windows. A Copilot cloud agent run or a session on a remote host will not drive your desktop, which is the point.

**It is a preview.** Commands, settings names, and the approval flow may change. The `/computer show` output is the quickest way to see what your installed version actually does.

## When to pick computer use, an MCP server, or a script

Use computer use for one-off or low-frequency tasks in software with no other interface, for exploratory checks of a native UI after a change, and for moving a handful of values between two GUI-only tools.

If you find yourself running the same GUI workflow every week, that is a signal to look for, or build, a real interface. A small MCP server wrapping the app's database, export files, or COM/AppleScript surface will be faster, cheaper in tokens, and auditable. Computer use is the right tool to discover what that workflow is; it is rarely the right tool to run it forever.

## Related

- [How to turn on Copilot local sandboxing and restrict what an agent can touch](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/)
- [How to keep Cursor agent tool execution inside your own network](/2026/09/how-to-keep-cursor-agent-tool-execution-inside-your-own-network/), including Cursor's own computer use on self-hosted workers
- [How to export GitHub Copilot app agent sessions to an OpenTelemetry backend](/2026/10/how-to-export-github-copilot-app-agent-sessions-to-an-opentelemetry-backend/), useful for auditing what a computer-use session did
- [Auto mode vs manual approval in Claude Code](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/), the same allow-vs-ask trade-off in another agent
- [What is the GitHub Copilot SDK, and what can you build with it?](/2026/10/what-is-the-github-copilot-sdk-and-what-can-you-build-with-it/)

## Sources

- [GitHub Copilot can now interact with desktop apps with computer use](https://github.blog/changelog/2026-10-01-github-copilot-can-now-interact-with-desktop-apps/) (GitHub changelog, October 1, 2026)
- [About computer use in GitHub Copilot](https://docs.github.com/en/copilot/concepts/agents/computer-use)
- [Using GitHub Copilot CLI to interact with desktop applications](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/computer-use)
- [Using the GitHub Copilot app to interact with desktop applications](https://docs.github.com/en/copilot/how-tos/github-copilot-app/computer-use)
- [Allowing and denying tool use](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools)
- [GitHub Copilot CLI command reference: tool permission patterns](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Enterprise managed settings: features.computerUse](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings)
- [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md), entries for 1.0.64 and 1.0.85
