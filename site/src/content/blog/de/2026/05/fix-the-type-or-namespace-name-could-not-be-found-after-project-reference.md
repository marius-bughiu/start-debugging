---
title: "Fix: The type or namespace name 'X' could not be found (nach Hinzufügen einer ProjectReference)"
description: "CS0246 direkt nach einer frischen ProjectReference liegt fast immer an einem TargetFramework-Mismatch, einem veralteten obj/-Ordner oder einer fehlenden using-Direktive. Fünf Lösungen, nach Wahrscheinlichkeit geordnet."
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "csproj"
lang: "de"
translationOf: "2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference"
translatedBy: "claude"
translationDate: 2026-05-11
---

Die Lösung: in neun von zehn Fällen zielt Ihr konsumierendes Projekt auf ein niedrigeres `TargetFramework` als das referenzierte Projekt (sodass das SDK-Pack gar nicht erst versucht, das Assembly aufzulösen), die Verzeichnisse `obj/` und `bin/` des vorherigen Builds zeigen noch auf das falsche Reference Assembly, oder der Typ wurde sauber kompiliert, aber an der Aufrufstelle fehlt eine `using`-Direktive. Öffnen Sie beide `.csproj`-Dateien, gleichen Sie die `TargetFramework`-Werte ab, führen Sie `dotnet build --no-incremental` aus (oder löschen Sie `obj/` und `bin/` unter Windows von Hand) und schauen Sie erst danach auf die `using`-Direktiven. Der Text der Exception und ihre Ursache haben sich zwischen .NET 6 und .NET 11 preview 4 nicht geändert, daher gilt dieselbe Checkliste für jedes moderne SDK-Style-Projekt.

```text
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?)
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'MyApp.Domain' (are you missing an assembly reference?)
```

Die beiden Codes teilen dieselbe Ursache entlang einer schmalen Linie: `CS0246` bedeutet, dass der Compiler einen Top-Level-Typ über seinen Kurznamen nicht findet; `CS0234` bedeutet, dass der Compiler den Namespace gefunden hat, das verschachtelte Mitglied aber nicht sehen konnte. Beide werden ausgelöst, sobald der C#-Compiler Roslyn nach einem Symbol fragt, das der Metadata-Reader nicht auflösen kann, was in einem SDK-Style-Build geschieht, nachdem MSBuild die Referenzliste fertig zusammengestellt hat. Ist diese Liste falsch, ist der Compiler die falsche Ebene zum Debuggen.

Dieser Leitfaden ist gegen .NET SDK 11.0.100-preview.4, MSBuild 17.13 und Roslyn 4.13 geschrieben. Das Verhalten ist identisch unter .NET 8 LTS und .NET 10. Die Fehlercodes des Compilers sind seit dem Erscheinen von Roslyn stabil, sodass die Lösungen für jede C#-Version ab 7.0 gelten.

## Warum der Compiler den Typ nach einer `ProjectReference` nicht sieht

Es gibt fünf wiederkehrende Ursachen, und sie sollten in dieser Reihenfolge geprüft werden. Die ersten drei machen den allergrößten Teil des Suchverkehrs aus, der auf die obige exakte Meldung trifft.

