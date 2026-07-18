---
title: "Lösung: type 'Null' is not a subtype of type 'X' in Dart"
description: "Dieser Laufzeitfehler bedeutet, dass ein null zu einer Konvertierung gelangte, die einen nicht nullbaren Typ erwartete, fast immer aus JSON. Machen Sie das Feld nullbar oder liefern Sie einen Standardwert vor der Konvertierung."
pubDate: 2026-07-18
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
lang: "de"
translationOf: "2026/07/fix-type-null-is-not-a-subtype-of-type-in-dart"
translatedBy: "claude"
translationDate: 2026-07-18
---

`type 'Null' is not a subtype of type 'X'` ist ein Typfehler zur Laufzeit: Ein `null` gelangte an eine Stelle in Ihrem Code, an der eine Konvertierung oder eine Zuweisung auf einem nicht nullbaren Typ bestand. Die überwältigend häufige Ursache ist das Parsen von JSON, wo ein Schlüssel fehlt oder als `null` eintrifft und Sie ihn direkt zu `String`, `int` oder einem Modelltyp konvertieren. Die Lösung besteht darin, zu verhindern, dass die Konvertierung ein rohes `null` sieht: Deklarieren Sie entweder den Zieltyp als nullbar (`String?`) und behandeln Sie das null, oder liefern Sie einen Standardwert mit `?? fallback`, bevor die Konvertierung stattfindet. Dies wurde gegen Dart 3.12 (Flutter 3.44) verifiziert; das Verhalten ist seit Dart 2.12 in jeder Version mit solidem null safety gleich geblieben.

## Der Fehler im Kontext

Die Meldung nennt den konkreten Typ, der der Wert sein sollte. Bei einer JSON-Dekodierung sieht sie normalerweise so aus:

```
Unhandled Exception: type 'Null' is not a subtype of type 'String' in type cast
#0      _$UserFromJson (package:myapp/models/user.dart:12:34)
#1      new User.fromJson (package:myapp/models/user.dart:8:7)
#2      fetchUser (package:myapp/api/client.dart:41:24)
<asynchronous suspension>
```

Zwei Wörter in dieser Meldung leisten die ganze Arbeit. Das erste, `'Null'`, ist der Typ, den der Wert zur Laufzeit tatsächlich hatte: Er war `null`. Das zweite, nach "subtype of type", ist das, was der Code verlangte: `'String'`, `'int'`, `'List<dynamic>'`, `'Map<String, dynamic>'` oder eine Ihrer eigenen Modellklassen. Das abschließende `in type cast` sagt Ihnen, dass der Fehler bei einer expliziten oder impliziten `as`-Konvertierung auftrat, was der verräterische Fingerabdruck des Dekodierens von untypisiertem `dynamic`-JSON in typisierte Felder ist.

Sie werden auch die Variante ohne `in type cast` sehen, zum Beispiel `type 'Null' is not a subtype of type 'String'`, wenn der Wert in einen nicht nullbaren Parameter oder ein nicht nullbares Feld statt in einen `as`-Ausdruck fließt. Dieselbe Grundursache, dieselben Lösungen.

## Warum das passiert

Unter solidem null safety ist `Null` ein eigener Typ und kein Subtyp irgendeines nicht nullbaren Typs. Das ist der ganze Sinn von null safety: `String` kann tatsächlich kein `null` enthalten, daher weigert sich die Laufzeit, ein `null` als solches auszugeben. Wenn Sie `json['name'] as String` schreiben und `json['name']` `null` ist, bitten Sie die Laufzeit, `Null` als `String` zu behandeln, und sie wirft den Fehler.

Der Grund, warum das zur Laufzeit statt zur Kompilierzeit auftritt, ist, dass JSON `dynamic` ist. `jsonDecode` gibt `dynamic` zurück, und jeder Zugriff auf ein `Map<String, dynamic>` ist ebenfalls `dynamic`. Der Compiler kann nicht sehen, was tatsächlich in der Map ist, daher vertraut er Ihrer `as String`-Konvertierung und verschiebt die Prüfung auf die Laufzeit. Ist der tatsächliche Wert `null`, schlägt die Prüfung in dem Moment fehl, in dem diese Zeile ausgeführt wird. Deshalb ist der Fehler in `fromJson`-Factories und in von `json_serializable` generiertem Code so häufig: Das sind genau die Stellen, an denen `dynamic`-Werte in typisierte Formen gezwungen werden.

Es gibt drei Situationen, die ihn erzeugen, in etwa nach Häufigkeit geordnet:

- Der JSON-Schlüssel fehlt vollständig, sodass `json['key']` `null` zurückgibt, und Sie konvertieren dieses `null` zu einem nicht nullbaren Typ.
- Der Schlüssel ist vorhanden, aber sein Wert ist JSON-`null`, zum Beispiel eine nullbare Spalte, die aus einem Backend serialisiert wurde.
- Der Wert ist vorhanden, aber hat die falsche Form, zum Beispiel eine Zahl, die als `int` eintrifft, wenn Sie zu `String` konvertieren, oder ein Objekt, wo Sie eine Liste erwartet haben. Dies wirft eine andere Subtyp-Meldung, ist aber dieselbe Fehlerkategorie.

## Minimale Reproduktion

Das kleinste Snippet, das den kanonischen Fall reproduziert:

```dart
// Dart 3.12, Flutter 3.44
import 'dart:convert';

class User {
  final String name;
  final int age;
  User({required this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => User(
        name: json['name'] as String, // throws if 'name' is null or missing
        age: json['age'] as int,
      );
}

void main() {
  // 'name' is absent from the payload
  final payload = jsonDecode('{"age": 30}') as Map<String, dynamic>;
  final user = User.fromJson(payload); // type 'Null' is not a subtype of type 'String'
  print(user.name);
}
```

`json['name']` wird zu `null` ausgewertet, weil der Schlüssel nicht in der Map ist. Die `as String`-Konvertierung versucht dann, `null` als `String` zu sehen, und wirft den Fehler. Beachten Sie, dass die Ausnahme innerhalb von `User.fromJson` ausgelöst wird, nicht beim `print`, weshalb der Stack Trace auf Ihre Modelldatei zeigt und nicht auf das Widget, das die Daten letztlich anzeigte.

## Lösung im Detail

Arbeiten Sie diese der Reihe nach durch. Die ersten beiden decken fast jedes reale Vorkommen ab; der Rest behandelt die Formen, die die einfachen Lösungen nicht abdecken.

### 1. Machen Sie das Feld nullbar, wenn die Daten wirklich fehlen können

Wenn das Backend den Wert legitim weglassen oder auf null setzen kann, modellieren Sie das ehrlich. Deklarieren Sie das Dart-Feld als nullbar und lassen Sie die Konvertierung auf einen nullbaren Typ zielen, dessen Subtyp `null` ist:

```dart
// Dart 3.12, Flutter 3.44
class User {
  final String? name; // was String
  final int age;
  User({this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => User(
        name: json['name'] as String?, // as String?, not as String
        age: json['age'] as int,
      );
}
```

`json['name'] as String?` gelingt, ob der Wert ein `String` oder `null` ist, weil `Null` ein Subtyp von `String?` ist. Der Kompromiss ist, dass jeder Konsument von `name` nun das null behandeln muss, was genau die Korrektheit ist, um deren Anerkennung das Typsystem Sie bittet. Dies ist die richtige Lösung, wenn das Feld wirklich optional ist.

### 2. Liefern Sie einen Standardwert mit ??, bevor der Wert ein nicht nullbares Feld erreicht

Wenn das Feld nicht nullbar bleiben muss, Sie aber einen sinnvollen Ausweichwert wählen können, eliminieren Sie das null, bevor die Konvertierung abgeschlossen ist:

```dart
// Dart 3.12, Flutter 3.44
factory User.fromJson(Map<String, dynamic> json) => User(
      name: json['name'] as String? ?? 'Unknown', // cast to nullable, then default
      age: json['age'] as int? ?? 0,
    );
```

Die Reihenfolge ist wichtig. Konvertieren Sie zuerst zum nullbaren Typ (`as String?`), dann wenden Sie `??` an. Wenn Sie `json['name'] ?? 'Unknown' as String` schreiben, macht die Präzedenz daraus `json['name'] ?? ('Unknown' as String)`, was die linke Seite nicht schützt und immer noch den Fehler wirft, wenn der Wert ein falscher, nicht nullbarer Typ ist. Zu nullbar zu konvertieren und dann zusammenzuführen ist die Redewendung, die sich sauber liest und sich korrekt verhält.

### 3. Konvertieren Sie einen `dynamic`-Map-Wert niemals direkt zu einem nicht nullbaren Typ

Die Angewohnheit, die diesen Fehler verursacht, ist `json['x'] as ConcreteType`. Machen Sie die sichere Form zu Ihrem Standard: Konvertieren Sie zum nullbaren Typ, dann entscheiden Sie, was ein null bedeutet. Für verschachtelte Objekte und Listen gilt dieselbe Regel eine Ebene tiefer:

```dart
// Dart 3.12, Flutter 3.44
// A list that may be absent -> default to empty, never null-cast the elements
final tags = (json['tags'] as List<dynamic>?)
        ?.map((e) => e as String)
        .toList() ??
    <String>[];

// A nested object that may be absent -> guard before recursing
final address = json['address'] == null
    ? null
    : Address.fromJson(json['address'] as Map<String, dynamic>);
```

Den äußeren Container zu `List<dynamic>?` zu konvertieren oder `== null` zu prüfen, bevor Sie rekursiv absteigen, verhindert, dass das `null` je einen Elementwert oder eine verschachtelte Konvertierung erreicht. Hier geht handgeschriebener `fromJson`-Code am häufigsten schief: Das Feld auf oberster Ebene ist geschützt, die Listenelemente oder die verschachtelte Map aber nicht.

### 4. Wenn Sie json_serializable verwenden, machen Sie das Feld nullbar oder geben Sie ihm einen Standardwert

Der generierte `fromJson`-Code konvertiert genauso, wie Sie es von Hand tun würden, daher erzeugt ein nicht nullbares Feld mit `@JsonKey` denselben Laufzeitfehler, wenn die Daten fehlen. Beheben Sie es bei der Modelldeklaration und generieren Sie neu:

```dart
// Dart 3.12, Flutter 3.44, json_serializable 6.x
@JsonSerializable()
class User {
  final String? name;                       // nullable -> generator emits `as String?`
  @JsonKey(defaultValue: 0) final int age;  // default -> used when the key is null/absent
  User({this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);
}
```

Ein nullbares Feld lässt den Generator `as String?` ausgeben. Ein `@JsonKey(defaultValue: ...)` lässt ihn den Standardwert einsetzen, wenn der Schlüssel fehlt oder null ist. Führen Sie nach dem Ändern der Annotationen `dart run build_runner build --delete-conflicting-outputs` aus, sonst ist die alte generierte Konvertierung das, was läuft.

### 5. Beheben Sie die Formabweichung, wenn der Wert nicht wirklich null ist

Wenn der Fehler einen Typ wie `'String'` nennt, das Payload aber eindeutig einen Wert hat, hat der Wert die falsche Form. Ein Backend, das `"age": "30"` (String) sendet, wenn Sie `as int` konvertieren, oder `"30"`, wo Sie eine Zahl erwarten, löst dieselbe Fehlerfamilie aus. Erzwingen Sie explizit, statt zu konvertieren:

```dart
// Dart 3.12, Flutter 3.44
// Backend sends age as a string sometimes, an int other times
final age = json['age'] is int
    ? json['age'] as int
    : int.parse(json['age'].toString());
```

Dies ist nicht der `Null`-Fall, aber es bringt Leute auf diese Seite, weil die Form der Meldung identisch ist. Wenn der Typ in der Meldung auf der linken Seite nicht `'Null'` ist, schauen Sie darauf, was der Server tatsächlich gesendet hat, nicht auf Ihre Null-Behandlung.

## Fallstricke und Varianten

- **Der Stack Trace zeigt auf das Modell, nicht auf die Oberfläche.** Weil die Konvertierung innerhalb von `fromJson` läuft, ist der oberste Frame Ihre Modelldatei. Entwickler beginnen oft, das Widget zu debuggen, das das leere Feld anzeigte; die eigentliche Lösung liegt ein oder zwei Frames tiefer, bei der Konvertierung. Lesen Sie den ersten Frame im Trace, der nicht zum Framework gehört.

- **`as String?` ist nicht dasselbe wie `as String`.** Das einzelne `?` ist in den meisten Fällen die gesamte Lösung. `as String?` erlaubt `null`; `as String` verbietet es. Wenn Sie eine Konvertierung von einem nicht nullbaren Feld zu einem nullbaren kopieren, denken Sie daran, das `?` hinzuzufügen, sonst haben Sie den Fehler verschoben, nicht behoben.

- **`Map<String, dynamic>`-Konvertierungen schlagen auf dieselbe Weise fehl.** `jsonDecode` gibt `dynamic` zurück. Wenn das gesamte Payload `null` ist (ein leerer 204-Antworttext zum Beispiel), dann wirft `jsonDecode(body) as Map<String, dynamic>` `type 'Null' is not a subtype of type 'Map<String, dynamic>'`, bevor Sie überhaupt ein Feld erreichen. Schützen Sie die Dekodierung: `body.isEmpty ? null : jsonDecode(body)`. Das überschneidet sich mit fehlerhafter Eingabe, die in [FormatException: Unexpected character beim Parsen von JSON in Dart](/de/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) behandelt wird.

