---
title: "Ein StatefulWidget mit setState zu einem Riverpod Notifier in Flutter migrieren"
description: "Schritt für Schritt vom widget-lokalen setState zu einem Riverpod-3.x-Notifier: klassifizieren, was das Widget wirklich verlässt, den Notifier schreiben, auf ConsumerWidget umstellen und die Fallstricke überstehen, die setState-Umsteiger treffen: Filterung per ==, erneute Ausführung von build() und unterschiedliche autoDispose-Voreinstellungen. Getestet mit Flutter 3.44, Dart 3.x und flutter_riverpod 3.3.2."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "de"
translationOf: "2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-25
---

Einen Screen von `setState` auf einen Riverpod-`Notifier` umzustellen dauert etwa eine Stunde, sobald Sie es zweimal gemacht haben, und der größte Teil dieser Stunde entfällt auf die Entscheidung, was **nicht** umziehen soll. Diese Anleitung ist mit Flutter 3.44 (stabil, Mai 2026), Dart 3.x und `flutter_riverpod` 3.3.2 getestet, für die Codegenerierungs-Variante mit `riverpod_generator` 4.0.4 und `riverpod_annotation` 4.0.3. Was bricht, ist selten der Compiler: Die drei Punkte, die wirklich treffen, sind die Filterung der Benachrichtigungen per `==` in Riverpod 3.0 (die In-Place-Mutation einer Liste, die unter `setState` durchging, baut die Oberfläche jetzt stillschweigend nicht mehr neu auf), das erneute Ausführen von `Notifier.build()` dort, wo `initState` nur einmal lief, und die unterschiedlichen Voreinstellungen der automatischen Entsorgung bei generierten und handgeschriebenen Providern. Machen Sie es, wenn zwei Widgets denselben Zustand brauchen, oder wenn Sie die Logik ohne Widget testen wollen. Machen Sie es nicht für einen Screen, der ein einziges Boolean besitzt.

## Warum dieser Zustand das Widget verlassen sollte

- **Zwei Leser, eine Quelle.** Ein Warenkorb-Badge in der `AppBar` und ein Warenkorb-Screen zwei Routen weiter brauchen dieselben Positionen. Mit `setState` heben Sie den Zustand entweder auf einen gemeinsamen Vorfahren und reichen Callbacks nach unten durch, oder Sie halten zwei Kopien und hoffen, dass sie übereinstimmen.
- **Die Logik wird unit-testbar.** Ein `Notifier` ist ein gewöhnliches Dart-Objekt. Sie steuern ihn aus einem `ProviderContainer.test()` in einem normalen `test()`-Block, ohne `pumpWidget`, ohne `WidgetTester` und ohne Frame-Planung.
- **Der Zustand überlebt die Route, wenn Sie das wollen.** Ein `NotifierProvider` behält seinen Wert über ein `Navigator.pop` hinweg, und genau das brauchen ein Warenkorb, ein Formularentwurf oder ein mehrstufiger Assistent. Widget-Zustand stirbt mit dem Element.
- **Mutationen bekommen Namen.** `setState(() => _lines = [..._lines, line])` über sechs Callbacks verstreut wird zu `cartProvider.notifier.add(line)`, und damit zu einer einzigen Stelle zum Protokollieren, Absichern oder Drosseln.

Nichts davon spricht dafür, alles zu verschieben. Ein `TextEditingController`, ein `AnimationController`, ein `FocusNode`, ein `ScrollController` und ein `GlobalKey<FormState>` gehören zum Widget und bleiben in einem `State`-Objekt.

## Was bricht

| Bereich | Änderung | Schweregrad |
| ------- | -------- | ----------- |
| Basisklasse des Widgets | `StatefulWidget` wird zu `ConsumerWidget`, oder zu `ConsumerStatefulWidget`, wenn Controller bleiben | hoch |
| In-Place-Mutation von Collections | Riverpod 3.0 filtert per `==`; `state.add(x)` gefolgt von `state = state` baut nicht neu auf | hoch |
| `setState`-Aufrufe | Ersetzt durch Zuweisung an `state` im `Notifier` | hoch |
| `initState` | Wandert in `Notifier.build()`, das mehr als einmal laufen kann | mittel |
| `dispose` | Wandert zu `ref.onDispose`, nur für Ressourcen des Providers | mittel |
| Lebensdauer des Zustands | Generierte Provider werden standardmäßig automatisch entsorgt, handgeschriebene nicht | mittel |
| `context` nach einem `await` | `context.mounted` im Widget wird zu `ref.mounted` im Notifier | mittel |
| Widget-Tests | `pumpWidget` braucht eine `ProviderScope`-Hülle, sonst wirft jeder Lesezugriff | niedrig |

