---
title: "Migration von .NET Framework 4.8 zu .NET 11 im Jahr 2026"
description: "Ein versionsgenaues Migrations-Playbook für die Umstellung einer .NET Framework 4.8-Codebasis auf .NET 11 LTS im Jahr 2026, einschließlich der Umstellung auf das SDK-Style csproj, System.Web zu ASP.NET Core, WCF, EF6 zu EF Core 11, BinaryFormatter-Entfernung, AppDomain-Ersatz und einem realistischen Rollback-Plan."
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
lang: "de"
translationOf: "2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026"
translatedBy: "claude"
translationDate: 2026-05-28
---

Die Umstellung einer .NET Framework 4.8-Codebasis auf .NET 11 ist kein bloßer Versionssprung. Es handelt sich um eine Re-Platforming-Übung, die das Projektformat, den Web-Stack, die Datenzugriffsschicht, das Hosting-Modell und einen langen Schwanz von APIs berührt, die zwischen 2017 und 2026 still und leise verschwunden sind. Das offizielle Servicing-Fenster für .NET Framework 4.8 ist 2026 noch offen, aber die Laufzeit hat seit 2019 kein Funktions-Update mehr erhalten, jeder moderne Azure App Service-Plan läuft standardmäßig auf dem Core-Stack, und nahezu jedes NuGet-Paket, von dem man abhängen sollte, hat seine `net48`-Targets fallen gelassen. Der realistische Aufwand für eine typische Line-of-Business-Anwendung beträgt zwei bis sechs Wochen für einen kleinen Dienst, zwei bis vier Monate für eine mittelgroße Codebasis mit WCF, EF6 und einem WebForms- oder MVC 5-Frontend. WebForms-Anwendungen bleiben, wo sie sind, oder werden neu geschrieben; es gibt keinen In-Place-Port. Dieser Beitrag legt `net48` als Quelle und `net11.0` als Ziel fest und geht davon aus, dass das Projekt unter Windows läuft.

## Warum jetzt migrieren

- .NET Framework 4.8 befindet sich seit dem 4.8.1 Release im August 2022 im reinen Wartungsmodus. Keine neuen APIs, keine neuen C#-Sprachfunktionen. Die .NET 11-Laufzeit liefert dynamisches PGO standardmäßig aktiviert, den modernisierten Tiered JIT und Native AOT für ASP.NET Core Minimal APIs.
- Jedes neue Microsoft-Framework (Aspire, Microsoft Agent Framework, Semantic Kernel 1.x, Azure Functions isolated worker) zielt auf `net8.0` oder neuer ab und wird nicht zurückportiert. Auf 4.8 zu bleiben bedeutet, dass keines davon aus Ihrem eigenen Prozess heraus erreichbar ist.
- Cloud-Kosten. Der Laufzeit-Speicherverbrauch von .NET 11 für eine im Leerlauf befindliche ASP.NET Core Minimal API liegt bei vergleichbarer Last bei etwa 35 bis 50 Prozent eines ASP.NET 4.8 Worker-Prozesses, was sich direkt in kleinere App Service-Pläne oder höhere Pod-Dichte in Kubernetes übersetzt.
- Recruiting und Tooling. Roslyn-Analyzer, Source Generators und die moderne `dotnet` CLI setzen ein SDK-Style-Projekt voraus. Die C#-Sprachversion ist auf `net48` auf C# 7.3 begrenzt, sofern Sie nicht gegen den Compiler ankämpfen, womit ein Jahrzehnt an Sprachfunktionen vom Tisch ist.

Wenn die Codebasis eine Windows-Desktop-Anwendung (WinForms oder WPF) ist, die nur unter Windows läuft und nirgendwo anders bereitgestellt werden soll, ist die Frage berechtigt. Die Antwort lautet trotzdem meistens ja, denn die unterstützte Lebensdauer von net48 endet mit dem erweiterten Support-Fenster von Windows 10, und die Tooling-Unterstützung ist bereits dünn.

## Was bricht

