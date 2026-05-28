---
title: "Von .NET 8 auf .NET 11 migrieren: die vollständige Checkliste"
description: "Eine versionsfixierte Migrations-Checkliste von .NET 8 LTS auf .NET 11 LTS, die SDK-Installation, csproj-Target-Framework, Breaking Changes in ASP.NET Core, EF Core, System.Text.Json und den Überladungsauflösungs-Wechsel in C# 14 abdeckt, inklusive Rollback-Hinweisen."
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
lang: "de"
translationOf: "2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist"
translatedBy: "claude"
translationDate: 2026-05-28
---

Zwei LTS-Zyklen auf einmal zu überspringen ist das günstigste .NET-Upgrade, das die meisten Teams in diesem Jahrzehnt vornehmen werden. .NET 8 verlässt den Standard-Support im November 2026, .NET 11 ist das aktuelle LTS, und der Weg dazwischen führt durch drei Sätze von Breaking Changes (.NET 9, 10, 11) sowie drei C#-Sprachversionen (C# 13, 14, mit C# 12 bereits in 8 ausgeliefert). Ein Wochenende konzentrierter Arbeit reicht in der Regel für einen kleinen Service. Ein mittelgroßer Monolith mit EF Core, eigener Middleware und ein paar Source Generators kostet meist drei bis fünf Tage. Codebasen, die `BinaryFormatter` pinnen, sich auf `System.Web.HttpContext`-Shims stützen oder In-Process-Azure-Functions betreiben, kosten mehr, und dieser Schmerz tritt zuerst auf.

Dieser Beitrag verwendet `net8.0` als Quelle und `net11.0` als Ziel. Jeder Codeblock fixiert Versionen explizit, damit die Schritte auch nach einigen Patch-Releases reproduzierbar bleiben.

## Warum jetzt migrieren

- Der Standard-Support für .NET 8 endet am 2026-11-10. Danach gibt es weder Sicherheitspatches noch Servicing. Produktionscode auf 8 wird drei Wochen vor Black Friday audit-exponiert.
- .NET 11 liefert relevante Runtime-Gewinne kostenlos: Dynamic PGO ist standardmäßig aktiv, der neue tiered JIT behandelt `async`-Zustandsmaschinen ohne die historische Strafe, und Native AOT unterstützt jetzt ASP.NET Core minimal APIs sowie den Großteil des Lesepfads von EF Core.
- Der in .NET 9 eingeführte `System.Threading.Lock`-Typ beseitigt eine Klasse von Monitor-Reentrancy-Fußangeln. Die Migration zu überspringen lässt das alte `lock(object)`-Muster im Spiel.
- C# 14 bringt das stabile `field`-Keyword in Properties und `partial`-Konstruktoren. Nützlich, aber nicht der Grund für die Migration; behandeln Sie sie als Bonus.

## Was bricht

| Bereich                  | Änderung                                                                            | Schwere    |
| ------------------------ | ----------------------------------------------------------------------------------- | ---------- |
| `lock(object)`           | Der neue `System.Threading.Lock`-Typ verändert die Monitor-Semantik bei Übernahme   | niedrig    |
| `BinaryFormatter`        | In .NET 9 vollständig entfernt. Kein Opt-in-Switch                                  | hoch       |
| `System.Text.Json`       | Standard-`JsonNumberHandling` für `JsonObject`-Roundtrips änderte sich in .NET 10   | mittel     |
| EF Core Query-Pipeline   | Übersetzung von Primitive Collections änderte sich in EF Core 10; manches LINQ wirft jetzt | hoch  |
| ASP.NET Core Middleware  | Überladungs-Signaturen von `UseExceptionHandler` verschoben sich in .NET 10         | niedrig    |
| Native AOT Trim-Warnungen | Mehrere `System.Reflection.Emit`-Pfade emittieren jetzt neu `IL2026`-Warnungen     | mittel     |
| C# 14 Überladungsauflösung | Span-Überladungen schlagen jetzt Array-Überladungen in mehrdeutigen Fällen        | mittel     |
| `IWebHostBuilder`        | Bereits in 8 veraltet, in 11 entfernt. Wechseln Sie zu `WebApplication.CreateBuilder` | hoch    |
| `dotnet ef`-Tool         | Major-Versionssprung erforderlich (`dotnet tool update --global dotnet-ef --version 11.*`) | niedrig |
| Azure Functions          | Das In-Process-Modell wurde entfernt; Isolated Worker ist obligatorisch             | hoch       |

