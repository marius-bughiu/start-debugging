---
title: "Fix: System.InvalidOperationException: No connection string named 'DefaultConnection' could be found"
description: "If GetConnectionString returns null in .NET 11, your appsettings.json is missing the key, not copied to the build output, or the wrong environment file is being selected. Three checks fix 95% of cases."
pubDate: 2026-05-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "ef-core"
  - "configuration"
---

The fix: `IConfiguration.GetConnectionString("DefaultConnection")` returns `null`, and EF Core throws because it expected a string. Either your `appsettings.json` does not contain a `ConnectionStrings:DefaultConnection` entry, the file is not being copied to the build output, or the wrong environment is selected and the key only exists in a sibling file. Verify the JSON, set `Copy to Output Directory = Copy if newer`, and confirm `ASPNETCORE_ENVIRONMENT` matches the file you wrote into.

```text
Unhandled exception. System.InvalidOperationException: No connection string named 'DefaultConnection' could be found in the application configuration.
   at Microsoft.EntityFrameworkCore.SqlServerDbContextOptionsExtensions.UseSqlServer(DbContextOptionsBuilder optionsBuilder, String connectionString, Action`1 sqlServerOptionsAction)
   at Program.<Main>$(String[] args) in C:\src\Api\Program.cs:line 14
   at Program.<Main>(String[] args)
```

The error is raised by EF Core's `UseSqlServer(string)` (and equivalents on Npgsql, MySQL, SQLite) when the string parameter is `null`. The exception text comes from EF Core's parameter validation, but the root cause is always upstream in `Microsoft.Extensions.Configuration`. This guide is written against .NET 11 preview 4, EF Core 11.0.0-preview.4, and `Microsoft.AspNetCore.App` 11.0.0-preview.4. The same advice applies all the way back to .NET Core 3.1.

## Why GetConnectionString returns null

`IConfiguration.GetConnectionString("X")` is sugar for `configuration["ConnectionStrings:X"]`. The configuration system walks every registered provider in order (JSON files, user secrets, environment variables, command-line arguments) and returns the first match. `null` means **none** of the providers had that key. There are six common reasons:

1. The key is missing from `appsettings.json`.
2. The key is present, but the file is not copied to the output directory, so the running binary never sees it.
3. The key is in `appsettings.Production.json`, but the app is running in `Development`, where only `appsettings.Development.json` is loaded.
4. EF Core design-time tools (`dotnet ef migrations add`) are invoked from a folder that does not contain the JSON file.
5. The key lives in User Secrets, but the project's `.csproj` is missing `<UserSecretsId>`.
6. The connection string is set as an environment variable, but the variable name uses a single underscore (`ConnectionStrings_DefaultConnection`) instead of the required double underscore (`ConnectionStrings__DefaultConnection`).

Cases 2 and 6 are the silent killers, because the code looks correct on inspection.

## A minimal repro

A clean Web API created with `dotnet new webapi -n Api` and an EF Core hookup. This is the smallest setup that reliably reproduces the error.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));

var app = builder.Build();
app.MapGet("/", () => "ok");
app.Run();

public class AppDb : DbContext
{
    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

```json
// appsettings.json -- this file is what you THINK is being read
{
  "Logging": { "LogLevel": { "Default": "Information" } },
  "AllowedHosts": "*"
}
```

`builder.Configuration.GetConnectionString("DefaultConnection")` returns `null`, EF Core throws on `UseSqlServer(null)`, and the host fails to build. The exception message names `DefaultConnection`, which is misleading: nothing in EF Core forces that name. Whatever string you passed to `GetConnectionString(...)` will appear there.

## The fix in three checks

Run these in order. Each one has caught me at least once.

### 1. Verify the JSON has the key

Open `appsettings.json` in the project that hosts `Program.cs` (not the project that defines `DbContext`, if they differ) and add the section:

```json
// appsettings.json
{
  "ConnectionStrings": {
    "DefaultConnection": "Server=(localdb)\\mssqllocaldb;Database=AppDb;Trusted_Connection=True;TrustServerCertificate=True"
  }
}
```

The provider name in `UseSqlServer` is independent of the connection-string format; SQL Server, PostgreSQL, MySQL, SQLite all read the same `ConnectionStrings:Name` shape. If your JSON has the key but inside a nested `Settings` object, `GetConnectionString` will not find it. The exact path must be `ConnectionStrings.<Name>`.

### 2. Confirm the file is in the build output

This trips up class libraries and worker services where the project template does not include `appsettings.json` by default. After `dotnet build`, check that the file is present next to your DLL:

```bash
dotnet build
ls bin/Debug/net11.0/appsettings.json
```

If it is missing, add this to the `.csproj`:

```xml
<!-- .NET 11 SDK-style csproj -->
<ItemGroup>
  <None Update="appsettings.json">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
  </None>
  <None Update="appsettings.*.json">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    <DependentUpon>appsettings.json</DependentUpon>
  </None>
