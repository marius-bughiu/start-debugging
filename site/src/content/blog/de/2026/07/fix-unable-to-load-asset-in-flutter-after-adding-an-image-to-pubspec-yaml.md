---
title: "Fix: Unable to load asset in Flutter nach dem Hinzufügen eines Bildes zu pubspec.yaml"
description: "Der Asset-Key fehlt im kompilierten Bundle, nicht auf der Festplatte. Einrückung im pubspec korrigieren, Schrägstrich ergänzen, Key exakt treffen, dann neu starten."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pubspec"
  - "assets"
lang: "de"
translationOf: "2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml"
translatedBy: "claude"
translationDate: 2026-07-31
---

Die Datei liegt auf der Festplatte, der Pfad sieht richtig aus, und Flutter meldet trotzdem, dass es sie nicht laden kann. Die Meldung bezieht sich nämlich nicht auf die Festplatte: Der übergebene Key steht nicht im kompilierten Asset-Bundle. Nach Häufigkeit sortiert sind die Ursachen ein `assets:`-Block, der nicht unter `flutter:` eingerückt ist, ein Verzeichniseintrag ohne abschließenden `/`, eine Datei in einem nie deklarierten Unterverzeichnis, ein Key mit abweichender Groß- und Kleinschreibung oder ein Hot Reload, wo ein vollständiger Neustart nötig war. Korrigieren Sie `pubspec.yaml`, beenden Sie die App und starten Sie sie erneut.

```text
======== Exception caught by image resource service ================================================
The following assertion was thrown resolving an image codec:
Unable to load asset: "assets/images/logo.png".
The asset does not exist or has empty data.

When the exception was thrown, this was the stack:
#0      PlatformAssetBundle.load (package:flutter/src/services/asset_bundle.dart:271:7)
<asynchronous suspension>
#1      AssetBundleImageProvider._loadAsync (package:flutter/src/painting/image_provider.dart:951:14)
```

Diese Anleitung bezieht sich auf Flutter 3.44.7 und Dart 3.12.2, den Stable-Kanal mit Stand 2026-07-20. Das beschriebene Verhalten ist stabil, seit Flutter 3.16 das Format des Asset-Manifests geändert hat, und die pubspec-Regeln haben sich seit Jahren nicht geändert.

## Was der Fehler tatsächlich bedeutet

`Image.asset('assets/images/logo.png')` öffnet keine Datei. Der Aufruf übergibt einen String-Key an das Framework, das die Engine nach den Bytes fragt, die unter diesem Key im Asset-Bundle der App registriert sind. `PlatformAssetBundle.load` wirft die Exception in dem Moment, in dem die Engine null oder einen leeren Puffer zurückgibt:

```dart
// flutter/lib/src/services/asset_bundle.dart, Flutter 3.44.7
throw FlutterError.fromParts(<DiagnosticsNode>[
  _errorSummaryWithKey(key),
  ErrorDescription('The asset does not exist or has empty data.'),
]);
```

Dieses Bundle wird einmalig vom `flutter`-Werkzeug aus dem Abschnitt `flutter: assets:` in `pubspec.yaml` erzeugt. Alles, was dort aufgeführt ist, landet in `build/flutter_assets/` und wird in einem Manifest namens `AssetManifest.bin` indexiert, das die Engine beim Start lädt. Alles andere im Dateisystem existiert für die laufende App nicht.

Zwei voneinander unabhängige Dinge müssen also zusammenpassen, und der Fehler kann nicht sagen, welches davon falsch ist:

1. Die pubspec-Deklaration muss die Datei in das Bundle bringen.
2. Der Key im Dart-Code muss byteweise dem Bundle-Key entsprechen.

Jede Ursache unten ist einer dieser beiden Punkte.

## Das minimale Reproduktionsbeispiel

```
my_app/
  pubspec.yaml
  assets/
    images/
      logo.png
  lib/
    main.dart
```

```yaml
# pubspec.yaml, Flutter 3.44.7
name: my_app

flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

```dart
// lib/main.dart, Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: Image.asset('assets/images/logo.png')),
        ),
      ),
    );
```

Das funktioniert. Beschädigen Sie eine einzelne Zeile davon auf eine der unten beschriebenen Arten, und Sie erhalten den Fehler ohne jede weitere Diagnose.

## Ursache 1: Der assets-Block ist nicht unter flutter verschachtelt

Das ist der häufigste Fehler und der frustrierendste, weil sich nichts beschwert. `flutter pub get` läuft durch, der Build läuft durch, und die App startet mit einem leeren Bundle.

```yaml
# Wrong. Valid YAML, silently ignored.
flutter:
  uses-material-design: true
