---
title: "Lösung: Model building is not supported when publishing with NativeAOT in einem .NET MAUI iOS Build"
description: "iOS Builds setzen DynamicCodeSupport=false, deshalb verweigert EF Core den Modellaufbau, auch wenn Sie NativeAOT nie aktiviert haben. Liefern Sie ein kompiliertes Modell plus vorkompilierte Abfragen aus, oder schalten Sie den Interpreter wieder ein."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "maui"
  - "ios"
  - "native-aot"
  - "dotnet-10"
lang: "de"
translationOf: "2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios"
translatedBy: "claude"
translationDate: 2026-08-30
---

Ihre MAUI iOS App stürzt beim ersten Datenbankzugriff mit `Model building is not supported when publishing with NativeAOT. Use a compiled model.` ab, und `<PublishAot>false</PublishAot>` bewirkt nichts. Der Grund: EF Core schaut nie auf `PublishAot`. Es prüft `RuntimeFeature.IsDynamicCodeSupported`, und die .NET Targets für iOS setzen diesen Schalter bei jedem iOS, tvOS und Mac Catalyst Build auf `false`, solange der Interpreter nicht aktiviert ist. Die unterstützte Lösung: Verschieben Sie Ihren `DbContext` und jede LINQ Abfrage in eine gewöhnliche Klassenbibliothek, führen Sie `dotnet ef dbcontext optimize --precompile-queries --nativeaot` darauf aus und ergänzen Sie `<InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>`. Der Notausgang in einer Zeile lautet `<UseInterpreter>true</UseInterpreter>`, zu einem realen Preis beim Start.

Alles Folgende wurde unter macOS mit dem .NET SDK 10.0.302, `Microsoft.EntityFrameworkCore.Sqlite` 8.0.21 / 9.0.19 / 10.0.11 und der `dotnet-ef` CLI 10.0.11 verifiziert. Der Fehler und alle drei Lösungen lassen sich in einer einfachen Konsolenanwendung nachstellen, ohne Xcode und ohne iPhone, denn der Auslöser ist ein einzelner AppContext Schalter. Wo eine Aussage den iOS Build selbst betrifft und nicht etwas, das ich ausgeführt habe, stammt sie aus den Targets von `dotnet/macios` und `dotnet/sdk`, und das sage ich dann auch.

## Der Fehler im Kontext

```text
System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder...
   at Microsoft.EntityFrameworkCore.DbContext.get_Model()
```

Er tritt bei der ersten Operation auf, die das Modell berührt: eine Abfrage, `Add`, `SaveChanges` oder `EnsureCreated`. Das bloße Erzeugen des `DbContext` löst ihn nicht aus, weshalb der Absturz meist weit entfernt vom Code für die Datenbankkonfiguration landet.

Die zwei verwandten Meldungen, auf die Sie beim Beheben stoßen können, sind `Design-time DbContext operations are not supported when publishing with NativeAOT.` und `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` Beide werden weiter unten behandelt.

## Warum ein iOS Build einen NativeAOT Fehler meldet, obwohl Sie NativeAOT nie aktiviert haben

Die Meldung nennt NativeAOT, aber nichts in der Prüfung erwähnt es. Hier ist der tatsächliche Code aus [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs):

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, DbContextServices.CreateModel
if (modelFromOptions == null
    || (designTime && modelFromOptions is not Metadata.Internal.Model))
{
    return RuntimeFeature.IsDynamicCodeSupported
        ? dependencies.ModelSource.GetModel(_currentContext!.Context, dependencies, designTime)
        : designTime
            ? throw new InvalidOperationException(CoreStrings.NativeAotDesignTimeModel)
            : throw new InvalidOperationException(CoreStrings.NativeAotNoCompiledModel);
}
```

`RuntimeFeature.IsDynamicCodeSupported` liest den AppContext Schalter `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported`, den das SDK aus der MSBuild Eigenschaft `DynamicCodeSupport` in die `runtimeconfig.json` schreibt. Aus [`Microsoft.NET.Sdk.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.Sdk.targets):

```xml
<!-- .NET SDK 10.0.302 -->
<RuntimeHostConfigurationOption Include="System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported"
                                Condition="'$(DynamicCodeSupport)' != ''"
                                Value="$(DynamicCodeSupport)"
                                Trim="true" />
```

Und hier ist die Zeile, die sie setzt, aus [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) in `dotnet/macios`:

