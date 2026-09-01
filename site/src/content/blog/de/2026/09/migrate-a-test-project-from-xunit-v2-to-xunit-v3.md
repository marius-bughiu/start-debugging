---
title: "Ein Testprojekt von xUnit v2 auf xUnit v3 migrieren (2.9.3 auf 4.0.0)"
description: "Schrittweise Migration von xunit 2.9.3 auf xunit.v3 4.0.0: Pakettausch, die Umstellung von OutputType auf Exe, IAsyncLifetime mit ValueTask, der Wegfall von Xunit.Abstractions und die CI-Filtersyntax, die stillschweigend nichts mehr trifft."
pubDate: 2026-09-01
template: migration
tags:
  - "migration"
  - "xunit"
  - "xunit-v3"
  - "testing"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
lang: "de"
translationOf: "2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3"
translatedBy: "claude"
translationDate: 2026-09-01
---

Die Migration eines normalen Testprojekts von `xunit` 2.9.3 auf `xunit.v3` 4.0.0 kostet etwa eine Stunde mechanische Arbeit: vier Paketreferenzen tauschen, `OutputType` auf `Exe` stellen, jedes `using Xunit.Abstractions;` löschen und `IAsyncLifetime` von `Task` auf `ValueTask` umstellen. Den Tag frisst alles rundherum: Ein Paket eines Drittanbieters ohne v3-Build bricht die Kompilierung mit einem doppelten `FactAttribute` ab, und der Ausdruck `dotnet test --filter` in der CI trifft plötzlich nichts mehr, ohne dass der Build fehlschlägt. Die Migration lohnt sich (v3 ist seit dem Erscheinen von 2.9.3 im Januar 2025 die einzige Linie, die noch Funktionen bekommt), und sie ist umkehrbar, bis Sie den alten Branch löschen. Alles Folgende wurde gegen `xunit.v3` 4.0.0 verifiziert, veröffentlicht am 2026-08-15, auf den SDKs von .NET 10 und .NET 11.

## Warum das keine bloße Versionsanhebung ist

- **v2 ist funktional eingefroren.** 2.9.3 (2025-01-08) ist das letzte v2-Release. `TestContext`, Timeouts mit echter Abbruchunterstützung, Fixtures auf Assembly-Ebene, dynamisches Überspringen von Tests und die Filterabfragesprache gibt es nur in v3.
- **Testprojekte werden zu ausführbaren Dateien.** Ein v3-Projekt hat einen generierten Einstiegspunkt und führt sich selbst aus. Damit entfällt die gesamte Fehlerklasse aus nicht zusammenpassenden Runner- und Framework-Versionen, und genau das macht Native-AOT-Testbuilds in 4.0.0 möglich.
- **`TestContext.Current.CancellationToken` macht Timeouts wirksam.** In v2 konnte ein `[Fact(Timeout = ...)]` auf einem nicht asynchronen Test gar nichts unterbrechen. In v3 fließt das Token in Ihren Code, sodass ein hängender HTTP-Aufruf tatsächlich abgebrochen wird.
- **Microsoft.Testing.Platform ist optional, aber nativ.** Das Metapaket `xunit.v3` 4.0.0 löst auf `xunit.v3.mtp-v2` auf, das MTP v2 mitbringt. Sie bekommen `--report-trx`, CTRF-Ausgabe und einen deutlich schnelleren Start ohne VSTest-Hostprozess.

## Was bricht

| Bereich | Änderung | Schweregrad |
| ------- | -------- | ----------- |
| `xunit.abstractions` | Paket und Namespace sind weg. `ITestOutputHelper` liegt jetzt in `Xunit` | hoch |
| Projektform | `OutputType` muss `Exe` sein; nur Projekte im SDK-Format | hoch |
| Zielframework | Minimum ist `net472` oder `net8.0`. `netcoreapp3.1` bis `net7.0` fallen raus | hoch |
| `IAsyncLifetime` | Erbt von `IAsyncDisposable`; beide Methoden liefern `ValueTask`, nicht `Task` | hoch |
| `async void`-Tests | Brechen zur Laufzeit sofort ab, statt zu laufen | hoch |
| Pakete von Drittanbietern | Jedes Paket mit Referenz auf `xunit.core` 2.x kollidiert mit `xunit.v3.core` | hoch |
| CI-Filter | VSTest-`--filter`-Ausdrücke werden unter MTP nicht unterstützt | hoch |
| `MemberDataAttribute` | `Parameters` heißt jetzt `Arguments`; `ConvertDataItem` heißt `ConvertDataRow` | mittel |
| Orderer- / Framework-Attribute | `CollectionBehavior`, `TestCaseOrderer` und `TestFramework` nehmen `Type` statt Zeichenketten | mittel |
| `AssemblyTraitAttribute` | Entfernt. Stattdessen `[assembly: Trait(...)]` verwenden | niedrig |
| `PropertyDataAttribute` | Entfernt (seit v1 veraltet) | niedrig |
| Freigabe von Ressourcen | Implementiert ein Fixture `IDisposable` und `IAsyncDisposable`, wird nur `DisposeAsync` aufgerufen | mittel |