assets:
  - assets/images/logo.png
```

`assets:` auf oberster Ebene ist ein Schlüssel, den das Flutter-Werkzeug nicht liest. Das ist kein Fehler, sondern aus Sicht des Parsers schlicht fremde Konfiguration. Die korrekte Form rückt `assets:` exakt zwei Leerzeichen unter `flutter:` ein, die Listeneinträge zwei weitere Leerzeichen:

```yaml
# Right.
flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

Eine verwandte Variante: ein zweiter `flutter:`-Schlüssel weiter unten in der Datei. YAML-Mappings dürfen keine doppelten Schlüssel haben, und je nach Parser gewinnt einer davon stillschweigend. Wenn Ihre pubspec-Datei organisch gewachsen ist, suchen Sie darin nach jedem Vorkommen von `flutter:` in Spalte null, bevor Sie irgendetwas anderes untersuchen.

## Ursache 2: Ein Verzeichniseintrag ohne abschließenden Schrägstrich oder ein nie deklariertes Unterverzeichnis

Verzeichniseinträge gelten pro Verzeichnis und wirken nicht rekursiv. Aus der Flutter-Dokumentation zum Hinzufügen von Assets: "Only files located directly in the directory are included. Resolution-aware asset image variants are the only exception. To add files located in subdirectories, create an entry per directory."

Das hier deklariert also nichts Brauchbares, wenn Ihre Bilder in `assets/images/icons/` liegen:

```yaml
flutter:
  assets:
    - assets/images/
```

und das hier brauchen Sie:

```yaml
flutter:
  assets:
    - assets/images/
    - assets/images/icons/
    - assets/images/illustrations/
```

Der abschließende Schrägstrich macht den Eintrag zu einem Verzeichnis. `- assets/images` ohne ihn wird als einzelne Datei namens `images` gelesen, und weil es diese Datei nicht gibt, scheitert der Build bereits auf Werkzeugebene mit einer Meldung, die tatsächlich hilft:

```text
Error: unable to find directory entry in pubspec.yaml: /path/to/my_app/assets/images/
```

Das ist auch umgekehrt aufschlussreich: Wenn der Build erfolgreich war und Sie zur Laufzeit trotzdem `Unable to load asset` sehen, hat der Eintrag etwas gefunden. Das Problem ist dann ein nicht passender Key, keine fehlende Deklaration.

Die einzige Ausnahme von der Nicht-Rekursivität sind auflösungsabhängige Varianten. Wenn Sie `assets/images/logo.png` deklarieren, werden `assets/images/2.0x/logo.png` und `assets/images/3.0x/logo.png` automatisch mitgebündelt, und `AssetImage` wählt die passende für das Device Pixel Ratio. Die Variantenverzeichnisse deklarieren Sie nie selbst.

## Ursache 3: Der Key im Code entspricht nicht dem Key im Bundle

Bundle-Keys sind exakte Strings. Drei Wege, auf denen sie von Ihrer Eingabe abweichen:

**Groß- und Kleinschreibung.** Ihr Entwicklungsrechner hat mit hoher Wahrscheinlichkeit ein Dateisystem, das Groß- und Kleinschreibung ignoriert (APFS unter macOS standardmäßig, NTFS unter Windows). `Image.asset('assets/images/Logo.png')` findet lokal eine Datei namens `logo.png` und scheitert auf einem Android-Gerät, unter iOS, im Web und auf jedem Linux-CI-Runner. Wenn ein Build auf dem Laptop funktioniert und überall sonst scheitert, prüfen Sie zuerst das. Das ist die wahrscheinlichste Erklärung dafür, dass identischer Code je nach Rechner unterschiedlich läuft.

**Ein führendes `./` oder ein versehentliches Leerzeichen.** `'./assets/images/logo.png'` ist ein anderer String als `'assets/images/logo.png'`, und das Bundle enthält nur den zweiten. Abschließender Leerraum in einem in Anführungszeichen gesetzten YAML-Wert hat denselben Effekt.

**Das Präfix `packages/`.** Ein Asset aus einem Paket, von dem Sie abhängen, hat den Key `packages/<package_name>/<path>`, wobei das `lib/`-Verzeichnis des Pakets implizit ist und nie ausgeschrieben wird. Um `lib/assets/bg.png` aus einem Paket namens `fancy_backgrounds` zu laden:

```dart
// Flutter 3.44.7. Either form works; they produce the same key.
Image.asset('packages/fancy_backgrounds/assets/bg.png');
Image.asset('assets/bg.png', package: 'fancy_backgrounds');
```

