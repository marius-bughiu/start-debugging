---
title: "Fix: dotnet test fällt in einer Linux-CI-Pipeline auf VSTest zurück, obwohl das Projekt Microsoft.Testing.Platform verwendet"
description: "dotnet test wählt seinen Runner anhand der global.json, die ausgehend vom Arbeitsverzeichnis nach oben gesucht wird. Auf Linux-CI fällt es auf VSTest zurück, wenn diese Datei fehlt, falsch benannt ist, einen Schlüssel in falscher Schreibweise enthält oder das SDK älter als 10 ist."
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "ci-cd"
  - "dotnet-10"
lang: "de"
translationOf: "2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform"
translatedBy: "claude"
translationDate: 2026-10-07
---

Wenn `dotnet test` Ihre Microsoft.Testing.Platform-Tests (MTP) auf einem Linux-Build-Agent über VSTest ausführt, auf Ihrem Rechner aber nicht, hat die CLI Ihre Runner-Auswahl nicht gesehen. `dotnet test` entscheidet zwischen VSTest und MTP, bevor irgendetwas kompiliert wird: Es sucht nach einer `global.json`, beginnend im **aktuellen Arbeitsverzeichnis** und von dort aufwärts, und liest einen Abschnitt `"test": { "runner": "Microsoft.Testing.Platform" }` mit genau diesen kleingeschriebenen Eigenschaftsnamen. Unter Linux muss die Datei in Kleinbuchstaben `global.json` heißen, der Job muss innerhalb des Repositorys laufen, und das SDK muss Version 10.0 oder neuer sein. Beheben Sie, was Ihre Pipeline davon verletzt, und sorgen Sie dann dafür, dass CI laut fehlschlägt, falls es erneut passiert.

Alles Folgende wurde auf macOS arm64 gemessen (einschließlich eines Case-Sensitive-APFS-Volumes, das sich wie ein Linux-Dateisystem verhält), mit dem .NET 10 SDK 10.0.302, dem .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) und dem .NET 9 SDK 9.0.318, gegen MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) und xunit.v3 3.2.2 (MTP v1 mit `xunit.runner.visualstudio` 3.1.5).

## Der Fehler im Kontext

Wie sich das "Zurückfallen auf VSTest" äußert, hängt davon ab, welche MTP-Version Ihre Testprojekte verwenden. Projekte mit MTP 2.x (MSTest 4.x, MSTest.Sdk 4.x, `xunit.v3.mtp-v2`) weigern sich zu laufen und lassen den Job fehlschlagen:

```text
Microsoft.Testing.Platform.MSBuild.targets(355,5): error : Testing with VSTest target is no longer supported by Microsoft.Testing.Platform on .NET 10 SDK and later. If you use dotnet test, you should opt-in to the new dotnet test experience. For more information, see https://aka.ms/dotnet-test-mtp-error [/src/tests/SdkTests/SdkTests.csproj]
```

Verwendet Ihre Pipeline die nur für MTP gültige Syntax zur Auswahl der Tests, tritt der Fehler sogar noch früher auf, weil das `dotnet test` im VSTest-Modus den unbekannten Schalter an MSBuild weiterreicht:

```text
MSBUILD : error MSB1001: Unknown switch.
    Full command line: '/usr/share/dotnet/sdk/10.0.302/MSBuild ... --target:VSTest --nologo -nodereuse:false --solution src/Repo.slnx ...'
Switch: --solution
```

Die gefährliche Variante ist die, die grün bleibt. Ein Projekt mit MTP v1, das noch einen VSTest-Adapter referenziert (`xunit.v3` 3.x mit `xunit.runner.visualstudio` oder MSTest 3.x mit `Microsoft.NET.Test.Sdk`), läuft unter VSTest problemlos:

```text
Test run for /src/tests/XTests/bin/Debug/net10.0/XTests.dll (.NETCoreApp,Version=v10.0)
A total of 1 test files matched the specified pattern.
Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 6 ms - XTests.dll (net10.0)
```