| Bereich                       | Änderung                                                                                              | Schweregrad |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ----------- |
| Projektformat                 | `packages.config` und das alte csproj-XML werden vom .NET 11 SDK nicht unterstützt                     | hoch        |
| `System.Web`                  | Vollständig entfernt. `HttpContext.Current`, Module, Handler, WebForms haben kein .NET 11-Äquivalent    | hoch        |
| WCF-Server                    | `System.ServiceModel` auf der Serverseite wird nicht unterstützt. Verwenden Sie CoreWCF oder schreiben Sie auf gRPC oder HTTP um | hoch        |
| WCF-Client                    | Unterstützt über `System.ServiceModel.*` 6.x NuGet-Pakete, mit eingeschränkten Bindings                | mittel      |
| Entity Framework 6            | Läuft auf .NET 11 mit EF6 6.5.0 oder neuer, neue Entwicklung sollte aber EF Core 11 verwenden          | mittel      |
| `AppDomain`                   | Nur die Standard-`AppDomain` existiert. Kein `CreateDomain`, keine entladbaren Plugin-Container        | hoch        |
| `BinaryFormatter`             | In .NET 9 entfernt, kein Opt-in-Schalter                                                              | hoch        |
| .NET Remoting                 | Weg. Kein Ersatz; schreiben Sie auf ein Netzwerkprotokoll um, das Sie tatsächlich wollen              | hoch        |
| Code Access Security          | Weg. `[SecurityCritical]`, `PermissionSet`, Sandboxing alles entfernt                                 | hoch        |
| `web.config`                  | Konfiguration wandert nach `appsettings.json`. `system.web`-Abschnitte gelten nicht mehr              | hoch        |
| `app.config`                  | Die meisten Einstellungen funktionieren weiterhin über `Microsoft.Extensions.Configuration.Xml`, aber Binding Redirects sind weg | mittel      |
| WPF und WinForms              | Unterstützt auf .NET 11, nur Windows. Die meisten Drittanbieter-Controls benötigen einen 6.x- oder neueren Build | mittel      |
| `System.Drawing.Common`       | Plattformübergreifende Unterstützung in .NET 6 entfernt. Seither nur Windows                          | mittel      |

