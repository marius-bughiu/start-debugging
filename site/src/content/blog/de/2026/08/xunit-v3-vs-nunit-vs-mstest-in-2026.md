---
title: "xUnit v3 vs NUnit vs MSTest in 2026: welches sollten Sie wählen?"
description: "Wählen Sie xUnit v3 für neue .NET-Projekte, NUnit 4.6, wenn Sie im Constraint-Modell zu Hause sind, und MSTest 4, wenn Sie es bereits ausliefern. Ein gemessener Vergleich auf .NET SDK 10.0.201 zu Parallelitäts-Defaults, Lebenszyklus der Testklasse, Fehlermeldungen von Assertions und dem Microsoft.Testing.Platform-Versionskonflikt, der den NUnit-Runner bricht."
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "testing"
  - "xunit"
  - "nunit"
  - "mstest"
  - "dotnet"
lang: "de"
translationOf: "2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026"
translatedBy: "claude"
translationDate: 2026-08-07
---

Wählen Sie **xUnit v3** für ein neues .NET-Projekt in 2026. Es parallelisiert standardmäßig, seine Fehlermeldungen sind die präzisesten der drei, und es ist das, was das .NET-Team verwendet. Wählen Sie **NUnit 4.6**, wenn Ihre Suite auf dem Constraint-Modell oder auf `[Retry]` aufbaut. Wählen Sie **MSTest 4**, wenn Sie MSTest bereits einsetzen und nicht darunter leiden, denn v4 hat den Abstand weitgehend geschlossen.

Alle Zahlen unten wurden auf .NET SDK 10.0.201 (Laufzeit 10.0.5) gegen xunit.v3 3.2.2, NUnit 4.6.1 mit NUnit3TestAdapter 5.1.0 und MSTest 4.3.3 gemessen. Jede Verhaltensaussage in diesem Artikel wurde durch Ausführen von Code überprüft, nicht durch Lesen eines Changelogs, denn vieles vom überlieferten Wissen über diese drei Frameworks ist inzwischen veraltet.

## Die Feature-Matrix

| Verhalten (getestete Versionen) | xUnit v3 3.2.2 | NUnit 4.6.1 | MSTest 4.3.3 |
| --- | --- | --- | --- |
| Standardmäßig parallel | Ja, über Collections hinweg | Nein, opt-in | Nein, opt-in |
| Neue Klasseninstanz pro Test | Ja | Nein, eine pro Fixture | Ja |
| Test-Attribut | `[Fact]` / `[Theory]` | `[Test]` / `[TestCase]` | `[TestMethod]` / `[DataRow]` |
| Marker-Attribut an der Klasse nötig | Nein | Nein | Ja, `[TestClass]` |
| Assertion-Stil | `Assert.Equal` | Constraints, `Assert.That(x, Is...)` | `Assert.AreEqual`, `Assert.That` |
| Gibt den fehlgeschlagenen Ausdruck aus | Nein | Ja | Ja |
| `Assert.Multiple` | Ja | Ja | Nein |
| Eingebautes Retry-Attribut | Nein | Ja, `[Retry(n)]` | Ja, `[Retry(n)]` |
| Projekttyp | Exe, immer | Exe mit dem NUnit-Runner | Exe mit dem MSTest-Runner |
| Microsoft.Testing.Platform | Nativ, eingebaut | Über Adapter 5.0+ | Nativ seit 3.2 |
| Mindest-Target | .NET 8 / .NET Framework 4.7.2 | .NET 6 / .NET Framework 4.6.2 | .NET 8 / .NET Framework 4.6.2 |

Zwei Zeilen dieser Tabelle widersprechen dem, was die meisten Vergleichsartikel schreiben. Beide verdienen einen eigenen Abschnitt.

## Die Aussage zum Instanz-Lebenszyklus, die überall falsch ist

Der am häufigsten wiederholte Satz in diesem Vergleich lautet, dass xUnit pro Test eine frische Testklassen-Instanz erzeugt, während NUnit und MSTest eine Instanz wiederverwenden. Die Hälfte davon ist falsch. MSTest hat schon immer pro Testmethode eine neue Instanz konstruiert.

