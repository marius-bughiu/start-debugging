---
title: "Fix: NU1608 / NU1107 Versionskonflikt zwischen Pomelo.EntityFrameworkCore.MySql und EF Core 10"
description: "Pomelo 9.0.0 erlaubt nur EF Core Relational 9.0.x und hat keinen Build für EF Core 10. Halten Sie alle EF-Core-Pakete auf 9.0.x oder wechseln Sie zu Microting.EntityFrameworkCore.MySql 10.0.x. Wer die Warnung unterdrückt, bekommt einen Absturz beim Start."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "dotnet-10"
  - "nuget"
  - "mysql"
lang: "de"
translationOf: "2026/10/fix-nu1608-nu1107-version-conflict-pomelo-entityframeworkcore-mysql-ef-core-10"
translatedBy: "claude"
translationDate: 2026-10-13
---

**Kurze Antwort:** `Pomelo.EntityFrameworkCore.MySql` 9.0.0 ist weiterhin das neueste Release auf nuget.org (Oktober 2026) und deklariert `Microsoft.EntityFrameworkCore.Relational` als `[9.0.0, 9.0.999]`. Jedes EF-Core-10-Paket im Abhängigkeitsgraphen kollidiert entweder mit diesem Bereich (`NU1107`, ein Restore-Fehler) oder setzt sich darüber hinweg (`NU1608`, eine Warnung). Es gibt keinen Pomelo-Build für EF Core 10, auch nicht im Nightly-Feed. Es gibt zwei funktionierende Wege: alle EF-Core- und Identity-Pakete auf 9.0.x halten (läuft problemlos auf `net10.0`) oder Pomelo durch den Fork `Microting.EntityFrameworkCore.MySql` 10.0.x ersetzen. Setzen Sie `NU1608` nicht per `NoWarn` außer Kraft: Die App wird kompiliert und stürzt dann in `UseMySql` mit einer `MissingMethodException` ab.

Alles Folgende wurde auf macOS mit .NET SDK 10.0.302, EF Core 10.0.13 und 9.0.21, Pomelo 9.0.0, Microting 10.0.12 und Oracles `MySql.EntityFrameworkCore` 10.0.9 reproduziert.

## Der Fehler im Kontext

Je nachdem, welches EF-Core-10-Paket Sie hinzugefügt haben, erscheint eine von zwei Varianten. Wenn etwas anderes EF Core 10 transitiv einbindet, typischerweise `Microsoft.EntityFrameworkCore.Design` oder ASP.NET Core Identity, schlägt der Restore hart fehl:

```text
error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 10.0.13 directly to project App to resolve this issue.
error NU1107:  App -> Microsoft.EntityFrameworkCore.Design 10.0.13 -> Microsoft.EntityFrameworkCore.Relational (>= 10.0.13)
error NU1107:  App -> Pomelo.EntityFrameworkCore.MySql 9.0.0 -> Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999).
```

Wenn Sie diesem Rat folgen und `Microsoft.EntityFrameworkCore.Relational` 10.0.13 direkt referenzieren, wird aus dem Fehler eine Warnung, weil eine direkte Referenz immer über einen transitiven Bereich gewinnt:

```text
warning NU1608: Detected package version outside of dependency constraint: Pomelo.EntityFrameworkCore.MySql 9.0.0 requires Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999) but version Microsoft.EntityFrameworkCore.Relational 10.0.13 was resolved.
```

Und das passiert mit diesem "reparierten" Build zur Laufzeit, gleich in der ersten Zeile, die den Kontext konfiguriert:

```text
Unhandled exception. System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NullButNotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.MySqlDbContextOptionsBuilderExtensions.UseMySql(DbContextOptionsBuilder optionsBuilder, String connectionString, ServerVersion serverVersion, Action`1 mySqlOptionsAction)
```

Die NuGet-Meldung rät wörtlich zu genau dem, was den Absturz auslöst. Deshalb taucht dieser Fehler auch Monate nach dem Erscheinen von .NET 10 noch in Issue-Trackern auf.

## Warum das passiert

EF-Core-Provider werden gegen die Interna genau einer EF-Core-Hauptversion kompiliert. Pomelo bildet das in seiner nuspec mit einer Obergrenze ab:

```xml
<!-- Pomelo.EntityFrameworkCore.MySql 9.0.0 nuspec -->
<group targetFramework="net8.0">
  <dependency id="Microsoft.EntityFrameworkCore.Relational" version="[9.0.0, 9.0.999]" include="All" />
  <dependency id="MySqlConnector" version="2.4.0" exclude="Build,Analyzers" />