```xml
<!-- dotnet/macios, Xamarin.Shared.Sdk.targets -->
<DynamicCodeSupport Condition="'$(DynamicCodeSupport)' == '' And ( '$(MtouchInterpreter)' == '' And '$(UseInterpreter)' != 'true' ) And ('$(_PlatformName)' == 'iOS' Or '$(_PlatformName)' == 'tvOS' Or '$(_PlatformName)' == 'MacCatalyst')">false</DynamicCodeSupport>
```

Aus dieser Bedingung folgen drei Dinge, und alle drei widersprechen der Folklore rund um diesen Fehler.

Es geht nicht um `PublishAot`. Diese Eigenschaft taucht nirgends in der Kette auf, deshalb ändert `false` daran nichts.

Es geht nicht um die Release Konfiguration. Die Bedingung enthält keine Prüfung auf `Configuration`. Entscheidend ist, ob der Interpreter aktiv ist, also bekommt auch ein Debug Build ohne Interpreter `IsDynamicCodeSupported = false`, und ein Release Build mit `UseInterpreter=true` bekommt es nicht.

Für Android gilt es nicht. Die Plattformliste umfasst nur iOS, tvOS und Mac Catalyst, deshalb funktioniert dieselbe Lösung unter Android und Windows weiter, während iOS abstürzt.

