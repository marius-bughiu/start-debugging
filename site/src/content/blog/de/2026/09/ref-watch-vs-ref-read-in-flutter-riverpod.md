---
title: "ref.watch vs ref.read in Riverpod: Was ist der Unterschied und wann verwende ich was"
description: "ref.watch abonniert und baut neu, ref.read liest einmal und baut nie neu. Verwenden Sie watch in jeder build-Methode und read ausschließlich in Event-Callbacks. Hier sind die Entscheidungsmatrix, der Quellcode beider Methoden in flutter_riverpod 3.4.3 und die vier stillen Fehlerfälle: watch in einem Callback, read im Rumpf eines Providers, read auf einem autoDispose-Provider und read als vermeintliche Optimierung."
pubDate: 2026-09-05
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "de"
translationOf: "2026/09/ref-watch-vs-ref-read-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-09-05
---

`ref.watch` registriert ein Abonnement, `ref.read` nicht. Dieser eine Unterschied entscheidet alles Weitere. Verwenden Sie `ref.watch` innerhalb von `build`-Methoden, sowohl im `build` eines `ConsumerWidget` als auch im `build` eines Providers oder eines `Notifier`, und verwenden Sie `ref.read` in Code, der einmalig als Reaktion auf ein Ereignis läuft: `onPressed`, `onTap`, der Callback eines `Timer`, eine Mutationsmethode auf einem `Notifier`. Die Wahl ist kein Leistungskompromiss, sondern eine Regel über die Aufrufstelle: Code, der bei einer Zustandsänderung erneut läuft, muss watch verwenden, Code, der genau einmal läuft, muss read verwenden. Alles Folgende ist gegen `riverpod` und `flutter_riverpod` 3.4.3 (veröffentlicht am 2026-09-03) auf Flutter 3.47.2 stable mit Dart 3.13.2 sowie `riverpod_lint` 3.1.9 verifiziert.

## Die Entscheidungsmatrix

| | `ref.watch` | `ref.read` |
| --- | --- | --- |
| Registriert ein Abonnement | ja | nein |
| Baut den Aufrufer bei Wertänderung neu | ja | nie |
| Hält einen `autoDispose`-Provider am Leben | ja | nein |
| Korrekt innerhalb von `build` | ja, das ist der einzige Ort | fast immer ein Bug |
| Korrekt in `onPressed` / `onTap` / Timern | nein | ja, das ist der einzige Ort |
| Korrekt in `initState` | nein | ja, für eine einmalige Initialbefüllung |
| Korrekt in einer Mutationsmethode eines `Notifier` | nein | ja |
| Pausiert, wenn das Widget nicht sichtbar ist (`TickerMode` in Riverpod 3) | ja | nicht zutreffend |
| Benachrichtigungen per `==` gefiltert | ja | nicht zutreffend |
| Wirft einen Fehler bei falscher Aufrufstelle | nein, es schlägt still fehl | nein |
| Werkzeug gegen zu viele Neuaufbauten | `.select` | nicht dieses |

Die beiden Zeilen, die am meisten Debugging-Zeit kosten, sind die letzten beiden. Es gibt bei keiner der beiden Methoden eine Absicherung zur Laufzeit, und `ref.read` ist nicht der Weg, Neuaufbauten zu reduzieren.

## Die beiden Methoden liegen auf zwei verschiedenen Klassen

Riverpod stellt `watch` und `read` zweimal bereit, auf zwei nicht verwandten Typen, und die Implementierungen unterscheiden sich tatsächlich.

`WidgetRef` bekommen Sie von einem `ConsumerWidget`, einem `Consumer`-Builder oder einem `ConsumerState`. Die Implementierung liegt in `ConsumerStatefulElement`:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
StateT watch<StateT>(ProviderListenable<StateT> target) {
  _assertNotDisposed();
  return _dependencies
          .putIfAbsent(target, () {
            final oldDependency = _oldDependencies?.remove(target);
            if (oldDependency != null) {
              return oldDependency;
            }
            final sub = container.listen<StateT>(
              target,
              (_, _) => markNeedsBuild(),
            );
            _applyTickerMode(sub);
            return sub;
          })
          .readSafe()
          .valueOrProviderException
      as StateT;
}

