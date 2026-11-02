---
title: "What is .NET Aspire? AppHost, service discovery and the dashboard"
description: "How an Aspire AppHost connects an API and a frontend, what service defaults configure, and what you can see in the dashboard."
pubDate: 2023-11-14
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
---

An API and a frontend can both start successfully while the frontend still calls the wrong port. Aspire lets you describe these services and their dependencies in an **AppHost**. When you run the app locally, Aspire starts the resources and passes connection information to the services that reference them.

## How the frontend finds the API

Suppose a C# AppHost references two projects named `Api` and `Web`. This example registers each project as a resource and tells Aspire that the web service needs the API:

```cs
var builder = DistributedApplication.CreateBuilder(args);
var api = builder.AddProject<Projects.Api>("api");
builder.AddProject<Projects.Web>("web").WithReference(api);
builder.Build().Run();
```

`WithReference(api)` supplies the web project with endpoint information for the resource named `api`. A client configured for service discovery can use that logical name. The frontend still has to make the HTTP request, and the API still needs to handle it. The same pattern can supply a connection string when the referenced resource is a database.

## What the other pieces do

The starter’s **ServiceDefaults** project shares configuration for service discovery, health checks and telemetry. Each participating service calls those extensions. The **dashboard** shows resource status and endpoints, then lets you follow a request through the logs and distributed traces that the services emit. For example, a long trace can reveal whether a slow page spent its time in the frontend or waiting for an API response.

**Correction — November 2, 2026:** The [original .NET 8 preview announcement](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/) used older hosting APIs. The example above describes the C# AppHost model used in Aspire 13.x. A project reference alone does not configure every client automatically.

[Install the Aspire CLI](/2023/11/how-to-install-net-aspire/) to prepare a machine, then [create and run the starter app](/2023/11/getting-started-with-net-aspire/) to see the service endpoints in the dashboard.