1. **TargetFramework-Mismatch.** Ihr Consumer ist `net8.0` und das referenzierte Projekt ist `net11.0`, oder Ihr Consumer ist `netstandard2.0` und das referenzierte Projekt ist `net8.0`. MSBuild verhält sich hier richtig und weigert sich, die Referenz zu verdrahten, aber die Warnung (`NU1201` von NuGet oder `NETSDK1005` vom SDK) lässt sich leicht im Build-Output übersehen. Der C#-Fehler, der danach feuert, ist CS0246, also genau das Symptom, das Sie bemerkt haben.
2. **Veraltete `obj/`- und `bin/`-Ordner.** Inkrementelle Builds in MSBuild sind aggressiv. Nach einer Änderung an einer `.csproj` können die Assets-Datei (`obj/project.assets.json`) und die Response-Dateien (`obj/*.csproj.AssemblyReference.cache`) im Widerspruch zum neuen Graphen stehen. Roslyn kompiliert fröhlich gegen den alten Referenzsatz und Sie erhalten CS0246 für einen Typ, der auf der Platte existiert.
3. **Fehlende `using`-Direktive.** Sie haben die Referenz korrekt hinzugefügt, der Typ existiert und der Build ist sauber, aber die Aufrufstelle importiert den Namespace nicht. Mit aktivierten `ImplicitUsings` ist das für die BCL selten, aber für Ihre eigenen Namespaces die Regel. Der Hinweis des Compilers am Ende von CS0246, `(are you missing a using directive or an assembly reference?)`, nennt diese Option aus gutem Grund zuerst.
4. **Das Projekt ist nicht in der Solution.** Visual Studio und `dotnet build <solution>` kompilieren nur Projekte, die die `.sln`-Datei kennt. Sie können eine `ProjectReference` zu einer `.csproj` hinzufügen, die nicht in der Solution ist, und der Consumer wird den Typ nicht finden, weil der Producer nie gebaut wurde. `dotnet build <consumer.csproj>` gelingt, weil es den Projektgraphen direkt durchläuft; die IDE scheitert, weil sie die Solution durchläuft.
5. **`ReferenceOutputAssembly="false"` oder `PrivateAssets="all"` an der Referenz.** Beide sind legitime Metadaten-Items, die genutzt werden, um den transitiven Fluss zu unterdrücken oder reine Build-Time-Referenzen wie Analyzer zu übergeben, aber jedes davon weist MSBuild an, das produzierte Assembly nicht in die Referenzliste des Compilers aufzunehmen. Die IDE zeigt das Projekt im Solution Explorer oft als referenziert an, was diesen Fall am schwierigsten zu entdecken macht.

Es gibt seltenere Ursachen, die es wert sind, benannt zu werden, damit Sie sie per Augenschein ausschließen können: ein case-sensitives Dateisystem (Linux, macOS), bei dem die `using`-Direktive die Groß-/Kleinschreibung des Namespaces nicht exakt trifft; eine `Conditional`-ItemGroup, die die Referenz für die aktuelle `Configuration` oder das aktuelle `TargetFramework` ausschließt; ein Multi-Target-Consumer (`<TargetFrameworks>net8.0;net11.0</TargetFrameworks>`), bei dem nur einer der inneren Builds die Referenz aufnimmt; und eine global.json, die eine SDK-Version festschreibt, die älter ist als das minimal nötige `TargetFramework` des Consumers.

## Der Fehler im Kontext

So sieht der Build-Output aus, wenn die TargetFramework-Ursache feuert. Achten Sie auf die Zeilen vor dem CS0246, nicht auf das CS0246 selbst:

```text
warning NU1201: Project Domain is not compatible with net8.0 (.NETCoreApp,Version=v8.0). Project Domain supports: net11.0 (.NETCoreApp,Version=v11.0)
warning MSB3277: Found conflicts between different versions of "System.Runtime" that could not be resolved.
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?) [C:\src\Api\Api.csproj]
```

`NU1201` ist der entscheidende Hinweis. Der NuGet-Restore-Schritt hat das Projekt gefunden, es aber abgelehnt, weil die Target-Framework-Menge nichts enthält, was der Consumer konsumieren kann. Der Compiler lief dann mit einer leeren Referenz für dieses Projekt. Das CS0246 ist Folge, nicht Ursache.

## Minimal-Reproduktion

Die kleinste Zwei-Projekt-Konstellation, die den TargetFramework-Mismatch reproduziert. Speichern Sie als `Domain/Domain.csproj` und `Api/Api.csproj`:

```xml
<!-- Domain/Domain.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```xml
<!-- Api/Api.csproj - .NET 8 LTS consumer of a net11.0 library -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Domain\Domain.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Domain/OrderService.cs - .NET 11 preview 4
namespace MyApp.Domain;

