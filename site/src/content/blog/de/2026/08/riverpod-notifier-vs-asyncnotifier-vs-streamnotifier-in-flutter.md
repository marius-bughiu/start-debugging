---
title: "Riverpod Notifier vs AsyncNotifier vs StreamNotifier in Flutter: welche Klasse erweitere ich?"
description: "Die Wahl entscheidet der Rückgabetyp von build(): T bedeutet Notifier, FutureOr<T> bedeutet AsyncNotifier, Stream<T> bedeutet StreamNotifier. Hier sind die Entscheidungsmatrix, die zugrunde liegende Typhierarchie sowie die Fallstricke beim ==-Filtern und beim Überschreiben des State. Verifiziert mit flutter_riverpod 3.4.2 auf Flutter 3.44.2."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "de"
translationOf: "2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-15
---

Die Wahl zwischen `Notifier`, `AsyncNotifier` und `StreamNotifier` entscheidet genau eine Sache: der Rückgabetyp Ihrer `build()`-Methode. Gibt sie `T` zurück, erweitern Sie `Notifier<T>`. Gibt sie `Future<T>` zurück oder ein einfaches `T`, das Sie später eventuell asynchron machen wollen, erweitern Sie `AsyncNotifier<T>`. Liefert Ihre Datenquelle auch nach dem ersten Wert weiter neue Werte, erweitern Sie `StreamNotifier<T>`. Alles andere (Mutationsmethoden, `ref.watch` innerhalb von `build`, Families, automatische Freigabe) funktioniert in allen drei Klassen identisch. Alles in diesem Beitrag ist verifiziert mit `flutter_riverpod` 3.4.2 auf Flutter 3.44.2 (stable, 2026-06-10) und Dart 3.12.2, für den Abschnitt zur Codegenerierung mit `riverpod_generator` 4.0.4.

## Die Entscheidungsmatrix

| | `Notifier<T>` | `AsyncNotifier<T>` | `StreamNotifier<T>` |
| --- | --- | --- | --- |
| `build()` gibt zurück | `T` | `FutureOr<T>` | `Stream<T>` |
| Provider stellt bereit | `T` | `AsyncValue<T>` | `AsyncValue<T>` |
| Provider-Klasse | `NotifierProvider` | `AsyncNotifierProvider` | `StreamNotifierProvider` |
| Ladezustand | nie | zuerst `AsyncLoading` | zuerst `AsyncLoading` |
| Werte nach dem ersten | schreiben Sie selbst | schreiben Sie selbst | schreibt der Stream |
| `.future`-Modifier | nein | ja | ja |
| `update()`-Helfer | nein | ja | ja |
| Signatur von `updateShouldNotify` | `(T, T)` | `(AsyncValue<T>, AsyncValue<T>)` | `(AsyncValue<T>, AsyncValue<T>)` |
| Ersetzt (Riverpod 2.x) | `StateNotifier`, `StateProvider` | `FutureProvider` + Methoden | `StreamProvider` + Methoden |

Über die letzte Zeile stolpern die meisten. `AsyncNotifier` ist nicht "die asynchrone Variante von `Notifier`" im Sinne einer Obermenge. Es ist `FutureProvider` mit einem Ort für Mutationsmethoden. `StreamNotifier` ist `StreamProvider` mit demselben Zusatz. Wenn Sie keine Mutationsmethoden brauchen, bleibt ein schlichter `FutureProvider` oder `StreamProvider` die kleinere Antwort.

## Warum der Rückgabetyp die ganze Regel ist

Das ist keine Stilkonvention, sondern wird von der Klassenhierarchie in `riverpod` 3.4.2 erzwungen. Jede der drei öffentlichen Klassen deklariert ein abstraktes `build()` mit festem Rückgabetyp:

```dart
// package:riverpod/src/providers/notifier/orphan.dart, riverpod 3.4.2
abstract class Notifier<ValueT> extends $Notifier<ValueT> {
  @visibleForOverriding
  ValueT build();
}

// package:riverpod/src/providers/async_notifier/orphan.dart
abstract class AsyncNotifier<StateT> extends $AsyncNotifier<StateT> {
  @visibleForOverriding
  FutureOr<StateT> build();
}

// package:riverpod/src/providers/stream_notifier/orphan.dart
abstract class StreamNotifier<ValueT> extends $StreamNotifier<ValueT> {
  @visibleForOverriding
  Stream<ValueT> build();
}
```