In diesem Modus liefert `dotnet test -- --report-trx` ebenfalls Exit-Code 0 und schreibt überhaupt keine TRX-Datei, weil alles nach `--` als RunSettings-Argumente behandelt wird. Im echten MTP-Modus lehnt dasselbe Projekt `--report-trx` mit Exit-Code 5 ab (die Erweiterung ist nicht referenziert), was die ehrliche Antwort ist. Eine Pipeline, die "alle vorhandenen TRX-Dateien" veröffentlicht, veröffentlicht dann klaglos nichts.

Zum Vergleich: So sieht die Ausgabe im MTP-Modus aus. Wenn Sie `Running tests from` und `Test run summary` nicht sehen, sind Sie nicht im MTP-Modus:

```text
Running tests from /src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64)
/src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64) passed (426ms)
Test run summary: Passed!
```

## Warum dotnet test Ihre Runner-Wahl ignoriert

Die Runner-Auswahl wurde im .NET 10 SDK eingeführt und steckt an genau einer Stelle: im Abschnitt `test` der `global.json`. Im .NET 11 SDK (ab Preview 6) kann die Umgebungsvariable `DOTNET_TEST_RUNNER` sie überschreiben. Wählt keines von beiden MTP, bleibt `dotnet test` im VSTest-Modus, ruft das MSBuild-Target `VSTest` auf und überlässt es Ihrem MTP-Projekt, so zu reagieren, wie seine Version es eben tut. Nichts in der `.csproj` kann diese Entscheidung ändern, weil sie von der CLI getroffen wird, bevor MSBuild irgendein Projekt auswertet.

Die Ursachen, die ich reproduzieren konnte, in grober Reihenfolge ihrer Häufigkeit in echten Pipelines:

1. **Der Job läuft in einem Verzeichnis außerhalb des Repos**, sodass die Aufwärtssuche die `global.json` nie erreicht. Die Übergabe des Solution-Pfads hilft nicht; die Suche beginnt im Arbeitsverzeichnis, nicht beim Projekt.
2. **Die Datei heißt `Global.json`** (oder `GLOBAL.JSON`). Windows und die macOS-Standarddateisysteme unterscheiden nicht zwischen Groß- und Kleinschreibung, daher funktioniert es lokal. Linux tut das nicht.
3. **Die `global.json` liegt nicht dort, wo CI ausgeführt wird**: Sie liegt in `src/`, während der Job im Repo-Root läuft, oder ein Docker-Build-Kontext kopiert die Projekte, aber nicht die Datei.
4. **Ein Eigenschaftsname hat die falsche Schreibweise.** `"Test"` oder `"Runner"` wird stillschweigend ignoriert. Der Wert ist case-insensitiv, die Schlüssel sind es nicht.
5. **Das CI-Image enthält ein SDK älter als 10.0.** Das .NET 9 SDK kennt den Abschnitt `test` nicht.
6. **`DOTNET_TEST_RUNNER=VSTest` ist gesetzt**, auf Pipeline- oder Agent-Ebene, bei einem .NET 11 SDK. Es hat Vorrang vor der `global.json`.

## Minimales Repro

Zwei Testprojekte, eine Solution und eine `global.json` im Repository-Root:

```json
// global.json - .NET 10 SDK 10.0.302
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

```xml
<!-- tests/SdkTests/SdkTests.csproj - MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

Vom Repo-Root aus führt `dotnet test` beide Projekte im MTP-Modus aus. Reproduzieren Sie nun das CI-Verhalten:

```bash
# .NET 10 SDK 10.0.302
cd /tmp/elsewhere
dotnet test /src/repo/Repo.slnx        # VSTest mode: "Testing with VSTest target is no longer supported"

cd /src/repo
mv global.json Global.json
dotnet test                             # macOS/Windows: MTP mode. Linux: VSTest mode
```

