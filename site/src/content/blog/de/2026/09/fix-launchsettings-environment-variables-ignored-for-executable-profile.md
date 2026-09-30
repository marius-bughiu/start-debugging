---
title: "Fix: Umgebungsvariablen aus launchSettings.json werden für ein Profil mit commandName: Executable ignoriert"
description: "Wenn Ihr Executable-Profil dotnet run oder dotnet watch startet, wendet der innere Befehl das Standardprofil an und überschreibt Ihre Variablen. Fügen Sie --no-launch-profile hinzu und verwenden Sie SDK 10.0.200+."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dotnet-cli"
  - "launchsettings"
  - "dotnet-watch"
  - "dotnet-10"
  - "dotnet-11"
lang: "de"
translationOf: "2026/09/fix-launchsettings-environment-variables-ignored-for-executable-profile"
translatedBy: "claude"
translationDate: 2026-09-30
---

Wenn Ihr Profil mit `commandName: "Executable"` `dotnet run` oder `dotnet watch run` startet, fügen Sie `--no-launch-profile` (oder `--launch-profile <name>`) zu dessen `commandLineArgs` hinzu. Andernfalls wählt der innere Befehl das Standardprofil des Projekts, und dessen `environmentVariables` überschreiben die Werte, die Ihr Executable-Profil gerade gesetzt hat. Gibt die CLI "The launch profile type 'Executable' is not supported" aus, verwenden Sie ein SDK älter als 10.0.200. Aktualisieren Sie es, denn diese SDKs überspringen das gesamte Profil. Alles Folgende habe ich unter macOS mit den SDKs 10.0.112, 10.0.302, 10.0.401 und 11.0.100-rc.1 gemessen.

## Der Fehler im Kontext

Das Problem tritt in zwei Varianten auf, und welche Sie treffen, hängt von Ihrem SDK ab.

Bei einem 10.0.1xx-SDK (und früheren SDKs, die nur Project-Profile kannten) meldet `dotnet run --launch-profile` das Problem direkt und führt das Projekt trotzdem aus:

```
Using launch settings from /src/app/Properties/launchSettings.json...
The launch profile "Exe" could not be applied.
The launch profile type 'Executable' is not supported.
MY_MODE=<null> DOTNET_ENVIRONMENT=<null> DOTNET_LAUNCH_PROFILE=<null> args=[] cwd=/src/app
```

Diese Meldung übersieht man leicht, weil die App startet. Sie startet nur ganz ohne Profil: keine Umgebungsvariablen, keine `commandLineArgs`, nicht einmal `DOTNET_LAUNCH_PROFILE`.

