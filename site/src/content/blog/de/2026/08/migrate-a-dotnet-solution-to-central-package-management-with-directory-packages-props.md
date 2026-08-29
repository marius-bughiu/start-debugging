---
title: "Eine .NET-Solution mit Directory.Packages.props auf Central Package Management umstellen"
description: "Verschiebe alle Paketversionen aus deinen csproj-Dateien in eine einzige Directory.Packages.props. Behandelt ein Generator-Skript, das widersprüchliche Versionen mit echter SemVer-Sortierung zusammenführt, den Vorher-Nachher-Diff des Abhängigkeitsgraphen als Nachweis, NU1008/NU1010/NU1013/NU1507, transitives Pinning, GlobalPackageReference, VersionOverride und warum eine verschachtelte Directory.Packages.props die Datei im Wurzelverzeichnis stillschweigend verdeckt."
pubDate: 2026-08-28
template: migration
tags:
  - "migration"
  - "dotnet"
  - "nuget"
  - "csharp"
lang: "de"
translationOf: "2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props"
translatedBy: "claude"
translationDate: 2026-08-28
---

Central Package Management verschiebt jedes `Version`-Attribut aus deinen `.csproj`-Dateien in eine einzige `Directory.Packages.props` im Wurzelverzeichnis des Repositorys. Aktiviere es mit `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`, deklariere ein `<PackageVersion Include="..." Version="..." />` für jedes Paket, das die Solution verwendet, und lösche das `Version`-Attribut aus jedem `<PackageReference>`. Die Migration selbst ist mechanisch und skriptbar. Der Teil, der einen Menschen braucht, ist das Zusammenführen der Pakete, die in verschiedenen Projekten auf verschiedene Versionen festgelegt sind, denn ihre Konsolidierung ist eine echte Verhaltensänderung, keine Formatierungsänderung. Alles Folgende wurde gegen das .NET-10-SDK 10.0.302 mit dem mitgelieferten NuGet 7.6.0 verifiziert.

## Was sich tatsächlich ändert

Vorher besitzt jedes Projekt seine Versionen selbst:

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
</ItemGroup>
```

Nachher deklariert das Projekt nur noch, *wovon* es abhängt, und die Datei im Wurzelverzeichnis entscheidet, *welche Version*:

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" />
</ItemGroup>
```

```xml
<!-- Directory.Packages.props -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
```

`Directory.Packages.props` wird gefunden, indem vom Verzeichnis jedes Projekts aus *nach oben* gelaufen wird, genau wie bei `Directory.Build.props`. Sie muss nicht neben der Solution-Datei liegen, und nichts importiert sie explizit. Beachte, dass nur die Version umzieht. `PrivateAssets`, `IncludeAssets` und `ExcludeAssets` bleiben am `PackageReference` in dem Projekt, das sie braucht, denn das sind projektspezifische Entscheidungen.

## Schritte

1. Lege `Directory.Packages.props` im Wurzelverzeichnis des Repositorys an, mit `ManagePackageVersionsCentrally` auf `true`.
2. Sammle die Version jedes `PackageReference` aus jedem Projekt und erzeuge ein `PackageVersion`-Item je Paket-ID.
3. Löse die Pakete auf, die in mehr als einer Version auftauchen. Das ist der einzige Schritt, der nicht mechanisch ist.
4. Lösche das `Version`-Attribut aus jedem `PackageReference` in jedem Projekt.
5. Führe ein Restore aus und vergleiche den aufgelösten Abhängigkeitsgraphen mit dem, den du vor dem Start erfasst hast.

## Die Datei aus dem erzeugen, was du schon hast

Eine dateibasierte C#-App passt hier gut: eine Datei, kein Projekt, und `dotnet run` führt sie direkt aus. Erfasse die Versionen, melde die Konflikte, schreibe die Props-Datei und entferne dann die Attribute.

