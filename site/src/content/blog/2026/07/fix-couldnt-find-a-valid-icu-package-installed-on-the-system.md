---
title: "Fix: Couldn't find a valid ICU package installed on the system in a .NET container"
description: "Your base image has no ICU. Either install icu-libs and icu-data-full, switch to an -extra image variant, or set InvariantGlobalization=true and accept ordinal-only string behavior."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "globalization"
  - "alpine"
---

Your container's base image does not ship ICU, and .NET refuses to start without it. Pick one of two answers. If your app formats dates, compares strings linguistically, or touches any culture other than invariant, install ICU: `RUN apk add --no-cache icu-libs icu-data-full` on Alpine, or switch to an `-extra` image variant that already has it. If your app genuinely never needs culture data, set `<InvariantGlobalization>true</InvariantGlobalization>` in the project file and keep the small image. Do not set the environment variable and hope, because it is the weakest of the three switches.

```text
Process terminated. Couldn't find a valid ICU package installed on the system.
Please install libicu (or icu-libs) using your package manager and try again.
Alternatively you can set the configuration flag System.Globalization.Invariant
to true if you want to run with no globalization support. Please see
https://aka.ms/dotnet-missing-libicu for more information.
```

Everything below is verified against .NET 10 (`10.0`, released 11 November 2025) and the .NET 11 previews. The mechanism has been identical since .NET 5, so the same fixes apply to `net8.0` and `net9.0` images unchanged. Only the package names and image tags move.

## Why the runtime kills the process instead of degrading

.NET's globalization stack on Unix is a thin shim over ICU (International Components for Unicode). Culture data, linguistic string comparison, casing rules beyond ASCII, calendar formatting, IDN handling: all of it comes from `libicuuc` and `libicui18n`, which are not part of .NET. They are a native dependency your base image is expected to provide.

At startup, `GlobalizationMode`'s static constructor walks a fixed decision list:

1. Is globalization-invariant mode on? If yes, skip ICU entirely and use the built-in invariant data.
2. Is app-local ICU configured? If yes, load `libicuuc.so.<version>` and `libicui18n.so.<version>` from the app directory.
3. Is `DOTNET_ICU_VERSION_OVERRIDE` set? If yes, try that exact version.
4. Otherwise load the highest system-installed ICU.

If step 4 finds nothing, the runtime calls `Environment.FailFast`. That is the detail that trips people up: this is not an exception. There is no `try`/`catch` that saves you, no `AppDomain.UnhandledException` hook, no graceful fallback to invariant mode. The process aborts before `Main` gets meaningfully underway, which on Linux surfaces as SIGABRT and a container exit code of 134. The design is deliberate: silently degrading to ordinal string comparison would change sorting, casing, and date parsing behavior in ways that produce wrong data rather than a loud failure.

The images most likely to hit this are the ones you chose specifically because they are small. Alpine, Azure Linux distroless, and Ubuntu chiseled all omit ICU and tzdata, and the .NET container docs are explicit that those images only work with apps configured for globalization-invariant mode. Debian and Ubuntu full images already include ICU, which is why the app worked on your machine and in the `sdk` image, then died the moment it landed in the runtime stage.

## The minimal repro

Two stages, a standard SDK build, an Alpine runtime. This Dockerfile is enough:

```dockerfile
# .NET 10. Fails at startup with the ICU error.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

The app itself does not have to do anything exotic. The failure happens during runtime initialization, before your code runs, so even this crashes:

```csharp
// .NET 10, C# 14. Never reaches the WriteLine.
Console.WriteLine("hello");
```

That is worth internalizing, because the first instinct is to hunt for the `CultureInfo` call that caused it. There isn't one. Globalization initialization is eager.

## Fix 1: install ICU in the image

This is the right fix for the majority of apps, and the one the .NET container samples document. On Alpine:

```dockerfile
# .NET 10 on Alpine 3.22. Adds ICU and disables invariant mode.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
RUN apk add --no-cache icu-libs icu-data-full
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false \
    LC_ALL=en_US.UTF-8 \
    LANG=en_US.UTF-8
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`icu-data-full` is not optional padding. Since Alpine 3.16 the ICU data package was split and `icu-libs` alone ships only the `en` locale, which produces a much more confusing failure than the one you started with: the runtime starts fine, and then every non-English culture silently formats like English. Tests that assert on `fr-FR` date formats start failing with no error message at all. Install both packages.

The `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` line matters only if something upstream set it to `true`, which several base images and CI templates do. Setting it explicitly costs nothing and removes a class of inherited-environment bugs.