Die vollständige offizielle Liste steht in der [.NET 11 Breaking-Changes-Dokumentation](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0). Lesen Sie sie von Anfang bis Ende, bevor Sie eine `.csproj` anfassen.

## Pre-Flight-Checkliste

Führen Sie das aus, bevor Sie irgendein Target Framework ändern.

1. Installieren Sie das .NET 11 SDK auf jeder Entwicklermaschine und jedem CI-Runner. Verifizieren Sie mit `dotnet --list-sdks` und bestätigen Sie, dass `11.0.x` erscheint. Das SDK ist Side-by-Side, daher funktioniert .NET 8 weiter.
2. Fixieren Sie das SDK in `global.json`, damit CI nicht stillschweigend vorwärts rollt:
   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```
3. Erstellen Sie eine Baseline: Führen Sie `dotnet test` auf .NET 8 aus und speichern Sie die Ergebnisse. Sie wollen ein sauberes Grün vor dem Start, damit das erste Rot nach dem Upgrade eindeutig ist.
4. Erstellen Sie einen Snapshot der Produktions-Runtime: dumpen Sie `dotnet --info` von einem Live-Host. Wenn etwas gegen eine Runtime älter als 8.0.0 linkt (eine alte Self-Contained-Publish, ein Drittanbieter-Plugin), finden Sie es jetzt.
5. Inventarisieren Sie NuGet-Pakete mit `dotnet list package --outdated --include-transitive`. Alles, was `Microsoft.*` auf `8.0.x` pinnt, braucht einen Major-Bump; alles, was auf `7.*` oder älter gepinnt ist, ist eine rote Flagge.
6. Verzweigen Sie die Migration. Ein PR pro logischem Schritt ist leichter zurückzunehmen als ein einzelner Green-Light-Riesen-PR.

## Migrationsschritte

1. **Erhöhen Sie das Target Framework.** Öffnen Sie jede `.csproj` und ändern Sie den Wert von `TargetFramework` (oder `TargetFrameworks`). Verifizieren Sie mit `dotnet build` und behandeln Sie die erste Runde Compile-Fehler als den wahren Umfang der Migration.

   ```xml
   <!-- src/MyApi.csproj, .NET 11 -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
   </Project>
   ```

   Verifikation: `dotnet build` beendet mit 0 zumindest für die Leaf-Projekte, oder schlägt mit Fehlern fehl, die Sie erkennen.

2. **Aktualisieren Sie alle `Microsoft.*` NuGet-Pakete auf die 11.x-Linie.** Tun Sie das als einen Batch mit `dotnet add package` pro Projekt, statt blind `Directory.Packages.props` anzufassen. Runtime, ASP.NET Core, EF Core und die `Microsoft.Extensions.*`-Pakete versionieren im Gleichschritt mit dem SDK.

   ```bash
   # .NET 11
   dotnet add package Microsoft.AspNetCore.OpenApi --version 11.0.0
   dotnet add package Microsoft.EntityFrameworkCore.SqlServer --version 11.0.0
   dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
   ```

   Verifikation: `dotnet restore` ist erfolgreich und `dotnet list package` zeigt kein `8.0.x` mehr unter dem `Microsoft.*`-Namespace.

3. **Entfernen Sie die Nutzung von `BinaryFormatter`.** Wenn die Codebasis etwas mit `BinaryFormatter` serialisiert, ersetzen Sie es jetzt. `System.Text.Json`, MessagePack oder `protobuf-net` sind die üblichen Ersetzungen, je nachdem ob Sie ein JSON- oder Binärformat brauchen. In .NET 9 oder später gibt es kein Kompatibilitäts-Flag; der Typ ist weg.

   Verifikation: `grep -r "BinaryFormatter" src/` liefert nichts. Wenn Sie alte `BinaryFormatter`-Blobs aus dem Speicher lesen müssen, schreiben Sie ein einmaliges .NET 8 Migrationstool, um sie zu konvertieren, bevor Sie die .NET 8 Umgebung abschalten.

4. **Ersetzen Sie `IWebHostBuilder` durch `WebApplication.CreateBuilder`.** Der alte Generic-Host-Shim wurde in .NET 6 deprecated und in .NET 11 entfernt. Jede `Program.cs`, die noch `Host.CreateDefaultBuilder().ConfigureWebHostDefaults(...)` aufruft, kompiliert nicht.

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.MapOpenApi();
   app.MapControllers();
   app.Run();
   ```

   Verifikation: die App startet unter `dotnet run` und der Endpoint `/openapi/v1.json` antwortet mit HTTP 200.