Bei falscher Wahl bekommen Sie einen Compile-Fehler, keine Überraschung zur Laufzeit. Dies sind die exakten Diagnosen von `flutter analyze` auf Flutter 3.44.2:

```text
error - 'WrongOne.build' ('Future<int> Function()') isn't a valid override of
        'Notifier.build' ('int Function()') - invalid_override

error - 'WrongTwo.build' ('Stream<int> Function()') isn't a valid override of
        'AsyncNotifier.build' ('FutureOr<int> Function()') - invalid_override

error - 'Ok' doesn't conform to the bound 'AsyncNotifier<int>' of the type
        parameter 'NotifierT' - type_argument_not_matching_bounds
```

Die dritte Meldung ist der Fehler bei falscher Paarung: eine `Notifier`-Unterklasse, die an einen `AsyncNotifierProvider` übergeben wird. Notifier-Klasse und Provider-Klasse sind über eine generische Schranke aneinander gebunden, mischen lassen sie sich also nicht.

## Wann Notifier die richtige Wahl ist

`Notifier<T>` passt, wenn der Anfangszustand synchron verfügbar ist und nichts außerhalb Ihrer eigenen Methoden ihn verändert.

```dart
// flutter_riverpod 3.4.2, Flutter 3.44.2, Dart 3.12.2
class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

final counterProvider = NotifierProvider<Counter, int>(Counter.new);
```

`ref.watch(counterProvider)` liefert ein `int`, kein `AsyncValue<int>`. Es gibt keinen Ladezweig zu rendern und auch keinen Fehlerzweig, und genau darum geht es: eine Filterauswahl, das Dirty-Flag eines Formulars, der Index eines ausgewählten Tabs, ein Warenkorb im Speicher. Wenn Sie `AsyncData(...)` um einen Wert schreiben, den Sie bereits haben, war die Basisklasse falsch gewählt.

Was Umsteiger von `StateNotifier` überrascht: `build()` kann erneut laufen. Wenn Sie darin einen anderen Provider per `ref.watch` beobachten, führt eine Änderung stromaufwärts `build()` erneut aus und setzt Ihren State zurück. Die Notifier-Instanz selbst bleibt erhalten, Instanzfelder überleben also:

```dart
// Verified: constructed once, built twice after the dependency changed.
expect(Instanced.built, 2);        // build() re-ran
expect(Instanced.constructed, 1);  // the object was not recreated
```

## Wann AsyncNotifier die richtige Wahl ist

`AsyncNotifier<T>` passt, wenn der Anfangszustand aus einem `Future` kommt und jeder Wert danach aus Ihren eigenen Mutationsmethoden.

```dart
// flutter_riverpod 3.4.2
class AsyncCounter extends AsyncNotifier<int> {
  @override
  Future<int> build() async {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    return 0;
  }

  Future<void> increment() async {
    final current = await future;      // resolves to the latest non-loading value
    state = AsyncData(current + 1);
  }
}

final asyncCounterProvider =
    AsyncNotifierProvider<AsyncCounter, int>(AsyncCounter.new);
```

Der `future`-Getter im Notifier und der `.future`-Modifier am Provider stammen beide aus dem Mixin `$AsyncClassModifier`. Ebenso `update()`, die ergonomische Fassung des obigen Read-Modify-Write:

```dart
Future<void> increment() => update((current) => current + 1);
```

Ein Detail lohnt sich zu kennen, weil es ändert, was Ihr Widget im ersten Frame rendert: `build()` gibt `FutureOr<T>` zurück, ein synchron zurückgegebener Wert ist also zulässig, und dann durchläuft der Provider nie `AsyncLoading`.

```dart
class SyncishAsync extends AsyncNotifier<int> {
  @override
  int build() => 42;   // legal: FutureOr<int> accepts int
}

// Verified: the very first read is AsyncData(42), not AsyncLoading.
expect(container.read(syncishProvider), isA<AsyncData<int>>());
```

