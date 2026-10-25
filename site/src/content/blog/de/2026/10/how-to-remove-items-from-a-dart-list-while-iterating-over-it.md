---
title: "Elemente aus einer Dart-List entfernen, während man darüber iteriert, ohne ConcurrentModificationError"
description: "remove in einer for-in-Schleife oder in forEach wirft ConcurrentModificationError. Mit removeWhere wird direkt gefiltert, mit where oder einem collection-for entsteht eine neue Liste, oder die Index-Schleife läuft rückwärts. Verifiziert mit Dart 3.13.7, inklusive Benchmark, der zeigt, warum removeAt in einer Schleife die langsame Variante ist."
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "collections"
  - "errors"
lang: "de"
translationOf: "2026/10/how-to-remove-items-from-a-dart-list-while-iterating-over-it"
translatedBy: "claude"
translationDate: 2026-10-25
---

**Kurze Antwort:** `remove`, `removeAt` oder `add` lassen sich nicht auf einer `List` aufrufen, während eine `for (final x in list)`-Schleife oder `list.forEach` sie durchläuft, denn der Iterator prüft bei jedem Schritt die Länge der Liste und wirft `ConcurrentModificationError`, sobald sie sich ändert. Ersetzen Sie die Schleife durch `list.removeWhere((x) => condition)`, um direkt in der Liste zu filtern, oder erzeugen Sie mit `list.where((x) => !condition).toList()` (oder einem collection-for) eine neue Liste, wenn Sie eine unveränderliche Aktualisierung wollen. Wenn wirklich eine Index-Schleife nötig ist, läuft sie rückwärts von `list.length - 1` bis `0`. Alles Folgende wurde mit Dart 3.13.7 (dem SDK aus Flutter 3.47.8) ausgeführt, auf der VM, als AOT und nach JavaScript kompiliert.

## Der Fehler im Kontext

