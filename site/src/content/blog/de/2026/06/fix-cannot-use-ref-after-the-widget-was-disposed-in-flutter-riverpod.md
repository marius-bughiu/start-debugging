---
title: "Lösung: Bad state: Cannot use \"ref\" after the widget was disposed in Flutter Riverpod"
description: "Dieser Absturz bedeutet, dass ein WidgetRef nach dem Entfernen seines Widgets aus dem Baum verwendet wurde, meist in einer asynchronen Callback. Lesen Sie alles vor dem await und sichern Sie mit einer mounted-Prüfung."
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "de"
translationOf: "2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-06-14
---

Ihr Code hat einen Riverpod-`WidgetRef` verwendet, nachdem das zugehörige Widget verworfen wurde. Der übliche Auslöser ist eine asynchrone Callback (ein `await`, `Future.then`, `Timer` oder Stream-Listener), die abschließt, nachdem der Benutzer den Bildschirm verlassen hat, und dann `ref.read`, `ref.watch` oder `ref.listen` aufruft. Die Lösung besteht darin, alles Benötigte aus `ref` vor dem `await` zu lesen und jede nachfolgende Arbeit mit einer `if (!mounted) return;`-Prüfung zu sichern. Dieser Leitfaden verwendet Flutter 3.44 (stabil, Mai 2026), Dart 3.x und Riverpod 3.0 (veröffentlicht im September 2025).

Ein `WidgetRef` ist an die Lebensdauer des Widgets gebunden, von dem er stammt. In dem Moment, in dem dieses Widget aus dem Baum entfernt wird, wird der ref ungültig, und jede weitere Verwendung wirft eine Ausnahme. Das ist beabsichtigt: Ein verworfenes Widget hat nichts mit dem Lesen oder Schreiben von Providern zu tun, und Riverpod scheitert lieber lautstark, als still Zustand in einen Bildschirm zu leiten, den der Benutzer bereits verlassen hat.

## Der Fehler im Kontext

Die vollständige Meldung, die Riverpod wirft, sieht so aus:

```
Unhandled Exception: Bad state: Cannot use "ref" after the widget was disposed.
#0      ProviderElementBase._assertNotDisposed (package:flutter_riverpod/...)
#1      ConsumerStatefulElement.read (package:flutter_riverpod/src/consumer.dart)
#2      _CheckoutScreenState._submit.<anonymous closure> (package:my_app/checkout_screen.dart:42)
...
```

Der Frame in Ihrem eigenen Code benennt die Zeile, die den toten ref berührt hat: einen Aufruf von `ref.read(...)`, `ref.watch(...)` oder `ref.listen(...)`. Dieser Frame ist, wo die Ausnahme auftaucht, aber der Grund, warum sie ausgelöst wurde, liegt zeitlich früher, als das Widget verworfen wurde, bevor diese Zeile lief.

Es gibt eine eng verwandte Variante mit einem leicht anderen Substantiv:

```
Bad state: Cannot use "ref" after the provider was disposed.
```

Diese stammt vom `Ref` innerhalb eines `Notifier` oder `AsyncNotifier`, nicht von einem `WidgetRef` in einem Widget. Gleiche Familie, gleiche Grundursache, anderer Eigentümer. Die Widget-Version sagt "widget"; die Provider-Version sagt "provider". Die Lösung unterscheidet sich leicht, und der Abschnitt zu Notifiern weiter unten behandelt sie.

## Warum das passiert

Es gibt vier Ursachen, grob in der Reihenfolge ihrer Häufigkeit.

Ein `WidgetRef` wurde in einer asynchronen Callback eingefangen, die das Widget überlebte. Sie starteten ein `await`, ein `Future.then`, einen `Timer` oder ein `stream.listen`, während der Bildschirm lebte, der Benutzer schloss die Route (was den `ConsumerState` verwirft und seinen `ref` ungültig macht), und dann schloss die Callback ab und rief `ref.read` auf. Das ist mit Abstand die häufigste Ursache, denn sie stürzt nur ab, wenn das Timing passt: Sie funktioniert jedes Mal, wenn die erwartete Arbeit schnell ist, und stürzt ab, wenn das Netzwerk langsam oder der Benutzer schnell ist.

