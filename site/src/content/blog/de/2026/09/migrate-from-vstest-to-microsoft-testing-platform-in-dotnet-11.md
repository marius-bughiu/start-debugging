---
title: "Von VSTest zu Microsoft.Testing.Platform im .NET 11 SDK migrieren"
description: "Eine Schritt-für-Schritt-Migration von VSTest zu Microsoft.Testing.Platform 2.3.3: das Opt-in per OutputType Exe, der Runner-Wechsel in global.json, aus Loggern werden Reporter, aus .runsettings wird testconfig.json, und die Exit-Codes, die einen grünen CI-Job rot färben."
pubDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "vstest"
  - "microsoft-testing-platform"
  - "testing"
  - "dotnet-11"
  - "dotnet"
  - "ci-cd"
lang: "de"
translationOf: "2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-02
---

Eine Solution von VSTest auf Microsoft.Testing.Platform (MTP) umzustellen kostet einen halben Tag für die Projektdateien und einen ganzen Tag für die CI. Auf Projektseite sind es drei Zeilen pro Testprojekt: `<OutputType>Exe</OutputType>`, eine Opt-in-Eigenschaft für Ihr Test-Framework und eine `global.json`, die `"runner": "Microsoft.Testing.Platform"` setzt. Zeit kostet alles, was danach kommt: Jedes `--logger`, `--collect` und `--blame` in Ihrer Pipeline entspricht einer anderen Option, die nur existiert, wenn Sie zusätzlich ein NuGet-Paket hinzufügen, Ihre `.runsettings`-Datei verliert den größten Teil ihrer Bedeutung, und ein Testprojekt, das null Tests ausführt, lässt den Build jetzt mit Exit-Code 8 scheitern statt durchzulaufen. Dieser Leitfaden ist gegen das .NET 11 SDK (Preview 7, August 2026), Microsoft.Testing.Platform 2.3.3, MSTest 4.3.3, NUnit3TestAdapter 6.3.0 und xunit.v3 4.0.0 geschrieben.

## Warum sich der Wechsel jetzt lohnt

- **Die Richtung steht fest.** MSTest hat seit 3.2.0 einen eigenen MTP-Runner, NUnit seit NUnit3TestAdapter 5.0.0, und xUnit v3 wurde von Anfang an auf MTP gebaut. VSTest befindet sich im Wartungsmodus: Die sichtbarste Änderung in diesem Jahr war [der Wegfall der Newtonsoft.Json-Abhängigkeit](/de/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/).
- **Testmodule laufen standardmäßig parallel.** VSTest serialisiert Assemblies, sofern man nicht dagegen ankämpft. MTP führt bis zu `Environment.ProcessorCount` Testmodule gleichzeitig aus, begrenzt durch `--max-parallel-test-modules`.
- **Kein externer Runner.** Das Testprojekt ist eine ausführbare Datei. `./MyApp.Tests` startet die Suite ohne `vstest.console.exe`, ohne `dotnet test` und ohne einen Adapter-Discovery-Durchlauf. Das zählt für Container-Images und für das lokale Reproduzieren eines CI-Fehlers.
- **Richtlinien auf Lauf-Ebene, die man früher skripten musste.** `--timeout`, `--maximum-failed-tests`, `--minimum-expected-tests` und `--ignore-exit-code` sind erstklassige Optionen, und die letzten drei existieren genau deshalb, weil die CI sie braucht.