```csharp
// migrate-to-cpm.cs -- ausführen mit: dotnet run migrate-to-cpm.cs .
#:property ManagePackageVersionsCentrally=false
#:package NuGet.Versioning@6.*

using System.Xml.Linq;
using NuGet.Versioning;

var root = args.Length > 0 ? args[0] : ".";
var projects = Directory.GetFiles(root, "*.csproj", SearchOption.AllDirectories);
var versions = new Dictionary<string, SortedSet<NuGetVersion>>(StringComparer.OrdinalIgnoreCase);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        var id = (string?)reference.Attribute("Include") ?? (string?)reference.Attribute("Update");
        var version = (string?)reference.Attribute("Version") ?? (string?)reference.Element("Version");
        if (id is null || version is null) continue;
        if (!versions.TryGetValue(id, out var set))
            versions[id] = set = new SortedSet<NuGetVersion>();
        if (NuGetVersion.TryParse(version, out var parsed)) set.Add(parsed);
    }
}

foreach (var (id, set) in versions.Where(v => v.Value.Count > 1))
    Console.WriteLine($"conflict: {id} -> {string.Join(", ", set)}");

var props = new XElement("Project",
    new XElement("PropertyGroup",
        new XElement("ManagePackageVersionsCentrally", true),
        new XElement("CentralPackageTransitivePinningEnabled", true)),
    new XElement("ItemGroup",
        versions.OrderBy(v => v.Key, StringComparer.OrdinalIgnoreCase)
                .Select(v => new XElement("PackageVersion",
                    new XAttribute("Include", v.Key),
                    new XAttribute("Version", v.Value.Max()!)))));

File.WriteAllText(Path.Combine(root, "Directory.Packages.props"), props + Environment.NewLine);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    var changed = false;
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        if (reference.Attribute("Version") is { } attribute) { attribute.Remove(); changed = true; }
        if (reference.Element("Version") is { } element) { element.Remove(); changed = true; }
    }
    if (changed) doc.Save(project);
}

Console.WriteLine($"wrote {versions.Count} PackageVersion entries from {projects.Length} projects");
```

Zwei Details in diesem Skript sind entscheidend.

Das erste ist `NuGetVersion` statt einfacher Strings. Versionen als Text zu sortieren ist falsch, und zwar in der Richtung, die dich stillschweigend herabstuft:

```text
string  max: 13.0.3
semver  max: 13.0.10
```

Das zweite ist die Direktive `#:property ManagePackageVersionsCentrally=false` in Zeile 1. Ohne sie zerlegt sich das Skript in dem Moment selbst, in dem es erfolgreich ist. Die `#:package`-Direktive einer dateibasierten App wird zu einem `PackageReference` *mit* `Version` übersetzt, und die `Directory.Packages.props`, die das Skript gerade geschrieben hat, liegt im selben Verzeichnisbaum. Der nächste Lauf scheitert also, bevor `Main` erreicht wird:

```text
migrate-to-cpm.cs.csproj : error NU1008: The following PackageReference items cannot define a value for
Version: NuGet.Versioning. Projects using Central Package Management must define a Version value on a
PackageVersion item.
```

Das lohnt sich über dieses Skript hinaus zu merken: CPM im Wurzelverzeichnis des Repositorys einzuschalten gilt auch für jede dateibasierte `.cs`-App im Repository, und `#:package` ist damit nicht kompatibel. Nimm jede einzelne mit `#:property` heraus, oder halte deine Skripte außerhalb des Baums.

## Die Konflikte sind die Migration

Lass das Skript auf einer Solution laufen, in der drei Projekte uneinig sind, und du bekommst die eigentliche Aufgabenliste:

```text
conflict: Serilog -> 4.1.0, 4.2.0
conflict: Newtonsoft.Json -> 13.0.1, 13.0.3
wrote 3 PackageVersion entries from 3 projects
```

Die höchste Version zu nehmen, was das Skript tut, ist die richtige *Voreinstellung* und die falsche *Richtlinie*. Richtig, weil eine Solution, die zwei Versionen derselben Bibliothek ausliefert, meist ein Versehen und keine Entscheidung ist, und weil die niedrigere Festlegung oft die veraltete ist, die niemand mehr angefasst hat. Falsch als Richtlinie, weil "die höchste gewinnt" genau der Weg ist, auf dem du in einem Projekt unbemerkt eine Major-Version-Grenze überschreitest, während du eigentlich nur deine Build-Dateien aufräumen wolltest. Lies die Liste, und migriere bei allem, was eine Major-Version überspringt, das betroffene Projekt bewusst, statt es dem Skript zu überlassen.

## Weise nach, was sich bewegt hat

CPM ist keine Nulloperation, und der Weg herauszufinden, was es tatsächlich getan hat, ist der Vergleich des aufgelösten Graphen. Erfasse ihn vor dem Start aus der Restore-Ausgabe jedes Projekts:

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); [print(k) for t in d['targets'].values() for k in sorted(t)]" src/Domain/obj/project.assets.json
```

Vorher und nachher für die obige Drei-Projekt-Solution:

```text
            BEFORE                       AFTER
Api       Newtonsoft.Json/13.0.3      Newtonsoft.Json/13.0.3
          Polly/8.5.0                 Polly/8.5.0
          Serilog/4.2.0               Serilog/4.2.0
Domain    Newtonsoft.Json/13.0.1  ->  Newtonsoft.Json/13.0.3
Workers   Serilog/4.1.0           ->  Serilog/4.2.0
          Polly/8.5.0                 Polly/8.5.0