5. **Auditieren Sie `System.Text.Json` auf Verhaltensänderungen.** Die Standardbehandlung von Zahlen-Roundtrips in `JsonObject` änderte sich in .NET 10 so, dass Integer beim Re-Serialisieren keine Präzision mehr verlieren, und der polymorphe Deserializer ist standardmäßig strenger mit unbekannten Diskriminatoren. Wenn Sie einen öffentlichen API-Vertrag pflegen, lassen Sie Ihre Vertragstests laufen und lesen Sie die Fehler sorgfältig. Der Vertrag ist oft nicht geändert, aber ein vorher stiller Mismatch wirft jetzt eine Exception. Der Begleitbeitrag zum [Fix von "JSON value could not be converted to System.DateTime"](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) deckt den häufigsten Konvertierungs-Fehlermodus ab.

   Verifikation: `dotnet test` beendet sauber für jedes Projekt, das Serialisierung gegen Fixture-JSON-Dateien übt.

6. **Migrieren Sie EF Core Queries, die Primitive Collections nutzen.** EF Core 10 hat überarbeitet, wie `List<int>.Contains(x)` übersetzt wird, sodass parametrisierte Collections einen einzelnen SQL-Parameter erzeugen statt in eine `IN`-Klausel zu expandieren. Das behob das Plan-Cache-Bloat-Problem, brach aber eine kleine Menge von Queries, die `Contains` mit anderen serverseitig ausgewerteten Ausdrücken kombinierten. Lassen Sie alle EF Core Integrationstests neu laufen und inspizieren Sie jede Query, die jetzt `InvalidOperationException: The LINQ expression ... could not be translated` wirft. Die Notluke ist, die Collection mit `.ToList()` vor dem Join zu materialisieren.

   Verifikation: jeder Integrationstest, der rohes LINQ über `DbSet<T>` übt, besteht; prüfen Sie stichprobenartig das generierte SQL mit `LogTo(Console.WriteLine, LogLevel.Information)` auf einer repräsentativen Query.

7. **Übernehmen Sie `System.Threading.Lock` selektiv, nicht als Pauschalersatz.** `private readonly object _gate = new();` durch `private readonly System.Threading.Lock _gate = new();` zu ersetzen, ist in den meisten Fällen korrekt, ändert aber, ob Reentrancy aus demselben Thread beobachtbar ist. Gehen Sie die Codepfade zuerst durch. Ein tieferer Trade-off-Vergleich findet sich in [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/de/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/).

   Verifikation: das Code-Review deckt explizit jede `lock(...)`-Stelle ab, die geändert wurde; keine funktionale Änderung in der Testsuite.

8. **Lassen Sie die Trim- und AOT-Analyzer erneut laufen.** Wenn das Projekt `<PublishAot>true</PublishAot>` oder `<TrimMode>full</TrimMode>` setzt, emittiert .NET 11 neue Warnungen rund um `System.Reflection.Emit`-Pfade, die unter .NET 8 stumm waren. Die Behebung besteht meist darin, `[DynamicallyAccessedMembers]`-Annotationen hinzuzufügen oder einen JSON Source Generator zu registrieren. Der [Native AOT vs ReadyToRun vs JIT Vergleich](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) behandelt, wann sich welches Modell rechnet.

   Verifikation: `dotnet publish -c Release` emittiert null `IL2026`- oder `IL3050`-Warnungen am Leaf-Projekt; das resultierende Native-Binary startet lokal.

9. **Beheben Sie Überraschungen der C# 14 Überladungsauflösung.** C# 14 änderte die Auflösungsregeln so, dass Überladungen, die `ReadOnlySpan<T>` akzeptieren, gegenüber solchen mit `T[]` bevorzugt werden, wenn beide passen. Der meiste Code ist unbetroffen. Die brechenden Fälle sind in der Regel Mocks, Fluent-Assertion-Bibliotheken und eigene Extension Methods, die unter der Annahme geschrieben wurden, dass die Array-Überladung gewinnt. Der Compiler emittiert einen klaren Diagnose; der Fix ist meist ein Cast. Der [C# 14 Überladungsauflösungs-Breaking-Change mit Spans](/de/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) führt durch die Diagnose und das Cast-Muster.

   Verifikation: `dotnet build` ist warnungsfrei bei `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`.

10. **Aktualisieren Sie die CI-Runner-Images.** Heben Sie die `dotnet-version` von `actions/setup-dotnet` in GitHub Actions auf `11.0.x` an, aktualisieren Sie jedes Dockerfile-Base-Image auf `mcr.microsoft.com/dotnet/sdk:11.0` und `mcr.microsoft.com/dotnet/aspnet:11.0`, und entfernen Sie Pins auf das .NET 8 SDK-Image. Self-Hosted-Runner brauchen das SDK manuell installiert, bevor CI grün wird.

    Verifikation: ein Pipeline-Lauf auf einem Feature-Branch ist von Anfang bis Ende grün, einschließlich des Publish-Schritts.

