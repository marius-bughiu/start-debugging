---
title: "Material- und Cupertino-Importe in Flutter auf die Pakete material_ui und cupertino_ui migrieren"
description: "Die vollständige Migration von package:flutter/material.dart und package:flutter/cupertino.dart auf material_ui 1.1.1 und cupertino_ui 1.0.2: was dart fix --code=migrate_design_widgets umschreibt, warum Widgets aus Drittpaketen plötzlich Ancestor-Lookups scheitern lassen, was MaterialUiCompatibilityBridge tatsächlich behebt und wie sich die Abhängigkeit zu flutter_localizations ändert."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material-design"
  - "cupertino"
lang: "de"
translationOf: "2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages"
translatedBy: "claude"
translationDate: 2026-09-03
---

Für eine App, deren einzige Material-Oberfläche ihr eigener Code ist, ist das eine Migration von einem Befehl und einem Nachmittag: `flutter pub add material_ui`, dann `dart fix --apply --code=migrate_design_widgets`, dann die Tests laufen lassen. Die Widget-APIs sind eine identische Kopie dessen, was im SDK lag, also rendert nichts anders und kein Golden sollte sich bewegen. Zeit kostet der Abhängigkeitsgraph. Jedes Paket, das noch `package:flutter/material.dart` importiert, zieht eine zweite, typinkompatible Kopie von `Theme`, `Material` und `MaterialLocalizations` in Ihr Programm, und dessen Widgets scheitern an Ancestor-Lookups in Ihrem migrierten Baum, bis Sie die App in `MaterialUiCompatibilityBridge` einwickeln. Diese Anleitung zielt auf den aktuellen Stable-Kanal, Flutter 3.47.2 mit Dart 3.13.2, plus [`material_ui`](https://pub.dev/packages/material_ui) 1.1.1 und [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.0.2.

Die Uhr läuft hier mit. Die Bibliotheken im SDK sind bereits eingefroren, und die formale Deprecation ist für das Stable-Release im November 2026 geplant.

## Warum das keine optionale Aufräumaktion ist

- **Die Kopien im SDK erhalten keine Korrekturen.** Flutter hat die Material- und Cupertino-Verzeichnisse in `flutter/flutter` am 2026-04-07 für alle Beiträge geschlossen. Jede Fehlerkorrektur seitdem landete in `flutter/packages`. `material_ui` 1.1.1 enthält bereits Korrekturen, die die SDK-Kopie nie bekommt, darunter die Race Condition in `SearchAnchor`, bei der ein veralteter Satz asynchroner Vorschläge einen neueren ersetzte, und die Wertanzeige-Labels von `Slider`, die am Bildschirmrand abgeschnitten statt mit Auslassungspunkten gekürzt wurden.
- **Design-Updates warten nicht mehr auf den SDK-Zug.** Material und Cupertino erschienen bisher im Quartalsrhythmus von Flutter, also wartete eine Token-Anpassung oder ein neues `MenuAnchor`-Argument auf den nächsten Stable-Schnitt. `material_ui: ^1.1.1` zu pinnen entkoppelt das: 1.1.0 und 1.1.1 kamen beide zwischen Stable 3.47 und heute.
- **Sie können endlich ein Designsystem loswerden, das Sie nie genutzt haben.** Sobald die SDK-Kopien gelöscht sind, schleppt eine reine Cupertino-App das Theming, die Typografie und die Icon-Metadaten von Material nicht mehr durch das Tree-Shaking, und umgekehrt.
- **Die Lokalisierungen ziehen mit den Widgets um.** Die übersetzten Strings und Delegates von Material und Cupertino liegen jetzt in den Paketen, und deshalb müssen Sie `flutter_localizations` nicht mehr selbst angeben.
- **Wenn Sie ein Paket veröffentlichen, sind Sie ein Blocker.** Ein einziges nicht migriertes Blattpaket erzwingt die Kompatibilitätsbrücke bei allen weiter unten.

## Was bricht

| Bereich | Änderung | Schweregrad |
| ------- | -------- | ----------- |
| Importe | `package:flutter/material.dart` wird `package:material_ui/material_ui.dart`; `package:flutter/cupertino.dart` wird `package:cupertino_ui/cupertino_ui.dart` | hoch, vollständig automatisierbar |
| Typidentität | Das `Material` des SDK und das `Material` aus `material_ui` sind zur Laufzeit verschiedene Typen, deshalb überschreiten Ancestor-Lookups die Grenze nicht | hoch, benötigt die Brücke |
| Lokalisierungs-Delegates | `GlobalMaterialLocalizations` und `GlobalCupertinoLocalizations` kommen aus den Paketen, nicht aus `flutter_localizations` | mittel |
| `pubspec.yaml` | Zwei neue direkte Abhängigkeiten; `flutter_localizations` ist keine direkte Abhängigkeit mehr, die Sie brauchen | mittel |
| Generierter Code | Alles, was `package:flutter/material.dart` in eine `.g.dart`- oder `.freezed.dart`-Datei schreibt, muss nach dem Durchlauf über den Quellcode neu generiert werden | mittel |
| Veröffentlichte Pakete | Ihr eigenes Paket zu migrieren ist eine Breaking Change für Konsumenten und braucht daher einen Major-Versionssprung | mittel |
| Widget-APIs | Keine. Konstruktoren, Parameter und Rendering bleiben unverändert | keine |

Diese letzte Zeile ist der ganze Grund, warum diese Migration machbar ist. `material_ui` 1.0.0 ist eine Kopie der mitgelieferten Bibliothek im Stand des Freeze vom April 2026, kein Redesign.

## Checkliste vor dem Start

- Flutter 3.44 oder neuer. `material_ui` hat seine Untergrenze auf Flutter 3.44 / Dart 3.12 gehoben, als der Code aus `flutter/flutter` auszog, und 3.47.2 ist die aktuelle Stable. Prüfen mit `flutter --version`.
- Ein sauberes `flutter analyze` vor dem Start. Der Durchlauf nach der Migration soll vergleichbar sein.
- Ein Branch. `dart fix --apply` schreibt jede passende Datei in einem Durchgang um, und es gibt keinen Undo-Schalter.
- Eine Inventur der Abhängigkeiten, die Material- oder Cupertino-Widgets rendern. `flutter pub deps --style=compact` plus `flutter pub outdated` liefert die Liste; alles, was zuletzt vor August 2026 veröffentlicht wurde, ist nicht migriert.
- Falls Sie Golden-Tests haben, lassen Sie sie zuerst laufen und committen Sie die Baseline. Sie sollten sich nicht ändern, und genau das ist die Aussage.

## Migrationsschritte

1. **Fügen Sie die Pakete hinzu, bevor Sie einen einzigen Import anfassen.** Die `dart fix`-Regel schreibt Import-Strings um; sie bearbeitet `pubspec.yaml` nicht. In der falschen Reihenfolge bekommen Sie eine Datei voller nicht auflösbarer Importe.

   ```sh
   # Flutter 3.47.2, Dart 3.13.2
   flutter pub add material_ui
   flutter pub add cupertino_ui
   ```

   Das löst heute zu `material_ui: ^1.1.1` und `cupertino_ui: ^1.0.2` auf. Ist Ihre App reines Material, erhalten Sie `cupertino_ui` trotzdem transitiv, denn `material_ui` hängt seit Release 1.0.1 von `cupertino_ui: ^1.0.0` ab; geben Sie es aber explizit an, wenn Sie es direkt importieren. Prüfen mit `flutter pub deps --style=compact | grep -E 'material_ui|cupertino_ui'` und bestätigen, dass beide auflösen.

2. **Schreiben Sie die Importe mit dem mitgelieferten Fix um.** Beide Pakete registrieren denselben Analyzer-Fix, ein Befehl erledigt also Material und Cupertino gemeinsam.

   ```sh
   dart fix --dry-run --code=migrate_design_widgets   # review first
   dart fix --apply  --code=migrate_design_widgets
   ```

   Das Ergebnis ist ein einzeiliger Diff pro Datei:

   ```dart
   // Before: Flutter 3.43 and earlier
   import 'package:flutter/material.dart';

   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';
   ```

   Unterhalb der Import-Zeile ändert sich nichts. `MaterialApp`, `Scaffold`, `ThemeData`, `Colors`, `showDialog` und jeder andere Name werden unter demselben Identifier exportiert. Prüfen mit `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" lib test`, das nichts zurückgibt, danach `flutter analyze`.

3. **Richten Sie die Lokalisierungs-Delegates auf die Pakete aus.** Die Delegates und die übersetzten Strings sind nach `material_ui` und `cupertino_ui` gewandert, und die Pakete bieten einen Sammel-Getter, der Ihnen das Auflisten von drei Delegates erspart.

   ```dart
   // Before: flutter_localizations, Flutter 3.43
   import 'package:flutter_localizations/flutter_localizations.dart';

   localizationsDelegates: const <LocalizationsDelegate<Object>>[
     GlobalMaterialLocalizations.delegate,
     GlobalCupertinoLocalizations.delegate,
     GlobalWidgetsLocalizations.delegate,
   ],
   ```

   ```dart
   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';

   localizationsDelegates: GlobalMaterialLocalizations.delegates,
   ```

   `GlobalMaterialLocalizations.delegates` enthält die Cupertino- und Widgets-Delegates bereits. Wenn Sie zusätzlich `gen-l10n` nutzen, bleibt Ihr generiertes `AppLocalizations.delegate` unberührt und wird wie bisher an diese Liste angehängt. `flutter_localizations` können Sie nun aus Ihren eigenen `dependencies` entfernen, es bleibt aber in `pubspec.lock`: `cupertino_ui` 1.0.2 hängt weiterhin davon ab, neben `collection: ^1.19.1` und `intl: ^0.20.2`. Prüfen, indem Sie mit einer nicht-englischen Locale starten und einen eingebauten String kontrollieren, zum Beispiel ein `TextField` lang drücken und bestätigen, dass die Einfügen-Option übersetzt ist.

4. **Überbrücken Sie die Abhängigkeiten, die nicht migriert sind.** Das ist der Schritt, den man überspringt und anschließend eine Stunde debuggt. Auf App-Ebene mit `MaterialApp.builder` einwickeln:

   ```dart
   // material_ui 1.1.1
   MaterialApp(
     theme: ThemeData(useMaterial3: true),
     builder: (BuildContext context, Widget? child) {
       return MaterialUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   Die Cupertino-Seite ist symmetrisch:

   ```dart
   // cupertino_ui 1.0.2
   CupertinoApp(
     builder: (BuildContext context, Widget? child) {
       return CupertinoUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   Sie können auch einen engeren Teilbaum einwickeln, wenn nur ein Screen alte Widgets einbettet; das hält die zusätzlichen Inherited Widgets aus dem restlichen Baum heraus. Prüfen, indem Sie jeden Screen aufrufen, der ein Widget aus einem Drittpaket enthält. Die Brücke ist temporäres Baugerüst: Löschen Sie sie, sobald `flutter pub outdated` nichts mehr mit den alten Importen zeigt.

5. **Generieren Sie alles neu, was ein Codegenerator geschrieben hat.** `dart fix` sieht Ihren Quellcode, nicht die Templates, die ihn erzeugt haben. Lassen Sie den Generator nach Schritt 2 erneut laufen, damit die erzeugten Dateien die SDK-Bibliothek nicht mehr importieren:

   ```sh
   dart run build_runner build --delete-conflicting-outputs
   ```

   Prüfen Sie danach die Reste, die `dart fix` nicht erreicht: `export`-Barrel-Dateien, die Material für Konsumenten re-exportieren, bedingte Importe, die pro Plattform eine Material-Implementierung wählen, und jedes eigene Generator-Template, in dem der Importpfad als String fest hinterlegt ist. Prüfen mit demselben `grep` aus Schritt 2, aber über das gesamte Repository statt nur `lib` und `test`.

6. **Wenn Sie ein Paket veröffentlichen, erhöhen Sie die Major-Version.** Ein veröffentlichtes Paket auf `material_ui` umzustellen ändert, was Konsumenten in ihrer eigenen `pubspec.yaml` haben müssen. Das als Minor-Release auszuliefern bricht Apps stillschweigend: Ihr Widget-Baum mischt am Ende Quellen, ohne dass ein Compilerfehler darauf zeigt. Springen Sie auf die nächste Major-Version, notieren Sie die nötige `material_ui`-Constraint im Changelog, und halten Sie die vorige Major-Version auf einem Wartungsbranch, wenn Sie ältere Flutter-Versionen unterstützen. Prüfen mit `dart pub publish --dry-run`.

## Verifikation

- `flutter analyze` meldet die gleiche Anzahl wie Ihre Baseline vor der Migration, ohne `uri_does_not_exist` und ohne `deprecated_member_use` in einer Import-Zeile.
- `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" .` findet nichts außerhalb von `.dart_tool` und `pubspec.lock`.
- `flutter test` läuft durch, Golden-Tests eingeschlossen und unverändert. Ein verschobenes Golden bedeutet, dass zwei Kopien der Bibliothek im selben Baum rendern, nicht dass Material sich geändert hat.
- Die App läuft auf einem Gerät, und jeder Screen mit einem eingebetteten Drittpaket-Widget rendert mit Ihrem Theme, nicht mit Defaults.
- Eine nicht-englische Locale zeigt nach Schritt 3 weiterhin übersetzte eingebaute Strings.
- `flutter build apk --release --analyze-size` (oder das iOS-Äquivalent) als Größen-Baseline für später, sobald die SDK-Kopien gelöscht sind und das Tree-Shaking das ungenutzte Designsystem wirklich verwerfen kann.

## Rollback

Heute vollständig umkehrbar. Die Änderungen sind ein `pubspec.yaml`-Diff, eine Import-Zeile pro Datei, eine Delegates-Liste und ein optionales Brücken-Widget, ein `git revert` des Migrations-Commits bringt Sie also zurück auf die SDK-Bibliotheken, ohne Daten oder Build-Artefakte zurückzudrehen. Zwei Einschränkungen: Es gibt kein umgekehrtes `dart fix`, ein manuelles Rollback heißt also, jeden Import per Hand zurückzuschreiben, weshalb Schritt Null ein Branch ist. Und nach dem Stable-Release im November 2026 parkt ein Revert Sie auf formal deprecated APIs, die gelöscht werden; behandeln Sie Rollback daher als Mittel, ein Release freizubekommen, nicht als Entscheidung.

## Fallstricke

**"Could not find an ancestor of type MaterialLocalizations" aus Code, den Sie nicht geschrieben haben.** Das ist das Typidentitätsproblem zur Laufzeit. Ein Widget, das gegen die SDK-Bibliothek kompiliert wurde, ruft `MaterialLocalizations.of(context)` auf, was den Baum nach dem Inherited Widget *seines* `MaterialLocalizations`-Typs durchsucht. Ihre `MaterialApp` aus `material_ui` hat einen anderen Typ mit gleichem Namen eingefügt, der Lookup schlägt fehl, und der Assert greift. `Theme.of(context)` scheitert genauso, mit "Could not find an ancestor of type Theme". Die Brücke aus Schritt 4 existiert genau dafür, die alten Inherited Widgets neben den neuen einzufügen, damit beide Lookups auflösen. Sie ist kein Ersatz für ein fehlendes `Scaffold`: Kommt der Fehler aus Ihrem eigenen migrierten Code, haben Sie das gewöhnliche Problem aus [no Material widget found in Flutter](/de/2026/08/fix-no-material-widget-found-in-flutter/), und die Brücke hilft nicht.

**Nicht auflösbarer Import direkt nach dem Fix.** Sie haben `dart fix` vor `flutter pub add` ausgeführt. Paket hinzufügen, dann `dart fix --apply --code=migrate_design_widgets` erneut laufen lassen; die Regel ist idempotent.

**Lassen Sie nicht beide Importe in einer Datei.** `package:flutter/material.dart` und `package:material_ui/material_ui.dart` exportieren die gleichen Identifier, jede Datei mit beiden bekommt also Fehler wegen mehrdeutiger Importe bei `Material`, `Theme`, `Colors` und Co. Einen davon zu präfixen kompiliert, gibt Ihnen aber zwei Designsysteme in einer Datei, was schlimmer als der Fehler ist. Pro Datei eines wählen.

**Freeze-Datum und Deprecation-Datum sind nicht dasselbe.** Die [Ankündigung des Code Freeze](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze) sagte, die SDK-Bibliotheken würden im Stable-Release *nach* 3.44 deprecated. Das hat sich verschoben: 3.47 erschien am 2026-08-12 ohne die Deprecation, und [die Release Notes zu 3.47](https://flutter.dev/blog/whats-new-in-flutter-3-47) setzen die formale Deprecation nun auf die November-Stable. Eingefroren seit April, deprecated im November, später gelöscht. Planen Sie gegen November, nicht gegen das, worüber Ihr Analyzer heute schweigt.

**Asset-Manifeste können sich verschieben, auch wenn die Widgets es nicht tun.** `material_ui` 1.1.0 hat das Shader-Asset `ink_sparkle` über die eigene `pubspec.yaml` bereitgestellt und den `stretch_effect`-Shader entfernt. Wenn Sie auf das Asset-Manifest testen oder unbenutzte Assets in einem Build-Schritt entfernen, ist das ein echter Diff zum Prüfen.

**Migrieren Sie Importe und Flutter-Versionen in getrennten Commits.** Wenn Sie im selben Durchgang SDK-Versionen springen, hat jede visuelle Regression zwei Kandidaten als Ursache. Erst das SDK-Upgrade landen, bestätigen, dass die App sauber ist, dann die Importe migrieren.

## Verwandte Beiträge

- Die Ankündigung, an die diese Migration anschließt, samt dem SwiftPM-Default aus demselben Release, steht in [Flutter 3.44 löst Material und Cupertino aus dem SDK](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Strukturell ist das derselbe breite, mechanische Durchgang wie [eine Flutter-Web-App von dart:html auf package:web migrieren](/de/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/), inklusive des Teils, in dem `dart fix` die einfachen 95 % erledigt und der Abhängigkeitsgraph Sie erledigt.
- Für eine Deprecation, die `dart fix` ausdrücklich nicht automatisieren kann, vergleichen Sie [Radio.groupValue und onChanged durch RadioGroup ersetzen](/de/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- Wenn Sie in diesem Zyklus zugleich auf die aktuelle Stable wechseln, lesen Sie [was Flutter 3.47 am Desktop-Rendering geändert hat](/de/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/), bevor Sie eine visuelle Regression dem Paketwechsel zuschreiben.
- Fehlgeschlagene Ancestor-Lookups sind eine Familie, kein Einzelfall. [ScaffoldMessenger.of(context) does not contain a Scaffold](/de/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/) ist dieselbe Debugging-Methode auf ein anderes Inherited Widget angewandt.

## Quellen

- [material_ui auf pub.dev](https://pub.dev/packages/material_ui), Version 1.1.1, und das [Changelog](https://pub.dev/packages/material_ui/changelog)
- [cupertino_ui auf pub.dev](https://pub.dev/packages/cupertino_ui), Version 1.0.2
- [Flutter's Material and Cupertino code freeze](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze), der Flutter-Blog
- [What's new in Flutter 3.44](https://flutter.dev/blog/whats-new-in-flutter-3-44), der Flutter-Blog
- [What's new in Flutter 3.47](https://flutter.dev/blog/whats-new-in-flutter-3-47), der Flutter-Blog
- [Tracking-Issue zur Entkopplung des Designsystems](https://github.com/flutter/flutter/issues/172932), flutter/flutter
- [Flutter 3.47.0 Release Notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0), docs.flutter.dev