## Was bricht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| Projektform | Testprojekte müssen `<OutputType>Exe</OutputType>` setzen | hoch |
| Konsistenz der Solution | Mit MTP in `global.json` müssen **alle** Testprojekte MTP verwenden. Eine gemischte Solution ist ein Fehler, keine Warnung | hoch |
| `--logger` | Umbenannt in "Reporter". `--logger trx` wird zu `--report-trx` und erfordert `Microsoft.Testing.Extensions.TrxReport` | hoch |
| `--collect "Code Coverage"` | Wird zu `--coverage`, erfordert `Microsoft.Testing.Extensions.CodeCoverage`, und `IncludeTestAssembly` steht jetzt standardmäßig auf `false` | hoch |
| `--blame-crash` / `--blame-hang` | Werden zu `--crashdump` / `--hangdump` aus separaten Paketen. `--blame-crash-collect-always` hat keine Entsprechung | mittel |
| Null Tests ausgeführt | VSTest liefert 0. MTP liefert Exit-Code 8 | hoch |
| `.runsettings` | Nur über die VSTest-Bridges von MSTest und NUnit unterstützt. Die Plattform selbst liest `testconfig.json` | mittel |
| `dotnet test MyTests.csproj` | Positionelle Projektpfade entfallen. Verwenden Sie `--project`, `--solution` oder `--test-modules` | mittel |
| xUnit-Filter | `--filter` ist nicht implementiert. Verwenden Sie `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, `--filter-query` | hoch (nur xUnit) |
| `RunConfiguration.TargetPlatform=x86` | Wird zu `--arch x86` | niedrig |
| Konsolen-Encoding | MTP setzt immer UTF-8. Der Standard-Isolationsmodus von VSTest tat das nicht | niedrig |

Die beiden Zeilen, die Ihren Zeitplan bestimmen, sind die zur Solution-Konsistenz und die zu `--logger`. Über den Rest informiert Sie das Werkzeug.

## Checkliste vor dem Start

- **.NET 10 SDK oder neuer.** Die Runner-Auswahl kam mit dem .NET 10 SDK. Unter .NET 9 und älter bleiben Sie an die Bridge `TestingPlatformDotnetTestSupport` und an einen zwingenden `--`-Trenner gebunden.
- **MTP 1.7 oder neuer** in jedem Testprojekt. Die MTP-Integration von `dotnet test` wird erst ab 1.7 unterstützt; 2.3.3 ist die aktuelle stabile Version.
- **Inventarisieren Sie zuerst die Pipeline.** Durchsuchen Sie Ihre CI mit grep nach `dotnet test`, `vstest.console`, `--logger`, `--collect`, `--blame`, `--settings` und `--filter`. Dieses grep ist Ihre eigentliche Arbeitsliste.
- **Finden Sie jede `.runsettings`.** `find . -name "*.runsettings"` und dann jede Datei lesen. Alles unter `DataCollectionRunSettings` wird zu einer CLI-Option oder verschwindet.
- **Kennen Sie Ihre Frameworks.** Eine Solution mit MSTest- und xUnit-Projekten braucht projektweises Argument-Routing (siehe Schritt 6). Finden Sie das jetzt heraus, nicht wenn die CI mit Exit-Code 5 scheitert.
- **Migrieren Sie zuerst ein Projekt vollständig**, inklusive eines echten CI-Laufs, bevor Sie den Rest anfassen.

## Migrationsschritte

1. **SDK festnageln und den Runner in `global.json` auswählen.**

   Die Runner-Auswahl ist eine Entscheidung auf Repository-Ebene, nicht pro Projekt.

   ```json
   // global.json - .NET 11 SDK
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     },
     "test": {
       "runner": "Microsoft.Testing.Platform"
     }
   }
   ```

   `VSTest` ist der andere gültige Wert und bleibt der Standard, wenn der Abschnitt `test` fehlt. Im .NET 11 SDK können Sie das zusätzlich pro Shell über die Umgebungsvariable `DOTNET_TEST_RUNNER` überschreiben, was der schnellste Weg ist, zwei Varianten eines CI-Jobs zu vergleichen, ohne eine versionierte Datei zu ändern.

   Prüfen: `dotnet test --help` listet jetzt `--project`, `--solution` und `--test-modules`. Stehen dort weiterhin `--logger` und `--collect`, hat der Runner-Wechsel nicht gegriffen.

2. **Jedes Testprojekt zu einer ausführbaren Datei machen.**

   Das ist das universelle Opt-in, unabhängig vom Framework. Legen Sie es in eine `Directory.Build.props` neben Ihren Testprojekten ab, statt es zu wiederholen.

   ```xml
   <!-- tests/Directory.Build.props - .NET 11 SDK, MTP 2.3.3 -->
   <Project>
     <PropertyGroup>
       <OutputType>Exe</OutputType>
     </PropertyGroup>
   </Project>
   ```

   Sie schreiben keine `Main`. `Microsoft.Testing.Platform.MSBuild`, das jedes MTP-fähige Framework transitiv mitbringt, erzeugt einen `TestingPlatformEntryPoint` für Sie.

   Prüfen: `dotnet build` erzeugt eine ausführbare Datei `MyApp.Tests` (oder `.exe`) im Ausgabeordner, und ihr direkter Aufruf führt die Suite aus.

3. **Den Runner für Ihr Test-Framework aktivieren.**

   Jedes Framework hat eine eigene Eigenschaft, und die Mindestversionen unterscheiden sich.

   ```xml
   <!-- tests/Directory.Build.props - pick the one that matches your framework -->
   <PropertyGroup>
     <!-- MSTest 3.2.0+, current 4.3.3 -->
     <EnableMSTestRunner>true</EnableMSTestRunner>

     <!-- NUnit3TestAdapter 5.0.0+, current 6.3.0 -->
     <EnableNUnitRunner>true</EnableNUnitRunner>

     <!-- xunit.v3 1.0.1+, current 4.0.0 -->
     <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
   </PropertyGroup>
   ```

   MSTest-Projekte können die Eigenschaft ganz überspringen, indem sie das Projekt-SDK auf `MSTest.Sdk` umstellen, wo MTP standardmäßig aktiv ist. xunit.v3 4.0.0 löst auf die MTP-v2-Paketvariante auf; die 3.x-Linie nutzte standardmäßig MTP v1, was 4.0.0 entfernt hat. Wenn Sie noch auf xUnit v2 sind, gibt es keinen offiziellen MTP-Weg, also erledigen Sie zuerst die [Migration von v2 auf v3](/de/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).

   Prüfen: Rufen Sie die Test-Executable mit `--help` auf. Sie sollten die Plattform-Optionen (`--filter-uid`, `--timeout`, `--list-tests`) sehen, dazu alles, was Ihr Framework registriert.

4. **Die Bridge-Eigenschaften aus der .NET-9-Ära entfernen.**

   Viele Blogbeiträge und selbst Teile der MSTest-Seite auf MS Learn zeigen diese noch. Im .NET 10 oder .NET 11 SDK mit Runner-Auswahl über `global.json` sind sie überholt und sollten entfernt werden:

   ```xml
   <!-- delete these from every test project and Directory.Build.props -->
   <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   <TestingPlatformShowTestsFailure>true</TestingPlatformShowTestsFailure>
   ```

   Der von ihnen geforderte `--`-Trenner wird ebenfalls optional, lohnt sich in der CI aber weiterhin, aus einem Grund, den Schritt 6 behandelt.

   Prüfen: `dotnet test` läuft weiterhin, und die Konsolenausgabe zeigt den Terminal-Reporter von MTP statt den von VSTest.

5. **Logger und Collectors als Erweiterungspakete wieder hinzufügen.**

   Der MTP-Kern liefert keines davon mit. Übergibt Ihre Pipeline eine Option, deren Paket fehlt, scheitert der Lauf mit **Exit-Code 5**, weil die Option unbekannt ist.

   ```xml
   <!-- tests/Directory.Build.props - MTP 2.3.3 extensions -->
   <ItemGroup>
     <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CodeCoverage" Version="18.10.0" />
     <PackageReference Include="Microsoft.Testing.Extensions.HangDump" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CrashDump" Version="2.3.3" />
   </ItemGroup>
   ```

   Die Code-Coverage-Erweiterung wird unabhängig von der Plattform versioniert: Sie folgt der Nummerierung der Visual Studio Test Platform, weshalb die aktuelle Version 18.10.0 lautet, während der Rest bei 2.3.3 steht. Die dokumentierte Kompatibilitätstabelle ordnet die 18.1.x-Linie MTP 2.0.x zu, 18.0.x der 1.8.x und 17.14.x der 1.6.2, und die Empfehlung lautet, beide auf dem jeweils neuesten Stand zu halten. Wenn Sie Central Package Management einsetzen, gehören diese in die `Directory.Packages.props`, was ein weiteres Argument dafür ist, [die Solution vorher auf Directory.Packages.props umzustellen](/de/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).

   Prüfen: `dotnet test --help` listet `--report-trx`, `--coverage`, `--hangdump` und `--crashdump`.

6. **Die CI-Kommandozeile übersetzen.**

   Hier steckt der Großteil der Arbeit. Die Zuordnung:

   ```bash
   # before - VSTest, .NET 9 SDK
   dotnet test MyApp.sln \
     --logger "trx;LogFileName=results.trx" \
     --collect "Code Coverage" \
     --blame-hang-timeout 5m \
     --results-directory ./artifacts/tests \
     --filter "TestCategory=Integration"
   ```

   ```bash
   # after - MTP 2.3.3, .NET 11 SDK
   dotnet test --solution MyApp.sln \
     --results-directory ./artifacts/tests \
     -- --report-trx --report-trx-filename results.trx \
        --coverage --coverage-output-format cobertura \
        --hangdump --hangdump-timeout 5m \
        --filter "TestCategory=Integration"
   ```

   Drei Dinge fallen auf. Aus dem positionellen `MyApp.sln` wurde `--solution`, weil `dotnet test` im MTP-Modus keinen nackten Pfad mehr akzeptiert. Der `--`-Trenner ist ab dem .NET 10 SDK technisch optional, aber `dotnet test` reicht unbekannte Tokens an die Testanwendung weiter, und eine erkannte SDK-Option zwischen dem Namen einer unbekannten Option und deren Wert ändert, wie die übrigen Tokens gebunden werden. Stellen Sie die Argumente der Testanwendung hinter `--`, und die Mehrdeutigkeit verschwindet. Schließlich versteht sowohl das SDK als auch die Plattform `--results-directory`, es kann also auf beiden Seiten stehen.

   Für eine Solution, die Frameworks oder Erweiterungssätze mischt, leiten Sie die Argumente pro Projekt statt global weiter:

   ```xml
   <!-- only the projects that reference HangDump get the option -->
   <PropertyGroup Condition="'$(MSBuildProjectName)' == 'MyApp.Integration.Tests'">
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --hangdump --hangdump-timeout 5m
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   Prüfen: Der Lauf erzeugt `results.trx` und eine Cobertura-Datei unter `./artifacts/tests`, und der Exit-Code ist 0.

