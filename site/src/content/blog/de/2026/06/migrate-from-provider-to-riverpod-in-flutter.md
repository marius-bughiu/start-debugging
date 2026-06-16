---
title: "Von provider zu Riverpod in Flutter migrieren (provider 6.1.5 zu Riverpod 3.x)"
description: "Eine schrittweise Migration vom provider-Paket zu Riverpod 3.x in einer echten Flutter-App: ChangeNotifierProvider zu Notifier, MultiProvider zu ProviderScope, context.watch zu ref.watch, ProxyProvider zu ref.watch-Komposition, plus die Gleichheits- und Lifecycle-Fallstricke, die Sie erwischen. Getestet mit Flutter 3.27.1, Dart 3.11, provider 6.1.5, flutter_riverpod 3.3.1."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "provider"
  - "state-management"
  - "migration"
lang: "de"
translationOf: "2026/06/migrate-from-provider-to-riverpod-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-16
---

Die Kurzfassung: Fügen Sie `flutter_riverpod` neben `provider` hinzu, kapseln Sie Ihre App in einen `ProviderScope` statt in einen `MultiProvider`, und migrieren Sie eine Funktion nach der anderen, beginnend bei den Blättern Ihres Abhängigkeitsbaums. Jeder `ChangeNotifier` wird zu einem `Notifier` (oder `AsyncNotifier` für asynchrone Arbeit), `context.watch<T>()` wird zu `ref.watch(myProvider)`, `Provider.of` und `context.read` werden zu `ref.read`, und jeder `ProxyProvider` kollabiert zu einem einfachen `ref.watch` eines anderen Providers. Eine kleine bis mittelgroße App ist ein Ein- bis Dreitagesprojekt; der knifflige Teil ist nicht die Syntax, sondern dass Riverpod den State per Gleichheit vergleicht und Provider anders am Leben hält als `provider` es tut. Getestet mit Flutter 3.27.1, Dart 3.11, provider 6.1.5, flutter_riverpod 3.3.1, riverpod_annotation 2.6.1 und riverpod_generator 2.6.5.

Das `provider`-Paket (derzeit 6.1.5) ist seit 2019 die Standardantwort für Flutter-State-Management, und es funktioniert nach wie vor. Aber sein Autor, Remi Rousselet, hat Riverpod gezielt geschrieben, um die strukturellen Probleme von `provider` zu beheben: State, der über `BuildContext` gelesen wird, bedeutet eine `ProviderNotFoundException` zur Laufzeit statt eines Compile-Fehlers, `ProxyProvider`-Verschachtelung wird ab zwei Abhängigkeiten unleserlich, und Sie können nicht zwei Provider desselben Typs ohne `ValueKey`-Verrenkungen haben. Riverpod behält das mentale Modell (ein Graph von Objekten, die Widgets neu aufbauen, wenn sie sich ändern) und entfernt die `BuildContext`-Kopplung. Dieser Leitfaden ist die mechanische, blatt-zuerst durchgeführte Migration, die kein Neuschreiben erfordert.

## Warum von provider weg migrieren

- **Compile-Zeit-Sicherheit statt `ProviderNotFoundException`.** In `provider` wirft das Lesen eines Typs, der nicht über Ihnen im Baum liegt, zur Laufzeit. In Riverpod sind Provider Top-Level-Globals, sodass ein Tippfehler ein Compile-Fehler ist und es nichts zu "finden" gibt.
- **Keine `MultiProvider`-Pyramide mehr.** Riverpod hat keinen Provider-Baum zusammenzusetzen. Ein `ProviderScope` an der Wurzel ersetzt die gesamte `MultiProvider(providers: [...])`-Liste, und Abhängigkeiten zwischen Providern werden mit `ref.watch` ausgedrückt, nicht durch die Verschachtelungsreihenfolge.
- **Zwei Provider desselben Typs, kostenlos.** `provider` indiziert alles nach Typ, sodass zwei `ChangeNotifierProvider<CartModel>` kollidieren. Riverpod indiziert nach dem Provider-Objekt, also ist das kein Problem.
- **Auto-Dispose und Family, die tatsächlich komponieren.** Riverpod gibt Ihnen `autoDispose` und parametrisierte (`family`) Provider als erstklassige Funktionen, die `provider` nur mit manuellem `ChangeNotifierProvider.value` und Schlüsselverwaltung annähert.

