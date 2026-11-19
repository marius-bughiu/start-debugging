---
title: "Aspire 17: AddProject is obsolete, here is what to change before you run aspire update"
description: "Aspire 17.0 shipped on November 17, 2026. It needs .NET 10 for the AppHost, obsoletes AddProject and Aspire.AppHost.Sdk in favor of AddDotnetProject, adds per-environment secrets, and makes the Kubernetes packages stable. What changes in your AppHost and what aspire update will not do for you."
pubDate: 2026-11-19
tags:
  - "aspire"
  - "dotnet-10"
  - "kubernetes"
---

Aspire jumped from 13.6 straight to [17.0 on November 17, 2026](https://devblogs.microsoft.com/aspire/whats-new-aspire-17/). The version number gets a joke in the announcement and no real explanation, so ignore it. What matters is that this release changes how .NET projects are registered in the AppHost, and the upgrade tool does not do all of that work for you.

## AppHosts now need .NET 10

Aspire 17 requires .NET 10 or later for the AppHost and for the Aspire library packages. The services you orchestrate can still target older frameworks as long as they do not reference Aspire packages themselves. If your AppHost still targets `net9.0` (which left support on November 10), retarget it first.

## AddProject and Aspire.AppHost.Sdk are obsolete

The biggest code-level change: `AddProject<T>`, `AddCSharpApp`, and the `Aspire.AppHost.Sdk` MSBuild SDK are marked obsolete. They still work, but you will get warnings, and the replacement is the path-based `AddDotnetProject` from the now-stable `Aspire.Hosting.Dotnet` package.

Before, with the generated `Projects` type:

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var api = builder.AddProject<Projects.Api>("api");
builder.AddProject<Projects.Web>("web").WithReference(api);
```

After, in Aspire 17:

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var api = builder.AddDotnetProject("api", "../Api/Api.csproj");
builder.AddDotnetProject("web", "../Web/Web.csproj").WithReference(api);
```

The project file changes too. Per the [Aspire 17 upgrade notes](https://aspire.dev/whats-new/aspire-17/), the AppHost moves from `Aspire.AppHost.Sdk` to plain `Microsoft.NET.Sdk` with package references to `Aspire.Hosting.AppHost` and `Aspire.Hosting.Dotnet`. This is the part `aspire update` does not migrate, so make that edit by hand.

There is also a known Visual Studio issue: "Enlist in Aspire orchestration" can still generate a legacy `AddProject<TProject>` call that fails with CS0234. The documented workaround is `aspire add Aspire.Hosting.Dotnet` and replacing the line with `AddDotnetProject`.

## The upgrade sequence

The announcement gives three commands:

```bash
aspire update --self
aspire update
aspire agent init
```

Read the breaking changes before running the second one. The ones most likely to bite:

- `Aspire.RabbitMQ.Client.v6` and `Aspire.MongoDB.Driver.v2` are gone; use `Aspire.RabbitMQ.Client` and `Aspire.MongoDB.Driver`.
- `WithLetsEncryptProduction` and `WithLetsEncryptStaging` are removed in favor of `WithAcmeServer`.
- Empty strings no longer satisfy required parameters.
- Default container tags moved: PostgreSQL 18.6, Redis 8.10, and MongoDB 9.0, a major bump. Pin with `WithImageTag` if you are not ready.
- OpenTelemetry 1.18 halves the default OTLP max request size from 128 MiB to 64 MiB. Restore it with `OtlpExporterOptions.MaxRequestSizeBytes` if your exporters send large batches.

## Secrets per environment and stable Kubernetes

Parameters can now carry environment-specific secrets that `aspire deploy` picks up:

```bash
aspire secret set Parameters:api_key --envvar API_KEY --environment Staging
aspire deploy --environment Staging
```

Secret commands still default to `Development`, and storage moves to `~/.aspire/secrets`. `Aspire.Hosting.Kubernetes` and `Aspire.Hosting.Azure.Kubernetes` are stable in 17.0, and `aspire deploy` applies the generated Helm charts to the current kube context. Helm 4 is required. New AKS clusters default to the Standard tier instead of Free, which is a cost change worth noticing.

## Smaller things that ship with it

The dashboard is redesigned around a resource table with health, request rate, error rate, and p95 latency, and the old layout is still one setting away. The CLI gains shell completion (`aspire completions script zsh`) and `aspire describe --format mermaid` for dumping the app model as a diagram. Go AppHosts drop their experimental flag and are now in preview, requiring Go 1.26.

If you followed the 13.6 line, the [13.6.4 DCP timeout fix](/2026/10/aspire-13-6-4-recovers-timed-out-dcp-creates-instead-of-failing-the-resource/) is the last patch story we covered. 13.6 stays supported, so there is no rush, but the `AddDotnetProject` migration is mechanical and best done before the obsolete APIs are removed.
