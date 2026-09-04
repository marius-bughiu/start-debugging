---
title: "Was ist ein Key in Flutter und wann verursacht sein Weglassen Bugs?"
description: "Ein Key ist die Identitätshälfte von Widget.canUpdate, der einen Zeile im Framework, die entscheidet, ob ein Element und sein State wiederverwendet oder verworfen werden. Was das in der Praxis bedeutet, welche Listenänderungen ohne Keys den State beschädigen, welcher Key-Typ passt und wo der Key stehen muss, damit er wirkt."
pubDate: 2026-09-04
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

Ein `Key` ist die Identitätshälfte des einzigen Vergleichs, mit dem Flutter entscheidet, ob ein vorhandenes `Element` (und der daran hängende `State`) für ein neues `Widget` wiederverwendet werden kann. Dieser Vergleich lautet `oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key`. Ohne Key werden Kinder desselben Typs rein nach Position in der Kinderliste zugeordnet. Jede Änderung, die einen Eintrag verschiebt (eine Umsortierung, ein Entfernen in der Mitte, ein Filter), lässt den State am alten Platz hängen, während die Daten an eine andere Stelle rutschen. Sie brauchen genau dann einen Key, wenn ein Widget mit State seine Position unter seinen Geschwistern ändern kann. Alles Folgende bezieht sich auf den aktuellen Stable-Kanal, Flutter 3.47.2 mit Dart 3.13.2, aber die Reconciliation-Regeln sind seit Flutter 1 unverändert.

## Keys sind eine Eingabe von canUpdate, sonst nichts

Das Framework hält drei parallele Bäume: Ihre unveränderliche `Widget`-Konfiguration, den `Element`-Baum, der Rebuilds überdauert, und den `RenderObject`-Baum, der Layout und Painting übernimmt. `State`-Objekte gehören zu den Elements, nicht zu den Widgets. Wenn ein Parent neu baut, wird jede Kindposition über `Element.updateChild` aufgelöst, das eine einzige Frage stellt:

```dart
// package:flutter/src/widgets/framework.dart, Flutter 3.47.2
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType &&
      oldWidget.key == newWidget.key;
}
```

Gibt das `true` zurück, bleibt das vorhandene Element erhalten und wird neu konfiguriert: sein `State` überlebt, `didUpdateWidget` läuft, `initState` nicht. Gibt es `false` zurück, wird das alte Element deaktiviert und ein völlig neues Element inflated, also `dispose` beim Hinausgehen und `initState` beim Hereinkommen. Ist das neue Widget null, wird das Kind ganz entfernt.

Aus dieser Signatur folgen zwei Dinge unmittelbar. Erstens ist ein null-Key ein völlig gültiger Key-Wert, und `null == null` ist `true`, also passen zwei Widgets ohne Key desselben Typs immer zusammen. Zweitens werden Keys nie über Parent-Grenzen hinweg verglichen: Sie werden ausschließlich unter den Kindern eines Elements herangezogen. Die Dokumentation sagt es klar: Keys müssen unter den Elements mit demselben Parent eindeutig sein.

## Der Reconciliation-Durchlauf, der entscheidet, welches Kind welches ist