Sie haben `ref` innerhalb von `dispose()` verwendet. Ein `ConsumerState.dispose()`, das `ref.read` zur Bereinigung aufruft (ein Abonnement abbrechen, einen Puffer leeren, einen Provider benachrichtigen), läuft in diesen Fehler, denn wenn `dispose` läuft, ist der `WidgetRef` bereits abgebaut. Das Riverpod-Team verfolgt genau diese Form in [Issue 4142](https://github.com/rrousselGit/riverpod/issues/4142): Das Widget sieht noch gemountet aus, aber der ref des Elements ist weg. Die Bereinigung muss über das eigene `ref.onDispose` des Providers erfolgen, nicht über das `dispose` des Widgets.

Sie haben einen `WidgetRef` in einem langlebigen Objekt gespeichert. Ein Controller, Dienst oder eine "Logik"-Klasse, die den in `build` erhaltenen `ref` festhält, behält eine veraltete Referenz. Wenn das Widget neu baut oder verschwindet, zeigt dieser gespeicherte ref auf ein verworfenes Element. Ein `WidgetRef` ist kein dauerhafter Handle; er ist nur für die Widget-Instanz gültig, die ihn besitzt.

Ein Provider wurde über eine asynchrone Lücke innerhalb eines Notifiers verworfen. In einem `autoDispose`-Notifier `await`-en Sie etwas, der Provider verliert während der Lücke seinen letzten Listener (oder wird invalidiert), Riverpod verwirft ihn, und die Zeile nach dem `await` liest `ref`. Das ist die Variante "after the provider was disposed". Riverpod 3.0 machte das seltener, indem es Listener beim Neubau pausiert, statt sie sofort zu entfernen, aber ein `autoDispose`-Provider, der mitten im await wirklich alle seine Watcher verliert, wird trotzdem verworfen. Das Thema wird in [Riverpod-Issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) diskutiert.

Der zugrunde liegende Vertrag aus den Release Notes von Riverpod 3.0: "Refs and Notifiers can no longer be interacted with after they have been disposed". Riverpod 3.0 wirft bei jeder Interaktion nach dem Verwerfen eine Ausnahme, statt sie zu tolerieren, und deshalb stürzt Code, der in 2.x manchmal still scheiterte, jetzt lautstark ab. Das ist das Framework, das seine Arbeit tut.

## Ein minimaler Repro

Dieser Bildschirm stürzt ab, wenn Sie ihn verlassen, bevor das Absenden abgeschlossen ist. Er kompiliert und läuft und funktioniert jedes Mal, wenn das Netzwerk schnell ist.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- throws "Cannot use \"ref\" after the widget was disposed".
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final cartProvider = NotifierProvider<CartNotifier, int>(CartNotifier.new);

class CartNotifier extends Notifier<int> {
  @override
  int build() => 3;
  void clear() => state = 0;
}

class CheckoutScreen extends ConsumerStatefulWidget {
  const CheckoutScreen({super.key});

  @override
  ConsumerState<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends ConsumerState<CheckoutScreen> {
  Future<void> _submit() async {
    // Pretend this posts the order and takes ~800ms.
    await Future.delayed(const Duration(milliseconds: 800));
    // If the user popped this screen during those 800ms, the ConsumerState and
    // its WidgetRef are already disposed. This line then throws.
    ref.read(cartProvider.notifier).clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: _submit,
          child: const Text('Place order'),
        ),
      ),
    );
  }
}
```

Tippen Sie auf "Place order" und schließen Sie dann den Bildschirm innerhalb von 800 Millisekunden. Der `ConsumerState` wird verworfen, sein `ref` wird ungültig, das `Future` schließt ab, und `ref.read(cartProvider.notifier)` wirft die Ausnahme. Der Absturz hängt vom Timing ab, und genau deshalb übersteht er das Code-Review und geht in Produktion.

## Die Lösung im Detail

Die Lösungen sind danach geordnet, wie sehr ich sie empfehle. Wählen Sie die, die zu Ihrer Ursache passt.

### 1. Vor dem await lesen, den Rest mit mounted sichern (empfohlen)

Zwei Regeln decken fast jedes Vorkommnis auf Widget-Seite ab. Erstens: Lösen Sie alles, was Sie aus `ref` brauchen, vor dem `await` auf, solange das Widget garantiert lebt. Zweitens: Prüfen Sie nach dem `await` `mounted`, bevor Sie den Baum berühren, `setState` aufrufen oder einen weiteren `ref`-Aufruf machen.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- correct.
Future<void> _submit() async {
  // Resolve the notifier BEFORE the await, while ref is still valid.
  final cart = ref.read(cartProvider.notifier);

  await Future.delayed(const Duration(milliseconds: 800)); // post the order

  if (!mounted) return; // the ConsumerState (and its WidgetRef) may be gone
  cart.clear();
}
```