Ab 10.0.200 gibt es keine Warnung. Das Profil läuft, aber die App sieht die falschen Werte. Das ist der in [dotnet/sdk#56023](https://github.com/dotnet/sdk/issues/56023) gemeldete Fall: Ein Profil "Watch" setzt `ASPNETCORE_ENVIRONMENT=Development`, und die App meldet trotzdem `Production`. Der einzige Hinweis ist, dass die Zeile "Using launch settings" zweimal ausgegeben wird:

```
Using launch settings from /src/app/Properties/launchSettings.json...
Using launch settings from /src/app/Properties/launchSettings.json...
MY_MODE=from-Default DOTNET_ENVIRONMENT=Production DOTNET_LAUNCH_PROFILE=Default args=[] cwd=/src/app
```

## Warum die Variablen verloren gehen

Die Ursachen, die häufigste zuerst:

1. **Ein verschachtelter SDK-Befehl wendet erneut ein Profil an.** `dotnet run` wendet ein Executable-Profil korrekt an. Es startet `executablePath` mit den gesetzten `environmentVariables` des Profils. Ist diese ausführbare Datei aber `dotnet` selbst (`run`, `watch run`), ist der Kindprozess ein brandneues `dotnet run` ohne `--launch-profile`. Es liest dieselbe `launchSettings.json`, wählt das *erste* Profil mit unterstütztem `commandName` und setzt dessen Variablen auf dem App-Prozess. Profilvariablen haben Vorrang vor geerbten (siehe `SetEnvironmentVariables` in [`RunCommand.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Cli/dotnet/Commands/Run/RunCommand.cs)), sodass Ihre äußeren Werte stillschweigend ersetzt werden.
2. **Das SDK ist älter als 10.0.200.** Die Executable-Unterstützung in `dotnet run` und `dotnet watch` kam mit [dotnet/sdk#51727](https://github.com/dotnet/sdk/pull/51727), gemergt am 12. Dezember 2025 in `release/10.0.2xx`. Davor kannte die CLI nur `commandName: "Project"`. Visual Studio unterstützte Executable-Profile schon immer, weshalb dieselbe Datei "in VS funktioniert".
3. **Die IDE liest Executable-Profile nie.** Die C#-Erweiterung für VS Code dokumentiert in ihren [Debugger-Einstellungen](https://code.visualstudio.com/docs/csharp/debugger-settings): "Only profiles with `"commandName": "Project"` are supported". Die Auswahl eines Executable-Profils dort bewirkt für dessen Variablen nichts.

## Wie dotnet run ein Profil wählt und Variablen schichtet

Es hilft, die genaue Reihenfolge der CLI zu kennen, denn jeder Workaround unten steuert lediglich einen dieser Schritte. Ab SDK 10.0.200 geht `dotnet run` so vor:

1. Übergeben Sie `--no-launch-profile`, verwendet es überhaupt kein Profil. Hier endet der Ablauf.
2. Andernfalls sucht es `Properties/launchSettings.json` (`My Project/launchSettings.json` bei VB oder `<app>.run.json` neben einer dateibasierten App).
3. Mit `--launch-profile <name>` wählt es dieses Profil. Die Suche unterscheidet zuerst Groß- und Kleinschreibung und fällt dann auf einen Treffer ohne Unterscheidung zurück. Ohne das Flag wählt es das erste Profil, dessen `commandName` `Project` oder `Executable` ist. Jeder andere Befehlsname (`IISExpress`, `Docker`, `DotNetCore`) wird übersprungen.
4. Es baut die Umgebung des Kindprozesses in drei Schichten auf. Zuerst die geerbte Umgebung des `dotnet`-Prozesses. Dann `DOTNET_LAUNCH_PROFILE`, dazu `ASPNETCORE_URLS` aus `applicationUrl` bei Project-Profilen und jeder Eintrag in `environmentVariables`. Zuletzt jedes `-e KEY=VALUE` von der Befehlszeile. Spätere Schichten gewinnen.

Schritt 4 ist der Grund, warum der verschachtelte Fall scheitert. Das äußere `dotnet run` legt Ihre Werte in Schicht eins des inneren `dotnet run`, und Schicht zwei des inneren Befehls ersetzt sie. Nichts im inneren Prozess weiß, dass er aus einem Startprofil gestartet wurde. Jede Lösung läuft darauf hinaus, dass sich im inneren Ablauf Schritt 1 oder Schritt 3 anders verhält.

## Minimales Reproduktionsbeispiel

Eine Konsolen-App, die ausgibt, was sie tatsächlich erhalten hat:

```csharp
// .NET 10, C# 14 - Program.cs (ImplicitUsings enabled)
Console.WriteLine($"MY_MODE={Environment.GetEnvironmentVariable("MY_MODE") ?? "<null>"} " +
                  $"DOTNET_ENVIRONMENT={Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "<null>"} " +
                  $"DOTNET_LAUNCH_PROFILE={Environment.GetEnvironmentVariable("DOTNET_LAUNCH_PROFILE") ?? "<null>"} " +
                  $"args=[{string.Join(",", args)}] cwd={Environment.CurrentDirectory}");
```

Dazu eine `Properties/launchSettings.json` mit einem normalen Project-Profil an erster Stelle, gefolgt von drei Executable-Profilen:

```json
{
  "profiles": {
    "Default": {
      "commandName": "Project",
      "environmentVariables": { "MY_MODE": "from-Default", "DOTNET_ENVIRONMENT": "Production" }
    },
    "Exe": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "bin/Debug/net10.0/app.dll hello",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Exe", "DOTNET_ENVIRONMENT": "Development" }
    },
    "ExeDotnetRun": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "run --no-build",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-ExeDotnetRun", "DOTNET_ENVIRONMENT": "Development" }
    },
    "Watch": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "watch run --non-interactive",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
    }
  }
}
```

`dotnet run --no-build --launch-profile <name>` lieferte auf jedem SDK folgende Ausgabe:

| Profil | 10.0.112 | 10.0.302 / 10.0.401 / 11.0.100-rc.1 |
| --- | --- | --- |
| `Default` (Project) | `from-Default` | `from-Default` |
| `Exe` (startet `app.dll`) | Warnung "not supported", `<null>` | `from-Exe`, `Development`, args `[hello]` |
| `ExeDotnetRun` | Warnung "not supported", `<null>` | `from-Default`, `Production` |
| `Watch` | Warnung "not supported", `<null>` | `from-Default`, `Production` (10.0.302) |

Die Zeile `Exe` zeigt, dass die Executable-Profilunterstützung auf modernen SDKs an sich funktioniert. Die Zeilen `ExeDotnetRun` und `Watch` zeigen das Überschreiben: Der innere Befehl meldet `DOTNET_LAUNCH_PROFILE=Default`, hat also von sich aus das erste Profil gewählt.

## Die Lösung, Schritt für Schritt

1. **SDK prüfen.** Führen Sie `dotnet --version` im Projektverzeichnis aus, denn `global.json` kann ein älteres Band festlegen. Damit `dotnet run` und `dotnet watch` Executable-Profile überhaupt berücksichtigen, benötigen Sie 10.0.200 oder höher. Behalten Sie die Variablen unter 10.0.1xx stattdessen in einem `Project`-Profil.
2. **Verhindern, dass der verschachtelte Befehl ein Profil wählt.** Ist `executablePath` gleich `dotnet` und beginnen die Argumente mit `run` oder `watch`, fügen Sie `--no-launch-profile` hinzu:

   ```json
   // .NET SDK 10.0.200+ - Properties/launchSettings.json
   "Watch": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "watch run --non-interactive --no-launch-profile",
     "workingDirectory": "..",
     "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
   }
   ```

   Mit dieser Änderung gab die App unter `dotnet watch` auf 10.0.302 `MY_MODE=from-WatchNoProfile DOTNET_ENVIRONMENT=Development` aus. `DOTNET_LAUNCH_PROFILE` zeigt weiterhin den Namen des äußeren Profils, weil das äußere `dotnet run` es gesetzt hat und nichts es überschrieb.

3. **Oder den verschachtelten Befehl auf ein bestimmtes Profil verweisen.** Liegen die Variablen bereits in einem Project-Profil, verweisen Sie darauf, statt sie zu duplizieren:

   ```json
   // .NET SDK 10.0.200+
   "ExeDotnetRunPinned": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "run --no-build --launch-profile Dev",
     "workingDirectory": ".."
   }
   ```

   Das gab `MY_MODE=from-Dev DOTNET_ENVIRONMENT=Development DOTNET_LAUNCH_PROFILE=Dev` aus. In diesem Aufbau besitzt das innere Profil die Variablen. Alles, was Sie in `environmentVariables` des äußeren Profils eintragen, verliert, sobald beide Profile denselben Schlüssel setzen.

4. **In VS Code die Variablen nach `launch.json` verschieben.** Die C#-Erweiterung liest nur Project-Profile und davon nur `environmentVariables`, `applicationUrl` und `commandLineArgs`. Legen Sie stattdessen einen `env`-Block in einer `coreclr`-Startkonfiguration an. Werte in `launch.json` haben ohnehin Vorrang vor `launchSettings.json`.

## Stolperfallen und ähnliche Fälle

**Ein an erster Stelle stehendes Executable-Profil wird zum Standard und kann endlos Prozesse erzeugen.** Ab 10.0.200 ist das Standardprofil das erste, dessen `commandName` `Project` *oder* `Executable` ist (`IsDefaultProfileType` in [`LaunchSettings.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Microsoft.DotNet.ProjectTools/LaunchSettings/LaunchSettings.cs), dieselbe Regel gilt in `dotnet watch`). Tragen Sie `"commandLineArgs": "run --no-build"` im ersten Profil ein und führen Sie ein einfaches `dotnet run` aus, wählt jedes Kind wieder dasselbe Profil. Auf 10.0.302 zählte ich nach 12 Sekunden 53 `dotnet run`-Prozesse, bevor ich sie beendete. Die oben beschriebene Lösung mit `--no-launch-profile` unterbricht auch diese Schleife. Ein Project-Profil am Anfang der Datei ist eine günstige Absicherung.

