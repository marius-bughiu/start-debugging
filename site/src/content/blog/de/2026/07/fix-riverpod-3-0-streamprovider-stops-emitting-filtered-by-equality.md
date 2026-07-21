---
title: "Fix: Riverpod 3.0 StreamProvider emittiert nicht mehr, weil Updates per == gefiltert werden"
description: "In Riverpod 3.0 filtert jeder Provider Listener-Benachrichtigungen mit ==, nicht per Identität. Ein StreamProvider, der dasselbe veränderliche Objekt erneut emittiert, baut die UI nach dem ersten Frame nicht mehr neu auf. Hier erfahren Sie, warum das passiert, und drei Wege, es zu beheben. Getestet mit flutter_riverpod 3.3.2, Flutter 3.44, Dart 3.x."
pubDate: 2026-07-21
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "streams"
lang: "de"
translationOf: "2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality"
translatedBy: "claude"
translationDate: 2026-07-21
---

Wenn Sie auf Riverpod 3.0 aktualisiert haben und ein `StreamProvider` Ihr Widget plötzlich genau einmal neu aufbaut und danach verstummt, liegt die Ursache in einer einzigen Zeile der Migrationshinweise, die leicht zu überlesen ist: In 3.0 filtert jeder Provider Listener-Benachrichtigungen mit `==` statt per Identität. Wenn Ihr Stream dieselbe Objektinstanz zweimal emittiert (eine veränderliche Liste, die Sie an Ort und Stelle mutieren, ein controllergestütztes Modell, das Sie erneut pushen), vergleicht Riverpod den neuen Wert mit dem vorherigen, findet sie gleich und verwirft die Benachrichtigung. Der Stream feuert weiterhin. Ihre `StreamSubscription` außerhalb von Riverpod würde weiterhin jedes Ereignis sehen. Aber `ref.watch` baut nie neu auf, denn für Riverpod hat sich nichts geändert. Die Lösung besteht darin, jedes Mal einen neuen, nicht gleichen Wert zu emittieren, oder `updateShouldNotify` zu überschreiben. Dieser Beitrag ist getestet mit `flutter_riverpod` 3.3.2 (Juni 2026), Flutter 3.44 und Dart 3.x.

## Was sich in 3.0 tatsächlich geändert hat

Vor 3.0 war Riverpod inkonsistent darin, wie entschieden wurde, ob ein neuer Wert eine Benachrichtigung der Listener rechtfertigte. Einige Provider-Typen verglichen mit `==`, einige nutzten `identical`, und einige wenige hatten maßgeschneiderte Logik. `StreamProvider` lag auf der Identitätsseite dieser Grenze: Jedes Ereignis, das der Stream erzeugte, wurde an die Listener gepusht, denn ein frisch geliefertes Stream-Ereignis wurde in der Praxis als neu behandelt.