`cart` ist eine einfache Objektreferenz auf den Notifier; sie veraltet nicht, wenn das Widget verworfen wird, daher ist der Aufruf von `cart.clear()` nach dem await sicher. Die `mounted`-Prüfung hindert Sie daran, auch die UI (ein `setState`, ein `Navigator.push`, einen `ScaffoldMessenger`-Aufruf) auf einem toten Widget anzusteuern. `mounted` ist hier das standardmäßige `State.mounted`, das `ConsumerState` wie jeder andere `State` bereitstellt.

Die Regel ist dieselbe, die die Controller-Verwerfungsabstürze behebt: Nach jedem `await` in einer `State`-Methode muss der nächsten Zeile, die `this`, `ref` oder den Baum berührt, eine `mounted`-Prüfung vorausgehen. Der Dart-Analyzer-Lint `use_build_context_synchronously` fängt die `BuildContext`-Version dieses Fehlers; behandeln Sie `ref` genau gleich. Dieselbe Disziplin erscheint in der [Lösung für TextEditingController used after being disposed](/de/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/), weil es dieselbe Bug-Klasse mit einem anderen Objekt ist.

### 2. In einem Notifier ref.mounted nach der asynchronen Lücke prüfen

Wenn der Absturz die Variante "after the provider was disposed" ist, befinden Sie sich in einem `Notifier` oder `AsyncNotifier`, nicht in einem Widget. Riverpod 3.0 fügte `Ref.mounted` hinzu, das Provider-seitige Äquivalent zu `BuildContext.mounted`. Lesen Sie die Abhängigkeiten vor dem await und machen Sie dann das Schreiben des Zustands von `ref.mounted` abhängig.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0
class OrdersNotifier extends AsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => _repo().fetch();

  OrderRepository _repo() => ref.read(orderRepositoryProvider);

  Future<void> refresh() async {
    final repo = _repo(); // read deps before the gap
    final next = await AsyncValue.guard(repo.fetch);

    if (!ref.mounted) return; // the provider may have been disposed mid-fetch
    state = next;
  }
}
```

Vor Riverpod 3.0 gab es kein `ref.mounted`, und die übliche Behelfslösung war ein kleines Mixin, das in `ref.onDispose` ein Flag umlegt. In 3.0 können Sie dieses Mixin löschen: `ref.mounted` ist die unterstützte Prüfung. Das Setzen von `state` auf einem verworfenen Notifier ist das, was die Ausnahme wirft, daher steht die Absicherung unmittelbar vor der Zuweisung. Das ist dieselbe Form, die die [Lade- und Fehlerzustände mit AsyncValue](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) über eine asynchrone Lücke hinweg sicher hält.

### 3. Speichern Sie keinen WidgetRef in einer Logik-Klasse

Wenn der Absturz nicht asynchron ist, handelt es sich oft um einen gespeicherten ref. Ein `WidgetRef` gehört zu genau einem Widget und stirbt mit ihm, daher dereferenziert ein Controller oder Dienst, der ihn festhält, irgendwann eine Leiche. Verschieben Sie die Logik in einen Notifier und lassen Sie ihn den immer lebenden `Ref` des Providers verwenden.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- the logic owns a durable Ref, not a WidgetRef.
final sessionProvider = NotifierProvider<SessionNotifier, Session?>(SessionNotifier.new);

class SessionNotifier extends Notifier<Session?> {
  @override
  Session? build() => null;

  Future<void> signOut() async {
    await ref.read(authProvider).signOut(); // ref here is the provider's Ref
    if (!ref.mounted) return;
    state = null;
  }
}
```