**`dotnet run -e` überlebt den verschachtelten Schritt ebenfalls nicht.** Ich habe `dotnet run -e KEY=VALUE` auf SDK 10.0.112 und später geprüft (siehe [`dotnet run -e`](/de/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)). Es überschreibt das Profil für den Prozess, den das äußere `dotnet run` startet. Ist dieser Prozess ein weiteres `dotnet run`, überschreibt das innere Standardprofil auch diesen Wert: `-lp ExeDotnetRun -e MY_MODE=from-cli` gab weiterhin `from-Default` aus. Dasselbe gilt für einen einfachen Shell-Export. `MY_MODE=from-shell dotnet run -lp Default` gibt `from-Default` aus, weil Startprofilwerte stets Vorrang vor geerbten haben.

**`%VAR%` wird expandiert, `$(Property)` (noch) nicht.** Die CLI schickt jeden Wert durch `Environment.ExpandEnvironmentVariables`, daher funktioniert `%HOME%` auch unter macOS und Linux. `$(HOME)` und `${HOME}` werden unverändert durchgereicht. MSBuild-Eigenschaften wie `$(TargetPath)` oder `$(ProjectDir)` werden auf keinem der von mir getesteten ausgelieferten SDKs (10.0.302, 10.0.401, 11.0.100-rc.1) expandiert. Statt einer stillschweigend ignorierten Variable erhalten Sie `An error occurred trying to start process '$(TargetPath)' ... No such file or directory`. Der `ProjectLaunchTargetsProvider` von Visual Studio expandiert sie (laut der [Dokumentation zu Startprofilen im project-system](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)), weshalb ein aus einem VS-Setup kopiertes Profil in der CLI scheitert. [dotnet/sdk#56074](https://github.com/dotnet/sdk/pull/56074) fügt die Expansion hinzu. Der Pull Request wurde am 4. September 2026 in `main` gemergt, ist aber heute weder in `release/11.0.1xx-rc2` noch in einem 10.0-Band enthalten. Verwenden Sie bis zur Auslieferung relative Pfade.

**`workingDirectory` ist relativ zum Ordner `Properties`, nicht zum Projekt.** Die CLI löst es mit `Path.Combine(Path.GetDirectoryName(launchSettingsPath), value)` auf, sodass `".."` das Projektverzeichnis bedeutet. Visual Studio und Rider lösen es anders auf, was [dotnet/sdk#56129](https://github.com/dotnet/sdk/pull/56129) derzeit diskutiert. Bei Project-Profilen ignoriert die CLI `workingDirectory` auf heutigen SDKs vollständig.

**Eine Lösung für den verschachtelten Fall befindet sich im Review.** [dotnet/sdk#56087](https://github.com/dotnet/sdk/pull/56087) lässt `dotnet run` auf Prozessen, die es aus einem Executable-Profil startet, einen Marker `DOTNET_LAUNCH_PROFILE_APPLIED=1` setzen. Ein verschachteltes `dotnet run` ohne explizites Profil überspringt dann das Standardprofil. Am 30. September 2026 war der Pull Request noch offen. Selbst nach der Auslieferung deckt er nur Profile ab, die über die CLI gestartet werden. Laut PR benötigen IDEs, die das Executable-Profil direkt starten, weiterhin `--no-launch-profile`.

**`hotReloadEnabled` in einem Project-Profil bewirkt in `dotnet run` nichts.** Auch der Melder von #56023 hat das bemerkt. Hot Reload kommt von `dotnet watch`, nicht von einer Profileigenschaft. Genau deshalb verpacken viele `dotnet watch` überhaupt in ein Executable-Profil. Was der Watcher zusätzlich leistet, steht unter [Unterschied zwischen `dotnet watch` und `dotnet run`](/de/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/).

## Verwandte Artikel

- [.NET 11 Preview 3: dotnet run -e setzt Umgebungsvariablen ohne Startprofile](/de/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [Was ist der Unterschied zwischen dotnet watch und dotnet run?](/de/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)
- [Fix: dotnet watch Blazor Hot Reload WebSocket schlägt auf einer benutzerdefinierten lokalen Domain fehl](/de/2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain/), ein weiterer Fall, in dem Startprofil-Variablen den erwarteten Prozess nicht erreichen
- [Eine dateibasierte C#-App mit `dotnet run app.cs` ausführen](/de/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/), die `<app>.run.json`-Startprofile über denselben Code liest
- [Aspire zu einer bestehenden ASP.NET-Core-Solution hinzufügen](/de/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/), wo das eigene Startprofil des AppHost bestimmt, welche Umgebung jeder Dienst erhält

## Quellen

- [dotnet/sdk#56023: `launchSettings.json` environment variables are not propagated for `commandName: Executable`](https://github.com/dotnet/sdk/issues/56023)
- [dotnet/sdk#51727: Add Executable launch profile support to dotnet run and dotnet watch](https://github.com/dotnet/sdk/pull/51727)
- [dotnet/sdk#56087: Preserve Executable launch profile environment in nested dotnet run](https://github.com/dotnet/sdk/pull/56087)
- [dotnet/sdk#56074: Expand MSBuild properties across launch profiles](https://github.com/dotnet/sdk/pull/56074)
- [dotnet/sdk#49131: Allow `dotnet run` to use launch profiles with `commandName: Executable`](https://github.com/dotnet/sdk/issues/49131)
- [dotnet/project-system: launch profiles documentation](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)
- [VS Code C# debugger settings: launchSettings.json support](https://code.visualstudio.com/docs/csharp/debugger-settings)
- [`dotnet run` command reference on Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnet-run)