The equivalent on Debian or Ubuntu based images, which you would only need for a `runtime-deps` image you assembled yourself:

```dockerfile
# .NET 10 on Ubuntu 24.04 (noble).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libicu74 tzdata \
    && rm -rf /var/lib/apt/lists/*
```

Pin the `libicu` package name to the one your distro release actually carries (`libicu74` on Ubuntu 24.04, `libicu72` on Debian bookworm). If you would rather not track that, `apt-get install -y libicu-dev` pulls the right runtime library transitively at the cost of a larger layer.

## Fix 2: switch to an `-extra` image variant

Microsoft publishes size-optimized images in three flavors, and the `-extra` feature suffix is precisely "the small image, plus ICU, tzdata, and `libstdc++`". If you are on chiseled or Azure Linux, this is one line instead of a package install:

```dockerfile
# .NET 10, Ubuntu chiseled with globalization support.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled-extra
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

There is an availability asymmetry worth knowing before you plan around it. For Ubuntu chiseled and Azure Linux, `-extra` exists on the `runtime-deps`, `runtime`, and `aspnet` repositories. For Alpine, `-extra` is published on `runtime-deps` only, which means you can only use it with a self-contained or Native AOT publish. A framework-dependent Alpine app has to install the packages by hand as in Fix 1.

If you build images with the SDK's built-in container support rather than a Dockerfile, select the variant through `ContainerFamily` instead of a `FROM` line:

```xml
<!-- .NET 10 SDK. Applies to dotnet publish /t:PublishContainer. -->
<PropertyGroup>
  <ContainerFamily>noble-chiseled-extra</ContainerFamily>
</PropertyGroup>
```

That plugs into the same flow described in [publishing a .NET app as a container image with PublishContainer](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/), and it keeps the base-image choice in the project file where the rest of your publish configuration lives.

## Fix 3: turn on invariant globalization, deliberately

If the app really is culture-free (an internal API exchanging ISO-8601 timestamps and invariant-formatted numbers is the classic case), invariant mode is not a workaround, it is the correct configuration. It removes the dependency entirely and buys you a smaller image and a faster startup.

```xml
<!-- .NET 10, C# 14. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Set it in the project file, not in the Dockerfile. Per the runtime's globalization-invariant-mode design document, the project file and `runtimeconfig.json` settings take precedence over `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT`, so the MSBuild property is the one that always wins and the environment variable is the one that quietly loses. The project file also travels with the app: nobody can drop your container into a different orchestrator, forget the environment block, and resurrect the crash.

Know what you are agreeing to. In invariant mode:

- `ToUpper` and `ToLower` only transform the ASCII range. Turkish dotted/dotless I casing is gone.
- `String.Compare`, `IndexOf`, and `LastIndexOf` perform ordinal comparison regardless of the `CompareOptions` or `StringComparison` you pass. Linguistic sorting silently becomes byte-order sorting.
- `String.Normalize` returns the string unchanged.
- Time zone display names on Linux fall back to the standard name rather than ICU's localized name.
- `TimeZoneInfo.TryConvertIanaIdToWindowsId` and its inverse fail, because they are ICU-backed.
- Culture enumeration returns exactly one culture, and every LCID collapses to `0x1000`.

The change that bites hardest in practice is culture creation. Since .NET 6, `PredefinedCulturesOnly` defaults to `true` under invariant mode, so `new CultureInfo("fr-FR")` throws:

```text
System.Globalization.CultureNotFoundException: Only the invariant culture is supported
in globalization-invariant mode.
```

If you need construction to succeed (a request-localization middleware that parses `Accept-Language` will do this even when you never use the result), you can relax it:

```xml
<!-- .NET 10. Cultures can be created, but all behave as invariant. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
  <PredefinedCulturesOnly>false</PredefinedCulturesOnly>
</PropertyGroup>
```

That stops the exception. It does not restore culture-specific behavior: every culture you create behaves exactly like the invariant culture. `1234.56m.ToString("C", new CultureInfo("de-DE"))` still returns the invariant currency form with the generic currency sign, not a German-formatted euro amount. Treating this pair as "the fix" for a genuinely localized app is how you ship an app whose output is wrong everywhere except en-US.

## Fix 4: carry your own ICU with app-local ICU

The niche but legitimate option: pin an exact ICU version and ship it with the app, so behavior is byte-identical across every host you deploy to. ICU version bumps change CLDR data, and CLDR data changes sort order and formatting, so an app with golden-file tests over formatted output can be destabilized by a base-image upgrade it never asked for.

