---
title: "Fix: TimeZoneNotFoundException: The time zone ID was not found on the local computer (.NET on Linux and Docker)"
description: "On Linux, FindSystemTimeZoneById reads /usr/share/zoneinfo. Install tzdata (plus tzdata-legacy on Ubuntu 24.04+), keep ICU for Windows IDs like 'Eastern Standard Time', or map IDs with TimeZoneConverter. Verified on .NET 11.0.0."
pubDate: 2026-11-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "docker"
  - "containers"
  - "timezones"
---

On Linux and macOS, `TimeZoneInfo.FindSystemTimeZoneById` does not have a built-in list of time zones. It opens a file under `/usr/share/zoneinfo/<id>`, and the exception means that file is not there. Install the `tzdata` package in your image (or use an `-extra` image variant). On Ubuntu 24.04 and later, also install `tzdata-legacy` if you use old names like `US/Eastern` or `Asia/Calcutta`. If you pass Windows IDs like `"Eastern Standard Time"`, you also need ICU with invariant globalization turned off, or the `TimeZoneConverter` package. Everything below was run on .NET 11.0.0 (SDK 11.0.100).

```text
Unhandled exception. System.TimeZoneNotFoundException: The time zone ID 'America/New_York' was not found on the local computer.
 ---> System.IO.DirectoryNotFoundException: Could not find a part of the path '/usr/share/zoneinfo/America/New_York'.
Directory path: '/usr/share/zoneinfo/America/New_York'
   at Interop.ThrowExceptionForIoErrno(ErrorInfo errorInfo, String path, Boolean isDirError)
   ...
   at System.TimeZoneInfo.ReadAllBytesFromSeekableNonZeroSizeFile(String path, Int32 maxFileSize)
   at System.TimeZoneInfo.TryGetTimeZoneFromLocalMachineCore(String id, TimeZoneInfo& value, Exception& e)
   --- End of inner exception stack trace ---
   at System.TimeZoneInfo.FindSystemTimeZoneById(String id)
```

The inner exception is the most useful part of this error, and most logs drop it. It tells you which of four different causes you have, so log `ex.ToString()`, not just `ex.Message`.

## Why this happens: the runtime reads tzdata files, it does not ship them

On Windows, .NET reads time zones from the registry, which every Windows install has. On Unix, `TimeZoneInfo` builds each zone from a compiled TZif file. In the .NET 11 source (`TimeZoneInfo.Unix.NonAndroid.cs`), the lookup is `Path.Combine(GetTimeZoneDirectory(), id)`. The directory is `/usr/share/zoneinfo/` unless the `TZDIR` environment variable says otherwise. If that read throws `FileNotFoundException` or `DirectoryNotFoundException`, `FindSystemTimeZoneById` wraps it in `TimeZoneNotFoundException`.

So the exception has four causes, from most to least common:

1. **No tzdata at all.** The image has no `/usr/share/zoneinfo`, so every ID fails except `"UTC"`, which the runtime special-cases.
2. **A Windows ID with no ICU.** On Unix, `"Eastern Standard Time"` is not a file. .NET 6+ converts it to an IANA ID through ICU. With invariant globalization on, that conversion is turned off.
3. **A legacy IANA alias that your distro moved into a separate package.** `US/Eastern`, `Asia/Calcutta`, `Europe/Kiev` and other backward-compatible names moved into `tzdata-legacy` on Ubuntu 24.04 and Debian 13.
4. **Time-zone invariant mode.** `InvariantTimezone=true` or `DOTNET_SYSTEM_TIMEZONE_INVARIANT=true` makes every lookup except UTC fail on purpose.

