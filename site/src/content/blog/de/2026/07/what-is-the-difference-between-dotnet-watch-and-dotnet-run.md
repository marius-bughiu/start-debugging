---
title: "Was ist der Unterschied zwischen dotnet watch und dotnet run?"
description: "dotnet run kompiliert Ihr Projekt einmal und startet es. dotnet watch umschließt dotnet run mit einem Dateibeobachter: Es startet die App neu oder wendet Hot Reload an, sobald Sie eine Quelldatei speichern. Hier steht genau, was jeder Befehl tut, was dotnet watch setzt und dotnet run nicht, und wann Sie welchen verwenden."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "dotnet-cli"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-11"
lang: "de"
translationOf: "2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run"
translatedBy: "claude"
translationDate: 2026-07-10
---

`dotnet run` kompiliert Ihr Projekt einmal (standardmäßig Debug) und startet die resultierende App ein einziges Mal. Wenn der Prozess endet, sind Sie zurück am Prompt. `dotnet watch` ist ein Dateibeobachter um `dotnet run` herum: Es startet die App, beobachtet dann Ihre Quelldateien, und jedes Mal, wenn Sie eine Änderung speichern, wendet es entweder Hot Reload dieser Änderung auf den laufenden Prozess an oder startet die App neu. Kurzfassung: `dotnet run` bedeutet "einmal kompilieren und starten"; `dotnet watch` bedeutet "die App mit meinem Code synchron halten, während ich editiere". Sie sind keine Konkurrenten. `dotnet watch` ruft im Hintergrund buchstäblich `dotnet run` auf, sodass alles, was `dotnet run` tut, auch `dotnet watch` tut, zuzüglich der Beobachtung und des Hot Reload obendrauf.

Alles Folgende verwendet das .NET 11 SDK (`11.0.100`) mit `<TargetFramework>net11.0</TargetFramework>` und C# 14. Das Kernverhalten ist seit dem .NET 6 SDK stabil, als `dotnet watch` Hot Reload erhielt; versionsspezifische Änderungen werden dort genannt, wo sie wichtig sind.

## Das mentale Modell in einer Zeile

Führen Sie diese beiden Befehle nacheinander aus, und der Unterschied ist sofort sichtbar:

```bash
# .NET 11 SDK 11.0.100, project targeting net11.0.
dotnet run     # builds, launches once, returns to the prompt when the app exits
dotnet watch   # builds, launches, then stays resident watching for file changes
```

`dotnet run` ist ein Befehl, der endet. Er erledigt seine Arbeit und gibt die Kontrolle zurück. `dotnet watch` ist eine langlebige Sitzung. Er kehrt erst zurück, wenn Sie ihn mit Ctrl+C stoppen. Diese eine Verhaltenstatsache, resident gegenüber endend, ist die Wurzel jedes weiteren Unterschieds.

So ordnen sich die beiden Befehle Funktion für Funktion an:

| Verhalten                            | `dotnet run`                  | `dotnet watch`                                  |
| ------------------------------------ | ----------------------------- | ----------------------------------------------- |
| Kompiliert vor dem Start             | Ja (über `dotnet build`)      | Ja (delegiert an `dotnet run`)                  |
| Standardkonfiguration                | `Debug`                       | `Debug`                                          |
| Startet die App                      | Einmal                        | Einmal, dann Neustart bei Änderung              |
| Beobachtet Quelldateien              | Nein                          | Ja                                               |
| Hot Reload beim Editieren            | Nein                          | Ja (seit dem .NET 6 SDK)                        |
| Neustart bei nicht unterstützter Änderung | N/A                      | Ja (Rude-Edit-Abfrage oder Auto-Neustart)       |
| Auto-Aktualisierung des Browsers (Web) | Nein                        | Ja                                               |
| Kehrt am Ende zum Prompt zurück      | Wenn die App endet            | Nur mit Ctrl+C                                   |
| Liest `launchSettings.json`          | Ja                            | Ja (über das aufgerufene `dotnet run`)           |

