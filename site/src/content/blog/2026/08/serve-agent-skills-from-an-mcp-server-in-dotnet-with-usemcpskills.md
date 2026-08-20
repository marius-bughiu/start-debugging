---
title: "How to Serve Agent Skills from an MCP Server in .NET with UseMcpSkills"
description: "Stop shipping SKILL.md folders inside every agent deployment. Serve them from an MCP server and pull them with UseMcpSkills on Microsoft.Agents.AI.Mcp 1.18. Includes the exact skill://index.json shape, a working C# server, the wire trace, and the SEP-2640 drift that will bite you."
pubDate: 2026-08-20
tags:
  - "mcp"
  - "agent-skills"
  - "microsoft-agent-framework"
  - "ai-agents"
  - "llm"
  - "dotnet"
  - "csharp"
---

If your agent loads its skills from a folder on disk, every skill edit is a redeploy. `Microsoft.Agents.AI.Mcp` 1.18.0-alpha adds `UseMcpSkills`, which points an `AgentSkillsProviderBuilder` at a connected `McpClient` and pulls skills from an MCP server instead. The server advertises them in a single JSON discovery document at the resource URI `skill://index.json`, and the framework fetches each `SKILL.md` body only when the model actually asks for it. The catch, and the reason this post exists: the shape `UseMcpSkills` expects was removed from the SEP-2640 draft on 2026-07-13, so a server written to today's spec is invisible to today's .NET client unless you serve both.

Everything below was run against .NET SDK 10.0.201, `Microsoft.Agents.AI` 1.18.0, `Microsoft.Agents.AI.Mcp` 1.18.0-alpha.260818.1, and a server on the `ModelContextProtocol` C# SDK 2.2.0.

## Why move skills off the filesystem

