---
title: "Lösung: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design"
description: "Fügen Sie Microsoft.EntityFrameworkCore.Design dem Startprojekt hinzu, das dotnet ef kompiliert, nicht dem Projekt mit Ihrem DbContext, und übergeben Sie -s in geschichteten Solutions."
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
lang: "de"
translationOf: "2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design"
translatedBy: "claude"
translationDate: 2026-07-30
---

Fügen Sie das Paket dem **Startprojekt** hinzu, also dem Projekt, das `dotnet ef` kompiliert und ausführt, nicht der Klassenbibliothek mit Ihrem `DbContext`: `dotnet add package Microsoft.EntityFrameworkCore.Design`. In einer geschichteten Solution teilen Sie den Tools zusätzlich mit, welches Projekt das ist: `-s ./src/Api`. Seit `Microsoft.EntityFrameworkCore.Tools` 10.0.6 wird das Design-Paket nicht mehr automatisch mitgezogen.

```text
Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design. This package is required for the Entity Framework Core Tools to work. Ensure your startup project is correct, install the package, and try again.
```

Dieser Artikel bezieht sich auf EF Core 11.0.0-preview.6 (`11.0.0-preview.6.26359.118`, 2026-07-14), das .NET 11 SDK Preview 6 und C# 14, mit Hinweisen zu EF Core 9 und 10 dort, wo sich die Tools anders verhalten. Die aktuelle stabile Linie ist 10.0.10. Der Fehlertext selbst hat sich seit EF Core 2.1 nicht verändert, aber **wie** die Tools entscheiden, dass das Paket fehlt, hat sich in EF Core 10 deutlich geändert, und das bestimmt, welche der folgenden Lösungen für Sie gilt.

## Worüber sich die Tools tatsächlich beschweren

Die Meldung liest sich wie eine statische Prüfung Ihrer `.csproj`. Sie ist es nicht. Sie ist ein Ladefehler, der nachträglich gemeldet wird.

Das ist die tatsächliche Abfolge, wenn Sie `dotnet ef migrations add Init` ausführen:

1. `dotnet-ef` führt einen Metadaten-Build des Startprojekts aus. In EF Core 10 und 11 ist das `dotnet build --no-restore /getProperty:AssemblyName /getProperty:OutputPath ... /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems`.
2. Es durchsucht die zurückgegebenen `RuntimeCopyLocalItems` nach einem `FullPath`, der `Microsoft.EntityFrameworkCore.Design` enthält, und behält diesen absoluten Pfad.
3. Es kompiliert das Startprojekt und ruft dann `ef.dll` auf, wobei es den gefundenen Pfad als `--design-assembly` übergibt, gemeinsam mit den Dateien `.deps.json` und `.runtimeconfig.json` des Projekts, damit der Tool-Prozess das Laden der Assemblies Ihrer Anwendung nachbildet.
4. `ef.dll` lädt `Microsoft.EntityFrameworkCore.Design.dll` in einen `AssemblyLoadContext`: aus diesem Pfad, falls einer vorliegt, andernfalls über den reinen Assemblynamen.
5. Wirft Schritt 4 eine `FileNotFoundException` und ist der Name der fehlenden Assembly genau `Microsoft.EntityFrameworkCore.Design`, so schluckt das Tool die Ausnahme und gibt die freundliche Meldung von oben aus, unter Nennung der Start-Assembly.

Daraus folgen unmittelbar zwei Dinge. Erstens ist das in der Meldung genannte Projekt das **Startprojekt**. Überrascht Sie dieser Name, liegt Ihr Problem in Schritt 1 und nicht bei einem fehlenden Paket. Zweitens ist ein `PackageReference`, der existiert, aber kein kopiertes Laufzeit-Asset erzeugt, für Schritt 2 unsichtbar. Genau deshalb kleben Leute ihre `.csproj` in Issue-Berichte und beharren darauf, dass das Paket doch da ist.

