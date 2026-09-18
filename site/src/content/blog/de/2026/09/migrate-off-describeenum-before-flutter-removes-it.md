---
title: "describeEnum in Flutter ablösen, bevor es entfernt wird"
description: "describeEnum ist seit Flutter 3.16 veraltet, und der PR zur Entfernung ist genehmigt. So ersetzen Sie jeden Aufruf durch Enum.name (Flutter 3.47.4, Dart 3.13), behandeln enum-ähnliche Klassen und Diagnostics, finden die Aufrufe, die sich in Abhängigkeiten wie flutter_svg 1.x verstecken, und so sieht der Build-Fehler aus, sobald die Funktion weg ist."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "enums"
lang: "de"
translationOf: "2026/09/migrate-off-describeenum-before-flutter-removes-it"
translatedBy: "claude"
translationDate: 2026-09-18
---

Für fast jede Codebasis ist das ein 30-minütiges Suchen und Ersetzen: `describeEnum(x)` wird zu `x.name`, `describeEnum` als Tear-off übergeben wird zu `(e) => e.name`, und die Schleifen für "String zurück zu Enum", die dazu passten, werden zu `MyEnum.values.byName(s)`. `dart fix` erledigt das nicht für Sie, und die einzigen Aufrufstellen, bei denen man nachdenken muss, sind die, die etwas übergeben, das kein echtes Dart-`Enum` ist. Was wirklich Zeit kostet, ist Ihr Abhängigkeitsgraph: Ein altes Paket wie `flutter_svg` 1.1.6 ruft `describeEnum` immer noch auf, und an dem Tag, an dem die Funktion entfernt wird, kompiliert Ihre App nicht mehr, und zwar in einer Datei, die Ihnen nicht gehört. Alles Folgende habe ich auf Flutter 3.47.4 (Dart 3.13.3), dem aktuellen Stable, und gegen einen lokalen Flutter-Build mit der anstehenden Entfernung verifiziert.

## Wo die Entfernung tatsächlich steht

Der Zeitablauf ist verwirrend genug, dass es sich lohnt, ihn festzuhalten, bevor man Code anfasst, denn die offizielle Dokumentation und das SDK widersprechen sich derzeit.