Lesen Sie die [.NET Framework to .NET porting overview](https://learn.microsoft.com/en-us/dotnet/core/porting/) und die [.NET 11 breaking changes list](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0) einmal, bevor Sie eine `.csproj` anrühren. Die erste Liste ist mit Abstand die längere der beiden.

## Pre-Flight-Checkliste

Führen Sie diese Schritte aus, bevor Sie eine einzige Projektdatei ändern.

1. Installieren Sie das .NET 11 SDK auf jedem Entwicklerrechner und CI-Runner. Verifizieren Sie mit `dotnet --list-sdks` und stellen Sie sicher, dass `11.0.x` erscheint. Lassen Sie das .NET Framework 4.8 Developer Pack installiert, damit sich die alte Solution weiterhin in Visual Studio öffnen lässt.
2. Installieren Sie die .NET Upgrade Assistant CLI und führen Sie sie zuerst im Analyse-Modus aus. Sie migriert keinen Code; sie erzeugt einen handlungsorientierten Bericht.
   ```bash
   # .NET 11, upgrade-assistant 0.6.x
   dotnet tool install --global upgrade-assistant
   upgrade-assistant analyze MySolution.sln
   ```
3. Führen Sie den .NET Portability Analyzer oder `apiport` gegen die kompilierten Assemblies aus. Alles, was als "not portable" markiert ist, ist Migrationsarbeit, die das upgrade-assistant-Tool nicht für Sie erledigen wird.
4. Erfassen Sie eine Baseline. Führen Sie die bestehende Test-Suite auf .NET Framework 4.8 aus und speichern Sie das Ergebnis. Ein sauberes Grün auf der alten Laufzeit bedeutet, dass das erste Rot auf .NET 11 eindeutig eine Migrationsregression ist.
5. Inventarisieren Sie die NuGet-Pakete von Drittanbietern. Alles, was nur `net48`- oder `net472`-Assemblies ausliefert, ist ein Blocker. Ersatz: `log4net` 2.0.16, `Newtonsoft.Json` 13.x, `AutoMapper` 13.x, `Dapper` 2.1.x sind alle Multi-Target und funktionieren auf .NET 11. Alles andere benötigt ein Upgrade-Ticket beim Hersteller.
6. Zweigen Sie die Migration ab. Planen Sie mindestens einen PR pro Projekt und einen separaten PR für die Testprojekte ein. Ein einzelner Mega-PR für eine mittelgroße Codebasis ist nicht reviewbar.

## Migrationsschritte

1. **Konvertieren Sie jede `.csproj` in SDK-Style.** Ersetzen Sie das alte XML durch den SDK-Style-Header. Das neue Format leitet Dateien ab, lässt die meisten Assembly-Referenzen weg und verwendet `PackageReference` statt `packages.config`. Das `try-convert`-Tool (im .NET Upgrade Assistant gebündelt) übernimmt den mechanischen Teil.

   ```xml
   <!-- src/MyApi.csproj, .NET 11, after conversion -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
       <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     </ItemGroup>
   </Project>
   ```

   Verifizierung: `dotnet build` beendet sich mit Fehlern, die entfernte APIs benennen, anstatt mit Parser-Fehlern gegen die Projektdatei selbst. Löschen Sie `packages.config`, nachdem die Konvertierung erfolgreich war.

2. **Entfernen Sie die Nutzung von `BinaryFormatter` überall.** Der Typ wurde in .NET 9 ohne Kompatibilitätsschalter entfernt. Ersetzen Sie ihn durch `System.Text.Json`, MessagePack oder `protobuf-net`, je nachdem, ob Sie ein JSON- oder ein binäres Wire-Format benötigen. Wenn Sie gespeicherte Blobs haben, die mit `BinaryFormatter` serialisiert wurden, schreiben Sie ein einmaliges Konvertierungs-Utility, das noch auf .NET Framework 4.8 läuft, um sie in das neue Format zu übersetzen, bevor Sie die alte Umgebung außer Betrieb nehmen. Diese Konvertierung von .NET 11 aus durchzuführen ist nicht möglich.

   Verifizierung: `grep -r "BinaryFormatter" src/` ist leer. Jeder Blob-Speicher, der zuvor binär formatierte Payloads enthielt, wurde neu serialisiert, und das neue Format wird über einen Unit-Test round-tripped.

3. **Schreiben Sie den Web-Stack von `System.Web` auf ASP.NET Core 11 um.** Dies ist die größte Einzelarbeit. MVC 5 Controller mappen sich nahezu eins zu eins auf ASP.NET Core Controller, aber Routing-Attribute, Model Binding, Action Filter und Dependency Injection unterscheiden sich alle. `HttpContext.Current` ist weg; Controller und Middleware erhalten `HttpContext` explizit. `Application_Start` in `Global.asax` wird zu Startup-Code in `Program.cs`. WebAPI 2 Controller sind ASP.NET Core Controllern sehr ähnlich, erben aber von `ControllerBase` statt von `ApiController`.

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddControllers();
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.UseAuthentication();
   app.UseAuthorization();
   app.MapControllers();
   app.MapOpenApi();
   app.Run();
   ```

   WebForms (`.aspx`) hat keinen Migrationspfad. Lassen Sie die WebForms-Anwendung entweder für den Rest ihres Lebens hinter einem Reverse Proxy auf .NET Framework 4.8 laufen, oder schreiben Sie die betroffenen Seiten als Blazor, MVC oder Razor Pages neu. Der Vergleich [Blazor Server vs Blazor WebAssembly vs Blazor United](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) ist der richtige Ausgangspunkt, falls Blazor zur Debatte steht.

   Verifizierung: Jeder Controller hat mindestens einen Integrationstest, der eine HTTP-Route gegen `WebApplicationFactory<Program>` ausübt und sowohl Statuscode als auch Response-Body assertiert.

4. **Verschieben Sie `web.config` nach `appsettings.json`.** Connection Strings, eigene appSettings und Logging-Konfiguration wandern nach JSON. `system.web`-Abschnitte gelten nicht mehr. `system.webServer`-Abschnitte, die IIS konfigurieren, gelten weiterhin, wenn Sie hinter IIS über das In-Process-Modul hosten, aber die meisten Produktivbereitstellungen verwenden heute Kestrel direkt. Authentifizierungseinstellungen wandern von den `<authentication>`- und `<authorization>`-web.config-Abschnitten zu `builder.Services.AddAuthentication(...)` und der Authorization-Policy-API.

   ```json
   // appsettings.json, .NET 11
   {
     "ConnectionStrings": {
       "Default": "Server=.;Database=App;Trusted_Connection=True;TrustServerCertificate=True;"
     },
     "Logging": {
       "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" }
     }
   }
   ```

   Verifizierung: Die Anwendung liest jeden zuvor konfigurationsgesteuerten Wert über `IConfiguration` oder das stark typisierte `IOptions<T>`-Muster; keine Aufrufe von `ConfigurationManager.AppSettings` überleben im Produktivcode.

5. **Bewältigen Sie WCF.** Serverseitiges WCF wird auf .NET 11 nicht unterstützt. Zwei realistische Wege:
   - **CoreWCF** (der von der Community gepflegte Port). Fügen Sie `CoreWCF.Primitives`, `CoreWCF.Http` und die Bindings hinzu, die Sie tatsächlich verwenden. Die meisten `BasicHttpBinding`- und `NetTcpBinding`-Dienste migrieren mit einer Contract-Referenz und einem `UseServiceModel`-Konfigurationsaufruf. Streaming, Transaktionen und Sicherheit auf Nachrichtenebene haben unterschiedliche Unterstützungsgrade; prüfen Sie die [CoreWCF compatibility matrix](https://github.com/CoreWCF/CoreWCF), bevor Sie sich festlegen.
   - **Umschreiben auf gRPC oder eine HTTP-API.** Höhere Decke, mehr Arbeit. Die richtige Wahl, wenn die WCF-Schnittstelle ohnehin nur von Clients konsumiert wurde, die Sie selbst kontrollieren.

   Clientseitiges WCF wird über die `System.ServiceModel.*` 6.x NuGet-Pakete unterstützt mit `BasicHttpBinding`, `NetTcpBinding` (eingeschränkt) und `WSHttpBinding` (nur Transport-Security). Wenn Ihr Client `WSFederationHttpBinding` oder Sicherheit auf Nachrichtenebene verwendet, werden Sie den Consumer umschreiben.

   Verifizierung: Jeder WCF-Endpunkt hat einen Contract-Test, der den .NET 11-Client entweder gegen den neuen CoreWCF-Host oder den umgeschriebenen Ersatz laufen lässt und dieselben Payloads wie der alte .NET Framework-Client assertiert.

6. **Verschieben Sie Entity Framework 6 nach EF Core 11 (wenn es sich lohnt).** EF6 läuft auf .NET 11 über das `EntityFramework` 6.5.0-Paket, ein striktes Lift-and-Shift ist also möglich. Aber EF6 erhält keine neuen Funktionen, die `DbContext`-API in EF Core liegt näher an dem, was Sie für die Dependency Injection in ASP.NET Core wollen, und die kompilierten Abfragen sowie die Übersetzung von Primitive Collections in EF Core 11 sind spürbar schneller. Für die meisten Teams ist die richtige Entscheidung, die Migration zuerst auf EF6 auszuliefern und dann in einem Folge-PR auf EF Core umzustellen. Der Beitrag [EF Core compiled queries vs raw SQL vs Dapper](/de/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) quantifiziert die Hot-Path-Gewinne.

   Verifizierung: Der gewählte ORM besteht dieselbe Integrationstest-Suite, die unter EF6 auf .NET Framework lief, einschließlich aller Tests, die das generierte SQL assertiert haben.

7. **Ersetzen Sie `AppDomain.CreateDomain`-Plugin-Loader.** `AppDomain` ist auf .NET 11 keine Isolationsgrenze mehr; nur die Standard-Domain existiert. Plugin-Systeme, die zuvor Assemblies in eine Kind-`AppDomain` für Unload-Semantik oder Fehler-Isolation geladen haben, müssen auf `AssemblyLoadContext` mit `isCollectible: true` umsteigen und `Unload()` aufrufen, wenn sie fertig sind. Out-of-Process-Plugins über `dotnet`-Worker-Prozesse sind das sicherere Muster, wenn das Plugin nicht vertrauenswürdig ist.

   Verifizierung: Ein Unit-Test lädt eine Plugin-Assembly, ruft hinein, entlädt den `AssemblyLoadContext` und assertiert, dass eine `WeakReference` auf den Kontext nach einem `GC.Collect()`-Zyklus `null` wird.

8. **Auditieren Sie die C#-Sprachversionssprünge.** Von C# 7.3 auf C# 14 sind zwölf Sprach-Releases in einem Schritt. Das meiste davon ist additiv und sicher, aber nullbare Referenztypen (eingeführt in C# 8) werden Tausende von Warnungen auf Legacy-Code hervorrufen, wenn Sie `<Nullable>enable</Nullable>` global einschalten. Der realistische Pfad ist zuerst `<Nullable>annotations</Nullable>` (nur Annotationen, keine Diagnostik), dann Datei für Datei Konvertierung mittels `#nullable enable`-Pragmas. Die Änderung an der Overload-Resolution in C# 14 rund um Span-Overloads ist im Fix-Beitrag [C# 14 overload resolution breaking change with spans](/de/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) dokumentiert.

   Verifizierung: `dotnet build -warnaserror` ist sauber für den vereinbarten Nullable-Scope vor dem Merge.