7. **`.runsettings` durch `testconfig.json` ersetzen.**

   MSTest und NUnit respektieren `--settings config.runsettings` weiterhin über ihre VSTest-Bridges, Sie können das also verschieben. xUnit v3 tut das nicht, und die Plattform selbst liest niemals runsettings. Der Ersatz:

   ```json
   // testconfig.json at the repo root - MTP 2.3.3
   {
     "platformOptions": {
       "resultDirectory": "./artifacts/tests",
       "exitProcessOnUnhandledException": false
     },
     "environmentVariables": {
       "DOTNET_ENVIRONMENT": "Testing"
     },
     "mstest": {
       "parallelism": { "enabled": true, "workers": 4, "scope": "method" },
       "timeout": { "test": 30000 }
     }
   }
   ```

   Die Zuordnung ist nicht eins zu eins. `RunConfiguration/ResultsDirectory` wird zu `platformOptions.resultDirectory`. `RunConfiguration/MaxCpuCount` hat keine Entsprechung, weil Parallelität auf Prozessebene jetzt `--max-parallel-test-modules` heißt. `LoggerRunSettings/Loggers` und alles unter `DataCollectionRunSettings` werden zu den CLI-Optionen aus Schritt 5. `TestRunParameters` wird zu `--test-parameter key=value`. Ab MTP 2.3.0 können Sie CLI-Optionen selbst in `testconfig.json` legen, Erweiterungsoptionen eingeschlossen, womit Sie `--coverage-output-format cobertura` aus jeder Pipeline-Datei heraushalten; der Abschnitt `environmentVariables` gibt es ebenfalls erst ab 2.3.0.

   Verweisen Sie alle Projekte über `Directory.Build.props` auf eine gemeinsame Datei:

   ```xml
   <PropertyGroup>
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --config-file $(MSBuildThisFileDirectory)testconfig.json
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   Prüfen: Entfernen Sie den `.runsettings`-Verweis aus der CI und bestätigen Sie, dass die Ergebnisse weiterhin im konfigurierten Verzeichnis landen.

8. **Den CI-Task selbst austauschen.**

   Ersetzen Sie in Azure DevOps den Task `VSTest@2` durch `DotNetCoreCLI@2`. Das ist ein `dotnet test`-Aufruf wie jeder andere, die Regeln aus Schritt 6 gelten also wörtlich:

   ```yml
   # azure-pipelines.yml - .NET 11 SDK, MTP 2.3.3
   - task: DotNetCoreCLI@2
     inputs:
       command: 'test'
       arguments: '--solution MyApp.sln -- --report-trx --results-directory $(Agent.TempDirectory)'
   ```

   In GitHub Actions setzt `Microsoft.Testing.Extensions.GitHubActionsReport` zusammen mit `--report-gh` die Fehler direkt in das Diff des Pull Requests, was [die Reporting-Geschichte ist, die in MTP 2.3 stabil wurde](/de/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/). Achten Sie auf die Verwechslungsgefahr: Das Drittanbieter-Paket `GitHubActionsTestLogger` verwendet `--report-github`, ein Zeichen entfernt von der offiziellen Option.

   Prüfen: Ein absichtlich fehlschlagender Test erzeugt einen roten Job, dessen Fehler in der Lauf-Zusammenfassung sichtbar ist, nicht nur im rohen Log.

## Die Migration prüfen

Arbeiten Sie diese Liste an einem Projekt ab, bevor Sie die Änderung auf die ganze Solution ausrollen:

- `dotnet build` erzeugt pro Testprojekt eine ausführbare Datei, und deren direkter Aufruf (`./MyApp.Tests`) meldet dieselbe Testanzahl wie `dotnet test`.
- `dotnet test --help` listet jede Option, die Ihre Pipeline übergibt. Fehlt eine, fehlt ihr Paket.
- Die Testanzahl stimmt mit der VSTest-Zahl vor der Migration überein. Ein Rückgang bedeutet meist, dass ein Filterausdruck nicht mehr greift, nicht dass Tests verschwunden sind.
- Die TRX-Datei und der Coverage-Bericht existieren an den Pfaden, die Ihre nachgelagerten Schritte lesen.
- Der Test-Explorer in Visual Studio erkennt und startet Tests weiterhin. MTP-Unterstützung erfordert Visual Studio 17.14 oder neuer; VS Code benötigt das C# Dev Kit.
- `echo $?` liefert nach einem erfolgreichen Lauf 0 und nach einem absichtlich fehlschlagenden Lauf 2.

## Rollback

Diese Migration lässt sich mit einem einzigen Commit zurücknehmen, solange `Microsoft.NET.Test.Sdk` und das VSTest-Adapter-Paket Ihres Frameworks referenziert bleiben. Löschen Sie den Abschnitt `test` aus `global.json`, und der Runner fällt auf VSTest zurück; `OutputType=Exe` und die Opt-in-Eigenschaften sind unter VSTest wirkungslos. Genau deshalb sollten Sie `xunit.runner.visualstudio` und `Microsoft.NET.Test.Sdk` nicht im selben Pull Request entfernen. Räumen Sie eine Woche später auf, wenn die CI und die IDE jedes Teammitglieds auf MTP gelaufen sind.

## Fallstricke, die Sie vorher kennen sollten

**Exit-Code 8 färbt einen grünen Job rot.** Ein Projekt, das null Tests ausführt, endet unter MTP mit 8 und unter VSTest mit 0. Das trifft Solutions mit einem Platzhalter-Testprojekt oder einem Filter, der auf nichts passt. Entweder Sie korrigieren den Filter, oder Sie steigen ausdrücklich aus:

```xml
<PropertyGroup>
  <TestingPlatformCommandLineArguments>
    $(TestingPlatformCommandLineArguments) --ignore-exit-code 8
  </TestingPlatformCommandLineArguments>
