---
title: "What is the difference between dotnet watch and dotnet run?"
description: "dotnet run builds your project once and launches it. dotnet watch wraps dotnet run in a file watcher: it relaunches or hot reloads the app every time you save a source file. Here is exactly what each one does, what dotnet watch sets that dotnet run does not, and when to reach for which."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "dotnet-cli"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-11"
---

`dotnet run` builds your project once (Debug by default) and launches the resulting app a single time. When the process exits, you are back at the prompt. `dotnet watch` is a file watcher wrapped around `dotnet run`: it starts the app, then watches your source files, and every time you save a change it either hot reloads that change into the running process or restarts the app. The short version: `dotnet run` is "compile and launch, once"; `dotnet watch` is "keep the app in sync with my code while I edit." They are not competitors. `dotnet watch` literally invokes `dotnet run` under the hood, so everything `dotnet run` does, `dotnet watch` does too, plus the watching and hot reload on top.

Everything below uses the .NET 11 SDK (`11.0.100`) with `<TargetFramework>net11.0</TargetFramework>` and C# 14. The core behavior has been stable since the .NET 6 SDK, when `dotnet watch` gained Hot Reload; version-specific changes are called out where they matter.

## The one-line mental model

Run these two commands back to back and the difference is immediate:

```bash
# .NET 11 SDK 11.0.100, project targeting net11.0.
dotnet run     # builds, launches once, returns to the prompt when the app exits
dotnet watch   # builds, launches, then stays resident watching for file changes
```

`dotnet run` is a terminating command. It does its work and hands control back. `dotnet watch` is a long-lived session. It does not return until you stop it with Ctrl+C. That single behavioral fact, resident versus terminating, is the root of every other difference.

Here is how the two commands line up feature by feature:

| Behavior                        | `dotnet run`                  | `dotnet watch`                                  |
| ------------------------------- | ----------------------------- | ----------------------------------------------- |
| Builds before launch            | Yes (via `dotnet build`)      | Yes (delegates to `dotnet run`)                 |
| Default configuration           | `Debug`                       | `Debug`                                          |
| Launches the app                | Once                          | Once, then relaunches on change                 |
| Watches source files            | No                            | Yes                                              |
| Hot Reload on edit              | No                            | Yes (since .NET 6 SDK)                           |
| Restart on unsupported edit     | N/A                           | Yes (rude edit prompt or auto-restart)          |
| Browser auto-refresh (web apps) | No                            | Yes                                              |
| Returns to prompt when done     | When the app exits            | Only on Ctrl+C                                   |
| Reads `launchSettings.json`     | Yes                           | Yes (through the `dotnet run` it invokes)        |

## dotnet run: build once, launch once

The [dotnet run reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run) describes it as a command that runs your application "from the source code with one command." It depends on `dotnet build`, so any requirement of the build applies to `dotnet run` as well. The sequence is: implicit restore, build to `bin/<configuration>/<framework>/`, then launch the produced binary. It defaults to `Debug` for most projects.

Because `dotnet run` works from the project rather than a built DLL, it also reads `Properties/launchSettings.json` and applies the first launch profile by default. That is where an environment name like `ASPNETCORE_ENVIRONMENT=Development` and any profile environment variables come from. You can opt out with `--no-launch-profile` or select one explicitly with `-lp|--launch-profile`.

Arguments after a literal `--` are forwarded to your app, not to the CLI:

```bash
# .NET 11 SDK 11.0.100. Everything after -- goes to your Main / top-level args.
dotnet run -- --input data.csv --verbose
```

The `--` matters more than it looks. `dotnet run` forwards any token it does not recognize to the application, but it strips its own options first, which can reorder the leftovers. Putting app arguments after `--` marks every following token as an application argument so the CLI does not reinterpret them. It also future-proofs your scripts against new `dotnet run` options that might later collide with a token you meant for the app.

A few things `dotnet run` deliberately does not do. It is not a deployment tool: the docs are explicit that it resolves dependencies from the NuGet cache and "it's not recommended to use `dotnet run` to run applications in production." For that you want `dotnet publish`, which is a separate story covered in [the difference between dotnet build and dotnet publish](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/). And it does not watch anything. Once the app is up, `dotnet run` is finished; it has no idea you just edited a file.

## dotnet watch: dotnet run, plus a file watcher and Hot Reload

The [dotnet watch reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch) puts it plainly: `dotnet watch` "is a file watcher. When it detects a change, it runs the `dotnet run` command or a specified `dotnet` command." If the change is supported for Hot Reload, it applies the change to the running app without restarting. If it is not, it restarts the app.