</group>
```

NuGet löst pro Projekt genau eine Version jedes Pakets auf. Wenn zwei Pfade im Graphen nicht übereinstimmen:

- **Beide transitiv, Bereiche überlappen sich nicht** (`Design 10 -> Relational >= 10.0.13` gegen `Pomelo -> Relational <= 9.0.999`): NuGet kann nicht wählen und bricht mit `NU1107` ab.
- **Eine direkte Referenz gewinnt** (Sie referenzieren Relational 10.0.13 selbst, oder Central Package Management fixiert es): NuGet übernimmt die direkte Version und warnt mit `NU1608`, dass die Einschränkung von Pomelo verletzt wurde.

Die Obergrenze ist keine Übervorsicht. Pomelo 9.0.0 ruft Hilfsmethoden wie `Check.NullButNotEmpty` auf, die in EF Core 9 an `AbstractionsStrings.ArgumentIsEmpty(object)` weiterleiten. EF Core 10 hat diese internen Ressourcenmethoden geändert, sodass die IL in Pomelos Assembly auf eine Methode zeigt, die nicht mehr existiert. Der JIT bemerkt das erst beim ersten Aufruf der Methode. Darum ist der Build grün und der Absturz passiert beim Start.

Dass das im Oktober 2026 noch ein Problem ist, fast ein Jahr nach dem GA von EF Core 10, hat folgenden Hintergrund: Pomelos [EF-Core-10-Tracking-Issue #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007) ist offen und hat über 120 Reaktionen, der letzte Kommentar eines Maintainers (Oktober 2025) versprach ein Release "bald", und mehrere Community-PRs für EF Core 10 liegen ungemergt herum. Ich habe sowohl das nuget.org-Listing als auch Pomelos Nightly-Feed bei Azure DevOps geprüft: Der neueste Build auf beiden ist ein CI-Paket `9.0.1-servicing` von August 2025. Es gibt nichts in der Version 10.x, auf das Sie aktualisieren könnten.

## Minimale Reproduktion

Drei `net10.0`-Projekte, jeweils mit Pomelo 9.0.0 plus einem EF-Core-10-Paket:

```xml
<!-- .NET SDK 10.0.302. Swap the second reference to get each outcome. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
    <!-- NU1107: -->
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13" />
    <!-- NU1107 too: Microsoft.AspNetCore.Identity.EntityFrameworkCore 10.0.13 -->
    <!-- NU1608 + crash: Microsoft.EntityFrameworkCore.Relational 10.0.13 -->
    <!-- No warning at all + crash: Microsoft.EntityFrameworkCore 10.0.13 -->
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 9.0.x or 10.0.x depending on the graph above
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<Shop>()
    .UseMySql("Server=localhost;Database=shop;User=root;Password=x",
              new MySqlServerVersion(new Version(8, 4, 0)))
    .Options;

using var db = new Shop(options);
Console.WriteLine(db.Orders.Where(o => o.Total > 10m).ToQueryString());

public class Order { public int Id { get; set; } public decimal Total { get; set; } }
public class Shop(DbContextOptions<Shop> o) : DbContext(o)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

Die letzte Variante in dieser Liste verdient eine eigene Warnung. Wenn Sie `Microsoft.EntityFrameworkCore` 10.0.13 hinzufügen (nicht Relational), bleibt der Restore stumm. `Microsoft.EntityFrameworkCore.Relational` 9.0.0 verlangt nur `Microsoft.EntityFrameworkCore >= 9.0.0`, ohne Obergrenze, sodass NuGet bereitwillig EF Core 10.0.13 neben Relational 9.0.0 auflöst. `dotnet nuget why` zeigt es:

```text
[net10.0]
 └── Pomelo.EntityFrameworkCore.MySql (v9.0.0)
     └── Microsoft.EntityFrameworkCore.Relational (v9.0.0)
```

Kein `NU1608`, kein `NU1107`, und zur Laufzeit dieselbe `MissingMethodException`. Wenn Sie diese Ausnahme ohne jede NuGet-Warnung sehen, ist das der Grund.

## Die Lösung im Detail

### 1. Alle Pakete finden, die EF Core 10 einschleppen

Bevor Sie etwas ändern, klären Sie, wer 10.x angefordert hat. In einem Projekt, das den Restore übersteht (der Fall `NU1608`), zeigt Ihnen `dotnet nuget why` den Pfad:

```bash
dotnet nuget why src/App/App.csproj Microsoft.EntityFrameworkCore.Relational
```

In einem Projekt, das bei `NU1107` hängt, listet der Fehler selbst beide Pfade auf. Die üblichen Verdächtigen in einer `net10.0`-App:

- `Microsoft.EntityFrameworkCore.Design` und `Microsoft.EntityFrameworkCore.Tools`, hochgezogen von Dependabot oder Renovate.
- `Microsoft.AspNetCore.Identity.EntityFrameworkCore`, weil die Identity-Vorlage die Framework-Version (10.0.x) verwendet.
- `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore`, `Microsoft.EntityFrameworkCore.InMemory` oder `.Sqlite` in einem Testprojekt, das die App referenziert.
- Eine Drittanbieter-Bibliothek, die bereits auf EF Core 10 umgestiegen ist (Bulk-Erweiterungen, Auditing, Mandantenfähigkeit).
- Eine `Directory.Packages.props`, die alle `Microsoft.EntityFrameworkCore.*`-Pakete auf eine gemeinsame Versionseigenschaft fixiert.

Letzteres ist die Falle bei Central Package Management: Ein einzelnes `$(EfCoreVersion)`, das auf 10.0.x angehoben wird, macht ein transitives Relational stillschweigend zu einem fixierten. Sie bekommen dann `NU1608` statt `NU1107` und verlieren den harten Stopp.

### 2. Option A: auf .NET 10 bei EF Core 9.0.x bleiben

EF Core 9 zielt auf `net8.0` und läuft deshalb ohne Beanstandung auf der .NET-10-Laufzeit. Fixieren Sie jedes EF-Core-Paket, und Identity, falls Sie es nutzen, auf denselben 9.0.x-Patch:

```xml
<!-- .NET 10 app, EF Core 9.0.21, Pomelo 9.0.0 -->
<ItemGroup>
  <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="9.0.21">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
  <PackageReference Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="9.0.21" />
</ItemGroup>
```

Mit Central Package Management teilen Sie die Eigenschaft auf, damit die Welt des Providers explizit bleibt:

```xml
<!-- Directory.Packages.props, .NET 10 solution with Pomelo 9.0.0 -->
<PropertyGroup>
  <!-- Pomelo 9.0.0 caps Relational at 9.0.999. Do not bump until the provider moves. -->
  <EfCoreVersion>9.0.21</EfCoreVersion>
</PropertyGroup>
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Relational" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
</ItemGroup>
```

Ich habe das Reproduktionsprogramm mit diesem Graphen auf `net10.0` ausgeführt: EF Core und Relational melden beide `9.0.21.0`, Modellaufbau, `ToQueryString()` und `GenerateCreateScript()` funktionieren, und das Identity-9.0.21-Projekt wird sauber wiederhergestellt und läuft. Weisen Sie Dependabot an, die 9.x-Linie in Ruhe zu lassen (eine `ignore`-Regel für `Microsoft.EntityFrameworkCore*` mit `update-types: ["version-update:semver-major"]`), sonst öffnet es jede Woche denselben PR erneut.