Diesen Code schreibt fast jeder zuerst:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3];
  for (final n in numbers) {
    if (n == 1) numbers.remove(n);
  }
}
```

Und das gibt die VM aus:

```
Unhandled exception:
Concurrent modification during iteration: Instance(length:2) of '_GrowableList'.
#0      ListIterator.moveNext (dart:_internal/iterable.dart:366:7)
#1      main (file:///.../main.dart:4:19)
```

Das `length:2` in der Meldung ist die Länge der Liste *nach* Ihrer Änderung, und `_GrowableList` ist die Implementierungsklasse der VM für ein normales `[]`-Literal. Im Web scheitert derselbe Code mit `Concurrent modification during iteration: Instance of 'JSArray<int>'.`, suchen Sie in Ihren Logs also nicht nach `_GrowableList`, wenn der Bugreport aus einem Flutter-Web-Build stammt. Maps und Sets erzeugen eigene Varianten, `_Map len:2.` und `_Set len:2.`, mit derselben Ursache.

## Warum der Iterator wirft, statt einfach weiterzuspringen

Eine `for-in`-Schleife über eine `List` ist syntaktischer Zucker dafür, `list.iterator` zu holen und `moveNext()` aufzurufen, bis es `false` zurückgibt. Der Iterator, den Dart für Listen verwendet, `ListIterator` in `dart:_internal`, merkt sich beim Erzeugen die Länge der Liste und vergleicht sie bei jedem `moveNext()`:

```dart
// dart:_internal, sdk/lib/internal/iterable.dart (Dart 3.13.7)
bool moveNext() {
  int length = _iterable.length;
  if (_length != length) {
    throw ConcurrentModificationError(_iterable);
  }
  if (_index >= length) {
    _current = null;
    return false;
  }
  _current = _iterable.elementAt(_index);
  _index++;
  return true;
}
```

`List.forEach` führt dieselbe Prüfung nach jedem Callback durch, `removeWhere` prüft in seiner eigenen Schleife, und der Fehler wird erst beim *nächsten* Schritt geworfen, nicht in der Zeile, die die Liste verändert hat. Deshalb zeigt der Stack Trace auf `moveNext` und nicht auf `remove`.

Die [Dokumentation von `Iterable`](https://api.dart.dev/dart-core/Iterable-class.html) formuliert den Vertrag klar: Eine Collection während der Iteration zu ändern, ist grundsätzlich nicht erlaubt, und der Abbruch wird typischerweise durch einen ConcurrentModificationError beim nächsten Aufruf von Iterator.moveNext signalisiert. Die Prüfung existiert, weil die Alternative schlimmer wäre. Das Entfernen von Element `i` verschiebt alles danach um eine Position nach links, ein indexbasierter Iterator würde also stillschweigend das Element überspringen, das auf Position `i` nachgerückt ist. Dart entscheidet sich für ein lautes Scheitern.

Zwei Folgen des "nächsten `moveNext()`" überraschen viele:

- **Auch das Entfernen des letzten Elements wirft.** Man könnte erwarten, dass das Entfernen von `4` aus `[1, 2, 3, 4]` in der letzten Iteration sicher ist, weil nichts mehr zu besuchen bleibt. Ist es nicht. Die Schleife ruft `moveNext()` noch einmal auf, um festzustellen, dass sie fertig ist, sieht die geänderte Länge und wirft.
- **Auch Hinzufügen wirft.** `numbers.add(x)` in der Schleife ändert die Länge genauso wie `remove`. Dart hat kein `Iterator.remove()` wie Java, es gibt also keinen "sicheren" Weg, über den Iterator selbst zu verändern.

## Die passende Lösung wählen

So entscheide ich. Jede Option wird weiter unten ausführlich behandelt.

1. Sollen Elemente direkt aus der bestehenden Liste verschwinden, rufen Sie `removeWhere` auf (oder `retainWhere` für das Gegenteil).
2. Gehört die Liste zu unveränderlichem State (Riverpod, Bloc, `ValueNotifier`, ein `final`-Feld, das an Widgets übergeben wird), erzeugen Sie mit `where(...).toList()` oder einem collection-for eine neue Liste und weisen sie zu.
3. Hängt die Entscheidung vom Index oder von benachbarten Elementen ab, läuft eine Index-Schleife rückwärts und verwendet `removeAt`.
4. Leistet der Schleifenrumpf viel Arbeit und entfernt nur ein Teil davon Elemente, iterieren Sie über eine Kopie (`for (final x in list.toList())`) und entfernen aus dem Original.

## Lösung 1: `removeWhere` für direktes Filtern

Das ist die kanonische Antwort und sollte Ihr Standard sein:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 2, 3];
  numbers.removeWhere((n) => n == 2);
  print(numbers); // [1, 3]

  final tasks = <({String title, bool done})>[
    (title: 'write post', done: true),
    (title: 'review PR', done: false),
  ];
  tasks.retainWhere((t) => !t.done);
  print(tasks); // [(done: false, title: review PR)]
}
```

`removeWhere` kommt mit einem einzigen Durchlauf aus. In der gemeinsamen `ListBase`-Implementierung geht es die Liste einmal durch, sammelt die verbleibenden Elemente, schreibt sie mit einem einzigen `setRange` zurück und kürzt die Länge. Es entfernt alle Treffer, anders als `remove`, das nur das erste Element entfernt, das dem Argument gleicht. Außerdem ist es mit großem Abstand die schnellste Variante, siehe Benchmark weiter unten.

Maps und Sets haben dieselbe Methode. `map.removeWhere((key, value) => value == 2)` und `set.removeWhere((x) => x.isEven)` beheben die `_Map`- und `_Set`-Varianten dieses Fehlers.

Eine Regel gilt auch im Prädikat: Verändern Sie die Liste nicht aus `test` heraus. Ein Prädikat, das `numbers.add(...)` aufruft, wirft `ConcurrentModificationError` aus `removeWhere` heraus, aus demselben Grund wie die `for-in`-Schleife.

## Lösung 2: eine neue Liste erzeugen, statt zu verändern

Gehört die Liste zu State, auf den anderer Code eine Referenz hält, ist das Verändern an Ort und Stelle der eigentliche Bug, und der `ConcurrentModificationError` ist nur das Symptom, das zufällig sichtbar wurde. Erzeugen Sie eine neue Liste:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3, 4];

  final odds = numbers.where((n) => n.isOdd).toList();
  final alsoOdds = [for (final n in numbers) if (n.isOdd) n];

  print(odds);     // [1, 3]
  print(alsoOdds); // [1, 3]
  print(numbers);  // [1, 2, 3, 4], untouched
}
```

In Flutter ist das die richtige Form für alles, was einen Rebuild auslöst:

```dart
// Flutter 3.47.8, Dart 3.13.7, flutter_riverpod 3.x
class TodoList extends Notifier<List<Todo>> {
  @override
  List<Todo> build() => const [];

