---
title: "Lösung: Der Flutter-Debugger springt beim Hot Reload ohne Fehlermeldung in binding.dart"
description: "Ein dwds-Bug in Flutter 3.35 für das Web meldete bei jedem Hot Reload eine falsche Pause. Aktualisieren Sie auf Flutter 3.38+ oder stellen Sie VS Code wieder auf 'Debug my code' um, damit Paket-Frames übersprungen werden."
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "hot-reload"
  - "vs-code"
  - "debugging"
lang: "de"
translationOf: "2026/09/fix-flutter-debugger-jumps-into-binding-dart-on-hot-reload"
translatedBy: "claude"
translationDate: 2026-09-26
---

Wenn Sie eine Flutter-Web-App aus VS Code oder Android Studio starten und jeder Hot Reload `package:flutter/src/foundation/binding.dart` öffnet (meist um Zeile 845 herum), ohne dass eine Exception zu sehen ist, machen Sie nichts falsch. Es handelt sich um einen Bug in dwds, dem Web-Debug-Dienst, der mit Flutter 3.35 ausgeliefert wurde: Während eines Hot Reloads pausierte er Chrome, um Haltepunkte neu zu registrieren, und meldete diese interne Pause der IDE als echte Pause. Behoben wurde das in dwds 25.1.0+1, das erstmals mit Flutter 3.38.0 im Stable-Kanal ankam. Aktualisieren Sie (die aktuelle Stable-Version ist 3.47.5). Wenn Sie auf 3.35.x festsitzen, stellen Sie den VS-Code-Debugmodus in der Statusleiste wieder auf "Debug my code" um oder übergeben Sie `--no-web-experimental-hot-reload`.

Alles Folgende wurde gegen die Quellen von Flutter 3.35.4, 3.35.7, 3.38.0 und 3.47.5, die Changelogs von dwds 24.4.0+2 und 25.1.0+1 sowie das Einstellungsschema von Dart-Code 3.144 geprüft.

## Der Fehler im Kontext

Es gibt keinen Fehlertext, und genau das ist das Verwirrende. Sie speichern eine Datei (oder drücken die Hot-Reload-Schaltfläche), der Reload wird abgeschlossen, und dann wechselt der Editor zu einer Datei, die Sie nie geöffnet haben:

```text
package:flutter/src/foundation/binding.dart   (line 845, highlighted as the current frame)

  @protected
  void postEvent(String eventKind, Map<String, dynamic> eventData) {
    developer.postEvent(eventKind, eventData);   // <- debugger "paused" here
  }
```

Das Panel CALL STACK zeigt an, dass das Isolate pausiert ist, allerdings weder wegen einer Exception noch an einem Haltepunkt. Sie drücken Continue, die App läuft weiter, und beim nächsten Reload passiert es erneut. Manche sehen stattdessen eine andere Datei, mit einer Meldung statt Quellcode:

```text
Could not load source 'package:flutter/src/foundation/binding.dart': Bad state: source reference is no longer valid.
```

Varianten desselben Berichts nennen `package:flutter/src/painting/decoration_image.dart` oder `package:provider/src/devtool.dart`. Diese Liste erweist sich als der beste Hinweis darauf, was vor sich geht.

Der typische Bericht betrifft Flutter 3.35.4 oder 3.35.5 im Stable-Kanal, Dart 3.9.2, ausgeführt in Chrome und aus VS Code debuggt. Dasselbe Symptom wurde auch in Android Studio bestätigt. Wer `flutter run -d chrome` in einem Terminal ausführt, sieht es nicht, weil in einem Terminal nichts zu einer Quelldatei springt.

## Warum der Debugger in binding.dart anhält

Flutter 3.35 hat Stateful Hot Reload für das Web standardmäßig aktiviert (das Flag `--web-experimental-hot-reload` wurde auf `defaultsTo: true` umgestellt). Damit Ihre Haltepunkte über einen Reload hinweg funktionieren, pausiert dwds das JavaScript-Isolate in Chrome, registriert die Haltepunkte gegen den neuen Code neu und setzt die Ausführung fort. Diese Pause ist ein Implementierungsdetail. Der Bug bestand darin, dass dwds 24.4.x beim Pausieren immer ein `PauseInterrupted`-Ereignis ausgab, auch bei dieser internen Pause.

