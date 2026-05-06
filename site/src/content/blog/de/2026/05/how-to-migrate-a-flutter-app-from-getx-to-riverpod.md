---
title: "Eine Flutter-App von GetX zu Riverpod migrieren"
description: "Schritt-für-Schritt-Migration von GetX zu Riverpod 3.x in einer echten Flutter-App: GetxController zu Notifier, .obs zu abgeleiteten Providern, Get.find zu ref.watch, Get.to zu go_router, plus Snackbars, Theming und Tests. Getestet mit Flutter 3.27.1, Dart 3.11, flutter_riverpod 3.3.1."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "getx"
  - "state-management"
  - "migration"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod"
translatedBy: "claude"
translationDate: 2026-05-06
---

Die Kurzfassung: Installieren Sie `flutter_riverpod` neben GetX, hüllen Sie Ihre App in einen `ProviderScope` und migrieren Sie Bildschirm für Bildschirm. Ersetzen Sie jeden `GetxController` durch einen `Notifier` (oder `AsyncNotifier` für asynchrone Arbeit), übersetzen Sie jedes `.obs`-Feld entweder in Notifier-State oder einen `Provider`, der davon ableitet, tauschen Sie `Get.find<T>()` gegen `ref.watch(myProvider)` und verlagern Sie das Routing auf `go_router`, damit Sie endlich `Get.to` loswerden können. Snackbars, Dialoge und Theme-Wechsel werden gegen die regulären Flutter-APIs neu aufgebaut. Getestet mit Flutter 3.27.1, Dart 3.11, flutter_riverpod 3.3.1, riverpod_generator 2.6.5 und go_router 14.6.

GetX wurde populär, weil es jede Frage mit einem einzigen Import beantwortete. State, Routes, Dependency Injection, Snackbars, Internationalisierung, Theming, alles aus `package:get`. Das war 2021 seine Stärke und ist 2026 sein Problem geworden: eine einzelne Abhängigkeit, die die halbe Laufzeit besitzt, eine `BuildContext`-freie Abkürzungskultur (`Get.context!`, `Get.snackbar`), die das Verständnis der App erschwert, und ein Wartungstakt, der nicht mehr zum Release-Tempo von Flutter passt. Riverpod ist der gegenteilige Kompromiss. Es macht eine Sache (State-Graph mit expliziten Abhängigkeiten) und zwingt Sie, sich für Routing und UI-Shell auf Standard-Flutter-APIs zu stützen. Die Migration ist größtenteils mechanisch, aber ein paar Muster werden sich wehren. Dieser Beitrag behandelt diejenigen, die jedes Team erwischen.

## Was Sie tatsächlich übersetzen

Bevor Sie irgendeinen Code anfassen, schreiben Sie auf, was GetX für Sie tut. Die meisten Apps stützen sich auf fünf Dinge:

1. `GetxController` plus `Rx<T>` / `.obs` für State.
2. `Get.put` / `Get.lazyPut` / `Get.find` für Dependency Injection.
3. `Obx` und `GetBuilder`, um Widgets bei State-Änderungen neu aufzubauen.
4. `Get.to`, `Get.toNamed`, `Get.back` für Navigation.
5. `Get.snackbar`, `Get.dialog`, `Get.changeTheme` für UI-Nebeneffekte.

Riverpod erledigt 1-3 direkt, mit dem passenden, code-generierten Boilerplate. Es macht 4 oder 5 absichtlich nicht. Sie ersetzen die Navigation durch `go_router` (oder den eingebauten `Navigator`), und Snackbars / Dialoge / Theme-Wechsel kehren zu gewöhnlichen Flutter-Widgets zurück, die State aus einem Provider lesen. Das ist der Teil der Migration, der die Leute überrascht: Riverpod ist im Umfang kleiner als GetX, und genau das ist der Punkt.

## Riverpod hinzufügen, ohne GetX zu entfernen

