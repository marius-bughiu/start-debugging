---
title: "Von IWebHostBuilder zu WebApplication.CreateBuilder in .NET 11 migrieren"
description: "Eine schrittweise Migration vom alten Hosting-Modell mit Startup.cs und WebHostBuilder hin zum Minimal-Hosting-Modell mit WebApplication.CreateBuilder, inklusive der ASPDEPR008-Deprecation, der Middleware-Reihenfolge, IStartupFilter und wie Sie Ihre Tests funktionsfähig halten."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "minimal-hosting"
lang: "de"
translationOf: "2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder"
translatedBy: "claude"
translationDate: 2026-06-06
---

Wenn Ihre `Program.cs` weiterhin `Host.CreateDefaultBuilder(args).ConfigureWebHostDefaults(web => web.UseStartup<Startup>())` aufruft, verwenden Sie das veraltete Hosting-Modell, und der Compiler hat begonnen, Sie davor zu warnen. Seit .NET 10 sind `WebHost`, `WebHostBuilder` und `IWebHost` mit der Diagnose `ASPDEPR008` als obsolet markiert, und diese Deprecation setzt sich in .NET 11 fort. Der Ersatz ist das Minimal-Hosting-Modell rund um `WebApplication.CreateBuilder(args)`, das seit ASP.NET Core 6.0 in jeder Projektvorlage der Standard ist. Dieser Beitrag migriert eine `Startup`-basierte App mit `net11.0` als Ziel auf Minimal-Hosting und behandelt die Punkte, über die man tatsächlich stolpert: die Middleware-Reihenfolge, den fehlenden DI-Scope beim Start, `IStartupFilter` und das Funktionsfähig-Halten von `WebApplicationFactory`-Tests.

Für einen kleinen Service ist die Migration mechanisch (ein bis zwei Stunden) und für einen Monolithen mit eigener Middleware, `IStartupFilter`-Implementierungen und einer großen `ConfigureServices` ein halber Tag. Am Verhalten Ihrer Anwendung muss sich nichts ändern. Sie verschieben dieselben Registrierungen und dieselbe Middleware-Pipeline in eine flachere Datei. Der einzige echte semantische Unterschied ist der DI-Scope beim Start, der weiter unten behandelt wird.

## Warum jetzt migrieren

- `WebHost` / `WebHostBuilder` / `IWebHost` erzeugen seit .NET 10 die Build-Warnung `ASPDEPR008`. Wenn Sie mit `TreatWarningsAsErrors` kompilieren, lässt sich Ihr .NET-11-Upgrade nicht kompilieren, solange Sie nicht davon weggewechselt sind.
- In das Minimal-Hosting-Modell fließt die gesamte neue ASP.NET-Core-Entwicklung. Funktionen wie Native AOT für Minimal-APIs, der verschlankte `WebApplication.CreateSlimBuilder` und `CreateEmptyBuilder` existieren nur auf dem neuen Pfad.
- Zwei Bootstrap-Dateien verschmelzen zu einer. `Startup.cs` plus eine `CreateHostBuilder`-Verdrahtungsmethode wird zu einer einzigen, gut lesbaren `Program.cs`, und Konfiguration, Services sowie die Pipeline lesen sich von oben nach unten.
- Es entsperrt Minimal-APIs. Sie können `app.MapGet(...)` nicht sauber in einer Codebasis aufrufen, deren Pipeline in einer `Startup.Configure(IApplicationBuilder, IWebHostEnvironment)`-Signatur lebt.

## Was nicht mehr funktioniert

