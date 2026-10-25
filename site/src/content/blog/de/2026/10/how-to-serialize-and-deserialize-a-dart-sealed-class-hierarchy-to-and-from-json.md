---
title: "Eine Dart-Sealed-Class-Hierarchie nach JSON serialisieren und aus JSON deserialisieren"
description: "Legen Sie ein Diskriminatorfeld ins JSON, schalten Sie in einer Factory der sealed Basisklasse darauf um und schalten Sie zum Zurückschreiben auf den Untertyp um. Drei funktionierende Varianten auf Dart 3.13.7: handgeschriebener Mustervergleich, json_serializable 6.15.2 und Freezed 4.0.3 mit unionKey und fallbackUnion, plus die Fallstricke, die jede Variante verbirgt."
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "json"
  - "freezed"
  - "json-serializable"
  - "sealed-classes"
lang: "de"
translationOf: "2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json"
translatedBy: "claude"
translationDate: 2026-10-25
---

**Kurze Antwort:** JSON weiß nicht, aus welcher Dart-Unterklasse ein Objekt stammt. Sie müssen diese Information also selbst in die Nutzdaten schreiben, meist als Diskriminatorfeld wie `"type": "circle"`. Zum Deserialisieren verwenden Sie eine `factory Shape.fromJson` auf der sealed Basisklasse, die auf dieses Feld umschaltet und an die passende Unterklasse delegiert. Zum Serialisieren verwenden Sie ein `toJson`, das auf `this` umschaltet (dank `sealed` erschöpfend) und den Diskriminator wieder hinzufügt. Das können Sie von Hand mit den Map-Mustern von Dart 3 schreiben, json_serializable die Rümpfe der einzelnen Unterklassen generieren lassen, während Sie die Verteilung selbst schreiben, oder Freezed mit `@Freezed(unionKey: 'type')` alles generieren lassen. Alles unten wurde auf Dart 3.13.7 (dem SDK in Flutter 3.47.8) mit json_serializable 6.15.2, json_annotation 4.12.0, Freezed 4.0.3, freezed_annotation 3.1.0 und build_runner 2.17.1 kompiliert und ausgeführt.

## Warum eine Sealed-Hierarchie nicht von allein einen Round-Trip übersteht

Eine `sealed class Shape` mit den Unterklassen `Circle` und `Rect` gibt Ihnen innerhalb von Dart eine erschöpfende `switch`-Prüfung, aber `jsonDecode` liefert Ihnen immer nur `Map<String, dynamic>`, `List<dynamic>`, `String`, `num`, `bool` und `null`. Nichts in `{"radius": 2}` sagt "das war ein `Circle`". Die Arbeit teilt sich also in zwei Richtungen, die unterschiedliche Werkzeuge brauchen:

- **Dart nach JSON** ist einfach, weil Sie ein echtes Objekt haben. Ein `switch (this)` über einen sealed Typ wird vom Compiler geprüft. Wenn Sie später ein `Triangle` hinzufügen, wird jedes `toJson`, das es vergessen hat, zu einem Kompilierfehler.
- **JSON nach Dart** ist die schwierige Richtung. Sie schalten auf einen *String* aus der Leitung um, und kein Compiler kann prüfen, dass jeder mögliche String auf eine Unterklasse abgebildet wird. Sie brauchen eine Strategie für unbekannte oder fehlende Diskriminatoren.

Der Diskriminator muss nicht `type` heißen. Freezed verwendet standardmäßig `runtimeType`, viele APIs nutzen `kind` oder `@type`, und manche APIs haben gar keinen Diskriminator, sodass Sie den Untertyp daraus ableiten müssen, welche Schlüssel vorhanden sind. Alle drei Ansätze unten decken diese Fälle ab.

## Die minimale Hierarchie und das Wire-Format

Das ist die Form, die in jedem Beispiel verwendet wird:

```json
[
  { "type": "circle", "radius": 2 },
  { "type": "rect", "width": 3, "height": 4.5 }
]
```

Beachten Sie `"radius": 2`. `jsonDecode` macht daraus einen `int`, keinen `double`, was in dem Moment wichtig wird, in dem Ihr Feld als `double` deklariert ist.

## Variante 1: handgeschrieben mit Map-Mustern aus Dart 3

Keine Pakete, keine Codegenerierung. Map-Muster prüfen in einem Schritt, ob der Schlüssel existiert *und* der Wert den richtigen Typ hat:

```dart
// Dart 3.13.7, no packages
sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
        {'type': 'circle', 'radius': num radius} => Circle(radius.toDouble()),
        {'type': 'rect', 'width': num w, 'height': num h} =>
          Rect(w.toDouble(), h.toDouble()),
        {'type': String type} =>
          throw FormatException('Unknown or malformed Shape "$type"', json),
        _ => throw FormatException('Missing "type" discriminator', json),
      };

  Map<String, dynamic> toJson() => switch (this) {
        Circle(:final radius) => {'type': 'circle', 'radius': radius},
        Rect(:final width, :final height) =>
          {'type': 'rect', 'width': width, 'height': height},
      };
}

final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;
}

final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;
}
```

Ausgeführt gegen die obigen Nutzdaten:

```text
[Circle, Rect]
[{"type":"circle","radius":2.0},{"type":"rect","width":3.0,"height":4.5}]
manual unknown THREW FormatException: Unknown or malformed Shape "hexagon"
manual missing type THREW FormatException: Missing "type" discriminator
manual circle missing radius THREW FormatException: Unknown or malformed Shape "circle"
manual radius as string THREW FormatException: Unknown or malformed Shape "circle"
```

Drei Details machen diese Variante besser als das übliche Snippet mit `json['radius'] as double`:

1. **`num` und dann `.toDouble()`.** Der Abgleich mit `'radius': double r` würde bei `2` scheitern, weil der dekodierte Wert ein `int` ist. Der Abgleich mit `num` akzeptiert beides.
2. **Fehlerhafte Nutzdaten schlagen mit Ihrer Meldung fehl, nicht mit einem `TypeError`.** Ein Kreis ohne Radius oder mit `"radius": "2"` passt nicht auf den ersten Fall, fällt zum Fall `{'type': String type}` durch und wirft eine `FormatException`, die die fehlerhafte Map mitführt.
3. **`toJson` wird vom Compiler geprüft.** Wenn Sie `final class Triangle extends Shape` hinzufügen und es vergessen, hält der Analyzer Sie auf:

```text
error - The type 'Shape' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'Triangle()'. Try adding a wildcard pattern or cases that match 'Triangle()'. - non_exhaustive_switch_expression
```

`fromJson` bekommt keine solche Prüfung, weil es auf Map-Inhalte umschaltet. Halten Sie die beiden Switches in der Basisklasse nebeneinander, damit ein Reviewer beide sieht, wenn eine Unterklasse hinzukommt.

### Wenn die API keinen Diskriminator hat

Wenn Sie die Nutzdaten nicht kontrollieren und sie wie `{"radius": 2}` oder `{"width": 3, "height": 4.5}` aussehen, verteilen dieselben Map-Muster stattdessen anhand des *Vorhandenseins* von Schlüsseln:

```dart
// Dart 3.13.7: dispatch on key presence, no "type" field on the wire
factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
      {'radius': num r} => Circle(r.toDouble()),
      {'width': num w, 'height': num h} => Rect(w.toDouble(), h.toDouble()),
      _ => throw FormatException('Not a Shape', json),
    };
```

Die Reihenfolge ist hier wichtig: Map-Muster ignorieren zusätzliche Schlüssel, also setzen Sie den spezifischsten Fall zuerst. Ein `RoundedRect` mit `width`, `height` und `cornerRadius` muss vor `Rect` geprüft werden, sonst wird jedes abgerundete Rechteck zu einem einfachen.

Die handgeschriebene Variante ist die richtige Wahl für drei bis fünf Unterklassen mit je ein paar Feldern. Darüber hinaus steckt der Fehlerteufel im Boilerplate pro Feld, und Codegenerierung rechnet sich.

## Variante 2: json_serializable für die Unterklassen, eigene Verteilung auf der Basisklasse