Die schrittweise Migration funktioniert nur, wenn beide Bibliotheken koexistieren können. Sie können das, mit einer Einschränkung: `Get.put` behält seinen eigenen Service Locator, und Riverpod hat seinen eigenen Provider-Baum, also hat ein State-Stück zu jedem Zeitpunkt genau einen Eigentümer. Wählen Sie diesen Eigentümer pro Bildschirm, nicht pro Typ.

```yaml
# pubspec.yaml. Flutter 3.27.1, Dart 3.11.
dependencies:
  flutter:
    sdk: flutter
  get: ^4.7.2
  flutter_riverpod: ^3.3.1
  riverpod_annotation: ^2.6.1
  go_router: ^14.6.2

dev_dependencies:
  build_runner: ^2.4.13
  riverpod_generator: ^2.6.5
  custom_lint: ^0.7.0
  riverpod_lint: ^2.6.5
```

Hüllen Sie Ihre bestehende `GetMaterialApp` in einen `ProviderScope`. Sie können `GetMaterialApp` behalten, bis das Routing migriert ist; die zwei Bäume kommen sich nicht ins Gehege.

```dart
// lib/main.dart, Flutter 3.27.1
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:get/get.dart';

void main() {
  runApp(const ProviderScope(child: MyApp()));
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return GetMaterialApp(
      title: 'Migrating to Riverpod',
      home: const HomePage(),
      getPages: const [
        // existing GetX routes for screens not yet migrated
      ],
    );
  }
}
```

Fügen Sie `riverpod_lint` einmal zu `analysis_options.yaml` hinzu. Es fängt die zwei Fehler ab, die am stärksten beißen: einen Provider während des Builds mit `ref.read` zu lesen und zu vergessen, einen Notifier `final` zu machen, wenn man ihn speichert.

## GetxController zu Notifier, der mechanische Durchgang

Nehmen Sie den einfachsten Controller, den Sie haben. Counter sind das GetX-Hello-World, und die Konvertierung erfolgt fast Zeile für Zeile.

```dart
// Before: GetX 4.7, Flutter 3.27.1
import 'package:get/get.dart';

class CounterController extends GetxController {
  final RxInt count = 0.obs;
  final RxBool busy = false.obs;

  Future<void> incrementAfterDelay() async {
    busy.value = true;
    await Future.delayed(const Duration(milliseconds: 200));
    count.value++;
    busy.value = false;
  }
}
```

Das Riverpod-3.x-Äquivalent verwendet Code-Generierung. Der generierte `counterProvider` spielt die Rolle von `Get.put` plus `Obx`: Er besitzt den State, weiß, wie er Abhängige neu aufbaut, und entsorgt sich selbst, wenn nichts mehr von ihm liest.

```dart
// After: flutter_riverpod 3.3.1, riverpod_generator 2.6.5, Dart 3.11
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

class CounterState {
  const CounterState({this.count = 0, this.busy = false});

  final int count;
  final bool busy;

  CounterState copyWith({int? count, bool? busy}) =>
      CounterState(count: count ?? this.count, busy: busy ?? this.busy);
}

@riverpod
class Counter extends _$Counter {
  @override
  CounterState build() => const CounterState();

  Future<void> incrementAfterDelay() async {
    state = state.copyWith(busy: true);
    await Future.delayed(const Duration(milliseconds: 200));
    state = state.copyWith(count: state.count + 1, busy: false);
  }
}
```

Führen Sie `dart run build_runner watch -d` einmal aus und lassen Sie es laufen. Der Generator emittiert `counterProvider`, und Ihr Widget liest ihn auf dieselbe Weise, wie es früher ein `Obx` gelesen hat:

```dart
// flutter_riverpod 3.3.1
class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(counterProvider);
    final ctrl = ref.read(counterProvider.notifier);
    return Scaffold(
      body: Center(
        child: s.busy
            ? const CircularProgressIndicator()
            : Text('${s.count}'),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: ctrl.incrementAfterDelay,
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

Zwei Dinge sollten Sie verinnerlichen. Erstens: `ref.watch` abonniert; `ref.read` nicht. Verwenden Sie `ref.read` nur innerhalb von Callbacks (Button-Taps, Lifecycle-Methoden), niemals in der Build-Methode. Zweitens: Die `state =`-Zuweisung erledigt das Äquivalent zu `count.value++` plus dem Rebuild, atomar. Es gibt nicht länger einen Moment zwischen `busy.value = true` und dem Rebuild, in dem jemand anderes ein inkonsistentes Feld-Paar beobachten kann. Diese eine Änderung beseitigt eine Bug-Kategorie, die GetX-Apps gerne ansammeln.

## Asynchrone Arbeit: AsyncNotifier ersetzt das manuelle Loading-Flag

Die meisten GetX-Controller tragen ihr eigenes `isLoading.obs` mit sich herum, weil `RxFuture` raue Kanten hat. Riverpod behandelt asynchron als erstklassigen State mit `AsyncValue<T>`. Das gleiche "Liste-von-Usern-holen"-Muster schrumpft auf das hier zusammen:

```dart
// flutter_riverpod 3.3.1, Dart 3.11
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'users.g.dart';

@riverpod
class Users extends _$Users {
  @override
  Future<List<User>> build() async {
    final api = ref.watch(apiClientProvider);
    return api.fetchUsers();
  }

  Future<void> refresh() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() => ref.read(apiClientProvider).fetchUsers());
  }
}
```

Das Widget bekommt Loading-, Error- und Data-States ohne ein einziges Boolean-Feld:

```dart
class UsersPage extends ConsumerWidget {
  const UsersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final users = ref.watch(usersProvider);
    return users.when(
      data: (list) => ListView(children: [for (final u in list) Text(u.name)]),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('Failed: $e')),
    );
  }
}
```

Riverpod 3.0 wiederholt fehlgeschlagene Provider zudem standardmäßig automatisch. Wenn Sie das nicht möchten (ein 401 sollte zum Beispiel keinen Retry auslösen), setzen Sie `retry: (count, error) => null` auf dem Provider oder global auf dem `ProviderScope`. Lesen Sie die [3.0-Migrationshinweise zu Retry](https://riverpod.dev/docs/3.0_migration), bevor Sie das umstellen; das Standardverhalten ist tatsächlich nützlich, kann aber transiente Bugs in Tests verschleiern.

## Dependency Injection: Aus Get.find wird ref.watch

GetX verwendet einen globalen Service Locator. Überall in der App liefert `Get.find<ApiClient>()` dieselbe Instanz. Riverpod ersetzt das durch einen Provider, der den Wert einmal pro `ProviderContainer` konstruiert.

```dart
// flutter_riverpod 3.3.1
@riverpod
ApiClient apiClient(Ref ref) {
  final dio = ref.watch(dioProvider);
  return ApiClient(dio);
}

