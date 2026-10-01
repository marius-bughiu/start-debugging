---
title: "Fix: dotnet test endet mit Exit-Code 5 und \"Zero tests ran\" auf Microsoft.Testing.Platform"
description: "Exit-Code 5 bedeutet, dass MTP eine Befehlszeilenoption abgelehnt hat, nicht dass Tests fehlen. Führen Sie die Test-Exe direkt aus, um den echten Fehler zu sehen, und fügen Sie dann das Erweiterungspaket hinzu oder leiten Sie die Option projektweise weiter."
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "dotnet-10"
lang: "de"
translationOf: "2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform"
translatedBy: "claude"
translationDate: 2026-10-01
---

Wenn `dotnet test` die Meldung `Zero tests ran` gefolgt von `Exit code: 5` ausgibt, wurden Ihre Tests nie gefunden, weil die Test-App eines der übergebenen Argumente abgelehnt hat. Auf Microsoft.Testing.Platform (MTP) bedeutet Exit-Code 5 "ungültige Befehlszeilenargumente", und `dotnet test` verwirft die Erklärung. Führen Sie die kompilierte Test-Executable mit denselben Argumenten aus (`./bin/Debug/net10.0/MyTests --logger trx`), um die echte Meldung zu sehen. Anschließend referenzieren Sie entweder das Erweiterungspaket, das die Option bereitstellt, ersetzen das VSTest-Flag durch sein MTP-Äquivalent oder leiten die Option mit `TestingPlatformCommandLineArguments` nur an die Projekte weiter, die sie verstehen.

Alles Folgende wurde mit dem .NET 10 SDK 10.0.302 und dem .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) auf macOS arm64 gemessen, mit MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1), MSTest.Sdk 4.3.3 (MTP 2.3.3) und xunit.v3.mtp-v2 4.0.1, mit einer `global.json`, die `dotnet test` in den MTP-Modus schaltet.

## Der Fehler im Kontext

Dies ist die gesamte Ausgabe von `dotnet test --project MsTests --logger trx` mit SDK 10.0.302 für ein MSTest-Projekt mit zwei völlig korrekten Tests:

```text
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0) Zero tests ran
Exit code: 5

Test run summary: Zero tests ran
  error: 1

  total: 0
  failed: 0
  succeeded: 0
  skipped: 0
  duration: 82ms
Test run completed with non-success exit code: 5 (see: https://aka.ms/testingplatform/exitcodes)
```

Beachten Sie, was fehlt: Das Zielframework wird als `(net10.0)` statt als `(net10.0|arm64)` ausgegeben, und es gibt keine Zeile `Running tests from ...`. Der Test-Host hat die Testerkennung nie erreicht. Mit `--output Detailed`, `-v detailed` oder `--diagnostic` kommt der Grund nicht zurück, und die von `--diagnostic` geschriebene `.diag`-Datei enthält nur die rohe Befehlszeile.

Im .NET 11 RC 1 SDK ändert sich die Zusammenfassungszeile zu `Test run summary: Failed!`, und ein neuer Abschnitt `Handshake failures:` listet das Modul auf, der Grund wird aber weiterhin nicht ausgegeben.

In einer Projektmappe mit mehreren Testprojekten ist es leichter misszuverstehen, weil ein Projekt fehlschlägt und das andere besteht:

```text
XTests/bin/Debug/net10.0/XTests.dll (net10.0) Zero tests ran
Exit code: 5
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0|arm64) passed (848ms)
Test run summary: Failed!
  error: 1
  total: 2
```

## Warum MTP Exit-Code 5 liefert und "zero tests ran" meldet

