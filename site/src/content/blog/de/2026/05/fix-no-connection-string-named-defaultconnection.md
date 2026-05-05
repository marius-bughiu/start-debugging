---
title: "Lösung: System.InvalidOperationException: No connection string named 'DefaultConnection' could be found"
description: "Wenn GetConnectionString in .NET 11 null zurückgibt, fehlt der Schlüssel in Ihrer appsettings.json, die Datei wird nicht in die Build-Ausgabe kopiert, oder die falsche Umgebungsdatei wird gewählt. Drei Prüfungen klären 95% der Fälle."
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
lang: "de"
translationOf: "2026/05/fix-no-connection-string-named-defaultconnection"
translatedBy: "claude"
translationDate: 2026-05-05
---

Die Lösung: `IConfiguration.GetConnectionString("DefaultConnection")` gibt `null` zurück, und EF Core wirft eine Exception, weil ein String erwartet wurde. Entweder enthält Ihre `appsettings.json` keinen `ConnectionStrings:DefaultConnection`-Eintrag, die Datei wird nicht in die Build-Ausgabe kopiert, oder die falsche Umgebung ist gewählt und der Schlüssel existiert nur in einer Geschwisterdatei. Prüfen Sie das JSON, setzen Sie `Copy to Output Directory = Copy if newer`, und stellen Sie sicher, dass `ASPNETCORE_ENVIRONMENT` zu der Datei passt, in die Sie geschrieben haben.

```text
Unhandled exception. System.InvalidOperationException: No connection string named 'DefaultConnection' could be found in the application configuration.
   at Microsoft.EntityFrameworkCore.SqlServerDbContextOptionsExtensions.UseSqlServer(DbContextOptionsBuilder optionsBuilder, String connectionString, Action`1 sqlServerOptionsAction)
   at Program.<Main>$(String[] args) in C:\src\Api\Program.cs:line 14
   at Program.<Main>(String[] args)
