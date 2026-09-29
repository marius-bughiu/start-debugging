---
title: "Fix: dotnet watch Blazor Hot Reload, WebSocket schlägt auf einer eigenen lokalen Domain fehl (403)"
description: "Seit den .NET SDKs vom September 2026 (10.0.112, 10.0.401, 11 RC1) lehnt dotnet watch Browser-Refresh-WebSockets von unbekannten Origins ab. Setzen Sie DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS auf Ihren Hostnamen."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-10"
  - "dotnet-11"
lang: "de"
translationOf: "2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain"
translatedBy: "claude"
translationDate: 2026-09-29
---

Setzen Sie `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` in der Shell, die `dotnet watch` startet, auf Ihren eigenen Hostnamen (nur der Host, etwa `myapp.localhost`, ohne Schema und ohne Port) und starten Sie den Watcher neu. Die SDKs vom 2026-09-08 (10.0.112, 10.0.401, 9.0.121, 9.0.318, 8.0.131, 8.0.425 und 11.0.100-rc.1) haben CVE-2026-58649 behoben. Seitdem akzeptiert der Browser-Refresh-WebSocket nur noch eine `Origin` von `localhost`, `127.0.0.1`, `[::1]` oder einem Host, den Sie in dieser Variable auflisten. Alles andere erhält ein 403. Alles Folgende habe ich auf macOS mit SDK 10.0.302 (vor dem Fix) und 10.0.401 (danach) gemessen, mit dem Standard-Template `dotnet new blazor`.

## Der Fehler im Kontext

Sie öffnen die App unter einem Namen wie `http://myapp.localhost:5080`, `https://shop.test` oder einem Hosts-Datei-Alias statt unter reinem `localhost`. Die Seite wird gerendert und der Blazor-eigene Circuit verbindet sich, aber die Browser-Konsole zeigt Folgendes:

```
Failed to load resource: the server responded with a status of 403 (Forbidden)
WebSocket connection to 'ws://localhost:5599/' failed:
WebSocket failed to connect.
WebSocket connection to 'wss://localhost:63038/' failed:
WebSocket failed to connect.
Unable to establish a connection to the browser refresh server.
```

Die letzten drei Zeilen sind `console.debug`-Ausgaben von `aspnetcore-browser-refresh.js`. Sie sehen sie daher nur, wenn in den DevTools von Chrome oder Edge die Stufe "Verbose" aktiviert ist. Die Portnummern sind zufällig, solange Sie sie nicht festlegen. Währenddessen sieht das Terminal von `dotnet watch` völlig gesund aus:

```
dotnet watch ⌚ Files updated: ./Components/Pages/Home.razor
dotnet watch 🔥 C# and Razor changes applied in 109ms.
```

Das Terminal meldet, die Änderung sei angewendet, und der Browser widerspricht. Dieser Widerspruch macht den Fehler so verwirrend. Viele Betroffene haben zudem nichts an ihrem Projekt geändert: Das SDK wurde im Hintergrund aktualisiert, über Visual Studio, Homebrew oder eine `global.json` mit `rollForward: latestPatch`. Der Bericht in [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291) beschreibt genau das: Hot Reload brach auf `bug.dev.localhost` mit SDK 10.0.401, und das Festpinnen auf 10.0.400 ließ es wieder funktionieren.

## Warum der Browser-Refresh-Socket jetzt 403 liefert

Unter `dotnet watch` erhalten Web-Apps ein kleines eingeschleustes Skript, `_framework/aspnetcore-browser-refresh.js`. Dieses Skript öffnet einen WebSocket zurück zu einem Server, der im `dotnet watch`-Prozess läuft. Der Server lauscht auf `127.0.0.1` an einem zufälligen Port, plus einem WSS-Port, wenn das Entwicklungszertifikat verfügbar ist. Über den Socket laufen Seiten-Reloads, CSS-Updates, Blazor-WebAssembly-Deltas und Diagnosedaten. Die eingeschleuste URL zeigt immer auf `localhost`, unabhängig davon, unter welchem Hostnamen die Seite geladen wurde:

```js
// injected by dotnet watch, SDK 10.0.401
const webSocketUrls = 'ws://localhost:5599,wss://localhost:63038'.split(',');
```

