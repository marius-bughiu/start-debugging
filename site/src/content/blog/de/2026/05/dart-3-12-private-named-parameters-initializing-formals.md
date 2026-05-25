---
title: "Dart 3.12 macht Schluss mit der Initialisierungsliste für private Felder"
description: "Dart 3.12 erlaubt Konstruktoren, private Felder direkt über benannte Parameter zu initialisieren, und beseitigt damit eines der hartnäckigsten Boilerplate-Muster der Sprache."
pubDate: 2026-05-25
tags:
  - "dart"
  - "flutter"
lang: "de"
translationOf: "2026/05/dart-3-12-private-named-parameters-initializing-formals"
translatedBy: "claude"
translationDate: 2026-05-25
---

Dart 3.12 erschien auf der Google I/O 2026 zusammen mit Flutter 3.44, und im Release versteckt sich eine kleine Sprachänderung, die ein Stück Boilerplate-Code entfernt, den jeder Dart-Entwickler schon hundertmal geschrieben hat. Sie können jetzt private benannte Parameter als initializing formals verwenden. Einfach gesagt: Ein Konstruktor kann ein benanntes Argument entgegennehmen und es direkt einem privaten Feld zuweisen, ohne dass eine Initialisierungsliste nötig ist.

## Das Underscore-Problem, das Dart jahrelang mit sich trug

Dart kennzeichnet ein Feld als privat, indem ein Underscore vorangestellt wird. Diese Konvention kollidierte mit benannten Konstruktorparametern, denn die Sprache erlaubte es nicht, dass ein benannter Parameter mit `_` beginnt. Das Ergebnis war ein bekannter Tanz: einen Parameter mit öffentlichem Namen entgegennehmen und ihn dann in der Initialisierungsliste manuell in das private Feld kopieren.

```dart
class Hummingbird {
  final String _petName;
  final int _wingbeatsPerSecond;

  Hummingbird({required String petName, required int wingbeatsPerSecond})
    : _petName = petName,
      _wingbeatsPerSecond = wingbeatsPerSecond;
}
```

Jedes private Feld bedeutete eine Parameterdeklaration plus einen Eintrag in der Initialisierung. Bei einer Klasse mit acht privaten Feldern sind das sechzehn Zeilen reine Verdrahtung. Die initializing formals (`this.field`) lösten dies vor Jahren für öffentliche Felder, aber private Felder blieben auf dem langsamen Weg.

## Was sich mit 3.12 tatsächlich ändert

Dart 3.12 lässt das Naheliegende funktionieren. Schreiben Sie `this._field` als benannten Parameter, und der Compiler erledigt den Rest:

```dart
class Hummingbird {
  final String _petName;
  final int _wingbeatsPerSecond;

  Hummingbird({required this._petName, required this._wingbeatsPerSecond});
}
```

Das Feld bleibt privat, aber der dem Aufrufer angezeigte Parametername ist die öffentliche Version ohne den Underscore. Die Aufrufstelle liest sich also genau wie zuvor:

```dart
void main() {
  print(Hummingbird(petName: 'Dash', wingbeatsPerSecond: 75));
}
```

Dies ist eine reine Änderung auf der Konstruktorseite. Die öffentliche API ist identisch, der Aufrufer ändert nichts, und die privaten Felder bleiben privat. Sie löschen lediglich die Initialisierungsliste, mehr nicht.

## Die Einschränkungen, die man kennen sollte

Diese Ausnahme gilt nur für initializing formals. Ein normaler benannter Parameter darf weiterhin nicht mit einem Underscore beginnen, denn das würde einen privaten Namen in die öffentliche Signatur durchsickern lassen, ohne dass ein öffentlicher Name als Rückgriff existiert. Der Name mit Underscore muss zudem einem gültigen öffentlichen Bezeichner entsprechen: `this._` und `this._2x` werden abgelehnt, denn nach Entfernen des Underscores bleibt `` beziehungsweise `2x`, und beides ist kein gültiger Parametername.

Die Funktion lässt sich auch mit den primary constructors kombinieren, die im selben Zyklus als Experiment erschienen und eine Sprachversion von mindestens 3.13 erfordern. Mit beiden im Einsatz können Sie ein privates Feld direkt im Konstruktorkopf deklarieren und den Compiler den öffentlich sichtbaren Namen automatisch veröffentlichen lassen.

Wenn Sie bereits auf Flutter 3.44 sind, haben Sie Dart 3.12 und können dies heute nutzen. Erhöhen Sie die SDK-Einschränkung in Ihrer `pubspec.yaml` auf `^3.12.0`, führen Sie `dart fix` aus und beginnen Sie, Initialisierungslisten zu löschen. Die vollständigen Release Notes finden Sie in der [Ankündigung von Dart 3.12](https://dart.dev/blog/announcing-dart-3-12).