| Bereich                    | Änderung                                                                                     | Schweregrad |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| `WebHost` / `IWebHost`     | Obsolet seit .NET 10 (`ASPDEPR008`). Warnungen, oder Fehler unter `TreatWarningsAsErrors`     | hoch     |
| `Startup` via `builder.Host`| `WebApplicationBuilder.Host.ConfigureWebHostDefaults(...UseStartup<T>())` wirft zur Laufzeit  | hoch     |
| DI-Scope beim Start        | Kein Scope um den Service-Provider während des Starts; das Auflösen von Scoped-Services wirft jetzt    | mittel   |
| Middleware-Reihenfolge     | Der `Configure`-Body muss nach `builder.Build()` in derselben Reihenfolge neu ausgedrückt werden             | mittel   |
| `IStartupFilter`           | Läuft weiterhin, wird aber jetzt um die Minimal-Hosting-Pipeline herum ausgeführt; Reihenfolge prüfen       | niedrig      |
| `IHostingStartup`          | Wird weiterhin unterstützt, liest `WebApplicationBuilder` für einige Assemblys aber anders     | niedrig      |
| `IWebHostBuilder` (Interface)| Überlebt via `builder.WebHost` für enge Konfiguration (`UseKestrel`, `UseUrls`); nicht verschwunden        | niedrig      |

Beachten Sie die letzte Zeile. Das `IWebHostBuilder`-*Interface* wird nicht gelöscht. `WebApplicationBuilder` stellt es als `builder.WebHost` bereit, sodass Sie weiterhin `builder.WebHost.ConfigureKestrel(...)` aufrufen können. Was als veraltet gilt, ist der eigenständige `WebHost.CreateDefaultBuilder()`-Bootstrap und der `IWebHost`, den er erstellt. Das Migrationsziel ist `WebApplication.CreateBuilder`, nicht das Entfernen jedes Typs mit `WebHost` im Namen.

## Pre-Flight-Checkliste

1. Installieren Sie das .NET-11-SDK auf jeder Entwicklermaschine und jedem CI-Runner. Überprüfen Sie es mit `dotnet --list-sdks` und bestätigen Sie, dass `11.0.x` erscheint.
2. Bestätigen Sie, dass das Projekt bereits auf `net6.0` oder höher abzielt. Das Minimal-Hosting-Modell existiert vor .NET 6 nicht, sodass eine .NET-5-App oder älter zunächst einen Framework-Sprung benötigt. Siehe die [Checkliste von .NET 8 zu .NET 11](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), wenn Sie auch LTS-Versionen überqueren, oder den [Leitfaden von .NET Framework 4.8 zu .NET 11](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) für den größeren Sprung.
3. Inventarisieren Sie Ihre `Startup`-Klasse. Listen Sie jede Zeile in `ConfigureServices` und jeden Middleware-Aufruf in `Configure` der Reihe nach auf. Die Reihenfolge in `Configure` ist der Vertrag, den Sie erhalten müssen.
4. Suchen Sie per Grep nach `IStartupFilter`-Implementierungen und `IHostingStartup`-Assemblys. Diese laufen außerhalb von `Startup` und werden leicht vergessen.
5. Committen Sie eine saubere Baseline, damit Sie ein Rollback mit einem einzigen Befehl haben.

## Der Ausgangszustand: eine Startup-basierte App

Hier ist die Form, die fast jede App vor 6.0 teilt. Zwei Dateien, bei denen die Host-Verdrahtung von der Service- und Pipeline-Konfiguration getrennt ist.

```csharp
// Program.cs -- legacy generic host, ASP.NET Core 3.1 / 5.0 style
// Builds with ASPDEPR008 warnings on .NET 10/11 if WebHost APIs are used
public class Program
{
    public static void Main(string[] args) =>
        CreateHostBuilder(args).Build().Run();

    public static IHostBuilder CreateHostBuilder(string[] args) =>
        Host.CreateDefaultBuilder(args)
            .ConfigureWebHostDefaults(webBuilder =>
            {
                webBuilder.UseStartup<Startup>();
            });
}
```

```csharp
// Startup.cs -- legacy services + pipeline split
public class Startup
{
    public Startup(IConfiguration configuration) => Configuration = configuration;

    public IConfiguration Configuration { get; }

    public void ConfigureServices(IServiceCollection services)
    {
        services.AddControllers();
        services.AddDbContext<AppDbContext>(o =>
            o.UseSqlServer(Configuration.GetConnectionString("DefaultConnection")));
        services.AddScoped<IOrderService, OrderService>();
        services.AddSwaggerGen();
    }

    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
    {
        if (env.IsDevelopment())
        {
            app.UseDeveloperExceptionPage();
            app.UseSwagger();
            app.UseSwaggerUI();
        }

        app.UseHttpsRedirection();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseEndpoints(endpoints => endpoints.MapControllers());
    }
}
```