Riverpod 3.0 hat all das in einer einzigen Regel zusammengefasst. Aus dem [offiziellen 3.0-Migrationsleitfaden](https://riverpod.dev/docs/3.0_migration): "all providers now use `==` to filter updates." Der Leitfaden nennt die Provider, die am ehesten betroffen sind: "The most likely way for you to be impacted by this change is when using `StreamProvider`/`StreamNotifier`, as stream values will now be filtered by `==`."

Für die Konsistenz ist das eine gute Änderung. Sie bedeutet, dass ein Provider, der einen Wert neu berechnet, der seinem letzten gleicht, nicht unnötig jedes nachgelagerte Widget neu aufbaut, was dieselbe Optimierung ist, zu der Sie sonst mit `select` greifen würden. Das Problem ist der stille Fehlermodus, den sie für ein Muster einführt, das in 2.x völlig in Ordnung war: ein veränderliches Objekt zu emittieren, es zu mutieren und es erneut zu emittieren.

## Die minimale Reproduktion

Hier ist das kleinste, das kaputtgeht. Ein Repository hält eine `List<int>`, hängt daran an und pusht nach jedem Anhängen dieselbe Liste durch einen `StreamController`.

```dart
// flutter_riverpod 3.3.2, Dart 3.x
import 'dart:async';

class CounterRepository {
  final _values = <int>[];
  final _controller = StreamController<List<int>>.broadcast();

  Stream<List<int>> get stream => _controller.stream;

  void add(int value) {
    _values.add(value);
    _controller.add(_values); // same List instance every time
  }
}
```

Verdrahten Sie es mit einem `StreamProvider` und beobachten Sie es:

```dart
// flutter_riverpod 3.3.2
final repositoryProvider = Provider((ref) => CounterRepository());

final valuesProvider = StreamProvider<List<int>>((ref) {
  return ref.watch(repositoryProvider).stream;
});

class ValuesView extends ConsumerWidget {
  const ValuesView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(valuesProvider);
    return async.when(
      data: (values) => Text('Count: ${values.length}'),
      loading: () => const CircularProgressIndicator(),
      error: (e, _) => Text('Error: $e'),
    );
  }
}
```

In 2.x zeigt dies `Count: 1`, dann `Count: 2`, dann `Count: 3`, während Sie `add` aufrufen. In 3.0 zeigt es `Count: 1` und aktualisiert danach nie wieder. Das Widget bleibt bei der ersten Emission hängen.

## Warum == hier true zurückgibt, obwohl sich die Daten geändert haben

Die Falle ist, dass `_values` bei jeder Emission dasselbe Objekt ist. Wenn Sie `_controller.add(_values)` ein zweites Mal aufrufen, liefert der Stream dieselbe `List`-Referenz. Riverpod verpackt jedes Stream-Ereignis in ein `AsyncData<List<int>>` und fragt, ob der neue `AsyncValue` gleich dem vorherigen ist.

`AsyncValue` implementiert Wertgleichheit, und zwei `AsyncData`-Instanzen sind gleich, wenn ihre enthaltenen Werte gleich sind. Für Ihre Liste fällt `==` auf die Standardgleichheit von `List` zurück, die für eine einfache `List` Referenzgleichheit ist: Eine Liste ist nur sich selbst gleich. Weil es buchstäblich dasselbe Objekt ist, ist `previous == next` gleich `true`. Riverpod schließt daraus, dass sich der Wert nicht geändert hat, und unterdrückt die Benachrichtigung. Die Mutation, die Sie zwischen den Emissionen durchgeführt haben, ist für den Vergleich unsichtbar, weil es keinen "vorherigen Schnappschuss" gibt, mit dem verglichen werden könnte. Es gibt nur eine Liste, und sie ist immer sich selbst gleich.

Das ist der Teil, den der Migrationsleitfaden unterspielt. Ein [GitHub-Issue zu genau diesem Verhalten](https://github.com/rrousselGit/riverpod/issues/4310) beschreibt es als stillen Fehler, der drei Tage Debugging gekostet hat: Direkte `stream.listen`-Callbacks erhalten weiterhin jedes Ereignis, sodass der Stream isoliert betrachtet gesund aussieht, aber die Provider-Schicht dedupliziert stillschweigend. Die Diskrepanz zwischen "der Stream feuert" und "die UI baut nicht neu auf" ist es, was das Auffinden so schwer macht.

## Fix 1: jedes Mal eine neue Instanz emittieren

Die direkteste Lösung, und die, die Sie fast immer wollen, besteht darin, das erneute Verwenden desselben veränderlichen Objekts zu unterlassen. Emittieren Sie einen unveränderlichen Schnappschuss, sodass jedes Ereignis ein eigener Wert ist, der nicht `==` zum letzten ist.

```dart
// flutter_riverpod 3.3.2, Dart 3.x
void add(int value) {
  _values.add(value);
  _controller.add(List<int>.unmodifiable(_values)); // fresh instance each emit
}
```

`List<int>.unmodifiable(_values)` allokiert eine neue Liste mit den aktuellen Elementen. Sie ist ein anderes Objekt als die vorherige Emission, sodass `previous == next` gleich `false` ist und Riverpod benachrichtigt. Als Bonus lecken Sie keine veränderliche Liste mehr in Ihren Widget-Baum, was unabhängig von der Riverpod-Version ein latenter Fehler war: Jeder Consumer hätte über die erhaltene Referenz den internen Zustand Ihres Repositorys mutieren können.

Das ist keine Riverpod-spezifische Regel. Dieselbe veränderliche Sammlung durch einen Stream zu pushen und sie an Ort und Stelle zu mutieren, ist fragil bei jedem Consumer, der Werte schnappschussartig festhält oder vergleicht. Unveränderliche Emissionen sind die dauerhafte Lösung.

## Fix 2: Wertgleichheit bewusst nutzen, dann funktioniert es einfach

Manchmal *wollen* Sie, dass `==` Inhalte vergleicht, weil Sie eine Modellklasse emittieren und wollen, dass die UI Neuaufbauten überspringt, wenn sich nichts Bedeutsames geändert hat. In diesem Fall geben Sie Ihrem emittierten Typ echte Wertgleichheit, und das 3.0-Verhalten wird zum Vorteil statt zum Fehler.

```dart
// Dart 3.x records give you value equality for free
final positionProvider = StreamProvider<({double lat, double lng})>((ref) {
  return locationStream(); // each event is a new record
});
```

Dart-Records vergleichen strukturell, sodass zwei Records mit denselben Feldern `==` sind. Das bedeutet, dass ein GPS-Stream, der dieselben Koordinaten zweimal emittiert, den Neuaufbau korrekt überspringt, und einer, der eine neue Position emittiert, ihn auslöst. Dasselbe gilt für eine Klasse mit generiertem `==`/`hashCode` aus `freezed` oder einem handgeschriebenen `operator ==`. Die Faustregel: Wenn der Wert unveränderlich ist und Wertgleichheit hat, macht 3.0 automatisch das Richtige. Es verhält sich nur dann falsch, wenn Sie ein veränderliches Objekt an der Gleichheitsprüfung vorbeischmuggeln, indem Sie dieselbe Referenz beibehalten.

## Fix 3: updateShouldNotify auf einem StreamNotifier überschreiben

Wenn Sie wirklich nicht ändern können, was der Stream emittiert (eine Drittanbieterquelle, ein Legacy-Repository, das Ihnen nicht gehört), können Sie den Vergleich überschreiben. Das ist nur bei der klassenbasierten API verfügbar, also konvertieren Sie den funktionalen `StreamProvider` in einen `StreamNotifierProvider` und überschreiben `updateShouldNotify`.

```dart
// flutter_riverpod 3.3.2 with riverpod_annotation 3.x
@riverpod
class Values extends _$Values {
  @override
  Stream<List<int>> build() {
    return ref.watch(repositoryProvider).stream;
  }

  @override
  bool updateShouldNotify(
    AsyncValue<List<int>> previous,
    AsyncValue<List<int>> next,
  ) {
    return true; // always notify, restore the 2.x behavior for this provider
  }
}
```

Ein unbedingtes `true` stellt das "bei jeder Emission benachrichtigen"-Verhalten von vor 3.0 für diesen einen Provider wieder her, ohne den globalen Standard für den Rest Ihrer App zu ändern. Sie können es auch intelligenter gestalten, zum Beispiel Längen oder einen Versionszähler vergleichen, falls unbedingte Neuaufbauten zu aggressiv sind. Beachten Sie, dass der rohe funktionale `StreamProvider((ref) => ...)` keinen `updateShouldNotify`-Hook hat, sodass diese Lösung die klassenbasierte Form erfordert. Wenn Sie noch zwischen dem funktionalen und dem klassenbasierten Stil abwägen, geht der Leitfaden zur [Migration von Riverpod 2.x auf 3.0](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) durch, wann sich welcher lohnt.

## Wie Sie bestätigen, dass das Ihr Fehler ist und nicht etwas anderes

Das Symptom (ein streamgestütztes Widget, das einmal aktualisiert und dann einfriert) hat einige mögliche Ursachen, also vergewissern Sie sich, dass es der Gleichheitsfilter ist, bevor Sie zu diesen Lösungen greifen:

1. Fügen Sie ein `print` innerhalb der Stream-Quelle ein, direkt vor `_controller.add(...)`. Wenn es bei jedem Ereignis druckt, das Widget aber nicht neu aufbaut, erreichen die Ereignisse den Stream, werden aber nachgelagert gefiltert.
2. Hängen Sie einen temporären rohen Listener an: `ref.watch(repositoryProvider).stream.listen((v) => debugPrint('raw: $v'))`. Wenn der rohe Listener jedes Mal feuert, `ref.watch(valuesProvider)` aber nicht neu aufbaut, dedupliziert die Provider-Schicht, was den `==`-Filter bestätigt.
3. Prüfen Sie, ob das emittierte Objekt dieselbe Instanz ist. Wenn Sie ein Feld, eine gecachte Liste oder ein Singleton-Modell pushen, treffen Sie mit ziemlicher Sicherheit auf dieses Problem.

Wenn stattdessen der Stream selbst aufhört zu feuern, ist das ein anderes Problem: eine `StreamSubscription`, die abgebrochen wurde, ein Controller, der geschlossen wurde, oder ein Provider, der verworfen und neu erstellt wurde. Zur Verwerfungsseite von Stream-Lebenszyklen siehe [Abbrechen einer StreamSubscription in dispose](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

## Verwandte Fallstricke im selben 3.0-Release

Der Gleichheitsfilter ist einer aus einer Reihe von 3.0-Änderungen, die zur Laufzeit statt zur Kompilierzeit auftauchen, was sie so teuer zu debuggen macht. Zwei weitere, die man kennen sollte, bevor man ausliefert:

- **Fehler kommen jetzt eingepackt heraus.** Ein Provider, der wirft, wirft Ihre ursprüngliche Ausnahme nicht mehr direkt erneut. Siehe [Riverpod 3.0 wirft ProviderException statt des ursprünglichen Fehlers](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/) dafür, wie Sie es auspacken.
- **Fehlgeschlagene Provider wiederholen automatisch.** Ein `FutureProvider` oder `StreamProvider`, der einen Fehler erzeugt, wiederholt standardmäßig mit exponentiellem Backoff, was einen Fehler verschleiern oder einen ausfallenden Endpunkt hämmern kann. Schalten Sie es pro Provider oder global aus, wie in [Deaktivieren der automatischen Provider-Wiederholung von Riverpod 3.0](/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/) beschrieben.

Und wenn die asynchronen Lücken in Ihrem Notifier `ref` nach einem `await` berühren, sichern Sie sie mit der mounted-Prüfung ab, die in [Prüfen von Ref.mounted nach einer asynchronen Lücke](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) behandelt wird.

## Die Ein-Zeilen-Regel, die man sich merken sollte

Riverpod 3.0 baut neu auf, wenn `previous != next`. Wenn Ihr `StreamProvider` ein veränderliches Objekt wiederverwendet, sind `previous` und `next` dieselbe Referenz, also sind sie immer gleich und es baut nie neu auf. Emittieren Sie unveränderliche Schnappschüsse (oder geben Sie Ihrem Werttyp echte Gleichheit), und das Framework macht das Richtige. Greifen Sie nur dann zu `updateShouldNotify`, wenn Sie den emittierten Wert nicht kontrollieren können. Für einen breiteren Blick darauf, wann ein `StreamProvider` und sein `AsyncValue` überhaupt das richtige Werkzeug sind gegenüber den älteren Builder-Widgets, ist der Vergleich von [FutureBuilder und StreamBuilder gegen Riverpods AsyncValue](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) eine gute nächste Lektüre.

## Quellen

- [Migrating from 2.0 to 3.0, Riverpod official docs](https://riverpod.dev/docs/3.0_migration)
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new)
- [rrousselGit/riverpod issue #4310: updateShouldNotify changes are downplayed in the migration guide](https://github.com/rrousselGit/riverpod/issues/4310)
- [StreamProvider class reference, flutter_riverpod](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/StreamProvider-class.html)