## dotnet run: einmal kompilieren, einmal starten

Die [dotnet run-Referenz](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run) beschreibt es als Befehl, der Ihre Anwendung "aus dem Quellcode mit einem Befehl" ausführt. Er hängt von `dotnet build` ab, sodass jede Anforderung des Builds auch für `dotnet run` gilt. Die Abfolge lautet: impliziter Restore, Build nach `bin/<configuration>/<framework>/`, dann Start der erzeugten Binärdatei. Standardmäßig verwendet er `Debug` für die meisten Projekte.

Da `dotnet run` vom Projekt und nicht von einer kompilierten DLL ausgeht, liest er auch `Properties/launchSettings.json` und wendet standardmäßig das erste Startprofil an. Von dort stammt ein Umgebungsname wie `ASPNETCORE_ENVIRONMENT=Development` und alle Umgebungsvariablen des Profils. Sie können dies mit `--no-launch-profile` abwählen oder mit `-lp|--launch-profile` explizit eines auswählen.

Argumente nach einem literalen `--` werden an Ihre App weitergeleitet, nicht an die CLI:

```bash
# .NET 11 SDK 11.0.100. Everything after -- goes to your Main / top-level args.
dotnet run -- --input data.csv --verbose
```

Das `--` ist wichtiger, als es aussieht. `dotnet run` leitet jedes nicht erkannte Token an die Anwendung weiter, entfernt aber zuerst seine eigenen Optionen, was den Rest umsortieren kann. App-Argumente nach `--` zu platzieren, markiert jedes folgende Token als Anwendungsargument, sodass die CLI es nicht neu interpretiert. Es schützt Ihre Skripte auch für die Zukunft vor neuen `dotnet run`-Optionen, die später mit einem für die App gedachten Token kollidieren könnten.

Einige Dinge tut `dotnet run` bewusst nicht. Es ist kein Deployment-Werkzeug: Die Dokumentation ist eindeutig, dass es Abhängigkeiten aus dem NuGet-Cache auflöst und "es nicht empfohlen wird, `dotnet run` zum Ausführen von Anwendungen in der Produktion zu verwenden". Dafür wollen Sie `dotnet publish`, eine eigene Geschichte, die in [dem Unterschied zwischen dotnet build und dotnet publish](/de/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) behandelt wird. Und es beobachtet nichts. Sobald die App läuft, ist `dotnet run` fertig; es hat keine Ahnung, dass Sie gerade eine Datei bearbeitet haben.

## dotnet watch: dotnet run, plus ein Dateibeobachter und Hot Reload

Die [dotnet watch-Referenz](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch) sagt es deutlich: `dotnet watch` "ist ein Dateibeobachter. Wenn er eine Änderung erkennt, führt er den Befehl `dotnet run` oder einen angegebenen `dotnet`-Befehl aus". Ist die Änderung Hot-Reload-fähig, wird sie ohne Neustart auf die laufende App angewendet. Ist sie es nicht, startet er die App neu.

Das ist das gesamte Wertversprechen. Sie bearbeiten eine `.cs`-Datei, speichern, und die Änderung ist in ein bis zwei Sekunden aktiv, ohne dass Sie das Terminal berühren. Kein manueller Zyklus aus Stoppen, Neukompilieren, Neustarten.

Der Standard-Unterbefehl ist `run`, sodass diese beiden identisch sind:

```bash
# .NET 11 SDK 11.0.100. 'dotnet watch' with no subcommand defaults to 'run'.
dotnet watch
dotnet watch run
```

Seit dem .NET 8 SDK akzeptiert `dotnet watch` `run`, `build` oder `test` als untergeordneten Befehl. So führt `dotnet watch test` Ihr Testprojekt bei jedem Speichern erneut aus, ein enger Rot-Grün-Refactor-Zyklus, den `dotnet run` überhaupt nicht bieten kann.

Weitergeleitete Argumente funktionieren gleich, delegiert an das zugrunde liegende `dotnet run`:

```bash
# .NET 11 SDK 11.0.100. Args after -- reach the app on every relaunch.
dotnet watch run -- --input data.csv
```

