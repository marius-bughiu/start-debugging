---
title: "Aspire vs Docker Compose for local multi-service development"
description: "Aspire 13.4.6 wins the .NET inner loop because it runs your projects as host processes you can debug, while Docker Compose wins when the compose file is also your CI and deployment contract. Measured startup and edit-to-running timings on both, the configuration each one injects for you, and the six gotchas that decide it."
pubDate: 2026-08-08
template: vs
tags:
  - "comparison"
  - "aspire"
  - "docker"
  - "dotnet"
  - "devops"
---

Pick Aspire if the services you run locally are .NET projects you build from source: it runs them as ordinary host processes, so a debugger attaches to all of them at once, and it injects connection strings and OpenTelemetry configuration you would otherwise hand-write. Pick Docker Compose if your `docker-compose.yaml` is also your CI, staging, or production contract, or if most of your stack is prebuilt images you do not author. You are not forced to choose: `aspire publish` emits a Compose file from the same model. All numbers and APIs below are from Aspire 13.4.6 (the current stable release, published 2026-06-20) and Docker Compose v5.1.4 on .NET 10.

Note the naming: the product dropped the ".NET" prefix with Aspire 13 in November 2025, so ".NET Aspire" and "Aspire" are the same thing, and the `dotnet workload install aspire` step has been gone since Aspire 9.0.

## The matrix

| | Aspire 13.4.6 | Docker Compose v5.1.4 |
| --- | --- | --- |
| Config format | C# or TypeScript | YAML |
| How your own .NET service runs | host process, launched by DCP | container built from a Dockerfile |
| Debugger attach | F5 across every project at once | remote debugger, configured per service |
| Connection strings | injected as `ConnectionStrings__<name>` | you write them |
| Service-to-service URLs | injected as `services__<name>__<scheme>__0` | container DNS by service name |
| Telemetry | OTLP endpoint plus dashboard, zero config | none |
| Startup ordering | `WaitFor()` plus health checks | `depends_on` with `condition: service_healthy` |
| Custom networks | no equivalent | `networks:` |
| CPU and memory limits | not modelled | `deploy.resources` |
| Container names | randomised suffix (`cache-mmsmckhq`) | deterministic (`<project>-cache-1`) |
| Is it your deployment artifact? | no, the AppHost is development-time only | frequently yes |
| Non-.NET services | Node, Bun, Python, Go, or any container | any container |

## What each one actually starts

This is the difference everything else follows from. Compose starts containers, full stop. Every service in the file, including the one you are editing, is an image that has to be built before it can run.

Aspire's AppHost starts a mix. Anything you declared with `AddProject<T>` runs as a plain process on your machine under the Developer Control Plane; only the things you did not write, declared with `AddContainer`, `AddRedis`, `AddPostgres` and friends, become containers. You can see it in `docker ps` while the app is running:

```
NAMES              IMAGE
cache-mmsmckhq     redis:8.6
```

That is the whole container list for a two-service app. The API is a `dotnet` process, which is why Visual Studio and Rider can put a breakpoint in it without any remote-debugging setup, and why a rebuild does not involve Docker at all.

## The same stack, written twice

A minimal API plus Redis. First the Compose version:

```yaml
# docker-compose.yaml -- Docker Compose v5.1.4
services:
  cache:
    image: redis:8.2
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 15

  api:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - ConnectionStrings__cache=cache:6379
    ports:
      - "8080:8080"
    depends_on:
      cache:
        condition: service_healthy
```

Plus a Dockerfile, which is not optional and is not shown here. Now the Aspire version, the entire file:

```csharp
// AppHost/AppHost.cs -- Aspire 13.4.6, .NET 10
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddProject<Projects.Api>("api")
       .WithHttpEndpoint(port: 8080, name: "public")
       .WithReference(cache)
       .WaitFor(cache);

builder.Build().Run();
```

The project file is three lines of interesting content, and note that the 13.4.6 template now puts the SDK in the `Sdk` attribute rather than a nested `<Sdk>` element:

```xml
<!-- AppHost/AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Aspire.AppHost.Sdk/13.4.6">
  <ItemGroup>
    <ProjectReference Include="..\Api\Api.csproj" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.Redis" Version="13.4.6" />
  </ItemGroup>
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

Both stacks run the same `Program.cs`, which reads `ConnectionStrings:cache` from configuration. Under Compose you supplied that value yourself. Under Aspire you did not.

## What Aspire writes into your process

I added a debug endpoint that dumps the interesting environment variables, then ran the AppHost. This is what the API process received without a line of configuration on my part:

```
ASPNETCORE_URLS=https://localhost:61681;http://localhost:61682;http://localhost:61683
ConnectionStrings__cache=localhost:58390,password=T9bjFegjra6EBk5HG3M9uq
OTEL_EXPORTER_OTLP_ENDPOINT=https://localhost:21089
OTEL_EXPORTER_OTLP_HEADERS=x-otlp-api-key=566b726e1f4c36c1b4e0474e80db9cd5
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_METRIC_EXPORT_INTERVAL=1000
OTEL_SERVICE_NAME=api
OTEL_TRACES_SAMPLER=always_on
```

Two things worth noticing. Aspire generated a Redis password and put it in the connection string, so the local cache is not open on a well-known port with no auth the way `redis:8.2` in a Compose file is. And the OTLP block is what makes traces and metrics show up in the dashboard for free; if you want the same under Compose you are standing up a collector and wiring exporters yourself, which is a whole post of its own on [using OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/).

For project-to-project references the injected variable is `services__<name>__<scheme>__0`, for example `services__basket__https__0`, and .NET's service discovery resolves `https://basket` against it.