Die beiden Zeilen, um die herum geplant werden muss, sind die Drittanbieter- und die CI-Zeile. Auf alles andere weist der Compiler hin.

## Checkliste vor dem Start

- **SDK von .NET 8 oder neuer installiert.** `xunit.v3` 4.0.0 zielt auf `net472` und `net8.0`; für das Kernpaket gibt es keine `netstandard2.0`-Oberfläche.
- **Alle Testprojekte liegen im SDK-Format vor.** `.csproj`-Dateien im alten Format werden überhaupt nicht unterstützt. Konvertieren Sie zuerst, in einem eigenen Commit.
- **Inventarisieren Sie Ihre xUnit-nahen Pakete.** Führen Sie `dotnet list package --include-transitive | grep -i xunit` in jedem Testprojekt aus und notieren Sie das Ergebnis. Diese Liste entscheidet, ob die Migration eine Stunde oder eine Woche dauert.
- **Wissen Sie, welchen Runner Ihre CI nutzt.** Suchen Sie in der Pipeline nach `dotnet test`, `--filter`, `--logger` und `vstest.console.exe`.
- **Branch anlegen.** Migrieren Sie zuerst ein Testprojekt vollständig durch die CI, bevor Sie die übrigen anfassen.

## Migrationsschritte

1. **Zielframework des Testprojekts anheben und es zur ausführbaren Datei machen.**

   Heben Sie `TargetFramework` auf `net8.0` oder neuer an und setzen Sie `OutputType`. Der generierte Einstiegspunkt kommt aus dem Paket; Sie schreiben kein `Main`.

   ```xml
   <!-- MyApp.Tests.csproj, .NET 10 SDK, xunit.v3 4.0.0 -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <OutputType>Exe</OutputType>
     <Nullable>enable</Nullable>
     <ImplicitUsings>enable</ImplicitUsings>
   </PropertyGroup>
   ```

   Prüfen: `dotnet build` scheitert an fehlenden xUnit-Typen, nicht an Fehlern der Projektform. Wenn das Testprojekt bereits Top-Level-Anweisungen enthält, setzen Sie `<XunitAutoGeneratedEntryPoint>false</XunitAutoGeneratedEntryPoint>` und übernehmen den Einstiegspunkt selbst.

2. **Paketreferenzen tauschen.**

   Die Zuordnung von v2 auf v3 ist eins zu eins, außer dass `xunit.abstractions` verschwindet und `xunit.console` keinen Nachfolger hat.

   ```xml
   <!-- before: xunit 2.9.3 -->
   <ItemGroup>
     <PackageReference Include="xunit" Version="2.9.3" />
     <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
     <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
   </ItemGroup>

   <!-- after: xunit.v3 4.0.0 -->
   <ItemGroup>
     <PackageReference Include="xunit.v3" Version="4.0.0" />
     <PackageReference Include="xunit.runner.visualstudio" Version="4.0.0" />
     <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
   </ItemGroup>
   ```

   `xunit.v3` 4.0.0 löst auf `xunit.v3.mtp-v2` auf und zieht damit `xunit.v3.core.mtp-v2`, `xunit.v3.assert` und `xunit.analyzers` 2.0.0 herein. Behalten Sie `xunit.runner.visualstudio` 4.0.0 und `Microsoft.NET.Test.Sdk` vorerst: Das Runner-Paket beherrscht v1, v2 und v3, sodass Test-Explorer und VSTest weiterlaufen, während Sie den Rest der Solution migrieren. Bei Central Package Management gehört das stattdessen in `Directory.Packages.props`, was genau der Sinn davon ist, [eine Solution auf Directory.Packages.props umzustellen](/de/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).

   Prüfen: `dotnet restore` läuft ohne NU1605-Downgrade-Warnungen und ohne Fehler wegen doppelter Typen durch.