EF Core 9 und früher arbeiteten anders: `dotnet-ef` injizierte eine eingebettete Datei `EntityFrameworkCore.targets` in das Projekt, und `ef.dll` löste Design über den Assemblynamen anhand der `.deps.json` des Startprojekts auf. Dieser Unterschied ist für einen bestimmten Fehlerfall relevant, der weiter unten behandelt wird.

## Minimale Reproduktion

Eine geschichtete Solution mit zwei Projekten, das Layout, das diesen Fehler am häufigsten hervorbringt:

```text
Shop.sln
  src/Shop.Api/Shop.Api.csproj          <- startup project, has Program.cs
  src/Shop.Data/Shop.Data.csproj        <- has AppDbContext and Migrations/
```

```xml
<!-- src/Shop.Data/Shop.Data.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

```xml
<!-- src/Shop.Api/Shop.Api.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Shop.Data/Shop.Data.csproj" />
  </ItemGroup>
</Project>
```

```bash
# .NET 11 SDK preview 6
cd src/Shop.Data
dotnet ef migrations add Init -s ../Shop.Api
# Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design.
```

Das Design-Paket ist referenziert. Es ist im falschen Projekt referenziert, und es kann nicht wandern.

## Lösung 1: Design im Startprojekt referenzieren

Das ist in nahezu allen Fällen die Lösung. Führen Sie sie aus dem Verzeichnis des Startprojekts aus:

```bash
# .NET 11 SDK preview 6, EF Core 11
dotnet add src/Shop.Api/Shop.Api.csproj package Microsoft.EntityFrameworkCore.Design
```

NuGet schreibt Folgendes, weil Design in seiner nuspec als `developmentDependency` markiert ist:

```xml
<!-- src/Shop.Api/Shop.Api.csproj - EF Core 11.0.0-preview.6 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

Lesen Sie diese `IncludeAssets`-Liste genau, denn sie erklärt beide Hälften des Problems:

- `runtime` **steht** in der Liste. Das ist es, was `Microsoft.EntityFrameworkCore.Design.dll` in Ihren `bin`-Ordner und damit in die `RuntimeCopyLocalItems` bringt, und genau danach suchen die Tools. Entfernen Sie es nicht.
- `compile` steht **nicht** in der Liste. Sie können Design-Typen nicht aus Ihrem Anwendungscode heraus referenzieren, und das ist beabsichtigt: Es handelt sich um ein Paket für die Entwurfszeit, und nichts in Ihrem Produktionscode sollte daran binden.
- `PrivateAssets: all` bedeutet, dass die Referenz **nicht transitiv weitergegeben wird**. Das ist der ganze Grund, weshalb Lösung 1 als eigener Schritt existiert und es nicht genügt, das Paket im Datenprojekt zu haben.

## Lösung 2: Die Tools auf das richtige Startprojekt zeigen lassen

Ist der Projektname im Fehler nicht das Projekt, das Sie gemeint haben, dann stimmt das Paket und das Ziel stimmt nicht. Die Regel aus der Dokumentation der EF Core CLI: Das *Zielprojekt* ist dort, wo Dateien geschrieben werden (`--project`, `-p`, Standard ist das aktuelle Verzeichnis), und das *Startprojekt* ist dasjenige, das die Tools kompilieren und ausführen, um Ihre Verbindungszeichenfolge und Ihr Modell zu ermitteln (`--startup-project`, `-s`, ebenfalls Standard aktuelles Verzeichnis).

```bash
# EF Core 11, run from the repository root
dotnet ef migrations add Init -p src/Shop.Data -s src/Shop.Api
```

Dass man das bei jedem Kommando tippen muss, ist der Grund, warum Teams das Paket am falschen Projekt festschrauben, nur damit der Fehler verschwindet. EF Core 11 ergänzt genau dafür eine Konfigurationsdatei. Sie wird gefunden, indem vom aktuellen Verzeichnis aufwärts nach der ersten `.config/dotnet-ef.json` gesucht wird:

```json
{
  "project": "src/Shop.Data",
  "startupProject": "src/Shop.Api"
}
```