@override
StateT read<StateT>(ProviderListenable<StateT> provider) {
  _assertNotDisposed();
  return ProviderScope.containerOf(this, listen: false).read(provider);
}
```

`watch` legt eine `ProviderSubscription` in einer Map `_dependencies` pro Element ab, deren Listener `markNeedsBuild()` aufruft. `read` greift mit `listen: false` auf den `ProviderContainer` zu und ruft dort `read` auf. Kein Map-Eintrag, kein Listener, niemals ein Neuaufbau.

`Ref` bekommt der Rumpf eines Providers oder ein `Notifier`. Gleiche Namen, andere Mechanik:

```dart
// package:riverpod/src/core/ref.dart, riverpod 3.4.3
@override
StateT watch<StateT>(ProviderListenable<StateT> listenable) {
  _throwIfInvalidUsage();
  late ProviderSubscription<StateT> sub;
  sub = _element.listen<StateT>(
    listenable,
    (prev, value) => _invalidateSelf(asReload: true, manual: false),
    onError: (err, stack) => _invalidateSelf(asReload: true, manual: false),
    onDependencyMayHaveChanged: _element._markDependencyMayHaveChanged,
  );
  return sub.readSafe().valueOrProviderException;
}

@override
StateT read<StateT>(ProviderListenable<StateT> listenable) {
  _throwIfInvalidUsage();
  final result = container.read(listenable);
  if (kDebugMode) _debugAssertCanDependOn(listenable);
  return result;
}
```

Auf Provider-Seite ist `watch` gleich `listen` plus `invalidateSelf`, was die offizielle Dokumentation im Doc-Kommentar von `Ref.watch` ausdrücklich festhält. `read` ist ein einfacher Container-Lesezugriff. Das Muster ist auf beiden Klassen identisch: watch baut eine Kante im Graphen, read nicht.

## Die Regel betrifft die Aufrufstelle, nicht den Provider

Stellen Sie eine Frage: Muss diese Codezeile erneut laufen, wenn sich der Wert ändert?

- Innerhalb von `build` ja. Der ganze Sinn von `build` ist, dass Riverpod es erneut aufrufen kann. Verwenden Sie `ref.watch`.
- Innerhalb von `onPressed` nein. Die Person drückt den Button erneut, und der Callback läuft erneut mit einem frischen Wert. Verwenden Sie `ref.read`.

Die offizielle Dokumentation ist unmissverständlich, in welche Richtung die Voreinstellung geht. Aus der Riverpod-Seite zu Refs: "Do not use Ref.read as a mean to 'optimize' your code by avoiding Ref.watch. This will make your code more brittle." Und aus dem Doc-Kommentar von `Ref.read` in 3.4.3: "If possible, avoid using [read] and prefer [watch], which is generally safer to use."

Diese Form ist in jeder Riverpod-Version seit 2.0 korrekt:

```dart
// flutter_riverpod 3.4.3, Flutter 3.47.2, Dart 3.13.2
final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Rerun this line on every change: watch.
    final count = ref.watch(counterProvider);

    return Column(
      children: [
        Text('$count'),
        ElevatedButton(
          // Runs once per tap: read.
          onPressed: () => ref.read(counterProvider.notifier).increment(),
          child: const Text('increment'),
        ),
      ],
    );
  }
}
```

## `ref.watch` in einem Callback wirft keinen Fehler, und genau das ist das Problem

Wenn Sie `ref.watch(counterProvider)` in den `onPressed`-Closure verschieben, kompiliert die App, der Analyzer schweigt, und der zurückgegebene Wert stimmt. Nichts in `riverpod_lint` 3.1.9 meldet das: Der Regelsatz besteht aus `missing_provider_scope`, `provider_dependencies`, `scoped_providers_should_specify_dependencies`, `avoid_build_context_in_providers`, `provider_parameters`, `avoid_public_notifier_properties`, `unsupported_provider_value`, `functional_ref`, `notifier_extends`, `avoid_ref_inside_state_dispose`, `avoid_keep_alive_dependency_inside_auto_dispose`, `notifier_build`, `riverpod_syntax_error`, `async_value_nullable_pattern` und `protected_notifier_properties`. Keine davon lautet "watch außerhalb von build".

Was tatsächlich passiert, ist schlimmer als ein Absturz. Sehen Sie sich `ConsumerStatefulElement.build` noch einmal an:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
Widget build() {
  if (_tickerModeNotifier == null) {
    _updateTickerModeNotifier();
  }
  try {
    _oldDependencies = _dependencies;
    for (var i = 0; i < _listeners.length; i++) {
      _listeners[i].close();
    }
    _listeners.clear();
    _dependencies = {};
    return super.build();
  } finally {
    for (final dep in _oldDependencies!.values) {
      dep.close();
    }
    _oldDependencies = null;
  }
}
```