Eingeführt wurde die Eigenschaft durch [dotnet/macios PR #18555](https://github.com/dotnet/macios/pull/18555), "Set `DynamicCodeSupport=false` to enable trimming in full AOT mode", und sie floss im Band 8.0.6x in das MAUI Workload ein. Dieser Zeitpunkt passt zu [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595), wo der Melder die Regression zwischen Workload 8.0.40 (funktionierte) und 8.0.61 (defekt) eingrenzte, ohne eine Zeile EF Core Code zu ändern.

## Nachstellen ohne iPhone

Weil der Auslöser ein einziger Schalter ist, können Sie das in einer Desktop Konsolenanwendung nachstellen und lösen. Legen Sie ein Projekt an und setzen Sie dieselbe Eigenschaft, die die iOS Targets setzen:

```xml
<!-- .NET SDK 10.0.302, net10.0 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <!-- exactly what Xamarin.Shared.Sdk.targets sets for iOS/tvOS/MacCatalyst -->
  <DynamicCodeSupport>false</DynamicCodeSupport>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
</ItemGroup>
```

```csharp
// .NET 10, EF Core 10.0.11
using System.Runtime.CompilerServices;
using Microsoft.EntityFrameworkCore;

Console.WriteLine($"IsDynamicCodeSupported = {RuntimeFeature.IsDynamicCodeSupported}");

using var db = new NotesContext();
db.Database.EnsureCreated();

public class Note
{
    public int Id { get; set; }
    public string Text { get; set; } = "";
}

public class NotesContext : DbContext
{
    public DbSet<Note> Notes => Set<Note>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=notes.db");
}
```

`dotnet run` gibt `IsDynamicCodeSupported = False` aus und wirft dann genau diesen Fehler. Die erzeugte `bin/Debug/net10.0/<app>.runtimeconfig.json` zeigt, woher er kommt:

```json
"configProperties": {
  "System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
}
```

Diese Repro Schleife ist wichtig, denn die Alternative ist ein zehnminütiger Gerätebuild pro Versuch.

## Lösung 1: kompiliertes Modell plus vorkompilierte Abfragen in einer gemeinsamen Bibliothek

Das ist der unterstützte Weg und der einzige, der den Trimming Vorteil erhält, für den der Schalter existiert. Er besteht aus drei Teilen, und wer einen davon auslässt, landet nur bei der nächsten Exception.

**Schritt 1: Verschieben Sie den `DbContext`, die Entitäten und jede LINQ Abfrage in eine gewöhnliche `net10.0` Klassenbibliothek.** Nicht `net10.0-ios`. Das `dotnet ef` Tooling lädt Ihre Assembly in einem Entwurfszeitprozess auf dem Host und braucht ein Projekt, das es tatsächlich kompilieren und laden kann. Eine gewöhnliche Bibliothek liefert Ihnen außerdem ein Projekt, in dem `IsDynamicCodeSupported` weiterhin `true` ist, was der nächste Schritt voraussetzt.

Der Teil "jede LINQ Abfrage" ist keine Stilfrage. Ich habe es geprüft: Eine Abfrage im App Projekt, das die optimierte Bibliothek referenziert, wirft weiterhin `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` Die Vorkompilierung erzeugt C# Interceptors für die Aufrufstellen, die sie sieht, also ist eine Aufrufstelle in einem anderen Projekt für sie unsichtbar. In der Praxis führt Sie das zu einer Repository oder Datendienstklasse in der Bibliothek, wo MAUI Apps diesen Code ohnehin halten sollten.

```csharp
// .NET 10, EF Core 10.0.11 - Notes.Data class library
public static class NoteRepository
{
    public static async Task<List<Note>> GetAllAsync()
    {
        using var db = new NotesContext();
        return await db.Notes.OrderBy(n => n.Id).ToListAsync();
    }

    public static async Task<Note?> FindByTextAsync(string text)
    {
        using var db = new NotesContext();
        var needle = text;
        return await db.Notes.FirstOrDefaultAsync(n => n.Text == needle);
    }
}
```

Die Zeile `var needle = text;` ist nicht kosmetisch. `n.Text == text` direkt gegen den Methodenparameter zu schreiben, lässt die Vorkompilierung unter EF Core 10.0.11 mit `System.Diagnostics.UnreachableException: IdentifierName of type ParameterSymbol: text` scheitern. Kopiert man den Parameter zuerst in eine lokale Variable, wird dieselbe Abfrage sauber vorkompiliert. Behalten Sie die lokale Variable, bis das upstream behoben ist.

**Schritt 2: Interceptors aktivieren und das Modell erzeugen.** Ergänzen Sie die Eigenschaft in der Bibliothek:

```xml
<!-- Notes.Data.csproj, EF Core 10.0.11 -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
</PropertyGroup>
```

Ohne sie schlägt der Build mit `CS9137: The 'interceptors' feature is not enabled in this namespace` fehl. Falls Ihnen dieser Code bekannt vorkommt: Es ist dieselbe Aktivierung, über die Leute bei [den Interceptors des OpenAPI Source Generators](/de/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/) stolpern.

Dann, aus dem Verzeichnis der Bibliothek:

```bash
dotnet ef dbcontext optimize --output-dir CompiledModels --namespace Notes.Data.CompiledModels --precompile-queries --nativeaot
```

Bei Erfolg gibt es aus:

```text
Successfully generated a compiled model, it will be discovered automatically, but you can also
call 'options.UseModel(Notes.Data.CompiledModels.NotesContextModel.Instance)'.
Run this command again when the model is modified.
```

Dieses "discovered automatically" ist ein Verhalten ab EF Core 9: Der Generator schreibt `[assembly: DbContextModel(typeof(NotesContext), typeof(NotesContextModel))]` in `NotesContextAssemblyAttributes.cs`, und EF findet es, solange das Attribut in derselben Assembly liegt wie der `DbContext`. In EF Core 8 gibt es kein Attribut, und Sie müssen `UseModel` selbst aufrufen.

**Schritt 3: Bei jeder Codeänderung neu erzeugen.** C# Interceptors sind an Quellcodepositionen gebunden, jede Änderung in der Bibliothek macht sie ungültig. Die EF Dokumentation ist da deutlich: Die Erzeugung der Interceptors "isn't expected to happen in the inner loop". Für eine echte App fügen Sie das Paket [`Microsoft.EntityFrameworkCore.Tasks`](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks) (10.0.11) zur Bibliothek hinzu, damit MSBuild das beim Veröffentlichen erledigt, statt sich darauf zu verlassen, dass jemand an den CLI Befehl denkt. Ich habe den CLI Weg vollständig verifiziert; die MSBuild Integration ist das, was die Dokumentation für CI empfiehlt.

Mit allen drei Teilen fügt meine Konsolenanwendung mit `DynamicCodeSupport=false` eine Zeile ein, listet Zeilen auf und führt eine parametrisierte Suche aus, ohne Exception.

## Lösung 2: den Interpreter wieder einschalten

Sehen Sie sich die macios Bedingung noch einmal an: `MtouchInterpreter` oder `UseInterpreter` zu setzen, unterdrückt `DynamicCodeSupport=false` vollständig, sodass EF Core sein Modell zur Laufzeit genauso aufbaut wie unter Android.

```xml
<!-- MAUI app csproj -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <UseInterpreter>true</UseInterpreter>
</PropertyGroup>
```

Das ist eine legitime Konfiguration, kein Trick: Der IL Interpreter von Mono ist kein JIT, und Apple erlaubt ihn. Bezahlt wird mit Durchsatz und Startzeit, denn interpretierter Code ist langsamer als AOT kompilierter, und das Modell wird bei der ersten Nutzung weiterhin per Reflexion aufgebaut. Nutzen Sie das, um ein Release freizubekommen, und setzen Sie danach Lösung 1 um.

Zwei Einschränkungen. Der Interpreter deaktiviert außerdem das IL Stripping (`EnableAssemblyILStripping` wird auf `false` gezwungen, sobald `MtouchInterpreter` gesetzt ist), Ihr App Bundle wächst also. Und es ist eine Mono Funktion: Die macios Targets geben die Warnung "The property 'UseInterpreter' has no effect when not using the Mono runtime (for instance when using CoreCLR)" aus. Das ist für die Zukunft relevant, denn [MAUI Mobile läuft ab .NET 11 Preview 6 nur noch auf CoreCLR](/de/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/). Behandeln Sie diese Lösung als Brücke für .NET 10, nicht als langfristigen Plan.

## Lösung 3: DynamicCodeSupport wieder auf true zwingen

```xml
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <DynamicCodeSupport>true</DynamicCodeSupport>
</PropertyGroup>
```

Die Bedingung in der macios Zeile beginnt mit `'$(DynamicCodeSupport)' == ''`, ein expliziter Wert gewinnt also, und der Schalter landet als `true` in der `runtimeconfig.json`. EF Core wirft danach nicht mehr.

Ich führe das aus gutem Grund zuletzt auf. Der Schalter ist nicht dekorativ: Er sagt dem Trimmer, dass er die dynamischen Codepfade entfernen darf, und genau darum ging es in [PR #18555](https://github.com/dotnet/macios/pull/18555). Ihn auf `true` zu setzen, während die App weiterhin vollständig AOT kompiliert ist, belügt die Laufzeit, und Sie verlassen sich darauf, dass jede Bibliothek in Ihrem Abhängigkeitsgraphen eine Umgebung toleriert, die eine Unterstützung für dynamischen Code behauptet, die sie nicht hat. Wenn Sie sich schon damit befasst haben, [was trimmingsicherer Code tatsächlich verlangt](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/), erkennen Sie die Form des Risikos. Nutzen Sie es zur Diagnose, nicht zum Ausliefern.

## EnsureCreated und Migrate werfen weiterhin, nachdem das Modell behoben ist

Das ist der Schritt, der die meisten MAUI Apps erwischt, denn der übliche SQLite Start ist ein Aufruf von `EnsureCreated()` im App Konstruktor. Mit vorhandenem kompilierten Modell und `IsDynamicCodeSupported = false` werfen beide:

```text
EnsureCreated: InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
Migrate:       InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
```

Sehen Sie sich den `CreateModel` Ausschnitt noch einmal an: Ein kompiliertes Modell ist ein `RuntimeModel`, kein `Metadata.Internal.Model`, deshalb nimmt jeder Codepfad, der das Entwurfszeitmodell anfordert, den Zweig `NativeAotDesignTimeModel`. Die Schemaerstellung braucht das Entwurfszeitmodell, um DDL zu erzeugen, kann also nicht aus einem kompilierten Modell arbeiten. Das ist eine weitere Regression von EF Core 9: Ich habe denselben `EnsureCreated()` Aufruf mit ausgeschaltetem Schalter gegen EF Core 8.0.21 ausgeführt, und er hat die Datenbank ohne Beanstandung erstellt.

Der Ausweg besteht darin, die App nicht mehr DDL berechnen zu lassen. Erzeugen Sie das SQL einmal auf dem Host und führen Sie es als Text aus:

```bash
dotnet ef migrations script -o Migrations.sql
```

```csharp
// .NET 10, EF Core 10.0.11 - runs fine with IsDynamicCodeSupported = false
using var db = new NotesContext();
db.Database.ExecuteSqlRaw(await File.ReadAllTextAsync(scriptPath));
```

Liefern Sie `Migrations.sql` als MAUI Raw Asset aus und führen Sie es beim ersten Start aus. Beachten Sie, dass SQLite `--idempotent` nicht unterstützt; `dotnet ef migrations script --idempotent` scheitert mit "Generating idempotent scripts for migrations is not currently supported for SQLite". Verfolgen Sie die angewendete Migration also selbst oder sichern Sie das Skript mit `CREATE TABLE IF NOT EXISTS` ab. Dieselbe Überlegung, ein Skript zu übergeben statt `Migrate()` auszuführen, gilt auch, wenn [ein Migrationslogin die Datenbank nicht anlegen kann](/de/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/), aus anderen Gründen.

## Was sich zwischen EF Core 8, 9 und 10 geändert hat

Wenn Ihre App unter iOS früher allein mit einem kompilierten Modell lief und nach einem EF Core Update erneut kaputtging, liegt es daran. Ich habe denselben Code mit `DynamicCodeSupport=false` und kompiliertem Modell, aber ohne vorkompilierte Abfragen, gegen drei EF Core Versionen ausgeführt:

| EF Core | Erkennung des kompilierten Modells | `EnsureCreated()` | Einfache LINQ Abfrage |
| --- | --- | --- | --- |
| 8.0.21 | `UseModel(...)` erforderlich | funktioniert | funktioniert |
| 9.0.19 | automatisch | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |
| 10.0.11 | automatisch | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |

In EF Core 8 kompilierte die Abfragepipeline LINQ noch zur Laufzeit, und der Ausdrucksinterpreter trug das. Ab EF Core 9 stützt sich der Compiler auf denselben Schalter, in [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs):

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, QueryCompiler.ExecuteAsync
var compiledQuery
    = _compiledQueryCache
        .GetOrAddQuery(
            _compiledQueryCacheKeyGenerator.GenerateCacheKey(queryAfterExtraction, async),
            () => RuntimeFeature.IsDynamicCodeSupported
                ? CompileQueryCore<TResult>(_database, queryAfterExtraction, _model, async)
                : throw new InvalidOperationException(CoreStrings.QueryNotPrecompiled));
```

Es gibt keinen AppContext Schalter, der das alte Verhalten zurückholt. In EF Core 8 genügte ein kompiliertes Modell; ab EF Core 9 brauchen Sie zusätzlich vorkompilierte Abfragen.

## Ähnlich aussehende Fehler

`Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` bedeutet, dass das kompilierte Modell gefunden wurde und die Abfrage nicht. Prüfen Sie, ob die Abfrage in dem Projekt liegt, gegen das Sie `optimize --precompile-queries` ausgeführt haben, und ob die erzeugte Datei `*.EFInterceptors.*.cs` mitkompiliert wird.

`Dynamic LINQ queries are not supported when precompiling queries.` stammt vom optimize Befehl, nicht von der App. Es bedeutet, dass die Abfrage über mehrere Anweisungen zusammengesetzt wird (`query = query.Where(...)` innerhalb eines `if`). Schreiben Sie sie als zwei vollständige Abfragen hinter einem bedingten Ausdruck um, so wie es die Dokumentation ausdrücklich zeigt.

`Design-time DbContext operations are not supported when publishing with NativeAOT.` steht für `EnsureCreated`, `Migrate`, `GenerateCreateScript` oder ein Entwurfszeitwerkzeug, das gegen eine Konfiguration mit ausgeschaltetem Schalter läuft. Beachten Sie, dass das auch `dotnet ef` selbst blockiert: `dotnet ef dbcontext optimize` in einem Projekt mit `DynamicCodeSupport=false` scheitert an derselben NativeAOT Fehlerfamilie, und genau dieses Henne Ei Problem macht die separate Klassenbibliothek nötig.

`PlatformNotSupportedException` beim Start einer getrimmten oder AOT App ist ein anderer Fehler mit anderer Ursache; siehe die Hinweise zu [PlatformNotSupportedException unter Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/).

## Verwandt

- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/) behandelt den Kompromiss, den dieser Schalter ermöglichen soll.
- [MAUI Mobile läuft in .NET 11 Preview 6 nur noch auf CoreCLR](/de/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/) erklärt, warum der Interpreter Notausgang ein Ablaufdatum hat.
- [Was ist trimmingsicherer Code und wie schreibe ich ihn?](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) liefert den Hintergrund dazu, warum das Überschreiben des Schalters riskant ist.
- [Lösung: Das Feature 'interceptors' ist in diesem Namespace nicht aktiviert](/de/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/) behandelt das CS9137, auf das Sie in Schritt 2 stoßen.
- [Lösung: CREATE DATABASE permission denied in database 'master'](/de/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/) ist der andere Fall, in dem ein ausgeliefertes SQL Skript besser ist als ein Aufruf von `Migrate()`.

## Quellen

- [NativeAOT Unterstützung und vorkompilierte Abfragen](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries), EF Core Dokumentation, inklusive der Aktivierung von `InterceptorsNamespaces`, dem Paket `Microsoft.EntityFrameworkCore.Tasks` und der Einschränkung bei dynamischen Abfragen.
- [Kompilierte Modelle](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models), EF Core Dokumentation, zu `dotnet ef dbcontext optimize` und den Grenzen des kompilierten Modells.
- [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs) und [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs) in `dotnet/efcore`, für beide Prüfungen von `RuntimeFeature.IsDynamicCodeSupported`.
- [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) in `dotnet/macios`, für den Standardwert von `DynamicCodeSupport` und die Interpreter Bedingungen.
- [dotnet/macios PR #18555](https://github.com/dotnet/macios/pull/18555), der die Eigenschaft eingeführt hat.
- [dotnet/maui#23653](https://github.com/dotnet/maui/issues/23653) und [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595), die ursprünglichen Meldungen, die die Regression auf das Workload Update eingrenzen.