## Checkliste vorab

1. Flutter 3.44 stabil und Dart 3.x auf der Maschine und in der CI (`flutter --version`).
2. `flutter_riverpod: ^3.3.2` in der `pubspec.yaml` und `ProviderScope` um `runApp`. Wenn Sie noch auf 2.x sind, erledigen Sie dieses Upgrade zuerst und getrennt: siehe [die Migration von Riverpod 2.x auf Riverpod 3.0](/de/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/).
3. Entscheiden Sie jetzt über Codegenerierung, nicht auf halbem Weg. Codegenerierung braucht `riverpod_annotation: ^4.0.3` sowie `riverpod_generator: ^4.0.4` und `build_runner` unter `dev_dependencies`.
4. `riverpod_lint` und `custom_lint` in der `analysis_options.yaml` aktiviert. Das findet `ref.read` in einer `build`-Methode, den häufigsten Fehler dieser Migration.
5. Ein Widget-Test, der das aktuelle Verhalten des Screens festhält, bevor Sie ihn anfassen. Sie brauchen ein Rot/Grün-Signal, kein Bauchgefühl.
6. Ein Branch. Das ist umkehrbar, aber nicht in drei kleinen Commits.

## Der Ausgangspunkt

Ein Warenkorb-Screen, der alles in `State` hält, mit einem bis zum Kind durchgereichten Callback, damit das Badge sich aktualisieren kann:

```dart
// Flutter 3.44, Dart 3.x -- before
class CartScreen extends StatefulWidget {
  const CartScreen({super.key});
  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  List<CartLine> _lines = const [];
  bool _isSubmitting = false;
  final _couponController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _lines = CartStorage.instance.load();
  }

  @override
  void dispose() {
    _couponController.dispose();
    super.dispose();
  }

  void _add(CartLine line) {
    setState(() => _lines = [..._lines, line]);
  }

  void _setQuantity(String sku, int quantity) {
    setState(() {
      _lines = [
        for (final l in _lines)
          if (l.sku == sku) l.copyWith(quantity: quantity) else l,
      ];
    });
  }

  Future<void> _submit() async {
    setState(() => _isSubmitting = true);
    await CheckoutApi.submit(_lines);
    if (!mounted) return;
    setState(() => _isSubmitting = false);
  }

  @override
  Widget build(BuildContext context) => CartView(
        lines: _lines,
        isSubmitting: _isSubmitting,
        couponController: _couponController,
        onQuantityChanged: _setQuantity,
      );
}
```

## Migrationsschritte

1. **Klassifizieren Sie jedes Feld des `State`-Objekts.** Teilen Sie sie auf Papier in zwei Listen, bevor Sie Code schreiben. Domänenzustand, den ein anderes Widget plausibel brauchen könnte (`_lines`, `_isSubmitting`), wandert in den Notifier. Framework-Objekte, die am Element dieses Widgets hängen (`_couponController`, Focus Nodes, Animation Controller, Formularschlüssel), bleiben. *Verifikation:* Jedes Feld steht in genau einer Liste, und nichts aus der Bleiben-Liste wird von einer anderen Route gelesen.

2. **Modellieren Sie den Zustand als einen unveränderlichen Wert.** Zwei lose Felder werden zu einer Klasse, sodass eine einzige `state`-Zuweisung den gesamten Screen beschreibt. *Verifikation:* `dart analyze` ist sauber und die Klasse hat `copyWith`.

   ```dart
   // Flutter 3.44, Dart 3.x
   class CartState {
     const CartState({this.lines = const [], this.isSubmitting = false});
     final List<CartLine> lines;
     final bool isSubmitting;

     int get itemCount => lines.fold(0, (sum, l) => sum + l.quantity);

     CartState copyWith({List<CartLine>? lines, bool? isSubmitting}) =>
         CartState(
           lines: lines ?? this.lines,
           isSubmitting: isSubmitting ?? this.isSubmitting,
         );
   }
   ```

