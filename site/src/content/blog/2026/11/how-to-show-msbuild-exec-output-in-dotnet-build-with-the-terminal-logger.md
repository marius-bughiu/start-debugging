---
title: "How to show MSBuild Exec output in dotnet build with the terminal logger"
description: "Why the output of an MSBuild Exec task disappears from dotnet build and dotnet restore since .NET 9, why StandardOutputImportance=\"High\" does not bring it back, and the fixes that do: -tlp:verbosity=detailed, Directory.Build.rsp, -tl:off, and promoting lines to warnings. Checked on SDK 10.0.302 and 11.0.100 RC3."
pubDate: 2026-11-09
template: how-to
tags:
  - "dotnet"
  - "msbuild"
  - "dotnet-cli"
  - "build"
  - "how-to"
---

**Short answer:** since .NET 9, `dotnet build`, `dotnet restore` and the other MSBuild-based CLI commands use the terminal logger whenever they run in an interactive terminal, and the terminal logger does not print ordinary task messages, not even `High` importance ones, unless its verbosity is `detailed` or higher. That is why the output of an `<Exec>` task in a custom target vanishes, and why setting `StandardOutputImportance="High"` changes nothing (it is already the effective default). Pass `-tlp:verbosity=detailed` (or put that line in a `Directory.Build.rsp` next to the project), or switch to the classic console logger with `-tl:off` / `MSBUILDTERMINALLOGGER=off`. If the line has to be visible no matter how the build is invoked, turn it into a warning. Everything below was checked with .NET SDK 10.0.302 (MSBuild 18.6.11) and .NET SDK 11.0.100-rc.3.26522.148 (MSBuild 18.12.0) on macOS arm64; both behaved identically.

## The symptom: the script runs, the output is gone

