---
title: "MCP C# SDK 2.4 Serves Agent Skills with skills/list and skills/get"
description: "ModelContextProtocol 2.4.0 ships ModelContextProtocol.Extensions.Skills, an experimental package that implements the SEP-2640 Skills extension: one call to publish a folder of SKILL.md directories, and client helpers that verify every file against a SHA-256 manifest."
pubDate: 2026-11-08
tags:
  - "mcp"
  - "agent-skills"
  - "dotnet"
  - "csharp"
  - "ai-agents"
---

The official MCP C# SDK shipped [v2.4.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.4.0) on November 7, 2026, and the headline is a new package: [ModelContextProtocol.Extensions.Skills](https://nuget.org/packages/ModelContextProtocol.Extensions.Skills). It implements the Skills extension from SEP-2640 (extension id `io.modelcontextprotocol/skills`), so a .NET MCP server can publish [Agent Skills](https://agentskills.io/) next to its tools, resources, and prompts without hand-building a discovery document.

## From a hand-rolled index to two protocol methods

In August, serving skills from a .NET MCP server meant answering a `resources/read` for `skill://index.json` yourself, in a shape the spec draft had already dropped. That workaround is covered in [how to serve Agent Skills from an MCP server with UseMcpSkills](/2026/08/serve-agent-skills-from-an-mcp-server-in-dotnet-with-usemcpskills/). The 2.4.0 package follows the current extension instead, which adds two methods:

- `skills/list` enumerates the skills a server serves, with pagination.
- `skills/get` returns one skill entry by the URI of its `SKILL.md`.

Each entry carries the `SKILL.md` frontmatter as JSON and a manifest of the skill's files, each with a SHA-256 digest and size (or the string `"dynamic"` for generated content). The files themselves remain ordinary MCP resources, fetched lazily through `resources/read`.

## Publishing a folder of skills

If your skills already sit on disk in the Agent Skills layout, registration is one line:

```csharp
using ModelContextProtocol.Extensions.Skills;

#pragma warning disable MCPEXP005 // Skills APIs are experimental in 2.4.0

builder.Services
    .AddMcpServer()
    .WithHttpTransport()
    .WithSkillsFromSubdirectories(Path.Combine(AppContext.BaseDirectory, "Skills"));
```

Every immediate child directory with a `SKILL.md` becomes a skill at `skill://{name}/SKILL.md`. The SDK reads the frontmatter, computes digests from the same bytes it will serve, and registers the file resources. Hidden and system files are skipped, and symbolic links are errors rather than being followed. For finer control, `McpServerSkillPackage.Create` builds a skill from explicit files, and a custom `McpServerSkill` subclass can resolve a scoped repository or `DbContext` from the request's services in `GetAsync`.

## The client side verifies before it trusts

The consuming half lives in `McpSkillsClientExtensions`:

```csharp
if (!client.ServerCapabilities.SupportsSkills())
    return;

IList<Skill> skills = await client.ListSkillsAsync();
Skill skill = await client.GetSkillAsync("skill://git-workflow/SKILL.md");

// Checks manifest membership before any I/O, then URI, size, and digest.
ReadResourceResult contents = await client.ReadSkillResourceAsync(skill, skill.Uri);
```

`ReadSkillResourceAsync` refuses a file that is not in the manifest without sending a request, and throws `InvalidDataException` when bytes, size, or digest do not match. The [Skills docs](https://github.com/modelcontextprotocol/csharp-sdk/blob/v2.4.0/docs/concepts/skills/skills.md) are explicit about one gap: a matching digest does not prove the advertised frontmatter matches the file. The host still has to parse the fetched `SKILL.md` itself and compare it with `skill.Frontmatter` before loading.

## What to watch before adopting

All public Skills APIs carry `[Experimental("MCPEXP005")]`. SEP-2640 is Final, but the extension specification is still Beta, so expect API movement. Two other changes in the release matter even if you ignore Skills:

- The experimental `MCPEXP002` custom-handler delegate changed to `McpRequestHandler<JsonNode?, JsonNode?>` and now receives a `RequestContext<JsonNode?>` ([PR #1993](https://github.com/modelcontextprotocol/csharp-sdk/pull/1993)). This is source- and binary-breaking for extensions compiled against 2.3.x.
- The legacy OAuth metadata fallback now requires explicit opt-in, and refresh tokens are preserved when a refresh response omits a replacement.

If your agents pull skills from an MCP server through another client, check which wire shape that client speaks before switching the server over: `skills/list` and `skills/get` are not the `skill://index.json` resource that earlier clients read. The full change list is in the [v2.4.0 release notes](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.4.0).
