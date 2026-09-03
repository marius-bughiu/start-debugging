---
title: "Eine Flutter-Web-App von dart:html auf package:web und dart:js_interop migrieren"
description: "Eine schrittweise Migration weg von den veralteten dart:html, dart:js_util und package:js hin zu package:web 1.1.1 und dart:js_interop: wie Sie jeden problematischen Import mit dem dart2wasm-Compiler finden, was dart fix umbenennt und was nicht, die Fallstricke von JSImmutableListWrapper und innerHTML, und wie Sie mit flutter build web --wasm verifizieren."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "flutter-web"
  - "interop"
  - "webassembly"
lang: "de"
translationOf: "2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web"
translatedBy: "claude"
translationDate: 2026-09-03
---

Eine Flutter-Web-Codebasis mit einer Handvoll `dart:html`-Aufrufe ist eine Migration von einem halben Tag. Eine Codebasis, in der `dart:html` in gemeinsame Pakete, Mocks oder ein selbst gepflegtes Plugin gesickert ist, dauert eine Woche, und der Engpass ist fast nie der eigene Code: es ist die transitive Abhängigkeit, die die alte Bibliothek noch importiert. Optional ist davon nichts mehr. `dart:html`, `dart:js`, `dart:js_util` und `package:js` wurden in Dart 3.7 (Februar 2025) als veraltet markiert, keines davon kompiliert unter `dart2wasm`, und das Ersatzpaar, [`package:web`](https://pub.dev/packages/web) 1.1.1 zusammen mit `dart:js_interop`, ist seit Juli 2024 stabil. Dieser Leitfaden zielt auf den aktuellen Stable-Kanal, Flutter 3.47.2 mit Dart 3.13.2 (veröffentlicht am 2026-08-27), und auf `package:web` 1.1.1, das Dart `^3.4.0` voraussetzt. Jede Compiler-Ausgabe unten stammt aus einem echten Lauf mit der Stable-Toolchain Flutter 3.44.8 / Dart 3.12.2 und demselben `package:web` 1.1.1.

## Warum sich das nicht länger aufschieben lässt

- **WebAssembly hängt daran.** `dart2wasm` weigert sich, ein Programm zu kompilieren, das transitiv `dart:html` erreicht. Wer den Nutzen will, der in [Flutter-Web-Apps mit `flutter build web --wasm` bauen](/de/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) beschrieben ist, zahlt diese Migration als Eintrittspreis, nicht als Optimierung.
- **Die Veraltung wirkt bereits.** `dart analyze` meldet `deprecated_member_use` in der Import-Zeile selbst, also schlägt jeder CI-Job mit `--fatal-infos` bereits fehl oder ist eine Konfigurationsänderung davon entfernt.
- **`package:web` wird unabhängig vom SDK versioniert.** Neue Browser-APIs kommen als Paketversion, statt auf ein SDK-Release zu warten, und `package:web` wird direkt aus dem Web IDL generiert, sodass die Namen zu MDN passen statt zu einem Dart-Styleguide von 2013.
- **Wer ein Paket veröffentlicht, blockiert seine Nutzer bis zur Migration.** Ein einziger `dart:html`-Import in einem Blattpaket blockiert den gesamten Abhängigkeitsgraph darunter.

## Was bricht

| Bereich | Änderung | Schweregrad |
| ------- | -------- | ----------- |
| Typnamen | Dart-Stilnamen kehren zu IDL-Namen zurück: aus `HtmlElement` wird `HTMLElement`, aus `InputElement` wird `HTMLInputElement`, aus `AnchorElement` wird `HTMLAnchorElement` | hoch, aber weitgehend automatisierbar |
| Collections | `querySelectorAll` und `children` liefern `NodeList` / `HTMLCollection`, die kein `List` implementieren | hoch |
| Typprüfungen | `is` und `as` funktionieren auf Browsertypen nicht mehr, weil jeder `package:web`-Typ zu `JSObject` gelöscht wird | hoch |
| Mocking | Extension Types haben keinen virtuellen Dispatch, daher kann ein Mock, der eine `dart:html`-Klasse `implements`, keinen `package:web`-Typ implementieren | hoch |
| Typsignaturen | `innerHTML` ist `JSAny`, Event-Listener nehmen `JSFunction`, daher brauchen die Aufrufstellen `.toJS` | mittel |
| Zonen | Callbacks werden nicht mehr automatisch an die aktuelle Zone gebunden | mittel |
| Bedingte Imports | `dart.library.html` muss zu `dart.library.js_interop` werden | mittel |
| Platform Views | View-Factories müssen ein `package:web`-Element liefern und sich über `dart:ui_web` registrieren | mittel |
| `dart:js_util` | `getProperty` / `setProperty` / `callMethod` wandern nach `dart:js_interop_unsafe` mit `JSAny`-Schlüsseln | gering, mechanisch |

## Checkliste vor dem Start

- Flutter 3.47.2 oder neuer im Stable-Kanal. Alles ab Flutter 3.22 (Dart 3.4) funktioniert, aber die unten beschriebenen Analyzer-Fixes sind in neueren SDKs besser.
- `flutter pub add web`, was zu `web: ^1.1.1` auflöst.
- Ein CI-Job, der `flutter build web --wasm` ausführt, auch wenn Sie den Wasm-Build noch nicht ausliefern. Er ist der einzige zuverlässige Detektor für alte Imports, die in Abhängigkeiten stecken.
- Ein Branch, keine Reihe kleiner Commits auf `main`. Der Umbenennungsdurchlauf berührt viele Dateien auf einmal und lässt sich in Scheiben schlecht reviewen.
- Eine Inventarliste der Pakete, von denen Sie abhängen und die zuletzt vor Mitte 2024 veröffentlicht wurden. Das sind die wahrscheinlichen Blocker.

## Migrationsschritte

1. **Finden Sie jeden problematischen Import mit dem Compiler, nicht mit grep.** `grep -r "dart:html" lib/` findet Ihren Code und übersieht die Abhängigkeit drei Ebenen tiefer, die Sie tatsächlich blockiert. `dart2wasm` gibt stattdessen die vollständige Importkette aus. Führen Sie `flutter build web --wasm` aus und lesen Sie den ersten Fehler:

   ```text
   Target dart2wasm failed: ProcessException: Process exited abnormally with exit code 254:
   lib/legacy_bit.dart:1:8: Error: Dart library 'dart:html' is not available on this platform.
   import 'dart:html' as html;
          ^
   Context: The unavailable library 'dart:html' is imported through these packages:

       main.dart => package:fweb => dart:html

   Detailed import paths for (some of) the these imports:

       main.dart => package:fweb/main.dart => package:fweb/legacy_bit.dart => dart:html
   ```

   Der Block "Detailed import paths" ist der nützliche Teil. Endet die Kette in einem Pub-Paket statt in Ihrem eigenen `lib/`, haben Sie eine Abhängigkeit gefunden, die aktualisiert, geforkt oder ersetzt werden muss, bevor Ihre App umziehen kann.

   Verifizierung: Jeder vom Compiler ausgegebene Pfad ist notiert und als "eigener Code", "eigenes Paket" oder "Drittanbieter" eingeordnet. Nichts bleibt als "wird schon passen" stehen.

2. **Tauschen Sie den Import und fügen Sie die Abhängigkeit hinzu.** Pro Datei wird aus `import 'dart:html' as html;` ein `import 'package:web/web.dart' as web;`. Behalten Sie das Präfix. Ein Import von `package:web` ohne Präfix bringt mehrere hundert Top-Level-Namen in den Geltungsbereich und kollidiert mit Flutters eigenen `Element`, `Image` und `Text`.

   ```console
   flutter pub add web
   ```

   Verifizierung: `flutter pub deps | grep web` zeigt `web 1.1.1`, und die Fehler der Datei wechseln von "deprecated" zu einer Liste undefinierter Namen. Undefinierte Namen sind Fortschritt, sie sind die sichtbar gewordene Umbenennungsarbeit.

3. **Führen Sie `dart fix` für die Typumbenennungen aus und erledigen Sie den Rest von Hand.** `package:web` liefert eine `lib/fix_data.yaml` mit 141 Umbenennungstransformationen aus, sodass der Analyzer die meisten alten Typnamen umschreiben kann, sobald der neue Import steht:

   ```console
   dart fix --dry-run
   dart fix --apply
   ```

   In einer Datei mit `InputElement`, `HtmlElement` und `CheckboxInputElement` schreibt `dart fix --apply` die ersten beiden um und lässt das dritte unangetastet:

   ```dart
   // After dart fix --apply, package:web 1.1.1
   final HTMLInputElement input = HTMLInputElement();
   final HTMLElement box = document.querySelector('#box') as HTMLElement;
   final CheckboxInputElement cb = CheckboxInputElement(); // still undefined
   ```

   `CheckboxInputElement` ist keine Umbenennung, sondern ein Komforttyp aus `dart:html` ohne IDL-Gegenstück. Die manuelle Form lautet `HTMLInputElement()..type = 'checkbox'`. Fehlt für einen Namen die Transformation, schlagen Sie die `@Native`-Annotation an der alten `dart:html`-Klasse nach: ihr Wert ist der Name in `package:web`.

   Verifizierung: `dart analyze` meldet null `undefined_class`- und `undefined_function`-Diagnosen in den migrierten Dateien.

4. **Ersetzen Sie `dart:js_util` und `package:js` durch `dart:js_interop`.** Die alten dynamischen Zugriffe wandern nach `dart:js_interop_unsafe` und nehmen `JSAny`-Schlüssel statt `String`. Deklarierte Interop-Typen wechseln von `@JS()`-Klassen zu Extension Types über `JSObject`. Vorher:

   ```dart
   // dart:html + dart:js_util, Dart 3.12.2
   import 'dart:convert';
   import 'dart:html';
   import 'dart:js_util' as js_util;

   void downloadCsv(String csv) {
     final blob = Blob([csv], 'text/csv');
     final url = Url.createObjectUrlFromBlob(blob);
     AnchorElement(href: url)
       ..download = 'report.csv'
       ..click();
     Url.revokeObjectUrl(url);
   }

   Future<Map<String, dynamic>> loadJson(String path) async {
     final text = await HttpRequest.getString(path);
     return jsonDecode(text) as Map<String, dynamic>;
   }

   void unsafeAccess() {
     final maybe = js_util.getProperty(window, 'myLegacyGlobal');
     if (maybe != null) {
       js_util.callMethod(maybe, 'init', ['flutter']);
     }
   }
   ```

   Nachher:

   ```dart
   // package:web 1.1.1 + dart:js_interop, Dart 3.12.2
   import 'dart:convert';
   import 'dart:js_interop';
   import 'dart:js_interop_unsafe';
   import 'package:web/web.dart';

   void downloadCsv(String csv) {
     final blob = Blob([csv.toJS].toJS, BlobPropertyBag(type: 'text/csv'));
     final url = URL.createObjectURL(blob);
     final anchor = document.createElement('a') as HTMLAnchorElement
       ..href = url
       ..download = 'report.csv';
     anchor.click();
     URL.revokeObjectURL(url);
   }

   Future<Map<String, dynamic>> loadJson(String path) async {
     final response = await window.fetch(path.toJS).toDart;
     final text = await response.text().toDart;
     return jsonDecode(text.toDart) as Map<String, dynamic>;
   }

   void unsafeAccess() {
     final maybe = globalContext.getProperty<JSObject?>('myLegacyGlobal'.toJS);
     if (maybe != null) {
       maybe.callMethod<JSAny?>('init'.toJS, 'flutter'.toJS);
     }
   }
   ```

   Drei Muster sollten sitzen: aus `allowInterop(fn)` wird `fn.toJS`, aus `js_util.promiseToFuture(p)` wird `p.toDart`, und ein mit `.toDart` erwartetes `JSPromise<T>` liefert ein `Future<T>`. Für `HttpRequest` gibt es keinen direkten Ersatz, der sich lohnt; die Antwort heißt `window.fetch` oder `package:http`.

   Verifizierung: `dart analyze` ist sauber, und keine Datei im Repository importiert noch `dart:js`, `dart:js_util` oder `package:js`.

5. **Verschieben Sie Platform-View-Factories nach `dart:ui_web`.** Jeder Code, der eine HTML-View registriert, muss jetzt ein `package:web`-Element liefern. Die Registry liegt in `dart:ui_web`, und `registerViewFactory` ist deklariert als `registerViewFactory(String viewType, Function viewFactory, {bool isVisible = true})`:

   ```dart
   // Flutter 3.44.8, package:web 1.1.1
   import 'dart:ui_web' as ui_web;

   import 'package:flutter/widgets.dart';
   import 'package:web/web.dart' as web;

   const _viewType = 'startdebugging-iframe';

   void registerIframeFactory() {
     ui_web.platformViewRegistry.registerViewFactory(_viewType, (int viewId) {
       final iframe = web.document.createElement('iframe') as web.HTMLIFrameElement
         ..src = 'https://startdebugging.net/'
         ..style.border = 'none'
         ..style.width = '100%'
         ..style.height = '100%';
       return iframe;
     });
   }

   class EmbeddedSite extends StatelessWidget {
     const EmbeddedSite({super.key});

     @override
     Widget build(BuildContext context) =>
         const HtmlElementView(viewType: _viewType);
   }
   ```

   Verifizierung: Die View rendert unter `flutter run -d chrome`, und `flutter build web --wasm` kompiliert die Datei ohne Beanstandung.

6. **Schreiben Sie bedingte Imports auf `dart.library.js_interop` um.** Die alte Schreibweise wählt unter `dart2wasm` stillschweigend die Stub-Implementierung, weil `dart.library.html` dort falsch ist, was zur Laufzeit einen `UnsupportedError` statt eines Compile-Fehlers erzeugt. Das ist der schlimmste Fehlermodus dieser gesamten Migration:

   ```dart
   // lib/platform_open.dart, Dart 3.12.2
   export 'src/open_stub.dart'
       if (dart.library.io) 'src/open_io.dart'
       if (dart.library.js_interop) 'src/open_web.dart';
   ```

   ```dart
   // lib/src/open_web.dart
   import 'package:web/web.dart' as web;

   void openUrl(String url) => web.window.open(url, '_blank');
   ```

   Verifizierung: Greppen Sie das Repository nach `dart.library.html` und bestätigen Sie null Treffer, dann starten Sie die App auf einem nativen Ziel und im Web, um zu belegen, dass jeder Zweig weiterhin auflöst. Dieselbe Technik gilt für das größere Thema [plattformspezifischer Code ohne Plugin](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

7. **Reparieren Sie die Tests zuletzt, denn Mocks brechen anders.** `package:web`-Typen sind Extension Types über `JSObject`, daher kompiliert ein Fake, der `implements HTMLElement` schreibt, nicht. Ersetzen Sie klassenbasierte Fakes durch echte DOM-Knoten, die im Test erzeugt werden, oder durch ein JS-Objekt, das Sie bauen und dem getesteten Code übergeben. Alles, was zu `dynamic` gegriffen hat, um ein DOM-Member aufzurufen, funktioniert ebenfalls nicht mehr, weil Extension-Type-Member nur statisch aufgelöst werden.

   Verifizierung: `flutter test` läuft durch, und in der Suite steht keine `implements`-Klausel mehr, die auf einen `package:web`-Typ zeigt.

## Verifizierung

Führen Sie alle vier aus, in dieser Reihenfolge:

```console
dart analyze --fatal-infos
flutter test
flutter build web
flutter build web --wasm
```

Der letzte Befehl ist das eigentliche Tor. In einer migrierten App endet er mit `Built build/web` und legt `main.dart.wasm`, `main.dart.mjs` und den `dart2js`-Fallback `main.dart.js` in `build/web` ab. Schlägt er weiterhin fehl, nennt der Fehler genau die verbliebene Importkette. Danach laden Sie die App und klicken alles durch, was das DOM berührt: Dateidownloads, Zwischenablage, Iframes, `localStorage` und jedes JS-SDK, mit dem Sie per Interop sprechen.

## Rollback-Plan

Ein Rollback pro Datei ist einfach, ein Rollback des gesamten Repositorys lohnt die Planung nicht. `package:web` und `dart:html` können im selben Programm koexistieren, Sie können also eine Datei migrieren, ausliefern und genau diese Datei zurücknehmen, wenn etwas bricht. Nicht möglich ist ein Rollback, nachdem Sie die `dart:html`-Codepfade gelöscht und einen Wasm-Build ausgeliefert haben, denn der Wasm-Build hat sie nie unterstützt. Behalten Sie den `dart2js`-Build als Produktionsziel, bis der oben beschriebene Klickdurchlauf erledigt ist; `flutter build web --wasm` erzeugt beide, und der Loader fällt von selbst zurück.

## Fallstricke, die Sie vorher kennen sollten

**Das offizielle `JSImmutableListWrapper`-Beispiel kompiliert nicht.** `JSImmutableListWrapper<T, U>` kann `U` nicht aus dem Konstruktorargument ableiten und fällt daher auf die Schranke `JSObject` zurück:

```dart
for (final a in JSImmutableListWrapper(document.querySelectorAll('a'))) {
  a.classList.add('link'); // error: The getter 'classList' isn't defined for the type 'JSObject'
}
```

Geben Sie beide Typargumente explizit an:

```dart
// package:web 1.1.1
for (final a in JSImmutableListWrapper<NodeList, Element>(
  document.querySelectorAll('a'),
)) {
  a.classList.add('link');
}
```

**`innerHTML` ist `JSAny`, in beide Richtungen.** Schreiben braucht `.toJS`, Lesen braucht einen Cast: `final String s = el.innerHTML;` scheitert mit "A value of type 'JSAny' can't be assigned to a variable of type 'String'". Lesen Sie es als `(el.innerHTML as JSString).toDart`. Dasselbe gilt für `outerHTML` und für `insertAdjacentHTML`, dessen zweiter Parameter `JSAny` ist.

**`element.text` ist ein Setter ohne Getter.** `package:web` behält einen veralteten `text`-Setter zur Migrationserleichterung, aber Lesen erfordert `textContent`, das `String?` statt `String` ist. Code, der `if (el.text.isEmpty)` schrieb, braucht jetzt eine Null-Prüfung.

**Callbacks verlieren ihre Zone.** `dart:html` band Event-Callbacks automatisch an die aktuelle Zone; `package:web` tut das nicht. Wer auf zonenlokale Werte oder auf einen zonenbasierten Fehlerhandler baut, der Vorgänge innerhalb eines Listeners abfängt, bindet vor der Konvertierung manuell:

```dart
element.addEventListener(
  'click',
  Zone.current.bindUnaryCallback((Event event) {
    // zone-local values are preserved here
  }).toJS,
);
```

**Typprüfungen ändern still ihre Bedeutung.** `obj is Window` kompilierte unter `dart:html` problemlos; unter `package:web` wird jeder Typ zu `JSObject` gelöscht, die Prüfung ist also bedeutungslos. Verwenden Sie `element.isA<HTMLInputElement>()` (ab Dart 3.4) oder `obj.instanceOfString('Window')`.

**Manche `dart:html`-Gewohnheiten überleben als veraltete Shims.** `window.localStorage['k'] = 'v'` besteht die Analyse weiterhin, mit "'[]=' is deprecated and shouldn't be used. Use Storage.setItem instead", und ein Top-Level-`querySelector` existiert mit "Directly use document.querySelector instead". Sie kompilieren heute, sie sind kein Ziel. Wandeln Sie sie im selben Durchlauf um, sonst machen Sie diese Arbeit zweimal.

**Event-Streams gibt es weiterhin, und sie sind der ergonomische Weg.** `package:web` bringt Stream-Helper mit, `input.onClick.listen(...)` funktioniert also unverändert und liefert `ElementStream<MouseEvent>`. Bevorzugen Sie sie gegenüber rohem `addEventListener` plus `.toJS` für alles, was Sie abbrechen müssen. Beachten Sie, dass die Helper-Streams manche Events asynchron zustellen, wo `dart:html` synchron war; zeitkritischer Code braucht daher einen zweiten Blick.

## Verwandte Beiträge

- Der Nutzen dieser Arbeit ist vollständig beschrieben in [Flutter-Web-Apps mit WebAssembly bauen](/de/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), inklusive der Frage, warum Firefox und Safari weiterhin den JavaScript-Build bekommen.
- Strukturell ist das derselbe breite, mechanische Durchlauf wie [eine Flutter-2-App auf Flutter 3.x migrieren](/de/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/): ein Plan mit zwei Sprüngen und ein Compiler, der meldet, wann Sie fertig sind.
- Der Mechanismus der bedingten Imports aus Schritt 6 steckt auch hinter [plattformspezifischem Code ohne Plugin](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).
- Wer gleichzeitig Flutter aktualisiert, liest [was Flutter 3.47 am Desktop-Rendering geändert hat](/de/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/), bevor er eine visuelle Regression dieser Migration anlastet.
- Das Web ist außerdem der Ort, an dem sich [Dart-Isolates](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) anders verhalten als auf jeder anderen Plattform, was man wissen sollte, bevor man im selben Durchlauf CPU-lastige Arbeit verschiebt.

## Quellen

- [Migrate to package:web](https://dart.dev/interop/js-interop/package-web), dart.dev
- [Past JS interop](https://dart.dev/interop/js-interop/past-js-interop), dart.dev
- [JS types and conversions](https://dart.dev/interop/js-interop/js-types), dart.dev
- [Breaking changes and deprecations](https://dart.dev/resources/breaking-changes), dart.dev
- [package:web auf pub.dev](https://pub.dev/packages/web), Version 1.1.1
- [API-Referenz zu EventStreamProviders](https://pub.dev/documentation/web/latest/web/EventStreamProviders-class.html), package:web
- [dart:ui_web PlatformViewRegistry](https://api.flutter.dev/flutter/dart-ui_web/PlatformViewRegistry-class.html), Flutter-API-Dokumentation
- [Announcing Dart 3.13](https://dart.dev/blog/announcing-dart-3-13), der Dart-Blog
