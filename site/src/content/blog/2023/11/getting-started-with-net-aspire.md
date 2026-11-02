---
title: "Create and run your first Aspire starter app"
description: "Build a C# Aspire starter with an API and Blazor frontend, open its dashboard, and compare the original .NET 8 preview project and screenshots."
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
---

Start with the [Aspire CLI and C# prerequisites](/2023/11/how-to-install-net-aspire/). For a **new** solution, the `aspire-starter` template gives you an API service, a Blazor frontend and an AppHost that connects them. If you already have a solution, follow the [Aspire 13.4 guide to adding an AppHost to existing projects](/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/).

## Create the starter and open its dashboard

From the directory where you want the new solution, run:

```sh
aspire new aspire-starter -n HelloAspire -o HelloAspire
cd HelloAspire
aspire run
```

Follow any template prompts. The first command creates the solution in `HelloAspire`. The last runs its AppHost. Open the dashboard URL printed in the terminal, then open the web frontend’s endpoint from the resources list. Visit the weather page to send a request through the frontend to the API. In the dashboard, inspect the service logs and the trace for that request. Use `Ctrl+C` in the terminal to stop the app.

In the generated starter, `ApiService` serves the data, `Web` consumes it, and `ServiceDefaults` supplies common configuration. The AppHost registers the projects and connects the frontend to its dependencies. See the [current C# quickstart](https://aspire.dev/get-started/first-app/?lang=csharp) for the template structure, or [the Aspire overview](/2023/11/what-is-net-aspire/) for how a resource reference works.

## Archive: the November 2023 .NET 8 preview

**Correction — November 2, 2026:** The steps above use the Aspire 13.x CLI. The screenshots, optional Redis switch and `AddRedisContainer` API below belong to the [2023 preview](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/). Its AppHost targeted `net8.0` and referenced [Aspire.Hosting 8.0.0-preview.1.23557.2](https://www.nuget.org/packages/Aspire.Hosting/8.0.0-preview.1.23557.2).

In Visual Studio 2022 Preview, the original walkthrough selected **.NET Aspire Starter Application**, then enabled **Use Redis for caching**. Its CLI equivalent was:

```sh
dotnet new aspire-starter --use-redis-cache --output Foo
```

[![Visual Studio's create new project dialog showing a list of filtered .NET Aspire project templates.](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

[![Additional information dialog for the .NET Aspire Starter Application project template with the optional Use Redis for caching (required Docker) option.](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

The AppHost referenced `ApiService` and `Web`. Those two projects shared `ServiceDefaults`, as shown in the original dependency diagram:

[![A project dependencies graph for a .NET Aspire Starter Application showing AppHost at the top, dependent on ApiService and Web, both dependent on ServiceDefaults.](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

The preview AppHost registered Redis as `cache` and the API as `apiservice`. The web frontend referenced both. This is the historical API shape:

```cs
var builder = DistributedApplication.CreateBuilder(args);
var cache = builder.AddRedisContainer("cache");
var api = builder.AddProject<Projects.Foo_ApiService>("apiservice");
builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(api);
builder.Build().Run();
```

The original dashboard showed the projects and container together. Opening the trace for a weather request exposed its individual service calls:

[![The .NET Aspire dashboard running the .NET Aspire Starter Application project template.](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

[![A request trace inside the .NET Aspire dashboard showing the request in stages as it passes through the different application components.](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)