## Migrationsschritte

### 1. ConfigureServices in den Builder verschieben

Erstellen Sie den Builder und kopieren Sie dann jede Zeile aus `Startup.ConfigureServices` wortwörtlich, wobei Sie `services` durch `builder.Services` ersetzen. `IConfiguration` ist als `builder.Configuration` verfügbar, sodass die Suche nach der Connection-String unverändert übernommen wird.

```csharp
// Program.cs -- .NET 11, minimal hosting model
var builder = WebApplication.CreateBuilder(args);

// formerly Startup.ConfigureServices, services -> builder.Services
builder.Services.AddControllers();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddSwaggerGen();
```

Überprüfung: Führen Sie `dotnet build` aus. Das Projekt sollte mit den vorhandenen Service-Registrierungen kompilieren, bevor Sie die Pipeline anfassen. Wenn eine Registrierung `builder.Configuration` nicht auflösen kann, haben Sie eine Referenz auf das `Configuration`-Feld kopiert, das nicht mehr existiert; tauschen Sie sie gegen `builder.Configuration` aus.

### 2. Die App bauen und die Pipeline in derselben Reihenfolge neu ausdrücken

Rufen Sie `builder.Build()` auf und übersetzen Sie dann `Startup.Configure` Zeile für Zeile. `IApplicationBuilder app` wird zur `WebApplication app`, und `env.IsDevelopment()` wird zu `app.Environment.IsDevelopment()`. Die Middleware-Reihenfolge muss exakt der ursprünglichen entsprechen, denn die Reihenfolge ist die Pipeline.

```csharp
// .NET 11, minimal hosting model -- continued
var app = builder.Build();

// formerly Startup.Configure, same order
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

Zwei Dinge sind geschrumpft. `UseRouting` und `UseEndpoints` sind nicht mehr erforderlich: Der Minimal-Host fügt die Routing-Middleware automatisch hinzu, und `app.MapControllers()` ersetzt den `UseEndpoints(e => e.MapControllers())`-Block. Wenn Sie Middleware haben, die *zwischen* Routing und Endpunkt-Ausführung laufen muss (zum Beispiel eine eigene Middleware, die die Metadaten des gematchten Endpunkts liest), behalten Sie einen expliziten `app.UseRouting()`-Aufruf und platzieren diese Middleware danach. Andernfalls lassen Sie beide weg.

Überprüfung: `dotnet run`, dann rufen Sie eine bekannte Route auf. Ein 200 auf eine Controller-Action bestätigt, dass die Pipeline verdrahtet ist. Ein 404 auf jeder Route bedeutet in der Regel, dass `MapControllers` fehlt oder vor einer terminalen Middleware sitzt.

### 3. Startup.cs und die CreateHostBuilder-Verdrahtung löschen

Sobald `Program.cs` alles enthält, löschen Sie `Startup.cs` und die alte `CreateHostBuilder`-Methode. Versuchen Sie nicht, `Startup` durch den Aufruf von `builder.Host.ConfigureWebHostDefaults(web => web.UseStartup<Startup>())` am Leben zu halten. Das wirft zur Laufzeit: Minimal-Hosting verbietet die Konfiguration des Web-Hosts über `builder.Host` oder `builder.WebHost`, sobald Sie auf `WebApplicationBuilder` sind.

Wenn Sie `Startup` nicht in einem Durchgang löschen können (eine riesige `ConfigureServices`, die Sie schrittweise migrieren möchten), besteht das Bridge-Muster darin, sie manuell zu instanziieren, anstatt sie über den Host zu leiten:

```csharp
// .NET 11 -- temporary bridge, not the WebApplicationBuilder.Host path
var builder = WebApplication.CreateBuilder(args);
var startup = new Startup(builder.Configuration);
startup.ConfigureServices(builder.Services);