3. **Schreiben Sie den `Notifier`.** `build()` liefert den Anfangszustand und ersetzt `initState`. Jeder frühere `setState`-Closure wird zu einer öffentlichen Methode, die `state` zuweist. *Verifikation:* Die Datei kompiliert ohne jeden Verweis auf `BuildContext`, `setState` oder einen Widget-Typ.

   ```dart
   // flutter_riverpod 3.3.2 -- no codegen
   import 'package:flutter_riverpod/flutter_riverpod.dart';

   final cartProvider = NotifierProvider<CartNotifier, CartState>(
     CartNotifier.new,
   );

   class CartNotifier extends Notifier<CartState> {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());

     void add(CartLine line) {
       state = state.copyWith(lines: [...state.lines, line]);
     }

     void setQuantity(String sku, int quantity) {
       state = state.copyWith(
         lines: [
           for (final l in state.lines)
             if (l.sku == sku) l.copyWith(quantity: quantity) else l,
         ],
       );
     }

     Future<void> submit() async {
       state = state.copyWith(isSubmitting: true);
       await CheckoutApi.submit(state.lines);
       if (!ref.mounted) return;
       state = state.copyWith(isSubmitting: false);
     }
   }
   ```

   Die Codegenerierungs-Form ist dieselbe Klasse mit abgeleitetem Provider:

   ```dart
   // riverpod_annotation 4.0.3, riverpod_generator 4.0.4
   @Riverpod(keepAlive: true)
   class Cart extends _$Cart {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());
     // ...same methods
   }
   ```

4. **Testen Sie den Notifier per Unit-Test, bevor Sie ein einziges Widget anfassen.** Das ist der Gewinn, also holen Sie ihn früh ab. *Verifikation:* `flutter test test/cart_notifier_test.dart` läuft durch, ohne dass ein Widget gepumpt wird.

   ```dart
   // flutter_riverpod 3.3.2
   test('setQuantity replaces the matching line', () {
     final container = ProviderContainer.test();
     container.read(cartProvider.notifier).add(const CartLine(sku: 'A', quantity: 1));
     container.read(cartProvider.notifier).setQuantity('A', 3);
     expect(container.read(cartProvider).itemCount, 3);
   });
   ```

5. **Stellen Sie das Widget um.** Wenn aus Schritt 1 nichts zurückbleibt, schrumpft `StatefulWidget` auf `ConsumerWidget` und `build` bekommt ein `WidgetRef`. Da der Gutschein-Controller bleibt, wird dieser Screen stattdessen ein `ConsumerStatefulWidget`. *Verifikation:* `flutter analyze` meldet null Probleme, einschließlich der `riverpod_lint`-Regeln.

   ```dart
   // Flutter 3.44, flutter_riverpod 3.3.2 -- after
   class CartScreen extends ConsumerStatefulWidget {
     const CartScreen({super.key});
     @override
     ConsumerState<CartScreen> createState() => _CartScreenState();
   }

   class _CartScreenState extends ConsumerState<CartScreen> {
     final _couponController = TextEditingController();

     @override
     void dispose() {
       _couponController.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) {
       final cart = ref.watch(cartProvider);
       return CartView(
         lines: cart.lines,
         isSubmitting: cart.isSubmitting,
         couponController: _couponController,
         onQuantityChanged: (sku, qty) =>
             ref.read(cartProvider.notifier).setQuantity(sku, qty),
       );
     }
   }
   ```

6. **Wenden Sie die watch/read-Regel an jeder Aufrufstelle an.** `ref.watch` in `build`, weil Sie Rebuilds wollen. `ref.read(provider.notifier)` in Callbacks, weil Sie dort keine wollen. Niemals `ref.watch` in einem `onPressed`. *Verifikation:* Durchsuchen Sie die Datei nach `ref.read(` und prüfen Sie, dass jeder Treffer in einem Callback oder einer asynchronen Methode steht, nie in `build`.

