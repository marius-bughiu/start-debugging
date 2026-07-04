---
title: "Ref.mounted nach einem asynchronen Unterbruch in Flutter Riverpod 3 prüfen"
description: "In einem Notifier lösen Sie die Abhängigkeiten vor dem await auf und schützen dann die state-Schreiboperation mit if (!ref.mounted) return. Das ist der Riverpod-3.0-Ersatz für das alte onDispose-Mixin und verhindert eine UnmountedRefException, wenn ein Provider mitten in einem await verworfen wird. Getestet mit flutter_riverpod 3.x, Flutter 3.44, Dart 3.x."
pubDate: 2026-07-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
lang: "de"
translationOf: "2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3"
translatedBy: "claude"
translationDate: 2026-07-04
---

Die Regel ist kurz: In einem `Notifier` oder `AsyncNotifier` kann ein `await` den Provider verwerfen, bevor Ihr Code fortgesetzt wird, und das Schreiben von `state` auf einem verworfenen Provider löst eine Ausnahme aus. Lesen Sie also alles, was Sie brauchen, vor dem ersten `await` aus `ref`, erledigen Sie die asynchrone Arbeit und schützen Sie dann die `state`-Schreiboperation mit `if (!ref.mounted) return;`. `Ref.mounted` ist eine Eigenschaft von Riverpod 3.0, das Provider-seitige Gegenstück zu `BuildContext.mounted`, und es ist der unterstützte Weg, um nach einem asynchronen Unterbruch zu fragen: "Lebt dieser Provider noch?" Diese Anleitung ist mit `flutter_riverpod` 3.x getestet (die 3.0-Linie erschien im September 2025; die aktuelle Version ist 3.3.2), Flutter 3.44 (stabil, Mai 2026) und Dart 3.x.

Wenn Sie jemals ein eigenes Mixin geschrieben haben, das in `ref.onDispose` einen Boolean umschaltet, damit Sie ihn nach einem await prüfen konnten, können Sie es jetzt löschen. `Ref.mounted` tut genau das, korrekt und ohne Boilerplate.

## Warum ein await einen Provider verworfen zurücklassen kann

Der `Ref` eines Providers ist an die Lebensdauer dieses Providers gebunden. Wenn der Provider verworfen wird, wird sein `Ref` ungültig, und Riverpod 3.0 löst bei jeder weiteren Interaktion damit eine Ausnahme aus, einschließlich des Lesens von `ref`, des Aufrufs von `ref.read` oder der Zuweisung von `state`. Die Ausnahme, die Sie erhalten, ist `UnmountedRefException`: "die Verwendung von `ref` oder `state` nach einem asynchronen Unterbruch löst eine Ausnahme aus, wenn der Notifier bereits unmounted ist".

Der Grund, warum dies gerade nach einem `await` zuschlägt, ist der asynchrone Unterbruch. Drei Dinge können einen Provider verwerfen, während Sie in einem `Future` suspendiert sind:

Ein `autoDispose`-Provider verliert seinen letzten Listener. Wenn das Widget, das den Provider beobachtet, während des await vom Stack genommen wird, hört niemand mehr auf den Provider, also verwirft Riverpod ihn. Ihre Fortsetzung erwacht dann mit einem toten `Ref`.

Der Provider wird explizit invalidiert. Ein anderer Teil der App ruft während des Unterbruchs `ref.invalidate(myProvider)` oder `ref.refresh(myProvider)` auf, was die aktuelle Instanz abbaut und eine neue erstellt. Der `Ref` der alten Instanz, den Ihre suspendierte Methode hält, ist nun verworfen.

Eine Abhängigkeit ändert sich. Der Provider ruft `watch` auf etwas auf, das sich geändert hat, und erzwingt einen Neuaufbau. Der `Ref` des vorherigen Builds wird ausgemustert.

Riverpod 3.0 machte den ersten Fall seltener, indem es Listener über einen Neuaufbau hinweg pausiert, statt sie sofort fallen zu lassen, sodass ein Provider, der lediglich neu aufbaut, sich nicht eifrig verwirft. Aber ein wirklich verwaister `autoDispose`-Provider, der mitten in einem await alle Beobachter verliert, wird immer noch verworfen. Die Änderung am Lebenszyklus reduzierte die Fehlalarme; sie entfernte nicht die echten. Genau dieses Szenario wird in [riverpod-Issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) verfolgt.