Die zweite Hälfte habe ich auf einem Case-Sensitive-APFS-Disk-Image (`hdiutil create -fs "Case-sensitive APFS"`) ausgeführt, um Linux-Semantik ohne Container zu erhalten: `global.json` bestand, `Global.json` scheiterte mit dem VSTest-Fehler, und dieselbe `Global.json` auf dem normalen Volume ohne Unterscheidung von Groß- und Kleinschreibung bestand. Das ist die klassische Trennlinie bei "bei mir läuft es".

## Die Lösung im Detail

### 1. Nachweisen, in welchem Modus der Agent läuft

Fügen Sie vor dem Test-Schritt einen Diagnose-Schritt hinzu. Die ersten Zeilen von `dotnet test --help` verraten, welchen Befehl die CLI gewählt hat:

```bash
# .NET 10 SDK 10.0.302 - put this right before the test step
pwd
ls -la global.json || echo "no global.json in $(pwd)"
dotnet --version
dotnet test --help | sed -n 2p
```

Im MTP-Modus lautet die zweite Zeile `.NET Test Command for Microsoft.Testing.Platform (opted-in via 'global.json' file)`. Im VSTest-Modus lautet sie `.NET Test Command for VSTest. To use Microsoft.Testing.Platform, opt-in to the Microsoft.Testing.Platform-based command via global.json.` Eine kleine Eigenheit: Im .NET 11 RC 1 SDK sagt der MTP-Text weiterhin "via 'global.json' file", selbst wenn die Umgebungsvariable die Aktivierung vorgenommen hat.

### 2. Die Datei in git in Kleinbuchstaben umbenennen

Auf einem Dateisystem ohne Unterscheidung von Groß- und Kleinschreibung wird eine einfache Umbenennung in denselben Namen mit anderer Schreibweise nicht zuverlässig erkannt. Überlassen Sie das git:

```bash
# any git version
git mv Global.json global.json.tmp
git mv global.json.tmp global.json
git commit -m "Rename global.json to lowercase for Linux agents"
```

Dasselbe gilt für `Directory.Build.props` und Verwandte, doch diese werden von MSBuild aufgelöst, und eine falsche Schreibweise dort führt zu anderen Symptomen.

### 3. Den Test-Schritt innerhalb des Repositorys ausführen

Die Suche läuft vom Arbeitsverzeichnis aufwärts, der Job muss also nur irgendwo auf oder unterhalb der Ebene des Ordners liegen, der die `global.json` enthält. In GitHub Actions ist das Standard-Arbeitsverzeichnis der Checkout, der übliche Übeltäter ist also ein explizites `working-directory` oder ein `cd` in einen Artefakt-Ordner:

```yaml
# GitHub Actions, actions/setup-dotnet@v6, .NET 10 SDK
- uses: actions/setup-dotnet@v6
  with:
    global-json-file: global.json
- name: Test
  run: dotnet test --solution Repo.slnx
  # no working-directory pointing at a folder outside the repo
```

`global-json-file` hält das von `setup-dotnet` installierte SDK mit der Datei synchron, was auch Ursache 5 abdeckt. Es liest die SDK-Version aus `sdk.version`, kombinieren Sie es also mit der Festlegung aus Schritt 5. Ohne Festlegung gewinnt laut Dokumentation von `setup-dotnet` das neueste bereits auf dem Runner installierte SDK. Liegt Ihre `global.json` in `src/`, verschieben Sie sie entweder in den Root (empfohlen, da `dotnet build` und IDEs sie genauso auflösen) oder führen den Schritt mit `working-directory: src` aus.

Kopieren Sie bei Docker-Builds die `global.json` in dasselbe Verzeichnis, aus dem Sie `dotnet test` ausführen, und prüfen Sie `.dockerignore`:

```dockerfile
# mcr.microsoft.com/dotnet/sdk:10.0
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS test
WORKDIR /src
COPY global.json ./
COPY Repo.slnx ./
COPY tests/ tests/
RUN dotnet test --solution Repo.slnx
```

### 4. Den Abschnitt exakt schreiben