@riverpod
Dio dio(Ref ref) {
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.com'));
  ref.onDispose(() => dio.close(force: true));
  return dio;
}
```

`ref.onDispose` ist der Teil, für den GetX nie eine saubere Antwort hatte. Wenn der letzte Konsument von `dioProvider` verschwindet, wird der HTTP-Client geschlossen; wenn er zurückkommt, baut sich der Provider neu auf und Sie bekommen ein frisches `Dio`. Der Lebenszyklus ist endlich explizit. Für Services, die wirklich für immer leben, markieren Sie den Provider mit `keepAlive: true` (oder lassen `autoDispose` weg) und besitzen diese Entscheidung im Code, statt zu hoffen, dass `Get.put(permanent: true)` einen Hot Restart überlebt.

Um beide DI-Systeme während der Migration funktionsfähig zu halten, registrieren Sie eine kleine Brücke, die GetX-aufgelöste Singletons an Riverpod-Konsumenten reicht:

```dart
// Bridge: read from GetX, expose as a Riverpod provider
@riverpod
LegacyAuthService legacyAuth(Ref ref) => Get.find<LegacyAuthService>();
```

Werfen Sie die Brücke weg, sobald die GetX-Seite nichts mehr zu registrieren hat.

## Reaktive Ableitungen: Wo .obs wirklich glänzt und wie Riverpod es ersetzt

`.obs` lässt abgeleiteten State kostenlos aussehen. `final fullName = ''.obs;` plus `ever(firstName, (_) => fullName.value = '$firstName $lastName')` ist eine Zeile. Das Riverpod-Äquivalent ist ein separater Provider, der seine Eingaben auflistet:

```dart
// flutter_riverpod 3.3.1
@riverpod
String fullName(Ref ref) {
  final first = ref.watch(firstNameProvider);
  final last = ref.watch(lastNameProvider);
  return '$first $last';
}
```

Der Vorteil ist, dass `fullNameProvider` nur dann neu berechnet wird, wenn sich tatsächlich eine seiner Eingaben ändert (Riverpod 3 verwendet `==` für Equality-Filterung, ein Upgrade gegenüber dem alten `identical`-Check), und jedes Widget, das ihn liest, baut sich nur dann neu auf, wenn sich der abgeleitete String ändert. Der Preis ist, dass Sie jede Eingabe benennen müssen. Diese Benennung ist die schwierigste redaktionelle Entscheidung der Migration. Widerstehen Sie der Versuchung, alles in einem Mega-Notifier zu vergraben; kleine Provider lassen sich besser komponieren und sind weitaus einfacher zu testen.

Für Ableitungen, die Cancellation benötigen (eine Suchbox, die beim Tippen ans Netzwerk geht), verwenden Sie einen `AsyncNotifier` und brechen über `ref.onDispose` plus ein `CancelToken` ab. Das ersetzt `debounce(query, ..., time: ...)` von GetX durch Code, der Unit-Tests übersteht.

## Routing: Get.to fallenlassen und go_router einführen

Das ist der Schritt, den Teams am längsten aufschieben, weil GetX-Routing tatsächlich funktioniert. Bezahlen Sie den Preis früh. Sobald `go_router` die Navigation besitzt, beschleunigt sich der Rest der Migration, weil Sie `Get.context` nicht mehr in den Controllern brauchen.

```dart
// go_router 14.6.2, Flutter 3.27.1
final goRouterProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (_, __) => const HomePage()),
      GoRoute(path: '/users/:id', builder: (_, s) => UserPage(id: s.pathParameters['id']!)),
    ],
    redirect: (ctx, state) {
      final auth = ProviderScope.containerOf(ctx).read(authProvider);
      if (!auth.isLoggedIn && state.matchedLocation != '/login') return '/login';
      return null;
    },
  );
});

class MyApp extends ConsumerWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(goRouterProvider);
    return MaterialApp.router(
      routerConfig: router,
      theme: ref.watch(themeProvider),
    );
  }
}
```

Ersetzen Sie `Get.to(NextPage())` durch `context.go('/next')`, `Get.toNamed('/users/42')` durch `context.go('/users/42')` und `Get.back()` durch `context.pop()`. Die string-typisierten Pfade fühlen sich zunächst wie ein Downgrade gegenüber typisierten Page-Konstruktoren an; in der Praxis schreiben Sie eine dünne `extension` auf `BuildContext`, die die Strings umhüllt, und Link-Prüfungen kommen von `go_router_builder` oder Ihren Tests.

## Snackbars, Dialoge, Themes: zurück zu reinem Flutter

`Get.snackbar` ist praktisch, weil es keinen `BuildContext` benötigt. Diese Bequemlichkeit ist auch der Grund, warum Sie es nicht testen können. Die idiomatische Antwort von Riverpod ist ein reines State-Signal, das die UI konsumiert:

```dart
// flutter_riverpod 3.3.1
@riverpod
class Toast extends _$Toast {
  @override
  String? build() => null;