  void clearCompleted() {
    state = [for (final t in state) if (!t.done) t];
  }
}
```

Riverpod, Bloc und `ValueNotifier` benachrichtigen ihre Listener nur, wenn ein neuer Wert zugewiesen wird, der sich vom alten unterscheidet. `state.removeWhere(...)` verändert dieselbe Listeninstanz, ohne etwas zuzuweisen, also wird nichts neu gebaut, und wurde `state` mit `const []` oder `List.unmodifiable` erzeugt, wirft es stattdessen `UnsupportedError: Cannot remove from an unmodifiable list`. Wenn Sie ein `setState`-Widget auf dieses Modell umstellen, führt die [Migration von setState zu einem Riverpod Notifier](/de/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/) durch den Rest der Umstellung.

Vorsicht bei Lazy Evaluation. `where` liefert ein lazy `Iterable`, das beim Konsumieren aus der Originalliste liest, deshalb wirft auch das hier:

```dart
// Dart 3.13.7: throws ConcurrentModificationError
for (final n in numbers.where((n) => n.isEven)) {
  numbers.remove(n);
}
```

Erst `.toList()` materialisiert das Ergebnis und trennt die Verbindung zur Quelle.

## Lösung 3: die Index-Schleife rückwärts laufen lassen

Manchmal hängt die Entscheidung von der Position ab: "Entferne ein Element, wenn es dem vorherigen gleicht" oder "entferne alle Einträge nach dem ersten Fehler". Eine Index-Schleife ist hier in Ordnung, solange sie rückwärts läuft:

```dart
// Dart 3.13.7
void main() {
  final values = [1, 2, 2, 3, 3, 3, 4];

  // Remove consecutive duplicates.
  for (var i = values.length - 1; i > 0; i--) {
    if (values[i] == values[i - 1]) values.removeAt(i);
  }
  print(values); // [1, 2, 3, 4]
}
```

Index-Schleifen berühren den Iterator nie und werfen daher nie `ConcurrentModificationError`. Eine Vorwärtsschleife wird dadurch aber nicht korrekt:

```dart
// Dart 3.13.7: no exception, wrong answer for adjacent matches
final numbers = [1, 2, 2, 3];
for (var i = 0; i < numbers.length; i++) {
  if (numbers[i] == 2) numbers.removeAt(i);
}
print(numbers); // [1, 2, 3]  (one 2 survived)
```

Wenn `removeAt(1)` läuft, rückt die zweite `2` auf Index 1 nach, und `i++` geht dann an ihr vorbei. Rückwärts zu laufen vermeidet das, weil das Entfernen von Index `i` nur Elemente verschiebt, die bereits besucht wurden. Wer auf einer Vorwärtsschleife besteht, erhöht `i` nur, wenn nichts entfernt wurde, aber die Rückwärtsschleife ist schwerer falsch zu machen.

## Lösung 4: über eine Kopie iterieren

Leistet der Schleifenrumpf echte Arbeit (Protokollierung, Callbacks auslösen, andere Strukturen aktualisieren) und ist das Entfernen ein Nebeneffekt einiger Iterationen, hält die Iteration über einen Snapshot den Code lesbar:

```dart
// Dart 3.13.7
void main() {
  final pending = [1, 2, 2, 3];
  for (final job in pending.toList()) {
    final ok = job != 2; // pretend this ran the job
    if (ok) pending.remove(job);
  }
  print(pending); // [2, 2]
}
```

`toList()` kostet eine Allokation und eine Kopie der Referenzen, bei Listen in UI-Größe vernachlässigbar. Beachten Sie, dass `remove(job)` das *erste* Element entfernt, das `job` gleicht, was bei eindeutigen Objekten passt und bei doppelten Werten überrascht. Für eine `Map` lautet das Gegenstück `for (final key in map.keys.toList())`.

## Warum `removeAt` in einer Schleife die langsame Variante ist

Jedes `removeAt(i)` verschiebt alle Elemente nach `i` um eine Position nach links, das Entfernen von `k` Elementen aus einer Liste der Länge `n` kostet also grob `O(n * k)` Elementverschiebungen. `removeWhere` und `where(...).toList()` sind ein einziger `O(n)`-Durchlauf. Ich habe alle drei auf einer `List<int>` mit 200.000 Elementen gemessen, wobei die 100.000 geraden Zahlen entfernt wurden, kompiliert mit `dart compile exe` auf einem Mac mit Apple Silicon:

```dart
// Dart 3.13.7, dart compile exe, macOS arm64
void main() {
  const n = 200000;
  var a = List<int>.generate(n, (i) => i);
  var sw = Stopwatch()..start();
  for (var i = a.length - 1; i >= 0; i--) {
    if (a[i].isEven) a.removeAt(i);
  }
  print('removeAt backwards: ${sw.elapsedMilliseconds} ms');

  var b = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  b.removeWhere((x) => x.isEven);
  print('removeWhere: ${sw.elapsedMicroseconds} us');

  var c = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  final d = c.where((x) => x.isOdd).toList();
  print('where.toList: ${sw.elapsedMicroseconds} us (${d.length})');
}
```

| Ansatz | Zeit (Median aus 3 Läufen) |
| --- | --- |
| rückwärts laufende `removeAt`-Schleife | ~3.720 ms |
| `removeWhere` | ~1,0 ms |
| `where(...).toList()` | ~1,45 ms |

Das sind dreieinhalb Größenordnungen. Bei einer Liste mit 20 Todos spielt nichts davon eine Rolle, und Sie sollten die am besten lesbare Variante nehmen. Für alles, was Daten verarbeitet (geparste CSV-Zeilen, Log-Einträge, eine Cache-Bereinigung), verwenden Sie `removeWhere` und heben sich die Index-Schleife für Logik auf, die wirklich Positionen braucht. Wenn eine sehr große Liste abseits des UI-Threads verarbeitet werden muss, hält [die Arbeit in einem Dart-Isolate](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) die Frames flüssig, eine `O(n^2)`-Schleife behebt das aber nicht.

## Wenn Sie auch die entfernten Elemente brauchen

`removeWhere` gibt `void` zurück, Sie sehen also nicht, was entfernt wurde. Die naheliegende Lösung ruft das Prädikat zweimal auf:

```dart
final removed = items.where(isExpired).toList();
items.removeWhere(isExpired);
```

Das ist nur korrekt, wenn `isExpired` deterministisch ist. Liest es `DateTime.now()`, kann ein Element zwischen den beiden Aufrufen ablaufen und verschwinden, ohne in `removed` aufzutauchen. Partitionieren Sie stattdessen in einem einzigen Durchlauf:

```dart
// Dart 3.13.7
extension RemoveAndCollect<E> on List<E> {
  List<E> removeWhereAndCollect(bool Function(E element) test) {
    final removed = <E>[];
    final kept = <E>[];
    for (final e in this) {
      (test(e) ? removed : kept).add(e);
    }
    if (removed.isNotEmpty) {
      setRange(0, kept.length, kept);
      length = kept.length;
    }
    return removed;
  }
}

