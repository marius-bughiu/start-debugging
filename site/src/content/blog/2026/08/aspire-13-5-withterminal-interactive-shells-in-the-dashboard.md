---
title: "Aspire 13.5 Puts a Real Terminal Inside the Dashboard"
description: "WithTerminal() gives a resource an interactive PTY session you can type into from the dashboard or attach to from your own shell. It is experimental, it detaches the debugger, and the Shell option you may have written against is gone."
pubDate: 2026-08-28
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "tooling"
---

[Aspire 13.5 shipped on August 18, 2026](https://devblogs.microsoft.com/aspire/whats-new-aspire-13-5/) with a redesigned dashboard, TypeScript AppHosts going GA, and a dozen breaking changes. The one that actually changes the inner loop is smaller than any of those: `WithTerminal()`, which gives a resource a live pseudo-terminal you can type into from the dashboard instead of only reading its console log.

## One call, and the resource gets a PTY

```csharp
#pragma warning disable ASPIRETERMINAL001
var agent = builder.AddExecutable("agent", "my-agent", ".")
    .WithTerminal();
#pragma warning restore ASPIRETERMINAL001
```

The API is experimental, so the call raises `ASPIRETERMINAL001` and your AppHost will not build until you acknowledge it, either with the pragma above or by adding the ID to `<NoWarn>`. Once it is on, the resource's Console Logs page in the dashboard gains a terminal view next to the usual log stream, and running resources open in that view by default.

The options overload covers the grid geometry:

```csharp
.WithTerminal(options =>
{
    options.Columns = 200;  // default 120
    options.Rows = 50;      // default 30
});
```

Both must be 1 or greater; zero or negative throws `ArgumentOutOfRangeException`. The third option, `ShowTerminalHost` (default `false`), leaks the implementation in a useful way: it controls "whether the hidden per-replica terminal host resources appear in the dashboard and CLI resource lists." Each replica gets its own independent session behind its own hidden host resource, so `.WithReplicas(3).WithTerminal()` gives you three, and you can switch between them in the dashboard. Order of those two calls does not matter. Calling `WithTerminal()` twice on the same resource throws.

## Attaching from your own shell

The CLI half is behind a feature flag:

```bash
aspire config set features.terminalCommandsEnabled true
aspire terminal ps
aspire terminal attach agent --replica 1
```

Sessions support multiple simultaneous viewers, so a browser tab and a local shell can drive the same process without either one tearing the session down.

## Two sharp edges

The first is the debugger. Per the docs, "when you apply `WithTerminal`, Aspire runs the resource as a plain process and does not automatically attach the debugger." That makes it the wrong tool for the project you are actively stepping through, and the right one for a TUI, a REPL, or a migration script you want to drive by hand. Aspire calls this a temporary limitation.

The second bites anyone who tried this during the 13.4 previews: there is no way to choose which shell launches. The `Shell` option is gone, removed "because it was never wired up to the underlying pseudo-terminal and had no effect." Code that set `TerminalOptions.Shell` stops compiling on 13.5, having done nothing on 13.4.

One upgrade note before you try any of it: the release notes flag that mixing 13.4 and 13.5 packages fails at runtime with `MissingMethodException` or `TypeLoadException`. Move the SDK and every `Aspire.Hosting.*` package to matching versions in the same commit. If you run several AppHosts side by side, this pairs well with [the `--isolated` flag from 13.2](/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/) — each isolated run gets its own terminal sessions along with its own ports.