Das wichtige mentale Modell: Der Absturz ist zeitabhängig. Wenn die erwartete Arbeit schnell ist, lebt der Provider bei der Fortsetzung meist noch, und alles funktioniert. Wenn das Netzwerk langsam ist oder der Benutzer schnell navigiert, wird der Provider zuerst verworfen, und die `state`-Schreiboperation schlägt fehl. Deshalb besteht dieser Bug das Code-Review, läuft auf Ihrem Rechner und stürzt in der Produktion ab.

## Die kleinste Reproduktion

Dieser `AsyncNotifier` holt eine Liste und schreibt sie nach dem await zurück in `state`. Er kompiliert, läuft und besteht jedes Mal, wenn das Abrufen schnell ist.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- throws UnmountedRefException.
import 'package:flutter_riverpod/flutter_riverpod.dart';

final ordersProvider =
    AsyncNotifierProvider.autoDispose<OrdersNotifier, List<Order>>(
  OrdersNotifier.new,
);

class OrdersNotifier extends AutoDisposeAsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => ref.read(orderRepositoryProvider).fetch();

  Future<void> refresh() async {
    state = const AsyncLoading();
    // ~800ms round trip. If the screen that watches ordersProvider is popped
    // during this await, the autoDispose provider loses its last listener and
    // is disposed. The line below then runs on a dead Ref.
    final orders = await ref.read(orderRepositoryProvider).fetch();
    state = AsyncData(orders); // throws UnmountedRefException
  }
}
```

Lösen Sie `refresh()` aus, nehmen Sie den Bildschirm innerhalb der 800 Millisekunden vom Stack, und die Zeile `state = AsyncData(orders)` löst die Ausnahme aus. Am Abrufen ist nichts falsch. Das Problem ist, dass `refresh` annahm, der Provider würde noch existieren, wenn das `Future` abgeschlossen ist, und für einen `autoDispose`-Provider, dessen Beobachter weg ist, existiert er nicht.

## Die Lösung, Schritt für Schritt

Zwei Regeln decken fast jedes Vorkommen ab. Lösen Sie Ihre Abhängigkeiten vor dem Unterbruch auf und schützen Sie die state-Schreiboperation danach.

1. **Lesen Sie jede benötigte Abhängigkeit vor dem ersten `await`.** Während der Provider garantiert lebt (der synchrone Teil Ihrer Methode), rufen Sie `ref.read` für jeden Dienst, jedes Repository oder jeden Notifier auf, den Sie verwenden werden, und speichern Sie die Ergebnisse in lokalen Variablen. Eine Referenz auf ein einfaches Objekt wird nicht veraltet, wenn der Provider verworfen wird; nur der `Ref` tut das.

2. **Erledigen Sie die asynchrone Arbeit.** Warten Sie auf Ihre `Future` unter Verwendung der lokalen Variablen, die Sie erfasst haben. Berühren Sie `ref` nicht innerhalb der erwarteten Ausdrücke, wenn Sie es vermeiden können.

3. **Schützen Sie die Fortsetzung mit `ref.mounted`.** Unmittelbar bevor Sie `state` zuweisen (oder eine `ref`-Methode aufrufen), prüfen Sie `if (!ref.mounted) return;`. Wenn der Provider während des Unterbruchs verworfen wurde, brechen Sie sauber ab, statt eine Ausnahme auszulösen.

4. **Weisen Sie `state` zu.** Jetzt landet die Schreiboperation auf einem lebenden Provider.

Hier ist der korrigierte Notifier:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- correct.
class OrdersNotifier extends AutoDisposeAsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => ref.read(orderRepositoryProvider).fetch();

  Future<void> refresh() async {
    final repo = ref.read(orderRepositoryProvider); // 1. read deps first
    state = const AsyncLoading();

    final next = await AsyncValue.guard(repo.fetch); // 2. async work

    if (!ref.mounted) return; // 3. the provider may be gone
    state = next;             // 4. safe write
  }
}
```