Relative Pfade werden gegen das übergeordnete Verzeichnis des `.config`-Verzeichnisses aufgelöst. Legen Sie die Datei also in das Wurzelverzeichnis Ihres Repositorys, dann greift jeder `dotnet ef`-Aufruf aus jedem Unterverzeichnis darauf zu. Explizite Kommandozeilenoptionen gewinnen weiterhin gegen die Datei. Akzeptiert werden nur die dokumentierten Schlüssel: `project`, `startupProject`, `context`, `framework`, `configuration`, `runtime`, `verbose`, `noColor`, `prefixOutput`. Ein unbekannter Schlüssel ist ein harter Fehler und keine Warnung, ein Tippfehler wie `startProject` lässt das Kommando also komplett scheitern.

## Lösung 3: Hören Sie auf, die Referenz aus dem Datenprojekt fließen zu lassen

Immer wieder findet jemand diesen Trick, und er funktioniert tatsächlich:

```xml
<!-- src/Shop.Data/Shop.Data.csproj - do not do this -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>none</PrivateAssets>
</PackageReference>
```

`PrivateAssets` auf `none` zu setzen lässt die Referenz transitiv in `Shop.Api` fließen, und der Fehler verschwindet. Es zieht aber auch Roslyn in jedes Projekt, das Ihre Datenschicht referenziert, denn Design hängt von `Microsoft.CodeAnalysis.CSharp` und `Microsoft.CodeAnalysis.CSharp.Workspaces` ab (5.0.0 oder höher im Paket 10.0.10), dazu `Microsoft.Build.Framework`, `Humanizer.Core`, `Mono.TextTemplating` und `Newtonsoft.Json`. Sie haben eine Codegenerierungs-Toolchain in Ihren Laufzeit-Abhängigkeitsgraphen verschoben, um eine Zeile in einer `.csproj` zu sparen. Nehmen Sie stattdessen die explizite Referenz im Startprojekt.

## Die Versionskonflikt-Variante seit Tools 10.0.6

Wenn Sie `Microsoft.EntityFrameworkCore.Tools` (das Modul der Package Manager Console) installieren und erwarten, dass es Design mitbringt, ist diese Annahme abgelaufen. Vor 10.0.6 hing Tools von einer passenden Design-Version ab. Das brach den Restore für Projekte mit Ziel `net8.0`, weil Design 10.0.x nur `net10.0` anvisiert. Daher senkte das EF-Team die Untergrenze in Tools 10.0.6 auf Design 8.0.0. Im Branch von EF Core 11 trägt `Microsoft.EntityFrameworkCore.Tools` überhaupt keinen `PackageReference` auf Design mehr.

Praktisch heißt das: NuGet kann nun eine alte Design-Version auflösen, die die Untergrenze erfüllt, und das Symptom ist nicht dieser Fehler, sondern:

```text
System.MissingMethodException: Method not found ...
System.TypeLoadException: Could not load type ...
```

Die Lösung ist eine explizite, versionsgleiche Referenz. Mit zentraler Paketverwaltung fixieren Sie sie einmal:

```xml
<!-- Directory.Packages.props - EF Core 11.0.0-preview.6 -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

Die zentrale Paketverwaltung hat hier ihre eigene Falle: Ein `PackageVersion`-Eintrag in `Directory.Packages.props` ist keine Referenz. Das Startprojekt braucht weiterhin `<PackageReference Include="Microsoft.EntityFrameworkCore.Design" />` ohne `Version`-Attribut. Halten Sie auch `dotnet-ef` selbst im Gleichschritt, denn ein 10.x-Tool, das eine 11.x-Design-Assembly steuert, ist eine eigene Fehlerklasse:

```bash
dotnet tool update --global dotnet-ef --version 11.0.0-preview.6.26359.118
```

## Wenn die Referenz da ist und es dennoch scheitert

Führen Sie dieselbe Abfrage aus, die die Tools ausführen, und sehen Sie sich die Antwort selbst an. Der Schalter `-getItem` benötigt das .NET 8 SDK oder höher:

```bash
# .NET 11 SDK preview 6
dotnet build src/Shop.Api/Shop.Api.csproj --no-restore \
  /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems
```

Steht `Microsoft.EntityFrameworkCore.Design.dll` nicht in diesem JSON, können EF Core 10 und 11 es nicht sehen, ganz gleich, was die `.csproj` behauptet. Die üblichen Verursacher sind Asset-Flow-Attribute, die jemand von einem Paket kopiert hat, das nur Analyzer enthält:

- `<ExcludeAssets>runtime</ExcludeAssets>` oder `<ExcludeAssets>all</ExcludeAssets>` an der Design-Referenz.
- Eine `<IncludeAssets>`-Liste, die `runtime` auslässt, zum Beispiel `build; analyzers`.
- `<PackageReference ... GeneratePathProperty="true" ExcludeAssets="all" />`, ein Muster, das auftaucht, wenn jemand nur das tools-Verzeichnis des Pakets möchte.

Ergänzen Sie `-v`, um den eigenen Bericht des Tools darüber zu erhalten, was es aufgelöst hat. Die ausführliche Ausgabe zeigt das vollständige Kommando des Metadaten-Builds und den Pfad der gewählten Design-Assembly, was aus einem Ratespiel eine Diagnose in zwei Zeilen macht:

```bash
dotnet ef migrations add Init -s src/Shop.Api -v
```

Der eine Fall, in dem eine korrekte `.csproj` wirklich nicht genügte: Bei EF Core 9 mit bestimmten .NET 9 SDK-Builds hörte [dotnet/sdk#45259](https://github.com/dotnet/sdk/pull/45259) damit auf, `PackageReference`-Einträge mit `PrivateAssets="all"` in die `.deps.json` zu schreiben. Da `ef.dll` in EF Core 9 Design über den Assemblynamen anhand dieser Datei auflöste, verloren die Tools das Paket ([dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265), mit [#35544](https://github.com/dotnet/efcore/issues/35544) als einem der Duplikate). Behoben wurde das in EF Core 10 durch [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527), das einen `AssemblyLoadContext.Resolving`-Handler registriert, der den App-Basispfad durchsucht, zusätzlich zum bereits beschriebenen expliziten `--design-assembly`-Pfad. Wenn Sie in einem EF Core 9-Projekt darauf stoßen, genügt es, das globale `dotnet-ef`-Tool auf 10 oder höher zu aktualisieren, denn die Tools sind versionsunabhängig von den Laufzeitpaketen, die sie steuern.

## Fallstricke und Verwechslungen

**Generierte Projekte, die ohne das Paket ausgeliefert wurden.** Frühe .NET 11 Preview 3 SDK-Builds erzeugten `dotnet new mvc --auth Individual`-Projekte ohne Design-Referenz, eine Regression gegenüber Preview 2, erfasst als [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750). Ab SDK `11.0.100-preview.3.26166.111` trat sie nicht mehr auf. Wurde ein Projekt in diesem Zeitfenster generiert, ist die Vorlage der Verursacher, und Lösung 1 ist alles, was Sie brauchen.

**Eine `netstandard2.0`-Klassenbibliothek als Startprojekt.** Die Tools müssen Anwendungscode ausführen, wofür eine echte Laufzeit erforderlich ist, und .NET Standard ist eher eine Spezifikation als eine Implementierung. Design hinzuzufügen hilft nicht. Erstellen Sie ein Wegwerf-Konsolenprojekt, das die Bibliothek referenziert, und verwenden Sie es als `-s`.

**Ein plattformspezifisches Target Framework.** Mit `net11.0-android` oder `net11.0-ios` erhalten Sie eine andere Meldung über ein plattformspezifisches Framework, und die dokumentierte Antwort lautet, `IDesignTimeDbContextFactory<TContext>` zu implementieren, damit die Tools Ihre Anwendung nie starten müssen.

**`NETSDK1004` in der ausführlichen Ausgabe.** Der Metadaten-Build läuft mit `--no-restore`. Wurde das Projekt nie wiederhergestellt, meldet `dotnet-ef`, dass ein Restore nötig ist, und nicht ein fehlendes Paket. Führen Sie `dotnet restore` aus und versuchen Sie es erneut.

**Multi-Targeting.** `dotnet-ef` nimmt das erste Target Framework und ruft sich selbst erneut auf. Ist Design an ein TFM gebunden und das erste ist nicht dieses, übergeben Sie `--framework net11.0` explizit.

**`Unable to create an object of type 'AppDbContext'`.** Anderer Fehler, andere Ursache. Die Design-Assembly wurde geladen, und danach konnten die Tools Ihren Kontext nicht instanziieren. Das behandelt [der Leitfaden zur DbContext-Erkennung zur Entwurfszeit](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

**CI-Container.** Das Image `dotnet/sdk`, nicht `dotnet/aspnet`, und `dotnet tool install --global dotnet-ef` vor jedem `dotnet ef`-Aufruf. Muss Ihre Pipeline Migrationen nur anwenden statt erzeugen, verzichten Sie ganz auf das Tool und liefern Sie ein Migrations-Bundle aus.

## Das Layout, das nie in diesen Fehler läuft

Vier Regeln, und dieser Fehler verschwindet aus Ihrer Solution:

1. `Microsoft.EntityFrameworkCore.Design` wird vom Startprojekt referenziert, mit den Standardwerten für `PrivateAssets` und `IncludeAssets`, die `dotnet add package` schreibt.
2. Das Provider-Paket (`Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.EntityFrameworkCore.PostgreSQL` und so weiter) ist vom Startprojekt aus erreichbar, transitiv über das Datenprojekt ist völlig in Ordnung.
3. Alle EF Core-Paketversionen und die Version des `dotnet-ef`-Tools stimmen überein, idealerweise fixiert in `Directory.Packages.props`.
4. `.config/dotnet-ef.json` hält `project` und `startupProject` fest, damit sich niemand `-p` und `-s` merken muss.

## Verwandte Beiträge

- [Warum die Entwurfszeit-Tools Ihren DbContext nicht instanziieren können](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) behandelt den Fehler, auf den Sie unmittelbar nach der Behebung dieses Fehlers stoßen.
- [Schemaänderungen mit Migrations-Bundles ausliefern](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) ist das Entwurfszeit-Kommando, das dieses Paket ebenfalls voraussetzt, und der Weg, `dotnet-ef` von Produktionsmaschinen fernzuhalten.
- [Die PendingModelChangesWarning und was sie tatsächlich erkennt](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) ist das Nächste, worauf die CI Sie hinweist, sobald Migrationen laufen.
- [DbContextOptions korrekt registrieren](/de/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/) erklärt den Fehler auf der Dependency Injection-Seite, der in einer geschichteten Solution ähnlich aussieht.
- [Breaking Changes beim Wechsel von EF Core 6 auf EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) enthält die Tooling-Änderungen, die vor einem Upgrade bekannt sein sollten.

## Quellen

- [Referenz der EF Core-Tools (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), einschließlich der Regeln zu Ziel- und Startprojekt sowie der Konfigurationsdatei `dotnet-ef.json` in EF Core 11.
- [Architektur der Entwurfszeit-Tools](https://learn.microsoft.com/en-us/ef/core/miscellaneous/internals/tools) für die Kette von `dotnet-ef` über `ef.dll` zu `EFCore.Design.dll`.
- [`src/dotnet-ef/Project.cs`](https://github.com/dotnet/efcore/blob/main/src/dotnet-ef/Project.cs) und [`src/ef/Commands/ProjectCommandBase.cs`](https://github.com/dotnet/efcore/blob/main/src/ef/Commands/ProjectCommandBase.cs) für die Suche in `RuntimeCopyLocalItems` und die genaue Stelle, an der die `FileNotFoundException` zu dieser Meldung wird.
- [Ankündigung: Änderung der Design-Paketabhängigkeit in Microsoft.EntityFrameworkCore.Tools 10.0.6](https://github.com/dotnet/efcore/issues/38124).
- [dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265) und [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527) zur Regression bei `.deps.json` und `PrivateAssets`.
- [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750) zur Vorlagen-Regression in .NET 11 Preview 3.
