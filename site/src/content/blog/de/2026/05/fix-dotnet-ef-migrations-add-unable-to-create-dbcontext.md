---
title: "Fix: dotnet ef migrations add scheitert mit 'Unable to create an object of type DbContext'"
description: "Die Design-Time-Tools von EF Core konnten Ihren DbContext nicht instanziieren. Stellen Sie einen Host über WebApplication.CreateBuilder bereit, verweisen Sie auf das richtige Startprojekt oder implementieren Sie IDesignTimeDbContextFactory."
pubDate: 2026-05-11
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
lang: "de"
translationOf: "2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext"
translatedBy: "claude"
translationDate: 2026-05-11
---

Die Lösung: `dotnet ef` führt Ihre Anwendung zur Design-Zeit aus, um den `DbContext` zu finden. Es scheiterte, weil der Einstiegspunkt keinen Host zurückgab, den das Tool prüfen konnte, oder Ihr `DbContext` Konstruktorparameter hat, die ohne einen solchen nicht aufgelöst werden können. Stellen Sie in einer Webanwendung sicher, dass `Program.cs` einen `WebApplication` kompiliert und verwendet (oder zurückgibt). In einer Klassenbibliothek oder einem Testprojekt fügen Sie eine `IDesignTimeDbContextFactory<TContext>`-Implementierung hinzu. Führen Sie dann erneut mit `--startup-project` aus, das auf das Host-Projekt verweist, nicht auf das Datenprojekt.

```text
Unable to create an object of type 'AppDbContext'. For the different patterns supported at design time, see https://go.microsoft.com/fwlink/?linkid=851728
```

Diese Anleitung ist gegen `Microsoft.EntityFrameworkCore.Design` 11.0.0-preview.4, `dotnet-ef` 11.0.0-preview.4 und das .NET 11 SDK preview 4 geschrieben. Dasselbe Verhalten gilt bis zurück zu EF Core 3.1: Die Regeln zur Design-Time-Erkennung haben sich seit der Einführung des Generic Host nicht in der Form geändert. Wenn Sie noch EF Core 6 oder 8 verwenden, funktionieren alle untenstehenden Lösungen, nur die Namespaces unterscheiden sich leicht.

## Wie die Design-Time-Tools Ihren DbContext finden

Wenn Sie `dotnet ef migrations add Init` ausführen, scannt das Tool Ihren Code nicht statisch. Es kompiliert Ihr Projekt, lädt das resultierende Assembly und sucht nach einer von vier Sachen, in dieser Reihenfolge:

1. Eine Implementierung von `IDesignTimeDbContextFactory<TContext>` im Startprojekt.
2. Ein Host, der aus `Program.Main` zurückgegeben oder über das implizite `WebApplication`-Builder-Muster bereitgestellt wird. Das Tool ruft darauf `IHost.Services.GetRequiredService<TContext>()` auf.
3. Ein `DbContext` mit einem öffentlichen parameterlosen Konstruktor. Das Tool ruft direkt `new TContext()` auf.
4. Ein `DbContext` mit `OnConfiguring`, das nicht von eingefügten Services abhängt.

Wenn keines davon eine Instanz erzeugt, erhalten Sie den Fehler `Unable to create an object of type 'X'`. Der Hyperlink in der Nachricht zeigt auf die Design-Time-Dokumentation, die dieselben vier Pfade auflistet.

## Warum das in einer typischen Webanwendung passiert

Die meisten Projekte scheitern an Pfad 2. Das Tool kann Ihre `Program.cs` aufrufen, findet aber keinen Host zum Prüfen. Drei Dinge brechen Pfad 2 in 2026 häufig:

1. `Program.cs` baut den `WebApplication`, beendet sich aber, bevor das Tool `Services` lesen kann, wegen der Reihenfolge der Top-Level-Statements.
2. Der `DbContext` ist in einem anderen Assembly registriert als dem, das als `--startup-project` übergeben wurde. Das Tool hat das falsche Projekt ausgeführt.
3. Der `DbContext`-Konstruktor nimmt einen benutzerdefinierten Typ (einen Tenant-Resolver, eine Uhr, einen Feature-Flag-Service), den der DI-Container ohne tatsächliche Ausführung von `app.Run()` nicht auflösen kann.

