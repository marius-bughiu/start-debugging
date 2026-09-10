---
title: "Lösung: PublishAot zusammen mit EFOptimizeContext erschöpft den Speicher beim EF Core-Build"
description: "Die Modellgenerierung von EF Core zur Build-Zeit hat MSBuild immer wieder aufgerufen, bis der RAM voll war. Aktualisieren Sie Tasks und Design auf 10.0.10+ und entfernen Sie unter EF Core 11 EFOptimizeContext."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "native-aot"
  - "msbuild"
  - "dotnet-10"
lang: "de"
translationOf: "2026/09/fix-publishaot-and-efoptimizecontext-exhaust-memory-during-an-ef-core-build"
translatedBy: "claude"
translationDate: 2026-09-10
---

Aktualisieren Sie sowohl `Microsoft.EntityFrameworkCore.Tasks` als auch `Microsoft.EntityFrameworkCore.Design` auf 10.0.10 oder neuer (10.0.12 ist der Stand vom 2026-09-10), beenden Sie danach die übrig gebliebenen Build-Prozesse und starten Sie Visual Studio neu. Bis einschließlich 10.0.9 hat sich die Generierung des kompilierten Modells und die Abfrage-Vorkompilierung von EF Core zur Build-Zeit aus ihren eigenen verschachtelten Builds heraus erneut ausgelöst und so lange MSBuild-Prozesse gestartet, bis der Rechner keinen Speicher mehr hatte. In EF Core 11 ist die Korrektur bereits enthalten, und `EFOptimizeContext` selbst gibt es nicht mehr: Entfernen Sie die Eigenschaft, sonst schlägt der Build fehl.

## Der Fehler im Kontext