Ein MTP-Testprojekt ist eine normale Konsolen-Executable. `dotnet test` baut im MTP-Modus jedes Testprojekt, startet die Executable, leitet jedes Argument weiter, das es nicht selbst verarbeitet, und kommuniziert mit dem Prozess über eine benannte Pipe. Die Test-App validiert ihre Befehlszeile, bevor sie irgendetwas anderes tut. Ist eine Option unbekannt oder erhält eine bekannte Option einen ungültigen Wert, beendet sie sich mit Exit-Code 5 und erkennt keinen einzigen Test. Die [MTP-Exit-Code-Tabelle](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting#exit-codes) definiert 5 als "die an die Test-App übergebenen Befehlszeilenargumente waren ungültig".

`dotnet test` meldet das Modul dann genauso wie jedes Modul ohne Ergebnisse: `Zero tests ran`. Der Text ist technisch wahr und völlig irreführend, weil er Sie nach fehlenden `[TestMethod]`-Attributen oder einem defekten Filter suchen lässt.

Optionen werden aus vier Gründen unbekannt, in der Reihenfolge, in der ich sie in echten Pipelines sehe:

1. **Ein VSTest-Flag hat die Migration überlebt.** `--logger trx`, `--collect "XPlat Code Coverage"`, `--blame-hang-timeout 5m` und `--blame-crash` gehören zu VSTest. MTP kennt weder `--logger` noch `--collect`.
2. **Das Erweiterungspaket fehlt.** Der MTP-Kern liefert keine Reporter, keine Abdeckung, keine Dumps und keinen Retry mit. `--report-trx` existiert nur, wenn `Microsoft.Testing.Extensions.TrxReport` referenziert ist, `--coverage` benötigt `Microsoft.Testing.Extensions.CodeCoverage`, und so weiter.
3. **Gemischte Frameworks in einer Projektmappe.** MSTest.Sdk aktiviert TRX und Code Coverage standardmäßig. Ein einfaches xUnit-v3-Projekt nicht. Dieselbe Befehlszeile `dotnet test --solution` ist für das eine Projekt gültig und für das andere ungültig.
4. **Ein ungültiger Wert für eine gültige Option.** `--settings` zeigt auf eine Datei, die auf dem Agent nicht existiert, oder `--timeout 30` ohne Einheit.

Exit-Code 8 ist ein anderer Fehler, der denselben Text `Zero tests ran` erzeugt. Dort waren die Argumente in Ordnung und die Test-App hat die Erkennung ausgeführt, aber nichts hat gepasst. Sie unterscheiden die beiden anhand der Zeile `Exit code:` und daran, ob `Running tests from ...` erscheint.

## Minimales Repro

Die `global.json` schaltet `dotnet test` in den MTP-Modus (ab dem .NET 10 SDK erforderlich; ohne sie sind Sie weiterhin auf der VSTest-Bridge):

```json
// .NET 10 SDK 10.0.302
{
  "sdk": { "version": "10.0.302" },
  "test": { "runner": "Microsoft.Testing.Platform" }
}
```

Ein MSTest-Projekt mit dem MSTest SDK:

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MsTests/Tests.cs, .NET 10, MSTest 4.4.1
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace MsTests;

[TestClass]
public class CalculatorTests
{
    [TestMethod]
    public void Adds() => Assert.AreEqual(4, 2 + 2);

    [TestMethod, TestCategory("Slow")]
    public void Multiplies() => Assert.AreEqual(6, 2 * 3);
}
```

Und ein xUnit-v3-Projekt daneben:

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  </ItemGroup>
</Project>
```

Das hat jeder Befehl mit SDK 10.0.302 zurückgegeben:

| Befehl | Exit-Code | Was die Zusammenfassung sagte |
| --- | --- | --- |
| `dotnet test --project MsTests` | 0 | Bestanden, 2 Tests |
| `dotnet test --project MsTests --logger trx` | 5 | Zero tests ran |
| `dotnet test --project MsTests --collect "XPlat Code Coverage"` | 5 | Zero tests ran |
| `dotnet test --project MsTests --blame-hang-timeout 5m` | 5 | Zero tests ran |
| `dotnet test --project MsTests --report-trx` | 0 | Bestanden, TRX geschrieben |
| `dotnet test --solution All.sln --report-trx` | 5 | MSTest bestanden, xUnit "Zero tests ran" |
| `dotnet test --solution All.sln --coverage` | 5 | MSTest bestanden, xUnit "Zero tests ran" |
| `dotnet test --solution All.sln --settings x.runsettings` (Datei fehlt) | 5 | beide "Zero tests ran" |
| `dotnet test --project MsTests --filter "TestCategory=DoesNotExist"` | 8 | Zero tests ran (ein echter Fall) |
| `dotnet test --project MsTests --minimum-expected-tests 5` | 9 | Verstoß gegen die Richtlinie für erwartete Mindesttests |

## Die Lösung im Detail

### 1. Die echte Fehlermeldung aus der Test-App holen

Führen Sie die kompilierte Executable selbst mit genau den Argumenten aus, die CI übergibt. Unter Windows heißt sie `MsTests.exe`, unter Linux und macOS hat sie keine Endung:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
./MsTests/bin/Debug/net10.0/MsTests --logger trx
```

```text
Unknown option '--logger'
Option '--logger' uses VSTest syntax, which is not supported by Microsoft.Testing.Platform.
Use '--report-trx' instead.
Run '--help' to see the options registered by this test application. If the option belongs to an extension, ensure its package is referenced and the extension is registered.
Command line: --logger trx
```

`dotnet run --project MsTests --no-build -- --logger trx` gibt dasselbe aus und liefert ebenfalls 5. Der Hinweis "uses VSTest syntax ... Use '--report-trx' instead" ist neu in MTP 2.4. MTP 2.3.3 (MSTest.Sdk 4.3.3) gibt nur `Unknown option '--logger'` gefolgt vom Hilfetext aus, was trotzdem ausreicht.

Fragen Sie als Nächstes die App, welche Optionen sie tatsächlich hat. `--help` listet Plattformoptionen und getrennt davon "Extension options", die von referenzierten Paketen beigesteuert werden. `--info` gibt die Plattformversion und jede registrierte Erweiterung mit ihrer eigenen Version aus:

```bash
# .NET 10 SDK 10.0.302
./XTests/bin/Debug/net10.0/XTests --help
./XTests/bin/Debug/net10.0/XTests --info
```

Steht die übergebene Option nicht in dieser Liste, scheitert sie mit Exit-Code 5. Allein diese Prüfung löst die meisten dieser Tickets.

### 2. VSTest-Flags durch ihre MTP-Äquivalente ersetzen

| VSTest-Argument | MTP-Argument | Paket, das es bereitstellt |
| --- | --- | --- |
| `--logger trx` | `--report-trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--logger trx;LogFileName=x.trx` | `--report-trx --report-trx-filename x.trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--collect "Code Coverage"` | `--coverage` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--collect "XPlat Code Coverage"` | `--coverage --coverage-output-format cobertura` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--blame-hang-timeout 5m` | `--hangdump --hangdump-timeout 5m` | `Microsoft.Testing.Extensions.HangDump` |
| `--blame-crash` | `--crashdump` | `Microsoft.Testing.Extensions.CrashDump` |
| `--results-directory` | `--results-directory` | integriert |

Zum Zeitpunkt des Schreibens sind die aktuellen Versionen 2.4.1 für TrxReport, HangDump und CrashDump sowie 18.11.2 für CodeCoverage. Die [Referenz der MTP-CLI-Optionen](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options) enthält die vollständige Zuordnung. `--filter` behält für MSTest und NUnit seine VSTest-Ausdruckssyntax, muss also meist nicht geändert werden.

### 3. Die Erweiterung in jedem Projekt referenzieren, das die Option erhält

Im Repro scheiterte das projektmappenweite `--report-trx` nur, weil dem xUnit-Projekt der Reporter fehlte. Das Hinzufügen behob den Lauf:

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<ItemGroup>
  <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.4.1" />
</ItemGroup>
```

```text
MsTests.dll (net10.0|arm64) passed (837ms)
XTests.dll (net10.0|arm64) passed (922ms)
Test run summary: Passed!
  total: 4
```

Soll jedes Testprojekt TRX und Abdeckung erzeugen, legen Sie die Referenzen in eine `Directory.Build.props`, die an `IsTestProject` gebunden ist, damit neue Projekte sie automatisch übernehmen. MSTest.Sdk-Projekte bringen sie bereits mit. Fügen Sie daher die Bedingung `'$(UsingMSTestSdk)' != 'true'` hinzu, wenn Sie doppelte Referenzen vermeiden möchten.

### 4. Optionen mit TestingPlatformCommandLineArguments pro Projekt weiterleiten

Manchmal möchten Sie die Erweiterung nicht überall haben. Abdeckung aus einem Integrationstestprojekt ist oft nur Rauschen, und Dumps sind nur für das Projekt nützlich, das hängt. Statt die Option in der `dotnet test`-Befehlszeile zu übergeben, tragen Sie sie in das Projekt ein, das sie versteht:

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <TestingPlatformCommandLineArguments>$(TestingPlatformCommandLineArguments) --coverage --coverage-output-format cobertura</TestingPlatformCommandLineArguments>
  </PropertyGroup>
</Project>
```

Damit lieferte ein einfaches `dotnet test --solution All.sln` Exit-Code 0, das xUnit-Projekt lief ohne Abdeckung, und das MSTest-Projekt schrieb eine `.cobertura.xml` in `TestResults`. Microsoft dokumentiert denselben Ansatz für [Projektmappen mit gemischten Testframeworks oder Erweiterungen](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions). Setzen Sie `$(TestingPlatformCommandLineArguments)` an den Anfang, damit Werte aus `Directory.Build.props` nicht überschrieben werden.

### 5. Werte validieren, nicht nur Namen

Steht die Option in `--help` und Sie erhalten trotzdem Exit-Code 5, ist der Wert falsch. Im Repro ließ `--settings x.runsettings` mit fehlender Datei beide Projekte mit Exit-Code 5 scheitern. Pfade werden ab dem Arbeitsverzeichnis des Testprozesses aufgelöst, das in CI nicht immer das Repository-Stammverzeichnis ist. Zeitwerte brauchen in MTP Einheiten: `--timeout 30m` funktioniert, eine bloße Zahl nicht.

## Exit-Code 8: wenn tatsächlich null Tests liefen

Ist der Exit-Code 8, wurden die Argumente akzeptiert, und der Filter oder das Projekt hat schlicht keine Tests ergeben. MTP wertet das standardmäßig als Fehler, anders als VSTest, das 0 zurückgab. Sie haben drei Stellschrauben:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1

# Accept an empty run for this invocation (returns 0)
dotnet test --project MsTests --filter "TestCategory=Nightly" --ignore-exit-code 8

# Or demand a floor: fewer than 50 tests returns exit code 9
dotnet test --solution All.sln --minimum-expected-tests 50
```

`--ignore-exit-code` liest auch die Umgebungsvariable `TESTINGPLATFORM_EXITCODE_IGNORE`, was praktisch ist, wenn derselbe Filter in vielen Pipelines läuft. Setzen Sie sie sparsam ein: Ein Filter, der stillschweigend nichts trifft, ist genau der Fehler, den Exit-Code 8 aufdecken soll.

Die SDK-Version spielt bei Mehrprojektläufen eine Rolle. Mit SDK 10.0.302 lieferte ein Projektmappenlauf, bei dem ein Projekt den Filter erfüllte und das andere nichts, für den gesamten Lauf 8. Mit dem .NET 11 RC 1 SDK lieferte derselbe Befehl 0 mit `Test run summary: Passed!`, gab aber weiterhin `Exit code: 8` neben dem leeren Modul aus. Das ist das neue [Zero-Tests-Urteil für den gesamten Lauf](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp) im .NET 11 SDK. Wird Ihre CI mit .NET 10 rot und mit .NET 11 grün bei demselben Filter, ist das der Grund. Exit-Code 5 hat sich nicht geändert: Beide SDKs lassen den gesamten Lauf scheitern, wenn ein Modul seine Argumente ablehnt.

## Stolperfallen und Doppelgänger

- **`error: 1` in der Zusammenfassung ist das Modul, kein Test.** Es zählt Module, die abnormal beendet wurden. `failed: 0` bleibt bei null, weil kein Test ausgeführt wurde.
- **`dotnet test -- --some-option` hilft nicht.** Im MTP-Modus werden die Argumente in jedem Fall weitergeleitet, der doppelte Bindestrich verbirgt sie also nicht vor der Test-App.
- **Ein MTP-Filter ohne Treffer liefert 8, nicht 5.** Sehen Sie vor `Zero tests ran` die Zeile `Running tests from ...`, waren Ihre Argumente in Ordnung. Prüfen Sie stattdessen die Filtersyntax des Frameworks.
- **`--zero-tests-policy strict` änderte meinen Lauf mit nur übersprungenen Tests nicht.** Laut Dokumentation behandelt strict übersprungene Tests als nicht ausgeführt. Mit MTP 2.4.1 lieferte ein Projekt, dessen einziger Test `[Ignore]` trug, unter strict dennoch 0, verlassen Sie sich also nicht allein darauf als Absicherung. `--minimum-expected-tests` ist explizit und zuverlässig.
- **"No test projects were found" ist ein anderes Problem.** Es stammt aus der Projektauswertung (typischerweise `--no-restore` in einer Container-Stage ohne den Ordner `obj`), nicht aus der Test-App. Die MTP-Troubleshooting-Seite behandelt es.
- **Der Test-Explorer kann seine eigene Variante davon zeigen.** Ist die CLI grün und Visual Studio hängt bei xUnit v3, ist das ein Runner-Konflikt, kein Argumentproblem.

## Verwandte Artikel

- Die schrittweise [Migration von VSTest zu Microsoft.Testing.Platform](/de/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) behandelt die übrigen CI-Änderungen, einschließlich `.runsettings` zu `testconfig.json`.
- Hängt Visual Studio, während die CLI besteht, lesen Sie [Test-Explorer hängt bei xUnit v3, während dotnet test besteht](/de/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).
- Ein Framework für eine neue Projektmappe wählen, mit verglichener MTP-Unterstützung: [xUnit v3 vs NUnit vs MSTest in 2026](/de/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).
- Ein älteres xUnit-Projekt zuerst auf MTP umstellen: [ein Testprojekt von xUnit v2 auf xUnit v3 migrieren](/de/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).
- Fehler direkt in Pull Requests annotieren: [Microsoft.Testing.Platform 2.3 GitHub-Actions-Annotationen](/de/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/).

## Quellen

- [Microsoft.Testing.Platform troubleshooting: exit codes and unrecognized extension options](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting)
- [Microsoft.Testing.Platform CLI options reference](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options)
- [Testing with dotnet test: solutions with mixed test frameworks or extensions](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions)
- [dotnet test in MTP mode, including whole-run minimums](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [microsoft/testfx repository (MSTest and Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)
