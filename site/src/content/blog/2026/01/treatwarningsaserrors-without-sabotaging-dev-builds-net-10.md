---
title: "TreatWarningsAsErrors without sabotaging dev builds (.NET 10)"
description: "If you have ever flipped TreatWarningsAsErrors to true and immediately regretted it, you are not alone. A recent r/dotnet thread making the rounds suggests a simple adjustment: enforce warning-free code in Release (and CI), but keep Debug flexible for local exploration: https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/ Release-only enforcement is a policy, not a toggle What you are really trying…"
pubDate: 2026-01-23
tags:
  - "net"
  - "net-10"
---
If you have ever flipped `TreatWarningsAsErrors` to `true` and immediately regretted it, you are not alone. A recent r/dotnet thread making the rounds suggests a simple adjustment: enforce warning-free code in Release (and CI), but keep Debug flexible for local exploration: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)

## Release-only enforcement is a policy, not a toggle

What you are really trying to achieve is a workflow:

-   Developers can spike locally without fighting analyzer noise.
-   Pull requests fail if new warnings sneak in.
-   You still have a path to ratchet up strictness over time.

In .NET 10 repos, the cleanest place to centralize this is `Directory.Build.props`. That makes the rule apply to every project, including test projects, without copy/paste.

Here is a minimal pattern:

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

This matches what most CI pipelines build anyway (Release). If your CI builds Debug, switch it to Release first. That makes your “warning-free” bar match the binaries you ship.

## Being strict does not mean being blind

Two knobs matter once you enable the big switch:

-   `WarningsAsErrors`: escalate only specific warning IDs.
-   `NoWarn`: suppress specific warning IDs (ideally with a comment and a tracking link).

Example for tightening one warning while leaving the rest as warnings:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <WarningsAsErrors>$(WarningsAsErrors);CS8602</WarningsAsErrors>
  </PropertyGroup>
</Project>
```

And if you need to temporarily suppress a noisy analyzer in one project:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <NoWarn>$(NoWarn);CA2007</NoWarn>
  </PropertyGroup>
</Project>
```

If you are using Roslyn analyzers (common in modern .NET 10 solutions), also consider `.editorconfig` for severity control, because it is discoverable and keeps the policy close to the code:

```xml
# .editorconfig
[*.cs]
dotnet_diagnostic.CA2007.severity = warning
```

## The practical payoff for PRs

The real win is predictable PR feedback. Developers learn quickly that warnings are not “future work”, they are part of the definition of done for Release. Debug stays fast and forgiving, Release stays strict and shippable.

If you want the original trigger for this pattern (and the tiny snippet that started the discussion), see the thread here: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)