void main() {
  final items = [1, 2, 3, 4, 5];
  final evens = items.removeWhereAndCollect((x) => x.isEven);
  print(items); // [1, 3, 5]
  print(evens); // [2, 4]
}
```

Das `for-in` ist hier sicher, weil nichts `this` verändert, bevor die Schleife fertig ist.

## Fallstricke, die den Fehler verbergen oder verändern

**Entfernen und danach Hinzufügen in derselben Iteration beschädigt die Schleife stillschweigend.** Der Iterator vergleicht nur Längen. Entfernt eine Iteration ein Element und fügt ein anderes hinzu, bleibt die Länge gleich und nichts wird geworfen:

```dart
// Dart 3.13.7: no exception, element 3 is never visited
final l = [1, 2, 3, 4];
for (final x in l) {
  print('visit $x'); // visit 1, visit 2, visit 4, visit 20
  if (x == 2) {
    l.remove(x);
    l.add(20);
  }
}
```

Die `3` ist auf die bereits besuchte Position nachgerückt und wurde übersprungen. Das Ausbleiben eines `ConcurrentModificationError` beweist nicht, dass der Code korrekt ist. Ein Element direkt zu ersetzen, `l[i] = newValue`, ist tatsächlich unproblematisch, weil es nie die Länge ändert und nichts verschiebt.

**Ein `await` in der Schleife öffnet die Tür für anderen Code.** Diese Variante taucht in Flutter-Apps als sporadischer Absturz auf:

```dart
// Dart 3.13.7
import 'dart:async';