Eine Seite unter `http://myapp.localhost:5080` sendet also eine Cross-Origin-WebSocket-Anfrage an `ws://localhost:5599`, und der Browser schickt dabei `Origin: http://myapp.localhost:5080` mit. Vor September 2026 ignorierte der Refresh-Server den `Origin`-Header vollständig. Jede in Ihrem Browser geöffnete Seite, auf jeder Website, konnte sich verbinden, und der Socket überträgt IL- und PDB-Update-Payloads. Das ist [CVE-2026-58649](https://github.com/dotnet/sdk/issues/56166), eingestuft als CWE-346 (Origin Validation Error), CVSS 6,5.

Der Fix ([dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198) auf `release/11.0.1xx`, nach `main` portiert als [#56246](https://github.com/dotnet/sdk/pull/56246)) fügt diese Prüfung ein, bevor der WebSocket akzeptiert wird:

```csharp
// src/Dotnet.Watch/HotReloadClient/Web/BrowserRefreshServer.cs (SDK fix for CVE-2026-58649)
if (!Uri.TryCreate(context.Request.Headers.Origin.FirstOrDefault(), UriKind.Absolute, out var originUri) ||
    !webSocketConfig.GetAllowedOriginDomains().Contains(originUri.Host, StringComparer.OrdinalIgnoreCase))
{
    context.Response.StatusCode = StatusCodes.Status403Forbidden;
    return;
}
```

`GetAllowedOriginDomains()` liefert `localhost`, `127.0.0.1`, `[::1]`, jeden Eintrag aus `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` und den Wert von `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME`, falls gesetzt. Verglichen wird exakt und ohne Beachtung der Groß-/Kleinschreibung mit `Uri.Host`. Es gibt keine Platzhalter, kein Suffix-Matching und keine Sonderbehandlung für `*.localhost`. Eine Anfrage ganz ohne `Origin`-Header wird ebenfalls abgelehnt.

## Minimale Reproduktion

```bash
# .NET SDK 10.0.401, macOS 26 (any OS behaves the same)
dotnet new blazor -o BlazorRepro
cd BlazorRepro
DOTNET_WATCH_AUTO_RELOAD_WS_PORT=5599 dotnet watch run --urls http://localhost:5080
```

Das Festlegen des Ports mit `DOTNET_WATCH_AUTO_RELOAD_WS_PORT` macht den Socket lediglich leicht testbar. Chromium-Browser lösen jeden `*.localhost`-Namen ohne Hosts-Datei-Eintrag auf Loopback auf. Rufen Sie also `http://myapp.localhost:5080/` auf, und Sie erhalten die oben gezeigte Konsolenausgabe. Einen Browser brauchen Sie dafür nicht einmal. Ein roher WebSocket-Handshake mit `curl` zeigt die Entscheidung direkt:

```bash
# .NET SDK 10.0.401, while dotnet watch is running
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: http://myapp.test:5000' \
  http://127.0.0.1:5599/
```

Ich habe diesen Handshake gegen beide SDKs ausgeführt, mit unterschiedlichen Werten der neuen Variable:

| `Origin`-Header | 10.0.302 | 10.0.401 | 10.0.401 + `ORIGINS=myapp.test;bug.dev.localhost` |
|---|---|---|---|
| `http://localhost:5000` | 101 | 101 | 101 |
| `http://myapp.test:5000` | 101 | 403 | 101 |
| `https://myapp.test` | 101 | 403 | 101 |
| `http://bug.dev.localhost:5000` | 101 | 403 | 101 |
| `https://evil.example` | 101 | 403 | 403 |
| (kein `Origin`) | 101 | 403 | 403 |

Unter 10.0.302 ist die Antwort 101 (Switching Protocols) für `https://evil.example` die Sicherheitslücke selbst. Unter 10.0.401 wird jeder eigene Name abgelehnt, bis Sie ihn auflisten.

## Die Lösung: Hostnamen erlauben

`dotnet watch` liest die Variable beim Start aus seiner **eigenen** Prozessumgebung. Setzen Sie sie in der Shell, im Task Runner oder im Container, der `dotnet watch` startet, und starten Sie den Watcher dann neu. Ein bereits laufender Watcher übernimmt sie nicht.

```bash
# bash / zsh, .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.localhost"
dotnet watch run --urls http://localhost:5080
```

```powershell
# PowerShell, .NET SDK 10.0.401+
$env:DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS = "myapp.localhost"
dotnet watch run
```

Für mehrere Namen trennen Sie diese mit `;` oder `,`. Leerraum um jeden Eintrag wird entfernt:

```bash
# .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="shop.test;admin.shop.test,api.shop.test"
```

Wenn Sie den Watcher aus VS Code starten, gehört die Variable an den Task, nicht in `launch.json`. Das `env` einer `coreclr`-Startkonfiguration geht an die App, und die App ist nicht der Prozess, der die Prüfung durchführt:

```json
// .vscode/tasks.json, .NET SDK 10.0.401+
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "watch",
      "type": "process",
      "command": "dotnet",
      "args": ["watch", "run", "--project", "BlazorRepro/BlazorRepro.csproj"],
      "options": { "env": { "DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS": "myapp.localhost" } },
      "isBackground": true
    }
  ]
}
```

Mit gesetztem `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS=myapp.localhost` verband sich dieselbe Seite unter `http://myapp.localhost:5080`, und Änderungen erreichten den Browser ohne manuelles Aktualisieren. Eine Textänderung an der statischen SSR-Seite `Home.razor` und eine Farbänderung in `wwwroot/app.css` erschienen beide im geöffneten Tab.

## Was tatsächlich kaputtgeht und warum manche Änderungen trotzdem zu funktionieren scheinen

Das Symptom hängt davon ab, wo die Komponente gerendert wird, weshalb der Fehler sporadisch wirkt. Unter 10.0.401 ohne die Variable, mit der Seite geöffnet auf `myapp.localhost`:

- **Interactive-Server-Komponenten** (`Counter.razor` des Templates mit `@rendermode InteractiveServer`): Razor- und C#-Änderungen **erschienen weiterhin**. Das Delta wird im Serverprozess angewendet, und Blazor rendert über seinen eigenen SignalR-Circuit (`ws://myapp.localhost:5080/_blazor`) neu. Dieser ist Same-Origin und berührt den Refresh-Server nie.
- **Statische SSR-Seiten** (`Home.razor` des Templates): Razor-Änderungen **erschienen nicht**. `dotnet watch` gab "C# and Razor changes applied" aus, aber das neue HTML würde nur ein über den Refresh-Socket ausgelöstes Browser-Refresh anzeigen.
- **CSS in `wwwroot`**: Änderungen **erschienen auf keiner Seite**, obwohl das Terminal "Static asset changes applied" ausgab. CSS-Updates werden über den Refresh-Socket ausgeliefert.
- **Blazor WebAssembly** (Standalone oder das `.Client`-Projekt): Die Deltas selbst laufen über den Refresh-Socket, daher stoppt auch das C#- und Razor-Hot-Reload für WebAssembly-Komponenten (diesen Fall habe ich nicht gemessen, der Lieferweg ist aber derselbe Socket).

"Hot Reload funktioniert auf der Counter-Seite, aber nicht auf der Startseite" ist also derselbe Fehler und keine zwei verschiedenen. Wenn Sie nicht sicher sind, in welche Gruppe eine Komponente fällt, lesen Sie [wie Blazor entscheidet, welcher Render-Modus eine Komponente ausführt](/de/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/).

## Stolperfallen und ähnliche Symptome

**Der Wert ist ein Hostname, keine Origin.** Die Prüfung vergleicht `Uri.Host`, daher passen `http://myapp.test` und `myapp.test:5000` auf nichts. In meinen Läufen lieferten `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.test:5000,*.localhost"` und `"http://myapp.test"` beide weiterhin 403 für jede eigene Origin. Listen Sie jede Subdomain explizit auf.

**`launchSettings.json` funktioniert nicht.** Die `environmentVariables` eines Profils werden an den App-Prozess übergeben. `dotnet watch` hat seine Allow-List zu diesem Zeitpunkt bereits aufgebaut. Ich habe die Variable in beide Profile der `launchSettings.json` des Templates eingetragen und dennoch 403 für `myapp.test` erhalten. Derselbe Fix hat außerdem geändert, wie Variablen aus Startprofilen die App erreichen: Sie gehen nun per RPC an den Hot-Reload-Agent statt als `-e`-Argumente ([CVE-2026-69806](https://github.com/dotnet/sdk/issues/56167), gleicher PR). Die eigenen Einstellungen des Watchers sind davon jedoch nicht betroffen. Wenn Sie das im Repository verankern möchten, sind ein Skript im `.env`-Stil oder die obige Task-Definition der richtige Ort.

**`DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` ist ein anderer Regler.** Sein Host wird ebenfalls zur Allow-List hinzugefügt (mit `HOSTNAME=myapp.test` lieferten die `myapp.test`-Origins in meinem Test 101), aber er bewirkt mehr. Er ändert den Host, an den der Refresh-Server gebunden wird, und die URL, zu der sich das eingeschleuste Skript verbindet. Kestrel behandelt einen Hostnamen, der keine IP ist, als "auf allen Schnittstellen lauschen", wodurch der Socket aus Ihrem Netzwerk erreichbar wird. Verwenden Sie `HOSTNAME` nur, wenn der Browser `localhost` wirklich nicht erreichen kann, etwa wenn `dotnet watch` in einem Container oder auf einem entfernten Entwicklungsrechner läuft. Wenn sich nur der Name der Seite unterscheidet, nehmen Sie `ORIGINS`.

**Das Festpinnen des alten SDK "behebt" das Problem, indem es die Sicherheitslücke zurückbringt.** Eine `global.json`, die auf 10.0.400 oder 10.0.302 festgelegt ist, lässt das 403 verschwinden, weil diese SDKs jede Origin akzeptieren, `https://evil.example` eingeschlossen. Betrachten Sie das als Diagnoseschritt, nicht als Lösung.

**Advisory-Tabelle und Release Notes widersprechen sich bei den Versionsnummern.** Das Advisory führt 10.0.111 und 10.0.400 als "gepatcht" auf. Die [Release-Metadaten](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json) ordnen CVE-2026-58649 dem Release vom 2026-09-08 zu (Runtime 10.0.12, SDKs 10.0.112 und 10.0.401). Messung und der Melder des Issues stimmen mit den Release-Metadaten überein: 10.0.400 akzeptiert jede Origin, und 10.0.401 erzwingt die Prüfung. Die öffentlichen Tags `v10.0.400` und `v10.0.401` zeigen auf denselben Commit, weil Sicherheitsfixes aus dem internen Repository gebaut werden. Sie können sich den Vergleich der Tags also sparen.

**Ein 403 auf der Seite selbst ist etwas anderes.** Wenn das gesamte Dokument 403 liefert, prüfen Sie, was tatsächlich auf diesem Port lauscht. Unter macOS gehört Port 5000 dem AirPlay-Empfänger im Kontrollzentrum, der für jeden Pfad 403 antwortet. Browser können `*.localhost` vor `127.0.0.1` zu `::1` auflösen, sodass ein nur an `127.0.0.1:5000` gebundener Kestrel diese Verbindung an AirPlay verliert. Genau das ist mir beim Bau der Reproduktion passiert, weshalb die obigen Befehle `--urls http://localhost:5080` verwenden.

**Keine eigene Domain im Spiel und trotzdem kein Refresh?** Wenn Sie `localhost` aufrufen und der Socket dennoch fehlschlägt, liegt die Ursache woanders: eine HTTPS-Seite, die `wss://` ohne vertrauenswürdiges Entwicklungszertifikat versucht, ein in der Umgebung verbliebenes `DOTNET_WATCH_SUPPRESS_BROWSER_REFRESH=1` oder Middleware, die die Antwort umschreibt, sodass das Skript nie eingeschleust wird. [Was dotnet watch zusätzlich zu dotnet run bietet](/de/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) erklärt die Einschleusung und die gesetzten Umgebungsvariablen.

**Das Problem verschwindet später.** Auf dem `main`-Branch des SDK leitet [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118) (gemergt am 2026-09-21) den Browser-Tools-WebSocket über die Origin der Anwendung selbst und reicht ihn an einen nur auf Loopback lauschenden Provider weiter. In diesem Design teilen sich Seite und Socket eine Origin, und ein Code-Kommentar besagt, dass `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` "no longer applies to this hop". Diese Änderung ist zum Zeitpunkt des Schreibens in keinem SDK ausgeliefert, daher brauchen Sie unter 10.0.401 und 11 RC1 weiterhin die Variable.

## Verwandte Artikel

Es ist das zweite Mal, dass ein SDK-Update eine Blazor-App still kaputtgemacht hat, ohne jede Projektänderung. Das erste Mal war [der 404 für blazor.server.js nach der Installation des .NET-10-SDK](/de/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/). Was `dotnet watch` zuletzt über den Browser-Socket hinaus dazugewonnen hat, lesen Sie in [dotnet watch in .NET 11 Preview 3 mit Aspire-Hosts und Absturzwiederherstellung](/de/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/). Wenn Sie Visual Studio statt der CLI verwenden, behandelt [Hot Reload Auto-Restart in Visual Studio 2026](/de/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/), wie die IDE mit Änderungen umgeht, die sie nicht anwenden kann. Die Browser-Verbindung von Visual Studio selbst habe ich für diesen Beitrag nicht getestet.

## Quellen

- [CVE-2026-58649 advisory, dotnet/sdk#56166](https://github.com/dotnet/sdk/issues/56166), und die [announcement, dotnet/announcements#441](https://github.com/dotnet/announcements/issues/441).
- [dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198), der Fix, der `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` als Ausweichmöglichkeit für eigene Domains dokumentiert, und sein `main`-Port [#56246](https://github.com/dotnet/sdk/pull/56246).
- [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291), der Regressionsbericht zu `*.dev.localhost` mit SDK 10.0.401 und dem Workaround des Maintainers.
- [`EnvironmentVariables.cs` in dotnet/sdk](https://github.com/dotnet/sdk/blob/main/src/Dotnet.Watch/Watch/Context/EnvironmentVariables.cs), für Variablennamen, Trennzeichen und Standardwerte.
- [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118), das Same-Origin-Redesign der Browser-Tools auf `main`.
- [.NET 10 release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json), dafür, welche SDK-Builds den Fix enthalten.