</ItemGroup>
```

`Microsoft.NET.Sdk.Web` includes this implicitly, so a project created with `dotnet new webapi` does not need it. Worker projects (`Microsoft.NET.Sdk.Worker`) include it too. Plain `Microsoft.NET.Sdk` does not, and that is where most of these bugs live: a console host reused for `dotnet ef`, or a class library that gained a `Program.cs` later.

### 3. Match the environment to the file you wrote

`WebApplication.CreateBuilder` loads `appsettings.json` first, then `appsettings.{Environment}.json`, with the second overriding the first. The environment is read from `ASPNETCORE_ENVIRONMENT` (Web) or `DOTNET_ENVIRONMENT` (generic host), defaulting to `Production` if neither is set. A common failure mode: you put the connection string only in `appsettings.Development.json`, then ran the app in production where only `appsettings.json` and `appsettings.Production.json` are loaded.

```bash
# powershell
$env:ASPNETCORE_ENVIRONMENT = "Development"

# bash
export ASPNETCORE_ENVIRONMENT=Development

dotnet run
```

Print the resolved value once during startup so you can see it in the logs:

```csharp
// .NET 11, C# 14
var cs = builder.Configuration.GetConnectionString("DefaultConnection");
Console.WriteLine($"DefaultConnection length: {cs?.Length ?? 0}");
```

Never log the full connection string in production, because passwords often live there. Logging the length is enough to tell `null` from "loaded but empty" from "loaded with content".

## Variants that hit different audiences

### `dotnet ef migrations add` from a class library

EF Core's design-time tools resolve `DbContext` by either calling your `Program.Main` or by finding an `IDesignTimeDbContextFactory<T>`. If the `DbContext` lives in a class library, `dotnet ef` invokes the **startup project** (the Web API) and reads its configuration. Run from the right folder:

```bash
# Bad: connection string is in Api/appsettings.json,
# but you ran this in Data/, where there is no JSON.
cd Data
dotnet ef migrations add Init

# Good: point at the startup project explicitly.
cd Data
dotnet ef migrations add Init --startup-project ../Api/Api.csproj
```

If you must run migrations from the data project standalone (for example, in a release pipeline), add an `IDesignTimeDbContextFactory<AppDb>`:

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbFactory : IDesignTimeDbContextFactory<AppDb>
{
    public AppDb CreateDbContext(string[] args)
    {
        var config = new ConfigurationBuilder()
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile("appsettings.json", optional: false)
            .AddEnvironmentVariables()
            .Build();

        var options = new DbContextOptionsBuilder<AppDb>()
            .UseSqlServer(config.GetConnectionString("DefaultConnection"))
            .Options;

        return new AppDb(options);
    }
}
```

This factory is design-time only; it is not registered in DI and does not run at runtime.

### Environment variables in containers

In Docker and Kubernetes, the convention is to flatten configuration paths with double underscores. `ConnectionStrings:DefaultConnection` becomes `ConnectionStrings__DefaultConnection`. A single underscore is just a normal name, and the configuration system will not recognise it.

```yaml
# docker-compose, .NET 11
services:
  api:
    image: api:11.0
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      ConnectionStrings__DefaultConnection: "Server=db;Database=App;User Id=sa;Password=..."
```

```bash
# Kubernetes secret reference
- name: ConnectionStrings__DefaultConnection
  valueFrom:
    secretKeyRef:
      name: db
      key: connection
```

If the variable is correct but still missing, confirm `AddEnvironmentVariables()` is in the configuration pipeline. `WebApplication.CreateBuilder` calls it for you. A custom `ConfigurationBuilder` in a console project does not, unless you add it explicitly.

### User Secrets in development

`dotnet user-secrets set "ConnectionStrings:DefaultConnection" "..."` only works when the project's `.csproj` has a `<UserSecretsId>` element:

```xml
<!-- .NET 11 SDK-style csproj -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <UserSecretsId>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</UserSecretsId>
</PropertyGroup>
```

`dotnet user-secrets init` adds this for you. User secrets are only loaded when `IHostEnvironment.IsDevelopment()` is true, which is another reason check 3 (the environment check) matters.

### Azure Key Vault and other providers

If you use `builder.Configuration.AddAzureKeyVault(...)`, the secret name must match the configuration path with `--` as a separator. A vault secret named `ConnectionStrings--DefaultConnection` shows up as `ConnectionStrings:DefaultConnection`. A secret named `DefaultConnection` does not.

### The error mentions a name you do not recognise

If the message says `No connection string named 'X'` and `X` is not the name you typed, you are probably calling `UseSqlServer(connectionStringName: "X")` on an older EF Core overload that resolves names against the application's connection-string table. EF Core 11 still supports this for back-compat. The fix is the same: add a `ConnectionStrings:X` entry, or pass the literal connection string instead of a name.

### Native AOT and trimming

If you publish with Native AOT, configuration binding still works for `GetConnectionString`, which is a plain string lookup. The error you are looking at is not an AOT trim warning. If you also see `IL3050`, that is the binding warning for `Configure<T>` reflection-based binding, not for connection strings.

## Related

For the broader EF Core context that usually surrounds this error, see the rundown of [N+1 query detection](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) and the guide to [compiled queries on hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). When wiring up tests against the same connection string, the [Testcontainers walkthrough](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) shows how to spin a real SQL Server per fixture without committing credentials. For diagnosing this kind of startup failure on a running app, the [Serilog and Seq setup](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) makes the resolved configuration readable in production logs.

## Sources

- [`IConfiguration.GetConnectionString` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.configuration.configurationextensions.getconnectionstring), Microsoft Learn.
- [Configuration in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/), Microsoft Learn.
- [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation), EF Core docs.
- [Safe storage of app secrets in development](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets), Microsoft Learn.
- [Environment variables configuration provider](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/#environment-variables), Microsoft Learn, on the `__` separator.