Damit ist `AsyncNotifier` ein vernünftiger Standard für State, der heute synchron ist, aber später hinter einen Netzwerkaufruf wandern soll. Bezahlt wird das mit einer `AsyncValue`-Hülle, die Sie in jedem Widget auspacken müssen, weshalb ich sie für einen Tab-Index nicht verwenden würde. Für das saubere Rendern dieser Hülle gilt dieselbe Mechanik wie in [Lade- und Fehlerzustände mit AsyncValue anzeigen](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Wann StreamNotifier die richtige Wahl ist

`StreamNotifier<T>` passt, wenn die Quelle laufend Werte nachliefert: ein Firestore-Snapshot-Listener, ein WebSocket, ein `Stream` aus einem Plugin, ein periodischer Timer.

```dart
// flutter_riverpod 3.4.2
class Ticker extends StreamNotifier<int> {
  @override
  Stream<int> build() {
    final controller = StreamController<int>();
    var i = 0;
    final timer = Timer.periodic(const Duration(milliseconds: 5), (_) {
      controller.add(i++);
    });
    ref.onDispose(() {
      timer.cancel();
      controller.close();
    });
    return controller.stream;
  }
}

final tickerProvider = StreamNotifierProvider<Ticker, int>(Ticker.new);
```

Das unterscheidende Verhalten: der State ändert sich weiter, ohne dass Sie in `state` schreiben. Wer diesen Provider abhört und die Emissionen sammelt, erhält `[0, 1, 2, ...]`, während ein `AsyncNotifier` genau ein `AsyncData` geliefert hätte und dann stehen geblieben wäre.

Riverpod verwaltet das Abonnement für Sie. Läuft `build()` erneut, weil sich eine beobachtete Abhängigkeit geändert hat, wird das vorherige Abonnement gekündigt, bevor der neue Stream abonniert wird:

```dart
// Verified with a StreamController whose onCancel increments a counter.
expect(Feed.subscribes, 2);  // build re-ran, new stream
expect(Feed.cancels, 1);     // Riverpod cancelled the old subscription
```

Das `ref.onDispose` oben brauchen Sie trotzdem für Ressourcen, die dem Stream nicht selbst gehören, etwa den `Timer`. Riverpod kündigt sein Abonnement auf Ihren Stream; vom Timer, der den Stream speist, weiß es nichts. Es ist dieselbe Disziplin wie beim [Freigeben von Controllern in Flutter zur Vermeidung von Speicherlecks](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## AsyncNotifier und StreamNotifier sind Geschwister, nicht Eltern und Kind

Das Dartdoc von `StreamNotifier` nennt die Klasse "eine Variante von `AsyncNotifier`", was nach Vererbung klingt. Das ist sie nicht. Beide erweitern dieselbe interne Basis und unterscheiden sich nur in einem generischen Argument:

```dart
// package:riverpod/src/providers/async_notifier.dart, riverpod 3.4.2
abstract class $AsyncNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, FutureOr<ValueT>> {}

// package:riverpod/src/providers/stream_notifier.dart
abstract class $StreamNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, Stream<ValueT>> {}
```

`$AsyncNotifierBase<ValueT>` erweitert in beiden Fällen `AnyNotifier<AsyncValue<ValueT>, ValueT>`, deshalb stellen beide `AsyncValue<T>` bereit und beide erhalten `future` und `update()`. Der einzige Unterschied ist `CreatedT`: `FutureOr<ValueT>` gegenüber `Stream<ValueT>`. `$Notifier<StateT>` dagegen erweitert `$SyncNotifierBase<StateT>`, das wiederum `AnyNotifier<StateT, StateT>` erweitert, weshalb dort State-Typ und Werttyp identisch sind.

Praktisch heißt das: eine Typprüfung gegen `AsyncNotifier` trifft auf einen `StreamNotifier` nicht zu. Generischer Hilfscode mit `if (notifier is AsyncNotifier)` überspringt Ihre stream-basierten Provider also stillschweigend:

```dart
// Verified on riverpod 3.4.2
expect(Ticker(), isNot(isA<AsyncNotifier<int>>()));
expect(AsyncCounter(), isNot(isA<StreamNotifier<int>>()));
```

## Der ==-Filter trifft alle drei

Riverpod 3.0 hat vereinheitlicht, dass `==` darüber entscheidet, ob Listener benachrichtigt werden. Die meisten Texte behandeln das als `Notifier`-Problem, weil das klassische Symptom eine in-place mutierte `List` ohne Rebuild ist. Es ist kein `Notifier`-Problem. Es gilt genauso für `AsyncNotifier` und `StreamNotifier`, denn `AsyncValue.operator ==` vergleicht den umschlossenen Wert mit `==`:

```dart
// package:riverpod/src/core/async_value.dart, riverpod 3.4.2
@override
bool operator ==(Object other) {
  return runtimeType == other.runtimeType &&
      other is AsyncValue<ValueT> &&
      other._loading == _loading &&
      other.valueFilled == valueFilled &&
      other._errorFilled == _errorFilled;
}
```

Dieselbe `List`-Instanz in ein frisches `AsyncData` zu verpacken erzeugt daher einen Wert, der `==` zum vorherigen State ist, und die Benachrichtigung entfällt:

```dart
// Verified: both of these are silent no-ops for listeners.
class AsyncTodoList extends AsyncNotifier<List<String>> {
  @override
  List<String> build() => <String>[];

  void addMutating(String v) {
    final list = state.requireValue..add(v);
    state = AsyncData(list);            // same list instance, == is true
  }

  void addReplacing(String v) =>
      state = AsyncData([...state.requireValue, v]);   // new list, notifies
}

final list = ['x'];
expect(AsyncData(list) == AsyncData(list), isTrue);
expect(AsyncData(['x']) == AsyncData(['x']), isFalse);
```

Die Lösung ist in allen drei Klassen dieselbe: weisen Sie immer eine neue Collection-Instanz zu, statt zu mutieren und neu zuzuweisen. Der Notausgang ist ebenfalls derselbe, allerdings ändert sich die Signatur mit der Basisklasse, denn `updateShouldNotify` erhält den *State*-Typ, nicht den Werttyp:

```dart
// Notifier<List<String>>
@override
bool updateShouldNotify(List<String> previous, List<String> next) => true;

// AsyncNotifier<List<String>> or StreamNotifier<List<String>>
@override
bool updateShouldNotify(
  AsyncValue<List<String>> previous,
  AsyncValue<List<String>> next,
) => true;
```

Wenn Sie hier gelandet sind, weil ein Stream die UI plötzlich nicht mehr aktualisiert hat: dieselbe Ursache wird ausführlicher behandelt unter [StreamProvider-Ereignisse werden in Riverpod 3.0 per Gleichheit gefiltert](/de/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## Der StreamNotifier-Fallstrick: Ihre Schreibzugriffe werden überschrieben

`StreamNotifier` erbt den `state`-Setter, Sie können also durchaus zuweisen. Aber der Stream lebt weiter, und das nächste Ereignis gewinnt:

```dart
// Verified against a StreamNotifier whose build() emits every 5ms.
container.read(tickerProvider.notifier).poke();       // state = AsyncData(999)
expect(container.read(tickerProvider).value, 999);    // holds, briefly

await Future<void>.delayed(const Duration(milliseconds: 20));
expect(container.read(tickerProvider).value, isNot(999));  // the stream won
```

Das ist kein Bug und kein Grund, auf Mutationsmethoden in einem `StreamNotifier` zu verzichten. Es ist ein Grund, die Mutation optimistisch zu machen und den Stream sie bestätigen zu lassen. Schreiben Sie für die sofortige UI-Reaktion in `state`, schicken Sie die Änderung ans Backend, und lassen Sie das zurückgespielte Stream-Ereignis zur Wahrheitsquelle werden:

```dart
// flutter_riverpod 3.4.2
Future<void> send(String message) async {
  state = AsyncData([...(state.value ?? const []), message]);  // optimistic
  await _api.post(message);   // the server echoes this back down the stream
}
```

Spielt der Stream Ihre Mutationen nicht zurück, hat Ihr Problem keine Stream-Form. Nehmen Sie einen `AsyncNotifier` und verwalten Sie den State selbst.

## Die Codegenerierung wählt für Sie

Mit `riverpod_generator` nennen Sie die Basisklasse nie. Sie annotieren mit `@riverpod`, erweitern das generierte `_$Foo`, und der Generator liest den Rückgabetyp von `build()`. Hier drei Klassen, die sich nur in diesem Rückgabetyp unterscheiden, samt der zugehörigen generierten Deklarationen aus `riverpod_generator` 4.0.4:

```dart
// gen.dart
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;
}

@riverpod
class AsyncCounter extends _$AsyncCounter {
  @override
  Future<int> build() async => 0;
}

@riverpod
class Ticker extends _$Ticker {
  @override
  Stream<int> build() => Stream.value(0);
}
```

```dart
// gen.g.dart, generated
final class CounterProvider extends $NotifierProvider<Counter, int> { ... }
abstract class _$Counter extends $Notifier<int> { ... }

final class AsyncCounterProvider
    extends $AsyncNotifierProvider<AsyncCounter, int> { ... }
abstract class _$AsyncCounter extends $AsyncNotifier<int> { ... }

final class TickerProvider extends $StreamNotifierProvider<Ticker, int> { ... }
abstract class _$Ticker extends $StreamNotifier<int> { ... }
```

Ändern Sie `Future<int> build()` in `Stream<int> build()`, lassen Sie den Builder erneut laufen, und die Basisklasse wechselt darunter ohne jede weitere Änderung. Das ist das stärkste praktische Argument für Codegenerierung bei genau dieser Frage.

Eine Asymmetrie macht die generierte Ausgabe sichtbar: generierte Provider geben sich automatisch frei, handgeschriebene nicht.

```dart
// gen.g.dart: every generated provider passes isAutoDispose: true
CounterProvider._() : super(..., isAutoDispose: true, ...);

// Hand-written, verified on riverpod 3.4.2:
expect(counterProvider.isAutoDispose, isFalse);
expect(asyncCounterProvider.isAutoDispose, isFalse);
expect(tickerProvider.isAutoDispose, isFalse);
```

Für einen `StreamNotifier` ist dieser Unterschied teuer: ein handgeschriebener Stream-Provider hält sein Abonnement für immer offen, sobald etwas ihn liest, denn `NotifierProvider`, `AsyncNotifierProvider` und `StreamNotifierProvider` setzen `isAutoDispose` standardmäßig auf `false`. Übergeben Sie `NotifierProvider(..., isAutoDispose: true)`, wenn Sie das generierte Verhalten ohne Generierung wollen.

## Ein Versionsvorbehalt

Auf Flutter 3.44.2 lassen sich die neuesten Pakete derzeit nicht gemeinsam auflösen. `flutter_riverpod` 3.4.2 zusammen mit einer beliebigen Version von `riverpod_generator` scheitert an der Versionsauflösung gegen `matcher` 0.12.19 und `test_api` 0.7.11, die dieses Flutter-SDK über `flutter_test` festlegt. Sauber auflösen lässt sich die Kombination `flutter_riverpod` 3.3.2 mit `riverpod_annotation` 4.0.3 und `riverpod_generator` 4.0.4, aus der die generierte Ausgabe oben stammt. An der Regel zur Klassenwahl ändert sich zwischen 3.3.2 und 3.4.2 nichts, aber mit Codegenerierung bleiben Sie voraussichtlich eine Minor-Version hinter dem Laufzeitpaket zurück, bis die SDK-Einschränkung nachzieht.

## Die Empfehlung

Nehmen Sie standardmäßig `AsyncNotifier` für alles mit E/A, `Notifier` für alles ohne, und `StreamNotifier` nur dann, wenn eine Quelle tatsächlich mehr als einen Wert liefert. Wählen Sie `AsyncNotifier`, wo `Notifier` gereicht hätte, ist der Preis etwas Rauschen beim Auspacken von `AsyncValue` in Ihren Widgets. Wählen Sie `Notifier`, obwohl die Daten asynchron sind, ist der Preis ein `late`-Feld, ein `LateInitializationError` und ein manuelles Lade-Flag, und das ist eindeutig schlechter. Und mit Codegenerierung können Sie das Thema ganz vergessen: schreiben Sie das `build()`, das Sie wirklich wollen, und lassen Sie den Generator wählen.

## Verwandte Beiträge

- [Welches Riverpod-Paket installiert werden sollte: riverpod, flutter_riverpod oder hooks_riverpod](/de/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [FutureBuilder und StreamBuilder im Vergleich zu Riverpods AsyncValue](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [Der vollständige Migrationsleitfaden von Riverpod 2.x auf 3.0](/de/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [Ein StatefulWidget mit setState auf einen Riverpod-Notifier umstellen](/de/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [Einen FutureBuilder in einen Riverpod-AsyncNotifier überführen](/de/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## Quellen

- [Was ist neu in Riverpod 3.0](https://riverpod.dev/docs/whats_new), zur Vereinheitlichung der Notifier und zum Wechsel auf `==` beim Filtern von Benachrichtigungen.
- [riverpod 3.4.2 auf pub.dev](https://pub.dev/packages/riverpod/versions/3.4.2), Quelle der oben zitierten Deklarationen von `Notifier`, `AsyncNotifier` und `StreamNotifier`.
- [flutter_riverpod 3.4.2 auf pub.dev](https://pub.dev/packages/flutter_riverpod/versions/3.4.2).
- [riverpod_generator 4.0.4 auf pub.dev](https://pub.dev/packages/riverpod_generator/versions/4.0.4), der Generator, dessen Ausgabe im Abschnitt zur Codegenerierung gezeigt wird.