An Agent Skill is a directory with a `SKILL.md` file: YAML frontmatter carrying a `name` and `description`, then a markdown body with the actual instructions. The [Agent Skills specification](https://agentskills.io/specification) defines a progressive disclosure model where only the name and description sit in the system prompt, and the body is pulled in on demand.

The default .NET source, `AgentFileSkillsSource`, discovers those directories from disk. That works fine until you have three services that all need the same "how we handle refunds" skill. Now the skill lives in three repos, drifts in two of them, and a policy change is three pull requests and three deployments.

Serving the same skill from an MCP server collapses that: one team owns the skill content, every agent that connects sees the current version on its next run, and the skills travel over the same connection you already opened for tools. If you are already exposing an internal API through MCP, the [tool-surface design tradeoffs](/2026/08/mcp-server-design-for-a-large-internal-api-surface/) apply here too, except skills cost you nothing in the tool list: they ride on the Resources primitive, not on `tools/list`.

## What UseMcpSkills actually asks the server for

There is no skills capability negotiation and no new protocol method involved. The MCP skills source issues exactly one `resources/read` for the URI `skill://index.json` and parses the result as a discovery document. The DTO in the shipped package (`McpSkillIndex` and `McpSkillIndexEntry`) binds these fields:

```json
{
  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  "skills": [
    {
      "name": "invoice-audit",
      "description": "Audits a supplier invoice against the purchase order and flags mismatched line items.",
      "type": "skill-md",
      "url": "skill://invoice-audit/SKILL.md"
    }
  ]
}
```

`type` is the distribution mode. `skill-md` means the `SKILL.md` and its sibling files are served as individual MCP resources and fetched file by file. `archive` means `url` points at a ZIP, TAR, or gzip-compressed TAR that the client downloads and unpacks locally. A third value, `mcp-resource-template`, is described in the DTO as part of the MCP binding but is not implemented by the 1.18 loaders: an entry carrying it is dropped with a "Skipping skill index entry" log and never reaches the model. I confirmed that by adding one alongside a working `skill-md` entry, and only the `skill-md` skill was advertised. Plan for `skill-md` and `archive` only.

Two details are worth pinning down, because the DTO documentation and the runtime do not quite agree with the prose docs.

The `digest` field exists on the entry type but is explicitly omitted under the MCP binding, on the reasoning that integrity is the transport's problem over an authenticated connection. Do not bother computing SHA-256 digests for this document; nothing verifies them.

And `$schema`, described as required by the base schema, is not enforced. An index document without it parses and loads fine. Emit it anyway for forward compatibility, but do not expect a validation error if you forget.

## A skills server in about 40 lines

This is a stdio server on the MCP C# SDK 2.2.0. It answers two things: `resources/list`, so the resources are discoverable by generic clients, and `resources/read` for the index and each skill file. The general project setup is the same one covered in [building a custom MCP server in C#](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), so only the skills-specific handlers are shown here.

```csharp
// .NET 10.0.201, ModelContextProtocol 2.2.0
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Protocol;

var builder = Host.CreateApplicationBuilder(args);
builder.Logging.ClearProviders(); // stdio transport: never write logs to stdout

var files = new Dictionary<string, string>
{
    ["skill://invoice-audit/SKILL.md"] =
        "---\nname: invoice-audit\ndescription: Audits a supplier invoice against the purchase order and flags mismatched line items.\n---\n\n# Invoice audit\n\n1. Read the invoice header and match the PO number.\n2. Compare each line item quantity and unit price.\n3. Read `references/tolerances.md` for the approved variance thresholds.\n",
    ["skill://invoice-audit/references/tolerances.md"] =
        "Unit price variance tolerance: 2 percent. Quantity variance tolerance: 0 units.",
};

var index = new Dictionary<string, object>
{
    ["$schema"] = "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    ["skills"] = new[]
    {
        new
        {
            name = "invoice-audit",
            description = "Audits a supplier invoice against the purchase order and flags mismatched line items.",
            type = "skill-md",
            url = "skill://invoice-audit/SKILL.md",
        },
    },
};

builder.Services.AddMcpServer(o => o.ServerInfo = new Implementation { Name = "skills-server", Version = "1.0.0" })
    .WithStdioServerTransport()
    .WithListResourcesHandler((ctx, ct) => ValueTask.FromResult(new ListResourcesResult
    {
        Resources =
        [
            new() { Uri = "skill://index.json", Name = "index.json", MimeType = "application/json" },
            .. files.Keys.Select(u => new Resource { Uri = u, Name = u, MimeType = "text/markdown" }),
        ],
    }))
    .WithReadResourceHandler((ctx, ct) =>
    {
        var uri = ctx.Params?.Uri ?? "";
        var text = uri == "skill://index.json"
            ? JsonSerializer.Serialize(index)
            : files.TryGetValue(uri, out var body)
                ? body
                : throw new InvalidOperationException($"unknown resource {uri}");

        return ValueTask.FromResult(new ReadResourceResult
        {
            Contents = [new TextResourceContents { Uri = uri, MimeType = "text/markdown", Text = text }],
        });
    });

await builder.Build().RunAsync();
```

Sibling resources are resolved by string surgery, not by any listing. The client computes the skill root by stripping the trailing `SKILL.md` off the entry `url`, then appends whatever relative name the model passed to `read_skill_resource`. So `skill://invoice-audit/SKILL.md` plus `references/tolerances.md` becomes a `resources/read` for `skill://invoice-audit/references/tolerances.md`. Keep the URI layout mirroring a real directory tree and this works. Get creative with the paths and it breaks.

Nothing privileges the `skill://` scheme at the protocol level, but the index URI is hardcoded in the client, so the discovery document must live at exactly `skill://index.json`. The individual skill URIs can use any scheme you like, as long as the index points at them.

## Wiring the client

On the agent side, connect an `McpClient` and hand it to the builder:

```csharp
// Microsoft.Agents.AI 1.18.0, Microsoft.Agents.AI.Mcp 1.18.0-alpha.260818.1
await using McpClient client = await McpClient.CreateAsync(
    new StdioClientTransport(new()
    {
        Name = "skills-server",
        Command = "dotnet",
        Arguments = [skillsServerPath],
    }));

using var skillsProvider = new AgentSkillsProviderBuilder()
    .UseMcpSkills(client)
    .Build();

AIAgent agent = chatClient.AsAIAgent(new ChatClientAgentOptions
{
    Name = "SkillsAgent",
    ChatOptions = new() { Instructions = "Use the available skills when they match the task." },
    AIContextProviders = [skillsProvider],
});
```

`AgentMcpSkillsSource` itself is internal, so `UseMcpSkills` on the builder is the only public door. That also means you cannot enumerate the discovered skills directly. To see what the model gets, look at what the provider injects.

Running that agent against a stub `IChatClient` that records its inputs, the first request carries these instructions verbatim:

```text
You have access to skills containing domain-specific knowledge and capabilities.
Each skill provides specialized instructions, reference documents, and assets for specific tasks.

<available_skills>
  <skill>
    <name>invoice-audit</name>
    <description>Audits a supplier invoice against the purchase order and flags mismatched line items.</description>
  </skill>
</available_skills>

When a task aligns with a skill's domain, follow these steps in exact order:
- Use `load_skill` to retrieve the skill's instructions.
- Follow the provided guidance.
- Use `read_skill_resource` to read any referenced resources, using the name exactly as listed
   (e.g. `"style-guide"` not `"style-guide.md"`, `"references/FAQ.md"` not `"FAQ.md"`).
- Use `run_skill_script` to run referenced scripts, using the name exactly as listed.
Only load what is needed, when it is needed.
```

Plus three tools: `load_skill`, `read_skill_resource`, and `run_skill_script`. That advertisement block is roughly 150 tokens for one skill and grows by about a line per skill. Replace the template with `UsePromptTemplate` if you need it shorter, keeping the `{skills}` placeholder.

The name and description in that block come from the **index document**, not from the `SKILL.md` frontmatter. Changing the index description to something different from the frontmatter and re-running proves it: the index copy is what reaches the model, and the frontmatter copy is never read at advertisement time. Treat the index as the authoritative catalog, and generate it from the frontmatter at build time so the two cannot drift.

## What actually crosses the wire

Logging every request the server handled during one agent run, with the model choosing not to touch the skill:

```text
resources/read skill://index.json
```

That is the entire cost of advertising. When the model does call `load_skill`, one more line appears:

```text
resources/read skill://index.json
resources/read skill://invoice-audit/SKILL.md
```

`resources/list` is never called. The `SKILL.md` body is fetched on the first `load_skill` and cached on the skill instance for the rest of the process. The builder also caches the resolved skill list by default, so the index is read once per provider, not once per run. Call `DisableCaching()` on the builder if you want a long-lived agent to notice new skills without a restart.

## Archive skills and the limits that silently drop them

For an `archive` entry, `url` points at a resource whose `resources/read` returns binary content. The client downloads it, detects the format from the media type or extension (`.zip`, `.tar`, `.tar.gz`, plus `application/zip`, `application/gzip`, `application/x-tar` and friends), and unpacks it under `ArchiveSkillsDirectory`.

```csharp
var skillsProvider = new AgentSkillsProviderBuilder()
    .UseMcpSkills(client, new AgentMcpSkillsSourceOptions
    {
        ArchiveSkillsDirectory = Path.Combine(AppContext.BaseDirectory, "extracted-skills"),
        ArchiveMaxFileCount = 50,
        ArchiveMaxSizeBytes = 2 * 1024 * 1024,
        ArchiveMaxUncompressedSizeBytes = 4 * 1024 * 1024,
    })
    .Build();
```

The defaults are deliberately tight: 20 files, 1 MB downloaded, 1 MB uncompressed, a resource search depth of 2, and an extension allowlist of `.md`, `.json`, `.yaml`, `.yml`, `.csv`, `.xml`, and `.txt`. An archive that exceeds any limit is skipped and logged, not truncated, so a skill that silently fails to appear is usually a limit rather than a transport problem. Extraction also refuses any entry whose resolved path escapes the target directory.

Scripts bundled in an archive are never executed, by design. Executable content arriving from a remote server does not get a runner. If your skill needs to run something, it has to be a `skill-md` entry backed by local scripts, or a tool on the same server.

When `ArchiveSkillsDirectory` is left null, each source instance extracts to a fresh GUID-named directory under the current working directory. That avoids collisions between sources but leaks directories across restarts, so set it explicitly in anything long-lived. Stale skill directories are pruned on reconcile, but only when they are no longer advertised.

## The spec moved and the package did not

Here is the part that will cost you an afternoon if nobody tells you.

The documentation on the client's index URI constant calls `skill://index.json` the "SEP-2640 canonical discovery document URI". That was true when it was written. It is not true of the current draft. Walking the commit history of [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640):

- 2026-07-08: "Remove archive distribution from skills extension"
- 2026-07-13: "Replace `skill://index.json` with a `skills/list` method"
- 2026-07-15: "Add `skills/get` for single-skill entry retrieval"

The draft, still open and last touched 2026-08-15, now defines an extension identified as `io.modelcontextprotocol/skills`. A server declaring it MUST implement `skills/list` and `skills/get`, returning entries that carry a `uri`, the parsed `frontmatter`, and a `resources` manifest with per-file `sha256:` digests that hosts MUST verify. Archive distribution is gone entirely.

`Microsoft.Agents.AI.Mcp` 1.18.0-alpha, published 2026-08-18, still implements the pre-July shape: index document, no capability declaration, no digests, plus the `archive` type the spec dropped. Other hosts have moved the other way. The fast-agent documentation, for instance, describes index-based servers as legacy and unsupported.

The practical consequence is blunt. A server that only implements `skills/list` is invisible to `UseMcpSkills`, which reads one URI and gives up when it is missing, logging "No skill://index.json resource available on MCP server". A server that only serves `skill://index.json` is invisible to a SEP-conformant host.

Until the .NET package catches up, serve both. Both are read-only projections over the same set of files, so the duplication is a serialization concern, not a content one: keep one in-memory catalog keyed by skill name, render it as an index document for the `skill://index.json` read, and render the same entries as `skills/list` results with digests computed over the file bytes. Pin the package version in your `csproj` while you do it. This is prerelease surface, the docs say the MCP skills API is experimental and may change, and given the spec churn, "may" is doing very little work in that sentence.

One more version detail: 1.18.0-alpha depends on `ModelContextProtocol` 1.2.0 on the client side. If your host app already moved to the [2.0 SDK with its stateless defaults and MCP9005 diagnostics](/2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005/), expect NuGet to unify that reference upward, and test the client path rather than assuming it.

## Approvals, and the tool that shows up anyway

All three skill tools require approval by default. `AgentSkillsProviderOptions` exposes `DisableLoadSkillApproval`, `DisableReadSkillResourceApproval`, and `DisableRunSkillScriptApproval`, and `AgentSkillsProvider.ReadOnlyToolsAutoApprovalRule` auto-approves the two read-only tools while leaving script execution gated. That is the sane default for a remote skills server, and it composes with the same approval machinery described in [gating risky tool calls behind FunctionApprovalRequestContent](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/).

One discrepancy to know about: the documentation states that `read_skill_resource` is advertised only when at least one skill has resources, and `run_skill_script` only when at least one skill has scripts. In 1.18.0 on .NET that is not what happens. An MCP-sourced skill with no scripts produced all three tools, and so did a plain `AgentInlineSkill` with no scripts and no resources, which rules out the MCP source as the cause. Budget for three tool schemas regardless of what your skills contain, and remember that `run_skill_script` is visible to the model even when nothing can answer it.

Finally, the obvious one that is easy to wave away: the skill body is instructions the model will follow, and an MCP server you did not write controls that text. `UseMcpSkills` is documented as an explicit opt-in to loading remote instructions, and the security note on the options type is there because the archive limits bound how much an external system can write to your disk. Point it at servers you own or have vetted, the same posture worth taking when [replacing archived reference servers with third-party maintained ones](/2026/08/migrate-off-archived-mcp-reference-servers/).

## Related reading

- [How to Build a Custom MCP Server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) for the project scaffolding and transport choices underneath this server.
- [MCP C# SDK 2.0 Ships: Stateless by Default and MCP9005 on Your Old Code](/2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005/) for what changed in the SDK this server runs on.
- [How to Package Reusable Domain Expertise as an Agent Skill in .NET](/2026/07/package-domain-expertise-as-an-agent-skill-microsoft-agent-framework/) for the A2A `AgentSkill` route, which solves a different problem than the file-format skills here.
- [How to Package Skills and an MCP Server as One Agent Plugin](/2026/08/package-skills-and-an-mcp-server-as-one-agent-plugin/) for distributing skills and tools to coding agents rather than to your own app.
- [MCP Server Design for a Large Internal API Surface](/2026/08/mcp-server-design-for-a-large-internal-api-surface/) for keeping the tool list small when the same server also exposes tools.

## Sources

- Microsoft Learn, [Agent Skills](https://learn.microsoft.com/en-us/agent-framework/agents/skills), covering `AgentSkillsProviderBuilder`, MCP-based sources, and `AgentMcpSkillsSourceOptions`.
- Microsoft DevBlogs, [Discover Agent Skills from MCP servers in .NET](https://devblogs.microsoft.com/agent-framework/discover-agent-skills-from-mcp-servers-in-net/), published 2026-07-28.
- [SEP-2640: Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640), draft, for `skills/list`, `skills/get`, and the `io.modelcontextprotocol/skills` extension identifier.
- The [Agent Skills specification](https://agentskills.io/specification) for the `SKILL.md` format and the progressive disclosure model.
- XML documentation and IL shipped in [Microsoft.Agents.AI.Mcp](https://www.nuget.org/packages/Microsoft.Agents.AI.Mcp) 1.18.0-alpha.260818.1, for the index DTO field requirements and archive extraction limits.
