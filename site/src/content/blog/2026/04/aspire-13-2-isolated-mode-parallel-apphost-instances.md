---
title: "Aspire 13.2 --isolated: Run Parallel AppHost Instances Without Port Collisions"
description: "Aspire 13.2 ships an --isolated flag that gives each aspire run its own random ports and secrets store. It unblocks multi-checkout work, agent worktrees, and integration tests that need a live AppHost."
pubDate: 2026-04-18
tags:
  - "aspire"
  - "dotnet-11"
  - "dotnet"
  - "tooling"
---

Running two copies of the same Aspire app at once has always meant fighting `address already in use`. Aspire 13.2, [announced this week](https://devblogs.microsoft.com/aspire/aspire-13-2-announcement/), adds a small but useful flag that removes the fight: `--isolated`. Every invocation gets its own random ports, its own user secrets store, and its own dashboard URL, so two AppHosts can live side by side without any manual port remapping.

## Where the collisions came from

By default `aspire run` binds to fixed ports: the dashboard at 18888, OTLP at 4317/4318, and predictable bindings for each resource. That is fine for a single developer on a single branch. Once you add a second worktree, a coding agent spinning up another instance, or an integration test that wants a live AppHost, everything collides. Teams have been patching this with `launchSettings.json` tweaks or custom port maps, and none of it composes.

## What --isolated actually changes

`--isolated` on `aspire run` or `aspire start` does two things per invocation. First, every port that would normally bind to a fixed number (dashboard, OTLP, resource endpoints) is bound to a random free port instead. Service discovery picks up the dynamic values, so the app itself does not need to know what its siblings chose. Second, the user secrets backing store is keyed by an instance ID unique to the run, so connection strings and API keys do not leak across parallel AppHosts.

A typical two-branch workflow now looks like this:

```bash
# Terminal 1 - feature branch worktree
cd ~/src/my-app-feature
aspire run --isolated

# Terminal 2 - bug fix worktree
cd ~/src/my-app-bugfix
aspire run --isolated
```

Both processes come up, both dashboards are reachable on different URLs, and neither one knows or cares about the other. Shutting one down does not disturb the other's port reservations.

## Why this matters beyond "multiple terminals"

The more interesting consumer is tooling. [Detached mode](https://devblogs.microsoft.com/aspire/aspire-detached-mode-and-process-management/) lets a coding agent start an AppHost with `--detach` and get the terminal back. Combined with `--isolated`, the same agent can spin up N AppHosts across N git worktrees in parallel, run HTTP probes or integration tests against each, and tear them down, all without manual port bookkeeping. That is the pattern VS Code's background agents already use when they create worktrees for exploratory work.

Integration test suites get the same benefit. Previously, running the AppHost from `dotnet test` in CI while a developer had the app open locally needed environment overrides. With `--isolated`, the test fixture can just do:

```csharp
[Fact]
public async Task ApiReturnsHealthy()
{
    var apphost = await DistributedApplicationTestingBuilder
        .CreateAsync<Projects.MyApp_AppHost>(["--isolated"]);

    await using var app = await apphost.BuildAsync();
    await app.StartAsync();

    var client = app.CreateHttpClient("api");
    var response = await client.GetAsync("/health");

    response.StatusCode.Should().Be(HttpStatusCode.OK);
}
```

No static port map, no cleanup between test runs, no "did I leave the app running?" surprises.

## Pairing with --detach and aspire wait

The full agent-friendly loop in 13.2 looks like `aspire run --isolated --detach` to start in the background, `aspire wait api --status healthy --timeout 120` to block until the resource is up, and `aspire resource api restart` to cycle pieces without tearing the whole graph down. `--isolated` is the piece that makes those loops composable across N copies.

For the full list of 13.2 CLI additions, see the [isolated mode documentation](https://devblogs.microsoft.com/aspire/aspire-isolated-mode-parallel-development/).