- **Der Bang-Operator verschiebt den Absturz, er behebt ihn nicht.** `json['name']!` zu schreiben wandelt einen `Null`-Subtypfehler in `Null check operator used on a null value` um. Es ist dasselbe zugrunde liegende null, von einem anderen Mechanismus geworfen. Siehe [Null check operator used on a null value in Flutter](/de/2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter/) dafür, warum `!` für Werte reserviert sein sollte, die Sie als nicht null nachweisen können, nicht dafür verwendet, einen Compiler zum Schweigen zu bringen, mit dem Sie nicht einverstanden sind.

- **`late`-Felder verwandeln dasselbe null in einen anderen Fehler.** Wenn Sie einen möglicherweise nullbaren Wert in ein nicht nullbares `late`-Feld leiten und ihn vor der Zuweisung lesen, erhalten Sie stattdessen `LateInitializationError`. Die Heilung ist dieselbe: Modellieren Sie die Abwesenheit ehrlich, statt einen Wert zu versprechen, den Sie nicht haben. Siehe [LateInitializationError: Field has not been initialized in Flutter](/de/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/).

- **Generische Typargumente verbergen die Konvertierung.** `List<String>.from(json['tags'])` und `(json['tags'] as List).cast<String>()` werfen beide diesen Fehler faul, wenn ein Element `null` ist, und der Trace kann auf `.cast` statt auf Ihren Code zeigen. Bevorzugen Sie ein explizites `.map((e) => e as String?)`, damit der Fehler sichtbar und Ihrer zu behandeln ist.

- **Dies ist ein Laufzeitfehler, daher fangen Tests ihn und der Analyzer nicht.** Der Analyzer kann nicht in eine `dynamic`-JSON-Map hineinsehen, daher bleibt `dart analyze` grün, während die Konvertierung unsicher ist. Ein einziger `fromJson`-Unittest mit einem Payload, das das Feld weglässt, bringt den Fehler ans Licht, bevor ein Benutzer es tut. Wenn Sie eine ältere Codebasis migrieren, geht die [Flutter-null-safety-Migrationscheckliste](/de/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) durch, wo sich diese Konvertierungen gern verstecken.

Das mentale Modell zum Mitnehmen: Dieser Fehler ist null safety, das sich weigert, ein `null` etwas vorgeben zu lassen, das es nicht ist. Der Wert kam als `null` herein, und irgendeine Konvertierung oder Zuweisung stromabwärts versprach, dass er es nicht sein würde. Die Lösung besteht nie darin, die Konvertierung stärker zu erzwingen; sie besteht darin, an der Grenze, an der die `dynamic`-Daten in Ihre typisierte Welt eintreten, zu entscheiden, ob dieses Feld fehlen darf. Wenn ja, machen Sie es nullbar und behandeln Sie das null. Wenn nicht, geben Sie ihm einen Standardwert, bevor die Konvertierung abgeschlossen ist. Tun Sie das bei jedem `json[...]`-Zugriff, und dieser Fehler hört auf zu erscheinen.

## Verwandt

- [Lösung: FormatException: Unexpected character beim Parsen von JSON in Dart](/de/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) für den Geschwisterfehler, wenn das Payload nicht einmal gültiges JSON ist.
- [Lösung: Null check operator used on a null value in Flutter](/de/2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter/) dafür, was passiert, wenn Sie stattdessen zu `!` greifen, um diese Konvertierung zum Schweigen zu bringen.
- [Lösung: LateInitializationError: Field has not been initialized in Flutter](/de/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/) für die `late`-Variante, einen Wert zu versprechen, den Sie nicht haben.
- [Eine Flutter-2-App auf Flutter 3.x migrieren: null-safety-Checkliste](/de/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/), um diese unsicheren Konvertierungen über eine ganze Codebasis hinweg zu finden.

## Quellen

- Dart, [Understanding null safety](https://dart.dev/null-safety/understanding-null-safety) (warum `Null` kein Subtyp jedes Typs mehr ist und warum implizite Downcasts von `dynamic` zu expliziten Konvertierungen wurden, die zur Laufzeit fehlschlagen).
- Dart, [Sound null safety](https://dart.dev/null-safety) (die Garantien, die einen nicht nullbaren `String` `null` zur Laufzeit ablehnen lassen).
- GitHub, [dart-lang/sdk issue #53700](https://github.com/dart-lang/sdk/issues/53700) ("type 'Null' is not a subtype of type 'String'", gemeldet gegen realen JSON-Dekodierungscode, mit der Grundursache des fehlenden Schlüssels).