public sealed class OrderService
{
    public string Greet(int id) => $"order-{id}";
}
```

```csharp
// Api/Program.cs - .NET 8 LTS
using MyApp.Domain;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<OrderService>();

var app = builder.Build();
app.MapGet("/", (OrderService svc) => svc.Greet(1));
app.Run();
```

Führen Sie `dotnet build Api/Api.csproj` aus und Sie erhalten exakt das Fehlerpaar aus dem vorherigen Abschnitt. Das CS0246 ist laut; die `NU1201`-Warnung darüber ist der eigentliche Fehler.

## Lösung eins: TargetFramework-Werte abgleichen

Der sicherste Schritt ist, den Consumer hochzuziehen statt die Bibliothek herunterzustufen, weil Herunterstufen typischerweise APIs verliert:

```xml
<!-- Api/Api.csproj - now .NET 11 to match the library -->
<TargetFramework>net11.0</TargetFramework>
```

Wenn Sie den Consumer nicht bewegen können, geben Sie der Bibliothek mehrere Targets, damit sie ein Assembly für beide liefert:

```xml
<!-- Domain/Domain.csproj -->
<TargetFrameworks>net8.0;net11.0</TargetFrameworks>
```

Für wirklich Framework-neutrale Bibliotheken ist `netstandard2.0` immer noch das breiteste Target und ist konsumierbar von .NET Framework 4.7.2+, Mono, Unity und jedem modernen .NET. Wählen Sie `netstandard2.0` nur, wenn die API-Fläche hineinpasst; sonst ist Multi-Targeting auf `net8.0` + `net11.0` 2026 die sauberere Option.

Ein Hinweis zu `<TargetFrameworks>` mit nur einem Wert: schreiben Sie `<TargetFramework>` (Singular). MSBuild behandelt sie als unterschiedliche Properties, und ein Projekt mit `<TargetFrameworks>net8.0</TargetFrameworks>` baut nach `bin/<config>/net8.0/` statt nach `bin/<config>/`, was nachgelagerte Tools, die das flache Layout annehmen, stillschweigend bricht.

## Lösung zwei: `obj/` und `bin/` nach einer `.csproj`-Änderung wegblasen

Wenn die Frameworks passen, der Fehler aber bleibt, ist der Build-Cache veraltet. Roslyn liest `obj/<project>.csproj.AssemblyReference.cache` und das pro-Projekt `*.GeneratedMSBuildEditorConfig.editorconfig`, um die Referenzauflösung abzukürzen. Wenn Sie die `.csproj` ändern, um die `ProjectReference` hinzuzufügen, während ein früherer Build noch resident ist, widerspricht der Cache dem neuen Graphen und der Compiler läuft gegen die alte Referenzliste.

Der richtige Reset unter .NET 11 ist `dotnet build --no-incremental` für einen einmaligen sauberen Rebuild oder, in den seltenen Fällen, in denen das nicht reicht, entfernen Sie die Build-Ordner manuell:

```powershell
# .NET SDK 11.0.100-preview.4, PowerShell on Windows
Get-ChildItem -Path . -Include obj,bin -Recurse -Directory | Remove-Item -Recurse -Force
dotnet build
```

```bash
# .NET SDK 11.0.100-preview.4, bash on Linux/macOS
find . -type d \( -name obj -o -name bin \) -prune -exec rm -rf {} +
dotnet build
```

`dotnet clean` ist absichtlich konservativ: es entfernt die Outputs, behält aber die Assets-Datei, was bedeutet, dass es diese Bug-Klasse nicht immer kuriert. Behandeln Sie es als Teil-Reset, nicht als Voll-Reset. Wenn parallel eine IDE läuft, schließen Sie sie vor dem Löschen von `obj/`, weil der Language Service unter Windows offene Dateihandles hält und das Löschen die Hälfte der Verzeichnisse fehlschlagen lässt.

## Lösung drei: `using`-Direktive ergänzen oder korrigieren

Sobald die Referenz gesund ist, findet der Compiler den Typ, aber Sie müssen den Namespace an der Aufrufstelle weiterhin importieren. Die Lösung ist mechanisch:

```csharp
// Api/Program.cs - .NET 11 preview 4
using MyApp.Domain;        // the namespace declared inside Domain/OrderService.cs
// using MyApp.Domain.Models; // for the CS0234 variant where you also need the nested namespace
```

Zwei Feinheiten beißen Teams in jedem Release. Erstens fügt `<ImplicitUsings>enable</ImplicitUsings>` eine feste Menge an Namespaces hinzu (`System`, `System.Collections.Generic`, `System.Linq`, `System.Net.Http`, `System.Threading`, `System.Threading.Tasks` plus SDK-spezifische Extras), importiert aber Ihre eigenen Namespaces nicht. Zweitens können Sie seit C# 10 globale Usings deklarieren, um diese Lücke zu füllen:

```xml
<!-- Api/Api.csproj - .NET 11 preview 4 -->
<ItemGroup>
  <Using Include="MyApp.Domain" />
