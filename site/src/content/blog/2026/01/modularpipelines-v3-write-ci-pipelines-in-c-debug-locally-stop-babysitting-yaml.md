---
title: "ModularPipelines V3: write CI pipelines in C#, debug locally, stop babysitting YAML"
description: "ModularPipelines V3 lets you write CI pipelines in C# instead of YAML. Run them locally with dotnet run, get compile-time safety, and debug with breakpoints."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
---
This week I saw another reminder that CI does not have to be a blind push-and-pray loop: **ModularPipelines V3** is actively shipping (latest tag `v3.0.86` was published on 2026-01-18) and it leans hard into a simple idea: your pipeline is just a .NET app.

Source: [ModularPipelines repo](https://github.com/thomhurst/ModularPipelines) and the [v3.0.86 release](https://github.com/thomhurst/ModularPipelines/releases/tag/v3.0.86).

## The part that changes your feedback loop

If you are shipping .NET 10 services, your pipeline steps are already “code-shaped”: build, test, publish, pack, scan, deploy. The problem is usually the wrapper: YAML, stringly-typed variables, and a 5-10 minute feedback cycle for typos.

ModularPipelines flips that:

-   You can run the pipeline locally with `dotnet run`.
-   Dependencies are declared in C#, so the engine can parallelize.
-   The pipeline is strongly typed, so refactors and mistakes surface like normal compile errors.

Here is the core shape straight from the project’s README, cleaned into a pasteable minimal example:

```cs
// Program.cs
await PipelineHostBuilder.Create()
    .AddModule<BuildModule>()
    .AddModule<TestModule>()
    .AddModule<PublishModule>()
    .ExecutePipelineAsync();

public class BuildModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Build(new DotNetBuildOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}

[DependsOn<BuildModule>]
public class TestModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Test(new DotNetTestOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}
```

This is boring in the best way: it is regular C#. Breakpoints work. Your IDE helps. “Rename a module” is not a scary global search.

## Tool wrappers that keep moving with the ecosystem

The `v3.0.86` release is “small” on purpose: it updates CLI options for tools like `pnpm`, `grype`, and `vault`. That is the kind of maintenance you want a pipeline framework to absorb for you. When a CLI adds or changes a flag, you want a typed wrapper to move, not a dozen YAML snippets to rot.

## Why I like the module model for real repos

On larger codebases, the hidden cost of YAML is not syntax. It is change management:

-   Split pipeline logic by concern (build, test, publish, scan) instead of one mega file.
-   Keep data flow explicit. Modules can return strongly typed results that downstream modules consume.
-   Let analyzers catch dependency mistakes early. If you call into another module, forgetting to declare `[DependsOn]` should not be a runtime surprise.

If you are already living in .NET 9 or .NET 10, treating your pipeline as a small C# app is not “overengineering”. It is a shorter feedback loop and fewer production surprises.

If you want to dig deeper, start from the project’s “Quick Start” and docs: [Full Documentation](https://thomhurst.github.io/ModularPipelines).