## Was bricht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| Root-Verdrahtung | `MultiProvider` ersetzt durch einen einzigen `ProviderScope` | mittel |
| Reads | `context.watch<T>()` / `Provider.of<T>(context)` ersetzt durch `ref.watch` / `ref.read` | hoch |
| Notifier | `ChangeNotifier` + `notifyListeners()` ersetzt durch `Notifier` + State-Neuzuweisung | hoch |
| Rebuild-Semantik | Riverpod vergleicht State per `==`; In-Place-Mutation baut nicht mehr neu auf | hoch |
| Komposition | `ProxyProvider` ersetzt durch `ref.watch` der Abhängigkeit | mittel |
| Widgets | `StatelessWidget` / `StatefulWidget` werden zu `ConsumerWidget` / `ConsumerStatefulWidget` | mittel |
| Lifecycle | `provider` verwirft beim Entfernen aus dem Baum; Riverpod behält State bis `autoDispose` | mittel |

Die zwei `hoch`-Zeilen in den Bereichen Rebuild und Notifier sind die, in denen Teams Zeit verlieren. Alles andere ist Suchen-und-Ersetzen.

## Pre-Flight-Checkliste

- Flutter 3.27.1 / Dart 3.11 (oder neuer) installiert: `flutter --version`.
- Ein sauberer `git`-Arbeitsbaum und ein Branch, den Sie wegwerfen können.
- Ein Inventar jedes Providers, den Sie heute registrieren. Durchsuchen Sie Ihre Codebasis: `grep -rn "ChangeNotifierProvider\|ProxyProvider\|FutureProvider\|StreamProvider\|Provider.of\|context.watch\|context.read" lib/`.
- Eine Notiz neben jedem davon, ob etwas davon abhängt. Migrieren Sie zuerst die Dinge, von denen nichts abhängt.
- Eine funktionierende Testsuite, auch eine dünne. Sie werden sie nach jedem Schritt ausführen.

## Migrationsschritte

1. **Fügen Sie Riverpod neben provider in `pubspec.yaml` hinzu.** Entfernen Sie `provider` noch nicht. Beide Pakete koexistieren, weil sie getrennte Bäume besitzen; ein gegebenes Stück State hat zu jedem Zeitpunkt genau einen Besitzer, also migrieren Sie pro Funktion, nicht pro Typ.

   ```yaml
   # pubspec.yaml. Flutter 3.27.1, Dart 3.11.
   dependencies:
     flutter:
       sdk: flutter
     provider: ^6.1.5            # keep until migration is done
     flutter_riverpod: ^3.3.1
     riverpod_annotation: ^2.6.1

   dev_dependencies:
     build_runner: ^2.4.13
     riverpod_generator: ^2.6.5
     custom_lint: ^0.7.0
     riverpod_lint: ^2.6.5
   ```

   Prüfen: `flutter pub get` löst ohne Versionskonflikte auf.

2. **Kapseln Sie die App-Wurzel in `ProviderScope` und behalten Sie `MultiProvider` vorerst darin.** `ProviderScope` ist der Ort, an dem Riverpod den gesamten Provider-State speichert. Es ist keine Liste von Providern, es ist eine einzelne Grenze. Lassen Sie Ihren bestehenden `MultiProvider` darunter, damit nicht migrierte Screens weiter funktionieren.

   ```dart
   // lib/main.dart, Flutter 3.27.1
   import 'package:flutter/material.dart';
   import 'package:flutter_riverpod/flutter_riverpod.dart';
   import 'package:provider/provider.dart';

   void main() {
     runApp(
       ProviderScope(                       // Riverpod root
         child: MultiProvider(              // legacy, shrinks as you migrate
           providers: [
             ChangeNotifierProvider(create: (_) => CartModel()),
             ChangeNotifierProvider(create: (_) => AuthModel()),
           ],
           child: const MyApp(),
         ),
       ),
     );
   }
   ```

   Prüfen: Die App kompiliert und läuft weiterhin identisch. Es hat sich noch nichts bewegt.