</ItemGroup>
```

Das erzeugt eine `GlobalUsings.g.cs` in `obj/` und spart die pro-Datei-`using`-Zeile überall dort, wo `OrderService` konsumiert wird. Der Preis: globale Usings machen Refactorings lauter. Ein Tippfehler in einem globalen Namespace bricht das gesamte Projekt, und eine entfernte Bibliothek versteckt sich nun als einzelne MSBuild-Änderung statt als Welle roter Unterstriche. Setzen Sie sie bewusst ein, nicht reflexhaft.

## Lösung vier: bestätigen, dass das Projekt in der Solution ist

`dotnet sln list` ist der schnellste Weg zur Prüfung. Wenn Ihr Consumer `Api/Api.csproj` und Ihre Bibliothek `Domain/Domain.csproj` ist, müssen beide in der `.sln` auftauchen:

```bash
# .NET SDK 11.0.100-preview.4
dotnet sln list
# Project(s)
# ----------
# Api\Api.csproj
# Domain\Domain.csproj   <-- must be here
```

Fehlt `Domain`, wird die IDE so tun, als wisse sie davon (weil die `ProjectReference` es auf Platte auflöst), aber Solution-bezogene Builds überspringen es, und ein Einzel-Projekt-Rebuild scheitert dann, weil die `obj/project.assets.json` des Consumers ein Assembly referenziert, das niemand produziert hat. Fügen Sie das fehlende Projekt hinzu:

```bash
dotnet sln add Domain/Domain.csproj
```

Diese Falle ist 2026 häufiger als noch, als `slnx` und das neue leichte Solution-Format mit dem .NET 11 SDK kamen. Die CLI toleriert das Bauen einer Solution, die Projekte mit disjunkten Referenzgraphen listet, und die Language Services in Visual Studio 2026 und Rider 2026.1 sind besser darin geworden, zu warnen, wenn ein referenziertes Projekt außerhalb der aktiven Solution liegt. Auf einem älteren SDK ist die Warnung still. Zur Ergonomie von Solution-Dateien generell lohnt sich ein Blick auf die neue CLI: siehe [die dotnet sln CLI-Verbesserungen in .NET 11](/de/2026/04/dotnet-11-sln-cli-solution-filters/).

## Lösung fünf: `ReferenceOutputAssembly` und `PrivateAssets` prüfen

Manche Referenzen werden absichtlich nicht an den Compiler weitergegeben. Die zwei Metadaten-Items, die an der `ProjectReference` zu prüfen sind:

```xml
<!-- Will NOT add Domain.dll to the compiler's reference list -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  ReferenceOutputAssembly="false" />