Wenn Sie das Paket selbst geschrieben haben, muss es diese Dateien auch in seiner eigenen `pubspec.yaml` deklarieren. Assets einer Abhängigkeit landen nicht im Bundle, nur weil die Datei in `.pub-cache` existiert.

## Ursache 4: Hot Reload statt Neustart

Hot Reload tauscht Dart-Code in einem laufenden Isolate aus. Das Asset-Bundle und sein Manifest erzeugt das Werkzeug beim Start der App. Ein neuer Eintrag in `pubspec.yaml` ändert das Manifest, und eine laufende App behält das Manifest, mit dem sie gestartet ist.

Beenden Sie die Sitzung und starten Sie sie neu. Weder `r` noch `R`:

```bash
# Flutter 3.44.7
# Ctrl-C to end the current run, then:
flutter run
```

Ändern sich die *Bytes* eines bereits deklarierten Assets, wird es beim Reload neu gebündelt und braucht das nicht. Ändert sich die *Menge* der deklarierten Assets, schon.

## Ursache 5: Veraltete Artefakte auf der Festplatte

Selten die Ursache, billig auszuschließen und das Erste, was jede Antwort im Netz empfiehlt, weshalb es für weit mehr Fehler verantwortlich gemacht wird, als es verursacht. Unter iOS ist es eine reale Ursache, weil ein halb aktualisiertes `.app`-Bundle einen Rebuild überleben kann:

```bash
# Flutter 3.44.7
flutter clean
flutter pub get
flutter run
```

