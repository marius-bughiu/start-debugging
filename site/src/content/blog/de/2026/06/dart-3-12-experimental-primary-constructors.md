---
title: "Dart 3.12 bringt primäre Konstruktoren hinter einem Experiment-Flag"
description: "Dart 3.12 fügt eine experimentelle Syntax für primäre Konstruktoren hinzu, die Felder und einen Konstruktor im Klassenkopf deklariert und die klassische dreizeilige Datenklasse auf eine Zeile reduziert."
pubDate: 2026-06-04
tags:
  - "dart"
  - "flutter"
lang: "de"
translationOf: "2026/06/dart-3-12-experimental-primary-constructors"
translatedBy: "claude"
translationDate: 2026-06-04
---

Dart 3.12 (veröffentlicht am 2026-05-20) brachte eine der meistgewünschten Funktionen der Sprache als experimentelle Vorschau: primäre Konstruktoren. Wenn Sie jemals dasselbe Feld, dazu den Konstruktorparameter `this.field` und dann die Zuweisung dreimal für eine einfache Datenklasse geschrieben haben, ist dies die Syntax, die dieses Muster beseitigt. Vorerst liegt sie hinter `--enable-experiment=primary-constructors`, aber es lohnt sich, sie heute in einem Branch einzubinden, weil sie verändert, wie sich ein großer Teil des alltäglichen Dart-Codes liest.

Das knüpft an die andere Reduzierung von Boilerplate in Dart 3.12 an, die [privaten benannten Parameter als initialisierende Formale](/de/2026/05/dart-3-12-private-named-parameters-initializing-formals/). Primäre Konstruktoren gehen weiter: Sie verschieben die gesamte Deklaration in den Klassenkopf.

## Eine Zeile statt vier

Das ist die Datenklasse, die jeder schreibt, der Teil, den der Compiler von Anfang an hätte generieren sollen:

```dart
class Point {
  final int x;
  final int y;
  Point(this.x, this.y);
}
```

Mit einem primären Konstruktor klappen die Felddeklarationen und der Konstruktor in den Kopf zusammen. Ein leerer Klassenrumpf wird zu einem Semikolon:

```dart
class Point(final int x, final int y);
```

Die Regel ist einfach: Ein im Kopf mit `final` oder `var` markierter Parameter wird zu einem Instanzfeld. Lassen Sie den Modifizierer weg, bleibt er ein gewöhnlicher Konstruktorparameter und kein Feld. So nimmt `class User(String name);` den Wert `name` als Argument an, ohne ihn zu speichern, während `class User(final String name);` ihn speichert.

## Felder können von den Kopfparametern abhängen

Die Kopfparameter sind im Klassenrumpf im Gültigkeitsbereich, sodass Sie andere nicht-`late`-Felder aus ihnen ohne Initialisierungsliste initialisieren können:

```dart
class DeltaPoint(final int x, int delta) {
  final int y = x + delta;
}
```

Hier ist `delta` ein Konstruktorparameter (ohne `final`, also kein Feld) und `y` wird daraus berechnet.

## Validierung mit einem Rumpf hinzufügen

Wenn Sie ein assert oder etwas Setup benötigen, schreiben Sie einen Konstruktorrumpf, der mit `this` eingeleitet wird. Die Form mit reiner Initialisierungsliste endet mit einem Semikolon:

```dart
class Point(var int x, var int y) {
  this : assert(x >= 0 && y >= 0) {
    print('Point initialized at ($x, $y)');
  }
}
```

Auch benannte Konstruktoren erhalten eine kompaktere Form, die `new` im Rumpf verwendet:

```dart
class Pet {
  String name;

  new() : name = 'Fluffy';
  new withName(this.name);
}
```

## So aktivieren Sie es

Die Funktion ist experimentell, daher aktivieren Sie sie pro Ausführung:

```bash
dart run --enable-experiment=primary-constructors bin/main.dart
```

Da sie experimentell ist, behandeln Sie sie als Vorschau: Die Syntax kann sich vor der Stabilisierung noch ändern, und `final` und `var` haben jetzt eine besondere Bedeutung in einer Parameterliste, bringen Sie sie also noch nicht in gemeinsam genutzten Produktionscode ein. Aber für einen Nebenbranch machen primäre Konstruktoren Flutter-Widget-Modelle, Wertobjekte und Konfigurationscontainer deutlich kürzer. Die vollständige Spezifikation, einschließlich der super-Parameter und der Regeln für benannte Konstruktoren, finden Sie in der [Dokumentation zu primären Konstruktoren von Dart](https://dart.dev/language/primary-constructors).