The [dotnet-docker globalization guide](https://github.com/dotnet/dotnet-docker/blob/main/samples/enable-globalization.md) lists which official images ship tzdata. As of the .NET 11 images (Ubuntu 26.04 "resolute", Alpine 3.24, Azure Linux 3.0 and 4.0):

| Image | tzdata | tzdata-legacy | ICU (Windows ID mapping) |
|---|---|---|---|
| `runtime-deps:11.0` / `aspnet:11.0` (Ubuntu 26.04) | yes | yes | yes (`libicu78`) |
| `*-resolute-chiseled` | no | no | no, invariant mode set |
| `*-resolute-chiseled-extra` | yes | yes | yes |
| `*-alpine3.24` | no | no | no, invariant mode set |
| `*-alpine3.24-extra` | yes | not split on Alpine | yes |
| Azure Linux distroless | no | no | no, invariant mode set |

Those rows come from the [.NET 11 runtime-deps Dockerfiles](https://github.com/dotnet/dotnet-docker/tree/main/src/runtime-deps/11.0). A common way to hit this error is moving from the default Ubuntu tag to `-chiseled` or `-alpine` to save space. That move takes out the zone files and ICU together.

## Minimal repro without Docker

You don't need a container to reproduce any of the four causes. On Unix, `TZDIR` points the runtime at a different zoneinfo directory, and the two invariant switches are plain environment variables. The program below tries a set of IDs and prints the inner exception for each one:

```csharp
// .NET 11.0.0, C# 15. Program.cs in a plain `dotnet new console` targeting net11.0
string[] ids = ["America/New_York", "Eastern Standard Time", "US/Eastern",
                "Asia/Calcutta", "UTC", "Mars/Olympus_Mons", "../../etc/passwd"];

foreach (var id in ids)
{
    try
    {
        var tz = TimeZoneInfo.FindSystemTimeZoneById(id);
        Console.WriteLine($"  OK   {id,-24} -> Id={tz.Id}, HasIanaId={tz.HasIanaId}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"  FAIL {id,-24} -> {ex.GetType().Name}: {ex.Message}");
        if (ex.InnerException is { } inner)
            Console.WriteLine($"       inner: {inner.GetType().Name}: {inner.Message}");
    }
}

Console.WriteLine($"  TryConvertWindowsIdToIanaId = " +
    $"{TimeZoneInfo.TryConvertWindowsIdToIanaId("Eastern Standard Time", out var iana)} {iana}");
```

With a normal zoneinfo directory, every real ID resolves. Two details are worth knowing. `"Eastern Standard Time"` comes back with `Id = "Eastern Standard Time"` and `HasIanaId = False`, because the runtime keeps the ID you asked for even though it loaded `America/New_York` underneath. A path like `../../etc/passwd` is rejected before any file is read (`The time zone ID '../../etc/passwd' is invalid.`), because .NET only allows `[A-Za-z0-9/_-]` in an ID.

Now run it four more times, once for each cause. These are the real outputs, trimmed:

```bash
# cause 1: no tzdata (empty directory)
TZDIR=/tmp/empty dotnet run
#  FAIL America/New_York      -> inner: DirectoryNotFoundException: Could not find a part of the path '/tmp/empty/America/New_York'.
#  FAIL Eastern Standard Time -> inner: DirectoryNotFoundException: ... '/tmp/empty/America/New_York'.
#  OK   UTC

# cause 2: globalization invariant (what Alpine and chiseled images set)
DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 dotnet run
#  OK   America/New_York
#  FAIL Eastern Standard Time -> inner: TimeZoneNotFoundException: The time zone ID 'Eastern Standard Time' is invalid.
#  TryConvertWindowsIdToIanaId = False

# cause 3: zoneinfo copy with the legacy links removed (what Ubuntu 24.04+ tzdata looks like)
TZDIR=/tmp/nolegacy dotnet run
#  OK   America/New_York
#  OK   Eastern Standard Time
#  FAIL US/Eastern            -> inner: DirectoryNotFoundException: ... '/tmp/nolegacy/US/Eastern'.
#  FAIL Asia/Calcutta         -> inner: FileNotFoundException: Could not find file '/tmp/nolegacy/Asia/Calcutta'.

# cause 4: time-zone invariant mode
DOTNET_SYSTEM_TIMEZONE_INVARIANT=1 dotnet run
#  FAIL America/New_York      (no inner exception at all)
#  OK   UTC
```

Look at how the Windows ID fails in each case. With no tzdata, the inner exception names `America/New_York`, not the ID you passed. The ICU conversion worked, and then the file read failed. With invariant globalization, the inner message says the ID "is invalid." That's misleading. The conversion was skipped, so the runtime treated `Eastern Standard Time` as a file name, and the spaces failed the character check. If you see "is invalid" for a Windows ID on Linux, the cause is invariant globalization, not a typo.

## Fix 1: put tzdata in the image

This is the fix for cause 1, and usually the only one you need. Pick whichever matches your base image.

```dockerfile
# .NET 11, Alpine 3.24: add zone files (and ICU if you use Windows IDs, see Fix 2)
FROM mcr.microsoft.com/dotnet/aspnet:11.0-alpine3.24
RUN apk add --no-cache tzdata
```

```dockerfile
# .NET 11: or switch to the variant that already has tzdata and ICU
FROM mcr.microsoft.com/dotnet/aspnet:11.0-resolute-chiseled-extra
```

You can't `apt-get install` into a chiseled image because it has no package manager. You either use `-extra`, or you cut the `tzdata_zoneinfo` and `tzdata-legacy_zoneinfo` slices with Chisel in a build stage. That is exactly what the official `-extra` Dockerfile does. The [Ubuntu chiseled docs](https://github.com/dotnet/dotnet-docker/blob/main/documentation/ubuntu-chiseled.md) have the full multi-stage pattern. Unless you need to save every megabyte, just use `-extra`.

For a self-contained or Native AOT app on a bare `runtime-deps` image, the rule is the same. Native AOT does not embed zone data on Linux. It reads the same files.

Set the container's own zone with `TZ` at run time, not in the Dockerfile. With tzdata present, `TimeZoneInfo.Local` reads `TZ` first, then `/etc/localtime`, then falls back to UTC:

```bash
docker run --rm -e TZ=Europe/Bucharest myapp
```

## Fix 2: Windows IDs on Linux need ICU, so keep invariant globalization off

Since .NET 6, `FindSystemTimeZoneById` accepts both IANA and Windows IDs on every platform. When the first lookup fails, `TryGetTimeZone` calls `GetAlternativeId`, which uses ICU's Windows-to-IANA mapping, and then tries again. That mapping lives in `TimeZoneInfo.FullGlobalizationData.cs`. It returns `false` right away when `GlobalizationMode.Invariant` or `GlobalizationMode.UseNls` is set.

So a Windows ID needs two things on Linux: zone files and ICU. On Alpine that means:

```dockerfile
# .NET 11, Alpine 3.24: Windows time zone IDs need ICU too
FROM mcr.microsoft.com/dotnet/aspnet:11.0-alpine3.24
RUN apk add --no-cache tzdata icu-libs icu-data-full
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false
```

The `ENV` line matters because the Alpine and chiseled base images set `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=true` themselves. If you also set `<InvariantGlobalization>true</InvariantGlobalization>` in your csproj, that setting goes into `runtimeconfig.json` as `System.Globalization.Invariant: true`, and you have to remove it. The [ICU missing post](/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) explains how those switches interact.

If you can choose your IDs, the simpler fix is to store IANA IDs (`America/New_York`) and never depend on the conversion. IANA IDs work on Windows too in .NET 6+, as long as ICU is in use, which is the default on Windows 10 1903 and later.

## Fix 3: legacy aliases and the CLDR mapping trap

Ubuntu 24.04 and Debian 13 split the backward-compatible links out of `tzdata` into `tzdata-legacy`. The [noble `tzdata-legacy` file list](https://packages.ubuntu.com/noble/all/tzdata-legacy/filelist) contains `US/Eastern`, `US/Pacific`, `Asia/Calcutta`, `Europe/Kiev` and `America/Buenos_Aires`. The main `tzdata` package only has the canonical names (`America/New_York`, `Asia/Kolkata`, `Europe/Kyiv`). `tzdata-legacy` is not a dependency of `tzdata`, so `apt-get install tzdata` on a custom Ubuntu 24.04 image does not bring it in.

There's a trap here even if your code never uses a legacy name. ICU's Windows-to-IANA mapping comes from CLDR's [`windowsZones.xml`](https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml), and CLDR keeps the old IDs as its stable identifiers. So `"India Standard Time"` maps to `Asia/Calcutta`, not `Asia/Kolkata`. For this post, every Windows ID reachable from the system zone list (141 on .NET 11.0.0, macOS ICU) was converted with `TryConvertWindowsIdToIanaId`, and each result was checked against the Ubuntu 24.04 `tzdata` file list. Seven of them point to a file that exists only in `tzdata-legacy`:

```text
Argentina Standard Time  -> America/Buenos_Aires
FLE Standard Time        -> Europe/Kiev
Greenland Standard Time  -> America/Godthab
India Standard Time      -> Asia/Calcutta
Myanmar Standard Time    -> Asia/Rangoon
Nepal Standard Time      -> Asia/Katmandu
US Eastern Standard Time -> America/Indianapolis
```

In the `TZDIR=/tmp/nolegacy` run, `FindSystemTimeZoneById("India Standard Time")` throws even though ICU is present and `Asia/Kolkata` is on disk. If you pass Windows IDs to a custom image, install `tzdata-legacy` (`apt-get install -y tzdata tzdata-legacy`, or add the `tzdata-legacy_zoneinfo` slice). The official .NET 11 Ubuntu images already include both.

For legacy IANA input such as `US/Eastern`, you can also hop through the Windows ID to reach the canonical name. This fixes `US/Eastern` but not `Asia/Calcutta`, because the hop goes through CLDR and lands back on `Asia/Calcutta`:

```csharp
// .NET 11.0.0, C# 15
using System.Diagnostics.CodeAnalysis;

static class TimeZones
{
    public static bool TryFind(string id, [NotNullWhen(true)] out TimeZoneInfo? tz)
    {
        // Exact ID. On .NET 6+ this already tries the Windows <-> IANA alternative via ICU.
        if (TimeZoneInfo.TryFindSystemTimeZoneById(id, out tz))
            return true;

        // Legacy IANA alias missing from tzdata: US/Eastern -> Eastern Standard Time -> America/New_York.
        if (TimeZoneInfo.TryConvertIanaIdToWindowsId(id, out var windowsId) &&
            TimeZoneInfo.TryConvertWindowsIdToIanaId(windowsId, out var canonical) &&
            TimeZoneInfo.TryFindSystemTimeZoneById(canonical, out tz))
            return true;

        tz = null;
        return false;
    }
}
```

`TryFindSystemTimeZoneById` was added in .NET 8. Use it instead of try/catch around `FindSystemTimeZoneById` when the ID comes from user input or configuration.

## Fix 4: TimeZoneConverter when you must stay invariant

If you want to keep invariant globalization (small image, no ICU) but still accept Windows IDs, use [TimeZoneConverter](https://www.nuget.org/packages/TimeZoneConverter) (8.0.1 at the time of writing). It ships its own Windows/IANA/Rails mapping tables, so it doesn't need ICU. It also maps to canonical IANA names:

```csharp
// .NET 11.0.0, TimeZoneConverter 8.0.1
using TimeZoneConverter;

TimeZoneInfo tz = TZConvert.GetTimeZoneInfo("India Standard Time"); // Id = Asia/Kolkata
```

The same five IDs, run through both approaches against the no-legacy zoneinfo copy (a copy of macOS `/usr/share/zoneinfo` with `US/` and `Asia/Calcutta` deleted):

| Input | `TZDIR=nolegacy` helper | `TZDIR=nolegacy` TZConvert | `+ GLOBALIZATION_INVARIANT` helper | `+ GLOBALIZATION_INVARIANT` TZConvert |
|---|---|---|---|---|
| `America/New_York` | OK | OK | OK | OK |
| `Eastern Standard Time` | OK | OK `America/New_York` | FAIL | OK `America/New_York` |
| `US/Eastern` | OK `America/New_York` | OK | FAIL | OK |
| `Asia/Calcutta` | FAIL | OK `Asia/Kolkata` | FAIL | OK `Asia/Kolkata` |
| `India Standard Time` | FAIL | OK `Asia/Kolkata` | FAIL | OK `Asia/Kolkata` |

With an empty `TZDIR`, TimeZoneConverter failed with `TimeZoneNotFoundException` for every ID, just like the runtime. The package maps IDs. It does not include the zone rules. You still need Fix 1.

## Gotchas and lookalikes

**`TimeZoneInfo.Local` is UTC in the container and nothing throws.** Same root cause, but quieter. With no tzdata, or with no `TZ` and no `/etc/localtime`, `Local` falls back to UTC, and `DateTime.Now` equals `DateTime.UtcNow`. Fix it with Fix 1 plus `-e TZ=...`. Better still, inject a `TimeProvider` so the zone is explicit and testable, as shown in [testing time-dependent code with TimeProvider](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).

**`InvariantTimezone` is a real switch, and it turns off every zone.** The .NET SDK maps `<InvariantTimezone>true</InvariantTimezone>` to `System.TimeZoneInfo.Invariant` in `runtimeconfig.json`. In that mode `Local` is UTC, `GetSystemTimeZones()` returns one entry, and every lookup except UTC fails with no inner exception. It's meant for apps that only use UTC, such as trimmed Blazor WebAssembly builds. If you copied it from a size-optimization guide, remove it.

**It works in `dotnet run` but fails in the container.** Your dev machine has full tzdata and ICU. The runtime image may not. The [container image comparison](/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/) covers what each base actually contains. The Ubuntu 26.04 tag changes are in [.NET on Ubuntu 26.04 resolute tags](/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/).

**`InvalidTimeZoneException` instead of `TimeZoneNotFoundException`.** The file exists but is empty, too large, or not a TZif file (message: "was found on the local computer, but the file at ... was corrupt"). This usually comes from a bind-mounted `/usr/share/zoneinfo` or a half-copied directory.

**Windows uses NLS.** The conversion code returns `false` when `GlobalizationMode.UseNls` is set, so `System.Globalization.UseNls=true` on Windows turns off the IANA-to-Windows conversion. Then `FindSystemTimeZoneById("America/New_York")` fails on Windows, which is the mirror image of this bug. (This is read from the source. The runs for this post were all on Unix.)

**Validate configured IDs at startup.** If the zone ID comes from `appsettings.json`, resolve it once at startup with `TryFindSystemTimeZoneById`, and fail fast with the ID in the message. Otherwise the first request that formats a local time is the one that fails.

## Related

- [Fix: Couldn't find a valid ICU package installed on the system](/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/), the ICU half of the same container problem
- [Framework-dependent vs self-contained vs Native AOT for a .NET 11 container image](/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/)
- [.NET on Ubuntu 26.04: resolute container tags](/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/)
- [How to test time-dependent code with TimeProvider and FakeTimeProvider](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)
- [Fix: The JSON value could not be converted to System.DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/)

## Sources

- [`TimeZoneInfo.Unix.NonAndroid.cs`](https://github.com/dotnet/runtime/blob/release/11.0/src/libraries/System.Private.CoreLib/src/System/TimeZoneInfo.Unix.NonAndroid.cs), [`TimeZoneInfo.cs`](https://github.com/dotnet/runtime/blob/release/11.0/src/libraries/System.Private.CoreLib/src/System/TimeZoneInfo.cs) and [`TimeZoneInfo.FullGlobalizationData.cs`](https://github.com/dotnet/runtime/blob/release/11.0/src/libraries/System.Private.CoreLib/src/System/TimeZoneInfo.FullGlobalizationData.cs) in dotnet/runtime `release/11.0`
- [`TimeZoneInfo.FindSystemTimeZoneById`](https://learn.microsoft.com/dotnet/api/system.timezoneinfo.findsystemtimezonebyid) and [`TryFindSystemTimeZoneById`](https://learn.microsoft.com/dotnet/api/system.timezoneinfo.tryfindsystemtimezonebyid) on Microsoft Learn
- [Enable globalization in .NET containers: Tzdata](https://github.com/dotnet/dotnet-docker/blob/main/samples/enable-globalization.md) and the [.NET 11 runtime-deps Dockerfiles](https://github.com/dotnet/dotnet-docker/tree/main/src/runtime-deps/11.0)
- [Date, Time, and Time Zone Enhancements in .NET 6](https://devblogs.microsoft.com/dotnet/date-time-and-time-zone-enhancements-in-net-6/)
- [Ubuntu 24.04 `tzdata-legacy` file list](https://packages.ubuntu.com/noble/all/tzdata-legacy/filelist) and CLDR [`windowsZones.xml`](https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml)
- [TimeZoneConverter on NuGet](https://www.nuget.org/packages/TimeZoneConverter)