var app = builder.Build();
startup.Configure(app, app.Environment); // Configure must accept IApplicationBuilder
app.Run();
```

Das kompiliert, weil `WebApplication` `IApplicationBuilder` und `IEndpointRouteBuilder` implementiert. Behandeln Sie es als Gerüst für einen einzigen PR, nicht als Ziel.

Überprüfung: Durchsuchen Sie die Solution nach `UseStartup`, `WebHost.CreateDefaultBuilder` und `ConfigureWebHostDefaults`. Null Treffer bedeutet, dass der veraltete Bootstrap weg ist und `ASPDEPR008` nicht ausgelöst wird.

### 4. Host- und Kestrel-Konfiguration auf den Builder verschieben

Alles, was Sie auf dem alten `IWebHostBuilder` konfiguriert haben (Kestrel-Limits, URLs, Content-Root), wird auf `builder.WebHost` verschoben, der weiterhin die `IWebHostBuilder`-Oberfläche bereitstellt. Generic-Host-Belange (Logging, die Serilog-Integration, `UseWindowsService`) werden auf `builder.Host` verschoben.

```csharp
// .NET 11 -- host/web host configuration on the new builder
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 50 * 1024 * 1024);
builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));
```

Überprüfung: Bestätigen Sie, dass das konfigurierte Limit greift (ein Anfrage-Body über dem Limit gibt `413` zurück) und dass Ihre Logging-Senke weiterhin Einträge erhält.

## Verifizierung

Arbeiten Sie diese Checkliste nach der Migration ab, bevor Sie mergen:

- `dotnet build` erzeugt null `ASPDEPR008`-Warnungen und null `UseStartup`-Referenzen.
- `dotnet run` startet und bedient eine bekannte Route mit dem erwarteten Statuscode.
- `dotnet test` läuft durch, einschließlich aller `WebApplicationFactory`-Integrationstests (siehe die Stolperfalle unten).
- Middleware-abhängiges Verhalten funktioniert weiterhin durchgängig: Authentifizierungs-Challenges, HTTPS-Redirect, CORS-Preflight, Exception-Handler-Antworten.
- Ein Anfrage-Body über Ihrem Kestrel-Limit gibt weiterhin `413` zurück und bestätigt, dass die Host-Konfiguration migriert wurde.

## Rollback-Plan

Diese Migration ist umkehrbar, bis Sie `Startup.cs` löschen. Die sichere Reihenfolge ist, die Schritte 1 und 2 in einem Branch auszuführen, zu bestätigen, dass die Tests durchlaufen, und erst dann die veralteten Dateien in einem separaten Commit zu löschen. Wenn nach dem Löschen etwas regrediert, machen Sie den Lösch-Commit mit `git revert` rückgängig, um `Startup.cs` und die alte `Program.cs` wiederherzustellen. Da das `Startup`-Muster unter .NET 11 weiterhin läuft (es warnt nur, es wird nicht entfernt), hält Sie ein temporäres Revert lieferfähig, während Sie debuggen. Der Punkt ohne Wiederkehr ist das vollständige Entfernen des Generic-Host-Bootstraps; halten Sie das in einem eigenen Commit.

## Stolperfallen, in die wir geraten sind

**Der DI-Scope beim Start ist weg.** Der alte Generic Host erstellte einen DI-Scope, während er den Service-Provider baute, sodass Code, der während des Starts einen Scoped-Service auflöste, zufällig funktionierte. Minimal-Hosting tut das nicht. Wenn Sie einen `DbContext` in `Configure` aufgelöst haben, um einen Migrations- oder Seed-Schritt auszuführen, erhalten Sie jetzt `Cannot resolve scoped service '...' from root provider`. Umschließen Sie Start-Arbeit mit einem expliziten Scope:

```csharp
// .NET 11 -- explicit scope for startup-time scoped resolution
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}
app.Run();
```

Das ist der mit Abstand häufigste Laufzeitbruch bei der Migration. Die allgemeine Regel und ihre Varianten werden in [Scoped-Services aus einem Singleton auflösen](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) und in [Scoped-Services innerhalb eines BackgroundService verwenden](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) behandelt.

**`WebApplicationFactory<TStartup>` hat keinen `Startup` mehr, auf den es zeigen kann.** Integrationstests, die auf `WebApplicationFactory<Startup>` verwiesen, benötigen einen neuen Einstiegspunkt-Typ. Der Einstiegspunkt des Minimal-Hosts ist die automatisch generierte `Program`-Klasse, aber sie ist `internal`, sodass das Testprojekt sie nicht sehen kann. Machen Sie sie sichtbar, indem Sie am Ende von `Program.cs` eine partielle Deklaration hinzufügen:

```csharp
// Program.cs -- end of file, .NET 11
public partial class Program { }
```

Ändern Sie dann die Test-Factory auf `WebApplicationFactory<Program>`. Ohne die partielle Deklaration erhalten Sie `'Program' is inaccessible due to its protection level` im Testprojekt.

**`IStartupFilter` läuft weiterhin, aber die Reihenfolge verschiebt sich.** Filter, die über `services.AddTransient<IStartupFilter, MyFilter>()` registriert wurden, werden weiterhin ausgeführt und umschließen die konfigurierte Pipeline. Mit Minimal-Hosting gibt es keine explizite `Configure`-Methode, die sie umschließen können, sodass ein Filter, der davon ausging, vor Ihrer Routing-Einrichtung zu laufen, jetzt an einer etwas anderen Position laufen kann. Wenn Sie `IStartupFilter` ausschließlich verwendet haben, um Middleware aus einer Bibliothek einzuschleusen, prüfen Sie, wo diese Middleware relativ zu Ihren `app.Use...`-Aufrufen landet, und ordnen Sie um, falls sich eine Anfrage anders verhält.

**Middleware, die den gematchten Endpunkt liest, benötigt ein explizites `UseRouting`.** Das Weglassen von `UseRouting` ist für den häufigen Fall in Ordnung, aber wenn Sie Middleware haben, die `context.GetEndpoint()` aufruft, muss sie nach dem Routing sitzen. Fügen Sie `app.UseRouting()` vor dieser Middleware wieder hinzu und behalten Sie `app.MapControllers()` danach. Für einen tieferen Vergleich der beiden Endpunkt-Stile siehe [Minimal-APIs vs. Controller in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/).

**Reihenfolgeabhängige Registrierung benannter Optionen.** Eine Handvoll Teams verließ sich darauf, dass `ConfigureServices` vor dem `IHostingStartup` einer Bibliothek lief. Der Minimal-Host wertet `builder.Services` bei `builder.Build()` eifrig aus, sodass die Zeitsteuerung abweichen kann, wenn Sie einen Service nach dem Aufruf einer Bibliotheks-Erweiterung registriert haben, die die Collection erfasst hat. Das ist selten, aber wenn eine konfigurierte Option nach der Migration null zurückgibt, prüfen Sie, ob Sie sie nach dem verarbeitenden `Add...`-Aufruf registriert haben.

Sobald Sie auf `WebApplication.CreateBuilder` sind, öffnet sich der Rest der modernen Oberfläche: Minimal-API-Endpunkte neben Ihren Controllern, `CreateSlimBuilder` für Native AOT und die sauberere Ausnahmebehandlung, die in [einen globalen Exception-Handler in ASP.NET Core 11 hinzufügen](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) gezeigt wird. Die Hosting-Migration ist das Tor; alles andere ist von dort an inkrementell.

## Quellen

- [WebHostBuilder, IWebHost, and WebHost are obsolete](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/webhostbuilder-deprecated) (.NET Breaking Changes, Diagnose `ASPDEPR008`)
- [Migrate from ASP.NET Core in .NET 5 to .NET 6](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60) (der ursprüngliche Minimal-Hosting-Migrationsleitfaden)
- [Code samples migrated to the new minimal hosting model](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60-samples) (Vorher/Nachher-`Startup`-Beispiele)
- [Deprecating WebHostBuilder, IWebHost, and WebHost](https://github.com/dotnet/aspnetcore/discussions/63480) (dotnet/aspnetcore Diskussion #63480)