```

Der Fehler wird von `UseSqlServer(string)` aus EF Core (und den Äquivalenten in Npgsql, MySQL, SQLite) geworfen, wenn der String-Parameter `null` ist. Der Exception-Text stammt aus der Parameter-Validierung von EF Core, aber die eigentliche Ursache liegt immer weiter oben in `Microsoft.Extensions.Configuration`. Diese Anleitung wurde gegen .NET 11 Preview 4, EF Core 11.0.0-preview.4 und `Microsoft.AspNetCore.App` 11.0.0-preview.4 geschrieben. Dieselben Hinweise gelten zurück bis zu .NET Core 3.1.

## Warum GetConnectionString null zurückgibt

`IConfiguration.GetConnectionString("X")` ist Syntactic Sugar für `configuration["ConnectionStrings:X"]`. Das Konfigurationssystem läuft jeden registrierten Provider in der Reihenfolge durch (JSON-Dateien, User Secrets, Umgebungsvariablen, Kommandozeilenargumente) und liefert den ersten Treffer. `null` bedeutet, dass **keiner** der Provider diesen Schlüssel hatte. Es gibt sechs übliche Gründe:

1. Der Schlüssel fehlt in `appsettings.json`.
2. Der Schlüssel ist vorhanden, aber die Datei wird nicht ins Ausgabeverzeichnis kopiert, sodass das laufende Binary sie nie sieht.
3. Der Schlüssel steht in `appsettings.Production.json`, aber die App läuft in `Development`, wo nur `appsettings.Development.json` geladen wird.
4. Die Design-Time-Tools von EF Core (`dotnet ef migrations add`) werden aus einem Verzeichnis aufgerufen, das die JSON-Datei nicht enthält.
5. Der Schlüssel liegt in den User Secrets, aber der `.csproj` des Projekts fehlt `<UserSecretsId>`.
6. Die Verbindungszeichenfolge ist als Umgebungsvariable gesetzt, aber der Name nutzt einen einfachen Unterstrich (`ConnectionStrings_DefaultConnection`) statt des erforderlichen doppelten Unterstrichs (`ConnectionStrings__DefaultConnection`).

Fälle 2 und 6 sind die stillen Killer, weil der Code bei der Inspektion korrekt aussieht.

## Ein minimaler Repro

Eine saubere Web API, erstellt mit `dotnet new webapi -n Api`, und eine EF-Core-Anbindung. Das ist das kleinste Setup, das den Fehler zuverlässig reproduziert.

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

`builder.Configuration.GetConnectionString("DefaultConnection")` liefert `null`, EF Core wirft bei `UseSqlServer(null)`, und der Host scheitert beim Aufbau. Die Exception nennt `DefaultConnection`, was irreführend ist: nichts in EF Core erzwingt diesen Namen. Der String, den Sie an `GetConnectionString(...)` übergeben haben, taucht dort auf.

## Die Lösung in drei Prüfungen

In dieser Reihenfolge anwenden. Jede hat mich mindestens einmal erwischt.

### 1. Sicherstellen, dass das JSON den Schlüssel enthält

Öffnen Sie die `appsettings.json` im Projekt, das `Program.cs` enthält (nicht im Projekt, das den `DbContext` definiert, falls beide getrennt sind), und fügen Sie den Abschnitt hinzu:

```json
// appsettings.json
{
  "ConnectionStrings": {
    "DefaultConnection": "Server=(localdb)\\mssqllocaldb;Database=AppDb;Trusted_Connection=True;TrustServerCertificate=True"
  }
}
```

Der Provider-Name in `UseSqlServer` ist unabhängig vom Format der Verbindungszeichenfolge; SQL Server, PostgreSQL, MySQL und SQLite lesen alle die gleiche Form `ConnectionStrings:Name`. Liegt der Schlüssel im JSON in einem verschachtelten `Settings`-Objekt, findet `GetConnectionString` ihn nicht. Der exakte Pfad muss `ConnectionStrings.<Name>` lauten.

### 2. Bestätigen, dass die Datei in der Build-Ausgabe ist

Das trifft Class Libraries und Worker Services, deren Projektvorlage `appsettings.json` standardmäßig nicht enthält. Nach `dotnet build` prüfen, ob die Datei neben Ihrer DLL liegt:

```bash
dotnet build
ls bin/Debug/net11.0/appsettings.json
```

Fehlt sie, ergänzen Sie das `.csproj`:

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

`Microsoft.NET.Sdk.Web` enthält das implizit, ein mit `dotnet new webapi` erzeugtes Projekt benötigt es daher nicht. Worker-Projekte (`Microsoft.NET.Sdk.Worker`) enthalten es ebenfalls. Das schlichte `Microsoft.NET.Sdk` nicht, und genau dort leben die meisten dieser Bugs: ein Konsolen-Host, der für `dotnet ef` zweckentfremdet wird, oder eine Class Library, die später eine `Program.cs` bekommen hat.

### 3. Die Umgebung passend zur geschriebenen Datei wählen

`WebApplication.CreateBuilder` lädt zuerst `appsettings.json`, dann `appsettings.{Environment}.json`, wobei das zweite das erste überschreibt. Die Umgebung wird aus `ASPNETCORE_ENVIRONMENT` (Web) oder `DOTNET_ENVIRONMENT` (Generic Host) gelesen und ist `Production`, wenn keine gesetzt ist. Häufiger Fehler: Sie schreiben die Verbindungszeichenfolge nur in `appsettings.Development.json` und starten die App dann in der Produktion, wo nur `appsettings.json` und `appsettings.Production.json` geladen werden.

```bash
# powershell
$env:ASPNETCORE_ENVIRONMENT = "Development"

# bash
export ASPNETCORE_ENVIRONMENT=Development

dotnet run
```

Geben Sie den aufgelösten Wert beim Start einmal aus, damit er in den Logs sichtbar ist:

```csharp
// .NET 11, C# 14
var cs = builder.Configuration.GetConnectionString("DefaultConnection");
Console.WriteLine($"DefaultConnection length: {cs?.Length ?? 0}");
```

Loggen Sie nie die vollständige Verbindungszeichenfolge in Produktion, weil dort oft Passwörter stehen. Die Länge zu loggen reicht, um `null` von "geladen, aber leer" und "geladen mit Inhalt" zu unterscheiden.

## Varianten, die unterschiedliche Zielgruppen treffen

### `dotnet ef migrations add` aus einer Class Library

Die Design-Time-Tools von EF Core lösen den `DbContext` auf, indem sie entweder `Program.Main` aufrufen oder ein `IDesignTimeDbContextFactory<T>` finden. Liegt der `DbContext` in einer Class Library, ruft `dotnet ef` das **Startprojekt** (die Web API) auf und liest dessen Konfiguration. Aus dem richtigen Verzeichnis ausführen:

```bash
# Bad: connection string is in Api/appsettings.json,
# but you ran this in Data/, where there is no JSON.
cd Data
dotnet ef migrations add Init

