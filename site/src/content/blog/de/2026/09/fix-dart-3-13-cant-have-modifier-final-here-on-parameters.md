---
title: "Fix: Can't have modifier 'final' here bei Parametern nach dem Upgrade auf Dart 3.13"
description: "Dart 3.13 reserviert final und var in Parameterlisten für Primary Constructors. Mit dart fix --apply --code=extraneous_modifier entfernen Sie sie, und nutzen Sie stattdessen parameter_assignments."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "dart-3-13"
lang: "de"
translationOf: "2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters"
translatedBy: "claude"
translationDate: 2026-09-30
---

Dart 3.13 (das SDK in Flutter 3.47) erlaubt `final` und `var` nicht mehr bei den Parametern gewöhnlicher Funktionen, Methoden, Closures und Konstruktoren mit Rumpf. Beide Schlüsselwörter sind jetzt für die Deklaration von Parametern in Primary Constructors reserviert, sodass `int add(int a, final int b)` mit `extraneous_modifier` fehlschlägt, sobald Ihre `pubspec.yaml` `sdk: ^3.13.0` enthält. Mit `dart fix --apply --code=extraneous_modifier` entfernen Sie alle betroffenen Modifier in einem Durchgang. Wenn Sie `final` verwendet haben, um die Neuzuweisung von Parametern zu verhindern, aktivieren Sie stattdessen den Lint `parameter_assignments`.