3. **Jedes `using Xunit.Abstractions;` löschen.**

   `ITestOutputHelper` liegt jetzt in `Xunit`, neben `Fact` und `Assert`, sodass die Korrektur in den meisten Dateien darin besteht, eine Zeile zu entfernen.

   ```csharp
   // xunit.v3 4.0.0 - no Xunit.Abstractions anywhere
   using Xunit;

   public class OrderServiceTests(ITestOutputHelper output)
   {
       [Fact]
       public void Prices_include_tax()
       {
           output.WriteLine("running");   // v3 also adds Write(), not just WriteLine()
           Assert.Equal(120m, new OrderService().Total(100m));
       }
   }
   ```

   Prüfen: `grep -rn "Xunit.Abstractions" .` liefert unterhalb Ihrer Testprojekte nichts mehr.

4. **`IAsyncLifetime`-Implementierungen auf `ValueTask` umstellen.**

   Das ist die Änderung, die am häufigsten schiefgeht, weil der Compilerfehler auf den Rückgabetyp zeigt und die Freigabesemantik dahinter verbirgt. `IAsyncLifetime` erbt jetzt von `IAsyncDisposable`, und beide Member liefern `ValueTask`.

   ```csharp
   // v2: xunit 2.9.3
   public class DbFixture : IAsyncLifetime
   {
       public Task InitializeAsync() => _container.StartAsync();
       public Task DisposeAsync()    => _container.DisposeAsync().AsTask();
   }

   // v3: xunit.v3 4.0.0
   public class DbFixture : IAsyncLifetime
   {
       public ValueTask InitializeAsync() => new(_container.StartAsync());
       public ValueTask DisposeAsync()    => _container.DisposeAsync();
   }
   ```

   Die Falle: Implementiert Ihr Fixture `IDisposable` **und** `IAsyncLifetime`, rief v2 `Dispose()` auf, v3 tut das nicht. Es ruft nur `DisposeAsync()` auf, gemäß der .NET-Richtlinie, das eine oder das andere aufzurufen. Aufräumcode, der ausschließlich in `Dispose()` lag, läuft still nicht mehr, was sich meist als übrig gebliebener Testcontainers-Container oder nicht gelöschtes temporäres Verzeichnis zeigt statt als fehlschlagender Test. Verschieben Sie diesen Aufräumcode nach `DisposeAsync()`. Besonders relevant ist das für das Muster mit einem Container pro Fixture aus den [Integrationstests gegen einen echten SQL Server mit Testcontainers](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).

   Prüfen: Lassen Sie die Suite laufen und bestätigen Sie mit `docker ps -a`, dass keine verwaisten Container übrig bleiben.