<!-- Will not flow transitively to projects that consume the consumer -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  PrivateAssets="all" />
```

`ReferenceOutputAssembly="false"` ist korrekt, wenn das referenzierte Projekt ein Build-Time-Tool (ein Code-Generator, ein Analyzer-Host) ist, dessen Output Sie in den Build-Graphen einsequenzieren wollen, dessen Assembly Sie aber nicht konsumieren. Steht es an Ihrer tatsächlichen Bibliotheksreferenz, scheitert der Consumer mit CS0246, obwohl der Build-Graph sonst gesund ist.

`PrivateAssets="all"` ist der symmetrische Fall für transitive Referenzen. Wenn `Api` `Bff` referenziert und `Bff` `Domain` mit `PrivateAssets="all"` referenziert, dann kann `Api` keine Typen aus `Domain` sehen, obwohl `Bff` es kann. Der Hinweis steckt im konsumierenden Projekt, nicht im produzierenden.

## Varianten, die wie derselbe Fehler aussehen

Eine Handvoll benachbarter Fehler werden in den Suchergebnissen mit CS0246 verwechselt:

- **`CS1069`: The type name 'X' could not be found in the namespace 'Y'. This type has been forwarded to assembly 'Z'.** Ein Type-Forwarder fehlt. Fügen Sie das in der Meldung genannte Assembly hinzu. Das ist am häufigsten bei `System.Configuration.ConfigurationManager` und `System.Drawing.Common` unter modernem .NET.
- **`CS8073` / `CS0518`: Predefined type 'System.Object' is not defined or imported.** Die implizite `System.Runtime`-Referenz ist kaputt. Fast immer ein korruptes `obj/` oder eine handgeschriebene `<Reference>`, die das Framework ausschließt. `dotnet build --no-incremental` ist die erste Maßnahme.
- **`CS0433`: The type 'X' exists in both 'A' and 'B'.** Zwei Assemblies stellen denselben Typ bereit. Lösen Sie das mit einem Alias an der `ProjectReference` (`<ProjectReference Include="..." Aliases="domain" />`) und einer `extern alias`-Direktive an der Aufrufstelle.
- **`NETSDK1005`: Assets file '...' doesn't have a target for 'net8.0'.** Die Referenz zeigt auf ein NuGet-Paket, das für ein höheres Framework als der Consumer kompiliert wurde. Dieselbe Ursache wie Lösung eins oben, andere Meldung, weil der Producer ein Paket statt eines Projekts ist.
- **`MSB4181`: The "ResolvePackageAssets" task returned false but did not log an error.** Ein echter Restore-Fehler; der Paketgraph ist nicht auflösbar. Löschen Sie den globalen Cache `~/.nuget/packages/<name>/<version>/` für das betroffene Paket und restoren Sie neu. Behandeln Sie das als orthogonal zu CS0246, auch wenn beide oft gemeinsam auftreten.

## Wie man den Build-Output liest, um die Lösung zu bestätigen

Lenken Sie Ihr Debugging vom C#-Fehlerlisten- auf das Build-Log um. Der Compiler ist der falsche Startpunkt, wenn die Referenzauflösung kaputt ist. Drei Befehle verdienen ihren Platz:

```bash
# .NET SDK 11.0.100-preview.4
dotnet build -v:n Api/Api.csproj
```

`-v:n` (`-verbosity normal`) druckt die aufgelöste Referenzliste unter `CoreCompile -> ResolveReferences`. Steht Ihre Bibliothek nicht in dieser Liste, hat der Compiler sie nie gesehen und Sie haben ein MSBuild-Problem, kein Roslyn-Problem.

```bash
dotnet build -bl Api/Api.csproj
```

`-bl` schreibt eine `msbuild.binlog` neben das Projekt. Öffnen Sie sie im [MSBuild Structured Log Viewer](https://msbuildlog.com/) und suchen Sie nach `ResolveAssemblyReferences`. Der Viewer zeigt exakt, welche Dateipfade MSBuild an Roslyn übergeben hat und warum jeder davon aufgenommen oder übersprungen wurde.

```bash
dotnet msbuild Api/Api.csproj -t:ResolveReferences -p:DesignTimeBuild=false
```

Das führt das Target zur Referenzauflösung isoliert aus, ohne den Compiler anzustoßen. Die Ausgabe ist knapp und sagt Ihnen, ob der Fehler im Restore, in der Auflösung oder in der Kompilation steckt. CS0246 verschwindet aus dem Rauschen.

## Randfälle, die erfahrene Entwickler erwischen

Einige Muster reproduzieren CS0246 in Code, der bei der Inspektion korrekt wirkt:

- **`Directory.Packages.props` mit `ManagePackageVersionsCentrally=true`.** Wenn Sie vergessen haben, einen `<PackageVersion>`-Eintrag für ein transitives Paket hinzuzufügen, das Ihre Bibliothek in der API exponiert, kann der Consumer den Typ aus der transitiven Abhängigkeit nicht auflösen. Die Meldung ist CS0246, nicht der Missing-Version-Fehler, den Sie erwarten würden.
- **Multi-Targeting mit `Condition`.** `<ProjectReference Include="..." Condition="'$(TargetFramework)' == 'net11.0'" />` überspringt die Referenz für den `net8.0`-Innen-Build eines Multi-Target-Consumers. Die IDE zeigt die Referenz; der `net8.0`-Build sieht den Typ nicht.
- **`global.json` fixiert ein SDK, dem Ihr `TargetFramework` fehlt.** Wenn `global.json` SDK 8.0.x auswählt und das Projekt auf `net11.0` zielt, meldet der Restore eine harmlose Warnung, der Build scheitert mit CS0246 für jeden Typ der referenzierten Bibliothek, weil die SDK-Packs für `net11.0` nicht installiert sind.
- **Linux-Case-Sensitivity.** `using MyApp.domain;` statt `using MyApp.Domain;` kompiliert unter Windows und scheitert mit CS0246 in CI unter Linux. Fügen Sie `<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>` hinzu und fixieren Sie die Schreibweise per `.editorconfig`-Regel.
- **Native-AOT-Consumer.** Wenn `<PublishAot>true</PublishAot>` am Consumer, aber nicht an der Bibliothek gesetzt ist, markiert der AOT-Analyzer die transitiven Trim-Warnungen als Fehler und der Build kann bei einem nachgelagerten CS0246 stoppen, sobald ein Typ getrimmt wurde. Die Lösung ist, die Bibliothek trim-safe zu machen, nicht den Analyzer zum Schweigen zu bringen. Dieselbe Trim-Disziplin, die der [Beitrag zur PlatformNotSupportedException im Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/) behandelt, gilt auch hier.

## Verwandt

- Die nächste Referenzauflösungs-Exception, in die Teams nach dieser laufen, ist die Laufzeitvariante, die in [Unable to resolve service for type 'X' while attempting to activate 'Y'](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) behandelt wird.
- Solution-Datei-Ergonomie, die diese Bug-Klasse leichter erkennbar macht: [die dotnet sln CLI-Änderungen in .NET 11](/de/2026/04/dotnet-11-sln-cli-solution-filters/).
- Die Native-AOT-Eckfälle, die CS0246 indirekt über Trimming auslösen: [PlatformNotSupportedException im Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/).
- Eine Build-Warnungs-Politik, die verhindert, dass stille `NU1201`-Warnungen unter grünem CI verschwinden: [TreatWarningsAsErrors ohne Sabotage von Dev-Builds](/de/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).
- Wenn der fehlende Typ ein Konfigurationswert ist und die Meldung sinngemäß ähnlich klingt: [no connection string named 'DefaultConnection' could be found](/de/2026/05/fix-no-connection-string-named-defaultconnection/).

## Quellen

- Microsoft Learn, [Compiler Error CS0246](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0246).
- Microsoft Learn, [Compiler Error CS0234](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0234).
- Microsoft Learn, [MSBuild ProjectReference protocol](https://learn.microsoft.com/en-us/visualstudio/msbuild/common-msbuild-project-items#projectreference).
- Microsoft Learn, [Implicit using directives in .NET 6+](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/overview#implicit-using-directives).
- Microsoft Learn, [global.json overview](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json).
- MSBuild source, [`Microsoft.Common.CurrentVersion.targets`](https://github.com/dotnet/msbuild/blob/main/src/Tasks/Microsoft.Common.CurrentVersion.targets), where `ResolveProjectReferences` lives.