Der erste ist der stille Killer. Mit Top-Level-Statements synthetisiert der Compiler ein `Program.Main`, dessen Rückgabetyp und letzte Anweisung für EF Core relevant sind. Wenn `app.Run()` der letzte Ausdruck ist, liest das Tool den Host per Reflektion über die synthetische `Program`-Klasse. Wenn Sie den Run-Aufruf in eine Bedingung gewickelt haben oder vorzeitig `return` ausführen, erreicht der Host das Tool nie.

## Eine minimale Reproduktion

Das ist das kleinste Projekt, das den Fehler erzeugt. Ein `WebApi`-Projekt, ein `DbContext` mit einer eingefügten Abhängigkeit, keine Design-Time-Factory.

```csharp
// AppDbContext.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

public sealed class AppDbContext : DbContext
{
    private readonly ITenantResolver _tenant;

    public AppDbContext(DbContextOptions<AppDbContext> options, ITenantResolver tenant)
        : base(options)
    {
        _tenant = tenant;
    }

    public DbSet<Order> Orders => Set<Order>();
}

public interface ITenantResolver { string Current { get; } }
public sealed class Order { public int Id { get; set; } public string TenantId { get; set; } = ""; }
```

```csharp
// Program.cs - .NET 11
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

if (args.Contains("--migrate-only"))
{
    return; // <-- design-time tool reads this path, never reaches app.Run()
}

app.Run();
```

`dotnet ef migrations add Init` gegen dieses Projekt auszuführen, gibt den Fehler aus. Die Registrierung von `ITenantResolver` findet erst nach `builder.Build()` statt, aber das frühe `return` schneidet das synthetisierte `Main` ab und die Host-Prüfung von EF Core sieht einen teilweise initialisierten Zustand. Der Erkennungscode versucht auch `new AppDbContext()`, was scheitert, weil der Konstruktor zwei Argumente benötigt.

## Lösung 1 - Lassen Sie den Host auffindbar sein (empfohlen für Webanwendungen)

Die sauberste Lösung ist, `Program.cs` den Host ohne bedingte frühe Returns vollständig initialisieren zu lassen. Die Design-Time-Host-Factory von EF Core verwendet `HostFactoryResolver`, um das kompilierte `Program.Main` zu durchlaufen und die `IHost`-Referenz zu holen. Alles, was diesen Durchlauf verhindert, hindert auch EF Core daran, den Kontext zu finden.

```csharp
// Program.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

app.MapGet("/", () => "ok");

app.Run();
```

Diese eine Änderung reicht meistens. Bestätigen Sie es mit der Flag `--verbose`:

```bash
dotnet ef migrations add Init --verbose
```

Sie sollten Zeilen wie `Finding design-time services...`, `Using application service provider from Microsoft.Extensions.Hosting.IHostBuilder.` und `Using DbContext factory 'AppDbContext'.` sehen. Wenn `--verbose` `No host builder was found` meldet, ist Pfad 2 weiterhin defekt und Sie benötigen Lösung 2 oder Lösung 3.

Wenn Sie tatsächlich einen `--migrate-only`-Switch benötigen (einen Konsolen-Runner, der in Produktion vor `app.Run()` beendet), platzieren Sie ihn nach dem Bau des Hosts, aber **geben Sie den Host zurück** statt void, damit das synthetisierte `Main` weiterhin mit der Host-Referenz endet:

```csharp
// Program.cs - .NET 11
var app = builder.Build();
app.MapGet("/", () => "ok");

if (args.Contains("--migrate-only"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}

app.Run();
```

Das Design-Time-Tool sieht weiterhin `app.Run()` als terminale Anweisung und kann `app.Services` prüfen, bevor es sie aufruft.

## Lösung 2 - Verweisen Sie auf das richtige Startprojekt

Eine Solution mit einem `Web`-Projekt, das eine `Data`-Klassenbibliothek referenziert, ist die zweithäufigste Ursache. Leute führen `dotnet ef migrations add Init` aus dem Inneren von `Data/` aus, wo der `DbContext` liegt, in der Erwartung, dass das Tool den in `Web` registrierten Host verwendet. Das tut es nicht. Das Tool kompiliert das **aktuelle** Projekt (oder das, was `--project` angibt) und sucht einen Host innerhalb **dieses** Assemblys.

```bash
# Run from the solution root, EF Core 11.0.0-preview.4 / .NET 11
dotnet ef migrations add Init \
  --project src/Data/Data.csproj \
  --startup-project src/Web/Web.csproj
```

`--project` ist, wohin die Migrationsdateien geschrieben werden. `--startup-project` ist, wo der Host lebt. Beide Flags sind erforderlich, wenn sie nicht dasselbe Projekt sind. Viele Teams legen dafür einen Alias in `Directory.Build.props` oder einem `Makefile` an, damit der lange Aufruf nie getippt werden muss.