Jeder Build tauscht `_dependencies` gegen eine frische Map und schließt alles, was vom vorherigen Durchlauf übrig ist. Ein aus `onPressed` aufgerufenes `ref.watch` läuft, während `_oldDependencies` gleich `null` ist, und fügt daher ein völlig neues Abonnement in die aktive `_dependencies`-Map ein. Von diesem Moment bis zum nächsten Neuaufbau ist das Widget bei einem Provider abonniert, den seine `build`-Methode nie erwähnt. Ändert sich der Provider in diesem Fenster, feuert `markNeedsBuild` und das Widget baut neu. Danach verwirft der Neuaufbau das Abonnement, weil `build` es nicht erneut registriert, und die zweite Änderung bewirkt nichts.

Das ist einmalige Reaktivität, die vom Frame-Timing abhängt. Genau die Art Bug, die sich nur auf einem langsamen Gerät reproduzieren lässt.

Beachten Sie den Kontrast zu `ref.listen`, das sich selbst absichert:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
void listen<StateT>(
  ProviderListenable<StateT> provider,
  void Function(StateT? previous, StateT value) listener, {
  void Function(Object error, StackTrace stackTrace)? onError,
  bool weak = false,
}) {
  _assertNotDisposed();
  assert(
    debugDoingBuild,
    'ref.listen can only be used within the build method of a ConsumerWidget',
  );
  ...
}
```

`listen` prüft das per assert in Debug-Builds. `watch` nicht. Lesen Sie das Fehlen einer Assertion nicht als Erlaubnis.

## `ref.read` im Rumpf eines Providers friert die Abhängigkeit dauerhaft ein

Derselbe Fehler auf Provider-Seite ist noch leiser, weil es kein Widget gibt, dessen ausbleibender Neuaufbau sichtbar wäre.

```dart
// riverpod 3.4.3, WRONG
final localeProvider = NotifierProvider<LocaleNotifier, Locale>(LocaleNotifier.new);

final greetingProvider = Provider<String>((ref) {
  // No graph edge. This provider will never be recomputed when the locale changes.
  final locale = ref.read(localeProvider);
  return locale.languageCode == 'fr' ? 'Bonjour' : 'Hello';
});
```

`greetingProvider` berechnet einmal und legt das Ergebnis im Cache ab. Ein Wechsel der Locale baut `localeProvider` und jedes Widget neu, das ihn beobachtet, und lässt `greetingProvider` auf einem veralteten String sitzen, bis ihn etwas anderes invalidiert. Tauschen Sie auf `ref.watch(localeProvider)`, und die Kante existiert: `Ref.watch` ruft bei jeder Änderung `_invalidateSelf(asReload: true)` auf, also wird `greetingProvider` bei Bedarf neu berechnet.

Dasselbe gilt innerhalb eines `Notifier`. Der Doc-Kommentar von `Notifier.build` in 3.4.3 sagt es direkt: "It is safe to use [Ref.watch] or [Ref.listen] inside this method." Watch in `build`. In `increment()` oder `submit()` read.

## `ref.read` auf einem `autoDispose`-Provider wirft die Arbeit weg

Das ist die Variante, die zu einem Fehlerbericht mit dem Titel "mein Zustand springt auf null zurück" führt.

Die automatische Entsorgung wird über Listener verfolgt, nicht über Lesezugriffe. Bei Codegenerierung ist `keepAlive: false` die Voreinstellung von `@riverpod`, also entsorgt sich jeder generierte Provider automatisch, sofern Sie nichts anderes angeben:

```dart
// riverpod_annotation 3.x
final class Riverpod {
  const Riverpod({
    this.keepAlive = false,
    ...
  });
}
```

Handgeschriebene Provider verhalten sich umgekehrt. `NotifierProvider` und `Provider` in `riverpod` 3.4.3 deklarieren beide `super.isAutoDispose = false`, bleiben also standardmäßig am Leben, und Sie schalten die Entsorgung mit `NotifierProvider.autoDispose` oder `isAutoDispose: true` frei.

Betrachten Sie nun einen generierten, sich selbst entsorgenden Zähler, den nichts auf dem Bildschirm beobachtet:

```dart
// riverpod_generator 4.x, riverpod 3.4.3
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

