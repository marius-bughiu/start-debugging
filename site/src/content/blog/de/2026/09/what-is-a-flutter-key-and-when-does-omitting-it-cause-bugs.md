---
title: "Was ist ein Key in Flutter und wann verursacht sein Weglassen Bugs?"
description: "Flutter-Keys identifizieren Zeilen beim Umsortieren. Wann ValueKey genügt, wann ein Lazy Builder einen Index-Callback braucht und wie GlobalKey den State erhält."
pubDate: 2026-09-04
updatedDate: 2026-11-02
tags:
  - "flutter"
  - "dart"
  - "state-management"
  - "listview"
lang: "de"
translationOf: "2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs"
translatedBy: "claude"
translationDate: 2026-09-04
---

Ein Flutter-Key hilft einem Parent, eine neue Widget-Konfiguration einem bestehenden Element zuzuordnen. `Widget.canUpdate` prüft gleichen `runtimeType` und gleiche Keys. Eine Zeile ohne Key kann ihren State behalten, obwohl andere Daten in ihren Slot rücken. Das ist wichtig, wenn Textcontroller, Fokus oder Animation zu einem bestimmten Element gehören.

**Korrektur, 2. November 2026.** Bei geänderter Reihenfolge eines Lazy Builders reicht ein stabiler Key allein unter Umständen nicht. Deaktivierung bedeutet außerdem keine sofortige Freigabe. Fünf Widget-Tests prüften normale Zeilen, Lazy-Zeilen und einen `GlobalKey`-Wechsel unter Flutter 3.44.8 / Dart 3.12.2. Die Beispiele verwenden die Widgets-Bibliothek.

## Normale Geschwister: Element statt Position identifizieren

```dart
import 'package:flutter/widgets.dart';

class RowLabel extends StatefulWidget {
  const RowLabel(this.id, {super.key});
  final String id;

  @override
  State<RowLabel> createState() => _RowLabelState();
}

class _RowLabelState extends State<RowLabel> {
  late final String createdFor = widget.id;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 48,
    child: Text('row=${widget.id}, state=$createdFor'),
  );
}

Widget rows(List<String> ids, {required bool stableKeys}) => Column(
  children: [
    for (final id in ids)
      RowLabel(id, key: stableKeys ? ValueKey<String>(id) : null),
  ],
);
```

Rendern Sie `rows(['A', 'B'], stableKeys: false)` unter `Directionality` und bauen Sie mit `['B', 'A']` neu. Die erste Zeile zeigt `row=B, state=A`: Die Konfiguration änderte sich, der State des Slots blieb. Mit `stableKeys: true` bewegt sich der State von A mit A. `ValueKey(index)` identifiziert dagegen den Slot. IDs müssen unter Geschwistern eindeutig und stabil sein.

Setzen Sie den Key am direkten Kind, das der Parent umsortiert. Wenn `Padding` die Zeile umschließt, gehört der Key an `Padding`. Auch ein einzelner Teilbaum kann beim Datensatzwechsel bewusst über einen neuen Key zurückgesetzt werden. Für Übergänge siehe [AnimatedSwitcher und Child-Keys](/de/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/).

## Lazy Builder: Keys den neuen Indizes zuordnen

`ListView.builder` erzeugt Kinder bei Bedarf. Bei geänderter Reihenfolge kann `findChildIndexCallback` dem Delegate den neuen Index eines bereits gebauten Kinds liefern. Erstellen Sie die Zuordnung aus denselben sortierten Daten wie `itemBuilder`; für entfernte IDs wird `null` zurückgegeben:

```dart
Widget lazyRows(List<String> ids, {bool remap = true}) {
  final indexById = {for (var i = 0; i < ids.length; i++) ids[i]: i};
  int? indexForKey(Key key) => key is ValueKey<String> ? indexById[key.value] : null;

  return ListView.builder(
    itemCount: ids.length,
    findChildIndexCallback: remap ? indexForKey : null,
    itemBuilder: (_, index) {
      final id = ids[index];
      return RowLabel(id, key: ValueKey<String>(id));
    },
  );
}
```

Der Test änderte bei vollständig sichtbaren Zeilen `[A, B, C]` zu `[C, B, A]`. Mit Callback behielt A dieselbe `State`-Instanz. Mit `remap: false` erhielt A in diesem Test neuen State. Laut Flutter **kann** fehlende Indexzuordnung State-Verlust verursachen. Ein Key hält außerhalb des Sichtbereichs liegende Kinder nicht automatisch am Leben. Dauerhafte Daten gehören ins Modell; Keep-alive passend wählen.

## Deaktivieren, erneut einsetzen oder freigeben

Ein kompatibles stateful Element kann eine neue Konfiguration ohne neuen `State` erhalten. Ein entferntes Element wird zuerst deaktiviert. Ein Teilbaum mit `GlobalKey` kann im selben Frame unter einem anderen Parent wieder eingesetzt und mit seinem State aktiviert werden. Bei endgültiger Entfernung folgt `dispose` nach der Deaktivierung.

Im Test ergab der Wechsel zwischen zwei Parents `init → deactivate → activate` mit demselben State. Die Entfernung im nächsten Frame ergab `deactivate → dispose`. Eigene Controller in `dispose` freigeben. Siehe [Controller korrekt freigeben](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) und [Ancestor-Zugriff nach Deaktivierung](/de/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/).

## Geeigneten Key auswählen

| Key | Identität |
| --- | --- |
| `ValueKey(id)` | Gleicher Typ und Wert. Für Zeilen eine stabile fachliche ID nutzen. |
| `ObjectKey(object)` | Dieselbe Objektinstanz. Neu erzeugte Modelle können die Identität ändern. |
| `UniqueKey()` | Eine bestimmte Key-Instanz. Ein neuer Key bei jedem Build ersetzt wiederholt den State. |
| `PageStorageKey(value)` | Speicherort in `PageStorage`, oft für Scrollpositionen. Er hält nicht den gesamten State. |
| `GlobalKey` | Baumweit eindeutig für Reparenting im selben Frame oder Zugriff auf State. Instanz außerhalb von `build` halten. |

Bei festen zustandslosen Kindern oder reinem Anhängen kann ein Key entbehrlich sein. Verwenden Sie stabile Item-Keys, wenn State einem Eintrag durch Änderungen folgen muss.

## Quellen

- [Widget.canUpdate](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Inside Flutter: linear reconciliation](https://docs.flutter.dev/resources/inside-flutter)
- [SliverChildBuilderDelegate.findChildIndexCallback](https://api.flutter.dev/flutter/widgets/SliverChildBuilderDelegate/findChildIndexCallback.html)
- [State.deactivate](https://api.flutter.dev/flutter/widgets/State/deactivate.html) · [GlobalKey](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [PageStorageKey](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