Sie können prüfen, welches Assembly das Tool tatsächlich geladen hat, mit `dotnet ef dbcontext info --startup-project src/Web/Web.csproj`. Es gibt den aufgelösten Typnamen, den Provider und die Quelle der Verbindungszeichenfolge aus. Wenn `info` funktioniert, aber `migrations add` scheitert, haben Sie ein Konstruktorproblem, kein Erkennungsproblem -- springen Sie zu Lösung 3.

## Lösung 3 - Implementieren Sie IDesignTimeDbContextFactory

Für Klassenbibliotheken ohne Host (das typische Layout für eine paketierte Datenschicht, ein Testprojekt oder ein gemeinsam genutztes gehostetes Blazor-WebAssembly-Projekt) gibt es kein `Program.Main` zum Prüfen. Fügen Sie im selben Projekt wie der `DbContext` eine Factory hinzu:

```csharp
// DesignTimeDbContextFactory.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\MSSQLLocalDB;Database=design-time;Trusted_Connection=True;TrustServerCertificate=True")
            .Options;

        return new AppDbContext(options, new DesignTimeTenantResolver());
    }

    private sealed class DesignTimeTenantResolver : ITenantResolver
    {
        public string Current => "design-time";
    }
}
```

Die Erkennung von EF Core prüft auf `IDesignTimeDbContextFactory<TContext>` **bevor** sie den Host durchläuft, daher überschreibt diese Implementierung auch alles andere. Das macht sie zur zuverlässigsten Lösung, hat aber einen Preis: Die Verbindungszeichenfolge wird dupliziert. Lesen Sie sie aus `appsettings.json`, wenn Sie das vermeiden möchten:

```csharp
// EF Core 11.0.0-preview.4 - read connection string from config
public AppDbContext CreateDbContext(string[] args)
{
    var config = new ConfigurationBuilder()
        .SetBasePath(Directory.GetCurrentDirectory())
        .AddJsonFile("appsettings.json", optional: false)
        .AddJsonFile($"appsettings.{Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "Development"}.json", optional: true)
        .AddEnvironmentVariables()
        .Build();

    var options = new DbContextOptionsBuilder<AppDbContext>()
        .UseSqlServer(config.GetConnectionString("Default"))
        .Options;

    return new AppDbContext(options, new DesignTimeTenantResolver());
}
```

Eine Erinnerung zur Dateikopie: `appsettings.json` muss im Projekt, das das Tool ausführt, auf `Copy if newer` gesetzt sein, sonst enthält das Arbeitsverzeichnis sie nicht. Wenn Sie den Erkennungsfehler hinter sich lassen und stattdessen auf einer `null`-Verbindungszeichenfolge landen, ist das dieselbe Falle, die im kanonischen Artikel zu [dem Fehler No connection string named DefaultConnection](/de/2026/05/fix-no-connection-string-named-defaultconnection/) behandelt wird.

## Lösung 4 - Die args-Vertragsfalle

Wenn Sie bereits eine Design-Time-Factory haben und in der CI weiterhin den Fehler sehen, prüfen Sie den `args`-Parameter. Das EF-Core-Tool übergibt seine eigene Argumentliste an `CreateDbContext(string[] args)`. Code, der diese mit den `args` der Anwendung verwechselt und unbekannte Flags ablehnt, wirft eine Exception, bevor der Kontext zurückgegeben wird. Das Tool meldet diesen Wurf dann als Erkennungsfehler:

```csharp
// Wrong - throws on EF Core's own args
public AppDbContext CreateDbContext(string[] args)
{
    if (args.Length != 2) throw new ArgumentException("expected env and db");
    ...
}
```

Entfernen Sie entweder die Validierung oder akzeptieren Sie, dass die Design-Time-`args` opak sind und stützen Sie sich stattdessen auf `Environment.GetEnvironmentVariable`.

## Fehler, die wie dieser aussehen, es aber nicht sind