Wenn dabei `flutter pub get` selbst scheitert, ist das ein Problem der Abhängigkeitsauflösung und kein Asset-Problem, und die Ausgabe des Constraint-Solvers ist eine eigene Übung: siehe [einen version solving failed-Fehler in pubspec.yaml lesen](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Nicht raten: die tatsächlich im Bundle enthaltenen Keys ausgeben

Jeder Abschnitt oben ist eine Hypothese. Sie können sie alle durch eine einzige Messung ersetzen. `AssetManifest` ist die unterstützte API, um das Manifest zur Laufzeit zu lesen; sie kam hinzu, als `AssetManifest.json` durch `AssetManifest.bin` ersetzt wurde:

```dart
// Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/services.dart';

Future<void> dumpAssetKeys() async {
  final manifest = await AssetManifest.loadFromAssetBundle(rootBundle);
  for (final key in manifest.listAssets()..sort()) {
    debugPrint(key);
  }
}
```

Rufen Sie das aus `main` hinter einer `kDebugMode`-Prüfung auf und lesen Sie die Konsole. Was dort ausgegeben wird, kann die Engine ausliefern. Fehlt Ihr Pfad, ist es Ursache 1 oder 2. Steht dort etwas, das Ihrem Pfad fast entspricht, ist es Ursache 3, und der Unterschied zwischen den beiden Strings ist die Lösung.

Parsen Sie `AssetManifest.bin` nicht selbst. Flutter dokumentiert die Datei als Implementierungsdetail, dessen Format sich ohne Ankündigung ändern kann, und `AssetManifest.json` wird gar nicht mehr erzeugt. Code, der noch `rootBundle.loadString('AssetManifest.json')` aufruft, wirft daher genau diesen Fehler mit `AssetManifest.json` als Key.

Sie können das Bundle auch untersuchen, ohne etwas auszuführen:

```bash
# Flutter 3.44.7. Writes the bundle the engine would load.
flutter build bundle
ls build/flutter_assets/assets/images/

# Or check what shipped inside a built APK:
unzip -l build/app/outputs/flutter-apk/app-debug.apk | grep flutter_assets
```

## Varianten, die auf dieser Seite landen

- **`Unable to load asset: "fonts/Inter-Regular.ttf"`**. Schriften werden unter `flutter: fonts:` deklariert, nicht unter `assets:`, und der Familienname im `TextStyle` muss dem Wert von `family:` entsprechen, nicht dem Dateinamen. Fehlerbild und Lösungslogik sind identisch.
- **`Unable to load asset` aus `SvgPicture.asset`**. `flutter_svg` lädt über dasselbe `AssetBundle`, der Fehler stammt also vom Framework und nicht vom Paket. Alles oben Genannte gilt unverändert.
- **Das Asset existiert, aber "has empty data"**. Nehmen Sie diesen Satz wörtlich. Der übliche Verursacher ist Git LFS: Ein Repository, in dem Bilder per LFS verwaltet werden und das auf einem CI-Runner ohne `lfs: true` ausgecheckt wird, hinterlässt einen 130 Byte großen Text-Pointer anstelle des PNG. Der Build läuft durch, das Bundle enthält den Key, und das Dekodieren scheitert. Prüfen Sie die Dateigröße vor allem anderen. Eine `.gitignore`- oder `.dockerignore`-Regel, die `assets/` ausschließt, erzeugt dasselbe Muster aus lokalem Erfolg und CI-Fehler, was sich zu prüfen lohnt, wenn Sie [Builds für mehrere Flutter-Versionen in einer Pipeline ausführen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- **Nur im Flutter-Web kaputt, und nur nach dem Deployment**. Läuft die App unter einem Unterpfad, braucht `build/web/index.html` ein `<base href="/my-app/">` und der Build ein `flutter build web --base-href /my-app/`. Ohne das fragt die Engine `/assets/...` von der Domain-Wurzel an und bekommt einen 404, der sich als dieser Fehler zeigt. Dieselbe Falle gilt für einen [WebAssembly-Build mit `flutter build web --wasm`](/de/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/).
- **Nur in `flutter test` kaputt**. In `pubspec.yaml` deklarierte Assets funktionieren in Widget-Tests durchaus: Das Werkzeug erzeugt `build/unit_test_assets/`, exportiert den Pfad als `UNIT_TEST_ASSETS`, und `mockFlutterAssets()` liefert die Keys von dort aus. Zwei Dinge scheitern weiterhin. Assets, die je nach Flavor bedingt gebündelt werden, liegen nicht in diesem Verzeichnis, und ein Golden-Test, der `Image.asset` rendert, braucht einen abgeschlossenen Ladevorgang. Kapseln Sie den Pump daher in `tester.runAsync` oder rufen Sie vor dem Vergleich `precacheImage` auf.
- **Nur im Release kaputt, nicht im Debug**. Kein Asset-Problem. Prüfen Sie, ob der Codepfad, der den Key erzeugt, überhaupt erreicht wird und ob ein `const`-String aus etwas zusammengesetzt wird, das sich zwischen den Build-Modi unterscheidet.
- **Der Android-Build kam nie weit genug, um überhaupt etwas zu bündeln**. Tritt der Fehler zur Build-Zeit und nicht zur Laufzeit auf, handelt es sich um [eine Gradle-Task, die mit exit code 1 gescheitert ist](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/), und keine noch so gründliche pubspec-Änderung hilft.

Der rote Faden: Dieser Fehler ist ein fehlgeschlagener Lookup in einer Datenstruktur, die Ihr Build erzeugt hat. Behandeln Sie ihn so. Geben Sie `listAssets()` aus, vergleichen Sie den übergebenen String mit den vorhandenen Strings, und die Lösung liegt immer auf einer der beiden Seiten dieses Vergleichs.

## Verwandte Beiträge

- [Fix: Version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- wenn das `flutter pub get` in der Clean-Rebuild-Sequenz selbst scheitert.
- [Fix: Gradle task assembleDebug failed with exit code 1 in einem Flutter-Android-Build](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) -- das Gegenstück zur Build-Zeit, bei dem das Bundle nie entsteht.
- [Eine Flutter-Web-App mit WebAssembly kompilieren](/de/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) -- behandelt base href und Hosting-Pfad, die Asset-URLs im Web brechen.
- [Mehrere Flutter-Versionen aus einer CI-Pipeline ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- die Checkout- und Cache-Details hinter den meisten Asset-Meldungen nach dem Muster lokal grün, CI rot.
- [Fix: Cannot provide both a color and a decoration in einem Flutter-Container](/de/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/) -- der andere Fehler, der auftaucht, sobald man ein Bild hinter eine gestaltete Box legt.

## Quellen

- [Adding assets and images](https://docs.flutter.dev/ui/assets/assets-and-images), Flutter-Dokumentation
- [Removal of AssetManifest.json](https://docs.flutter.dev/release/breaking-changes/asset-manifest-dot-json), Flutter-Dokumentation
- [Klasse `AssetManifest`](https://api.flutter.dev/flutter/services/AssetManifest-class.html), Flutter-API-Referenz
- [`asset_bundle.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/services/asset_bundle.dart), flutter/flutter
- [`_binding_io.dart` und `mockFlutterAssets`](https://github.com/flutter/flutter/blob/stable/packages/flutter_test/lib/src/_binding_io.dart), flutter/flutter
- [Conditionally bundling assets based on flavor makes tests fail](https://github.com/flutter/flutter/issues/150296), flutter/flutter
