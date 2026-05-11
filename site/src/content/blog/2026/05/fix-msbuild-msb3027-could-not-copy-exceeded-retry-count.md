---
title: "Fix: MSB3027 Could not copy X to Y. Exceeded retry count of 10. Failed"
description: "MSB3027 means MSBuild retried a file copy 10 times and a process still held the destination. Kill the locking process, exclude bin/obj from antivirus, or raise CopyRetryCount."
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "csproj"
---

The fix: MSBuild's `Copy` task tried ten times, with one-second pauses, to overwrite a file in your `bin/` directory and a process still held a handle on it. Find the holder with `handle.exe` or Resource Monitor, kill it, and rebuild. On Windows the holder is almost always the previous run of your own program (`apphost.exe`, `MyApp.exe`, an IIS Express worker, or a `dotnet watch` child), the `MSBuild.exe` build-server staying resident under Visual Studio, or a real-time antivirus scanner that opened the freshly produced DLL for inspection a few milliseconds before MSBuild tried to overwrite it. If you cannot fix the source of the lock, raise `CopyRetryCount` and `CopyRetryDelayMilliseconds` in `Directory.Build.props` and move on.

```text
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed. The file is locked by: ".NET Host (4176)"  [C:\src\MyApp\MyApp.csproj]
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' because it is being used by another process.
```

This article is written against .NET SDK 11.0.100-preview.4, MSBuild 17.13, and Visual Studio 17.14. The `Copy` task and the MSB3027 message string have been stable since MSBuild 15 (Visual Studio 2017), so the same checklist applies to every modern SDK-style project from `net6.0` through `net11.0`. What changed recently is the retry behaviour: between SDK 7.0.306 and 7.0.400 the retry path on some `IOException` subtypes was tightened, which is why CI failures that used to be invisible (the retry succeeded) now surface as MSB3027.

## What MSB3027 actually means

`MSB3027` is raised by the `Copy` MSBuild task at the end of its retry loop. The task is wired up by the standard `_CopyFilesMarkedCopyLocal` and `CopyFilesToOutputDirectory` targets inside `Microsoft.Common.CurrentVersion.targets`, which fire near the end of every `dotnet build`. The loop is governed by two properties:

- `CopyRetryCount` defaults to `10`. The task fails after this many consecutive failures.
- `CopyRetryDelayMilliseconds` defaults to `1000`. The task sleeps this long between retries.

So the full ten-retry window is roughly ten seconds. If a process holds the destination file for longer than ten seconds, MSB3027 fires. MSBuild prints the inner exception (`System.IO.IOException`) on the next line as `MSB3021`, which is why the two error codes nearly always travel together.

The Microsoft Learn entry for [MSB3027](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) names the four canonical causes: another program holds the file, your account cannot write the destination, the drive is full, or the network share dropped. In practice on a developer workstation, the first cause accounts for well over 95 percent of the traffic.

## Why this happens (in priority order)

These are the seven recurring causes, ranked by how often they explain the failure on a real .NET 11 project.