Hier die Sonde, in allen drei Projekten bis auf die Attribute identisch:

```csharp
// MSTest 4.3.3, .NET 10.0.201
[TestClass]
public class LifecycleTests
{
    private static int _instances;
    private readonly int _id;
    public LifecycleTests() { _id = Interlocked.Increment(ref _instances); }

    private void Record(string n) =>
        File.AppendAllText(Log, $"{n} ctorId={_id} totalInstances={_instances}");

    [TestMethod] public void A() => Record("A");
    [TestMethod] public void B() => Record("B");
    [TestMethod] public void C() => Record("C");
}
```

Jedes der drei ausgeführt:

```text
# xunit.v3 3.2.2
A ctorId=3 totalInstances=3
B ctorId=1 totalInstances=1
C ctorId=2 totalInstances=2

# MSTest 4.3.3
A ctorId=1 totalInstances=1
B ctorId=2 totalInstances=2
C ctorId=3 totalInstances=3

# NUnit 4.6.1
A ctorId=1 totalInstances=1
B ctorId=1 totalInstances=1
C ctorId=1 totalInstances=1
```

xUnit und MSTest haben beide drei Instanzen konstruiert. NUnit hat eine konstruiert und geteilt. NUnit ist der Ausreißer und das einzige der drei, bei dem ein veränderliches Instanzfeld Zustand von einem Test in den nächsten überträgt.

Das wiegt schwerer, als es klingt. Eine einzige Instanz pro Fixture ist genau das Umfeld, in dem eine `[Order]`-abhängige Testsuite still wächst, und es verträgt sich schlecht mit Parallelität: Instanzfelder werden zu geteiltem veränderlichem Zustand, sobald zwei Tests derselben Fixture nebenläufig laufen. NUnits eigene Dokumentation sagt genau das und bietet den Ausweg, der in NUnit 3.13 zurückkam:

```csharp
// NUnit 4.6.1
[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]
public class LifecycleTests { /* ... */ }
```

Mit diesem Attribut gibt dieselbe Sonde `ctorId=1`, `2`, `3` aus. Wenn Sie auf NUnit sind und Parallelität einschalten wollen, setzen Sie es vorher auf Assembly-Ebene. Beachten Sie, dass `OneTimeSetUp` und `OneTimeTearDown` dann `static` werden müssen, da sie nun einmal für eine Fixture laufen, die keine einzelne Instanz mehr hat.

## Der Parallelitäts-Benchmark

Das ist der eine echte Leistungsunterschied, und es geht dabei ausschließlich um Defaults.

**Aufbau**: vier Testklassen, je fünf Tests, jeder Test `Thread.Sleep(200)`. Zwanzig Tests, ein streng sequentieller Lauf hat also eine Untergrenze von 4,0 Sekunden, ein perfekt klassenparalleler Lauf eine von 1,0 Sekunde. Release-Build, direkt als Test-Executable über Microsoft.Testing.Platform ausgeführt, Wanduhrzeit über drei Läufe nach einem Warmlauf, Intel Core Ultra 7 265KF (20 Kerne, 20 logische), Windows 11, .NET SDK 10.0.201.

| Framework | Standardkonfiguration | Mit Parallelität auf Klassenebene |
| --- | --- | --- |
| xunit.v3 3.2.2 | 1,29 - 1,32 s | 1,29 - 1,32 s (bereits der Default) |
| NUnit 4.6.1 | 4,71 - 4,73 s | 1,53 - 1,64 s |
| MSTest 4.3.3 | 4,80 - 4,89 s | 1,66 - 1,69 s |

Out of the box ist xUnit auf dieser Suite 3,6x schneller als NUnit und 3,7x schneller als MSTest. Das ist die Zahl, die zitiert wird. Sie ist auch irreführend, denn sie misst einen Default, keine Fähigkeit. Ein einziges Attribut auf Assembly-Ebene löscht das meiste davon aus:

```csharp
// NUnit 4.6.1
[assembly: Parallelizable(ParallelScope.Fixtures)]
```

```csharp
// MSTest 4.3.3
[assembly: Parallelize(Workers = 0, Scope = ExecutionScope.ClassLevel)]
```

Damit landen alle drei zwischen 1,29 und 1,69 Sekunden. Die verbleibende Spanne von 240 bis 380 ms ist Startup-Overhead des Runners, keine Testausführung: xUnit v3 hostet Microsoft.Testing.Platform nativ, während NUnit 4.6.1 sie über die VSTest-Brücke im NUnit3TestAdapter erreicht, was beim Start etwas mehr kostet.

Die ehrliche Einordnung lautet also so. xUnits Vorteil ist, dass der sichere Default zugleich der schnelle Default ist, und er ist sicher wegen des Instanzmodells pro Test. NUnit und MSTest verlangen ein Opt-in, und bei NUnit sollten Sie zuerst den Fixture-Lebenszyklus korrigieren. Wenn Ihre CI seit drei Jahren eine 12-minütige MSTest-Suite seriell ausführt, ist die Lösung eine Zeile, keine Migration.

## Fehlermeldungen von Assertions im direkten Vergleich

Früher war das ein Erdrutsch. Das ist es nicht mehr. Dieselben drei Fehlschläge, echte Ausgabe jedes Runners:

```text
# xunit.v3 3.2.2
Assert.Equal() Failure: Strings differ
                  ↓ (pos 7)
Expected: "hello world"
Actual:   "hello wurld"
                  ↑ (pos 7)

Assert.Equal() Failure: Collections differ
                 ↓ (pos 2)
Expected: [1, 2, 3, 8]
Actual:   [1, 2, 4, 8]
                 ↑ (pos 2)
```

```text
# NUnit 4.6.1
Assert.That("hello wurld", Is.EqualTo("hello world"))
String lengths are both 11. Strings differ at index 7.
Expected: "hello world"
But was:  "hello wurld"
------------------^

Assert.That(actual, Is.EqualTo(expected))
Expected and actual are both <System.Int32[4]>
Values differ at index [2]
Expected: 3
But was:  4
```

```text
# MSTest 4.3.3
Assertion failed. Expected strings to be equal.
Strings have same length (11) and differ at 1 location(s). First difference at index 7.

expected: "hello world"
actual:   "hello wurld"

Assert.AreEqual("hello world", "hello wurld")
```

Alle drei zeigen auf den exakten Index. NUnit und MSTest 4 geben beide den fehlgeschlagenen Quellausdruck aus, was xUnit nicht tut, weil MSTest 4 `CallerArgumentExpression` zu jeder `Assert`-API hinzugefügt hat und NUnit es seit 4.0 hat. xUnit gleicht das mit den visuellen Positionsmarkern aus, die bei langen Strings und Collections besser sind.

Wo MSTest weiterhin zurückliegt, ist der Collection-Fall: `CollectionAssert.AreEqual` gibt "Element at index 2 do not match" aus, ohne eine der beiden Sequenzen zu zeigen, Sie bekommen also den Index, aber nicht die Form des Diffs. Wenn Sie oft Collections vergleichen, ist das ein echter Papierschnitt.

Zwei API-Details, die Sie kennen sollten, bevor Sie MSTest-4-Assertions schreiben. `Assert.That` nimmt einen `Expression<Func<bool>>`, kein `bool`, `Assert.That(1 + 1 == 2)` kompiliert also nicht, `Assert.That(() => 1 + 1 == 2)` schon. Und MSTest hat kein `Assert.Multiple`; xUnit v3 und NUnit 4.6 haben es beide.

## Der Stolperstein, der für Sie entscheidet

Wenn Sie heute auf dem .NET SDK 10.0.201 ein NUnit-Projekt mit dem nativen NUnit-Runner aufsetzen, bekommen Sie das hier:

```text
error CS1705: Assembly 'NUnit3.TestAdapter' with identity 'NUnit3.TestAdapter, Version=5.1.0.0'
uses 'Microsoft.Testing.Platform, Version=1.8.1.0' which has a higher version than referenced
assembly 'Microsoft.Testing.Platform' with identity 'Microsoft.Testing.Platform, Version=1.7.3.0'
```

NUnit3TestAdapter 5.1.0 ist gegen Microsoft.Testing.Platform 1.8.1 kompiliert, aber nichts im Paketgraphen deklariert diese Abhängigkeit, also gewinnt die Version, die das SDK einspielt: 1.7.3. Das Projekt kompiliert nicht. Die Lösung besteht darin, beide Platform-Assemblies selbst zu pinnen:

```xml
<!-- NUnit 4.6.1 + NUnit3TestAdapter 5.1.0 on .NET SDK 10.0.201 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <EnableNUnitRunner>true</EnableNUnitRunner>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="NUnit" Version="4.6.1" />
  <PackageReference Include="NUnit3TestAdapter" Version="5.1.0" />
  <PackageReference Include="Microsoft.Testing.Platform" Version="1.8.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.VSTestBridge" Version="1.8.1" />
</ItemGroup>
```

Beide Pins sind nötig. Nur `Microsoft.Testing.Platform` hinzuzufügen beseitigt den Fehler, hinterlässt aber eine MSB3277-Konfliktwarnung auf `Microsoft.Testing.Extensions.VSTestBridge`. Mit beiden ist der Build sauber.

Die äquivalenten Projekte für xUnit v3 und MSTest 4 brauchen überhaupt kein Pinning, weil beide Frameworks ihre Platform-Abhängigkeit durchgängig selbst besitzen:

```xml
<!-- xunit.v3 3.2.2 on .NET SDK 10.0.201: this is the whole file -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="xunit.v3" Version="3.2.2" />
</ItemGroup>
```

Diese eine `PackageReference` ist die sauberste Geschichte der drei. NUnits Runner ist eine Brücke über VSTest im MTP-Mantel, und man spürt die Naht. Sie zeigt sich auch in der CLI: xUnit v3 nutzt seine eigene Abfragesprache mit einem einzelnen Bindestrich (`-filter "/*/*/FailingTests/*"`), während der NUnit-Runner VSTest-Syntax nimmt (`--filter "FullyQualifiedName~FailingTests"`) und MSTest MTP-Graph-Abfragen. Drei Frameworks auf einer Plattform, drei Filter-Dialekte.

## Wo jedes einzelne weiterhin gewinnt

**Wählen Sie xUnit v3 3.2.2, wenn** Sie neu auf .NET 8 oder später starten. Das Instanzmodell pro Test entfernt eine ganze Kategorie reihenfolgeabhängiger Fehler, bevor Sie sie schreiben können, Parallelität ist aktiv, ohne dass Sie danach fragen, und v3 hat wirklich nützliche Ergänzungen gebracht: `Assert.Skip`/`Assert.SkipWhen` zum Überspringen zur Laufzeit, `MatrixTheoryData`, Assembly-Fixtures über `[assembly: AssemblyFixture(...)]` und `[CaptureConsole]`, um verirrte `Console.WriteLine`-Aufrufe in die Testausgabe umzuleiten.

**Wählen Sie NUnit 4.6.1, wenn** Ihr Team bereits in Constraints denkt. `Assert.That(items, Has.Exactly(1).EqualTo(2).And.Length.EqualTo(3))` komponiert auf eine Weise, die keines der anderen erreicht, und `[TestCase]`, `[Values]` und `[Combinatorial]` decken parametrisiertes Testen gründlicher ab als `[Theory]` oder `[DataRow]`. Es ist außerdem das einzige der drei, das noch .NET 6 unterstützt, was zählt, wenn Sie ein Nachzügler-Projekt haben. Rechnen Sie das oben beschriebene MTP-Pinning ein und setzen Sie den Fixture-Lebenszyklus explizit.