That is the entire value proposition. You edit a `.cs` file, hit save, and the change is live in a second or two without you touching the terminal. No manual stop, rebuild, relaunch loop.

The default subcommand is `run`, so these two are identical:

```bash
# .NET 11 SDK 11.0.100. 'dotnet watch' with no subcommand defaults to 'run'.
dotnet watch
dotnet watch run
```

Since the .NET 8 SDK, `dotnet watch` accepts `run`, `build`, or `test` as the child command. So `dotnet watch test` reruns your test project on every save, which is a tight red-green-refactor loop that `dotnet run` cannot give you at all.

Forwarded arguments work the same way, delegated to the underlying `dotnet run`:

```bash
# .NET 11 SDK 11.0.100. Args after -- reach the app on every relaunch.
dotnet watch run -- --input data.csv
```

While the session is live you have two keyboard controls. Ctrl+R forces a rebuild and restart even without a file change. Ctrl+C tears the whole thing down, both the watcher and the app. Ctrl+R only does anything while the app is actually running: if you watch a console app that exits immediately, pressing Ctrl+R does nothing, though the watcher keeps watching and will relaunch when a file changes.

## Hot Reload and the "rude edit" that forces a restart

Hot Reload is the piece that makes `dotnet watch` feel magical and is the single biggest thing `dotnet run` does not have. Since the .NET 6 SDK, `dotnet watch` applies eligible edits, method bodies, many statement changes, added members in a lot of cases, into the live process while it keeps running. Your app's in-memory state survives the edit.

Not every edit can be applied to a running process. Changing a method signature, renaming a type, editing something the runtime cannot patch in place: these are "rude edits." When `dotnet watch` hits one, it cannot Hot Reload, and by default it asks what to do:

```
dotnet watch ⌚ Unable to apply hot reload because of a rude edit.
  ❔ Do you want to restart your app - Yes (y) / No (n) / Always (a) / Never (v)?
```

Choose Always and it stops asking and just restarts on every rude edit from then on. You can also skip the prompt entirely: set `DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1` to always restart silently, or run with `--non-interactive` (available since the .NET 7 SDK) so it restarts on rude edits without waiting for console input, which is what you want in scripted or container scenarios. If you would rather not deal with Hot Reload at all and want a plain restart-on-change loop, disable it:

```bash
# .NET 11 SDK 11.0.100. Watch and restart, no Hot Reload.
dotnet watch --no-hot-reload
```

The Hot Reload engine here is the same one Visual Studio uses, and the set of supported versus unsupported edits tracks the same rules; the [Visual Studio 2026 Hot Reload auto-restart on rude edits](/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) behavior mirrors the CLI's. If you understand rude edits in one, you understand them in the other.

## What dotnet watch sets in the environment that dotnet run does not

When `dotnet watch` launches your app, it injects several environment variables that a bare `dotnet run` never sets. These are worth knowing because they let your app detect that it is running under the watcher, and they occasionally explain surprising behavior. The key ones from the docs:

- **`DOTNET_WATCH`** is set to `1` on every child process the watcher launches. This is the clean way to detect "am I running under `dotnet watch`."
- **`DOTNET_WATCH_ITERATION`** starts at `1` and increments by one every time the app is restarted or hot reloaded. You can log it to see how many reload cycles a session has been through.
- **`DOTNET_HOTRELOAD_NAMEDPIPE_NAME`** names the named pipe the watcher uses to push Hot Reload deltas to the running process.

So a build step or a startup diagnostic can branch on the watcher:

```csharp
// .NET 11, C# 14. Detect the watcher from inside the app.
if (Environment.GetEnvironmentVariable("DOTNET_WATCH") == "1")
{
    var iteration = Environment.GetEnvironmentVariable("DOTNET_WATCH_ITERATION");
    Console.WriteLine($"Running under dotnet watch, reload iteration {iteration}");
}
```

There are also several `DOTNET_WATCH_SUPPRESS_*` switches to turn off individual behaviors (browser refresh, launch-browser, emoji output, MSBuild incrementalism). None of these exist in the `dotnet run` world because `dotnet run` has no watching, no Hot Reload channel, and no browser-refresh injection to suppress.

## Which files trigger a reload, and which quietly do not

A common source of confusion: you edit `appsettings.json` under `dotnet watch` and nothing restarts. That is by design. `dotnet watch` watches the items in the project's `Watch` item group, which by default is everything in the `Compile` and `EmbeddedResource` groups, across the entire graph of project references. In practice that means:

- `**/*.cs`
- `*.csproj`
- `**/*.resx`
- Web content: `wwwroot/**`

Configuration files (`.json`, `.config`) deliberately do not trigger a restart, because the configuration system has its own change-detection via `IOptionsMonitor` and reload tokens. If you genuinely want the watcher to react to another file type, extend the `Watch` group in the `.csproj`:

```xml
<!-- .NET 11. Make dotnet watch react to JS files too. -->
<ItemGroup>
  <Watch Include="**\*.js"
         Exclude="node_modules\**\*;**\*.js.map;obj\**\*;bin\**\*" />
</ItemGroup>
```

Since the .NET 10 SDK you can also exclude whole folders that would otherwise cause noisy reloads with `DefaultItemExcludes`, for example an `App_Data` directory the app writes to at runtime. `dotnet run` has none of this machinery because it never re-reads anything after launch.

## For web apps, dotnet watch also refreshes the browser

There is one more `dotnet watch`-only behavior that `dotnet run` does not touch: for ASP.NET Core and Blazor apps, the watcher injects a small browser-refresh script and opens a WebSocket back to the tool. When you save a Razor or CSS change, the browser reloads (or live-updates, for supported Blazor edits) without you switching to it and hitting F5. It is the same reason `dotnet watch` sets `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` and the browser-refresh middleware appears in web projects. Under a plain `dotnet run` you get none of that: change a view, and the browser shows the old page until you rebuild and reload by hand.

One caveat the docs call out: if your app enables response compression, the tool may fail to inject the refresh script and warns about it. The fix is to gate the refresh script yourself or disable compression in development.

## The versions where behavior changed

The mechanics are old and stable, but a few dates are worth pinning:

- **.NET 6 SDK**: `dotnet watch` gained Hot Reload. Before that it was restart-only.
- **.NET 7 SDK**: `--non-interactive` and `--disable-build-servers` arrived.
- **.NET 8 SDK**: `dotnet watch` narrowed its child commands to `run`, `build`, and `test`; earlier it could wrap any `dotnet` command.
- **.NET 9 SDK (9.0.200)**: `dotnet run -e KEY=VALUE` landed, so you can now pass a one-off environment variable straight from the CLI without a launch profile. Because `dotnet watch` forwards to `dotnet run`, you get it under the watcher too. See [dotnet run -e for environment variables without launch profiles](/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/).
- **.NET 10 SDK (10.0.100)**: `dotnet run --file app.cs` for file-based C# apps, and `DefaultItemExcludes` support in `dotnet watch`.
- **.NET 11 SDK**: `dotnet watch` learned to integrate cleanly with Aspire app hosts and to relaunch automatically after a crash, detailed in [dotnet watch in .NET 11: Aspire hosts and crash recovery](/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/).

## Which one to run

Reach for `dotnet run` when you want to launch the app once: to sanity-check a change, to run a console tool, to script a single invocation in CI, or any time you do not plan to edit code while it runs. It builds, it launches, it exits with the app. It is the simplest thing that gets your code running.

Reach for `dotnet watch` when you are in an edit-save-see loop: iterating on an API, styling a Blazor page, red-green cycling with `dotnet watch test`, or debugging something that takes a few edits to pin down. It costs you a resident terminal, and Hot Reload occasionally drops to a restart on a rude edit, but in exchange you stop paying the manual rebuild-relaunch tax on every single change.

The one-sentence test: if you are going to run the app and then keep typing in your editor, use `dotnet watch`; if you just want it to run, use `dotnet run`. Neither replaces `dotnet publish`, which is still the only supported way to produce something you actually ship.

## Related

- [What is the difference between dotnet build and dotnet publish?](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)
- [dotnet watch in .NET 11 Preview 3: Aspire hosts, crash recovery, and saner Ctrl+C](/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/)
- [.NET 11 Preview 3: dotnet run -e sets environment variables without launch profiles](/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [Visual Studio 2026: Hot Reload auto-restart on rude edits](/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/)
- [.NET 11 Preview 5: file-based apps get the #:ref directive](/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)

## Sources

- [dotnet watch command reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch) (Microsoft Learn)
- [dotnet run command reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run) (Microsoft Learn)
- [dotnet build command reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build) (Microsoft Learn)
- [Supported .NET app frameworks and scenarios for Hot Reload](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) (Microsoft Learn)