Alle diese Fälle wurden mit dem SDK 10.0.302 getestet:

| Inhalt der `global.json` | Ergebnis |
|---|---|
| `"test": { "runner": "Microsoft.Testing.Platform" }` | MTP |
| `"test": { "runner": "microsoft.testing.platform" }` | MTP (Wert ist case-insensitiv) |
| `"Test": { "runner": ... }` oder `"test": { "Runner": ... }` | VSTest, stillschweigend |
| `"sdk": { "version": "10.0.302", "test": { ... } }` (verschachtelt) | VSTest, stillschweigend |
| `"test": { "runner": "MTP" }` | CLI-Absturz: `Test runner 'MTP' is not supported.` |
| `// comments` in der Datei | MTP (Kommentare sind erlaubt) |
| ein abschließendes Komma | CLI-Absturz: `JsonException ... trailing comma` |

Die lauten Fehler sind leicht zu finden. Die beiden stillen sind der Grund, die exakte Schreibweise aus der Dokumentation beizubehalten und `test` auf oberster Ebene neben `sdk` zu platzieren, nicht darin.

### 5. Ein SDK verwenden, das die Runner-Auswahl versteht

Mit dem SDK 9.0.318 und exakt derselben `global.json` ignorierte `dotnet test` den Abschnitt `test` komplett und führte ein `xunit.v3`-3.2.2-Projekt über VSTest aus (`VSTest version 17.14.1`). Ein MSTest.Sdk-4.4.1-Projekt auf `net9.0` blieb ebenfalls grün, aber über die alte MSBuild-Brücke (`Run tests: '...' [net9.0|arm64]`), weil die Brücke im SDK 9 und früher weiterhin unterstützt wird. In beiden Fällen verlieren Sie das Verhalten des MTP-Modus ohne jede Warnung.

Das trifft Pipelines, die `mcr.microsoft.com/dotnet/sdk:9.0`-Images oder `setup-dotnet` mit `dotnet-version: 9.0.x` für ein Projekt verwenden, das `net8.0` oder `net9.0` als Ziel hat. Sie müssen die Projekte nicht umziehen; Sie brauchen nur das 10.0 SDK, um sie auszuführen. Legen Sie es in derselben Datei fest:

```json
// global.json - SDK pin plus runner selection, .NET 10 SDK
{
  "sdk": {
    "version": "10.0.302",
    "rollForward": "latestFeature"
  },
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

Mit festgelegter `sdk.version` scheitert ein Agent ohne passendes SDK beim Start mit der Fehlermeldung "compatible .NET SDK was not found", statt stillschweigend ein älteres zu verwenden.

### 6. Auf .NET-11-Agents nach DOTNET_TEST_RUNNER suchen

Mit dem .NET 11 RC 1 SDK habe ich die dokumentierte Rangfolge bestätigt: `DOTNET_TEST_RUNNER=VSTest` überschreibt eine korrekte `global.json` und erzeugt denselben Fehler "Testing with VSTest target is no longer supported", während ein leerer oder unbekannter Wert (`DOTNET_TEST_RUNNER=MTP`) ignoriert wird und `global.json` gewinnt. Die Variable funktioniert auch in die andere Richtung, was sie zu einer praktischen vorübergehenden Lösung macht, wenn Sie das Repo nicht ändern können:

```bash
# .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) and later; ignored by the .NET 10 SDK
export DOTNET_TEST_RUNNER=Microsoft.Testing.Platform
dotnet test --solution Repo.slnx
```

Im SDK 10.0.302 hat die Variable in keiner der beiden Richtungen eine Wirkung, verlassen Sie sich also nicht darauf, bis der Agent auf .NET 11 läuft.

### 7. Einen Fallback den Build fehlschlagen lassen

Zwei einfache Absicherungen machen aus der stillen Variante einen roten Build:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
dotnet test --solution Repo.slnx --minimum-expected-tests 1
```