9. **Aktualisieren Sie die CI-Runner-Images.** Heben Sie in GitHub Actions `actions/setup-dotnet` auf `dotnet-version: 11.0.x` an, aktualisieren Sie jedes Dockerfile-Base-Image auf `mcr.microsoft.com/dotnet/sdk:11.0` und `mcr.microsoft.com/dotnet/aspnet:11.0`, und entfernen Sie das alte .NET Framework MSBuild-Image. Falls ein Projekt weiterhin unter .NET Framework gebaut werden muss (zum Beispiel das einmalige `BinaryFormatter`-Konvertierungstool aus Schritt 2), behalten Sie einen einzelnen `windows-2022`-Runner mit installiertem .NET Framework 4.8 Developer Pack und schalten Sie ihn über einen Path-Filter scharf.

   Verifizierung: Ein Pipeline-Lauf auf einem Feature-Branch ist Ende-zu-Ende grün, einschließlich `dotnet publish`, Container-Image-Build und Smoke-Deploy in eine Staging-Umgebung.

## Verifizierung (Smoke-Checkliste)

Nach den obigen Schritten sollte die Anwendung jede Zeile dieser Liste bestehen, bevor der Migrations-PR mergt:

- `dotnet --list-sdks` zeigt `11.0.x`, und `dotnet --version` aus dem Repo-Root druckt `11.0.x`.
- `dotnet restore && dotnet build -c Release` beendet sich mit 0 und keinen Warnungen für den vereinbarten Nullable-Scope.
- `dotnet test -c Release` ist grün, und die Testanzahl entspricht der .NET Framework 4.8-Baseline (oder übertrifft sie).
- `dotnet publish -c Release` erzeugt ein Self-Contained-Artefakt, das auf einem sauberen Staging-Host ohne installiertes .NET Framework 4.8 Redistributable bootet.
- Jede HTTP-Route hat mindestens einen Integrationstest gegen `WebApplicationFactory<Program>`.
- Logs zeigen in Produktivcode-Pfaden keine First-Chance-Referenzen auf `BinaryFormatter`, `IWebHostBuilder`, `HttpContext.Current` oder `ConfigurationManager`.
- Ein Staging-Deploy bedient den Golden Path; p50/p95-Latenz liegt innerhalb von 20 Prozent der .NET Framework-Baseline auf vergleichbarer Hardware.