Es gibt keine Exception, nach der man suchen könnte, und genau das macht dieses Problem so unangenehm. Der Bericht zu EF Core 10.0.5, [dotnet/efcore#38087](https://github.com/dotnet/efcore/issues/38087), beschreibt das gesamte Symptom: Der RAM-Verbrauch steigt, bis der Rechner nicht mehr reagiert, die Build-Ausgabe kommt nie über ihre erste Zeile hinaus, und schon das Öffnen der Solution in Visual Studio löst es aus, weil IntelliSense Design-Time-Builds startet, sobald das Projekt geladen ist. Das ausführliche Build-Log in diesem Bericht enthält genau das und sonst nichts:

```
Build started at 5:55 PM...
```

Der Task-Manager oder `top` zeigt währenddessen einen wachsenden Stapel von `dotnet`- und `MSBuild`-Prozessen. Die auslösenden Projekteinstellungen sind immer dieselben vier Zeilen:

```xml
<!-- EF Core 10.0.5 through 10.0.9: do not build this without the fix -->
<PublishAot>true</PublishAot>
<EFOptimizeContext>true</EFOptimizeContext>
<EFScaffoldModelStage>build</EFScaffoldModelStage>
<EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
```

Wer nach dem Upgrade auf EF Core 11 hier gelandet ist, sieht etwas anderes: einen harten Build-Fehler aus dem Target `_EFValidateProperties` in `Microsoft.EntityFrameworkCore.Tasks` 11.0.0-rc.1.26425.128 mit dieser Meldung:

```
$(EFOptimizeContext) is no longer supported. Use $(EFScaffoldModelStage) and $(EFPrecompileQueriesStage) instead.
```

## Warum das passiert

Hier kommen zwei Dinge zusammen, die auf den ersten Blick nichts miteinander zu tun haben.

Erstens ist `PublishAot` nicht nur eine Veröffentlichungseinstellung. Mit `<PublishAot>true</PublishAot>` in der Projektdatei schreibt schon ein einfaches `dotnet build` die AOT-Feature-Switches in `bin/Debug/net10.0/YourApp.runtimeconfig.json`, darunter diesen:

```json
"System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
```

EF Core respektiert diesen Switch und weigert sich, sein Modell zur Laufzeit aufzubauen. Eine F5-Debug-Sitzung stirbt deshalb bei der ersten Abfrage:

```
Unhandled exception. System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
```

Die naheliegende Reaktion ist, das kompilierte Modell und die vorkompilierten Abfragen bei jedem Build generieren zu lassen. Genau das tun `EFScaffoldModelStage=build` und `EFPrecompileQueriesStage=build`, und in EF Core 9 und 10 wirken sie nur zusammen mit `EFOptimizeContext=true`. Daher die vier Zeilen.

Zweitens ist da die Art, wie `Microsoft.EntityFrameworkCore.Tasks` die Generierung in den Build einhängt. Das Target `_EFGenerateFilesAfterBuild` wird an `$(TargetsTriggeredByCompilation)` angehängt und läuft deshalb nach jedem `CoreCompile`. Es startet ein verschachteltes MSBuild desselben Projekts mit `_EFGenerationStage=build`, das das Projekt mit abgeschaltetem AOT erneut kompiliert und danach den Task `OptimizeDbContext` ausführt. Für vorkompilierte Abfragen öffnet der Design-Time-Code von EF das Projekt anschließend über Roslyns `MSBuildWorkspace`, und das Laden eines Projekts auf diesem Weg führt einen weiteren Design-Time-Build davon aus.

Das Einzige, was diese Kette an der Rekursion hinderte, war eine Bedingung `'$(_EFGenerationStage)'==''` an den Generierungs-Targets. Sie hatte zwei Lücken:

1. **Design-Time-Builds von Visual Studio.** `CoreCompile` läuft auch in den leichtgewichtigen Design-Time-Builds, die VS fortlaufend startet, solange ein Projekt geöffnet ist. Jeder davon stieß eine vollständige Generierung außerhalb des Prozesses an, und diese stauten sich schneller auf, als sie fertig wurden. [dotnet/efcore#38386](https://github.com/dotnet/efcore/pull/38386) behob das, indem die Generierungs-Targets die Bedingung `'$(DesignTimeBuild)' != 'True'` erhielten. Diese Änderung steckt in der `.targets`-Datei des **Tasks**-Pakets.
2. **Builds über die Kommandozeile.** Der für die Abfrage-Vorkompilierung geöffnete `MSBuildWorkspace` trug kein `_EFGenerationStage`, sodass sein Build die Bedingung erfüllte und die Generierung erneut auslöste, die wiederum einen Workspace öffnete, und so weiter. [dotnet/efcore#38403](https://github.com/dotnet/efcore/pull/38403) behob das, indem der Workspace mit `_EFGenerationStage=build` als globaler Eigenschaft erzeugt wird. Diese Änderung steckt in `DbContextOperations` im **Design**-Paket.

Beide Korrekturen wurden im Juni 2026 in `release/10.0` gemergt und erstmals mit 10.0.10 am 2026-07-14 ausgeliefert. Ich habe das an den Paketen selbst geprüft, statt dem Milestone zu vertrauen: Die `Microsoft.EntityFrameworkCore.Tasks.targets` aus 10.0.9 enthält keine `DesignTimeBuild`-Prüfung, die aus 10.0.10 enthält drei, und der String `_EFGenerationStage` taucht in `Microsoft.EntityFrameworkCore.Design.dll` erstmals in 10.0.10 auf.

## Minimale Reproduktion

Das ist das Projekt aus dem ursprünglichen Bericht, reduziert auf eine Entität und einen Kontext über SQLite. Jede Version bis einschließlich 10.0.9 reproduziert das Problem. Kompilieren Sie es nicht auf einem Rechner, auf dem Sie nicht bereit sind, den Prozessbaum abzuschießen.

```xml
<!-- .NET 10 SDK, EF Core 10.0.9 (broken). Reproduces the memory exhaustion. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
    <EFOptimizeContext>true</EFOptimizeContext>
    <EFScaffoldModelStage>build</EFScaffoldModelStage>
    <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
    <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.9" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.9" PrivateAssets="all" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.x
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();
await db.Database.OpenConnectionAsync();
await db.Database.ExecuteSqlRawAsync(
    "CREATE TABLE IF NOT EXISTS Entities (Id INTEGER PRIMARY KEY)");
var count = await db.Entities.Where(e => e.Id > 0).CountAsync();
Console.WriteLine($"Entities: {count}");

public class Entity { public int Id { get; set; } }

public class AppDbContext : DbContext
{
    public DbSet<Entity> Entities => Set<Entity>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=db.sqlite");
}
```

Die Tabelle wird absichtlich mit rohem SQL statt mit `EnsureCreatedAsync()` angelegt. Der Abschnitt zu den Stolperfallen weiter unten erklärt, warum.

## Die Lösung im Detail

### 1. Tasks und Design gemeinsam auf 10.0.10 oder neuer aktualisieren

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 (fixed) -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.12" PrivateAssets="all" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.12" PrivateAssets="all" />
</ItemGroup>
```

Pinnen Sie Design explizit. Der Schutz für Design-Time-Builds steckt in Tasks, der Schutz für die Kommandozeile steckt in Design, und ohne explizite Referenz gelangt Design transitiv in der Version in Ihren Graphen, die NuGet gerade auflöst. Das ist nicht immer die erwartete: Tools 10.0.6 bis 10.0.8 ließen Design bis hinunter auf 8.0.0 auflösen, ein Durcheinander, das in [der Lösung zu MissingMethodException ArgumentIsEmpty](/de/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/) beschrieben ist. Wer nur Tasks aktualisiert, repariert Visual Studio und lässt `dotnet build` kaputt. `dotnet nuget why . Microsoft.EntityFrameworkCore.Design` zeigt, was tatsächlich aufgelöst wurde.

Räumen Sie danach auf, was die fehlerhafte Version hinterlassen hat. Schließen Sie Visual Studio, beenden Sie verwaiste `dotnet`- oder `MSBuild`-Prozesse, fahren Sie die Build-Server herunter und löschen Sie `obj`, damit halb geschriebene generierte Dateien und ihre `*.EFGeneratedSources.Build.txt`-Listen nicht in die nächste Kompilierung einfließen:

```bash
dotnet build-server shutdown
```

Mit der obigen Reproduktion auf 10.0.12 und SDK 10.0.302 ist `dotnet build` nach 5,4 Sekunden mit 0 Fehlern fertig, die App gibt `Entities: 0` aus, und `obj/Debug/net10.0/EfBombRepro.EFGeneratedSources.Build.txt` listet sechs generierte Dateien:

```
AppDbContextAssemblyAttributes.g.cs
EntityUnsafeAccessors.g.cs
AppDbContextModel.g.cs
AppDbContextModelBuilder.g.cs
EntityEntityType.g.cs
Program.EFInterceptors.AppDbContext.g.cs
```

Die Interceptor-Datei enthält das fertige SQL für den `CountAsync`-Aufruf, `SELECT COUNT(*) FROM "Entities" AS "e" WHERE "e"."Id" > 0`, als String-Literal. Genau darum geht es bei der Abfrage-Vorkompilierung: Zur Laufzeit wird kein LINQ mehr übersetzt.

### 2. Unter EF Core 11 EFOptimizeContext entfernen

EF Core 11 hat die Eigenschaft entfernt ([dotnet/efcore#35079](https://github.com/dotnet/efcore/issues/35079)), weil die Stage-Eigenschaften bereits alles ausdrückten, was sie tat. Sie aktivieren die Generierung jetzt allein:

```xml
<!-- .NET 11, EF Core 11.0.0-rc.1.26425.128 -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
  <EFScaffoldModelStage>build</EFScaffoldModelStage>
  <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
</PropertyGroup>
```

Die targets-Datei der rc.1 enthält den `DesignTimeBuild`-Schutz, und die Design-Assembly der rc.1 enthält die Workspace-Korrektur mit `_EFGenerationStage`, daher ist diese Konfiguration sicher. Wenn Sie die Generierung nur beim Veröffentlichen brauchen, entfernen Sie auch die beiden Stage-Zeilen: Beide haben `publish` als Standardwert, und mit `PublishAot=true` generiert EF Core 11 das kompilierte Modell und die vorkompilierten Abfragen während `dotnet publish` ohne zusätzliche Eigenschaft. Eine Kombination wird direkt abgelehnt, `EFScaffoldModelStage=publish` zusammen mit `EFPrecompileQueriesStage=build`, die mit "If $(EFScaffoldModelStage) is set to 'publish' then $(EFPrecompileQueriesStage) must also be set to 'publish'." fehlschlägt.

Achten Sie auf die Reihenfolge. Unter 10.x ist `EFOptimizeContext` weiterhin der Schalter für die Generierung in der Build-Phase. Ich habe die Eigenschaft aus der korrigierten 10.0.12-Reproduktion entfernt und beide Stages auf `build` gelassen: Der Build war erfolgreich, generierte nichts, und die App warf bei der ersten Abfrage die Exception "Model building is not supported". Entfernen Sie die Eigenschaft im Zuge des Upgrades auf EF Core 11, nicht vorher. Beachten Sie außerdem, dass das Tasks-Paket in EF Core 11 überhaupt nicht mehr von Design abhängt, ein weiterer Grund, die explizite Design-Referenz aus Schritt 1 beizubehalten.

Da auf meinem Rechner nur SDK 10.0.302 installiert ist und die EF Core 11-Pakete ausschließlich `net11.0` adressieren, beruhen die Aussagen zu EF Core 11 oben auf dem Lesen der ausgelieferten rc.1-targets-Datei und -Assembly, nicht auf einem tatsächlichen Build.

### 3. PublishAot aus der inneren Entwicklungsschleife heraushalten

Der Rat des EF-Maintainers im Issue-Thread ist eindeutig: "I'd recommend not setting `<PublishAot>true</PublishAot>` for the inner dev loop". Der Einwand des Meldenden ist der eigentliche: Ohne `PublishAot` verschwinden die Trimming- und AOT-Warnungen aus der IDE. Das muss nicht sein, denn die Analyzer haben eigene Schalter:

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 -->
<PropertyGroup>
  <EnableAotAnalyzer>true</EnableAotAnalyzer>
  <EnableTrimAnalyzer>true</EnableTrimAnalyzer>
</PropertyGroup>
```

Ersetzt man `PublishAot` durch diese beiden Zeilen, meldet die Reproduktion weiterhin dieselben Warnungen `IL2026` und `IL3050` bei `new AppDbContext()`. Die runtimeconfig enthält den Switch `IsDynamicCodeSupported` nicht mehr, EF Core baut sein Modell wie gewohnt zur Laufzeit auf, und während des Builds wird nichts generiert. AOT wird zur Entscheidung beim Veröffentlichen:

```bash
dotnet publish -c Release -r linux-x64 -p:PublishAot=true
```

Die EF-Dokumentation empfiehlt außerdem, `<RuntimeIdentifier>` im Startprojekt zu setzen, wenn die Generierung in der Veröffentlichungsphase läuft.

Die Kosten in der inneren Schleife sind nicht hypothetisch. In der Reproduktion mit einer einzigen Entität dauerte ein inkrementeller Build nach einer Änderung an `Program.cs` 4,7 Sekunden mit Generierung in der Build-Phase und 1,2 Sekunden ohne. Ein Build ohne Änderungen dauerte in beiden Fällen 0,6 Sekunden, weil die Generierung immer dann übersprungen wird, wenn `CoreCompile` übersprungen wird. Die Dokumentation warnt, dass das generierte Modell und die Interceptors "may currently be quite large" sind und lange zur Erzeugung brauchen, also wächst dieser Abstand mit Ihrem Modell.

## Stolperfallen und ähnliche Fehler

**"Design-time DbContext operations are not supported when publishing with NativeAOT."** Unter `PublishAot=true` werfen `EnsureCreatedAsync()`, `Migrate()` und alles andere, was das Design-Time-Modell braucht, diese Exception, auch mit F5 und auch mit vorhandenem kompiliertem Modell. Deshalb legt die Reproduktion ihre Tabelle mit rohem SQL an. Wenden Sie Schemaänderungen stattdessen aus Ihrer Deployment-Pipeline mit einem Migrations-Bundle oder einem SQL-Skript an.

**`warning CS9270: 'InterceptsLocationAttribute(string, int, int)' is not supported`.** Die von 10.0.12 generierten Interceptors verwenden noch die dateipfadbasierte Form des Attributs, daher warnt der Compiler bei der generierten Datei. Das ist eine Warnung in generiertem Code, nichts, was Sie in Ihrem Code beheben. Dasselbe Detail erklärt, warum diese Dateien maschinenspezifische absolute Pfade enthalten und nach `obj` gehören, niemals in die Versionsverwaltung.

**CS9137, "The 'interceptors' feature is not enabled in this namespace".** Entweder fehlt die Zeile `InterceptorsNamespaces`, oder laut EF-Dokumentation befinden sich veraltete transitive Referenzen auf `Microsoft.CodeAnalysis.CSharp.Workspaces` und `Microsoft.CodeAnalysis.Workspaces.MSBuild` im Graphen. Derselbe Fehlercode aus einem anderen Generator wird in [der Lösung zum CS9137-Interceptors-Fehler](/de/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/) behandelt.

**Stillschweigend übersprungene Generierung in einer Solution mit mehreren Projekten.** Jedes Projekt, das einen `DbContext` oder eine EF-Abfrage enthält, braucht eine eigene Referenz auf `Microsoft.EntityFrameworkCore.Tasks`, da sie nicht transitiv ist. Die Integration kann außerdem kein separates Startprojekt verwenden, daher braucht ein Kontext, der von einem Host in einem anderen Projekt konfiguriert wird, eine `IDesignTimeDbContextFactory<TContext>`.

**Dieselbe Modellaufbau-Exception unter iOS ohne PublishAot.** iOS-Builds setzen `DynamicCodeSupport=false` von sich aus, daher landen .NET MAUI-Apps auf diesem Pfad, ohne je AOT aktiviert zu haben. Siehe [die Lösung zum NativeAOT-Modellaufbau unter MAUI iOS](/de/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/).

## Verwandte Artikel

- [Wie Sie das Modell von EF Core vor der ersten Abfrage aufwärmen](/de/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/), einschließlich der Auslieferung eines kompilierten Modells mit `dotnet ef dbcontext optimize`, wenn Sie AOT gar nicht brauchen.
- [Lösung: Model building is not supported when publishing with NativeAOT in einem .NET MAUI-iOS-Build](/de/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11: Was sollten Sie ausliefern?](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), lesenswert, bevor Sie eine EF Core-App auf AOT festlegen.
- [Lösung: MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' nach dem Upgrade von EF Core Tools](/de/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/)
- [Lösung: The 'interceptors' feature is not enabled in this namespace](/de/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/)

## Quellen

- [dotnet/efcore#38087, `PublishAot` + `EFOptimizeContext` fork bombs the system](https://github.com/dotnet/efcore/issues/38087)
- [dotnet/efcore#38386, schützt die EF-Dateigenerierung vor Design-Time-Builds](https://github.com/dotnet/efcore/pull/38386)
- [dotnet/efcore#38403, schützt die EF-Dateigenerierung bei Builds über die Kommandozeile](https://github.com/dotnet/efcore/pull/38403)
- [dotnet/efcore#35079, entfernt die Eigenschaft EFOptimizeContext aus den EF-Targets](https://github.com/dotnet/efcore/issues/35079)
- [EF Core MSBuild-Tasks](https://learn.microsoft.com/en-us/ef/core/cli/msbuild)
- [Breaking Changes in EF Core 11: Die MSBuild-Eigenschaft EFOptimizeContext wurde entfernt](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [NativeAOT-Unterstützung und vorkompilierte Abfragen in EF Core](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries)
- [Microsoft.EntityFrameworkCore.Tasks auf NuGet](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks)