Die IDE kann den Unterschied nicht erkennen. Wie Dart-Code-Maintainer Danny Tuppeny in [flutter/flutter#176693](https://github.com/flutter/flutter/issues/176693) schrieb, wirkt das während des Reloads gesendete `PauseInterrupted`-Ereignis "to DAP/VS Code looks like a legitimate pause" (für DAP/VS Code wie eine legitime Pause). Also tut VS Code, was es bei jeder Pause tut: Es nimmt den obersten Frame des Aufrufstapels und öffnet diese Datei.

Welche Datei? Den Dart-Code, der gerade lief, als Chrome pausierte. In einem Debug-Build sendet Flutter ständig VM-Service-Ereignisse: `SchedulerBinding` sendet nach Frames `Flutter.Frame`, Service-Extensions senden `Flutter.ServiceExtensionStateChanged`, und all das läuft über eine einzige Methode in `BindingBase`:

```dart
// Flutter 3.35.4, packages/flutter/lib/src/foundation/binding.dart, lines 843-846
@protected
void postEvent(String eventKind, Map<String, dynamic> eventData) {
  developer.postEvent(eventKind, eventData);
}
```

Im Quellcode von 3.35.4 steht `developer.postEvent(eventKind, eventData);` genau in Zeile 845, weshalb so viele Berichte diese Zeile nennen. Die anderen Dateien, in denen Leute landen, rufen ebenfalls `postEvent` auf: `decoration_image.dart` ruft `developer.postEvent('Flutter.ImageSizesForFrame', ...)` auf, und `devtool.dart` aus `provider` sendet eigene Ereignisse für die Provider-DevTools-Erweiterung. Die Pause trifft denjenigen, der in diesem Moment gerade mit dem VM-Service spricht.

Die Variante "source reference is no longer valid" ist dieselbe Pause mit ungünstigerem Timing: Der Reload hat gerade neue Skripte eingespielt, sodass sich die Skriptreferenz des veralteten Frames nicht mehr auflösen lässt.

### Warum nur manche Entwickler es sahen

VS Code springt nur dann zu einem pausierten Frame, wenn dieser als Ihr eigener Code gilt. Dart-Code entscheidet das anhand zweier Einstellungen, die beide standardmäßig `false` sind:

- `dart.debugSdkLibraries`: markiert `dart:*`-Bibliotheken als debugbar.
- `dart.debugExternalPackageLibraries`: markiert externe Pub-Pakete als debugbar, und das Dart-Code-Schema stellt ausdrücklich klar, dass dazu `package:flutter` gehört.

Das sind dieselben Einstellungen, die das Statusleisten-Element während einer laufenden Debug-Sitzung durchschaltet: "Debug my code", "Debug my code + packages", "Debug my code + packages + SDK". Mit der Standardeinstellung "Debug my code" gehört jeder Frame der falschen Pause zu `package:flutter`, keiner davon zählt als Benutzercode, und VS Code hat kein Sprungziel. Wer irgendwann auf "+ packages" umgestellt hatte, um in eine Framework-Methode hineinzusteppen, für den wurde `binding.dart` zu "eigenem" Code, und der Editor sprang bei jedem Reload dorthin. Das erklärt auch, warum ein Mitglied des Flutter-Teams zunächst 3.35.6 testete, kein Problem sah und das Issue als behoben markierte, bevor Danny darauf hinwies, dass die Aufzeichnung "Debug my code" verwendete.

## Minimale Reproduktion

Das brauchen Sie nur, wenn Sie bestätigen möchten, dass Sie auf genau diesen Bug stoßen und nicht auf etwas anderes.

```bash
# Flutter 3.35.4 stable, Dart 3.9.2, Chrome, VS Code with Dart-Code
flutter create repro_binding
cd repro_binding
code .
```

```jsonc
// .vscode/settings.json -- Flutter 3.35.x, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": true
}
```

Wählen Sie Chrome als Gerät, drücken Sie F5, ändern Sie den Zählertext in `lib/main.dart` und speichern Sie. Unter 3.35.x öffnet der Editor `binding.dart` in der Zeile mit `developer.postEvent`. Entfernen Sie die Einstellung (oder wählen Sie "Debug my code" in der Statusleiste), und der Sprung bleibt aus, auch wenn das Isolate weiterhin kurz pausiert. Ab Flutter 3.38.0 passiert weder das eine noch das andere.

## Lösung 1: auf Flutter 3.38 oder neuer aktualisieren

Das ist die eigentliche Lösung. Die dwds-Änderung ist [dart-lang/webdev#2695](https://github.com/dart-lang/webdev/pull/2695), "Don't send PauseInterrupted event during a hot reload", gemergt am 2025-10-09. Statt ein normales Pause-Ereignis zu senden, teilt `ChromeProxyService` dem Debugger jetzt mit, dass die Pause intern ist, und der Debugger signalisiert den Abschluss über einen Completer statt über ein Ereignis. Ausgeliefert wurde das als dwds-Hotfix `25.1.0+1`, dessen Changelog-Eintrag "Fix an issue in `reloadSources` where a `PauseInterrupted` event was sent" lautet und auf [dart-lang/sdk#61560](https://github.com/dart-lang/sdk/issues/61560) verweist.

Entscheidend für Sie ist, welche dwds-Version Ihr Flutter SDK in `packages/flutter_tools/pubspec.yaml` festlegt:

| Flutter | Festgelegte dwds-Version | Falsche Pause beim Web-Hot-Reload |
| --- | --- | --- |
| 3.32.8 | 24.3.10 | Nein (Stateful Web Hot Reload standardmäßig aus) |
| 3.35.4 | 24.4.0+2 | Ja |
| 3.35.7 (letzter 3.35-Hotfix) | 24.4.0+2 | Ja |
| 3.38.0 | 25.1.0+2 | Nein |
| 3.47.5 (Stable, September 2026) | 27.1.2 | Nein |

Der Fix wurde nie per Cherry-Pick in die 3.35-Linie übernommen, daher hilft kein 3.35-Hotfix. Prüfen Sie, welche Version Sie verwenden, und gehen Sie weiter:

```bash
# any Flutter version
flutter --version
flutter channel stable
flutter upgrade
```

Wenn das Projekt sein SDK über FVM oder eine `.flutter-version`-Datei festlegt, erhöhen Sie stattdessen diese Version, sonst startet die IDE weiterhin das alte SDK, selbst nachdem Sie das globale aktualisiert haben:

```bash
# FVM 3.x
fvm install 3.47.5
fvm use 3.47.5
```

Starten Sie anschließend die Debug-Sitzung neu. Eine laufende Sitzung behält ihren ursprünglichen `flutter run`-Prozess, und dieser Prozess hält das alte dwds.

## Lösung 2: VS Code wieder auf "Debug my code" umstellen

Wenn Sie noch nicht aktualisieren können (ein festgeschriebenes CI-Image, ein Plugin, das neuere Dart-Versionen nicht unterstützt), verbergen Sie das Symptom. Klicken Sie während einer laufenden Debug-Sitzung auf das Debugmodus-Element links in der Statusleiste und wählen Sie "Debug my code". Oder legen Sie es für den Workspace fest:

```jsonc
// .vscode/settings.json -- Flutter 3.35.x workaround, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": false,
  "dart.debugSdkLibraries": false
}
```

Das ist der Workaround, den Danny im Issue empfohlen hat. Das Isolate pausiert während des Reloads weiterhin kurz, aber da jeder Frame in `package:flutter` oder `dart:*` liegt, behandelt VS Code sie alle als externen Code und reißt den Fokus nicht an sich. Wenn Sie wirklich in ein Paket hineinsteppen müssen, schalten Sie für diese Sitzung auf "+ packages" um und nehmen die Sprünge in Kauf, bis Sie zurückschalten.

In Android Studio oder IntelliJ hilft das nicht, da es dort für diesen Fall keinen entsprechenden Schalter gibt. Verwenden Sie dort Lösung 3.

## Lösung 3: Stateful Web Hot Reload unter 3.35 abschalten

Die grobe Variante ist die Rückkehr zum Web-Modulformat von vor 3.35, das den Ablauf aus Pausieren und Neuregistrieren überhaupt nicht durchführt:

```bash
# Flutter 3.35.x, terminal
flutter run -d chrome --no-web-experimental-hot-reload
```

Für VS Code tragen Sie es in `launch.json` ein, damit es nur für dieses Projekt gilt:

```jsonc
// .vscode/launch.json -- Flutter 3.35.x, Dart-Code extension
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "web (no stateful reload)",
      "type": "dart",
      "request": "launch",
      "program": "lib/main.dart",
      "deviceId": "chrome",
      "toolArgs": ["--no-web-experimental-hot-reload"]
    }
  ]
}
```

Die Benutzereinstellung `dart.flutterRunAdditionalArgs` funktioniert ebenfalls, gilt aber für jedes Projekt auf dem Rechner, und so vergisst man ein Jahr später, dass sie überhaupt gesetzt ist. Öffnen Sie in Android Studio Run > Edit Configurations, wählen Sie die Flutter-Konfiguration aus und tragen Sie `--no-web-experimental-hot-reload` unter "Additional run args" ein.

Der Preis ist real: Ohne das neue Modulformat fällt das Web-Target auf das ältere Verhalten zurück, bei dem ein Reload die App neu startet und Sie bei jedem Speichern den Zustand verlieren. Betrachten Sie das als Überbrückung, bis Sie aktualisieren können, und entfernen Sie es danach. In Flutter 3.47.5 steht im Hilfetext des Flags bereits "(deprecated; will be removed in a future release)", ein zurückgebliebener `toolArgs`-Eintrag wird Ihre Startkonfiguration also irgendwann kaputtmachen.

## Stolperfallen und ähnliche Fehlerbilder

**Sie verwenden 3.38 oder neuer, und es passiert trotzdem.** Sehen Sie sich zuallererst die Kopfzeile des Panels CALL STACK an. Steht dort "Paused on exception", ist das nicht der dwds-Bug, sondern eine echte Exception, und im Panel Breakpoints ist "Uncaught Exceptions" oder "All Exceptions" angehakt. Mit "All Exceptions" hält der Debugger auch bei Exceptions an, die Framework- oder Paketcode selbst wirft und abfängt. Entfernen Sie den Haken, laden Sie neu und prüfen Sie, ob die Pause verschwindet. Steht dort "Paused on breakpoint", öffnen Sie das Panel Breakpoints: VS Code speichert Haltepunkte pro Workspace, einschließlich solcher, die Sie vor Monaten beim Durchsteppen des Frameworks in `binding.dart` gesetzt haben. Entfernen Sie ihn.

**Es passiert auf Android, iOS oder Desktop.** Die falsche Pause gab es nur im Web, weil sie in dwds steckte, das nur für Web-Targets läuft. Der native VM-Service pausiert das Isolate beim Reload nicht, um Haltepunkte neu zu registrieren. Auf einem Mobile- oder Desktop-Target ist ein Halt in `binding.dart` eine Exception oder ein verirrter Haltepunkt, nutzen Sie also die obigen Prüfungen.

**Hot Reload bringt die Debug-Sitzung zum Absturz, statt zu pausieren.** Flutter 3.35.2 hatte einen separaten Web-Bug, bei dem Hot Reload aus `dwds/src/injected/client.js` eine Exception warf und die Sitzung beendete ([flutter/flutter#174932](https://github.com/flutter/flutter/issues/174932)). Anderer Bug, gleiches Heilmittel: aktualisieren.

**Die Seite zeigt nach einem Reload alten Code.** Wenn der Reload "funktioniert", der Browser aber einen veralteten Build ausführt, haben Sie es mit Caching zu tun, nicht mit dem Debugger. Siehe [warum Flutter Web nach einem Reload einen veralteten, zwischengespeicherten Build ausliefert](/de/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/).

**Hot Reload hängt, wenn ein Haltepunkt gesetzt ist.** Wenn Sie einen Haltepunkt in einer `State.reassemble`-Überschreibung (oder in Code, den sie aufruft) gesetzt haben, hält der Service-Aufruf `ext.flutter.reassemble` bei jedem Reload dort an, und das Tool kann beim Warten darauf in ein Timeout laufen ([flutter/flutter#23285](https://github.com/flutter/flutter/issues/23285)). Das ist ein echter Haltepunkt, der seine Arbeit tut, nicht der dwds-Bug: Setzen Sie die Ausführung fort oder verschieben Sie ihn.

## Verwandte Artikel

- Wenn Sie profilieren statt debuggen, behandelt [wie Sie Ruckler in einer Flutter-App mit DevTools profilieren](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) die Performance-Ansicht, die diese `Flutter.Frame`-Ereignisse verarbeitet.
- [Warum `appFlavor` nach einem Hot Restart mit `flutter attach` null wird](/de/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/) ist ein weiterer Fall, in dem sich der Reload-Pfad anders verhält als ein normaler Start.
- Der [MCP-Server für Dart und Flutter](/de/2026/05/dart-flutter-mcp-server-claude-code-cursor/) spricht mit demselben VM-Service und DTD, die dwds im Web vorschaltet.
- Wählen Sie gleichzeitig mit dem Upgrade einen Web-Renderer? [CanvasKit vs. skwasm für Flutter Web im Jahr 2026](/de/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/) erläutert die Abwägungen.

## Quellen

- [dart-lang/sdk#61560: Hot Reload opens `binding.dart` at line 845 on every reload (no errors shown)](https://github.com/dart-lang/sdk/issues/61560)
- [flutter/flutter#176693: [Web] Hot Reload jumping on binding.dart file even if "uncaught exceptions" are turned off](https://github.com/flutter/flutter/issues/176693)
- [flutter/flutter#174951: Error when hot reload since latest versions](https://github.com/flutter/flutter/issues/174951)
- [dart-lang/webdev#2695: Don't send PauseInterrupted event during a hot reload](https://github.com/dart-lang/webdev/pull/2695)
- [dwds-Changelog auf pub.dev](https://pub.dev/packages/dwds/changelog)
- [API-Dokumentation zu BindingBase.reassembleApplication](https://api.flutter.dev/flutter/foundation/BindingBase/reassembleApplication.html)
- [Flutter-Dokumentation: Hot reload](https://docs.flutter.dev/tools/hot-reload)
- [Neuerungen in Flutter 3.38](https://blog.flutter.dev/whats-new-in-flutter-3-38-3f7b258f7228)