Wenn eines davon fehlschlägt, hören Sie auf. Eine partielle Migration auf .NET 11 ist schlimmer als ein sauberes .NET Framework 4.8-Deploy, weil sie auf beide Laufzeiten festlegt.

## Rollback

Die Migration ist nur so lange reversibel, wie das Datenbankschema und alle Wire-Formate unverändert geblieben sind. Der Tausch der Laufzeit selbst ist reversibel: Setzen Sie die `.csproj`-Änderungen zurück und installieren Sie das .NET Framework 4.8 Redistributable auf dem Host neu. Die Entscheidungen, die einen Rollback teuer machen, sind meist orthogonal:

- Eine neue EF Core 11-Migration wurde gegen die Produktivdatenbank ausgeführt. Setzen Sie zuerst das Schema zurück.
- JSON-Payloads wurden unter `System.Text.Json`-Defaults neu serialisiert, die sich von `Newtonsoft.Json` unterscheiden. Nachgelagerte Konsumenten, die per Pattern-Matching auf Feldreihenfolge oder Null-Handling reagieren, werden Drift sehen.
- Die Authentifizierung wurde von `FormsAuthentication`-Cookies auf die Data-Protection-Cookies von ASP.NET Core umgestellt. Bestehende Sessions sind in beiden Richtungen ungültig.

