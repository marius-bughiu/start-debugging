---
title: "The .NET 10 tracker"
description: "Every post on .NET 10 in one place: what changed in the LTS release, upgrade errors after moving to the .NET 10 SDK, runtime performance work, and the libraries that followed."
tagline: "One bookmark for the .NET 10 LTS release."
pubDate: 2026-11-08
updatedDate: 2026-11-22
indexTags:
  - "dotnet-10"
---

This pillar collects the site's posts about **.NET 10**, the long-term support (LTS) release: new runtime and library features, upgrade errors, and the ecosystem packages that moved to it.

## What to read first

For the overview, start with [what's new in .NET 10](/2024/12/dotnet-10/) and [what's new in C# 14](/2024/12/csharp-14/). On the runtime side, [stack allocation of value-type arrays](/2025/04/net-10-stack-allocation-of-arrays-of-value-types/), [array enumeration de-abstraction](/2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction/) and [SearchValues](/2026/01/net-10-performance-searchvalues/) show where the JIT and BCL got faster. For security, [post-quantum cryptography with ML-KEM, ML-DSA and SLH-DSA](/2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa/) covers the new APIs.

.NET 8 and 9 [left support on November 10, 2026](/2026/11/dotnet-8-and-dotnet-9-reach-end-of-support-on-november-10-2026/), which makes .NET 10 the LTS landing spot. Patch first: [the November 2026 servicing release](/2026/11/november-2026-dotnet-patch-two-cves-a-runtime-update-does-not-fix/) has two CVEs that need package bumps, not just a runtime, and [NU1903 on System.Security.Cryptography.Pkcs](/2026/11/fix-nu1903-system-security-cryptography-pkcs-microsoft-data-sqlclient/) is the SqlClient one. On Aspire, [Aspire 17 requires .NET 10 for the AppHost](/2026/11/aspire-17-addproject-is-obsolete-move-to-adddotnetproject/) and obsoletes `AddProject`. Upgrading from .NET 8? [NuGet package pruning is on by default](/2026/05/nuget-package-pruning-default-net-10/), and the surprises usually come from the SDK: [API endpoints that return 401 instead of redirecting to login](/2026/09/fix-aspnetcore-api-endpoints-return-401-instead-of-redirecting-to-login-dotnet-10/), [conflicting static assets with the same target path](/2026/09/fix-conflicting-assets-with-the-same-target-path-in-aspnetcore-10/), and [Blazor routable components in another assembly](/2026/10/migrate-blazor-routable-components-from-another-assembly-dotnet-8-to-dotnet-10/). For MAUI, [what's new in .NET MAUI 10](/2025/04/whats-new-in-net-maui-10/) is the starting point.

## What's on this page

The list below auto-collects posts tagged `dotnet-10`, newest first. For the next release, see [the .NET 11 tracker](/pillars/dotnet-11-tracker/); companion pillars are [C# 14 features](/pillars/csharp-14-features/) and [the ASP.NET Core 11 cheat sheet](/pillars/aspnetcore-11-cheat-sheet/).