Während die Sitzung läuft, haben Sie zwei Tastatursteuerungen. Ctrl+R erzwingt eine Neukompilierung und einen Neustart auch ohne Dateiänderung. Ctrl+C baut das Ganze ab, sowohl den Beobachter als auch die App. Ctrl+R bewirkt nur etwas, solange die App tatsächlich läuft: Beobachten Sie eine Konsolen-App, die sofort endet, bewirkt Ctrl+R nichts, der Beobachter beobachtet aber weiter und startet neu, wenn sich eine Datei ändert.

## Hot Reload und die "Rude Edit", die einen Neustart erzwingt

Hot Reload ist das Element, das `dotnet watch` magisch wirken lässt, und das Größte, was `dotnet run` nicht hat. Seit dem .NET 6 SDK wendet `dotnet watch` zulässige Bearbeitungen, Methodenrümpfe, viele Anweisungsänderungen, in vielen Fällen hinzugefügte Member, im laufenden Prozess an, während dieser weiterläuft. Der In-Memory-Zustand Ihrer App überlebt die Bearbeitung.

Nicht jede Bearbeitung lässt sich auf einen laufenden Prozess anwenden. Eine Methodensignatur ändern, einen Typ umbenennen, etwas bearbeiten, das die Laufzeit nicht an Ort und Stelle patchen kann: Das sind "Rude Edits". Trifft `dotnet watch` auf eine solche, kann es kein Hot Reload durchführen und fragt standardmäßig, was zu tun ist:

```
dotnet watch ⌚ Unable to apply hot reload because of a rude edit.
  ❔ Do you want to restart your app - Yes (y) / No (n) / Always (a) / Never (v)?
```

Wählen Sie Always, hört es auf zu fragen und startet fortan bei jeder Rude Edit einfach neu. Sie können die Abfrage auch ganz überspringen: Setzen Sie `DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1`, um immer stillschweigend neu zu starten, oder führen Sie mit `--non-interactive` (verfügbar seit dem .NET 7 SDK) aus, sodass bei Rude Edits ohne Warten auf Konsoleneingabe neu gestartet wird, was Sie in skript- oder containergestützten Szenarien wollen. Wenn Sie sich gar nicht mit Hot Reload befassen und einen einfachen Neustart-bei-Änderung-Zyklus wollen, deaktivieren Sie es:

```bash
# .NET 11 SDK 11.0.100. Watch and restart, no Hot Reload.
dotnet watch --no-hot-reload
```

Die Hot-Reload-Engine ist hier dieselbe, die Visual Studio verwendet, und die Menge unterstützter gegenüber nicht unterstützten Bearbeitungen folgt denselben Regeln; das Verhalten von [Visual Studio 2026 Hot Reload mit Auto-Neustart bei Rude Edits](/de/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) spiegelt das der CLI. Wenn Sie Rude Edits im einen verstehen, verstehen Sie sie im anderen.

## Was dotnet watch in der Umgebung setzt, was dotnet run nicht setzt

Wenn `dotnet watch` Ihre App startet, injiziert es mehrere Umgebungsvariablen, die ein bloßes `dotnet run` nie setzt. Es lohnt sich, sie zu kennen, denn sie erlauben Ihrer App zu erkennen, dass sie unter dem Beobachter läuft, und erklären gelegentlich überraschendes Verhalten. Die wichtigsten laut Dokumentation:

- **`DOTNET_WATCH`** wird in jedem vom Beobachter gestarteten Kindprozess auf `1` gesetzt. Das ist der saubere Weg zu erkennen: "Laufe ich unter `dotnet watch`?".
- **`DOTNET_WATCH_ITERATION`** beginnt bei `1` und erhöht sich um eins, jedes Mal, wenn die App neu gestartet oder per Hot Reload aktualisiert wird. Sie können sie protokollieren, um zu sehen, wie viele Reload-Zyklen eine Sitzung durchlaufen hat.
- **`DOTNET_HOTRELOAD_NAMEDPIPE_NAME`** benennt die Named Pipe, über die der Beobachter die Hot-Reload-Deltas an den laufenden Prozess sendet.

