---
title: "The .NET 11 tracker"
description: "Track the .NET 11 release candidate, support policy, runtime changes and upgrade checks, with links to integration testing, EF Core and request logging guides."
tagline: "One bookmark for the whole .NET 11 cycle."
pubDate: 2026-04-18
updatedDate: 2026-11-15
indexTags:
  - ".net 11"
  - "dotnet 11"
  - ".net 11 preview"
  - "dotnet-11"
---

**.NET 11 is generally available.** Runtime 11.0.0 and SDK 11.0.100 shipped on November 10, 2026; start with [what to change in your project at GA](/2026/11/dotnet-11-is-generally-available-what-to-change-in-your-project/). It is a Standard Term Support (STS) release, while .NET 8 and 9 [left support the same day](/2026/11/dotnet-8-and-dotnet-9-reach-end-of-support-on-november-10-2026/), so teams on .NET 8 LTS should weigh it against .NET 10 LTS.

**Correction, November 2, 2026.** An earlier version listed RC2 as newest and described the .NET 8 to 11 move as LTS-to-LTS. The index now selects .NET 11 tags so articles about other versions no longer appear solely because they carry a general .NET tag.

## Release and runtime changes

From the release candidates, RC2 added [incremental CBOR parsing](/2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally/), and RC1 introduced work on [reproducible container images](/2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch/), [process signals](/2026/09/dotnet-11-rc-1-process-signal-exit-status/) and [SignalR authentication refresh](/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/). Runtime topics include [generic virtual method devirtualization](/2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods/), [struct calling conventions](/2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet/) and [CPU compatibility](/2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2/).

## Plan and validate an upgrade

Start with the [.NET 8 migration checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) or the [.NET Framework 4.8 migration guide](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/). For a multi-project solution, review [SDK selection](/2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins/) and [central package management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/). If changing test runners, check [Microsoft.Testing.Platform configuration](/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/), [exit code 5](/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/) and [VSTest fallback](/2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform/).

Use [WebApplicationFactory and Testcontainers](/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) to decide which HTTP and database behavior an integration test must exercise. For a change to stored data, [enum-to-string conversion](/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/) shows why numeric strings and named values can produce different query results. To trace an authenticated request through the upgraded application, see [user-ID logging and its request-lifetime limits](/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/).

## Browse by topic

The chronological index below matches .NET 11 version tags. For focused reference, continue with [EF Core 11](/pillars/efcore-11-cheat-sheet/), [C# 14](/pillars/csharp-14-features/) or [async and concurrency](/pillars/async-and-concurrency-in-csharp/).