`repo` ist ein langlebiger Objekt-Handle; er funktioniert nach dem await einwandfrei, selbst wenn der Provider tot ist. Die `ref.mounted`-Prüfung ist es, die den Absturz stoppt: Sie gibt `false` zurück, wenn der Provider verworfen wurde, sodass die `state`-Zuweisung nie gegen einen ungültigen `Ref` läuft. Das ist dieselbe Disziplin, die die [Lade- und Fehlerzustände mit AsyncValue](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) sicher hält, und sie ist strukturell identisch mit dem [BuildContext-nach-await-Schutz](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) auf der Widget-Seite.

Die offizielle Riverpod-3.0-Dokumentation zeigt genau dieses Muster:

```dart
// From the Riverpod 3.0 "what's new" docs.
Future<void> addTodo(String title) async {
  final newTodo = await api.addTodo(title);
  if (!ref.mounted) return;
  state = [...state, newTodo];
}
```

## ref.mounted, WidgetRef und context.mounted: welche Prüfung wohin gehört

Die häufigste Quelle der Verwirrung ist, welches `mounted` Sie wollen, denn es gibt drei davon, und sie leben auf drei verschiedenen Objekten.

`ref.mounted` liegt auf dem `Ref` des Providers, den Sie in einem `Notifier`, `AsyncNotifier` oder im Rumpf eines funktionalen Providers (`Ref ref`) erhalten. Verwenden Sie es, wenn der asynchrone Code in einem Provider lebt. Dies ist die Eigenschaft, die Riverpod 3.0 hinzugefügt hat; sie existierte in 2.x nicht.

`context.mounted` liegt auf `BuildContext`. Verwenden Sie es, wenn der asynchrone Code in einem Widget lebt und Sie danach den Baum berühren müssen (`Navigator`, `ScaffoldMessenger`, `Theme.of`). Der `use_build_context_synchronously`-Lint des Dart-Analyzers erzwingt diese.

`State.mounted` liegt auf `State` (und somit auf `ConsumerState`). Verwenden Sie es in einem `ConsumerStatefulWidget`, bevor Sie `setState` aufrufen oder `WidgetRef` nach einem await lesen. Achten Sie auf die Falle: Ein `WidgetRef` in einem Widget ist nicht dasselbe Objekt wie der `Ref` eines Providers und hat kein `ref.mounted`. In einem Widget schützen Sie mit `context.mounted` oder `State.mounted`, nicht mit `ref.mounted`.

Die Faustregel: Wenn der Stack-Frame, der die Ausnahme auslöst, in einem `Notifier` oder `AsyncNotifier` liegt, wollen Sie `ref.mounted`. Wenn er in einem `ConsumerState` oder einem `ConsumerWidget` (build/Callback) liegt, wollen Sie `context.mounted` oder `State.mounted`. Dies falsch zu machen ist die Wurzel des eng verwandten [Absturzes Cannot use "ref" after the widget was disposed](/de/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/), dessen Provider-seitige Variante die proaktive Antwort dieser Anleitung ist.

## Das 2.x-Mixin, das Sie jetzt löschen können

Vor Riverpod 3.0 gab es kein `Ref.mounted`, daher war die Behelfslösung der Community ein Mixin, das die Verwerfung manuell verfolgte:

```dart
// Riverpod 2.x workaround -- no longer needed on 3.0.
mixin NotifierMounted {
  bool _mounted = true;
  void setUnmounted() => _mounted = false;
  bool get mounted => _mounted;
}

class SomeNotifier extends AutoDisposeAsyncNotifier<void>
    with NotifierMounted {
  @override
  FutureOr<void> build() {
    ref.onDispose(setUnmounted); // flip the flag when disposed
  }

  Future<void> doAsyncWork() async {
    final next = await AsyncValue.guard(someFuture);
    if (mounted) {
      state = next;
    }
  }
}
```

Das funktionierte, aber der Maintainer von Riverpod riet ausdrücklich davon ab, und es hatte scharfe Kanten (Sie mussten daran denken, `onDispose` zu registrieren, und das Flag lebte auf der Notifier-Instanz statt auf dem ref). In 3.0 kollabiert das gesamte Mixin auf eine einzige Eigenschaft:

```dart
// Riverpod 3.x -- the mixin is gone, ref.mounted is built in.
class SomeNotifier extends AutoDisposeAsyncNotifier<void> {
  @override
  FutureOr<void> build() {}

  Future<void> doAsyncWork() async {
    final next = await AsyncValue.guard(someFuture);
    if (!ref.mounted) return;
    state = next;
  }
}
```

Wenn Sie von 2.x aktualisieren und ein `NotifierMounted`-Mixin (oder ein handgemachtes `_mounted`-Flag) in Ihrer Codebasis sehen, ist das jetzt Ballast. Löschen Sie das Mixin, löschen Sie die Zeile `ref.onDispose(setUnmounted)` und ersetzen Sie `if (mounted)` durch `if (!ref.mounted) return;`.

## Fallstricke und Randfälle

**`ref.mounted` ist kein Ersatz für die Bereinigung mit `ref.onDispose`.** Der Schutz verhindert eine Schreiboperation auf einem verworfenen Provider; er bereinigt keine Ressourcen. Wenn Ihr Provider ein Abonnement, einen Socket oder einen Timer besitzt, registrieren Sie dessen Abbau mit `ref.onDispose` im `build`. Und rufen Sie `ref.read` nicht innerhalb eines `onDispose`-Callbacks auf: Der Provider wird an dieser Stelle bereits verworfen, also ist `ref` ungültig, und Sie stoßen erneut auf `UnmountedRefException`. Der DCM-Lint `avoid-ref-inside-state-dispose` kennzeichnet genau das.