Widgets rufen dann `ref.read(sessionProvider.notifier).signOut()` aus einem Event-Handler auf, und die langlaufende Arbeit liegt hinter einem `Ref`, den Riverpod am Leben hält, solange der Provider in Gebrauch ist. Das Widget muss nie seinen eigenen `ref` überleben. Die Lebenszyklus-Verantwortung aus den Widgets heraus und in die Notifier hinein zu verlagern, ist genau die Form, auf der eine [Migration von GetX zu Riverpod](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) aufbaut, und einer der Gründe, warum [Riverpod 2026 die Standardwahl für das State-Management ist](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/).

### 4. Verwenden Sie ref niemals im dispose() des Widgets

Bereinigung, die einen Provider braucht, gehört nicht in `ConsumerState.dispose()`, denn zu diesem Zeitpunkt ist der `WidgetRef` bereits ungültig. Es gibt zwei korrekte Heimstätten dafür. Wenn die Ressource einem Provider gehört, registrieren Sie die Bereinigung mit `ref.onDispose` innerhalb dieses Providers, wo sie läuft, wenn der Provider verworfen wird:

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- cleanup lives with the provider, not the widget.
final socketProvider = NotifierProvider<SocketNotifier, void>(SocketNotifier.new);

class SocketNotifier extends Notifier<void> {
  late final WebSocketChannel _channel;