Future<void> main() async {
  final items = [1, 2, 3];
  Timer(const Duration(milliseconds: 5), () => items.removeAt(0));

  for (final x in items) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    print('processed $x');
  }
  // processed 1, then ConcurrentModificationError
}
```

Nichts im Schleifenrumpf berührt `items`. Das tut ein Timer, ein Stream-Listener oder ein Tap-Handler eines Buttons, der während des `await` läuft. Die Lösung entspricht Lösung 4: Iterieren Sie über `items.toList()`, oder machen Sie die geteilte Liste unveränderlich und ersetzen Sie sie. Lebt die asynchrone Schleife in einem `State`, ist genau diese Lücke auch die Stelle, an der der [mounted-Check vor dem Aufruf von setState](/de/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) nötig ist, und ein nicht abgewarteter Aufruf in der Schleife ist genau das, was die [Lints `unawaited_futures` und `discarded_futures`](/de/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/) abfangen sollen.

**Maps vertragen das Aktualisieren von Werten, nicht das Ändern von Schlüsseln.** `for (final k in map.keys) map[k] = 0;` ist in Ordnung, weil das Aktualisieren eines vorhandenen Schlüssels die Struktur der Map nicht ändert. `map.remove(k)` oder das Hinzufügen eines neuen Schlüssels wirft. Einen nicht vorhandenen Schlüssel zu entfernen, ist ein No-op und wirft nicht.

**`addAll` auf sich selbst wirft sofort.** `list.addAll(list)` auf einer growable Liste der VM wirft `ConcurrentModificationError`, ganz ohne Schleife. Verwenden Sie `list.addAll(list.toList())` oder `[...list, ...list]`.

**Listen fester Länge und unveränderliche Listen werfen `UnsupportedError`, nicht diesen Fehler.** `List.filled(3, 0).removeWhere(...)` wirft `Unsupported operation: Cannot remove from a fixed-length list`, und eine `const`-Liste oder `List.unmodifiable` wirft `Cannot remove from an unmodifiable list`. Die [Dokumentation von `removeWhere`](https://api.dart.dev/dart-core/List/removeWhere.html) sagt es ausdrücklich: Die Liste muss growable sein. Für diese Fälle gilt Lösung 2.

**Das Entfernen aus einer Liste hinter einem `ListView` braucht Keys.** Nach `setState(() => _items.removeWhere(...))` ordnet Flutter alte und neue Kinder nach Position zu, sofern Sie ihnen keine Keys geben, sodass State pro Element (eine Checkbox, ein Textfeld, eine Animation) in die falsche Zeile springen kann. Der [Beitrag über Keys in Flutter](/de/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/) behandelt die Lösung mit `ValueKey(item.id)`.

### Weiterlesen

- [setState in Flutter nach einer asynchronen Lücke mit dem mounted-Check absichern](/de/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [Was ist ein Flutter Key und wann verursacht sein Fehlen Bugs?](/de/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [Ein setState-StatefulWidget zu einem Riverpod Notifier migrieren](/de/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [Die Lints unawaited_futures und discarded_futures in Dart im Vergleich](/de/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)

### Quellen

- [Dokumentation der Klasse `Iterable`](https://api.dart.dev/dart-core/Iterable-class.html), Abschnitt über das Ändern einer Collection während der Iteration
- [Klasse `ConcurrentModificationError`](https://api.dart.dev/dart-core/ConcurrentModificationError-class.html)
- [`List.removeWhere`](https://api.dart.dev/dart-core/List/removeWhere.html) und [`List.retainWhere`](https://api.dart.dev/dart-core/List/retainWhere.html)
- Quellcode des Dart SDK: [`ListIterator.moveNext` in `sdk/lib/internal/iterable.dart`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/internal/iterable.dart) und [`ListBase._filter` in `sdk/lib/collection/list.dart`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/collection/list.dart)