`--solution` (oder `--project`) existiert nur im MTP-Modus, im VSTest-Modus bricht der Befehl daher mit `MSB1001: Unknown switch` ab, statt Tests auf die falsche Weise auszuführen. `--minimum-expected-tests` ist eine MTP-Option, die den Lauf mit Exit-Code 9 fehlschlagen lässt, wenn weniger Tests als erwartet ausgeführt wurden. Übergeben Sie in CI niemals MTP-Optionen nach `--`: Genau diese Syntax schluckt der VSTest-Modus ohne Beschwerde.

Wenn Sie noch mitten in der Migration stecken, entfernen Sie außerdem `TestingPlatformDotnetTestSupport` aus Ihren Projekten, sobald die Umstellung über die `global.json` steht. Es spielt nur im VSTest-Modus eine Rolle, und wenn es stehen bleibt, kann ein MTP-v1-Projekt über die Brücke weiter "funktionieren", wenn die Runner-Auswahl verloren geht.

## Stolperfallen und ähnliche Fälle

- **Die `.csproj` kann sich nicht selbst aktivieren.** `TestingPlatformDotnetTestSupport`, `EnableMSTestRunner` und `UseMicrosoftTestingPlatformRunner` bestimmen, wie sich ein Projekt in jedem Modus verhält. Sie wählen nicht den Modus.
- **Eine gemischte Solution ist ein anderer Fehler.** Sobald der MTP-Modus aktiv ist, lässt ein Projekt, das nur VSTest unterstützt, den Lauf fehlschlagen. Das ist das umgekehrte Problem, behandelt im [Migrationsleitfaden von VSTest zu Microsoft.Testing.Platform](/de/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/).
- **`Zero tests ran` mit Exit-Code 5 bedeutet, dass Sie im MTP-Modus sind.** Eine Option wurde von der Test-App abgelehnt, siehe [dotnet test Exit-Code 5 bei Microsoft.Testing.Platform](/de/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/).
- **Die Azure-DevOps-Tasks `VSTest@2` und `VSTest@3` verwenden immer vstest.console.** Keine Änderung an der `global.json` ändert das. Verwenden Sie stattdessen einen Skript-Schritt, der `dotnet test` aus dem Repository-Root aufruft.
- **IDEs treffen ihre eigene Wahl.** Wenn der Test Explorer das Projekt anders liest als die CLI, ist das eine eigene Fehlerklasse, zum Beispiel [Test Explorer hängt bei xUnit v3, während dotnet test erfolgreich ist](/de/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).

## Verwandte Artikel

- Die vollständige [Migration von VSTest zu Microsoft.Testing.Platform in .NET 11](/de/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/), einschließlich `--logger` zu `--report-trx` und `.runsettings` zu `testconfig.json`.
- Wenn der MTP-Modus aktiv ist, ein Projekt aber seine Argumente ablehnt: [dotnet test Exit-Code 5 und "Zero tests ran" beheben](/de/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/).
- MTP-Fehler als Annotationen im Pull-Request-Diff erhalten, sobald CI im richtigen Modus läuft: [Microsoft.Testing.Platform 2.3 GitHub-Actions-Annotationen](/de/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/).
- Ein `xunit.v3`-3.x-Projekt von MTP v1 und dem VSTest-Adapter lösen: [Ein Testprojekt von xUnit v2 auf xUnit v3 migrieren](/de/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).

## Quellen

- [dotnet test command: Auswahl eines Test-Runners](https://learn.microsoft.com/dotnet/core/tools/dotnet-test#choose-a-test-runner)
- [Testing with dotnet test: VSTest-Modus und MTP-Modus](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test)
- [global.json-Übersicht, einschließlich der Suche nach der Datei](https://learn.microsoft.com/dotnet/core/tools/global-json)
- [dotnet test mit Microsoft.Testing.Platform](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [actions/setup-dotnet: Eingabe global-json-file](https://github.com/actions/setup-dotnet)
- [microsoft/testfx-Repository (MSTest und Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)