// In a widget that does NOT watch counterProvider anywhere:
onPressed: () {
  ref.read(counterProvider.notifier).increment(); // state becomes 1
},
```

`ref.read` erzeugt den Provider, führt `build()` aus, gibt den Notifier zurück und fügt keinen Listener hinzu. Die Dokumentation zur Entsorgung beschreibt das Timing: Erreicht die Listener-Zahl null, gilt der Provider als "not used", Riverpod "waits for one frame", und ist er danach weiterhin ungenutzt, wird er zerstört. Das Inkrement landet also auf einem `Counter`, der einen Frame später abgebaut wird. Der nächste Tipp beginnt wieder bei `0`.

Die Lösung ist nicht `ref.watch` im Callback. Die Lösung ist, dafür zu sorgen, dass etwas den Provider legitim beobachtet, in der Regel das Widget, das den Zählerstand anzeigt, oder `ref.keepAlive()` innerhalb von `build` aufzurufen, falls der Zustand seine Listener wirklich überdauern muss.

## Den Wert beobachten, den Notifier lesen

`ref.read(counterProvider.notifier)` ist der kanonische Weg zu den Mutationsmethoden und steht wortwörtlich im Doc-Kommentar von `Notifier`. `ref.watch(counterProvider.notifier)` ist kein Verbrechen, aber sinnlos: Riverpod filtert in 3.x alle Benachrichtigungen per `==`, und der Doc-Kommentar von `Notifier` hält fest, dass bei einer erneuten Ausführung von `build` gilt: "the [Notifier] will **not** be recreated. Its instance will be preserved between executions of [build]." Dieselbe Instanz ist gleich sich selbst, also feuert das Beobachten von `.notifier` fast nie. Es feuert nur, wenn der Provider vollständig entsorgt und neu erzeugt wird. Sie bekommen ein Abonnement, das Ihnen nichts einbringt ausser einem Auto-Dispose-Keep-Alive, um das Sie nicht gebeten haben.

Also: `ref.watch(provider)` für den Wert, `ref.read(provider.notifier)` für die Methoden.

## `initState` will keines von beiden

In einem `ConsumerState` läuft `initState` vor dem ersten `build`. `ref.watch` wirft dort keinen Fehler, aber das erzeugte Abonnement wird vom ersten Build verworfen, sofern `build` nicht zufällig denselben Provider beobachtet, was das Verhalten zufällig macht. `ref.listen` wirft seine `debugDoingBuild`-Assertion. Die unterstützte API ist `listenManual`:

```dart
// flutter_riverpod 3.4.3
class _FormState extends ConsumerState<MyForm> {
  late final ProviderSubscription<AsyncValue<void>> _sub;

  @override
  void initState() {
    super.initState();
    // Seed a controller once: read is correct here.
    _controller.text = ref.read(draftProvider);

    // Subscribe outside build: listenManual is correct here.
    _sub = ref.listenManual(submitProvider, (previous, next) {
      next.whenOrNull(error: (e, _) => showErrorBar(context, e));
    });
  }
}
```

`listenManual` liest den Container bewusst mit `listen: false`, damit es in `initState` sicher ist, und `ConsumerStatefulElement.unmount` schließt manuelle Listener, nachdem `State.dispose` gelaufen ist. Sie müssen ihn nicht selbst schließen, auch wenn das zurückgegebene Abonnement es erlaubt.

Wenn Sie schon im Lebenszyklus-Code von `State` sind, denken Sie an das andere Ende: `ref` in `dispose` anzufassen wirft einen Fehler, und die Regel `avoid_ref_inside_state_dispose` aus `riverpod_lint` existiert genau dafür. Die Meldung in 3.4.3 lautet `Using "ref" when a widget is about to or has been unmounted is unsafe.`, die aktuelle Formulierung des älteren [Fehlers Cannot use "ref" after the widget was disposed](/de/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

## Riverpod 3 pausiert watch-Abonnements, womit das letzte Argument für read entfällt

Die Folklore "read ist billiger" stammt aus der Zeit vor Riverpod 3. In 3.x nehmen die von `WidgetRef.watch` erzeugten Abonnements am `TickerMode` teil:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
void _updateTickerMode() {
  final isActive = _tickerModeNotifier!.value;
  if (isActive != _isActive) {
    _isActive = isActive;
    for (final sub in _dependencies.values) {
      if (isActive) {
        sub.resume();
      } else {
        sub.pause();
      }
    }
  }
}
```