**Das Lesen eines `autoDispose`-Providers über `.future` kann ihn nach dem ersten await verwerfen.** Es gibt einen subtilen Fall, diskutiert in [riverpod-Diskussion 4293](https://github.com/rrousselGit/riverpod/discussions/4293), bei dem ein über sein `.future` gelesener `autoDispose`-Provider nach dem ersten `await` verworfen wird, weil der durch das Lesen erzeugte temporäre Listener freigegeben wird. Wenn Sie Lesevorgänge über awaits verketten, halten Sie einen echten Listener am Leben (beobachten Sie ihn oder verwenden Sie `ref.keepAlive()`), statt anzunehmen, dass `.future` den Provider offen hält.

**`ref.keepAlive()` ändert die Rechnung.** Ein Provider, den Sie mit `ref.keepAlive()` angepinnt haben, wird kein `autoDispose` durchführen, wenn sein letztes Widget geht, sodass die Ursache "letzten Listener verloren" verschwindet. Er kann immer noch durch ein explizites `invalidate` oder `refresh` verworfen werden, behalten Sie also den `ref.mounted`-Schutz bei, aber verstehen Sie, dass das Anpinnen den häufigsten Auslöser entfernt.

**`AsyncValue.guard` schützt das Mounting nicht.** `AsyncValue.guard` wandelt eine geworfene Ausnahme in einen `AsyncError` um, sodass der Fehler in Ihrem Zustand landet, statt abzustürzen. Es tut nichts gegen die Verwerfung. Sie brauchen danach immer noch das `if (!ref.mounted) return;`, bevor Sie das geschützte Ergebnis `state` zuweisen. Die beiden Mechanismen lösen verschiedene Probleme: `guard` behandelt das Fehlschlagen des Future, `ref.mounted` behandelt das Verschwinden des Providers.

**Ein `ConsumerWidget` hat kein `ref.mounted`.** Sein `ref` ist ein `WidgetRef`, kein Provider-`Ref`. Wenn Sie einen `WidgetRef` in einem asynchronen Callback innerhalb eines zustandslosen `ConsumerWidget` erfasst haben, gibt es kein `mounted` zu prüfen. Verschieben Sie die asynchrone Arbeit in einen Notifier, damit sie hinter einem langlebigen Provider-`Ref` läuft (das ist die Form, die eine [Migration von FutureBuilder zu AsyncNotifier](/de/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) erzeugt), oder wechseln Sie zu einem `ConsumerStatefulWidget`, um `State.mounted` zu haben.

**Es begann erst nach dem Upgrade auf 3.0 zu werfen.** Riverpod 3.0 löst bei einer Interaktion nach der Verwerfung eine Ausnahme aus, wo 2.x sie manchmal stillschweigend tolerierte. Code, der zuvor "funktionierte", schrieb bereits auf einen verworfenen Provider; 3.0 brachte einen latenten Bug an die Oberfläche, statt einen zu erschaffen. Fügen Sie den Schutz hinzu, kehren Sie nicht zu 2.x zurück, um ihn zu verbergen.

## Lassen Sie den Linter die verpassten Fälle fangen

Der Schutz ist eine Gewohnheit, und Gewohnheiten schlüpfen durch. Zwei Regeln der statischen Analyse verwandeln "denke daran, `ref.mounted` zu prüfen" in einen Kompilierungsfehler. DCM liefert `use-ref-and-state-synchronously`, das einen `ref`- oder `state`-Zugriff nach einem asynchronen Unterbruch kennzeichnet, dem keine mounted-Prüfung vorausgeht, und `avoid-ref-inside-state-dispose` für den `onDispose`-Fall. Riverpods eigenes Lint-Set enthält Entsprechungen. Standardmäßig warnt Sie der Dart-Compiler nicht vor `ref` nach einem await, wie er es bei `BuildContext` tut, also ist das Einschalten dieser Regeln der Unterschied zwischen dem Fangen des Bugs in der CI und dem Fangen in einem Absturzbericht.

Die eine Disziplin, die diese ganze Klasse von Bugs beseitigt: Behandeln Sie den `Ref` eines Providers genau wie einen `BuildContext`. Er ist synchron gültig, ein `await` kann ihn ungültig machen, also lesen Sie, was Sie brauchen, vor dem Unterbruch und schützen Sie jede `ref`- oder `state`-Berührung nach dem await mit `if (!ref.mounted) return;`. Verankern Sie das in Ihrem Async-Notifier-Reflex, und `UnmountedRefException` hört auf zu erscheinen. Es ist einer der Gründe, warum [der Notifier-eigene Lebenszyklus von Riverpod 2026 die Standardwahl für State-Management ist](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/).

## Verwandt

- [Fix: Cannot use "ref" after the widget was disposed in Flutter Riverpod](/de/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) ist das reaktive Gegenstück: der Absturz, den Sie erhalten, wenn Sie diesen Schutz auslassen, sowohl auf der Widget- als auch auf der Provider-Seite.
- [BuildContext nach einem await in Flutter sicher verwenden](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) ist derselbe Schutz für das Widget-seitige `context.mounted`.
- [Lade- und Fehlerzustände mit AsyncValue in Flutter Riverpod anzeigen](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) zeigt das Muster aus `AsyncNotifier` plus `AsyncValue.guard`, das dieser Schutz absichert.
- [Von FutureBuilder zu einem Riverpod-AsyncNotifier in Flutter migrieren](/de/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) verschiebt asynchrone Arbeit in einen Provider, wo `ref.mounted` verfügbar ist.
- [Provider vs Riverpod vs Bloc für State-Management in Flutter 2026](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) behandelt, warum der Notifier-eigene Lebenszyklus der moderne Standard ist.

## Quellen

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- führt `Ref.mounted`, das Muster `if (!ref.mounted) return;` und die Lebenszyklusänderung des Listener-Pausierens-beim-Neuaufbau ein.
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- zur Lebensdauer des `Ref` eines Providers gegenüber einem `WidgetRef`.
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- die Verwendung von `ref` in einem Notifier nach einem asynchronen Unterbruch und die 3.0-Korrektur.
- [rrousselGit/riverpod discussion 4293](https://github.com/rrousselGit/riverpod/discussions/4293) -- warum `autoDispose`-Provider nach dem ersten `await` verworfen werden, wenn sie über `.future` gelesen werden.
- [DCM use-ref-and-state-synchronously rule](https://dcm.dev/docs/rules/riverpod/use-ref-and-state-synchronously/) -- der Lint, der eine mounted-Prüfung nach einem asynchronen Unterbruch erzwingt.
- [How to Check if an AsyncNotifier is Mounted with Riverpod, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- das alte 2.x-Mixin und der `ref.mounted`-Ersatz von 3.0.
</content>