So kann ein Build-Schritt oder eine Startdiagnose abhängig vom Beobachter verzweigen:

```csharp
// .NET 11, C# 14. Detect the watcher from inside the app.
if (Environment.GetEnvironmentVariable("DOTNET_WATCH") == "1")
{
    var iteration = Environment.GetEnvironmentVariable("DOTNET_WATCH_ITERATION");
    Console.WriteLine($"Running under dotnet watch, reload iteration {iteration}");
}
```

Es gibt außerdem mehrere `DOTNET_WATCH_SUPPRESS_*`-Schalter, um einzelne Verhaltensweisen abzuschalten (Browser-Aktualisierung, Browser-Start, Emoji-Ausgabe, MSBuild-Inkrementalität). Keiner davon existiert in der `dotnet run`-Welt, weil `dotnet run` keine Beobachtung, keinen Hot-Reload-Kanal und keine Browser-Aktualisierungsinjektion hat, die zu unterdrücken wäre.

## Welche Dateien einen Reload auslösen und welche stillschweigend nicht

Eine häufige Verwirrungsquelle: Sie bearbeiten `appsettings.json` unter `dotnet watch` und nichts startet neu. Das ist Absicht. `dotnet watch` beobachtet die Elemente in der `Watch`-Elementgruppe des Projekts, die standardmäßig alles aus den Gruppen `Compile` und `EmbeddedResource` umfasst, über den gesamten Graphen der Projektreferenzen hinweg. In der Praxis heißt das:

- `**/*.cs`
- `*.csproj`
- `**/*.resx`
- Web-Inhalte: `wwwroot/**`

Konfigurationsdateien (`.json`, `.config`) lösen bewusst keinen Neustart aus, weil das Konfigurationssystem eine eigene Änderungserkennung über `IOptionsMonitor` und Reload-Token besitzt. Wenn Sie wirklich wollen, dass der Beobachter auf einen anderen Dateityp reagiert, erweitern Sie die `Watch`-Gruppe in der `.csproj`:

```xml
<!-- .NET 11. Make dotnet watch react to JS files too. -->
<ItemGroup>
  <Watch Include="**\*.js"
         Exclude="node_modules\**\*;**\*.js.map;obj\**\*;bin\**\*" />
</ItemGroup>
```

Seit dem .NET 10 SDK können Sie mit `DefaultItemExcludes` auch ganze Ordner ausschließen, die sonst laute Reloads verursachen würden, etwa ein `App_Data`-Verzeichnis, in das die App zur Laufzeit schreibt. `dotnet run` hat nichts von dieser Maschinerie, weil es nach dem Start nie wieder etwas liest.

## Bei Web-Apps aktualisiert dotnet watch auch den Browser

Es gibt ein weiteres nur `dotnet watch` eigenes Verhalten, das `dotnet run` nicht anfasst: Für ASP.NET Core- und Blazor-Apps injiziert der Beobachter ein kleines Browser-Aktualisierungsskript und öffnet einen WebSocket zurück zum Werkzeug. Wenn Sie eine Razor- oder CSS-Änderung speichern, lädt der Browser neu (oder aktualisiert live, bei unterstützten Blazor-Bearbeitungen), ohne dass Sie zu ihm wechseln oder F5 drücken. Das ist der Grund, warum `dotnet watch` `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` setzt und die Browser-Aktualisierungs-Middleware in Web-Projekten erscheint. Unter einem bloßen `dotnet run` erhalten Sie nichts davon: Ändern Sie eine View, und der Browser zeigt die alte Seite, bis Sie von Hand neu kompilieren und neu laden.

Eine Einschränkung, die die Dokumentation nennt: Aktiviert Ihre App Response Compression, kann das Werkzeug das Aktualisierungsskript nicht injizieren und warnt darüber. Die Lösung ist, das Aktualisierungsskript selbst zu bedingen oder die Kompression in der Entwicklung zu deaktivieren.