```xml
<!-- .NET 10. Ships ICU 72.1 with the app instead of using the system copy. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Globalization.AppLocalIcu" Value="72.1" />
  <PackageReference Include="Microsoft.ICU.ICU4C.Runtime" Version="72.1.0.3" />
</ItemGroup>
```

With the switch set, .NET loads `libicuuc.so.72.1` and `libicui18n.so.72.1` from the app's native probing paths and never looks at the system copy. The corresponding environment variable is `DOTNET_SYSTEM_GLOBALIZATION_APPLOCALICU`, and the value format is `<version>` or `<suffix>:<version>` where the suffix matches a custom ICU build. If the libraries are missing you get a different, more specific failure: `Failed to load app-local ICU: <library name>`. Match the `PackageReference` version to the switch value or you will see exactly that.

## Gotchas that send people to the wrong fix

**`ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` in the Dockerfile did nothing.** Check the project file. If `<InvariantGlobalization>true</InvariantGlobalization>` is set there or in `runtimeconfig.json`, it takes precedence and your environment variable is inert. Grep the whole solution, including `Directory.Build.props`, where a well-meaning size optimization often lives.

**`Failed to load system ICU: libicuuc.so.<n>` instead of the message above.** That is a different branch. It means ICU was found by version probing but the specific soname could not be loaded, usually a partial install or an architecture mismatch (an `amd64` layer running under `arm64` emulation). Verify with `ldconfig -p | grep icu` inside the container.

**The error only appears in Native AOT or trimmed publishes.** Then it is likely not the image at all. `PublishAot` and `PublishTrimmed` interact with feature switches, and `InvariantGlobalization` is one of the switches commonly turned on for size in AOT templates. The same class of "the SDK changed a switch behind your back" problem is covered in [why reflection-based serialization gets disabled](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) and in the broader treatment of [trim-safe code](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/).

**Dates format correctly but time zones do not resolve.** ICU and tzdata are separate packages. `TimeZoneInfo.FindSystemTimeZoneById` reads `/usr/share/zoneinfo`, which the size-optimized images also omit. Install `tzdata` alongside `icu-libs`, or use the `-extra` variant, which includes both.

**Everything works except culture-specific tests.** You installed `icu-libs` without `icu-data-full` on Alpine. Only `en` data is present.

**The SDK image works, the runtime image does not.** Expected. The `sdk` images are Debian based by default and carry ICU; your `aspnet` or `runtime` final stage is the one that needs the dependency. Diagnose inside the actual runtime layer, not the build layer.

To confirm which mode you ended up in, without guessing:

```csharp
// .NET 10, C# 14. Prints 1 in invariant mode, several hundred with ICU loaded.
using System.Globalization;

Console.WriteLine(CultureInfo.GetCultures(CultureTypes.AllCultures).Length);
Console.WriteLine(AppContext.TryGetSwitch("System.Globalization.Invariant", out bool inv) && inv);
```

## Related

- [How to publish a .NET 11 app as a container image with dotnet publish /t:PublishContainer](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [What is trim-safe code and how do I write it?](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Sources

- [.NET globalization invariant mode](https://github.com/dotnet/runtime/blob/main/docs/design/features/globalization-invariant-mode.md), for the behavior list and the setting precedence - dotnet/runtime
- [`GlobalizationMode.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Globalization/GlobalizationMode.Unix.cs), for the load order and the `FailFast` on missing ICU - dotnet/runtime
- [Globalization config settings](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/globalization) - MS Learn
- [.NET globalization and ICU](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu), for app-local ICU and the Linux probing sequence - MS Learn
- [Enable globalization in .NET container images](https://github.com/dotnet/dotnet-docker/blob/main/samples/enable-globalization.md) - dotnet/dotnet-docker
- [.NET image variants](https://github.com/dotnet/dotnet-docker/blob/main/documentation/image-variants.md), for which repositories publish `-extra` - dotnet/dotnet-docker
- [.NET container images](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images) - MS Learn
- [Install .NET on Alpine](https://learn.microsoft.com/en-us/dotnet/core/install/linux-alpine), for the dependency list including `icu-data-full` - MS Learn
- [Alpine 3.16 icu-libs now contains only en](https://github.com/dotnet/dotnet-docker/issues/3844) - dotnet/dotnet-docker
- [Culture creation and case mapping in globalization-invariant mode](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode) - MS Learn