# Good: point at the startup project explicitly.
cd Data
dotnet ef migrations add Init --startup-project ../Api/Api.csproj
```

Wenn Sie Migrationen eigenständig aus dem Datenprojekt ausführen müssen (etwa in einer Release-Pipeline), fügen Sie ein `IDesignTimeDbContextFactory<AppDb>` hinzu:

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

Diese Factory ist nur Design-Time; sie wird nicht in DI registriert und läuft nicht zur Laufzeit.

### Umgebungsvariablen in Containern

In Docker und Kubernetes ist es Konvention, Konfigurationspfade mit doppeltem Unterstrich zu flachen. Aus `ConnectionStrings:DefaultConnection` wird `ConnectionStrings__DefaultConnection`. Ein einfacher Unterstrich ist nur ein normaler Name, und das Konfigurationssystem erkennt ihn nicht.

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

Stimmt die Variable, fehlt aber trotzdem, prüfen Sie, ob `AddEnvironmentVariables()` in der Konfigurationspipeline steht. `WebApplication.CreateBuilder` ruft es für Sie auf. Ein eigenes `ConfigurationBuilder` in einem Konsolenprojekt nicht, sofern Sie es nicht explizit ergänzen.

### User Secrets in der Entwicklung

`dotnet user-secrets set "ConnectionStrings:DefaultConnection" "..."` funktioniert nur, wenn das `.csproj` des Projekts ein `<UserSecretsId>`-Element hat:

```xml
<!-- .NET 11 SDK-style csproj -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <UserSecretsId>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</UserSecretsId>
</PropertyGroup>
```

`dotnet user-secrets init` ergänzt das für Sie. User Secrets werden nur geladen, wenn `IHostEnvironment.IsDevelopment()` `true` ist, was ein weiterer Grund ist, warum Prüfung 3 (die Umgebungsprüfung) wichtig ist.

### Azure Key Vault und andere Provider

Wenn Sie `builder.Configuration.AddAzureKeyVault(...)` nutzen, muss der Secret-Name den Konfigurationspfad mit `--` als Trennzeichen abbilden. Ein Vault-Secret namens `ConnectionStrings--DefaultConnection` erscheint als `ConnectionStrings:DefaultConnection`. Ein Secret namens `DefaultConnection` nicht.

### Der Fehler nennt einen Namen, den Sie nicht erkennen

Wenn die Meldung `No connection string named 'X'` lautet und `X` nicht der Name ist, den Sie eingegeben haben, rufen Sie wahrscheinlich `UseSqlServer(connectionStringName: "X")` über eine ältere EF-Core-Überladung auf, die Namen gegen die Anwendungs-Connection-Strings auflöst. EF Core 11 unterstützt das aus Kompatibilitätsgründen weiterhin. Die Lösung ist dieselbe: ein `ConnectionStrings:X`-Eintrag oder die literale Verbindungszeichenfolge statt eines Namens übergeben.

### Native AOT und Trimming

Wenn Sie mit Native AOT publizieren, funktioniert das Konfigurationsbinding für `GetConnectionString` weiterhin, weil es eine simple String-Suche ist. Der Fehler, den Sie sehen, ist keine AOT-Trim-Warnung. Sehen Sie zusätzlich `IL3050`, ist das die Bindungs-Warnung für das reflexionsbasierte Binding von `Configure<T>`, nicht für Verbindungszeichenfolgen.

## Verwandt

Für den breiteren EF-Core-Kontext rund um diesen Fehler, siehe die Übersicht zur [Erkennung von N+1-Abfragen](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) und die Anleitung zu [kompilierten Abfragen auf Hot Paths](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). Wenn Sie Tests an dieselbe Verbindungszeichenfolge anbinden, zeigt der [Testcontainers-Walkthrough](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), wie Sie pro Fixture einen echten SQL Server hochziehen, ohne Anmeldedaten zu committen. Zur Diagnose solcher Startfehler in einer laufenden App macht das [Serilog- und Seq-Setup](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) die aufgelöste Konfiguration in Produktionslogs lesbar.

## Quellen

- [`IConfiguration.GetConnectionString` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.configuration.configurationextensions.getconnectionstring), Microsoft Learn.
- [Configuration in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/), Microsoft Learn.
- [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation), EF Core docs.
- [Safe storage of app secrets in development](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets), Microsoft Learn.
- [Environment variables configuration provider](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/#environment-variables), Microsoft Learn, zum `__`-Trennzeichen.
