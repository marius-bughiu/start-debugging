---
title: "Dot Shorthands in Dart 3.12: den Typnamen im Flutter-Code weglassen"
description: "Dot Shorthands sind mit Dart 3.12.2 stabil geworden. Schreiben Sie .center oder .new und lassen Sie den Compiler den Typ aus dem Kontext ableiten. So funktionieren sie bei Enums, statischen Membern und Konstruktoren."
pubDate: 2026-07-05
tags:
  - "dart"
  - "flutter"
lang: "de"
translationOf: "2026/07/dart-dot-shorthands-drop-the-type-name-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-05
---

Wenn Ihr Flutter-Widget-Baum eine Wand aus `MainAxisAlignment.center`, `CrossAxisAlignment.start` und `EdgeInsets.all` ist, hat Dart Ihnen gerade einen Weg gegeben, einen Großteil dieser Wiederholung zu löschen. Dot Shorthands, die Funktion, mit der Sie `.center` schreiben und der Compiler den Typ ermittelt, sind mit Dart 3.12.2 stabil geworden. Flutter 3.44 liefert bereits Dart 3.12 aus, wenn Sie also auf dem aktuellen Stable-Kanal sind, können Sie das heute nutzen.

## Was der führende Punkt tatsächlich bewirkt

Ein Dot Shorthand ist ein Ausdruck, der mit einem bloßen `.` beginnt. Wenn der umgebende Kontext den Zieltyp eindeutig macht, löst Dart das Member gegen diesen Typ auf, statt Sie zu zwingen, ihn vollständig auszuschreiben. Der klassische Fall ist ein Enum in einer Zuweisung:

```dart
Status currentStatus = .running; // Instead of Status.running
```

Die Variable ist als `Status` deklariert, also kann `.running` nur `Status.running` bedeuten. Dieselbe Inferenz greift innerhalb eines `switch`, wo der verglichene Wert den Typ bereits festlegt:

```dart
return switch (level) {
  .debug => 'gray',
  .info => 'blue',
  .warning => 'orange',
  .error => 'red',
};
```

## Es sind nicht nur Enums

Der Mechanismus ist allgemein: Jedes statische Member, das über den Kontexttyp erreichbar ist, ist zulässig. Dazu gehören statische Methoden, statische Getter, benannte Konstruktoren und Factory-Konstruktoren.

```dart
int port = .parse('8080');      // int.parse('8080')
BigInt zero = .zero;            // BigInt.zero
Point origin = .origin();       // Point.origin() named constructor
Point p = .fromList([1.0, 2.0]); // Point.fromList(...) factory
```

Der unbenannte Konstruktor erhält für diesen Zweck einen Namen: `.new`. Genau dieses Detail macht die Funktion in echtem Flutter-Code lohnenswert, wo Sie ständig frisch konstruierte Objekte typisierten Feldern zuweisen:

```dart
final ScrollController _scrollController = .new();
final GlobalKey<ScaffoldMessengerState> scaffoldKey = .new();
```

## Die eine Regel, über die man stolpert

Gleichheit hat einen Sonderfall. Wenn Sie ein Shorthand auf der rechten Seite von `==` oder `!=` verwenden, nimmt Dart den statischen Typ des linken Operanden als Kontext:

```dart
if (myColor == .green) {
  print('The color is green.');
}
```

Hier ist `myColor` als `Color` typisiert, also löst sich `.green` zu `Color.green` auf. Das Shorthand muss auf der rechten Seite stehen. Drehen Sie es zu `.green == myColor` um, gibt es keinen linken Operandentyp, aus dem abgeleitet werden könnte, also kompiliert es nicht.

## So aktivieren Sie es

Dot Shorthands erfordern eine Sprachversion von mindestens 3.10, und die Funktion wurde mit Dart 3.12.2 stabil. Wenn Sie bereits auf Flutter 3.44 sind, haben Sie sie. Erhöhen Sie die SDK-Einschränkung in `pubspec.yaml` auf `^3.12.0`, und der Analyzer markiert den führenden Punkt nicht mehr. Es gibt keine Laufzeitkosten und keine Änderung am generierten Code: Dies ist reine Syntax, die zur Kompilierzeit zu dem vollständig qualifizierten Member aufgelöst wird, das Sie ohnehin geschrieben hätten.

Der Gewinn ist nicht kürzerer Code um seiner selbst willen. Es ist, dass der Typ nur einmal erscheint, in der Deklaration, statt bei jedem Wert wiederholt zu werden. Alle Auflösungsregeln finden Sie auf der [Sprachseite zu Dot Shorthands](https://dart.dev/language/dot-shorthands).