7. **Löschen Sie die durchgereichten Callbacks und lassen Sie das andere Widget direkt beobachten.** Dieser Schritt zahlt die Migration. Das Badge bekommt die Anzahl nicht mehr über drei Konstruktoren, sondern liest den Provider selbst. *Verifikation:* Die Zwischen-Widgets deklarieren die entfernten Parameter nicht mehr, und das Hinzufügen eines Artikels im Warenkorb-Screen aktualisiert das Badge auf einer anderen Route.

   ```dart
   // flutter_riverpod 3.3.2
   class CartBadge extends ConsumerWidget {
     const CartBadge({super.key});
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final count = ref.watch(cartProvider.select((s) => s.itemCount));
       return Badge(label: Text('$count'));
     }
   }
   ```

   `select` ist hier entscheidend. Ohne es baut das Badge bei jedem Wechsel von `isSubmitting` neu auf, was unter `setState` nie passierte, weil es gar nicht in diesem Teilbaum lag.

8. **Verlagern Sie das Aufräumen von Provider-Ressourcen nach `ref.onDispose`.** Alles, was der Notifier erzeugt hat (ein `StreamSubscription`, ein Timer, ein Socket), wird dort freigegeben, nicht im `dispose` des Widgets. *Verifikation:* Schalten Sie den Screen weg und wieder hin und prüfen Sie, dass im Log keine doppelten Subscriptions auftauchen.

   ```dart
   @override
   CartState build() {
     final sub = PriceFeed.stream.listen(_onPriceChanged);
     ref.onDispose(sub.cancel);
     return CartState(lines: CartStorage.instance.load());
   }
   ```

## Verifikation

Arbeiten Sie diese Liste vor dem Merge ab:

- `flutter analyze` meldet null Probleme bei aktiviertem `riverpod_lint`.
- `flutter test` läuft durch, und die Widget-Tests umhüllen den Screen jetzt mit einem `ProviderScope`. Ohne ihn wirft das erste `ref.watch` zur Laufzeit statt beim Kompilieren.
- Der Screen baut auf, und jede frühere `setState`-Interaktion aktualisiert weiterhin die Oberfläche. Klicken Sie jede durch; der Fehlermodus der `==`-Filterung (siehe unten) erzeugt keinen Fehler, nur ein eingefrorenes Widget.
- Screen öffnen, schließen, wieder öffnen. Prüfen Sie, dass die Persistenz des Zustands Ihrer Absicht entspricht und nicht dem Zufall.
- Prüfung im Profile-Modus mit DevTools: Die Rebuild-Zahl des Parents sollte gleich oder niedriger sein als vorher. Ist sie gestiegen, fehlt ein `select`.

## Rollback-Plan

Diese Migration lässt sich mit `git revert` zurücknehmen, solange Sie sie in einem eigenen Branch gehalten haben, denn auf der Platte und über das Netz ändert sich nichts. Das Einzige, was ein Revert nicht wiederherstellt, ist Verhalten, das an der neuen Lebensdauer hing: Wenn Sie ausgeliefert haben und Nutzer sich daran gewöhnt haben, dass der Warenkorb eine Zurück-Navigation überlebt, verwirft die Rückkehr zum widget-lokalen Zustand ihn beim Pop stillschweigend. Setzen Sie den Code zurück und testen Sie die Navigationsflüsse erneut, nicht nur den Build.

## Fallstricke, auf die wir gestoßen sind

**In-Place-Mutation baute nicht mehr neu auf.** Unter `setState` funktionierte `_lines.add(line)` im Closure, weil `setState` das Element unabhängig vom Inhalt als dirty markiert. Riverpod 3.0 vergleicht alten und neuen Zustand mit `==` und überspringt die Benachrichtigung, wenn beide gleich sind. Das hier tut also überhaupt nichts:

```dart
// broken on flutter_riverpod 3.x
void add(CartLine line) {
  state.lines.add(line); // mutates the same List instance
  state = state;         // identical, == is true, no listeners notified
}
```