3. **Konvertieren Sie einen Blatt-`ChangeNotifier` in einen `Notifier`.** Wählen Sie ein Modell, von dem nichts anderes abhängt. In `provider` mutieren Sie ein Feld und rufen `notifyListeners()` auf. In Riverpod gibt `build()` den initialen State zurück, und Sie weisen `state` neu zu, um zu benachrichtigen. Es gibt kein `notifyListeners()`.

   ```dart
   // Before: provider 6.1.5
   class CartModel extends ChangeNotifier {
     final List<Item> _items = [];
     List<Item> get items => List.unmodifiable(_items);

     void add(Item item) {
       _items.add(item);
       notifyListeners();
     }
   }
   ```

   ```dart
   // After: flutter_riverpod 3.3.1, code generation
   import 'package:riverpod_annotation/riverpod_annotation.dart';

   part 'cart_model.g.dart';

   @riverpod
   class Cart extends _$Cart {
     @override
     List<Item> build() => const [];

     void add(Item item) {
       state = [...state, item];   // new list, not state.add(...)
     }
   }
   ```

   Führen Sie `dart run build_runner build --delete-conflicting-outputs` aus, um `cartProvider` zu generieren. Prüfen: Der Generator erzeugt `cart_model.g.dart` ohne Fehler.

4. **Stellen Sie den Screen, der ihn konsumiert, auf ein `ConsumerWidget` um.** `StatelessWidget` wird zu `ConsumerWidget`, und `build` erhält ein `WidgetRef ref`. `context.watch<CartModel>()` wird zu `ref.watch(cartProvider)`. Für einen Methodenaufruf wird `context.read<CartModel>().add(x)` zu `ref.read(cartProvider.notifier).add(x)`.

   ```dart
   // Before
   class CartView extends StatelessWidget {
     @override
     Widget build(BuildContext context) {
       final items = context.watch<CartModel>().items;
       return Column(children: [
         for (final i in items) Text(i.name),
         ElevatedButton(
           onPressed: () => context.read<CartModel>().add(Item('pen')),
           child: const Text('Add'),
         ),
       ]);
     }
   }
   ```

   ```dart
   // After
   class CartView extends ConsumerWidget {
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final items = ref.watch(cartProvider);
       return Column(children: [
         for (final i in items) Text(i.name),
         ElevatedButton(
           onPressed: () => ref.read(cartProvider.notifier).add(Item('pen')),
           child: const Text('Add'),
         ),
       ]);
     }
   }
   ```

   Wenn das Widget bereits eigenen State hatte, verwenden Sie `ConsumerStatefulWidget` plus `ConsumerState`, wobei `ref` als Feld verfügbar ist. Entfernen Sie die Zeile `ChangeNotifierProvider(create: (_) => CartModel())` aus `MultiProvider`. Prüfen: Der Screen verhält sich gleich, und die `MultiProvider`-Liste ist um eins kürzer.

5. **Ersetzen Sie `ProxyProvider` durch `ref.watch`-Komposition.** Das ist der Schritt, der den meisten Code löscht. Ein `ProxyProvider`, der B aus A baut, wird zu einem Provider, der einfach A beobachtet.

   ```dart
   // Before: ProxyProvider wiring
   ProxyProvider<AuthModel, ApiClient>(
     update: (_, auth, __) => ApiClient(token: auth.token),
   ),
   ```

   ```dart
   // After: a provider that watches its dependency
   @riverpod
   ApiClient apiClient(ApiClientRef ref) {
     final token = ref.watch(authProvider.select((a) => a.token));
     return ApiClient(token: token);
   }
   ```

   `ref.watch(...select(...))` ist der direkte Ersatz für `provider`s `context.select`, und es bedeutet, dass `apiClient` nur dann neu aufgebaut wird, wenn sich `token` ändert, nicht bei jedem `AuthModel`-Update. Prüfen: Abhängige Widgets bauen neu auf, wenn sich der vorgelagerte Provider ändert.