## Die Versionen, in denen sich das Verhalten geändert hat

Die Mechanik ist alt und stabil, aber einige Daten sind es wert, festgehalten zu werden:

- **.NET 6 SDK**: `dotnet watch` erhielt Hot Reload. Davor war es reiner Neustart.
- **.NET 7 SDK**: `--non-interactive` und `--disable-build-servers` kamen hinzu.
- **.NET 8 SDK**: `dotnet watch` beschränkte seine untergeordneten Befehle auf `run`, `build` und `test`; zuvor konnte es jeden `dotnet`-Befehl umschließen.
- **.NET 9 SDK (9.0.200)**: `dotnet run -e KEY=VALUE` kam an, sodass Sie nun eine einmalige Umgebungsvariable direkt aus der CLI ohne Startprofil übergeben können. Da `dotnet watch` an `dotnet run` weiterleitet, erhalten Sie das auch unter dem Beobachter. Siehe [dotnet run -e für Umgebungsvariablen ohne Startprofile](/de/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/).
- **.NET 10 SDK (10.0.100)**: `dotnet run --file app.cs` für dateibasierte Apps und `DefaultItemExcludes`-Unterstützung in `dotnet watch`.
- **.NET 11 SDK**: `dotnet watch` lernte, sich sauber in Aspire-App-Hosts zu integrieren und nach einem Absturz automatisch neu zu starten, ausgeführt in [dotnet watch in .NET 11: Aspire-Hosts und Crash-Recovery](/de/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/).

## Welchen Sie ausführen sollten

Greifen Sie zu `dotnet run`, wenn Sie die App einmal starten wollen: um eine Änderung zu prüfen, ein Konsolenwerkzeug auszuführen, einen einzelnen Aufruf in CI zu skripten oder wann immer Sie nicht vorhaben, während der Ausführung Code zu bearbeiten. Es kompiliert, startet und endet mit der App. Es ist das Einfachste, das Ihren Code zum Laufen bringt.

Greifen Sie zu `dotnet watch`, wenn Sie in einer Editieren-Speichern-Sehen-Schleife sind: an einer API iterieren, eine Blazor-Seite gestalten, mit `dotnet watch test` Rot-Grün zyklen oder etwas debuggen, das mehrere Bearbeitungen braucht, um es einzukreisen. Es kostet Sie ein residentes Terminal, und Hot Reload fällt gelegentlich bei einer Rude Edit auf einen Neustart zurück, aber im Gegenzug zahlen Sie nicht mehr bei jeder einzelnen Änderung die manuelle Neukompilieren-Neustart-Steuer.

Der Ein-Satz-Test: Wenn Sie die App ausführen und dann in Ihrem Editor weitertippen, verwenden Sie `dotnet watch`; wenn Sie sie nur laufen lassen wollen, verwenden Sie `dotnet run`. Keiner ersetzt `dotnet publish`, das nach wie vor der einzige unterstützte Weg ist, etwas zu erzeugen, das Sie tatsächlich ausliefern.

## Verwandte Artikel

- [Was ist der Unterschied zwischen dotnet build und dotnet publish?](/de/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)
- [dotnet watch in .NET 11 Preview 3: Aspire-Hosts, Crash-Recovery und ein saubereres Ctrl+C](/de/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/)
- [.NET 11 Preview 3: dotnet run -e setzt Umgebungsvariablen ohne Startprofile](/de/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [Visual Studio 2026: Hot Reload mit Auto-Neustart bei Rude Edits](/de/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/)
- [.NET 11 Preview 5: dateibasierte Apps erhalten die #:ref-Direktive](/de/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)

## Quellen

- [dotnet watch-Befehlsreferenz](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch) (Microsoft Learn)
- [dotnet run-Befehlsreferenz](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run) (Microsoft Learn)
- [dotnet build-Befehlsreferenz](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build) (Microsoft Learn)
- [Unterstützte .NET-App-Frameworks und -Szenarien für Hot Reload](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) (Microsoft Learn)