```

Zwei Projekte haben sich bewegt. Das ist die Änderung, die getestet und in die Beschreibung des Pull Requests gehört. Ist dein Diff leer, war die Migration wirklich mechanisch und du kannst sie mit deutlich weniger Aufwand mergen.

## Die vier Fehler, die dir begegnen werden

**NU1008**: ein `PackageReference` trägt noch eine `Version`. Das ist der erwartete Zustand mitten in der Migration, und es ist ein Fehler, keine Warnung. Ein halb migriertes Repository baut also nicht.

```text
error NU1008: The following PackageReference items cannot define a value for Version: Serilog.
```

**NU1010**: ein `PackageReference` hat kein passendes `PackageVersion`. Meist ein Paket, das nur in einem Projekt vorkommt, das das Skript nicht erfasst hat, etwa eines außerhalb des übergebenen Wurzelverzeichnisses.

```text
error NU1010: The following PackageReference items do not define a corresponding PackageVersion item:
Humanizer.Core.
```

**NU1013**: ein `VersionOverride` wurde verwendet, während `CentralPackageVersionOverrideEnabled` auf `false` steht. Siehe die Notausgänge weiter unten.

**NU1507**: eine Warnung, und diejenige, die überlesen wird:

```text
warning NU1507: There are 2 package sources defined in your configuration. When using central package
management, please map your package sources with package source mapping
(https://aka.ms/nuget-package-source-mapping) or specify a single package source.
The following sources are defined: nuget.org, contoso
```

Mit einer Quelle ändert sich nichts. Mit einem privaten Feed neben nuget.org ist eine zentral deklarierte Version nun aus beiden auflösbar, was das Zeitfenster für eine Dependency-Confusion-Substitution vergrößert. Behebe das mit Package Source Mapping, statt die Warnung zu unterdrücken.

## Transitives Pinning

Das ist die Funktion, die die Migration schon für sich allein lohnenswert macht. Schalte sie mit `<CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>` ein, und jedes von dir deklarierte `PackageVersion` gilt auch für Pakete, die transitiv hereinkommen.

Nimm ein Projekt, das `Newtonsoft.Json.Bson` referenziert und sonst nichts. Seine Abhängigkeit auf `Newtonsoft.Json >= 12.0.1` löst sich genau darauf auf, obwohl `Directory.Packages.props` 13.0.3 deklariert, denn ein `PackageVersion` ohne passendes `PackageReference` tut standardmäßig nichts:

```text
warning NU1903: Package 'Newtonsoft.Json' 12.0.1 has a known high severity vulnerability
```

Schalte transitives Pinning ein, und dasselbe Restore ist sauber:

```text
Top-level Package           Requested   Resolved
> Newtonsoft.Json.Bson      1.0.2       1.0.2

Transitive Package      Resolved
> Newtonsoft.Json       13.0.3
```

Das Paket wird auf 13.0.3 angehoben und bleibt als transitiv eingestuft, wird also nicht Teil der öffentlichen Abhängigkeitsfläche deines Projekts und sickert nicht in die nuspec eines Pakets, das du erzeugst. Genau darum geht es: Du kannst eine verwundbare transitive Abhängigkeit in allen Projekten auf einmal beheben, ohne eine direkte Referenz hinzuzufügen, an deren Entfernung du dich später erinnern müsstest.

## GlobalPackageReference

Pakete, die nur zur Build-Zeit wirken und in jedes Projekt gehören, etwa Source-Link-Provider, Analyzer und Versionierungswerkzeuge, haben einen eigenen Item-Typ. Deklariere ihn einmal in `Directory.Packages.props` und fass keine einzige `.csproj` an:

```xml
<ItemGroup>
  <GlobalPackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0.0" />
</ItemGroup>
```

Beachte, dass ein `GlobalPackageReference` seine `Version` inline trägt, anders als ein `PackageReference`. Er gilt überall als Referenz oberster Ebene mit reinem Entwicklungs-Asset-Verhalten und taucht deshalb in `dotnet package list` jedes Projekts auf. Nutze ihn nur für Pakete, die wirklich in alle gehören; ein Paket, das "vorerst" global ist, lässt sich später sehr schwer wieder entfernen.

## Notausgänge

Ein Projekt braucht eine andere Version, und du hast einen echten Grund. `VersionOverride` gewinnt gegen den zentralen Wert:

```xml
<PackageReference Include="Newtonsoft.Json" VersionOverride="13.0.1" />
```

War dein Ziel bei der Einführung von CPM, Versions-Drift unmöglich zu machen, schließe diese Tür mit `<CentralPackageVersionOverrideEnabled>false</CentralPackageVersionOverrideEnabled>`, was jede Verwendung zu NU1013 macht.

Ein ganzes Projekt kann sich mit `<ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>` in seiner `.csproj` ausklinken und verwaltet seine Versionen danach wieder inline. Beachte, dass es sich damit auch aus dem transitiven Pinning ausklinkt: Eine verwundbare transitive Abhängigkeit, die der Rest der Solution angehoben hat, kommt in diesem einen Projekt direkt zurück.

## Eine verschachtelte Directory.Packages.props verdeckt, sie führt nicht zusammen

Der Suchlauf endet bei der ersten gefundenen Datei. Eine `Directory.Packages.props` in einem Unterverzeichnis ersetzt die Datei im Wurzelverzeichnis daher vollständig, statt sie zu ergänzen, und jedes Projekt darunter scheitert sofort mit NU1010 für die Pakete, die die Wurzeldatei deklariert hatte. Brauchst du bereichsspezifische Versionen, importiere die übergeordnete Datei explizit und lege mit `Update` darüber:

```xml
<Project>
  <Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Packages.props', '$(MSBuildThisFileDirectory)../'))" />
  <ItemGroup>
    <PackageVersion Update="Newtonsoft.Json" Version="13.0.2" />
  </ItemGroup>
</Project>
```

`Update` statt `Include`, denn das Item existiert bereits. Das falsch zu machen liefert dir zwei `PackageVersion`-Items für ein Paket, was mehrdeutig ist.

## Die CLI weiß längst Bescheid

Du musst die Props-Datei nach der Migration nicht von Hand bearbeiten. Die Paketbefehle des .NET-10-SDK kennen CPM und schreiben von selbst in die richtige Datei.

`dotnet package add Humanizer.Core --project src/Lib1/Lib1.csproj` fügt dem Projekt ein `PackageReference` ohne Version hinzu *und* trägt ein `PackageVersion` alphabetisch sortiert in `Directory.Packages.props` ein:

```text
info : PackageReference for package 'Humanizer.Core' version '3.0.10' added to file
'/repo/Directory.Packages.props'.
```

`dotnet package update Serilog --project src/App/App.csproj` bearbeitet nur die zentrale Version und lässt die Projektdatei in Ruhe. `dotnet package list --outdated` meldet weiterhin korrekt, einschließlich `GlobalPackageReference`-Items. `dotnet nuget why <project> <package>` bleibt der schnellste Weg herauszufinden, welche Referenz ein transitives Paket hereingezogen hat, das du gerade pinnen willst.

## Verwandt

- CPM passt natürlich zur Bereinigung transitiver Abhängigkeiten aus [NuGet Package Pruning ist in .NET 10 standardmäßig aktiv](/de/2026/05/nuget-package-pruning-default-net-10/), das vom Framework bereitgestellte Pakete aus dem Graphen entfernt, bevor das Pinning überhaupt über sie nachdenken muss.
- Die vom Migrationsskript verwendeten Direktiven `#:package` und `#:property` werden vollständig in [wie man eine dateibasierte C#-App mit `dotnet run app.cs` ausführt](/de/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) behandelt.
- Versionen projektübergreifend zu konsolidieren ist eine gute Sache, die man *vor* der [Migration von .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) erledigt, damit der Framework-Sprung die einzige Variable im Diff ist.
- Kompiliert ein Projekt nicht mehr, nachdem du seine Versionen entfernt hast, liegt die Ursache meist an der Referenz selbst und nicht an CPM; siehe [Der Typ- oder Namespacename konnte nach dem Hinzufügen einer Projektreferenz nicht gefunden werden](/de/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/).
- Wenn zwei Projekte auf eine einzige Version zusammenlaufen, erfährst du es über Ladefehler zur Laufzeit; [Datei oder Assembly konnte in einer veröffentlichten App nicht geladen werden](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) behandelt deren Diagnose.

## Quellen

- [Central Package Management](https://learn.microsoft.com/de-de/nuget/consume-packages/central-package-management) in der NuGet-Dokumentation, für `PackageVersion`, `GlobalPackageReference`, `VersionOverride` und transitives Pinning.
- [NuGet-Referenz für Fehler und Warnungen](https://learn.microsoft.com/de-de/nuget/reference/errors-and-warnings/) für NU1008, NU1010, NU1013 und NU1507.
- [Package Source Mapping](https://learn.microsoft.com/de-de/nuget/consume-packages/package-source-mapping), die empfohlene Antwort auf NU1507.
- [Build mit Directory.Build.props anpassen](https://learn.microsoft.com/de-de/visualstudio/msbuild/customize-by-directory) für den Verzeichnisdurchlauf, der auch `Directory.Packages.props` steuert.