Der pragmatische Plan ist, das .NET Framework-Deploy für eine Woche nach Cutover in einem separaten Slot warm zu halten und den Cutover über ein Feature Flag am Load Balancer statt zur Deploy-Zeit zu schalten. Danach Fix-Forward.

## Stolpersteine, auf die wir gestoßen sind

- **`HttpClient` auf .NET 11 erzwingt TLS Server Name Indication strikt.** Aufrufe an interne Dienste, die ein Zertifikat ohne passenden SAN präsentieren, scheitern mit `AuthenticationException`. Entweder reparieren Sie das Zertifikat oder setzen Sie `SslOptions.RemoteCertificateValidationCallback` bewusst. Die Defaults von .NET Framework waren lockerer, und das hat die SAN-Lücke verdeckt.
- **`DateTime.Parse` auf .NET 11 ist strenger bei mehrdeutigen Formaten als .NET Framework 4.8.** Code, der `DateTime` ohne expliziten `IFormatProvider` durch einen String round-tripped hat, wird bei Eingaben, die er zuvor akzeptiert hat, plötzlich `FormatException` werfen. Übergeben Sie immer `CultureInfo.InvariantCulture` und ein bekanntes Format. Der Fix [JSON value could not be converted to System.DateTime fix](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) deckt die häufigste Variante ab, wenn das Datum über JSON ankommt.
- **`Microsoft.Data.SqlClient` ersetzt `System.Data.SqlClient` in jedem modernen Pfad.** EF Core 11 will `Microsoft.Data.SqlClient` 7.x oder neuer. Ein transitiver Pin auf das alte `System.Data.SqlClient` kompiliert zwar, scheitert aber zur Laufzeit bei der TLS 1.3-Aushandlung gegen neuere SQL Server-Boxen.
- **Konfigurationsbinding ist in JSON case-sensitive, in `app.config` case-insensitive.** Eine Eigenschaft namens `MaxRetries` in `appsettings.json` bindet nicht aus einem `maxretries`-Key. Dem .NET Framework `ConfigurationManager` war das egal.
- **`HostingEnvironment.MapPath` ist weg.** Ersetzen Sie es durch `IWebHostEnvironment.ContentRootPath` und `Path.Combine`. Die `~/`-Virtual-Path-Syntax wird in ASP.NET Core von nichts verstanden.
- **WCF-DataContract-Surrogates round-trippen nicht identisch durch CoreWCF.** Wenn Sie von `IDataContractSurrogate` abhängen, schreiben Sie einen Contract-Test, der das exakte Wire-Format vor und nach der Migration assertiert, nicht nur Objektgleichheit.

## Verwandt

- [Migrate from .NET 8 to .NET 11: the full checklist](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [System.Text.Json vs Newtonsoft.Json in 2026](/de/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)
- [EF Core 11 vs Dapper for bulk inserts: real benchmark](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## Quellen

- [.NET Framework to .NET porting overview](https://learn.microsoft.com/en-us/dotnet/core/porting/)
- [.NET 11 breaking changes](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [.NET Upgrade Assistant documentation](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)
- [CoreWCF project and compatibility matrix](https://github.com/CoreWCF/CoreWCF)
- [Migrate from ASP.NET to ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/migration/proper-to-2x/)
- [AssemblyLoadContext API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.loader.assemblyloadcontext)