**Wählen Sie MSTest 4.3.3, wenn** Sie MSTest bereits haben. v4 ist ein echtes Release, keine Wartung: `CallerArgumentExpression` an jedem Assert, `Assert.ThrowsExactly`, `AssemblyFixtureProvider` zum projektübergreifenden Teilen von Assembly-Setup (neu in 4.3.0) und AppDomain-Isolation unter MTP standardmäßig aus, was Microsoft mit bis zu 30 % Beschleunigung gemessen hat. Die Migration von v3 ist nicht gratis, da v4 nicht binärkompatibel ist und .NET Core 3.1 bis .NET 7 fallen lässt, aber die Analyzer und Code-Fixes erledigen den größten Teil der mechanischen Arbeit.

## Was ich tatsächlich tun würde

Neues Projekt in 2026: xUnit v3. Die Standardkonfiguration ist die richtige Konfiguration, und das ist genau die Eigenschaft, die man von einem Test-Framework will, und über die Projektdatei mit einem einzigen Paket lässt sich schwer streiten.

Bestehende NUnit- oder MSTest-Suite: bleiben Sie. Der gemessene Abstand zwischen den dreien liegt, sobald Parallelität aktiviert ist, bei unter 400 ms Startup-Overhead auf einer Suite mit zwanzig Tests. Das ist kein Migrationsbudget. Verbringen Sie den Nachmittag stattdessen damit, `[assembly: Parallelizable(ParallelScope.Fixtures)]` (plus `[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]`) oder `[assembly: Parallelize(...)]` hinzuzufügen, und Sie holen fast den gesamten verfügbaren Gewinn ab.

Die Wahl des Frameworks zählt 2026 deutlich weniger als 2022, weil Microsoft.Testing.Platform jetzt unter allen dreien liegt. Runner, Reporting, CI-Integration und CLI konvergieren. Zu wählen bleiben das Lebenszyklus-Modell und der Assertion-Dialekt, und das sind Vorlieben mit einer einzigen echten Korrektheitsfolge: NUnits geteilte Fixture-Instanz.

## Verwandte Artikel

- Wenn Sie ASP.NET Core-Tests aufsetzen, beginnen Sie mit [Integrationstests mit `WebApplicationFactory<T>`](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/), das über alle drei Frameworks hinweg identisch funktioniert.
- Für Tests, die eine echte Datenbank statt eines Fakes brauchen, siehe [Integrationstests gegen einen echten SQL Server mit Testcontainers](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Zeitabhängige Tests sind die andere häufige Quelle von Flakiness: [Testen mit `TimeProvider` und `FakeTimeProvider`](/de/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).
- Auf der Reporting-Seite bringt [Microsoft.Testing.Platform 2.3 Fehlschläge direkt in das PR-Diff](/de/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/), unabhängig davon, welches Framework sie erzeugt hat.
- Zwei weitere Testmuster, die framework-unabhängig sind: [Unit-Tests für Code, der `HttpClient` verwendet](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/) und [`DbContext` mocken, ohne das Change Tracking zu brechen](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

## Quellen

- [What's New in xUnit.net v3](https://xunit.net/docs/getting-started/v3/whats-new) und [Microsoft Testing Platform support in xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)
- [xUnit.net shared context documentation](https://xunit.net/docs/shared-context) zum Instanzmodell pro Test
- [NUnit `FixtureLifeCycle` documentation](https://docs.nunit.org/articles/nunit/writing-tests/attributes/fixturelifecycle.html)
- [NUnit and Microsoft.Testing.Platform](https://docs.nunit.org/articles/vs-test-adapter/NUnit-And-Microsoft-Test-Platform.html)
- [MSTest migration from v3 to v4](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-migration-v3-v4) und [MSTest test lifecycle](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-writing-tests-lifecycle)
- [Microsoft.Testing.Platform: now supported by all major .NET test frameworks](https://devblogs.microsoft.com/dotnet/mtp-adoption-frameworks/)
- Paketversionen von NuGet: [xunit.v3 3.2.2](https://www.nuget.org/packages/xunit.v3), [NUnit 4.6.1](https://www.nuget.org/packages/NUnit), [MSTest 4.3.3](https://www.nuget.org/packages/MSTest)