## The measurements

Same machine, same app, same Redis: an Intel Core Ultra 7 265KF (20 cores), 32 GB RAM, Windows 11 Pro 26200, Docker 29.5.3 with Compose v5.1.4, .NET SDK 10.0.201, Aspire CLI 13.4.6. Base images were pulled before timing so no measurement includes a registry download. Timing is wall clock from the command starting to an HTTP GET on the app returning the newly built code, polled every 250 ms. The edit is a one-line change to a string literal in `Program.cs`, and each round uses a new value so nothing can be served from a cache.

| Scenario | Aspire 13.4.6 | Docker Compose v5.1.4 |
| --- | --- | --- |
| Cold start: nothing built, stack up and serving | 15.5 s (`dotnet clean`, then `aspire run`) | 10.8 s (7.0 s `build --no-cache` plus 3.8 s `up`) |
| One-line C# change to serving the new code | 14.6 / 13.9 / 11.0 s, median 13.9 s | 5.4 / 5.6 / 5.3 s, median 5.4 s |

Docker Compose won every row, and I am not going to dress that up. It is worth understanding why before you draw a conclusion from it.

The Compose loop here is a three-second incremental `docker build` (the restore layer is cached, only `COPY` and `dotnet publish` re-run) plus a container recreate, on an app whose published output is about ten kilobytes of my code. The Aspire loop is `aspire resource api stop`, a full MSBuild invocation, and `aspire resource api start`, and MSBuild's own startup cost dominates on a project this small. Compose's number grows with the size of the image layer you rebuild; Aspire's grows with the MSBuild graph. I did not measure where those curves cross, so I will not claim a crossover point.

The bigger caveat is that the Aspire row is measured with the CLI, and the CLI is not how most people use Aspire. In Visual Studio or Rider the loop is F5 plus Hot Reload, which patches the running process and never rebuilds. There is no equivalent for a containerised service: `docker compose watch` syncs files or rebuilds the image, it does not patch a running process. So take the table as an upper bound on Aspire's inner loop and a fair measure of Compose's.

## When Docker Compose is the right answer

- **The compose file is a deliverable.** If CI spins up the same YAML, if a QA box runs it, if your on-call runbook says `docker compose up`, then Compose is not just a dev tool and replacing it with an AppHost means maintaining two descriptions of the same system.
- **You mostly do not build the services.** A stack of Kafka, MinIO, Keycloak and a Postgres with three init scripts is a stack of images. Aspire models those as containers too, but you are paying for a C# abstraction over things that were already fine as YAML.
- **You need networks or resource limits.** Aspire has no equivalent for custom network isolation; every resource is reachable by name. If you are testing what happens when service A genuinely cannot reach service B, or you need `deploy.resources` to cap a container at one CPU, Compose does that and Aspire does not.
- **Your team is not .NET-first.** Aspire 13.4 made TypeScript AppHosts generally available and added `AddGoApp` and `AddBunApp`, so this is less true than it was a year ago, but the documentation, samples, and integration catalogue are still centred on .NET.

## When Aspire is the right answer

- **You debug more than one service at a time.** This is the single biggest reason. Breakpoints in the API and the worker in one F5, with no `docker-compose.debug.yml`, no `vsdbg` in the image, no port juggling.
- **Your dev stack has backing services with fiddly configuration.** `AddPostgres("db").AddDatabase("orders")` gets you a container, a generated password, a connection string in the right .NET format, and a health-gated startup. The Compose equivalent is fifteen lines and a `.env` file.
- **You want telemetry in the inner loop.** The dashboard shows traces across services, structured logs, and metrics from the moment you press run. Finding an N+1 or a retry storm on your own machine, rather than in staging, changes how you write the code. If you have been [detecting N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) from log files, this is a real upgrade.
- **You are already adding it incrementally.** Aspire drops into a brownfield solution as two new projects, which is the subject of [adding Aspire to an existing ASP.NET Core solution](/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/).

## The gotchas that pick for you

**Compose port syntax does not translate literally.** `ports: ["8080:8080"]` looks like `WithHttpEndpoint(port: 8080, targetPort: 8080)`, and that combination throws at startup:

```
System.InvalidOperationException: The endpoint 'public' for resource 'api'
requested a proxy (IsProxied is true). Non-container resources cannot be
proxied when both TargetPort and Port are specified with the same value.
```

Aspire proxies project endpoints, so the host port and the target port cannot be the same value. Specify `port:` only and let it pick the target.