Alles Folgende wurde mit Dart 3.13.3 (Flutter 3.47.4) und Dart 3.12.2 (Flutter 3.44.8) auf macOS arm64 reproduziert und gegen das Changelog von 3.13.0, die akzeptierte Spezifikation für Primary Constructors und das Triage von [dart-lang/sdk#64151](https://github.com/dart-lang/sdk/issues/64151) geprüft, in dem das Dart-Team bestätigt hat, dass die Einschränkung beabsichtigt ist.

## Der Fehler im Kontext

`dart analyze` und die IDE melden ihn als Analyzer-Fehler:

```text
error - lib/a.dart:2:16 - Can't have modifier 'final' here. Try removing 'final'. - extraneous_modifier
```

`dart run`, `flutter run` und `flutter build` laufen stattdessen über den Front-End-Compiler, der denselben Text mit einem Zeichen unter dem Schlüsselwort ausgibt:

```text
lib/a.dart:2:16: Error: Can't have modifier 'final' here.
Try removing 'final'.
int add(int a, final int b) => a + b;
               ^^^^^
```

Bei `var` wechselt nur das Schlüsselwort in der Meldung: `Can't have modifier 'var' here. Try removing 'var'.` Ein typisierter Parameter `var int n` meldet zusätzlich `var_and_type`, das war aber schon vor 3.13 ein Fehler.

Verwirrend ist der Auslöser. Niemand hat die Datei angefasst. Geändert hat sich die SDK-Einschränkung: Jemand hat `environment: sdk:` auf `^3.13.0` angehoben, um Primary Constructors auszuprobieren, oder eine Vorlage hat ein neues Paket mit der Untergrenze 3.13 erzeugt, und Code, der jahrelang kompilierte, schlägt plötzlich fehl. Ein typischer CI-Fehler sieht aus wie der in #64151: eine private Hilfsmethode, die vor Monaten mit `final int precision` in der Parameterliste geschrieben wurde, in einer Klasse ohne jeden Primary Constructor.

## Warum Dart 3.13 final bei Parametern ablehnt

Dart 3.13.0 hat am 2026-08-12 [Primary Constructors](https://dart.dev/language/primary-constructors) ausgeliefert. Ein Primary Constructor steht im Klassenkopf, und ein dort mit `final` oder `var` markierter Parameter ist ein *deklarierender Parameter*: Er deklariert neben dem Konstruktorparameter auch ein Instanzfeld.

```dart
// Dart 3.13.3
class Point(final int x, final int y); // declares fields x and y
```

Damit diese Bedeutung eindeutig bleibt, verbietet die [Feature-Spezifikation](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md) `var x`, `final x` und `final T x` als formale Parameterdeklarationen in jeder Funktion, die kein Primary Constructor ist. Das Dart-Team hat Konsistenz einer engeren Regel vorgezogen: In #64151 hat Leaf Petersen die Frage, ob das enger gemeint war, schlicht mit Ja beantwortet, es ist beabsichtigt.

Zwei Details lassen es wie eine Regression statt wie eine Sprachänderung wirken:

1. **Es ist an die Sprachversion gebunden.** Die Einschränkung gilt nur für Bibliotheken mit Sprachversion 3.13 oder höher. Die Sprachversion ergibt sich aus der Untergrenze von `sdk:` in der `pubspec.yaml`, sodass derselbe Code mit `sdk: ^3.12.0` auf dem 3.13-SDK weiterhin kompiliert. Deshalb hat das Dart-Team es auch nicht als Breaking Change im formalen Sinn behandelt.
2. **Es war zum Release kaum dokumentiert.** Das ursprüngliche Changelog von 3.13.0 beschrieb Primary Constructors, wies aber nicht auf die Auswirkung auf gewöhnliche Funktionen hin. Nach #64151 erhielt das Changelog unter Language den Eintrag "**Breaking change**: You can no longer use `final` or `var` on non-declaring parameters", und die Seite zu Primary Constructors bekam einen Abschnitt "Constraints and breaking changes". Das einzige frühere Signal war die Abkündigung des Lints `prefer_final_parameters` in Dart 3.11.

## Minimales Beispiel zur Reproduktion

Zwei Dateien genügen. Die Pubspec legt die Sprachversion fest:

```yaml
# Dart 3.13.3
name: fp
environment:
  sdk: ^3.13.0
```

Und eine Bibliothek, die `final` und `var` an allen gängigen Parameterpositionen verwendet:

```dart
// Dart 3.13.3, language version 3.13
int add(int a, final int b) => a + b;                   // error

void named({required final String id, final int retries = 3}) {} // 2 errors

void positional([final int? x]) {}                      // error

void callback(final void Function(int) onTap) {}        // error

void untypedVar(var x) {}                               // error

class Money {
  final int cents;
  Money(final int c) : cents = c;                       // error, in-body constructor
  Money operator +(final Money other) => Money(cents + other.cents); // error
  set value(final int v) {}                             // error
  static Money zero(final int unused) => Money(0);      // error
}

void loops(List<int> xs) {
  for (final x in xs) {                                 // fine, not a parameter
    print(x);
  }
  final local = xs.length;                              // fine, local variable
  xs.forEach((final v) => print(v + local));            // error, closure parameter
}

class Point(final int x, final int y);                  // fine, declaring parameters
```

`dart analyze` meldet unter 3.13.3 für jeden oben markierten Parameter einen `extraneous_modifier`-Fehler. Wenn Sie die Pubspec auf `sdk: ^3.12.0` ändern, verschwinden alle, und die einzigen verbleibenden Fehler stehen in der Zeile `Point`, die nun `This requires the 'primary-constructors' language feature to be enabled` meldet.

Auch Field Formals und Super-Parameter werden erfasst. `T2(final this.x)` und `C(final super.y)` erzeugen unter 3.13 beide `extraneous_modifier` sowie eine Warnung `unnecessary_final`, weil diese Parameter schon immer implizit final waren.

Nicht betroffen sind lokale Variablen, `for (final ... in ...)`, Pattern-Variablen, Felder sowie einfache Parameter `this.x` / `super.x`.

## Die Lösung im Detail

Wählen Sie eine dieser Varianten, in der Reihenfolge der Präferenz.

### 1. dart fix die Modifier entfernen lassen

Der Analyzer liefert einen Fix für `extraneous_modifier` mit, die Migration ist also mechanisch:

```bash
dart fix --dry-run
```

Im Reproduktionspaket meldet das `extraneous_modifier - 11 fixes` in `lib/a.dart`, einen pro Fehler. Wenden Sie nur diesen Code an, damit nichts anderes im Projekt umgeschrieben wird:

```bash
dart fix --apply --code=extraneous_modifier
```

Der resultierende Diff entspricht genau dem, was Sie von Hand schreiben würden:

```dart
// Dart 3.13.3, after dart fix
int add(int a, int b) => a + b;
void named({required String id, int retries = 3}) {}
void positional([int? x]) {}
void callback(void Function(int) onTap) {}
void untypedVar(x) {}

class Money {
  final int cents;
  Money(int c) : cents = c;
  Money operator +(Money other) => Money(cents + other.cents);
  set value(int v) {}
  static Money zero(int unused) => Money(0);
}
```

Nach dem Fix meldet `dart analyze` keine Probleme mehr, und das Programm läuft. In einer Flutter-App ist der Befehl derselbe; `flutter` verwendet lediglich das mitgelieferte Dart-SDK, führen Sie `dart fix` also im Projektstamm aus, wobei Flutter 3.47 im Pfad liegt.

Beachten Sie, dass aus `var x` ein bloßes `x` wird, also ein implizit `dynamic` typisierter Parameter. Das kompiliert, aber wenn Sie `strict-raw-types` oder ähnliche Analyzer-Einstellungen verwenden, geben Sie ihm bei dieser Gelegenheit einen echten Typ.

### 2. Die Regel "Parameter nicht neu zuweisen" mit einem Lint beibehalten

Die meisten haben `final` an Parametern geschrieben, damit eine Neuzuweisung zum Kompilierfehler wird. Diese Garantie kommt jetzt vom Linter:

```yaml
# analysis_options.yaml, Dart 3.13.3
linter:
  rules:
    - parameter_assignments
```

```dart
// Dart 3.13.3
int clamp(int value, int max) {
  if (value > max) value = max; // info: Invalid assignment to the parameter 'value'.
  return value;
}
```

Greifen Sie nicht zu `prefer_final_parameters`, um das alte Verhalten zurückzuholen. Der Lint ist seit Dart 3.11 abgekündigt, und unter 3.13 erzeugt seine Aktivierung `The lint rule 'prefer_final_parameters' is deprecated and shouldn't be enabled`. Sein Rat würde Sie jetzt zu Code führen, der nicht kompiliert. Wenn das gemeinsame Lint-Paket Ihres Teams ihn noch aktiviert, braucht auch dieses Paket ein Update.

### 3. Eine einzelne Datei auf die alte Sprachversion festlegen

Wenn Sie eine Datei heute nicht anfassen können, etwa generierten Code oder eine eingebundene Bibliothek, nimmt ein Kommentar zur Sprachversion am Dateianfang genau diese eine Bibliothek aus:

```dart
// @dart=3.12
// Dart 3.13.3 SDK, this library uses language version 3.12
int legacyAdd(int a, final int b) => a + b; // compiles
```

Der Rest des Pakets kann Primary Constructors verwenden. Das ist eine Übergangslösung: Eine auf 3.12 festgelegte Datei kann keine Funktion von 3.13 nutzen, und Sie sollten den Kommentar löschen, sobald die Datei bereinigt ist.

### 4. Die SDK-Einschränkung auf 3.12 belassen, bis Sie bereit sind

Da die Prüfung an die Sprachversion Ihres Pakets gekoppelt ist und nicht an das ausgeführte SDK, kompiliert das 3.13-SDK problemlos ein Paket mit der Einschränkung `sdk: ^3.12.0`. Wenn Sie die Einschränkung nur angehoben haben, weil eine Vorlage oder `pub upgrade --major-versions` es für Sie getan hat, ist das Zurücksetzen der Untergrenze eine gültige kurzfristige Lösung. Abhängigkeiten sind in beiden Fällen nicht betroffen: In meiner Reproduktion kompilierte und lief eine Path-Abhängigkeit mit `sdk: ^3.12.0` und `final` an einem Parameter einwandfrei in einer 3.13-App, weil jedes Paket mit seiner eigenen Sprachversion kompiliert wird.

## Eine 3.12-Codebasis vor dem Upgrade vorbereiten

Wenn Sie noch auf Flutter 3.44 / Dart 3.12 sind, können Sie alles finden und beheben, bevor Sie die Einschränkung anheben. Die Seite zu Primary Constructors empfiehlt zwei Lints, die es in 3.12.2 gibt:

```yaml
# analysis_options.yaml, Dart 3.12.2
linter:
  rules:
    - avoid_final_parameters
    - var_with_no_type_annotation
```

Unter 3.12.2 melden diese `Parameters should not be marked as 'final'` und `Avoid declaring parameters with var and no type annotation`, und beide unterstützen `dart fix` (`--code=avoid_final_parameters` und `--code=var_with_no_type_annotation`). Beheben Sie die Warnungen und heben Sie dann `sdk:` auf `^3.13.0` an, dann erzeugt das Upgrade überhaupt keine `extraneous_modifier`-Fehler.

## Stolperfallen und ähnliche Fehler

- **Code-Generatoren erzeugen es auch.** freezed 3.x hat für Collection-Felder Konstruktoren wie `const _Example({required final List<String> someField})` generiert, was in einem 3.13-Paket fehlschlägt ([rrousselGit/freezed#1365](https://github.com/rrousselGit/freezed/issues/1365)). freezed 4.0.0 (2026-08-22) hat `final` in den Parametern generierter Konstruktoren entfernt, und 4.0.2 ist das aktuelle Release. Aktualisieren Sie den Generator und führen Sie `dart run build_runner build` erneut aus. `dart fix` auf `.freezed.dart`-Dateien auszuführen ist sinnlos, weil der nächste Build sie neu generiert. Wenn Sie einen anderen Generator verwenden, suchen Sie in dessen Changelog nach "Dart 3.13" oder "primary constructors", bevor Sie den eigenen Code verdächtigen.
- **Werkzeuge, die Ihren Code parsen, können es auch unter 3.12 treffen.** In #64151 stammte der Fehler von einem Werkzeug, das `parseString()` des Analyzers ohne `featureSet` aufrief. Das nimmt standardmäßig die neueste dem Analyzer bekannte Sprachversion an, sodass Analyzer 13.1.0 und später `final`-Parameter in einem Paket ablehnten, das noch auf einer älteren Sprachversion war. Wenn ein eigener Builder, ein Dokumentationswerkzeug oder ein Code-Metrik-Skript fehlschlägt, während `dart analyze` durchläuft, ist das die Ursache, und die Korrektur gehört in das Werkzeug.
- **Die Meldung erwähnt Primary Constructors nie.** Das Dart-Team hat in #64151 über eine längere Meldung diskutiert und sich dagegen entschieden, deshalb bekommen Sie `Try removing 'final'`. Wenn Sie über genau diese Zeichenfolge hier gelandet sind, ist diese Seite die Erklärung.
- **`var` ohne Typ wird zu `dynamic`.** `dart fix` macht aus `(var x)` ein `(x)`, nicht `(Object? x)`. Ergänzen Sie einen Typ, wenn Ihnen das wichtig ist.
- **Zuordnung der Flutter-Versionen.** Flutter 3.47.0 bis 3.47.5 enthalten Dart 3.13.0 bis 3.13.4. Allein das Upgrade von Flutter ändert nichts; die Fehler erscheinen erst, wenn die Untergrenze `sdk:` eines Pakets 3.13 erreicht. Nach dieser Anhebung schlagen kopierte Snippets aus älteren Antworten, die `final`-Parameter verwenden, sofort fehl.
- **Nicht dasselbe wie `final`-Felder in einem Primary Constructor.** `class User(final String name);` ist gültiger 3.13-Code und deklariert ein Feld. Wenn Sie `extraneous_modifier` an einem Parameter eines Primary Constructors erhalten, prüfen Sie, ob die Parameterliste wirklich im Klassenkopf steht und nicht in einem Konstruktor mit Rumpf.

## Verwandte Artikel

- Das Feature, das dies ausgelöst hat, aus seiner experimentellen Phase: [Primary Constructors in Dart 3.12](/de/2026/06/dart-3-12-experimental-primary-constructors/).
- Eine weitere Überraschung beim 3.13-Upgrade, die in Ihrem Diff nicht sichtbar ist: [CERTIFICATE_VERIFY_FAILED im Dart-3.13-Docker-Image](/de/2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image/).
- Wenn das Anheben der SDK-Einschränkung auch die Auflösung von Abhängigkeiten gebrochen hat, lesen Sie [wie Sie version solving failed in pubspec.yaml beheben](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/).
- Die Wahl zwischen generierten Datenklassen und eingebauten Typen nach dem freezed-4.0-Upgrade: [Dart Records vs. freezed-Klassen](/de/2026/05/dart-records-vs-freezed-classes/).
- Wenn `dart fix` und der Analyzer in einem großen Repository langsam sind, [beschleunigen Sie den Dart Analysis Server in VS Code](/de/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

## Quellen

- [dart-lang/sdk#64151: `final` no longer allowed on parameters of normal functions/methods](https://github.com/dart-lang/sdk/issues/64151)
- [Dart SDK CHANGELOG, 3.13.0 Language section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Primary constructors feature specification (accepted/3.13)](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md)
- [Primary constructors, dart.dev](https://dart.dev/language/primary-constructors)
- [`parameter_assignments` lint rule](https://dart.dev/tools/linter-rules/parameter_assignments)
- [`avoid_final_parameters` lint rule](https://dart.dev/tools/linter-rules/avoid_final_parameters)
- [rrousselGit/freezed#1365: invalid `final` keyword in generated constructor parameters](https://github.com/rrousselGit/freezed/issues/1365)
- [freezed CHANGELOG (4.0.0, 4.0.2)](https://github.com/rrousselGit/freezed/blob/master/packages/freezed/CHANGELOG.md)