6. **Migrieren Sie `FutureProvider` und `StreamProvider` zu ihren Riverpod-Äquivalenten.** Die Namen sind gleich; nur die Verdrahtung unterscheidet sich. Ein `provider`-`FutureProvider` wird mit `context.watch<AsyncSnapshot>`-artiger Verdrahtung gelesen; der Riverpod-Provider gibt ein `AsyncValue<T>` zurück, auf das Sie direkt verzweigen.

   ```dart
   // After: flutter_riverpod 3.3.1
   @riverpod
   Future<User> currentUser(CurrentUserRef ref) {
     return ref.watch(apiClientProvider).fetchUser();
   }

   // in a ConsumerWidget
   final userAsync = ref.watch(currentUserProvider);
   return userAsync.when(
     data: (user) => Text(user.name),
     loading: () => const CircularProgressIndicator(),
     error: (e, _) => Text('Failed: $e'),
   );
   ```

   Prüfen: Lade- und Fehlerzustände werden ohne manuelle `bool isLoading`-Flags gerendert. Mehr zu diesem Muster finden Sie im verlinkten AsyncValue-Beitrag weiter unten.

7. **Löschen Sie die `provider`-Abhängigkeit.** Sobald `MultiProvider` leer ist, entfernen Sie es aus `main.dart`, lassen dann `provider: ^6.1.5` aus `pubspec.yaml` fallen und führen `flutter pub get` aus. Der Compiler wird alle verbleibenden `context.watch`/`context.read`/`Provider.of`-Aufrufe markieren. Prüfen: Das Projekt kompiliert mit null Referenzen auf `package:provider`.

## Verifizierung

Führen Sie diese Checkliste nach dem letzten Schritt aus, nicht nur ganz am Ende:

- `flutter analyze` meldet keine Fehler und keine `riverpod_lint`-Warnungen.
- `dart run build_runner build --delete-conflicting-outputs` läuft sauber durch.
- `flutter test` besteht. Riverpod-Tests verwenden `ProviderContainer` (oder `ProviderContainer.test()` in 3.x) und `container.read(provider)` und ersetzen Ihre alten `ChangeNotifier`-Unit-Tests.
- Ein manueller Smoke-Durchlauf: Jeder migrierte Screen baut bei State-Änderung weiterhin neu auf, und kein Screen wirft `ProviderNotFoundException` (es sollte per Konstruktion keine mehr geben).
- `grep -rn "package:provider" lib/` gibt nichts zurück.

## Rollback-Plan

Diese Migration ist pro Funktion umkehrbar, gerade weil beide Pakete koexistieren. Wenn sich ein migrierter Screen fehlerhaft verhält, machen Sie den Commit dieses Screens rückgängig: Setzen Sie die `ChangeNotifierProvider`-Zeile wieder in `MultiProvider` ein, stellen Sie die `ChangeNotifier`-Klasse wieder her, und ändern Sie das Widget zurück auf `StatelessWidget`. Weil Sie blatt-zuerst und eine Funktion pro Commit migriert haben, berührt kein Rollback mehr als einen Screen. Löschen Sie `provider` nicht aus `pubspec.yaml` (Schritt 7), bis Sie zuversichtlich sind, denn das ist die einzige Einbahnstraße in der Sequenz.

## Fallstricke, auf die wir gestoßen sind