  void show(String message) => state = message;
  void clear() => state = null;
}

class ToastListener extends ConsumerWidget {
  const ToastListener({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(toastProvider, (_, next) {
      if (next != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(next)));
        ref.read(toastProvider.notifier).clear();
      }
    });
    return child;
  }
}
```

Hüllen Sie den Teil Ihres Baums, der einen `Scaffold`-Vorfahren hat, in `ToastListener`. Jetzt kann jeder Controller `ref.read(toastProvider.notifier).show('Saved')` aufrufen, ohne `BuildContext` anzufassen, und Tests prüfen den State des Providers, statt ein Overlay abzufangen.

Theming funktioniert ähnlich. Aus `Get.changeTheme` wird ein `themeProvider`, den `MaterialApp.router` beobachtet. Lokalisierung kann entweder `Get.locale` weiter verwenden, bis Sie sie zuletzt migrieren, oder zu `flutter_localizations` plus einem `localeProvider` wechseln.

## Tests werden schneller und klarer

Der größte Gewinn liegt in den Tests. Ein GetX-Controller-Test braucht in der Regel `Get.testMode = true` plus sorgfältigen Teardown von Singletons. Ein Riverpod-Test erstellt einen `ProviderContainer`, überschreibt genau die Provider, die ihn interessieren, und entsorgt am Ende:

```dart
// flutter_test, flutter_riverpod 3.3.1
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  test('Counter increments after delay', () async {
    final container = ProviderContainer(overrides: const []);
    addTearDown(container.dispose);

    final notifier = container.read(counterProvider.notifier);
    expect(container.read(counterProvider).count, 0);

    final f = notifier.incrementAfterDelay();
    expect(container.read(counterProvider).busy, true);
    await f;
    expect(container.read(counterProvider).count, 1);
    expect(container.read(counterProvider).busy, false);
  });
}
```

Überschreiben Sie Provider, um Fakes einzuspeisen (`apiClientProvider.overrideWithValue(FakeApi())`), und Sie brauchen für die meisten Fälle kein Mocking-Framework mehr. Listener pausieren in Riverpod 3, wenn sie nicht sichtbar sind, aber in Tests ist jeder Container standardmäßig "sichtbar", sofern Sie es nicht ausdrücklich modellieren, also ist die Änderung für bestehende Test-Suites unsichtbar.

## Stolpersteine, auf die die Migration immer trifft

**`autoDispose` versus Singletons.** Code-generierte `@riverpod`-Provider sind standardmäßig auto-dispose. Wenn Sie einen `Get.put(permanent: true)`-Controller konvertiert haben und feststellen, dass der State zurückgesetzt wird, sobald Sie den Bildschirm verlassen, markieren Sie den Provider mit `@Riverpod(keepAlive: true)`. Tun Sie das bewusst; permanenter State ist ein Speicherleck, das nur darauf wartet, zu passieren.

**Provider in `initState` lesen.** Ein verbreitetes GetX-Muster ist `final c = Get.find<MyController>()` in `initState`. Das Riverpod-Äquivalent ist `ref.read(myProvider.notifier)` in `initState`, aber nur innerhalb eines `ConsumerStatefulWidget`. Innerhalb von `build` zu lesen, ist für `ref.watch` in Ordnung; einmal in `initState` `notifier` zu lesen und ihn zu speichern, ist ein Code Smell, weil sich die Notifier-Identität nach einer `ref.invalidate` ändern kann. Bevorzugen Sie `ref.read` an der Aufrufstelle.

**Hintergrund-Tasks unter Routenwechseln.** Riverpod 3 pausiert Listener in unsichtbaren Widgets, was meistens das ist, was Sie wollen, aber es ändert das Timing von Arbeit, die zuvor durch die eifrige `Obx` von GetX am Leben gehalten wurde. Wenn ein Netzwerk-Refresh weiterlaufen muss, während der Nutzer auf einem anderen Tab ist, geben Sie diese Arbeit einem `keepAlive: true`-`AsyncNotifier`, statt zu erwarten, dass ein pausiertes Widget sie antreibt.

**Hot Restart wirft die GetX-Seite zuerst ab.** Während der Phase mit beiden Bibliotheken setzt ein Hot Restart `Get.put`-Instanzen zurück, aber Riverpod-State überlebt, wenn der `ProviderScope` an der Spitze des Baums sitzt. Das ist für die Migration tatsächlich nützlich: Sie können einen Hot Restart auslösen, sehen, wie Riverpod-eigener State stehenbleibt, und bestätigen, was Sie noch zu verschieben haben.

**`Obx`-Build-Fehler nach dem Löschen.** Wenn Sie den GetX-Import aus einer Datei entfernen, werden übriggebliebene `Obx(...)`-Aufrufe zu einem harten Compile-Fehler statt einer Laufzeit-Warnung. Suchen Sie das Projekt vor dem Commit nach `Obx(` und `GetBuilder<` ab; der Compiler wird sie abfangen, aber ein einziger grep-Durchlauf spart einen Build-Zyklus.

## Wie das in den Rest Ihrer Flutter-Pipeline passt

Die Migration ist selten die einzige Flutter-Aufgabe in Arbeit. Wenn Sie auch [eine Multi-Version-CI-Matrix](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) betreiben, pinnen Sie sowohl `flutter_riverpod` als auch die generierten `*.g.dart`-Dateien explizit, damit ein Dart-SDK-Bump nicht stillschweigend Boilerplate neu generiert, das einen alten Branch bricht. CPU-gebundene Arbeit, die früher in einem GetX-Controller lebte (Parsing, Hashing, große Reduces), gehört ohnehin [in einen Dart Isolate](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), und der Wechsel zu `AsyncNotifier` macht die Übergabe sauberer, weil der Loading-State bereits erstklassig ist. Wenn ein Notifier nativen Code aufrufen muss, [binden Sie ihn über einen Platform Channel ein, ohne ein Plugin zu schreiben](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/), und stellen Sie den Channel als eigenen Provider bereit, damit Tests ihn überschreiben können. Und wenn die Migration abgeschlossen ist und Sie einen Build ausliefern, der auf einem echten Gerät debuggt werden muss, gilt der [iOS-von-Windows-Geräte-Workflow](/de/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) weiterhin; nichts an der State-Bibliothek ändert, wie sich der Observatory-Port verhält.

Das kürzeste mentale Modell für die Migration: GetX tauscht Korrektheit gegen Ergonomie, Riverpod tauscht Ergonomie gegen Korrektheit. Sie schreiben Ihre App nicht neu, Sie benennen und fassen ihren State-Graph neu ein. Tun Sie es Bildschirm für Bildschirm, lassen Sie die Phase mit beiden Bibliotheken laufen, bis jedes `Get.find` weg ist, und überspringen Sie nicht den Routing-Schritt. Wenn der letzte `package:get`-Import aus `pubspec.yaml` herausfliegt, wird die Codebasis kleiner sein, und die Tests werden der Teil sein, vor dem Sie aufhören, sich zu fürchten.

## Quellenverweise

- [Riverpod 3.0 migration guide](https://riverpod.dev/docs/3.0_migration)
- [flutter_riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod)
- [riverpod_generator on pub.dev](https://pub.dev/packages/riverpod_generator)
- [go_router on pub.dev](https://pub.dev/packages/go_router)
- [Riverpod testing recipes](https://riverpod.dev/docs/essentials/testing)
- [GetX package on pub.dev](https://pub.dev/packages/get)