1. **The previous run of your own program is still alive.** Console apps that block on `Console.ReadKey`, dotnet `IHostedService` workers waiting on a graceful shutdown, and orphaned `apphost.exe` processes from a crashed debugger session all keep a file lock on the main executable. The error message names the process directly, for example `The file is locked by: ".NET Host (4176)"`.
2. **IIS Express or the Kestrel app pool is holding the assembly.** `dotnet run`, `iisexpress.exe`, and the IIS worker process (`w3wp.exe`) keep an exclusive read share on the loaded DLL. A build started from Visual Studio while the previous F5 session is still running hits this every time.
3. **`dotnet watch` is mid-rebuild.** Hot reload swaps assemblies in place, but on a rude edit it triggers a full restart and there is a small window where the old process and the new build both touch the same file. Source-generator-heavy projects amplify this because the generator output DLL is copied twice. The dotnet SDK has tracked this as [dotnet/sdk#40911](https://github.com/dotnet/sdk/issues/40911) since the .NET 8 timeframe.
4. **Real-time antivirus scanned the file the moment MSBuild wrote it.** Windows Defender, CrowdStrike Falcon, SentinelOne, and similar tools open every new `.exe` and `.dll` for inspection. The scan finishes in a few hundred milliseconds, but if the next project in a parallel build needs to copy that same file, the copy can race the scanner. Defender exclusions for the repo root remove this entire failure mode.
5. **OneDrive or another sync client opened the file.** OneDrive's "Files On-Demand" feature opens a write handle on any file under a synced folder when it dehydrates or rehydrates content. If your source tree lives under `C:\Users\<you>\OneDrive\...`, this triggers MSB3027 randomly during long builds.
6. **The MSBuild build server (or VS BuildHost) is still attached.** With `MSBUILDDISABLENODEREUSE=0` (the default), MSBuild keeps `MSBuild.exe` nodes alive between builds. Inside Visual Studio, the equivalent is `VBCSCompiler.exe` and the Roslyn build server. These almost never hold copy targets, but a hung node can pin a recently-compiled assembly.
7. **Parallel projects in one solution copy the same file at the same instant.** Two projects in the same `.sln` that depend on a shared library each try to copy that library into their own output. With `/m` parallelism, the second copy can hit MSB3021 on `OpenWrite` and exhaust the retry budget. This regressed in SDK 7.0.400 and is tracked at [dotnet/msbuild#9169](https://github.com/dotnet/msbuild/issues/9169).

## Minimal repro: a console app that holds its own binary open

The smallest reproducer is a console app that does not exit. Save this as `MyApp/Program.cs` and `MyApp/MyApp.csproj`:

```xml
<!-- MyApp.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// Program.cs - .NET 11, C# 14
Console.WriteLine("running, press any key to exit");
Console.ReadKey();
```

Start it in one terminal:

```text
dotnet run
```

Then change `Program.cs` (add a space) and from a second terminal:

```text
dotnet build
```

The second build prints:

```text
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file because it is being used by another process.
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed.
```

This is the canonical case. The first terminal owns the DLL because the .NET host opened it with `FILE_SHARE_READ` only, which excludes writes.

## The fix, in detail

### 1. Find the locking process and kill it

The error message after `MSB3027` lists the process when MSBuild can resolve it. When it cannot (typically inside containers or on locked-down machines), reach for one of these:

```text
:: sysinternals handle.exe - https://learn.microsoft.com/sysinternals/downloads/handle
handle64.exe -nobanner -accepteula C:\src\MyApp\bin\Debug\net11.0\MyApp.dll
```

```powershell
# Get-Process by module path (PowerShell 7.4+)
Get-Process | Where-Object { $_.Modules.FileName -contains 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' }
```

```text
:: Kill by image name
taskkill /im MyApp.exe /f
:: Or by PID from handle.exe output
taskkill /pid 4176 /f
```

For IIS Express: right-click the system tray icon and `Exit All`, or `iisexpress /stop /siteid:<id>`. For full IIS, an `iisreset` is the blunt option; a `Stop-WebAppPool -Name "<pool>"` is the surgical one.

### 2. Stop running the program from the same terminal you build from

The cleanest fix is workflow: do not leave a debug session attached while you rebuild. In Visual Studio, the `Edit and Continue` and `Hot Reload` paths usually handle this for you. From the command line, prefer `dotnet watch` (which is aware of the rebuild) over a manual `dotnet run` plus a separate `dotnet build` loop.

If you are on `dotnet watch` itself and seeing MSB3027 on every rebuild, the symptom is usually a source generator whose output DLL is being rewritten on each compile. The workaround documented in the SDK repo is to move the generator into a separate `.csproj` with `<EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>` and `<EmitCompilerGeneratedFiles>false</EmitCompilerGeneratedFiles>`, then reference the generator project with `OutputItemType="Analyzer" ReferenceOutputAssembly="false"`. The generator's DLL stops being a copy target.

### 3. Add antivirus exclusions for the repo

For Microsoft Defender, open `Windows Security` > `Virus & threat protection` > `Manage settings` > `Exclusions` > `Add or remove exclusions` > `Add an exclusion` > `Folder`, and add:

- The repo root, or at minimum every `bin/` and `obj/` subdirectory.
- `%USERPROFILE%\.nuget\packages` (NuGet's global cache).
- `%USERPROFILE%\.dotnet` (the SDK install).

For CrowdStrike / SentinelOne / corporate-managed Defender, you cannot do this yourself; file a ticket with the IT team and reference your team's `.gitattributes` or `.editorconfig` as proof that the bin/obj folders are build artefacts, not user data. Microsoft's own [Defender exclusions documentation](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus) confirms that real-time scanning of build output is the leading cause of intermittent MSBuild failures in enterprise environments.

### 4. Move the repo off OneDrive

If `pwd` inside your repo prints `C:\Users\<you>\OneDrive\source\...`, move it. Sync clients of any kind (OneDrive, Dropbox, Google Drive, iCloud) own a write handle on files they are uploading or hydrating, and they release that handle on their own clock, not MSBuild's. `C:\src\<repo>` outside any synced folder is the standard layout for .NET work on Windows.

### 5. Raise the retry budget (last resort)

If the lock is unavoidable (CI agent with a shared cache, antivirus you cannot exclude, parallel build hitting a shared dependency), raise the budget. Put this in `Directory.Build.props` at the repo root so it applies to every project:

```xml
<!-- Directory.Build.props - .NET 11 SDK, MSBuild 17.13 -->
<Project>
  <PropertyGroup>
    <CopyRetryCount>20</CopyRetryCount>
    <CopyRetryDelayMilliseconds>2000</CopyRetryDelayMilliseconds>
  </PropertyGroup>
</Project>
```

That gives the `Copy` task forty seconds of retry budget. Numbers higher than that just hide a more serious problem (a stuck process, a misconfigured antivirus) and make every failed build take a minute to surface, so do not raise them past `CopyRetryCount=20`.

For the CI-specific case where parallel projects race on the same shared DLL, the better fix is to set `BuildInParallel=false` for the offending solution or to mark the shared library as a `<PackageReference>` to a NuGet feed instead of a `<ProjectReference>`. Both make the race vanish.

### 6. Disable the build server when MSBuild nodes hang

Hung MSBuild nodes are rare but visible: `tasklist /fi "imagename eq MSBuild.exe"` shows nodes that have not been reused for many minutes. Shut them down with:

```text
dotnet build-server shutdown
```

Run this between builds in scripts that experience intermittent MSB3027, or set `MSBUILDDISABLENODEREUSE=1` to disable node reuse altogether. Build times go up by a few seconds, but the long-tail file-lock failures disappear.

## Gotchas and variants

- **MSB3026 is a warning, not an error.** It means MSBuild retried a copy and the retry succeeded. If you only see MSB3026, the build passed and there is nothing to fix; the noise just tells you a transient lock occurred. Treat repeated MSB3026 as a signal to add a Defender exclusion before it escalates to MSB3027 next week.
- **MSB3021 without MSB3027.** This is the older behaviour, before the retry loop was added. If you see only MSB3021, you are on a much older toolchain (.NET Core 2.x or `msbuild.exe` from VS 2015), and the resolution is the same minus the `CopyRetryCount` knob.
- **Linux and macOS variants.** The error number is the same. The Unix kernels do not enforce mandatory file locking the way Windows does, so most of the lock causes do not apply. The remaining ones are permission errors (the destination directory is owned by `root` after a Docker build) and full filesystems. `df -h` and `ls -ld bin/` rule both out in seconds.
- **Containers.** Building inside a Linux container with a Windows-mounted host volume is the worst of both worlds: the host's antivirus scans files written from inside the container. Either build inside the container with a container-local volume (`docker volume create`), or build on the host directly.
- **The file is locked by: 'System' or 'unknown'.** When the lock holder is reported as `System (4)` or unnamed, the culprit is almost always a kernel-mode antivirus driver. Defender, CrowdStrike, and SentinelOne all surface this way. User-mode `taskkill` cannot help; the fix is an exclusion or temporarily disabling real-time protection.
- **Native AOT and trim publish.** `dotnet publish -c Release` for a Native AOT project sometimes writes the output `.exe` twice (once for the publish step, once for the trim verification). On slow IO this races itself. Add `<PublishAot>true</PublishAot>` and `<PublishSingleFile>false</PublishSingleFile>` in tandem to avoid the duplicate copy.

## Related

- [Fix: The type or namespace name 'X' could not be found after adding a project reference](/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) is the other half of the SDK-style project troubleshooting toolkit. Reference and copy failures share a root cause more often than people think.
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) covers the trim and AOT scenarios where MSB3027 also surfaces from the publish path.
- [How to profile a .NET app with dotnet-trace and read the output](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) is useful when the lock holder is your own program and you want to find out what kept the process alive in the first place.
- [.NET watch in .NET 11 preview 3: Aspire crash recovery](/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/) is the recent SDK change that affects the `dotnet watch` variant of this failure.
- [Visual Studio 2026 Hot Reload: auto-restart on rude edits](/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) is the IDE counterpart for the hot reload cause.

## Sources

- Microsoft Learn, [MSB3027 diagnostic code - MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) (the official one-screen reference)
- Microsoft Learn, [Configure Microsoft Defender Antivirus exclusions by extension, name, or location](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus)
- GitHub, [dotnet/msbuild#9169 File copy is no longer retried, causing builds to randomly fail](https://github.com/dotnet/msbuild/issues/9169)
- GitHub, [dotnet/sdk#40911 dotnet watch fails with MSB3021 (locked file) when project references custom source generator](https://github.com/dotnet/sdk/issues/40911)
- Microsoft Sysinternals, [handle.exe](https://learn.microsoft.com/en-us/sysinternals/downloads/handle), the canonical tool for naming the locking process