**In-Place-Mutation hört auf, neu aufzubauen.** Das ist die Überraschung Nummer eins. In `provider` funktioniert `_items.add(x); notifyListeners()`, weil Sie die Benachrichtigung kontrollieren. In einem Riverpod-`Notifier` baut das Framework nur dann neu auf, wenn `state` ein Wert zugewiesen wird, der nicht `==` zum alten ist. `state.add(x)` mutiert dieselbe Liste, die Referenz ist unverändert, und es wird nichts neu aufgebaut. Weisen Sie immer eine neue Collection zu: `state = [...state, x]`. Dasselbe gilt für Modellobjekte, weshalb unveränderlicher State (Records, `copyWith` oder eine `freezed`-Klasse) natürlich zu Riverpod passt.

**Provider werden nicht verworfen, wenn das Widget den Baum verlässt.** Ein `provider`-`ChangeNotifierProvider` wird verworfen, wenn sein Subtree entfernt wird. Ein Riverpod-Provider behält standardmäßig seinen State für die Lebensdauer des `ProviderScope`. Wenn Sie sich darauf verlassen haben, dass der Controller eines Screens zurückgesetzt wird, wenn Sie wegnavigieren, benötigen Sie jetzt `autoDispose` (oder, mit Code-Generierung, das ist der Standard für annotierte Provider, sofern Sie nicht `ref.keepAlive()` aufrufen). Prüfen Sie jeden Provider, dessen altes Verhalten von baumbasiertem Verwerfen abhing.

**`ref.read` innerhalb von `build()` ist eine Falle.** Das Lesen eines anderen Providers mit `ref.read` innerhalb eines `Notifier.build()` oder eines Widget-`build` erfasst den Wert einmal als Momentaufnahme und aktualisiert nie. Verwenden Sie `ref.watch` für alles, das reagieren soll, und reservieren Sie `ref.read` für Event-Handler wie Button-Callbacks. `riverpod_lint` markiert die meisten davon für Sie, weshalb es sich lohnt, die Dev-Abhängigkeit ab dem ersten Tag zu installieren.

**`Consumer` existiert in beiden Paketen.** Wenn Sie während der Migration beide importieren, ist `Consumer` mehrdeutig. Riverpods `Consumer` nimmt einen `(context, ref, child)`-Builder; der von `provider` nimmt `(context, value, child)`. Bevorzugen Sie es, das gesamte Widget zu einem `ConsumerWidget` zu konvertieren, statt einen Riverpod-`Consumer` in ein Widget aus der provider-Ära einzustreuen, und Sie vermeiden den Import-Konflikt vollständig.

Die Migration belohnt es, langweilig zu sein: ein Blatt, ein Commit, die Tests ausführen, wiederholen. Bis Sie `provider` aus `pubspec.yaml` löschen, ist der riskante Teil bereits Wochen zuvor in kleinen, umkehrbaren Schritten passiert.

## Verwandtes

- Wenn Sie von einer anderen State-Bibliothek kommen, behandelt die [GetX-zu-Riverpod-Migration](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) denselben blatt-zuerst-Ansatz für ein schwergewichtigeres Framework.
- Noch unentschlossen? Der [Vergleich provider vs Riverpod vs Bloc](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) legt die Kompromisse dar, bevor Sie sich festlegen.
- Für die asynchrone Seite geht [Lade- und Fehlerzustände mit AsyncValue](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) tief auf `when` und `AsyncNotifier` ein.
- Kommen Sie von rohem `FutureBuilder`? Siehe [FutureBuilder/StreamBuilder vs Riverpod AsyncValue](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).
- Der häufigste Laufzeitfehler nach der Migration: [Cannot use ref after the widget was disposed](/de/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

## Quellen

- [Riverpod-Doku: Migration von pkg:provider (Quickstart)](https://riverpod.dev/docs/from_provider/quickstart)
- [Riverpod-Doku: von ChangeNotifier](https://riverpod.dev/docs/migration/from_change_notifier)
- [Riverpod-Doku: Was ist neu in 3.0](https://riverpod.dev/docs/whats_new)
- [provider 6.1.5 auf pub.dev](https://pub.dev/packages/provider/versions/6.1.5)
- [flutter_riverpod-Changelog](https://pub.dev/packages/flutter_riverpod/changelog)
