---
title: "NuGet “become owner” request spam: what to do (and what to lock down) in .NET 9/.NET 10"
description: "Defend your .NET packages against NuGet ownership request spam. Lock files, Package Source Mapping, and Central Package Management practices for .NET 9 and .NET 10."
pubDate: 2026-01-23
tags:
  - "net"
---
A thread from the last 48 hours warns about suspicious “become owner” requests on NuGet.org, allegedly sent at scale to package maintainers: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/).

Even if the details change by tomorrow, the defensive checklist is stable. The goal is simple: reduce the chance that an unexpected ownership change turns into a compromised dependency in your .NET 9/.NET 10 apps.

## Treat ownership requests like a security event, not a notification

If you maintain packages:

-   **Do not accept** unexpected owner invitations, even if the sender looks “legit”.
-   **Verify out of band**: if you recognize the person or org, contact them via a known channel (not the invitation message).
-   **Report** suspicious activity to NuGet.org support with timestamps and package IDs.

If you consume packages, assume that mistakes happen and make your build resilient to upstream surprises.

## Lock the dependency graph so “surprise updates” do not auto-land

If you are not using lock files, you should. Lock files make restores deterministic, which is what you want when a dependency ecosystem is noisy.

Enable lock files in your repo (works with `dotnet restore`):

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
    <!-- Optional: make CI fail if the lock file would change -->
    <RestoreLockedMode Condition="'$(CI)' == 'true'">true</RestoreLockedMode>
  </PropertyGroup>
</Project>
```

Then generate the initial `packages.lock.json` once per project (locally), commit it, and let CI enforce it.

## Reduce source sprawl with Package Source Mapping

A common footgun is having “whatever NuGet source happens to be configured” in play. Package Source Mapping forces each package ID pattern to come from a specific feed.

Minimal `nuget.config` example:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="ContosoInternal" value="https://pkgs.dev.azure.com/contoso/_packaging/contoso/nuget/v3/index.json" />
  </packageSources>

  <packageSourceMapping>
    <packageSource key="nuget.org">
      <package pattern="Microsoft.*" />
      <package pattern="System.*" />
      <package pattern="Newtonsoft.Json" />
    </packageSource>
    <packageSource key="ContosoInternal">
      <package pattern="Contoso.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
```

Now an attacker cannot “win” by getting a same-named package into a different feed you forgot existed.

## Make upgrades intentional

For .NET 9 and .NET 10 codebases, the best “day to day” posture is boring:

-   Pin versions (or use Central Package Management) and upgrade via PRs.
-   Review dependency diffs like code diffs.
-   Avoid floating versions in production apps unless you have a strong reason and strong monitoring.

The original discussion thread is here: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/). If you maintain packages, it is worth checking your NuGet account notifications and auditing any recent ownership changes today.