</PropertyGroup>
```

`--ignore-exit-code` nimmt eine durch Semikolon getrennte Liste (`--ignore-exit-code 2;8`), und `TESTINGPLATFORM_EXITCODE_IGNORE` tut dasselbe über die Umgebung. Davon getrennt hat MTP 2.3.0 den Fall "alles übersprungen" geändert: Ein Lauf, in dem jeder Test übersprungen wurde, gilt jetzt standardmäßig als erfolgreich, und `--zero-tests-policy strict` stellt das Verhalten vor 2.3.0 wieder her.

**Eine gemischte Solution ist ein Fehler, keine Warnung.** Sobald `global.json` MTP auswählt, erwartet `dotnet test`, dass jedes Testprojekt im Graphen ein MTP-Projekt ist. Ein einzelner Nachzügler auf VSTest bringt den gesamten Lauf zu Fall. Migrieren Sie zuerst die Blattprojekte und stellen Sie `global.json` zuletzt um.

**Exit-Code 5 bedeutet ein fehlendes Paket, keinen Tippfehler.** Referenziert die Hälfte Ihrer Projekte `Microsoft.Testing.Extensions.HangDump` und die andere Hälfte nicht, ist `--hangdump` für die einen gültig und für die anderen unbekannt, und der Lauf stirbt mit 5. Verwenden Sie die projektbezogenen `TestingPlatformCommandLineArguments`-Bedingungen aus Schritt 6.

**xUnit ignoriert `--filter`.** MSTest und NUnit behalten unter MTP die VSTest-Ausdruckssyntax (`FullyQualifiedName~UnitTest1|TestCategory=CategoryA`) bei. xUnit v3 implementiert sie überhaupt nicht: Sie brauchen `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait` oder `--filter-query` sowie deren negierte Varianten. Ein CI-Filter, der still auf nichts passt, löst anschließend Exit-Code 8 aus, und so zeigt sich das in der Praxis. Dieselbe Klasse stiller Filterprobleme ist auch dann relevant, wenn Sie [xUnit v3 gegen NUnit und MSTest](/de/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) abwägen.

**Die Coverage-Zahlen verschieben sich.** `IncludeTestAssembly` steht in `Microsoft.Testing.Extensions.CodeCoverage` standardmäßig auf `false` und stand in VSTest auf `true`. Ihre Gesamtabdeckung ändert sich im Migrations-Commit aus Gründen, die nichts mit Ihrem Code zu tun haben. Informieren Sie vor dem Push, wer das Coverage-Gate überwacht.

**Der generierte Einstiegspunkt erzeugt zwei sonderbare Compiler-Fehler.** `Microsoft.Testing.Platform.MSBuild` legt `TestingPlatformEntryPoint` und `SelfRegisteredExtensions` in `$(RootNamespace)` ab, was standardmäßig dem Projektnamen entspricht. Ein Projekt namens `Contoso.Serialization.Tests`, das zusätzlich ein Paket `Contoso.Serialization` referenziert, kann `CS0118: 'Serialization' is a namespace but is used like a type` erzeugen; setzen Sie `<RootNamespace>Contoso.SerializationTests</RootNamespace>` oder leeren Sie es mit `<RootNamespace />`. Getrennt davon läuft ein Nicht-Testprojekt, das ein Testprojekt referenziert, in `CS8892`, weil der generierte Einstiegspunkt mit dessen `Main` kollidiert; setzen Sie `<IsTestingPlatformApplication>false</IsTestingPlatformApplication>` im referenzierenden Projekt oder `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>` im Testprojekt.

**Für Test-Explorer-Merkwürdigkeiten gibt es einen eigenen Schalter.** Verhält sich die Discovery in einer IDE seltsam, schaltet `<DisableTestingPlatformServerCapability>true</DisableTestingPlatformServerCapability>` den Servermodus von MTP ab, sodass die IDE auf den VSTest-Adapter zurückfällt. Das ist ein Workaround, keine Lösung, und ein anderes Problem als [ein hängender Test-Explorer, während `dotnet test` durchläuft](/de/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).

Das .NET 11 SDK macht den Zeitpunkt günstig: `--timeout` und `--maximum-failed-tests` auf Lauf-Ebene, `--no-dependencies`, `--use-current-runtime`, Ausschlussmuster mit `!`-Präfix für `--test-modules`, Unterstützung für `Microsoft.Build.Traversal` und eine Live-Anzeige laufender Tests in interaktiven Terminals. Nichts davon gibt es auf dem VSTest-Pfad.

## Verwandt

- [Ein Testprojekt von xUnit v2 auf xUnit v3 migrieren](/de/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/)
- [Microsoft.Testing.Platform 2.3 und GitHub-Actions-Annotationen](/de/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [xUnit v3 vs NUnit vs MSTest im Jahr 2026](/de/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [VSTest entfernt Newtonsoft.Json in .NET 11 Preview 4](/de/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/)
- [Eine .NET-Solution auf Central Package Management umstellen](/de/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## Quellen

- [Migrationsleitfaden von VSTest zu Microsoft.Testing.Platform (MTP)](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform) auf MS Learn
- [Der Befehl dotnet test mit Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test-mtp), die CLI-Referenz für den MTP-Modus
- [CLI-Optionsreferenz für Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-cli-options), inklusive der Tabelle mit Erweiterungsoptionen nach Szenario
- [Fehlerbehebung für Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-troubleshooting) mit der vollständigen Exit-Code-Tabelle
- [Konfigurationsoptionen von Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-config) zu `testconfig.json` und der runsettings-Zuordnung
- [Code Coverage in Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-code-coverage) zu den Erweiterungsoptionen und der Versionskompatibilitätstabelle
- [Enhance your CLI testing workflow with the new dotnet test](https://devblogs.microsoft.com/dotnet/dotnet-test-with-mtp/) im .NET-Blog
- [Neuerungen im SDK und Tooling für .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk) zu den Testverbesserungen in Preview 7
- [Unterstützung der Microsoft Testing Platform in xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)