The question comes up in this shape on [Stack Overflow](https://stackoverflow.com/questions/79893500/how-can-i-adjust-the-verbosity-level-in-a-custom-msbuild-target): a project runs a script after restore,

```xml
<!-- ExecDemo.csproj, .NET SDK 10.0.302 / 11.0.100-rc.3 -->
<Target Name="AfterRestore" AfterTargets="Restore">
  <Exec Command="./script/after-restore.sh" />
</Target>
```

and the script writes one line to stdout and one to stderr:

```sh
#!/bin/sh
echo "after-restore: stdout"
echo "after-restore: stderr" >&2
```

With `dotnet restore` in a normal terminal you see `Restore complete (0,2s)` and nothing else. The script ran (it has side effects, and if it fails the build fails), but its output is not shown. The only accepted-ish answer says to add `StandardOutputImportance="High"` and `StandardErrorImportance="High"`. On the terminal logger that does not work, and the reason is useful to understand before picking a fix.

## Why the terminal logger hides Exec output

The terminal logger arrived as opt-in in .NET 8 and became the default for `build`, `clean`, `msbuild`, `pack`, `publish`, `restore` and `test` in [.NET 9](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-9/sdk). Its design goal is a condensed view: one line per project with the result, the primary output as a link, and the diagnostics (warnings and errors). The `-tl` option docs list what that "build completed" section contains, and plain messages are not on the list.

The `Exec` task logs each line of the tool's stdout and stderr as an MSBuild message with an importance level controlled by `StandardOutputImportance` and `StandardErrorImportance` (see the [Exec task reference](https://learn.microsoft.com/visualstudio/msbuild/exec-task)). The classic console logger maps importance to verbosity: `High` messages show at `minimal` (the `dotnet` CLI default), `Normal` at `normal`, `Low` at `detailed`. The terminal logger does something different. To see exactly what, I ran the same one-line target with each importance through both loggers and counted whether the line appeared:

```xml
<!-- .NET SDK 10.0.302: the importance value was varied per run -->
<Target Name="RunTool" AfterTargets="Build">
  <Exec Command="echo out-high" StandardOutputImportance="high" />
</Target>
```

| `StandardOutputImportance` | Classic `-v:m` | Classic `-v:n` | Terminal logger default | TL `-v:n` | TL `-v:d` | TL `-v:diag` |
|---|---|---|---|---|---|---|
| not set | shown | shown | hidden | hidden | shown | shown |
| `Low` | hidden | hidden | hidden | hidden | hidden | hidden |
| `Normal` | hidden | shown | hidden | hidden | hidden | hidden |
| `High` | shown | shown | hidden | hidden | shown | shown |

Three things fall out of that table:

1. **The unset value behaves like `High`.** The classic logger shows it at `minimal`, exactly like an explicit `High`. Setting `StandardOutputImportance="High"` is a no-op for this problem, which is why the Stack Overflow answer does not help anyone on the terminal logger.
2. **The terminal logger only prints `High` messages, and only at `detailed` or `diagnostic` verbosity.** At the default and at `-v:n` the line is hidden. The same was true for `<Message Importance="high" Text="..." />`.
3. **`Normal` and `Low` messages never appear in the terminal logger**, even at `diagnostic`. Lowering the importance to get rid of noise and then raising the verbosity will not work in the terminal logger the way it does in the classic one.

The asker's stderr line follows the same rule: with the default `StandardErrorImportance` it showed at `-v:d` and was hidden at the default.

### Even a failing Exec hides its output

This one surprises people. If the script prints a diagnostic and exits non-zero, you get `MSB3073: The command "./script/after-restore.sh" exited with code 3.` and nothing the script printed:

```text
  ExecDemo net10.0 failed with 1 error(s) (0,1s)
    ExecDemo.csproj(6,47): error MSB3073: The command "echo output-before-fail && exit 3" exited with code 3.

Build failed with 1 error(s) in 0,4s
```

The same project at `-tlp:verbosity=detailed` shows the missing line right above the error:

```text
  ExecDemo net10.0 failed with 1 error(s) (0,2s)
    output-before-fail
    ExecDemo.csproj(6,47): error MSB3073: The command "echo output-before-fail && exit 3" exited with code 3.
```

Both SDK 10.0.302 and SDK 11.0.100 RC3 behaved this way. If you are staring at a bare `MSB3073` in a terminal, rerunning with the flag from the next section is the fastest way to see what your tool said.

## How to make the output visible

1. **Raise only the terminal logger's verbosity for one run.** `-tlp` (`-terminalLoggerParameters`) accepts `verbosity`, which overrides `-verbosity` for the terminal logger alone:

   ```bash
   dotnet restore -tlp:verbosity=detailed
   dotnet build -tlp:verbosity=detailed
   ```

   Output on SDK 10.0.302 for the restore example:

   ```text
   Restore complete (0,2s)
       Determining projects to restore...
       All projects are up-to-date for restore.
       after-restore: stderr
       after-restore: stdout

   Build succeeded in 0,3s
   ```

   You keep the condensed layout, the links and the summary, and you also get every other `High` message in the build (here the two restore lines). It even works combined with `-v:q`, because `-tlp:verbosity` wins for the terminal logger while `-v` keeps applying to any other logger. File loggers and `-bl` binlogs are unaffected either way.

2. **Make it the default for the repository with `Directory.Build.rsp`.** MSBuild reads a response file named `Directory.Build.rsp` from the project directory or any parent and appends its switches to every invocation, including through `dotnet build` and `dotnet restore`:

   ```text
   -tlp:verbosity=detailed
   ```

   With that file next to the project, a plain `dotnet restore` and a plain `dotnet build` both printed the script output on SDK 10.0.302. The switch only affects the terminal logger, so when the build runs with `-tl:off` or in CI where the terminal logger is off, the classic logger keeps its normal behavior (it already shows `High` messages at `minimal`). This is the answer to "can I put something in `Directory.Build.rsp`", and it is the closest thing to a per-repo setting.

3. **Turn the terminal logger off.** For one command use `-tl:off`; for a shell session or a CI job set the environment variable:

   ```bash
   dotnet build -tl:off
   export MSBUILDTERMINALLOGGER=off
   ```

   The classic console logger shows the default-importance `Exec` output at the default `minimal` verbosity, so nothing else needs to change. An explicit `-tl:on` on the command line beats the environment variable: with `MSBUILDTERMINALLOGGER=off` set, `dotnet build -tl:on` still used the terminal logger and still hid the line.

4. **Promote lines that must always be seen to warnings.** The terminal logger always prints diagnostics, at every verbosity. If a tool line is important enough that nobody should miss it (a generated client is out of date, a license is about to expire), capture the output and re-log it with `<Warning>`:

   ```xml
   <!-- .NET SDK 10.0.302 / 11.0.100-rc.3 -->
   <Target Name="RunTool" AfterTargets="Build">
     <Exec Command="./script/check.sh" ConsoleToMSBuild="true">
       <Output TaskParameter="ConsoleOutput" ItemName="ToolOutput" />
     </Exec>
     <Warning Text="%(ToolOutput.Identity)" Code="TOOL001" />
   </Target>
   ```

   `ConsoleToMSBuild="true"` collects every stdout and stderr line into the `ConsoleOutput` item list, and the `%(ToolOutput.Identity)` metadata reference batches the `Warning` task once per line. Result at the default verbosity:

   ```text
     ExecDemo net10.0 succeeded with 2 warning(s) (0,1s)
       ExecDemo.csproj(10,5): warning TOOL001: line-one
       ExecDemo.csproj(10,5): warning TOOL001: line-two

   Build succeeded with 2 warning(s) in 0,4s
   ```

   Use this sparingly. Every line is now a real warning: it counts in the summary, it fails builds that use `TreatWarningsAsErrors` unless you add `TOOL001` to `WarningsNotAsErrors`, and it shows up in IDE error lists.

5. **Or have the tool speak MSBuild's diagnostic format.** By default `Exec` scans output for the [canonical error and warning format](https://learn.microsoft.com/visualstudio/msbuild/msbuild-diagnostic-format-for-tasks) and logs matching lines as real diagnostics. A script you control can opt in per line:

   ```sh
   echo "tool: warning TL100: something odd"
   echo "plain-line"
   ```

   The first line surfaced as `tool : warning TL100: something odd` in the terminal logger at default verbosity; the second stayed hidden. That is the same mechanism compilers use, and it does not need `ConsoleToMSBuild`. If the tool emits lines that accidentally match the pattern, set `IgnoreStandardErrorWarningFormat="true"` to stop the promotion. An `error` line in that format also makes the `Exec` task fail even when the exit code is 0: `echo tool: error TL200: bad thing` printed the error and then `MSB3077: The command ... exited with return value 0, but errors were detected during execution`.

## Which fix to pick

- **You are debugging locally and just want to see what a target printed:** `-tlp:verbosity=detailed` on the command line. It is temporary, does not change the layout, and also shows the output of a failing `Exec` above its `MSB3073`.
- **The output is informational and the whole team should see it in local builds:** `Directory.Build.rsp` with `-tlp:verbosity=detailed`. The cost is the extra `High` messages from the SDK and other targets, which in a small solution is a handful of restore lines.
- **The output is consumed by scripts or people who prefer the old log:** `-tl:off` or `MSBUILDTERMINALLOGGER=off`. In CI you usually do not need either, because `auto` mode already falls back to the classic logger when stdout is redirected, as the [`--tl` option docs](https://learn.microsoft.com/dotnet/core/tools/dotnet-build#options) describe.
- **A line must be noticed by everyone, everywhere:** a warning, through `<Warning>` or the canonical format.

## Gotchas worth knowing

**There is no project-level switch.** Loggers and their verbosity are configured by whoever starts MSBuild, so nothing inside a `.csproj` or `Directory.Build.props` can lower the terminal logger's threshold for one target. The `Directory.Build.rsp` file is the project-adjacent workaround, and it applies to every target in the build, not just yours.

**`-v:n` is not enough.** Several answers in the wild suggest `-v:n`, and on the classic logger that does show the output (plus the echoed command line). Under the terminal logger on SDK 10.0.302 and 11.0.100 RC3, `-v:n` still hid both `High` `Exec` output and `<Message Importance="high">`. The threshold is `detailed`.

**`showCommandLine` needs `detailed` too.** `-tlp:showCommandLine` prints the command `Exec` ran, but on its own it printed nothing extra. Combined as `-tlp:verbosity=detailed;showCommandLine` it put `echo hello-from-exec` above `hello-from-exec`, which is handy when a target builds its command from properties.

**Line order between stdout and stderr is not guaranteed.** In the restore example the stderr line arrived before the stdout line even though the script wrote them the other way round. The two streams are read separately; do not rely on interleaving when you read the log.

**How these results were produced.** All runs used the throwaway `ExecDemo` console project shown above, targeting `net10.0` for SDK 10.0.302 and `net11.0` for SDK 11.0.100-rc.3.26522.148, on macOS arm64. Because the commands' output was captured through a pipe, `auto` mode would have picked the classic logger, so every terminal-logger run passed `-tl:on` explicitly and every classic run passed `-tl:off`. Visibility was checked by counting the marker string in the captured output. The terminal logger help text warns that its output format may change between versions, so recheck on newer SDKs before you script against it.

## Related

- If the build log is too long to read at all, [the Binlog MCP server lets an AI investigate MSBuild builds](/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/) from a `-bl` file, which captures every message regardless of logger verbosity.
- Promoting tool output to warnings interacts with [TreatWarningsAsErrors without sabotaging dev builds](/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/), so decide which codes may stay warnings.
- [Using Tailwind CSS with Blazor WebAssembly in .NET 11](/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) is a worked example of an `Exec` target with `ConsoleToMSBuild` in a real build.
- For what each CLI verb runs under the hood, see [the difference between dotnet build and dotnet publish](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/).

## Sources

- [Stack Overflow: How can I adjust the verbosity level in a custom MSBuild target?](https://stackoverflow.com/questions/79893500/how-can-i-adjust-the-verbosity-level-in-a-custom-msbuild-target)
- [Exec task reference (MS Learn)](https://learn.microsoft.com/visualstudio/msbuild/exec-task)
- [What's new in the SDK and tooling for .NET 9: Terminal Logger enabled by default](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-9/sdk)
- [dotnet build options, including `--tl`](https://learn.microsoft.com/dotnet/core/tools/dotnet-build#options)
- [MSBuild and Visual Studio format for diagnostic messages](https://learn.microsoft.com/visualstudio/msbuild/msbuild-diagnostic-format-for-tasks)
- [MSBuild response files](https://learn.microsoft.com/visualstudio/msbuild/msbuild-response-files)