**`WithReference` is not `depends_on`.** The migration guide is explicit that `WithReference()` only configures service discovery and connection strings and does not control startup order. If you want the Compose behaviour of `condition: service_healthy`, you want `WaitFor()`, and you want it in addition to `WithReference()`, not instead of it.

**Container names are not stable.** Compose gives you `bench-cache-1`, derived from the project and service name. Aspire gave me `cache-vvkhtnuf`, then `cache-zwjpvzxh`, then `cache-mmsmckhq` across three runs. Any script or teammate habit built on `docker exec -it myapp-cache-1 redis-cli` breaks.

**Default image versions move with the Aspire version.** `AddRedis` on 13.4.6 pulled `redis:8.6`, not the `redis:8.2` my Compose file pinned. Aspire 13.4 also moved the Postgres default from 17.6 to 18.3, which is not compatible with an existing data volume. Pin with `WithImageTag` if you care.

**A Compose build context needs a `.dockerignore`.** Without one, `COPY Api/ Api/` ships your host `bin/` and `obj/` into the build context, which bloats every build and invalidates layers on changes that did not touch source. Two lines fix it, and the difference is visible in the build log, where the context transfer for this project drops to 1.18 kB:

```
# .dockerignore
**/bin
**/obj
```

Aspire has no equivalent problem because it never builds an image for your project. It has a mirror-image one instead: MSBuild cannot overwrite `Api.dll` while the resource is running, so a command-line rebuild needs `aspire resource api stop` before `dotnet build`. The IDE handles that for you; a shell script does not.

**Aspire's proxy can outlive `aspire stop`, and it will shadow your containers.** This one cost me an hour while collecting the numbers above. After `aspire stop --force`, a `dcp` process was still bound to the fixed host port:

```
PID=70448 Name=dcp Addr=127.0.0.1
PID=70448 Name=dcp Addr=::1
```

Docker then bound the same port on `::`, both commands reported success, and every request to `localhost:8080` was answered by the abandoned Aspire proxy rather than the container. Nothing errors. `docker compose ps` shows the container healthy and mapped, the image genuinely contains your new code, and the app still returns the previous build's responses, because you are not talking to the container at all. I spent a while blaming Docker's layer cache before checking who actually owned the port:

```bash
Get-NetTCPConnection -LocalPort 8080 -State Listen
```

This only bites when you pin a host port with `WithHttpEndpoint(port: ...)`, which is exactly what you do when translating a Compose file. Aspire's default dynamic ports do not collide.

## Using both

The choice is not permanent, because the AppHost model can generate the Compose file:

```csharp
// AppHost/AppHost.cs -- Aspire 13.4.6
builder.AddDockerComposeEnvironment("compose")
       .WithDashboard(d => d.WithHostPort(8080));
```

```bash
aspire publish
```

That emits a `docker-compose.yaml` plus a `.env` with the parameters left unfilled, and every resource in the model becomes a Compose service without further opt-in. `PublishAsDockerComposeService` customises an individual service (container name, labels, restart policy) and `ConfigureComposeFile` edits the whole document before it is written. So a reasonable end state is: Aspire for the inner loop, generated Compose for the environments that need a YAML file, one source of truth. Note that the AppHost itself never ships, in the same way that [publishing a container image with `dotnet publish /t:PublishContainer`](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) is a separate concern from how you ran the thing locally.

## The call

For a .NET solution where you build the services, Aspire is the better local development environment, and the reason is emphatically not speed: Compose beat it on every timing I took. It is that your code runs as a process you can debug, and that the AppHost writes the connection strings, ports, and OpenTelemetry configuration that you would otherwise maintain by hand in YAML and drift out of sync. Seconds of startup are cheap next to an afternoon spent working out why the container has a stale build or why the debugger will not attach.

Stay on Docker Compose when the file has a second job. If CI, staging, or a runbook depends on that YAML, the honest comparison is not "Aspire vs Compose" but "Aspire plus generated Compose vs Compose alone", and if your team is small and the stack is five images you did not write, the second option is still a perfectly good answer in 2026.

## Related

- [How to add Aspire to an existing ASP.NET Core solution without restructuring it](/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/)
- [What is .NET Aspire?](/2023/11/what-is-net-aspire/)
- [How to use OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [WebApplicationFactory vs Testcontainers for ASP.NET Core integration tests](/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/)
- [How to publish a .NET 11 app as a container image with dotnet publish /t:PublishContainer](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## Sources

- [Migrate from Docker Compose to Aspire](https://aspire.dev/app-host/migrate-from-docker-compose/), the official concept-by-concept mapping
- [Deploy Aspire apps with Docker Compose to any host](https://aspire.dev/deployment/docker-compose/)
- [Aspire Docker integration for containerized resources](https://aspire.dev/integrations/compute/docker/)
- [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/), including the Postgres and RabbitMQ default image changes
- [Aspire service discovery fundamentals](https://aspire.dev/fundamentals/service-discovery/)
- [Compose Develop Specification](https://docs.docker.com/reference/compose-file/develop/) for `watch`
- [microsoft/aspire releases](https://github.com/microsoft/aspire/releases)