- **`Could not load file or assembly 'Microsoft.EntityFrameworkCore.Design'`**. Sie haben vergessen, das Paket `Microsoft.EntityFrameworkCore.Design` zum Startprojekt hinzuzufügen. Es muss dort referenziert sein, auch wenn der `DbContext` woanders liegt, weil das Tool es aus dem bin-Ordner des Start-Assemblys lädt.
- **`No project was found`**. Sie haben `dotnet ef` aus einem Ordner ohne `.csproj` ausgeführt. Führen Sie es aus dem Projekt-Root aus oder übergeben Sie `--project`.
- **`The command 'dotnet-ef' could not be found`**. Das lokale Tool-Manifest fehlt. Führen Sie `dotnet new tool-manifest` und `dotnet tool install dotnet-ef --version 11.0.0-preview.4` aus. Das Pinnen der Version ist wichtig: Ein global vor Jahren installiertes `dotnet-ef` wird mit der Laufzeit stillschweigend nicht zusammenpassen.
- **`Cannot consume scoped service from singleton`**. Die Erkennung hat funktioniert, aber die DI-Registrierung ist falsch. Das ist ein anderer Fehler und die [Scoped vs Singleton Lifetime-Lösung](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) behandelt ihn.
- **`A second operation was started on this context instance`**. Ebenfalls ein anderer Fehler, aber EF-Core-Nutzer finden ihn über dasselbe Such-Kaninchenloch. Der [Artikel zur DbContext-Nebenläufigkeit](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/) führt Schritt für Schritt durch.

## Eine Debugging-Checkliste, wenn keine der Lösungen greift

Wenn Sie alle vier ausprobiert haben und das Tool Ihren Kontext immer noch nicht findet, gehen Sie diese Checkliste der Reihe nach durch. Es ist dieselbe Liste, die das Triage-Label "design-time" des EF-Core-Teams auf GitHub empfiehlt.

1. `dotnet build` ist ohne Warnungen über fehlende Assemblies erfolgreich. Das Tool läuft gegen Ihr Build-Output, ein grüner Build ist Voraussetzung.
2. `dotnet ef dbcontext list --startup-project src/Web/Web.csproj` gibt Ihren Kontextnamen aus. Wenn auch das scheitert, hat das Assembly nie einen Kontext geladen. Wahrscheinlich fehlt `AddDbContext`.
3. `dotnet ef dbcontext info` gibt den Provider und die Verbindungszeichenfolge aus. Wenn das funktioniert, aber `migrations add` scheitert, wirft Ihr `DbContext`-Konstruktor bei tatsächlichem Aufruf. Fügen Sie Protokollierung hinzu.
4. Das `TargetFramework` des Startprojekts passt zur Laufzeit des `dotnet-ef`-Tools. Die EF-Core-11-Tools zielen auf .NET 11. Sie können ein Projekt, das nur `netstandard2.0` anvisiert, nicht prüfen.
5. Das Startprojekt hat sowohl `Microsoft.EntityFrameworkCore.Design` als auch das Provider-Paket (`Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.EntityFrameworkCore.PostgreSQL` usw.) referenziert.
6. `Program.cs` ist der Einstiegspunkt. Wenn Sie mehrere `Main`-Methoden haben oder `OutputType`-Einstellungen verwenden, die ihn verstecken, scheitert die Erkennung.

Sobald `dotnet ef dbcontext info` durchgängig funktioniert, funktionieren alle anderen Befehle. Das ist der beste Smoke-Test und schneller als eine echte Migration auszuführen.

## Verwandt

- Der [Single-Step-Migrations-Workflow in EF Core 11](/de/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) behandelt `dotnet ef migrations update --add`, den neuen kombinierten Befehl für Routine-Schema-Updates.
- Für DI-Scope-Fehler zur Laufzeit siehe [die Scoped-Service-aus-Singleton-Lösung](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- Wenn `GetConnectionString` zur Design-Zeit null zurückgibt, siehe [den Artikel zur fehlenden Verbindungszeichenfolge](/de/2026/05/fix-no-connection-string-named-defaultconnection/).
- Um die Datenschicht zu testen, ohne die Design-Time-Erkennung zu berühren, hält [Integrationstests mit Testcontainers](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) das Testprojekt unabhängig von der Migrations-Toolchain.
- Um die Modellerstellung vor der ersten Anfrage aufzuwärmen, behandelt [Aufwärmen des EF-Core-Modells](/de/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) das verwandte Cold-Path-Problem.

## Quellen

- [Design-time DbContext Creation - EF Core docs](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation)
- [EF Core Tools Reference - dotnet ef](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [HostFactoryResolver source on dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting/src/Internal/HostFactoryResolver.cs)
- [EF Core issue 21025: design-time discovery on top-level statements](https://github.com/dotnet/efcore/issues/21025)
- [WebApplication and the generic host - ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis)