json_serializable versteht keine Sealed-Hierarchien. Die Feature-Anfrage [google/json_serializable.dart#1342 "Support dart3 sealed class"](https://github.com/google/json_serializable.dart/issues/1342) ist seit August 2023 offen und ist es auch mit 6.15.2 noch. Was das Paket gut kann, ist, den Code Feld für Feld für jede konkrete Klasse zu generieren. Das Muster lautet also: Unterklassen annotieren, die beiden Switches auf der Basisklasse von Hand schreiben.

```dart
// Dart 3.13.7, json_serializable 6.15.2, json_annotation 4.12.0
import 'package:json_annotation/json_annotation.dart';

part 'shape.g.dart';

sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json['type']) {
        'circle' => Circle.fromJson(json),
        'rect' => Rect.fromJson(json),
        final type => throw CheckedFromJsonException(
            json, 'type', 'Shape', 'Unknown Shape type "$type"'),
      };

  Map<String, dynamic> toJson();
}

@JsonSerializable()
final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;

  factory Circle.fromJson(Map<String, dynamic> json) => _$CircleFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'circle', ..._$CircleToJson(this)};
}

@JsonSerializable()
final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;

  factory Rect.fromJson(Map<String, dynamic> json) => _$RectFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'rect', ..._$RectToJson(this)};
}
```

Führen Sie `dart run build_runner build` aus. Das generierte `_$CircleToJson` enthält nur `radius`; es weiß nichts vom Diskriminator, weshalb jede Überschreibung ihn in eine Map spreadet, die mit `'type'` beginnt. Das Werfen von `CheckedFromJsonException` bei unbekannten Typen hält die Fehlerform identisch mit dem, was generierter Code anderswo wirft, sodass ein einziger `on CheckedFromJsonException`-Handler beides abdeckt.

Weil `Shape` jetzt eine `fromJson`-Factory und eine `toJson`-Methode hat, behandelt json_serializable es wie jeden anderen serialisierbaren Typ, wenn es als Feld auftaucht. Eine Container-Klasse funktioniert beim Dekodieren einfach:

```dart
// Dart 3.13.7, json_serializable 6.15.2
@JsonSerializable(explicitToJson: true)
class Drawing {
  Drawing(this.name, this.shapes);
  final String name;
  final List<Shape> shapes;

  factory Drawing.fromJson(Map<String, dynamic> json) => _$DrawingFromJson(json);
  Map<String, dynamic> toJson() => _$DrawingToJson(this);
}
```

Der generierte Decoder ruft für jedes Element `Shape.fromJson(e as Map<String, dynamic>)` auf, die von Ihnen geschriebene Verteilung wird also wiederverwendet. Behalten Sie `explicitToJson: true` bei; der Grund steht unten bei den Fallstricken.

Die eine Schwäche: Fehlt in den Nutzdaten ein Feld, sagt der generierte Code nicht, welches. `Shape.fromJson({'type': 'circle'})` wirft `type 'Null' is not a subtype of type 'num' in type cast`. Fügen Sie den Unterklassen `@JsonSerializable(checked: true)` hinzu, wenn Sie eine `CheckedFromJsonException` mit dem Namen des Schlüssels möchten.

## Variante 3: Freezed generiert die ganze Union

Freezed modelliert eine Sealed-Hierarchie als Klasse mit mehreren Factory-Konstruktoren, und wenn json_serializable ebenfalls eine Dev-Abhängigkeit ist, generiert es die Verteilung, den Diskriminator und den Code pro Fall:

```dart
// Dart 3.13.7, freezed 4.0.3, freezed_annotation 3.1.0, json_serializable 6.15.2
import 'package:freezed_annotation/freezed_annotation.dart';

part 'shape.freezed.dart';
part 'shape.g.dart';

@Freezed(unionKey: 'type', unionValueCase: FreezedUnionCase.snake)
sealed class Shape with _$Shape {
  const factory Shape.circle({required double radius}) = Circle;
  const factory Shape.rect({required double width, required double height}) =
      Rect;
  const factory Shape.roundedRect({
    required double width,
    required double height,
    required double cornerRadius,
  }) = RoundedRect;

  factory Shape.fromJson(Map<String, dynamic> json) => _$ShapeFromJson(json);
}
```

Die Dev-Abhängigkeiten sind `build_runner`, `freezed` und `json_serializable`; die regulären Abhängigkeiten sind `freezed_annotation` und `json_annotation`. Freezed 4.0.3 setzt Dart 3.13 voraus, also bleiben Sie auf Flutter 3.44 (Dart 3.12) bei Freezed 3.2.x, wo dieselben Annotationen funktionieren.

Was der generierte Code tut:

```text
[{"radius":2.0,"type":"circle"},{"width":3.0,"height":4.5,"type":"rect"},{"width":1.0,"height":2.0,"cornerRadius":0.5,"type":"rounded_rect"}]
fz unknown THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "hexagon"!
fz missing type THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "null"!
```

- `unionKey: 'type'` benennt den Diskriminator um. Ohne ihn schreibt und liest Freezed `runtimeType`, sodass ein einfaches `@freezed`-Union `{"n": 1, "runtimeType": "a"}` erzeugt. Das erwartet fast nie ein Backend.
- `unionValueCase` steuert, wie Konstruktornamen zu Werten werden: `roundedRect` wird mit `FreezedUnionCase.snake` zu `rounded_rect`, mit `kebab` zu `rounded-rect`, mit `pascal` zu `RoundedRect` und bleibt mit dem Standard `none` `roundedRect`.
- `@FreezedUnionValue('rounded-rect')` auf einem Konstruktor überschreibt den Wert nur für diesen Fall. So passen Sie ein Wire-Format an, das keiner einheitlichen Schreibweise folgt.
- Die generierten Klassen sind echte Untertypen, sodass ein erschöpfendes `switch (shape) { Circle(:final radius) => ..., Rect() => ..., RoundedRect() => ... }` genau wie in Variante 1 funktioniert.

Wenn Sie die Einstellungen überall statt pro Klasse haben möchten, legen Sie sie in `build.yaml` ab:

```yaml
# build.yaml, freezed 4.0.3
targets:
  $default:
    builders:
      freezed:
        options:
          union_key: type
          union_value_case: snake
```

### Unbekannte Typen: `fallbackUnion`

Clients überleben Server-Deployments. Wenn das Backend einen neuen Ereignistyp hinzufügt, stürzt eine App, die bei unbekannten Diskriminatoren wirft, bei einer Liste ab, die sie sonst hätte darstellen können. Das `fallbackUnion` von Freezed leitet jeden nicht erkannten Wert an einen Konstruktor um:

```dart
// Dart 3.13.7, freezed 4.0.3
@Freezed(unionKey: 'type', fallbackUnion: 'unknown')
sealed class Event with _$Event {
  const factory Event.click({required int x, required int y}) = ClickEvent;
  const factory Event.unknown() = UnknownEvent;

  factory Event.fromJson(Map<String, dynamic> json) => _$EventFromJson(json);
}
```

Das Dekodieren von `{"type": "scroll", "dy": 120}` ergibt `Event.unknown()`, und dessen `toJson()` liefert `{type: scroll}`: Freezed behält den ursprünglichen Diskriminator im versteckten Feld `$type`, aber die Nutzdaten (`dy`) sind weg. Auch ein fehlender `type`-Schlüssel landet im Fallback. Wenn Sie unbekannte Ereignisse originalgetreu erneut senden oder protokollieren müssen, geben Sie dem Fallback-Konstruktor ein Feld vom Typ `Map<String, dynamic>` und befüllen Sie es mit einem eigenen `fromJson`, oder verwenden Sie die handgeschriebene Variante, bei der der Fall `_` die ganze Map behalten kann.

## Fallstricke, die bei jedem Ansatz zubeißen

1. **Verschachteltes `toJson` liefert Objekte statt Maps, solange Sie nicht danach fragen.** Ohne `explicitToJson: true` schreibt json_serializable `'shapes': instance.shapes`. Das Ergebnis von `Drawing.toJson()` ist `{name: d, shapes: [Instance of 'Circle', Instance of 'Rect']}`. `jsonEncode` verbirgt das Problem, weil es `toJson()` auf allem aufruft, was es nicht kodieren kann, sodass der String korrekt aussieht. Alles, was die *Map* verarbeitet (Firestore, `shared_preferences` über eine Map, `Isolate`-Nachrichten, ein Test, der Maps vergleicht), bekommt Dart-Objekte. Freezed hat dasselbe Standardverhalten; die Lösung dort ist, den Factory-Konstruktor zu annotieren:

   ```dart
   // Dart 3.13.7, freezed 4.0.3
   @freezed
   abstract class FzDrawing with _$FzDrawing {
     @JsonSerializable(explicitToJson: true)
     const factory FzDrawing({required String name, required List<Shape> shapes}) =
         _FzDrawing;

     factory FzDrawing.fromJson(Map<String, dynamic> json) =>
         _$FzDrawingFromJson(json);
   }
   ```

   Nach dieser Änderung lieferte `toJson()` `{name: d, shapes: [{radius: 2.0, type: circle}, ...]}`, und der Round-Trip aus Dekodieren, Kodieren und erneutem Dekodieren verglich sich als gleich.

2. **`int` versus `double`.** Generierter Code macht bereits `(json['radius'] as num).toDouble()`. Handgeschriebener Code, der `as double` castet, wirft bei `2`, und das `jsonEncode` von Dart schreibt `2.0` zurück, sodass ein Byte-für-Byte-Vergleich mit den ursprünglichen Nutzdaten fehlschlägt, selbst wenn der Wert korrekt den Round-Trip überstanden hat. Vergleichen Sie dekodierte Objekte, nicht Strings.

3. **Der Diskriminator darf nicht mit einem Feld kollidieren.** Wenn ein Fall bereits ein Feld namens `type` hat, beschwert sich Freezed nicht. Mit `unionKey: 'type'` und `const factory Note.email({required String type, required String to})` lieferte `toJson()` `{type: urgent, to: a}`: Das Feld ersetzte stillschweigend den Diskriminator, sodass das Dekodieren dieser Ausgabe `Invalid union type "urgent"!` wirft. In der Gegenrichtung stopft `Note.fromJson({'type': 'email', 'to': 'a'})` den Diskriminator in das Feld (`Note.email(type: email, ...)`). Wählen Sie einen `unionKey`, den kein Feld verwendet, etwa `kind`. Die handgeschriebene und die json_serializable-Variante haben dieselbe Falle, wenn das `toJson` einer Unterklasse einen `type`-Schlüssel enthält, weil der Spread das Literal überschreibt.

4. **Das Umbenennen eines Konstruktors ist eine Änderung des Wire-Formats.** Bei Freezed wird der Diskriminatorwert aus dem Konstruktornamen abgeleitet. Wenn Sie `Shape.rect` in `Shape.rectangle` umbenennen, ändert das stillschweigend, was Sie senden, und bricht jedes gespeicherte Dokument und jeden älteren Client. Fixieren Sie Werte mit `@FreezedUnionValue('rect')` bei allem, was persistiert oder mit einem anderen Dienst geteilt wird.

5. **Die `build_runner`-Flags haben sich verschoben.** Mit build_runner 2.17.1 gibt `dart run build_runner build --delete-conflicting-outputs` die Meldung `These options have been removed and were ignored: --delete-conflicting-outputs` aus und kompiliert trotzdem. Alte READMEs und CI-Skripte übergeben es weiterhin; die Warnung ist harmlos, aber entfernen Sie das Flag, damit es keine echte Warnung verdeckt.

6. **Generics brauchen `genericArgumentFactories`.** Eine `sealed class Result<T>` mit den Fällen `Ok<T>` und `Err<T>` braucht `@JsonSerializable(genericArgumentFactories: true)` (oder `@Freezed(genericArgumentFactories: true)`), und `fromJson` nimmt dann einen zusätzlichen Parameter `T Function(Object?) fromJsonT` entgegen. Planen Sie diese Signatur ein, bevor Sie `Result.fromJson` über die Codebasis verteilen.

## Welche Variante Sie wählen sollten

- **Handgeschrieben** für kleine, stabile Hierarchien oder wenn die Nutzdaten keinen Diskriminator haben und Sie den Typ aus den Schlüsseln ableiten müssen. Keine Abhängigkeiten, beste Fehlermeldungen, aber jedes Feld ist Code, den Sie pflegen.
- **json_serializable auf den Unterklassen**, wenn Sie es bereits für einfache DTOs verwenden und die Unterklassen als normale Klassen mit eigenen Methoden behalten möchten. Sie schreiben etwa zehn Zeilen Verteilung pro Hierarchie.
- **Freezed**, wenn Sie außerdem `copyWith`, Wertgleichheit und `toString` möchten oder die Hierarchie groß ist. Setzen Sie `unionKey` explizit, fixieren Sie bei persistierten Daten die Werte mit `@FreezedUnionValue` und entscheiden Sie vorab, ob unbekannte Typen eine Ausnahme werfen oder in `fallbackUnion` landen. Der [Vergleich von Records und Freezed](/de/2026/05/dart-records-vs-freezed-classes/) behandelt, wann sich die Codegenerierung von Freezed überhaupt lohnt.

### Weiterlesen

- [Fix FormatException: Unexpected character when parsing JSON in Dart](/de/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) für den Schritt, bevor `fromJson` überhaupt läuft.
- [Fix "type 'Null' is not a subtype of type" in Dart](/de/2026/07/fix-type-null-is-not-a-subtype-of-type-in-dart/), der Fehler, den ein fehlendes Feld in generiertem `fromJson`-Code erzeugt.
- [How to handle network errors gracefully in a Flutter app](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), einschließlich der Frage, wo ein Dekodierfehler in der UI sichtbar werden sollte.
- Das C#-Pendant, [serializing a polymorphic hierarchy with JsonDerivedType in System.Text.Json](/de/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), löst dasselbe Diskriminatorproblem mit Attributen.

### Quellen

- [Dart language: patterns, map patterns](https://dart.dev/language/pattern-types#map) und [class modifiers: sealed](https://dart.dev/language/class-modifiers#sealed)
- [Freezed README: fromJSON for classes with multiple constructors](https://pub.dev/packages/freezed#fromjson---classes-with-multiple-constructors) und das [Freezed changelog](https://pub.dev/packages/freezed/changelog)
- [json_serializable on pub.dev](https://pub.dev/packages/json_serializable) und [issue #1342, sealed class support](https://github.com/google/json_serializable.dart/issues/1342)
- [build_runner changelog](https://pub.dev/packages/build_runner/changelog)