## Verifikation (Smoke-Checkliste)

Nach den obigen Schritten sollte die App jede Zeile dieser Liste bestehen, bevor der Migrations-PR gemerged wird:

- `dotnet --list-sdks` zeigt 11.0.x als die tatsächlich vom Build genutzte Version (`dotnet --version` im Repo-Root druckt `11.0.x`).
- `dotnet restore && dotnet build -c Release` beendet mit 0 und null Warnungen.
- `dotnet test -c Release` ist grün und die Testanzahl entspricht der .NET 8 Baseline.
- `dotnet publish -c Release` produziert ein Artefakt, das lokal startet und `/health` serviert.
- Ein repräsentativer Lesepfad und ein repräsentativer Schreibpfad werden gegen eine Staging-Umgebung geübt; die Latenz p50/p95 liegt innerhalb von 10 Prozent der .NET 8 Baseline.
- Die Logs zeigen keine First-Chance-Referenzen auf `BinaryFormatter`, `IWebHostBuilder` oder `IL2026`.

Wenn irgendetwas davon fehlschlägt, halten Sie an. Mergen Sie keine teilweise migrierte Codebasis.

## Rollback

Diese Migration ist umkehrbar bis zum ersten Produktions-Deploy, der einen Schreibvorgang unter .NET 11 entgegennimmt. Bis dahin nehmen Sie `global.json`, `TargetFramework` und die NuGet-Bumps in einem Commit zurück. Nach dem ersten .NET 11 Produktions-Schreibvorgang ist Rollback technisch möglich, aber selten lohnend: Schemaänderungen, die Sie unter dem EF Core 11 Translator gemacht haben, JSON-Ausgaben, die unter den neuen Standards serialisiert wurden, und jede Übernahme von `System.Threading.Lock` benötigen separates Nachdenken. Planen Sie vorwärts zu fixen.

## Stolperfallen, auf die wir gestoßen sind

- **Ein NuGet-Paket, das nur `net8.0` zielt, ist nicht zwangsläufig auf net11.0 kaputt**, aber es lädt stillschweigend die .NET Standard 2.0 Facade, wenn das Paket eine offenlegt. Das zieht manchmal ältere `System.*`-Abhängigkeiten zurück ins Spiel. `dotnet list package --include-transitive` nach dem Bump ist nicht optional.
- **`Microsoft.Data.SqlClient`-Versionen sind wichtig.** EF Core 11 will `Microsoft.Data.SqlClient` 7.x oder neuer. Ein älterer transitiver Pin kompiliert, scheitert dann zur Laufzeit an der TLS 1.3 Aushandlung gegen neuere SQL Server-Instanzen.
- **Source Generators, die auf Roslyn 4.6 basieren, emittieren Warnungen auf dem Roslyn, der mit .NET 11 ausgeliefert wird.** Die meisten lösen sich, indem die `Microsoft.CodeAnalysis.CSharp`-Referenz des Generators angehoben wird. Wenn Sie Ihren eigenen Generator versenden, tun Sie das in einem separaten PR.
- **In-Process Azure Functions sind weg.** Wenn ein einzelnes Function-Projekt noch das In-Process-Modell auf .NET 8 verwendet, wird .NET 11 es nicht ausführen. Wechseln Sie zuerst zum Isolated-Worker-Modell, dann bumpen Sie.
- **Die Cancellation-Semantik von `HttpClient` auf .NET 11** wirft korrekterweise `TaskCanceledException`, deren `CancellationToken` mit dem gelieferten Token übereinstimmt, während früher einige Pfade mit `CancellationToken.None` warfen. Catch-Blöcke, die per Pattern-Matching auf den Token zielen, brauchen eine kleine Anpassung; die Begründung steht in der Diskussion zu [async void vs async Task in C#](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Verwandt

- [ConfigureAwait(false) vs Standard in .NET 11](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [EF Core 11 vs Dapper für Bulk Inserts: echter Benchmark](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/de/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)
- [Minimal APIs vs Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Quellen

- [.NET 11 Breaking Changes](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [.NET Release-Zeitplan und Support-Politik](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)
- [EF Core 10 und 11 Breaking Changes](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [C# 14 Sprachreferenz](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
- [`System.Threading.Lock` API-Referenz](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock)