Entgegen der üblichen Annahme führt Flutter kein allgemeines Tree-Diff aus. Jedes Element gleicht seine eigene Kinderliste in einem linearen `O(N)`-Durchlauf ab, beschrieben in [Inside Flutter](https://docs.flutter.dev/resources/inside-flutter):

1. Beide Listen von oben durchlaufen und zuordnen, solange `runtimeType` und `key` übereinstimmen.
2. Beide Listen von unten durchlaufen und dasselbe tun.
3. Für den nicht zugeordneten Bereich in der Mitte: die alten Kinder nach ihrem `key` in eine Hashtabelle legen, dann den neuen mittleren Bereich durchlaufen und jeden Eintrag nachschlagen.
4. Alte Kinder ohne Treffer werden ausgehängt; neue Widgets ohne Treffer bekommen frische Elements.

Schritt 3 ist der Punkt, an dem Keys ihren Wert liefern. Ein Kind ohne Key hat nichts, was in die Hashtabelle könnte, es kann also nur über die positionsbasierten Durchläufe aus Schritt 1 und 2 zugeordnet werden. Deshalb überstehen Listen ohne Keys das Anhängen am Ende (Schritt 1 ordnet alles zu, der Rest ist neu) und brechen bei allem anderen still zusammen.

## Die minimale Reproduktion: State, der zurückbleibt

Zwei Kacheln, die je einmal in ihrem eigenen `State` eine Farbe wählen, dazu ein Button, der die Liste umdreht. Nichts Exotisches. Seit Flutter 3.47 leben die Material-Widgets im eigenständigen Paket, der Import unterscheidet sich also von älteren Beispielen; die Anleitung zum [Umstellen der Importe auf material_ui](/de/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) hilft, wenn Ihre noch auf die SDK-Kopie zeigen.

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'dart:math';
import 'package:material_ui/material_ui.dart';

class ColorTile extends StatefulWidget {
  const ColorTile({super.key, required this.label});

  final String label;

  @override
  State<ColorTile> createState() => _ColorTileState();
}

class _ColorTileState extends State<ColorTile> {
  // Chosen once when the State is created, and never again.
  late final Color color = Color(0xFF000000 | Random().nextInt(0xFFFFFF));

  @override
  Widget build(BuildContext context) => Container(
        width: 120,
        height: 120,
        color: color,
        alignment: Alignment.center,
        child: Text(widget.label),
      );
}
```

```dart
// Flutter 3.47.2, Dart 3.13.2
class _TileSwapperState extends State<TileSwapper> {
  List<String> labels = ['A', 'B'];

  @override
  Widget build(BuildContext context) => Column(
        children: [
          Row(
            // No keys.
            children: [for (final l in labels) ColorTile(label: l)],
          ),
          TextButton(
            onPressed: () => setState(() => labels = labels.reversed.toList()),
            child: const Text('Swap'),
          ),
        ],
      );
}
```

Drücken Sie Swap: Die Buchstaben tauschen die Plätze, die Farben nicht. Slot 0 enthielt ein `ColorTile` mit null-Key, der neue Slot 0 ist ein `ColorTile` mit null-Key, `canUpdate` liefert `true`, also werden Element und `_ColorTileState` wiederverwendet und nur `widget.label` ändert sich. Die Farbe ist State, und der State blieb, wo er war.

Eine Identität hinzuzufügen behebt das:

```dart
// Flutter 3.47.2, Dart 3.13.2
children: [for (final l in labels) ColorTile(key: ValueKey(l), label: l)],
```

Jetzt scheitern die positionsbasierten Durchläufe an beiden Enden, beide Kinder landen im mittleren Bereich, die Hashtabelle bildet `ValueKey('A')` auf das Element aus Slot 0 ab, und dieses Element wird mit unveränderter Farbe nach Slot 1 umgehängt.

## Die Variante dieses Bugs, die es in Produktion schafft

Eine Zufallsfarbe ist ein Spielzeug. Derselbe Mechanismus beschädigt echte Daten, sobald der State im Zeilen-Widget liegt:

```dart
// Flutter 3.47.2, Dart 3.13.2
// Each row owns a TextEditingController in its State.
Column(
  children: [
    for (final task in tasks) TaskRow(task: task), // no key
  ],
)
```

Löschen Sie die Aufgabe an Index 0. Die Liste schrumpft um eins und alle verbleibenden Aufgaben rücken auf. Die Reconciliation ordnet den alten Slot 0 dem neuen Slot 0 zu, also sitzt der Controller mit der halb getippten Notiz zur gelöschten Aufgabe jetzt in der Zeile, die die *nächste* Aufgabe rendert. `didUpdateWidget` feuert mit einem anderen `widget.task`, aber der Text des Controllers, der Scroll-Offset, die Checkbox, das Expanded-Flag, der Focus Node: nichts davon leitet sich aus `widget` ab, also wandert nichts davon mit. Die Nutzerin sieht ihren Text an einem fremden Datensatz, und beim Speichern schreiben Sie ihn dorthin. Dasselbe Muster zeigt sich bei Expansion Tiles, die das falsche Panel offen halten, bei Animationen, die in der falschen Zeile neu starten, und bei Validierungsfehlern an einem Feld, das niemand angefasst hat. Pro Zeile erzeugte Controller brauchen zudem die übliche Lebenszyklus-Disziplin, ein eigenes und ebenso häufiges Leck: siehe [Controller in Flutter freigeben](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

`ValueKey(task.id)` auf `TaskRow` behebt das alles auf einen Schlag.

## Der Key gehört an das äußerste Widget in der Liste

Keys werden unter Geschwistern eines Parents zugeordnet. Wenn Sie die Zeile umwickeln, ist der Wrapper das Geschwister, also braucht der Wrapper den Key:

```dart
// Wrong: Padding is unkeyed, so Paddings match positionally. The TaskRows
// inside then get compared slot-for-slot, their keys disagree, canUpdate
// returns false, and every row's State is destroyed and rebuilt.
for (final task in tasks)
  Padding(
    padding: const EdgeInsets.all(8),
    child: TaskRow(key: ValueKey(task.id), task: task),
  ),

// Right: the key sits on the widget that is directly a child of the list.
for (final task in tasks)
  Padding(
    key: ValueKey(task.id),
    padding: const EdgeInsets.all(8),
    child: TaskRow(task: task),
  ),
```

Die falsche Variante ist schlimmer als gar kein Key: Statt State falsch zuzuordnen, wirft sie ihn bei jeder Umsortierung weg, was sich als Flackern, neu startende Animationen und geleerte Textfelder zeigt.

Die zweite sichere Methode, einen wirkungslosen Key zu schreiben, ist `ValueKey(index)`. Der Index *ist* die positionsbasierte Identität, die Sie ohnehin schon hatten, ein Key darauf reproduziert also exakt das Verhalten ohne Key und sieht dabei nach einer Lösung aus. Nehmen Sie etwas, das dem Eintrag gehört: eine Datenbank-ID, eine UUID, einen Slug.

## Welcher Key-Typ

| Typ | Identität | Passend, wenn |
| ---- | -------- | ----------------- |
| `ValueKey<T>(v)` | `runtimeType` und `v ==` | Der Eintrag hat einen stabilen fachlichen Wert: ID, Slug, ISO-Datum als String. Die Standardwahl. |
| `ObjectKey(o)` | `identical(o, other.value)` | Das Modell überschreibt `==` wertbasiert (Records, Freezed-Klassen), zwei gleiche Instanzen müssen aber unterscheidbar bleiben. |
| `UniqueKey()` | Nur zu sich selbst gleich | Sie wollen einmalig einen frischen Teilbaum erzwingen. Konstruieren Sie ihn nie in `build`; eine neue Instanz pro Frame heißt `canUpdate` false in jedem Frame und ein Teilbaum, der ewig bei null neu beginnt. |
| `PageStorageKey<T>(v)` | Ein `ValueKey`, der zusätzlich einen Slot im umgebenden `PageStorage` benennt | Einen Scroll-Offset über einen Route-Push oder Tab-Wechsel hinweg erhalten, wo das Element selbst zerstört wird. |
| `GlobalKey` | App-weit eindeutig; stellt `currentState`, `currentContext`, `currentWidget` bereit | Einen Teilbaum mitsamt State an einen anderen Parent hängen oder einen `FormState` von außerhalb seines Teilbaums erreichen. |

`Key('some string')` ist eine Factory, die ein `ValueKey<String>` liefert, also dasselbe mit weniger Zeichen.

## GlobalKey ist ein anderes Werkzeug und kostet wirklich etwas

Ein `GlobalKey` ist der einzige Key, der über Parent-Grenzen hinweg funktioniert, was das Umhängen eines Teilbaums überhaupt erst möglich macht, und der einzige, der Ihnen den `State` des Kindes gibt:

```dart
// Flutter 3.47.2, Dart 3.13.2
class _CheckoutFormState extends State<CheckoutForm> {
  // Long-lived: a field on the State, not a local in build().
  final _formKey = GlobalKey<FormState>();

  void _submit() {
    if (_formKey.currentState?.validate() ?? false) {
      _formKey.currentState!.save();
    }
  }

  @override
  Widget build(BuildContext context) => Form(key: _formKey, child: /* ... */);
}
```

Drei Dinge beißen hier. Umhängen über einen `GlobalKey` ist laut Dokumentation relativ teuer: Es löst `State.deactivate` aus und zwingt jedes Widget, das in diesem Teilbaum von einem `InheritedWidget` abhängt, zum Rebuild, was zugleich der schnellste Weg zu [einem Ancestor-Lookup auf einem deaktivierten Widget](/de/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) ist. Den Key in `build` zu konstruieren zerstört den State des Teilbaums in jedem Frame, und zwar lautlos: Ein `GestureDetector` unter einem neu erzeugten `GlobalKey` verliert mitten in einer Drag-Geste einfach die Spur. Und zwei lebende Widgets mit demselben `GlobalKey` sind eine Assertion, "Multiple widgets used the same GlobalKey". Deshalb stürzt eine geteilte Widget-Instanz, die in zwei Zweigen einer `TabBarView` oder unter verschachtelten `Navigator`s wiederverwendet wird, ab, statt sich nur schlechter zu verhalten.

Nehmen Sie einen `LocalKey`, sofern Sie nicht ausdrücklich parentübergreifende Identität oder `currentState` brauchen.

## Keys funktionieren auch andersherum: ein Reset erzwingen

Weil ein `canUpdate` von false dispose und danach initState bedeutet, ist das absichtliche Ändern eines Keys der sauberste Weg, einen Teilbaum zurückzusetzen. Ein Detailbereich, der innerhalb derselben Route den Datensatz wechselt, ist der Standardfall:

```dart
// Flutter 3.47.2, Dart 3.13.2
// Without the key, switching selectedOrderId reuses the same State, so the
// TextEditingController inside OrderEditor still holds the previous order's
// notes and any AnimationController keeps its current value.
OrderEditor(
  key: ValueKey(selectedOrderId),
  orderId: selectedOrderId,
)
```

Das ist derselbe Fehler, der ein in `build` erzeugtes `Future` bei unbeteiligten Rebuilds erneut auslöst, nur von der anderen Seite betrachtet: Mal wollen Sie den Reset, mal wollen Sie ihn verhindern, und entschieden wird das immer über die Frage, ob sich die Identität geändert hat. Die [FutureBuilder-Variante dieses Problems](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) liest sich gut daneben.

Bei zwei Widgets ist der Key Pflicht statt Empfehlung: `Dismissible` wirft bei null-Key eine Assertion, weil ein positionsbasiert zugeordnetes Wischen zum Entfernen die falsche Zeile hinausanimieren würde, und `ReorderableListView` verlangt aus genau demselben Grund einen Key an jedem Kind.

## Wann der Key entfallen kann

- **Der Teilbaum hat keinen State.** Ist alles unterhalb des Kindes stateless und leitet sich jedes Pixel aus den eigenen Feldern des Widgets ab, liefert die positionsbasierte Zuordnung das richtige Ergebnis. Das Umsortieren von stateless Kindern ohne Key kostet etwas zusätzliche Rebuild-Arbeit, ist aber kein Korrektheitsfehler.
- **Die Liste wächst nur am Ende.** Rein anhängende Feeds sind vom Durchlauf von oben vollständig abgedeckt.
- **Benachbarte Kinder unterscheiden sich bereits im `runtimeType`.** `canUpdate` ist ohnehin false, ein Key ändert nichts.
- **Sie versehen ein einzelnes Kind ohne Geschwister mit einem Key.** Der `body` eines `Scaffold` hat einen Slot; es gibt nichts zu unterscheiden.

Der Parameter `super.key` an jedem Widget-Konstruktor ist eine Konvention für Aufrufer, kein Hinweis darauf, dass Sie dort etwas übergeben sollten.

## Zwei Grenzen, die man kennen sollte, bevor man Keys vertraut

Keys hebeln das Viewport-Recycling nicht aus. `ListView.builder` und die Sliver-Familie zerstören Elements, sobald ein Eintrag über den Cache Extent hinausscrollt, mit oder ohne Key, und bauen sie beim Zurückscrollen neu auf. Muss sich eine Zeile über diese Grenze hinweg etwas merken, heben Sie den State entweder in Ihr Modell oder nutzen `AutomaticKeepAliveClientMixin`, auf Kosten des Speichers, den das Recycling gerade eingespart hat. Es ist dieselbe Budgetfrage, die auftaucht, wenn Sie [Listen- und Grid-Abschnitte mit Slivern in einer Scroll-Ansicht kombinieren](/de/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

Und doppelte `LocalKey`s unter Geschwistern sind eine Assertion im Debug-Modus, "Duplicate keys found. If multiple keyed widgets exist as children of another widget, they must have unique keys", ausgelöst von `debugChildrenHaveDuplicateKeys`. Meist heißt das, dass das als Key gewählte Feld weniger eindeutig ist als angenommen, ein Datenfehler im Gewand eines Framework-Fehlers.

Der tiefere Punkt: Ein Key repariert die Reconciliation, nicht die Architektur. Jeder der obigen Bugs entsteht, weil State pro Eintrag im `State` eines Widgets liegt, wo seine Identität standardmäßig positionsbasiert ist. State, der zu einer Aufgabe gehört, sollte bei der Aufgabe liegen, und sobald er das tut, stellt sich die Umsortierungsfrage gar nicht mehr. Das ist der Großteil des Arguments dafür, [setState-State in einen Riverpod-Notifier zu verschieben](/de/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/). Für wirklich flüchtigen State pro Element wie Scroll-Offsets, Fokus und Animation Controller bleiben Keys die richtige Antwort, und dort sollten Sie sie bewusst setzen, statt sie zu verstreuen.

## Verwandte Artikel

- [Controller in Flutter freigeben, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Lösung: Looking up a deactivated widget's ancestor is unsafe in Flutter](/de/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/)
- [Wie man ein Future so initialisiert, dass FutureBuilder es nicht bei jedem Rebuild neu erstellt](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [Wie man eine ListView und eine GridView mit Slivern in einer Scroll-Ansicht kombiniert](/de/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/)
- [Ein StatefulWidget mit setState zu einem Riverpod Notifier in Flutter migrieren](/de/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)

## Quellen

- [Inside Flutter: lineare Reconciliation](https://docs.flutter.dev/resources/inside-flutter)
- [Widget.canUpdate, Flutter-API-Dokumentation](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Element.updateChild, Flutter-API-Dokumentation](https://api.flutter.dev/flutter/widgets/Element/updateChild.html)
- [Klasse Key, Flutter-API-Dokumentation](https://api.flutter.dev/flutter/foundation/Key-class.html)
- [Klasse GlobalKey, Flutter-API-Dokumentation](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [Klasse PageStorageKey, Flutter-API-Dokumentation](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
- [debugChildrenHaveDuplicateKeys, Flutter-API-Dokumentation](https://api.flutter.dev/flutter/widgets/debugChildrenHaveDuplicateKeys.html)
- [AutomaticKeepAliveClientMixin, Flutter-API-Dokumentation](https://api.flutter.dev/flutter/widgets/AutomaticKeepAliveClientMixin-mixin.html)
- [Was ist neu in Flutter 3.47, Flutter-Blog](https://flutter.dev/blog/whats-new-in-flutter-3-47)
