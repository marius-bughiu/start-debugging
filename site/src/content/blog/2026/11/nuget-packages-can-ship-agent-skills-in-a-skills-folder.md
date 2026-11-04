---
title: "NuGet Packages Can Now Carry Agent Skills: What Lives in the skills/ Folder"
description: "On November 3, 2026 the .NET team showed agent skills shipping inside NuGet packages as skills/<name>/SKILL.md. Here is the layout, how restore exposes it through project.assets.json, the two tools that read it today, and what is still missing."
pubDate: 2026-11-04
tags:
  - "nuget"
  - "dotnet"
  - "agent-skills"
  - "ai-agents"
---

Agent skills for .NET have so far come from outside your dependency graph: the [dotnet/skills](https://github.com/dotnet/skills) marketplace, a repo's own `.github/skills` folder, or the [built-in set in Visual Studio 18.8](/2026/08/visual-studio-18-8-built-in-dotnet-agent-skills-off-by-default/). On November 3, 2026 Richard Lander published [Delivering Skills in NuGet packages](https://devblogs.microsoft.com/dotnet/delivering-skills-in-nuget-packages/), which moves the skill next to the code it describes: the library author ships it in the `.nupkg`, and the version you restore is the version your agent reads.

## Same SKILL.md, new home

Nothing about the skill format changes. A skill is still a `SKILL.md` file with a YAML header, following the [agentskills.io](https://agentskills.io/) spec. The post's example, abbreviated here, is a small check that tells the agent how to audit dependencies:

```markdown
---
name: vulnerable-nuget-package-check
description: Check a .NET project for vulnerable NuGet packages dependencies.
---

Run `dotnet package list --vulnerable --include-transitive`.
```

The convention is the folder. Inside the package, every skill sits at `skills/<skill-name>/SKILL.md`. The sample package, [Markout](https://www.nuget.org/packages/Markout) 0.40.0, ships `skills/markout/SKILL.md` and `skills/markout-output-formats/SKILL.md`.

## Getting the folder into the package

The post does not show the project file side. Since the convention is only a path inside the `.nupkg`, the ordinary NuGet pack mechanism for extra content is enough to produce it. This is the standard `Pack`/`PackagePath` pattern, not something the post prescribes, and we have not run it against a skill-aware tool:

```xml
<ItemGroup>
  <None Include="skills/**/*.md"
        Pack="true"
        PackagePath="skills/" />
</ItemGroup>
```

Watch for an official MSBuild item or property in the follow-up; if one arrives, prefer it.

## How consumers see it

Restore does the delivery. After `dotnet restore`, the files sit in the global packages folder (for example `~/.nuget/packages/markout/0.40.0/skills/...`), and their paths are listed in `obj/project.assets.json`. That file is the discovery surface: any tool that reads the assets file can enumerate every skill your resolved graph carries, including transitive ones.

Two tools on NuGet read it today:

- [dotnet-inspect](https://www.nuget.org/packages/dotnet-inspect) lists them, per package or per project:

```bash
dotnet-inspect package markout -S Skills
dotnet-inspect project scratch.csproj -S Skills
```

- [dotnet-package-skills](https://www.nuget.org/packages/dotnet-package-skills) copies them into the repo so agents that scan `.agents/skills` pick them up, and records what it installed in `.agents/skills/.dotnet-package-skills.json`:

```bash
dotnet-package-skills install
```

The [NuGet MCP server](https://learn.microsoft.com/nuget/concepts/nuget-mcp-server) "hasn't yet been updated for skills," per the post.

## What is not there yet

This is a format and plumbing announcement, not an end-to-end feature. In the comments Lander says the post does not show how agents consume package skills, and that this comes next. There is no stated NuGet, SDK, Visual Studio or Copilot CLI version requirement, and no opt-in switch, because no first-party agent reads these folders automatically yet.

Two cautions from the post are worth taking seriously now. First, a skill is markdown that an agent will follow, which makes it a new supply-chain vector: "only use packages from maintainers you trust" now applies to instructions, not just binaries. Reviewing `skills/` in a package diff is as reasonable as reviewing a new `build/` targets file. Second, for authors: the .NET team found that evaluating skills only with cheap models is an anti-pattern. Test with frontier models, and keep skills short, because a badly written one costs tokens on every load.

For library authors, the low-risk move today is to write the `SKILL.md` you would want an agent to read, put it under `skills/`, and wait for the consumer story to land.