5. **`async void`-Tests korrigieren und die mechanischen Attributumbenennungen anwenden.**

   v3 lässt `async void`-Tests zur Laufzeit sofort fehlschlagen, statt sie ohne Rückmeldung laufen zu lassen, also ändern Sie die Signatur auf `async Task`. Es ist dieselbe Argumentation wie in [async void vs async Task in C#](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), nur dass das Framework sie jetzt erzwingt. Danach folgen die Umstellungen von Zeichenketten auf `Type`:

   ```csharp
   // v2
   [assembly: CollectionBehavior("MyTests.MyCollectionFactory", "MyTests")]
   [assembly: AssemblyTrait("Category", "Integration")]

   // v3, xunit.v3 4.0.0
   [assembly: CollectionBehavior(typeof(MyCollectionFactory))]
   [assembly: Trait("Category", "Integration")]
   ```

   `TestCaseOrdererAttribute`, `TestCollectionOrdererAttribute` und `TestFrameworkAttribute` werden genauso behandelt. `MemberDataAttribute.Parameters` heißt jetzt `Arguments`, und wer von `MemberDataAttributeBase` abgeleitet hat: `ConvertDataItem` wurde zu `ConvertDataRow` und liefert `ITheoryDataRow` statt `object[]`.

   Prüfen: `dotnet build` ist sauber bis auf `xUnit1051`-Warnungen, um die es im nächsten Schritt geht.

6. **`TestContext.Current.CancellationToken` durch Ihre `await`-Aufrufe reichen.**

   `xunit.analyzers` 2.0.0 meldet `xUnit1051` bei jedem Aufruf, der ein `CancellationToken` annimmt und keines bekommt. Es ist eine Warnung, kein Fehler, und Sie können ohne diese Änderung migrieren, aber das Token ist der Hauptgrund, überhaupt auf v3 zu sein.

   ```csharp
   // xunit.v3 4.0.0 - the token cancels when the test times out or the run is aborted
   [Fact(Timeout = 5000)]
   public async Task Fetches_the_order()
   {
       var ct = TestContext.Current.CancellationToken;
       var response = await _client.GetAsync("/orders/1", ct);
       Assert.Equal(HttpStatusCode.OK, response.StatusCode);
   }
   ```

   Prüfen: `dotnet build -warnaserror:xUnit1051` läuft durch, sobald Sie fertig sind, oder Sie belassen es bei der Warnung und kommen später darauf zurück.

7. **Die CI auf die neue Filtersyntax umstellen.**

   Danach entscheiden Sie, ob Sie Microsoft.Testing.Platform aktivieren. Unter MTP akzeptiert xUnit die Ausdruckssprache von VSTest `--filter` nicht; es bietet `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, die zugehörigen `--filter-not-*`-Varianten und `--filter-query`. Auf den SDKs von .NET 8 und 9 aktivieren Sie das pro Projekt:

   ```xml
   <!-- .NET 8/9 SDK -->
   <PropertyGroup>
     <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   </PropertyGroup>
   ```

   Ab dem SDK von .NET 10 aktivieren Sie es einmalig für das gesamte Repository:

   ```json
   // global.json
   {
     "test": { "runner": "Microsoft.Testing.Platform" }
   }
   ```

   Und der Filter selbst ändert seine Form:

   ```bash
   # before, VSTest
   dotnet test --filter "Category!=Integration"

   # after, MTP with xunit.v3 4.0.0
   dotnet test -- --filter-not-trait "Category=Integration"
   ```

   Prüfen: Führen Sie den gefilterten Befehl aus und bestätigen Sie, dass die gemeldete Testanzahl kleiner ist als die ungefilterte. Verlassen Sie sich hier nicht auf einen grünen Build, denn ein Filter, der nichts trifft, beendet sich mit Code null.

## Die Migration verifizieren

Führen Sie das der Reihe nach aus und behandeln Sie jede Überraschung bei der Testanzahl als Fehlschlag, auch wenn der Exit-Code null ist.

- `dotnet build -c Release` ohne Warnungen außer den bereits bewerteten.
- `dotnet run --project MyApp.Tests -- --list`, um zu bestätigen, dass die Erkennung so viele Tests findet, wie Sie erwarten.
- `dotnet test` und den Gesamtwert mit dem letzten v2-Lauf vergleichen. Ein Rückgang bedeutet fast immer einen Filter oder einen übersprungenen `async void`-Test.
- Öffnen Sie den Test-Explorer einmal. Laufen die Tests auf der Kommandozeile, während Visual Studio hängt, ist das das [Hängen des Test-Explorers bei xUnit-v3-Projekten](/de/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/) und keine schlechte Migration.
- Kontrollieren Sie die Werte der Codeabdeckung. Coverlet klinkt sich unter MTP anders ein, und ein Abdeckungsbericht, der plötzlich 0 % ausweist, ist ein Verdrahtungsproblem, keine Regression.

## Rollback

Diese Migration ist vollständig umkehrbar: Es sind Paketreferenzen plus Quelltextänderungen, ohne Zustand auf der Festplatte und ohne Datenbankschema. Ein `git revert` des Commits lässt die v2-Suite wieder laufen, sofern Sie im selben Commit nicht auch das Zielframework unter `net8.0` gesenkt haben. Genau deshalb gehört die Framework-Umstellung in einen eigenen Commit. Einseitig ist nur ein Fork eines Drittanbieterpakets, den Sie veröffentlichen mussten (siehe unten), und der bleibt so oder so nützlich.

## Details, die man vorher kennen sollte

**Der Fehler wegen doppeltem `FactAttribute`.** Referenziert irgendein Paket im Graph noch `xunit.core` 2.x, bekommen Sie:

```
error CS0433: The type 'FactAttribute' exists in both
'xunit.core, Version=2.4.2.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c' and
'xunit.v3.core, Version=4.0.0.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c'
```

Ein Alias-Trick lohnt sich hier nicht. Entweder das Paket hat einen v3-Build oder nicht. Stand September 2026: `Verify.XunitV3` 32.0.0, `AutoFixture.Xunit3` 4.19.0, `Xunit.DependencyInjection` 12.0.1 und `MartinCostello.Logging.XUnit.v3` 0.7.1 referenzieren alle `xunit.v3.*` 4.x. `Serilog.Sinks.XUnit` 3.0.19 zieht weiterhin `xunit.abstractions` 2.0.3 und `xunit.extensibility.core` 2.9.2 herein und ist damit ein harter Blocker; der übliche Ausweg ist ein kleiner Sink im eigenen Repository, der direkt in `ITestOutputHelper` schreibt, etwa dreißig Zeilen.

**`Xunit.SkippableFact` ist jetzt Ballast.** Entfernen Sie es. v3 hat `Assert.Skip(reason)`, `Assert.SkipWhen(condition, reason)` und `Assert.SkipUnless(condition, reason)` sowie die Eigenschaften `SkipWhen` und `SkipUnless` auf `[Fact]` und `[Theory]`, die auf eine öffentliche statische `bool`-Eigenschaft der Testklasse zeigen. `SkipWhen` und `SkipUnless` gleichzeitig auf einem Attribut zu setzen, ist ein Laufzeitfehler, kein Compilerfehler.

**Attributinstanzen werden in v3 zwischengespeichert.** v2 erzeugte pro Abfrage eine neue Instanz; v3 speichert sie zwischen, was dem normalen Reflexionsverhalten von .NET entspricht. Eigene Attribute, die ihren Zustand zwischen Erkennung und Ausführung veränderten, verhalten sich anders.

**Versionsfestlegung über die gesamte Solution.** `xunit.v3` 4.0.0 legt `xunit.v3.mtp-v2` auf den exakten Bereich `[4.0.0, 4.0.0]` fest, sodass gemischte Versionen zwischen Projekten als Restore-Konflikte auftreten statt als Merkwürdigkeiten zur Laufzeit. Das ist eine Funktion, bedeutet aber: Sie aktualisieren alle Testprojekte in einem Commit oder keines.

**Eigene `ITestCaseOrderer`-Implementierungen haben sich in 4.0.0 geändert**, nicht nur zwischen v2 und v3. Die Sortierung läuft jetzt über Collection, dann Klasse, dann Methode, dann Fall, und es gibt getrennte Erweiterungspunkte für Klassen und Methoden. Wer einen v2-Orderer unverändert durch v3.2.2 mitgeschleppt hat, stellt bei 4.0.0 fest, dass er nicht mehr kompiliert.

**`WebApplicationFactory<T>` braucht keine Änderungen.** Integrationstests für ASP.NET Core migrieren reibungslos; das Fixture-Muster aus [Integrationstests mit WebApplicationFactory](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) funktioniert unverändert, sobald `IAsyncLifetime` `ValueTask` liefert.

## Verwandte Artikel

- [xUnit v3 vs NUnit vs MSTest 2026: welches sollten Sie wählen?](/de/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [Fix: Der Test-Explorer von Visual Studio hängt bei einem xUnit-v3-Projekt, während dotnet test durchläuft](/de/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/)
- [Microsoft.Testing.Platform 2.3 zeigt Testfehler direkt im PR-Diff](/de/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [Integrationstests mit WebApplicationFactory in ASP.NET Core 11 schreiben](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [Eine .NET-Solution mit Directory.Packages.props auf Central Package Management umstellen](/de/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## Quellen

- [Migrating Unit Tests from v2 to v3](https://xunit.net/docs/getting-started/v3/migration) -- xUnit.net
- [What's New in v3?](https://xunit.net/docs/getting-started/v3/whats-new) -- xUnit.net
- [Microsoft Testing Platform (xUnit.net v3)](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform) -- xUnit.net
- [Release Notes zu xUnit.net v3 4.0.0](https://xunit.net/releases/v3/4.0.0) -- xUnit.net
- [Migrationsleitfaden von VSTest zu Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform) -- Microsoft Learn
- [xunit.v3 auf NuGet](https://www.nuget.org/packages/xunit.v3/4.0.0) -- Paketmetadaten und Abhängigkeitsbereiche
- [Migrating from XUnit v2 to v3: troubleshooting](https://bartwullems.blogspot.com/2025/09/migrating-from-xunit-v2-to.html) -- Bart Wullems