- `describeEnum` wurde in [flutter/flutter#125016](https://github.com/flutter/flutter/pull/125016) als veraltet markiert. Der PR landete in 3.14.0-2.0.pre und wurde mit dem Stable 3.16 ausgeliefert. Die Deprecation-Meldung lautet "Use the `name` getter on enums instead. This feature was deprecated after v3.14.0-2.0.pre."
- Die Entfernung ist [flutter/flutter#190076](https://github.com/flutter/flutter/pull/190076), eröffnet am 2026-07-27. Er löscht die Funktion aus `packages/flutter/lib/src/foundation/diagnostics.dart` samt ihren Tests. Er hat drei Genehmigungen, ist aber Stand 2026-09-18 noch offen: Der Check "Google testing" schlägt fehl, weil Googles internes Monorepo `flutter_svg` zuerst über 2.0.0 hinaus aktualisieren muss.
- Der Breaking-Change-Leitfaden zur Entfernung ([flutter/website#13682](https://github.com/flutter/website/pull/13682)) wurde am 2026-08-18 gemergt, und der Index der Breaking Changes führt "Removal of `describeEnum`" bereits unter **Released in Flutter 3.47**. Das ist der Realität voraus. Ich habe `diagnostics.dart` am Tag `3.47.4`, am Beta-Tag `3.48.0-0.5.pre` und auf `master` geprüft: `describeEnum` ist in allen dreien noch definiert.

Auf dem Stable-Kanal bricht heute also nichts. Sie bekommen lediglich einen `deprecated_member_use`-Hinweis auf `info`-Ebene, den die meisten Teams seit 2023 ignorieren. Sobald #190076 gemergt wird, bricht `master` sofort, und die nächste Beta danach bricht für alle auf dem Beta-Kanal. Jetzt zu migrieren kostet genauso viel wie später, nur passiert es später mitten in einem Upgrade, das Sie aus einem ganz anderen Grund wollten.

## Was bricht

| Bereich | Änderung | Schweregrad |
| ---- | ------ | -------- |
| `describeEnum(value)` in Ihrem Code | Kompilierfehler: Die Funktion existiert nicht mehr | hoch, aber trivial zu beheben |
| `describeEnum` in einer Abhängigkeit | Kompilierfehler in der Datei des Pakets, die App baut nicht | hoch, erfordert ein Paket-Upgrade |
| `describeEnum` auf Klassen, die kein `Enum` sind | Kein `.name`-Getter, auf den man umstellen könnte | mittel, erfordert einen lokalen Helfer |
| `describeEnum` als Tear-off (`.map(describeEnum)`) | Derselbe Kompilierfehler | niedrig |
| `StringProperty(name, describeEnum(v))` in `debugFillProperties` | Funktioniert, wenn auf `.name` umgeschrieben, aber `EnumProperty` ist der bessere Ersatz | niedrig |
| Unterstützung durch `dart fix` | Keine. Der Flutter-Leitfaden sagt das ausdrücklich, und `dart fix --dry-run` meldet "Nothing to fix!" | informativ |

## Checkliste vor dem Start

- Flutter 3.16 oder neuer. Jedes Stable seitdem enthält die Deprecation, sodass der Analyzer Ihre Aufrufstellen für Sie finden kann. Code auf 3.47.4 ist hier die Basis.
- Dart 2.15 oder neuer für den `name`-Getter und `values.byName`. Beide kamen mit den Enum-Helfern in `dart:core` in Dart 2.15.0 (der Flutter-Leitfaden nennt 2.14, aber das Dart-Changelog führt sie unter 2.15.0). Jedes Flutter-3.x-Projekt erfüllt das bereits.
- Eine saubere `flutter analyze`-Ausgangslage, damit die Deprecation-Hinweise nicht unter fremden Warnungen begraben werden.
- Die Ausgabe von `flutter pub outdated` für Ihre App, denn der Schritt zu den Abhängigkeiten unten kann einen Major-Versionssprung erzwingen.

## Wie der Fehler nach der Entfernung aussieht

Um den echten Fehlertext zu bekommen, statt zu raten, habe ich den Diff aus #190076 auf einen Test-Checkout von Flutter 3.47.4 angewendet und ein Probeprojekt dagegen laufen lassen. Der Analyzer meldet:

```text
error • The function 'describeEnum' isn't defined. Try importing the library that defines 'describeEnum', correcting the name to the name of an existing function, or defining a function named 'describeEnum' • lib/legacy.dart:27:20 • undefined_function
```

`flutter run`, `flutter test` und `flutter build` laufen stattdessen über den Front-End-Compiler, der Folgendes ausgibt:

```text
lib/legacy.dart:27:20: Error: Method not found: 'describeEnum'.
String simple() => describeEnum(ThemeChoice.dark);
                   ^^^^^^^^^^^^
```

Und ein Projekt, das von `flutter_svg: 1.1.6` abhängt, scheitert, bevor überhaupt Ihr Code läuft, mit einem Fehler, der in den Pub-Cache zeigt:

```text
/Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196:33: Error: The method 'describeEnum' isn't defined for the type 'PictureConfiguration'.
      result.write('platform: ${describeEnum(platform!)}');
                                ^^^^^^^^^^^^
```

Wenn Sie über diese letzte Meldung auf diesem Beitrag gelandet sind, springen Sie direkt zu Schritt 5.

## Migrationsschritte

1. **Alle Aufrufstellen mit dem Analyzer auflisten.**
   Führen Sie `flutter analyze` aus und filtern Sie nach der Deprecation. Auf 3.47.4 ist jeder Treffer eine `info`-Zeile, die auf `deprecated_member_use` endet:

   ```bash
   # Flutter 3.47.4
   flutter analyze --no-fatal-infos | grep "'describeEnum' is deprecated"
   ```

   Ein einfaches `grep -rn "describeEnum" lib test` findet dieselben Stellen, dazu Erwähnungen in Doc-Kommentaren und in allen Dateien, die Ihre `analysis_options.yaml` ausschließt. Prüfen: Sie haben eine Liste von Dateien und Zeilennummern und wissen, welche davon in generierten Dateien liegen (diese neu generieren, nicht von Hand bearbeiten).

2. **Aufrufe auf echten Enums durch `.name` ersetzen.**
   Für jeden Wert, dessen statischer Typ ein `enum` ist, ist die Umschreibung mechanisch. Das deckt einfache Enums, Enhanced Enums, nullable Enums und Tear-offs ab:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   enum ThemeChoice { light, dark }

   // Before
   String simple() => describeEnum(ThemeChoice.dark);
   String? nullable(ThemeChoice? c) => c == null ? null : describeEnum(c);
   List<String> tearOff() => ThemeChoice.values.map(describeEnum).toList();

   // After
   String simple() => ThemeChoice.dark.name;
   String? nullable(ThemeChoice? c) => c?.name;
   List<String> tearOff() => ThemeChoice.values.map((e) => e.name).toList();
   ```

   Das Verhalten ist identisch: Seit Flutter 3.0 beginnt `describeEnum` mit `if (enumEntry is Enum) return enumEntry.name;`, für echte Enums war es also schon nur ein Wrapper um `.name`. Das gilt auch für Enhanced Enums, die `toString()` überschreiben. Ein Enum, dessen `toString()` `Level(H)` zurückgibt, lieferte bei `describeEnum` trotzdem `high` und liefert `high` auch bei `.name`. Prüfen: `flutter analyze` zeigt für diese Dateien keine Hinweise mehr.

3. **Die Rückwärtssuche durch `values.byName` ersetzen.**
   Der meiste `describeEnum`-Code steht neben einem handgeschriebenen Parser, der über `values` iteriert und Strings vergleicht. Ersetzen Sie beide Hälften zusammen:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': describeEnum(c)};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.firstWhere((e) => describeEnum(e) == json['theme']);

   // After
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': c.name};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.byName(json['theme']! as String);
   ```

   Die serialisierten Strings ändern sich nicht, gespeichertes JSON, Shared Preferences und Analytics-Ereignisse funktionieren also weiter. Das Fehlerverhalten ändert sich aber: Bei einem unbekannten Wert warf die alte Schleife `StateError: Bad state: No element`, während `byName` `ArgumentError: Invalid argument (name): No enum value with that name: "blue"` wirft. Wenn Sie um dieses Parsen herum `StateError` abfangen, passen Sie das `catch` an. Prüfen: ein Test, der jeden Wert in `ThemeChoice.values` per `toJson`/`fromJson` hin und zurück schickt, plus ein Test mit einem unbekannten String.

4. **Enum-ähnlichen Klassen einen lokalen Helfer geben.**
   `describeEnum` akzeptierte `Object` und nahm für alles, was kein `Enum` war, `toString()` und gab alles nach dem ersten Punkt zurück. Das zielte auf "enum-ähnliche" Klassen aus der Zeit vor Dart 2.17 wie diese hier, die es in älteren Codebasen und in manchen Paketen noch gibt:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   class Channel {
     const Channel._(this._value);
     final String _value;
     static const Channel stable = Channel._('stable');
     static const Channel beta = Channel._('beta');
     @override
     String toString() => 'Channel.$_value';
   }
   ```

   `Channel.beta.name` kompiliert nicht, weil es kein `name` gibt. Sie haben zwei Möglichkeiten. Die bessere ist, `Channel` in ein echtes `enum` umzuwandeln, was meist möglich ist, seit Enhanced Enums Felder und Konstruktoren unterstützen. Wenn das nicht geht (die Klasse stammt aus einem Paket oder hat nicht-const Instanzen), kopieren Sie den Fallback-Zweig in Ihren eigenen Code:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   /// Local copy of the only describeEnum behaviour `.name` cannot replace.
   String enumLikeName(Object value) {
     final String description = value.toString();
     final int indexOfDot = description.indexOf('.');
     assert(
       indexOfDot != -1 && indexOfDot < description.length - 1,
       'The provided object "$value" is not an enum.',
     );
     return description.substring(indexOfDot + 1);
   }

   String fromObject(Object value) =>
       value is Enum ? value.name : enumLikeName(value);
   ```

   Die Prüfung `value is Enum` ist wichtig für Aufrufstellen, die als `Object` oder `dynamic` typisiert sind, denn genau dort haben Leute `describeEnum` eine Mischung aus Enums und enum-ähnlichen Klassen übergeben. Beachten Sie, dass das `assert` nur in Debug-Builds läuft. Im Release warf `describeEnum(42)` nie: `indexOf` gab -1 zurück, `substring(0)` gab `"42"` zurück, und Ihr Code lief weiter. Der Helfer behält dieses Verhalten absichtlich bei, damit sich in Produktion nichts ändert. Prüfen: Tests im Debug-Modus für jeden enum-ähnlichen Typ liefern dieselben Strings wie vorher.

5. **Die Aufrufe in Ihren Abhängigkeiten beheben.**
   Ihr eigener Code ist der einfache Teil. Ein Paket, das `describeEnum` aufruft, bricht Ihren Build an dem Tag, an dem die Funktion verschwindet, und Sie können es nicht per Suchen und Ersetzen patchen. Den Pub-Cache zu durchsuchen liefert viel Rauschen, weil er jede Version enthält, die Sie je heruntergeladen haben. Scannen Sie daher nur die Paketversionen, die Ihre App tatsächlich auflöst, anhand von `.dart_tool/package_config.json`:

   ```dart
   // Dart 3.13: list every describeEnum call in the packages your app resolves.
   // Save as tool/find_describe_enum.dart, run: dart run tool/find_describe_enum.dart
   import 'dart:convert';
   import 'dart:io';

   void main() {
     final config = File('.dart_tool/package_config.json');
     final json = jsonDecode(config.readAsStringSync()) as Map<String, dynamic>;
     final call = RegExp(r'\bdescribeEnum\s*[(),;]');
     for (final pkg in (json['packages'] as List).cast<Map<String, dynamic>>()) {
       if (pkg['name'] == 'flutter') continue; // defines it
       var rootUri = pkg['rootUri'] as String;
       if (!rootUri.endsWith('/')) rootUri += '/';
       final root = config.parent.uri.resolve(rootUri);
       final lib = Directory.fromUri(root.resolve(pkg['packageUri'] as String));
       if (!lib.existsSync()) continue;
       for (final f in lib.listSync(recursive: true).whereType<File>()) {
         if (!f.path.endsWith('.dart')) continue;
         final lines = f.readAsLinesSync();
         for (var i = 0; i < lines.length; i++) {
           if (call.hasMatch(lines[i]) && !lines[i].trimLeft().startsWith('//')) {
             print('${pkg['name']}: ${f.path}:${i + 1}');
           }
         }
       }
     }
   }
   ```

   Die Korrektur mit dem abschließenden Schrägstrich ist keine Dekoration. `package_config.json` speichert gehostete Pakete als `file:///.../flutter_svg-1.1.6` ohne abschließenden Schrägstrich, und `lib/` dagegen aufzulösen zeigt stillschweigend auf den übergeordneten Ordner. Meine erste Version dieses Skripts hatte genau diesen Bug und meldete null Treffer für `flutter_svg` 1.1.6. Die korrigierte Version gibt aus:

   ```text
   flutter_svg: /Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196
   ```

   Prüfen Sie für jedes gemeldete Paket, ob ein neueres Release den Aufruf entfernt hat. Für `flutter_svg` lautet die Antwort: jede 2.x. Ich habe 2.0.0 und 2.2.1 durchsucht, und keine der beiden referenziert `describeEnum` (das neueste Release ist 2.3.0). Der Sprung von 1.x auf 2.x ist eine eigene, echte Migration, weil 2.0 auf `vector_graphics` umgestellt und die Loader-APIs geändert hat, aber es ist derselbe Sprung, den Googles interner Code machen muss, bevor #190076 landen kann. Wenn ein Paket verwaist ist, forken Sie es, wenden Schritt 2 auf den Fork an und lassen einen `dependency_overrides`-Eintrag auf Ihren Fork zeigen. Prüfen: Das Skript gibt für Drittanbieter-Pakete keine Zeilen aus.

6. **Diagnostics auf `EnumProperty` umschreiben.**
   Ein häufiger Einsatzort in Widgets und Render-Objekten war `debugFillProperties`. Eine mechanische Umschreibung auf `.name` kompiliert, aber die typisierte Property ist besser:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   properties.add(StringProperty('choice', describeEnum(choice)));

   // After
   properties.add(EnumProperty<ThemeChoice>('choice', choice));
   ```

   Die Ausgabe unterscheidet sich leicht. `StringProperty` setzt seinen Wert in Anführungszeichen, DevTools und `toStringDeep()` zeigten also `choice: "dark"`, während `EnumProperty` `choice: dark` ausgibt. Wenn Sie Golden-Tests über `toStringDeep()` oder `debugDescribeChildren` haben, aktualisieren Sie diese. Seit Flutter 3.16 verlangt `EnumProperty<T>`, dass `T extends Enum?` gilt. Für eine enum-ähnliche Klasse verwenden Sie daher stattdessen `DiagnosticsProperty<Channel>`. Prüfen: Die Diagnostics-Tests laufen durch, nachdem ihre erwarteten Strings neu erzeugt wurden.

7. **Verhindern, dass die Deprecation zurückkommt.**
   `deprecated_member_use` ist standardmäßig `info`, weshalb diese Aufrufe drei Jahre Deprecation überlebt haben. Stufen Sie es in `analysis_options.yaml` hoch:

   ```yaml
   # Flutter 3.47.4
   include: package:flutter_lints/flutter.yaml

   analyzer:
     exclude:
       - build/**
       - android/**
     errors:
       deprecated_member_use: error
   ```

   Führen Sie `errors:` mit Ihrem bestehenden `analyzer:`-Block zusammen. Als ich stattdessen einen zweiten `analyzer:`-Schlüssel auf oberster Ebene angehängt habe, hat sich der Analyzer nicht beschwert und weiter `info` gemeldet, die Hochstufung sah also angewendet aus und war es nicht. Mit dem zusammengeführten Block meldet `flutter analyze --no-fatal-infos` `error` und endet mit Exit-Code 1. Beachten Sie, dass dies jede Deprecation hochstuft, nicht nur `describeEnum`. Wenn das für einen PR zu viel ist, belassen Sie es bei `warning` und lassen CI mit `--fatal-warnings` fehlschlagen. Prüfen: Fügen Sie einer Testdatei einen `describeEnum`-Aufruf hinzu und bestätigen Sie, dass CI fehlschlägt.

## Verifikation

Ich habe die Vorher- und Nachher-Version jedes Musters oben nebeneinander in einem `flutter test` auf Flutter 3.47.4 laufen lassen:

| Muster | Ergebnis mit `describeEnum` | Ergebnis nach der Migration |
| ------- | --------------------- | --------------- |
| Einfaches Enum | `dark` | `dark` |
| Enhanced Enum mit überschriebenem `toString()` | `high` | `high` |
| Enum-ähnliche Klasse | `beta` | `beta` |
| Nullable, Wert `null` | `null` | `null` |
| Tear-off über `values` | `[light, dark]` | `[light, dark]` |
| Als `Object` typisierter Enum-Wert | `light` | `light` |
| JSON hin und zurück | `ThemeChoice.dark` | `ThemeChoice.dark` |
| Unbekannter JSON-Wert | `StateError` | `ArgumentError` |
| `debugFillProperties` | `choice: "dark"` | `choice: dark` |

Nach der Migration ist die Checkliste kurz: `flutter analyze` ist mit `deprecated_member_use: error` sauber, der Abhängigkeits-Scan gibt für Drittanbieter-Pakete nichts aus, und die Testsuite läuft durch. Für zusätzliche Sicherheit checken Sie einen Flutter-Branch mit angewendetem #190076 aus und führen `flutter test` aus. Genau so wurden die Fehlermeldungen oben erfasst.

## Rollback-Plan

In Ihrem eigenen Code gibt es nichts zurückzurollen: `.name` und `values.byName` funktionieren auf jeder Flutter-Version seit 3.0, der migrierte Code läuft also auf dem SDK, das Sie heute haben, und auf jedem SDK nach der Entfernung. Der einzige Schritt, der wehtun kann, ist ein Major-Upgrade eines Pakets in Schritt 5. Machen Sie es in einem eigenen Commit, damit Sie die Änderung an `pubspec.yaml` und `pubspec.lock` separat zurücknehmen können und Ihre `describeEnum`-Bereinigung behalten.

## Stolperfallen

- **`dart fix` hilft nicht.** Anders als bei den meisten Flutter-Deprecations hat `describeEnum` keinen datengesteuerten Fix in `packages/flutter/lib/fix_data`, und der Leitfaden zur Entfernung sagt ausdrücklich, dass die Migration von `dart fix` nicht unterstützt wird. Wenn Sie für andere Migrationen einen repoweiten `dart fix`-Durchlauf machen, bleibt diese hier Handarbeit.
- **Ersetzen Sie `describeEnum(e)` nicht durch `e.toString().split('.').last`.** Das ist die häufigste Antwort auf Stack Overflow, und sie ist falsch für Enhanced Enums, die `toString()` überschreiben: `Level.high.toString().split('.').last` gibt `Level(H)` zurück.
- **Generierter Code.** Wenn ein Treffer aus Schritt 1 in einer `.g.dart`- oder `.freezed.dart`-Datei liegt, korrigieren Sie den Generator (aktualisieren Sie ihn oder ändern Sie Ihr Template) und generieren Sie neu. Die Ausgabe von Hand zu bearbeiten hält nur bis zum nächsten `build_runner`-Lauf.
- **Die Dokumentation sagt 3.47, das SDK nicht.** Wenn ein Reviewer auf den Index der Breaking Changes zeigt und fragt, warum 3.47.4 noch kompiliert: Der Leitfaden wurde vor der Codeänderung gemergt. Verfolgen Sie #190076 für das tatsächliche Datum. Das Feld "Landed in version" im Leitfaden selbst steht noch auf TBD.

## Verwandte Beiträge

- Wenn Sie einen ganzen Stapel Flutter-Deprecations auf einmal abarbeiten wollen, erledigt [`dart fix` über ein ganzes Repo ausführen](/de/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) alles, was einen datengesteuerten Fix hat.
- Eine weitere Deprecation, die eine manuelle Umschreibung braucht: [das veraltete `groupValue` und `onChanged` von `Radio` durch `RadioGroup` ersetzen](/de/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- Die größere Migration des Abhängigkeitsgraphen, die auf jede Flutter-App zukommt: [der Umstieg auf die eigenständigen Pakete `material_ui` und `cupertino_ui`](/de/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Wenn Ihr Enum-Parsing mitten im JSON-Decoding steckt, deckt [`FormatException: Unexpected character` in Dart beheben](/de/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) die andere Hälfte dieses Codepfads ab.

## Quellen

- [flutter/flutter#190076: Remove deprecated `describeEnum` from framework](https://github.com/flutter/flutter/pull/190076)
- [flutter/flutter#125016: Deprecate `describeEnum`](https://github.com/flutter/flutter/pull/125016)
- [Flutter Breaking Change: Remove describeEnum](https://docs.flutter.dev/release/breaking-changes/remove-describeEnum)
- [Flutter Breaking Change: Migrationsleitfaden für describeEnum und EnumProperty](https://docs.flutter.dev/release/breaking-changes/describe-enum)
- [API-Referenz zu `describeEnum`](https://api.flutter.dev/flutter/foundation/describeEnum.html)
- [API-Referenz zu `EnumProperty`](https://api.flutter.dev/flutter/foundation/EnumProperty-class.html)
- [Dart-Sprache: Enumerated types](https://dart.dev/language/enums)
- [Dart-SDK-Changelog, 2.15.0](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [flutter_svg auf pub.dev](https://pub.dev/packages/flutter_svg)