Verschwindet ein Widget vom Bildschirm, etwa in einem inaktiven Tab einer `TabBarView` oder unter einer darübergelegten Route, werden alle seine watch-Abonnements pausiert und die dahinterliegenden Provider stellen ihre Arbeit ein. Ein Wechsel zu `ref.read` bringt keine vergleichbare Ersparnis, weil `ref.read` nie ein Abonnement hatte, das man pausieren könnte. Die Laufzeitkosten eines watch sind ein Eintrag in einer `HashMap` plus ein Listener-Callback, und das ist nicht das, was Ihr Frame-Budget belastet.

Wenn Sie wirklich weniger Neuaufbauten wollen, ist `.select` das Werkzeug, nicht `read`:

```dart
// flutter_riverpod 3.4.3
// Rebuilds on every user field change:
final user = ref.watch(userProvider);
Text(user.name);

// Rebuilds only when the name changes, because select's output is compared with ==:
final name = ref.watch(userProvider.select((u) => u.name));
Text(name);
```

`select` behält das Abonnement, behält damit die Reaktivität und das Keep-Alive und filtert nur, was als Änderung zählt. Das ist die Optimierung. `ref.read` ist keine Optimierung, sondern das Entfernen einer Funktion.

Beachten Sie, dass die `==`-Filterung in Riverpod 3.0 global gilt und `watch`, `select` und `listen` gleichermaßen betrifft, was eine eigene Überraschungsklasse ist, wenn Ihre Zustandsklasse keine Gleichheit implementiert. Wenn ein watch nicht feuert, obwohl Sie es erwarten, prüfen Sie `==`, bevor Sie die Aufrufstelle verdächtigen: Es ist derselbe Mechanismus hinter [StreamProvider, der in Riverpod 3.0 Events verwirft](/de/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## Was Sie tatsächlich schreiben sollten

Nehmen Sie `ref.watch` als Standard. Greifen Sie zu `ref.read` an genau drei Stellen: in einem Event-Callback, in einer Mutationsmethode eines `Notifier` und bei einem `Ref`, das Sie bewusst auf einer einfachen Service-Klasse abgelegt haben, damit der Service aktuelle Werte ziehen kann, ohne neu erzeugt zu werden, was der Anwendungsfall ist, den die Dokumentation von `Ref.read` selbst zeigt. Überall sonst watch. Wenn Sie ein watch durch ein read ersetzen, damit etwas aufhört, neu zu bauen, haben Sie eine `select`-Gelegenheit oder einen zu grob geschnittenen Provider gefunden, keinen Grund, die Kante aus dem Graphen zu schneiden.

Und wenn ein `ref.watch` in einen Callback zu gehören scheint, wollen Sie vermutlich `ref.listen` in `build` (für Seiteneffekte, solange das Widget lebt) oder `ref.listenManual` in `initState` (für Seiteneffekte, die an den `State` gebunden sind).

## Verwandte Beiträge

- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/de/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)
- [ref.mounted nach einer asynchronen Lücke in Riverpod 3 prüfen](/de/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [Welches Riverpod-Paket installieren: riverpod, flutter_riverpod oder hooks_riverpod](/de/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [Lade- und Fehlerzustände mit AsyncValue anzeigen](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Der vollständige Migrationsleitfaden von Riverpod 2.x auf 3.0](/de/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)

## Quellen

- [Refs](https://riverpod.dev/docs/concepts2/refs), die offizielle Seite zu `Ref.watch`, `Ref.read` und `Ref.listen`.
- [Automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose), zur Schonfrist von einem Frame und zur Verfolgung über die Listener-Zahl.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new), zur `==`-Filterung und zum `TickerMode`-gesteuerten Pausieren.
- [flutter_riverpod 3.4.3 auf pub.dev](https://pub.dev/packages/flutter_riverpod/versions/3.4.3), Quelle des oben zitierten `ConsumerStatefulElement`.
- [riverpod 3.4.3 auf pub.dev](https://pub.dev/packages/riverpod/versions/3.4.3), Quelle der oben zitierten `Ref.watch` und `Ref.read`.
- [riverpod_lint 3.1.9 auf pub.dev](https://pub.dev/packages/riverpod_lint), die oben referenzierte vollständige Regelliste.