Der Haken ist der Kalender. EF Core 9 gehört zum Supportzeitraum von .NET 9 (STS), der am [10. November 2026](https://dotnet.microsoft.com/platform/support/policy/dotnet-core) endet. Nach diesem Datum gibt es keine Sicherheitspatches mehr für EF-Core-9-Pakete (EF Core 8 LTS endet am selben Tag). Option A ist eine Brücke, kein Ziel.

### 3. Option B: zu Microting.EntityFrameworkCore.MySql 10.0.x wechseln

[Microting.EntityFrameworkCore.MySql](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql) ist ein Fork von Pomelo, der seit Februar 2026 EF-Core-10-Builds liefert und auch ein `11.0.0-preview.1` hat. Die nuspec von 10.0.12 zielt auf `net10.0` mit `Microsoft.EntityFrameworkCore.Relational [10.0.12, 10.0.999]` und `MySqlConnector 2.6.2`. Es ist die Option, zu der die meisten im Pomelo-Tracking-Issue gewechselt sind.

```xml
<!-- .NET 10, EF Core 10.0.13, Microting 10.0.12 -->
<ItemGroup>
  <PackageReference Include="Microting.EntityFrameworkCore.MySql" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

Die Erweiterung `UseMySql(...)` sowie `MySqlServerVersion`/`ServerVersion.AutoDetect` liegen in beiden Paketen im Namespace `Microsoft.EntityFrameworkCore`. Mein `Program.cs` aus der Reproduktion wurde daher nach dem Wechsel unverändert kompiliert und gab dasselbe MySQL-SQL aus wie Pomelo 9.0.0 mit EF Core 9:

```text
SELECT `o`.`Id`, `o`.`Customer`, `o`.`Total`
FROM `Orders` AS `o`
WHERE (`o`.`Total` > 10.0) AND (`o`.`Customer` LIKE 'A%')
ORDER BY `o`.`Id`
LIMIT 5
```

Was Sie ändern müssen:

1. Benennen Sie jedes `using Pomelo.EntityFrameworkCore.MySql.*;` in `using Microting.EntityFrameworkCore.MySql.*;` um. Der Fork hat sowohl die Assembly als auch die Namespaces umbenannt (zum Beispiel wird aus `Pomelo.EntityFrameworkCore.MySql.Infrastructure` dann `Microting.EntityFrameworkCore.MySql.Infrastructure`).
2. Ersetzen Sie auch die Plugin-Pakete: Aus `Pomelo.EntityFrameworkCore.MySql.Json.Microsoft` wird `Microting.EntityFrameworkCore.MySql.Json.Microsoft`, und ebenso für `.Json.Newtonsoft` und `.NetTopologySuite`. Wer ein Pomelo-Plugin zurücklässt, holt Pomelo 9.0.0 und damit `NU1107` sofort zurück.
3. Passen Sie den Providernamen in Scaffolding-Befehlen an: `dotnet ef dbcontext scaffold "<conn>" Microting.EntityFrameworkCore.MySql`.
4. Aktualisieren Sie das Tool `dotnet-ef` auf 10.0.x, damit es zur EF-Core-Version der Laufzeit passt.
5. Führen Sie `dotnet ef migrations add ProviderSwapCheck` gegen Ihre bestehenden Migrationen aus. Ist die erzeugte Migration leer, ist der Modell-Snapshot kompatibel; löschen Sie sie mit `dotnet ef migrations remove`. Ist sie nicht leer, lesen Sie sie, bevor Sie irgendetwas ausliefern: Dieser Diff ist genau das, was gegen die Produktion laufen würde.

Seien Sie ehrlich zu sich selbst, was das ist: ein Community-Fork, der von einer einzelnen Firma gepflegt wird, kein offizieller Provider. Fixieren Sie die exakte Version, lesen Sie die Release Notes vor jedem Update und beobachten Sie beide Repositories. Sollte Pomelo später 10.0.0 veröffentlichen, ist der Rückweg dieselbe Umbenennung in umgekehrter Richtung.

### 4. Option C: Oracles MySql.EntityFrameworkCore

Oracles Provider [MySql.EntityFrameworkCore](https://www.nuget.org/packages/MySql.EntityFrameworkCore) hat seit 10.0.0-rc EF-Core-10-Builds und steht bei 10.0.9. Seine nuspec verwendet einfache Untergrenzen (`Microsoft.EntityFrameworkCore.Relational >= 10.0.9`), sodass dieser Konflikt nie auftritt. Es ist ein anderer Provider, kein Fork, und die API unterscheidet sich:

```csharp
// .NET 10, EF Core 10.0.13, MySql.EntityFrameworkCore 10.0.9
options.UseMySQL(connectionString); // capital SQL, no ServerVersion argument
```

Auch die Abfrageübersetzung ist anders. Derselbe Filter `Customer.StartsWith("A")` aus der Reproduktion wird zu einem `LIKE CONCAT('A', '%')` plus einem Vergleich `LEFT(...) = CONVERT(... USING utf8mb4) COLLATE utf8mb4_bin`, während Pomelo und Microting `LIKE 'A%'` erzeugen. Auch Typzuordnungen und Migrationsannotationen unterscheiden sich; rechnen Sie daher mit einem nicht leeren Migrations-Diff und planen Sie eine echte Migrationsprüfung ein. Wählen Sie diese Option, wenn Sie einen vom Hersteller unterstützten Provider wollen und sich diese Prüfung leisten können; andernfalls ist Option B die kleinere Änderung.

### 5. Was Sie nicht tun sollten

- **Fügen Sie kein `<NoWarn>NU1608</NoWarn>` hinzu.** Die Reproduktion zeigt das Ergebnis: ein sauberer Build und eine `MissingMethodException` beim ersten Aufruf von `UseMySql`. Wenn `TreatWarningsAsErrors` die `NU1608` ans Licht gebracht hat, hat es seinen Zweck erfüllt.
- **Referenzieren Sie `Microsoft.EntityFrameworkCore.Relational` 10.x nicht direkt**, nur weil die Meldung `NU1107` es vorschlägt. Das verwandelt den Fehler in den Absturz.
- **Mischen Sie keine Hauptversionen innerhalb einer Solution.** Ein Testprojekt mit EF Core 10 InMemory, das eine App mit EF Core 9 referenziert, zieht beide in den Graphen des Tests, und Sie bekommen `NU1107` (oder die stille Inkompatibilität) nur im Testprojekt.

## Fallstricke und ähnliche Fehler

- **`MissingMethodException` ohne NuGet-Warnung**: der Graph aus `Microsoft.EntityFrameworkCore` 10 und Relational 9.0.0 aus der Reproduktion. Führen Sie `dotnet nuget why <project> Microsoft.EntityFrameworkCore.Relational` aus und suchen Sie ein Relational 9.x neben einem EF Core 10.x.
- **`NU1107` oder `NU1608` mit Nennung von `Pomelo.EntityFrameworkCore.MySql.Json.Microsoft`**: Die Plugin-Pakete wiederholen dieselbe Einschränkung `Microsoft.EntityFrameworkCore.Relational [9.0.0, 9.0.999]` und hängen selbst von Pomelo 9.0.0 ab. Ziehen Sie sie gemeinsam mit dem Hauptpaket nach.
- **`NU1605` (erkanntes Paket-Downgrade)**: ein anderes Problem. Etwas im Graphen verlangt eine neuere Version, als Sie direkt fixiert haben. Es tritt oft direkt nach Option A auf, wenn ein transitives Paket noch EF Core 10 will. Beheben Sie es, indem Sie dieses Paket finden und fixieren, nicht durch weiteres Downgrade.
- **`dotnet ef` warnt, dass die Tools-Version neuer ist als die Laufzeit**: für sich genommen harmlos, aber halten Sie nach Option A das Tool `dotnet-ef` auf derselben Hauptversion wie die EF-Core-Pakete der App, damit das Verhalten zur Entwurfszeit dem entspricht, was in der Produktion läuft.
- **Npgsql- oder SQL-Server-Pakete auf 10.x in derselben Solution**: unproblematisch, solange sie in verschiedenen Projekten liegen, die nie einen Graphen teilen. Ein Projekt, eine EF-Core-Hauptversion.

## Verwandte Artikel

- Wenn `NU1608` nur auffiel, weil Warnungen Ihren Build fehlschlagen lassen, lesen Sie [TreatWarningsAsErrors, ohne Dev-Builds zu sabotieren](/de/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/), um das streng zu halten, ohne echte Probleme zu verstecken.
- Für das Muster der gemeinsamen Versionseigenschaft aus Option A siehe [Migration einer .NET-Solution zu Central Package Management](/de/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).
- .NET 10 hat auch verändert, welche transitiven Pakete überhaupt in Ihrem Graphen erscheinen: [NuGet Package Pruning ist in .NET 10 standardmäßig aktiv](/de/2026/05/nuget-package-pruning-default-net-10/).
- Wenn stattdessen das Tool `dotnet-ef` und das SDK nicht zusammenpassen, lesen Sie [die Lösung für DotnetToolSettings.xml](/de/2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package/).
- Für die Planung des späteren Sprungs über EF Core 9 hinaus: [EF Core 6 auf EF Core 11 migrieren: Breaking Changes, die wirklich wehtun](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Quellen

- [Pomelo EF Core 10 support tracking issue #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007)
- [Pomelo.EntityFrameworkCore.MySql README: compatibility table and nightly feeds](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql)
- [Pomelo.EntityFrameworkCore.MySql 9.0.0 on NuGet](https://www.nuget.org/packages/Pomelo.EntityFrameworkCore.MySql/9.0.0)
- [Microting.EntityFrameworkCore.MySql auf NuGet](https://www.nuget.org/packages/Microting.EntityFrameworkCore.MySql) und [dessen README zur Namespace-Umbenennung](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql)
- [MySql.EntityFrameworkCore on NuGet](https://www.nuget.org/packages/MySql.EntityFrameworkCore)
- [NuGet-Warnung NU1608](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1608) und [NuGet-Fehler NU1107](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1107)
- [.NET and .NET Core support policy](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)