  @override
  void build() {
    _channel = WebSocketChannel.connect(Uri.parse('wss://example.com'));
    ref.onDispose(_channel.sink.close); // runs when the provider goes away
  }
}
```

Wenn Sie wirklich etwas beim Abbau des Widgets tun müssen, fangen Sie das einfache Objekt (den Notifier, das Abonnement, den Wert) in `initState` oder `didChangeDependencies` ein und speichern Sie es in einem Feld, dann verwenden Sie dieses Feld in `dispose()`. Rufen Sie `ref.read` nicht aus `dispose` selbst auf.

## Fallstricke und Varianten

`Cannot use "ref" after the provider was disposed`. Der Notifier-seitige Zwilling dieses Fehlers, behandelt durch Lösung 2 oben. Wenn der Stack-Frame in einem `Notifier`/`AsyncNotifier` statt in einem `ConsumerState` liegt, wollen Sie `ref.mounted`, nicht `State.mounted`. Die beiden Meldungen unterscheiden sich um ein Wort, und dieses Wort sagt Ihnen, welche Prüfung Sie verwenden sollen.

`ref.read` in `onPressed` funktioniert, `ref.read` nach `await` im selben Handler nicht. Der synchrone Teil eines Event-Handlers läuft, während das Widget lebt, daher ist ein nacktes `ref.read` am Anfang von `onPressed` in Ordnung. Nur der Code nach einem `await` kann auf einem verworfenen Widget landen. Die Trennlinie ist das erste `await`, nicht der Handler.

Der Absturz passiert nur manchmal. Das ist die Signatur der asynchronen Ursache, nicht eines instabilen Frameworks. Ein schnelles Backend verbirgt ihn; ein langsames oder ein schneller Benutzer legt ihn offen. Reproduzieren Sie ihn deterministisch, indem Sie ein künstliches `Future.delayed` vor dem `ref`-Aufruf einfügen und den Bildschirm während der Verzögerung schließen, genau wie der obige Repro es tut.

Es begann nach dem Upgrade auf Riverpod 3.0. Riverpod 3.0 wirft bei Interaktion nach dem Verwerfen eine Ausnahme, wo 2.x sie manchmal tolerierte. Code, der vorher "funktionierte", berührte bereits einen verworfenen ref; 3.0 brachte einen latenten Bug ans Licht, statt einen einzuführen. Die Release Notes stellen klar fest, dass refs und Notifier nach dem Verwerfen nicht mehr verwendet werden können. Beheben Sie den Zugriff, fixieren Sie nicht auf 2.x zurück, um ihn zu verbergen.

`ConsumerWidget` (zustandslos), das dies auslöst. Ein `ConsumerWidget` hat kein `mounted`, weil es keinen `State` hat. Wenn Sie seinen `ref` in einer Callback einfangen, die das Widget überlebt, wechseln Sie zu einem `ConsumerStatefulWidget`, um ein `mounted`-Flag zum Absichern zu haben, oder schieben Sie die asynchrone Arbeit in einen Notifier (Lösung 3), damit das Widget den ref nie über sein eigenes Leben hinaus festhält.

`use_build_context_synchronously` markiert `ref` nicht. Der Analyzer-Lint, der einen nach einem await verwendeten `BuildContext` fängt, hat kein eingebautes Äquivalent für `WidgetRef`. Statische Analyzer wie DCM und das Lint-Set von Riverpod 3.0 fügen Regeln dafür hinzu (ref und state synchron verwenden), und es lohnt sich, sie einzuschalten, aber ab Werk warnt der Compiler nicht. Behandeln Sie jeden `ref` nach einem `await` als verdächtig, genau wie Sie `context` behandeln.

Die einzige Disziplin, die diese ganze Bug-Klasse beseitigt: Ein `WidgetRef` ist nur innerhalb des synchronen Rumpfes des Widgets gültig, das ihn besitzt, lesen Sie also alles Benötigte vor jedem `await`, sichern Sie alles Nachfolgende mit `mounted` (Widgets) oder `ref.mounted` (Notifier) und halten Sie dauerhafte Logik in Providern statt in Widgets, die kommen und gehen. Verankern Sie das in Ihrem Reflex für asynchrone Handler, und der Fehler hört auf zu erscheinen. Es ist derselbe `mounted`-Absicherungsreflex, der den [Fehler setState oder markNeedsBuild called during build](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) behebt, und das langsame Antwort-Timing, das ihn auslöst, lässt sich meist darauf zurückführen, [wie die App Netzwerkfehler behandelt](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/).

## Verwandte Artikel

- [Lösung: A TextEditingController was used after being disposed in Flutter](/de/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) ist derselbe Nach-dem-Verwerfen-Absturz für Controller, mit derselben mounted-Absicherung.
- [So zeigen Sie Lade- und Fehlerzustände mit AsyncValue in Flutter Riverpod](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) hält asynchrone Ergebnisse im Zustand eines Notifiers, abseits des gefährlichen Nach-await-Pfads.
- [Lösung: setState() or markNeedsBuild() called during build in Flutter](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) teilt die mounted-Absicherungsdisziplin für asynchrone Callbacks.
- [So migrieren Sie eine Flutter-App von GetX zu Riverpod](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) zeigt, wie man Logik in Notifier verschiebt, die einen dauerhaften Ref besitzen.
- [Provider vs Riverpod vs Bloc für State-Management in Flutter 2026](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) erläutert, warum ein vom Notifier verwalteter Lebenszyklus der moderne Standard ist.

## Quellen

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- führt `Ref.mounted` und die Regel "refs and notifiers can no longer be interacted with after they have been disposed" ein.
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- zur Lebensdauer von `WidgetRef` im Vergleich zum `Ref` eines Providers.
- [rrousselGit/riverpod issue 4142](https://github.com/rrousselGit/riverpod/issues/4142) -- der Fehler, der beim Verwenden von `ref` in der `dispose`-Callback eines Widgets geworfen wird.
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- `ref` in einem Notifier nach einer asynchronen Lücke verwenden und die Listener-Pausierungslösung in 3.0.
- [Prüfen, ob ein AsyncNotifier gemountet ist, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- das `ref.mounted`-Muster in Riverpod 3.0 und das ältere 2.x-Mixin.