Bauen Sie immer einen neuen Wert, so wie in Schritt 3. Es ist dieselbe Gleichheitsfilterung, die zuschlägt, wenn [ein StreamProvider in Riverpod 3.0 nichts mehr ausgibt](/de/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/). Hier trifft sie härter, wenn Ihre Zustandsklasse `equatable` oder einen `freezed`-Wertetyp verwendet, denn dann wird selbst ein korrekt neu gebautes Objekt mit unverändertem Inhalt herausgefiltert.

**`build()` ist kein `initState`.** `initState` läuft einmal pro Element. `Notifier.build()` läuft erneut, sobald sich eine beobachtete Abhängigkeit ändert, und setzt `state` auf den Rückgabewert zurück. Wenn Sie `ref.watch(authProvider)` in `build()` aufrufen, löscht eine Token-Erneuerung den Warenkorb. Verwenden Sie `ref.read` für Werte, die Sie nur beim Initialisieren brauchen, und reservieren Sie `ref.watch` in `build()` für Abhängigkeiten, die den Zustand tatsächlich zurücksetzen sollen.

**Die Voreinstellungen der automatischen Entsorgung unterscheiden sich zwischen beiden Syntaxen.** Ein handgeschriebenes `NotifierProvider(CartNotifier.new)` bleibt standardmäßig am Leben; Sie aktivieren die Entsorgung mit `isAutoDispose: true`. Ein generierter `@riverpod`-Provider wird standardmäßig automatisch entsorgt; Sie deaktivieren das mit `@Riverpod(keepAlive: true)`. Teams, die beide Formen in einer Codebasis schreiben, bekommen einen Warenkorb, der sich auf manchen Screens selbst leert und auf anderen nicht, ohne jede erklärende Fehlermeldung.

**`mounted` ist umgezogen.** Im Widget verwenden Sie weiterhin `context.mounted` und die übliche [`mounted`-Absicherung nach einer asynchronen Lücke](/de/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/). Im Notifier gibt es keinen `BuildContext`, daher lautet die Prüfung [`ref.mounted` nach dem await](/de/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/). Wer sie vergisst, bekommt eine Ausnahme, wenn der Provider entsorgt wurde, während die Anfrage noch lief.

**Controller gehören nicht in den Notifier.** Einen `TextEditingController` in den Provider-Zustand zu legen wirkt aufgeräumt, bis der Provider das Widget überlebt und Sie in einen Controller tippen, dessen Listener längst weg sind. Lassen Sie die [Regeln zur Freigabe von Controllern](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) genau dort, wo sie waren.

## Weiterführende Artikel

- [Provider vs Riverpod vs Bloc für Flutter-State-Management 2026](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), falls Sie das Ziel noch auswählen.
- [Von Riverpod 2.x auf Riverpod 3.0 migrieren](/de/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), das Upgrade, das vor diesem hier kommt.
- [Von FutureBuilder zu einem Riverpod-AsyncNotifier migrieren](/de/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) als asynchrones Gegenstück zu dieser Migration.
- [Welches Riverpod-Paket Sie wirklich brauchen](/de/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/), denn `riverpod` und `flutter_riverpod` sind nicht austauschbar.
- [Lade- und Fehlerzustände mit AsyncValue anzeigen](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), sobald der Notifier IO betreibt.

## Quellen

- [Was ist neu in Riverpod 3.0](https://riverpod.dev/docs/whats_new) für das vereinheitlichte `Ref`, `ref.mounted`, `ProviderContainer.test()` und die Benachrichtigungsfilterung per `==`.
- [Riverpod-Provider-Referenz](https://riverpod.dev/docs/concepts2/providers) für den Vertrag von `Notifier` und `build()`.
- [Automatische Entsorgung in Riverpod](https://riverpod.dev/docs/concepts2/auto_dispose) für `isAutoDispose` und `ref.keepAlive()`.
- [Migration von 2.0 auf 3.0](https://riverpod.dev/docs/3.0_migration) für den Wegfall der `AutoDispose`-Interfaces.
- [flutter_riverpod auf pub.dev](https://pub.dev/packages/flutter_riverpod) und [riverpod_generator auf pub.dev](https://pub.dev/packages/riverpod_generator) für die Versionen 3.3.2 und 4.0.4.
- [Flutter Release Notes](https://docs.flutter.dev/release/release-notes) für die Basis Flutter 3.44 stabil.
