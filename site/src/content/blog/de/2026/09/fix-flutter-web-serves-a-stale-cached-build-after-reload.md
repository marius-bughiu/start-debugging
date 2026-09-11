---
title: "Fix: Flutter Web liefert nach dem Neuladen des Browser-Tabs einen veralteten Build aus dem Cache"
description: "Ein Reload validiert nur index.html neu, daher kommt ein main.dart.js ohne Hash im Dateinamen weiter aus dem Browser-Cache. Senden Sie Cache-Control: no-cache für die Flutter-Build-Ausgabe, versehen Sie die Dateien mit einer Build-ID, wo Sie keine Header setzen können, und lassen Sie den selbstbereinigenden Service Worker die Caches aus der Zeit vor 3.41 abräumen."
pubDate: 2026-09-11
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "deployment"
  - "caching"
  - "how-to"
lang: "de"
translationOf: "2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload"
translatedBy: "claude"
translationDate: 2026-09-11
---

**Kurze Antwort:** Flutter Web erzeugt Einstiegspunkte mit festen Dateinamen (`flutter_bootstrap.js`, `main.dart.js`, `main.dart.wasm`, `canvaskit/...`), und ein normaler Reload im Browser validiert nur das HTML-Dokument neu. Wenn Ihr Host für diese Dateien irgendeine Frischedauer sendet (Firebase Hosting sendet `max-age=3600`, GitHub Pages sendet `max-age=600`), erhält die neu geladene Seite ein frisches `index.html` und ein altes `main.dart.js` aus dem Cache. Die Lösung: Liefern Sie den gesamten Ordner `build/web` mit `Cache-Control: no-cache` aus, oder, auf Hosts ohne konfigurierbare Header, versehen Sie `flutter_bootstrap.js` und `main.dart.js` nach `flutter build web` mit einer Build-ID. Haben Nutzer noch den Offline-first-Service-Worker aus Flutter 3.38 oder früher, stellen Sie weiterhin das Standard-`flutter_service_worker.js` bereit: Seit Flutter 3.41 ist das ein selbstbereinigender Worker, der den alten abmeldet und den Tab neu lädt.

Alles Folgende wurde mit Flutter 3.44.8 (Dart 3.12.2) nachgestellt und mit dem Tool- und Engine-Quellcode von 3.47.3 abgeglichen, der sich bei diesem Problem genauso verhält. Die Browsertests liefen in einem Chromium-basierten Browser gegen einen kleinen Node-Server, dessen `Cache-Control`-Richtlinie umschaltbar ist.

## Zwei verschiedene Caches, je nachdem, wann Sie zuerst ausgeliefert haben

Suchergebnisse zu diesem Problem vermischen zwei Epochen, und die Lösung unterscheidet sich:

- **Flutter 3.38.x und früher** erzeugte einen Offline-first-Service-Worker. Er lieferte jede Datei aus seiner `RESOURCES`-Map direkt aus dem Cache Storage, holte nur `index.html` online-first und brauchte einen zweiten Ladevorgang, bevor ein neues Deployment übernahm. Daher stammt der klassische Rat "Ich muss zweimal neu laden".
- **Flutter 3.41.0 und später** installiert für neue Besucher keinen cachenden Service Worker mehr. [PR #176834](https://github.com/flutter/flutter/pull/176834) (gemergt im Oktober 2025, erstmals stabil in 3.41.0) ersetzte den 6-KB-Worker durch einen 784 Byte großen Aufräum-Worker, und der Loader in `flutter.js` registriert ihn nur, wenn der Origin bereits eine Registrierung hat. Bei einer frischen 3.41+-App bleibt nur der gewöhnliche HTTP-Cache im Spiel, und um den geht es in diesem Beitrag hauptsächlich.

Welche Welt auf Sie zutrifft, sehen Sie in den DevTools unter Application, Service workers. Gibt es keine Registrierung, ist der HTTP-Cache der Schuldige.

## Warum ein Reload das neue main.dart.js nicht abruft

Sehen Sie sich an, was `flutter build web` unter 3.44.8 in `build/web` ablegt:

```text
# flutter build web, Flutter 3.44.8
index.html
flutter_bootstrap.js
flutter.js
flutter_service_worker.js
main.dart.js
version.json
manifest.json
assets/AssetManifest.bin
assets/FontManifest.json
assets/fonts/MaterialIcons-Regular.otf
canvaskit/canvaskit.js
canvaskit/canvaskit.wasm
```

Keiner dieser Namen enthält einen Inhalts-Hash. `index.html` lädt `flutter_bootstrap.js`, das eine `_flutter.buildConfig` enthält, deren `mainJsPath` der literale String `"main.dart.js"` ist. Jedes Deployment verwendet dieselben URLs, der Browser kann einen neuen Build also allein anhand der URL nicht von einem alten unterscheiden.

Kombinieren Sie das nun mit der Funktionsweise eines Reloads. Der Reload in Chrome validiert die Hauptressource neu und führt dann einen regulären Seitenaufruf durch. Laut dem Artikel des Chromium-Teams von 2017 hat sich der Browser dafür entschieden, "only validate the main resource and continue with a regular page load" ([Chromium-Blog](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html)). Unterressourcen, die laut ihrem `Cache-Control` noch frisch sind, kommen ohne Anfrage direkt aus dem Festplatten-Cache. Bei einer einfachen Navigation (ein Lesezeichen, eine eingetippte URL, ein Link) verwendet jeder Browser frische Kopien wieder, einschließlich `index.html` selbst.

Ob der Reload den neuen Build zeigt, hängt also vollständig davon ab, was Ihr Host für diese Dateien sendet:

| Host | Standard-`Cache-Control` für statische Dateien | Veraltungsfenster nach einem Deployment |
| --- | --- | --- |
| Firebase Hosting | `max-age=3600` (beobachtet auf `*.firebaseapp.com`) | bis zu 1 Stunde |
| GitHub Pages | `max-age=600`, nicht konfigurierbar | bis zu 10 Minuten |
| Netlify, Vercel, Cloudflare Pages | `public, max-age=0, must-revalidate` | keines |
| Nginx, Apache, `python -m http.server` ohne Konfiguration | kein Header, aber `Last-Modified` wird gesendet | heuristisch, siehe unten |

Die letzte Zeile erwischt viele. Ein fehlender `Cache-Control`-Header bedeutet nicht "nicht cachen". Mit einem `Last-Modified`-Header erlaubt [RFC 9111 Abschnitt 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2) dem Browser, eine heuristische Frischedauer zu wählen, typischerweise 10 % der Zeit seit der letzten Änderung der Datei. Ein `main.dart.js`, das zuletzt vor zehn Tagen bereitgestellt wurde, kann einen ganzen Tag lang als frisch gelten.

Firebase leert bei jedem Deployment zwar sein CDN, der Edge liefert die neuen Dateien also sofort aus. Der Cache des Browsers selbst wird aber nicht geleert, und genau diese Kopie verwendet ein Reload.

## Minimale Reproduktion

Dieser Server liefert `build/web` mit umschaltbarer Richtlinie aus. `firebase` ahmt die Standardeinstellung von Firebase Hosting nach, `fixed` ist die Lösung:

```js
// server.mjs, Node 22. Usage: MODE=firebase node server.mjs build/web
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const stat = fs.statSync(file);
  const headers = {
    'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    'ETag': `"${stat.size}-${stat.mtimeMs}"`,
    'Cache-Control': process.env.MODE === 'fixed' ? 'no-cache' : 'max-age=3600',
  };
  if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); return res.end(); }
  console.log(200, p);
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(8765);
```

Und eine App, deren einzige Aufgabe es ist, anzuzeigen, welcher Build läuft:

```dart
// lib/main.dart, Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

const build = 'A';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('Build $build')))),
);
```

Schritte: Kompilieren Sie mit `build = 'A'`, starten Sie den Server mit `MODE=firebase` und öffnen Sie `http://localhost:8765/`. Ändern Sie die Konstante auf `'B'`, führen Sie `flutter build web` erneut aus und laden Sie den Tab neu. Die Seite zeigt weiterhin "Build A". Das Server-Log für diesen Reload enthält eine einzige Anfrage:

```text
200 /index.html
```

`flutter_bootstrap.js`, `main.dart.js`, CanvasKit und die Schriften kamen alle aus dem Browser-Cache. Wiederholen Sie den ganzen Ablauf mit `MODE=fixed` auf einem frischen Origin, und der Reload zeigt "Build B". Ein zweiter Reload ohne neues Deployment kostet dann eine bedingte Anfrage pro Datei, jede beantwortet mit einem `304` ohne Body.

## Die Lösung, Schritt für Schritt

1. **Liefern Sie die Flutter-Build-Ausgabe mit `Cache-Control: no-cache` aus.** `no-cache` schaltet das Caching nicht ab. Es weist den Browser an, die Datei zu behalten, sie aber vor jeder Verwendung mit `If-None-Match` oder `If-Modified-Since` neu zu validieren. Unveränderte Dateien kosten einen Roundtrip und ein `304`. Geänderte Dateien werden heruntergeladen. Wenden Sie das auf `index.html`, `flutter_bootstrap.js`, `flutter.js`, `flutter_service_worker.js`, `main.dart.js`, `main.dart.mjs`, `main.dart.wasm`, `version.json`, `manifest.json`, alles unter `assets/` und den lokalen Ordner `canvaskit/` an. Die einfachste korrekte Regel lautet "alles in `build/web`".
2. **Tragen Sie die Regel in die Konfiguration Ihres Hosts ein.** Beispiele für Firebase Hosting, Nginx und die von Netlify und Cloudflare Pages verwendete Datei `_headers` folgen unten.
3. **Warten Sie eine alte Lebensdauer ab.** Neue Header gelten nur für Antworten, die nach der Änderung abgerufen werden. Browser, die `main.dart.js` unter `max-age=3600` gecacht haben, verwenden es weiter, bis diese Stunde um ist. Liefern Sie die Header-Änderung ein Deployment früher aus, als Sie sie brauchen, oder kombinieren Sie sie beim ersten Rollout mit einer Build-ID (Schritt 4).
4. **Wo Sie keine Header setzen können, vergeben Sie eine Build-ID.** GitHub Pages ist der typische Fall. Schreiben Sie die URLs der Einstiegspunkte nach jedem Build um, sodass jedes Deployment neue URLs hat.
5. **Informieren Sie bereits geöffnete Tabs.** Header helfen erst beim nächsten Laden. Ein langlebiger Tab führt den alten Build weiter aus, bis der Nutzer neu lädt, fragen Sie also regelmäßig eine kleine Datei mit der Build-ID ab und bieten Sie einen Reload an.

### Firebase Hosting

Die [Flutter-Web-FAQ](https://docs.flutter.dev/platform-integration/web/faq) schlägt `max-age=0,s-maxage=604800` für `js`, `mjs`, `wasm` und `json` vor, was das CDN warm hält und den Browser gleichzeitig zur Revalidierung zwingt. Ihr Muster lässt HTML und `.bin` aus und gibt Bildern und Schriften `max-age=3600`, sodass `index.html`, `assets/AssetManifest.bin` und jedes unter demselben Namen ersetzte Bild eine Stunde lang veraltet bleiben. Diese `firebase.json` deckt den ganzen Build ab:

```json
{
  "hosting": {
    "public": "build/web",
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cache-Control", "value": "no-cache" }
        ]
      }
    ]
  }
}
```

Da Firebase sein CDN beim Deployment leert, brauchen Sie `s-maxage` nicht, damit der Edge korrekt bleibt. Fügen Sie es nur wieder hinzu, wenn Sie ein Latenzproblem messen.

### Nginx

```nginx
# nginx 1.27, serving the output of flutter build web
server {
    listen 80;
    root /var/www/app/build/web;

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
        etag on;
    }
}
```

Behalten Sie `etag on` bei (die Standardeinstellung). Ohne Validator hat der Browser nichts, womit er revalidieren kann, und lädt jedes Mal die vollständige Datei herunter.

### Netlify und Cloudflare Pages

Beide verwenden standardmäßig bereits `max-age=0, must-revalidate`, was sich korrekt verhält. Hat eine frühere Konfiguration oder ein Framework-Preset eine längere Lebensdauer hinzugefügt, überschreiben Sie sie mit einer Datei `_headers` in `web/`, damit `flutter build web` sie nach `build/web` kopiert:

```text
# web/_headers, copied to build/web by flutter build web (Flutter 3.44)
/*
  Cache-Control: no-cache
```

### GitHub Pages und andere Hosts ohne Header-Konfiguration

Führen Sie nach dem Build ein kleines Skript aus. Es hängt `?v=<id>` an das Bootstrap-Script-Tag und an die Build-Pfade in `_flutter.buildConfig` an und schreibt die ID für Schritt 5 in `build_id.txt`:

```bash
#!/usr/bin/env bash
# bust.sh, run after `flutter build web` (Flutter 3.44 output layout)
set -euo pipefail
ID="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"
OUT=build/web
sed -i.bak "s|src=\"flutter_bootstrap.js\"|src=\"flutter_bootstrap.js?v=$ID\"|" "$OUT/index.html"
sed -i.bak -E "s#\"(main\.dart\.(js|wasm|mjs))\"#\"\1?v=$ID\"#g" "$OUT/flutter_bootstrap.js"
rm "$OUT"/*.bak
echo "$ID" > "$OUT/build_id.txt"
```

Unter einer `max-age=600`-Richtlinie forderte ein Reload nach dem Deployment eines gestempelten Builds genau drei Dateien an (`index.html`, `flutter_bootstrap.js?v=...`, `main.dart.js?v=...`) und zeigte den neuen Build, während CanvasKit und die Schriften weiter aus dem Cache kamen. Das ist der Ansatz, den die Flutter-FAQ beschreibt, mit dem Hinweis, dass Flutter Build-IDs nicht automatisch anhängt. `index.html` selbst unterliegt bei einer einfachen Navigation weiterhin der Lebensdauer von 10 Minuten (ein Reload validiert es immer neu), und Assets, die Sie unter demselben Namen ersetzen, sind nicht abgedeckt, benennen Sie geänderte Bilder also um, statt sie zu überschreiben.

### Geöffneten Tabs einen Reload anbieten

Übergeben Sie der App dieselbe ID zur Kompilierzeit und vergleichen Sie sie mit der bereitgestellten `build_id.txt`. `cache: 'no-store'` hält die Prüfung selbst aus dem HTTP-Cache heraus:

```dart
// lib/update_check.dart, Flutter 3.44.8, Dart 3.12.2, package:web 1.1.1
import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

/// flutter build web --dart-define=BUILD_ID=$(git rev-parse --short HEAD)
const buildId = String.fromEnvironment('BUILD_ID', defaultValue: 'dev');

Future<bool> newBuildAvailable() async {
  try {
    final response = await web.window
        .fetch('build_id.txt'.toJS, web.RequestInit(cache: 'no-store'))
        .toDart;
    if (!response.ok) return false;
    final deployed = (await response.text().toDart).toDart.trim();
    return deployed.isNotEmpty && deployed != buildId;
  } catch (_) {
    return false; // offline or blocked: keep running the current build
  }
}

void startUpdateCheck(GlobalKey<ScaffoldMessengerState> messenger) {
  if (buildId == 'dev') return;
  Timer.periodic(const Duration(minutes: 5), (timer) async {
    if (!await newBuildAvailable()) return;
    timer.cancel();
    messenger.currentState?.showSnackBar(
      SnackBar(
        duration: const Duration(days: 1),
        content: const Text('A new version is available.'),
        action: SnackBarAction(
          label: 'Reload',
          onPressed: () => web.window.location.reload(),
        ),
      ),
    );
  });
}
```

Geben Sie `MaterialApp` einen `scaffoldMessengerKey` und rufen Sie `startUpdateCheck` damit aus `main` auf. Beim Kompilieren mit `--dart-define=BUILD_ID=A` und dem Bereitstellen einer `build_id.txt` mit dem Inhalt `B` lieferte `newBuildAvailable()` bei der ersten Prüfung `true`. Wenn Sie `bust.sh` nicht verwenden, schreiben Sie `build_id.txt` in der CI mit derselben ID. Das ist vor allem dann wichtig, wenn sich Ihre Backend-API zusammen mit dem Frontend ändert, denn ein alter Tab, der eine neue API aufruft, ist ein schlimmerer Bug als eine alte Oberfläche.

## Wenn Sie den Service Worker vor Flutter 3.41 ausgeliefert haben

Nutzer, die Ihre App zum ersten Mal geöffnet haben, als sie mit 3.38.x oder früher gebaut war, haben den Offline-first-Worker und seinen `flutter-app-cache` noch im Browser. Laut dem Quellcode von 3.44.8 und 3.47.3 passiert Folgendes, wenn sie zum ersten Mal ein Deployment laden, das mit 3.41 oder später gebaut wurde:

1. Der alte Worker hat noch die Kontrolle, beantwortet die Navigation also online-first (neues `index.html`), liefert aber `flutter_bootstrap.js` und `main.dart.js` aus dem Cache Storage. Der Nutzer sieht möglicherweise kurz den alten Build.
2. Die Update-Prüfung des Browsers für den Service Worker ruft `flutter_service_worker.js` aus dem Netzwerk ab. Die Datei unterscheidet sich byteweise (sie ist jetzt der 784 Byte große Aufräum-Worker) und wird daher installiert.
3. Der Aufräum-Worker ruft `skipWaiting()` auf, ruft dann in `activate` `self.registration.unregister()` auf und navigiert jedes von ihm kontrollierte Fenster zu dessen aktueller URL.
4. Diese Navigation erfolgt ohne Service Worker, die Seite lädt den aktuellen Build also über den HTTP-Cache. Mit den Headern aus dem vorherigen Abschnitt ist das der neue Build.

Der Aufräum-Worker löscht `flutter-app-cache`, `flutter-temp-cache` und `flutter-app-manifest` nicht. Ohne Worker liest sie niemand, sie belegen aber weiter Speicherplatz. Wenn Ihnen das wichtig ist, löschen Sie sie einmalig beim Start über die Cache Storage API (`caches.delete('flutter-app-cache')` und so weiter, über `package:web`).

Zwei Fehler beim Deployment blockieren diese Übergabe:

- **`flutter_service_worker.js` aus dem Deployment entfernen.** Erhält die Update-Prüfung ein `404`, behält der Browser den bestehenden Worker, und der alte Worker liefert weiter das alte `main.dart.js` aus dem Cache Storage. Liefern Sie die Datei so lange mit aus, wie Sie Besucher aus der alten Zeit haben könnten.
- **Zu früh mit `--pwa-strategy=none` kompilieren.** Das Flag ist in 3.44 versteckt und veraltet und gibt einen Verweis auf [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910) aus. Mit `none` schreibt das Tool ein leeres `flutter_service_worker.js` und entfernt `serviceWorkerSettings` aus `flutter_bootstrap.js`, sodass nichts den alten Worker abmeldet. Der Browser installiert irgendwann das leere Skript, doch es übernimmt erst, nachdem jeder Tab der App geschlossen wurde, und die Registrierung verschwindet nie. Der Standard-Build ist derjenige, der den Aufräumpfad enthält.

Wenn Sie echte Offline-Unterstützung brauchen, empfiehlt die [Flutter-FAQ](https://docs.flutter.dev/platform-integration/web/faq) inzwischen, einen eigenen Worker mitzubringen, etwa mit Workbox. Geben Sie ihm einen versionierten Cache-Namen und eine Network-first-Strategie für `index.html` und `flutter_bootstrap.js`, sonst bauen Sie das alte Problem nach.

## Fallstricke und ähnlich aussehende Probleme

- **Ein Hard Reload verdeckt den Bug.** Ctrl+Shift+R (Cmd+Shift+R unter macOS) umgeht bei diesem Ladevorgang den HTTP-Cache und den Service Worker, deshalb sehen Entwickler das Problem selbst selten. Testen Sie mit einem normalen Reload oder mit deaktiviertem "Disable cache" in den DevTools.
- **CanvasKit vom CDN ist sicher, lokales CanvasKit nicht.** Standardmäßig lädt der Loader CanvasKit von `gstatic.com` unter einer URL, die die Engine-Revision enthält, ein Flutter-Upgrade ändert also die URL. Mit `--no-web-resources-cdn` wird CanvasKit aus `canvaskit/` mit bei jedem Release gleichem Namen ausgeliefert. Eine aggressive Lebensdauer kann dort nach einem Flutter-Upgrade ein neues `main.dart.js` mit einem alten CanvasKit kombinieren.
- **Lange Lebensdauern für "statische" Assets.** Manche Hosts und CDN-Presets geben `.js`-Dateien `max-age`-Werte von 30 Tagen, weil sie gehashte Namen voraussetzen. Diese Annahme ist für die Flutter-Ausgabe falsch. Prüfen Sie die tatsächlichen Antwort-Header mit `curl -I https://your.app/main.dart.js`.
- **Wasm-Builds haben mehr Einstiegspunkte.** Ein `--wasm`-Build lädt zusätzlich `main.dart.mjs` und `main.dart.wasm`, und der Loader fällt bei Browsern außerhalb seiner Allowlist auf `main.dart.js` zurück. Alle drei brauchen dieselbe Behandlung, deshalb schreibt `bust.sh` sie alle um.
- **Veraltetes Verhalten, das nicht am Cache liegt.** Lädt der neue Build, aber Routen liefern beim Aktualisieren ein 404, fehlt ein SPA-Rewrite (`try_files ... /index.html` oder `"rewrites"` in `firebase.json`). Liefern Assets nur unter einem Unterpfad ein 404, prüfen Sie `--base-href`.

## Verwandte Artikel

- [So kompilieren Sie eine Flutter-Web-App mit WebAssembly](/de/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), mit den zusätzlichen Wasm-Einstiegspunkten und den COOP/COEP-Headern, die in derselben Host-Konfiguration neben `Cache-Control` stehen.
- [Eine Flutter-Web-App von `dart:html` auf `package:web` migrieren](/de/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/), für den Interop-Stil, der in der Update-Prüfung verwendet wird.
- [Fix: Flutter-Text wird in einer Android-WebView außerhalb des Bildschirms gerendert](/de/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/), ein weiteres Flutter-Web-Problem, das erst nach dem Deployment auftaucht.
- [Output Caching vs. Response Caching in ASP.NET Core 11](/de/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/), falls Ihr Flutter-Web-Build von einem ASP.NET-Core-Backend ausgeliefert wird und Sie die `Cache-Control`-Header dort setzen.

## Quellen

- [Flutter-Web-FAQ](https://docs.flutter.dev/platform-integration/web/faq): Entfernung des Service Workers, Hinweise zu `Cache-Control` und die Build-ID-Technik.
- [Initialisierung von Flutter-Web-Apps](https://docs.flutter.dev/platform-integration/web/initialization): Template-Tokens von `flutter_bootstrap.js`.
- [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910): Abkündigung und Entfernung von `flutter_service_worker.js`.
- [flutter/flutter PR #176834](https://github.com/flutter/flutter/pull/176834): der selbstbereinigende Service Worker, erstmals ausgeliefert in 3.41.0.
- [`service_worker_loader.js` in 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/flutter_js/src/service_worker_loader.js) und [`flutter_service_worker.js` in 3.38.10](https://github.com/flutter/flutter/blob/3.38.10/packages/flutter_tools/lib/src/web/file_generators/js/flutter_service_worker.js) für das Verhalten des alten und des neuen Workers.
- [Chromium-Blog: Reload, reloaded](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html): Ein Reload validiert nur die Hauptressource neu.
- [RFC 9111, Abschnitt 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2): heuristische Frische, wenn keine explizite Lebensdauer gesendet wird.
- [Cache-Verhalten von Firebase Hosting](https://firebase.google.com/docs/hosting/manage-cache): Leeren des CDN bei erneutem Deployment.
