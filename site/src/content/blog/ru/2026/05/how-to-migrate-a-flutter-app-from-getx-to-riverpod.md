---
title: "Как мигрировать Flutter-приложение с GetX на Riverpod"
description: "Пошаговая миграция с GetX на Riverpod 3.x в реальном Flutter-приложении: GetxController в Notifier, .obs в производные провайдеры, Get.find в ref.watch, Get.to в go_router, плюс снэкбары, темы и тесты. Проверено на Flutter 3.27.1, Dart 3.11, flutter_riverpod 3.3.1."
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
lang: "ru"
translationOf: "2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod"
translatedBy: "claude"
translationDate: 2026-05-06
---

Коротко: установите `flutter_riverpod` рядом с GetX, оберните приложение в `ProviderScope` и мигрируйте по одному экрану за раз. Замените каждый `GetxController` на `Notifier` (или `AsyncNotifier` для асинхронной работы), переведите каждое поле `.obs` либо в состояние notifier, либо в `Provider`, который из него выводится, замените `Get.find<T>()` на `ref.watch(myProvider)` и переведите маршрутизацию на `go_router`, чтобы наконец отказаться от `Get.to`. Снэкбары, диалоги и смена темы перестраиваются на стандартных Flutter API. Проверено на Flutter 3.27.1, Dart 3.11, flutter_riverpod 3.3.1, riverpod_generator 2.6.5 и go_router 14.6.

GetX стал популярным потому, что отвечал на каждый вопрос одним импортом. Состояние, маршруты, внедрение зависимостей, снэкбары, интернационализация, темы, всё из `package:get`. Это было его силой в 2021 году и стало его проблемой в 2026: одна зависимость, владеющая половиной вашей среды выполнения, культура сокращений без `BuildContext` (`Get.context!`, `Get.snackbar`), которая делает приложение трудным для понимания, и темп сопровождения, который больше не соответствует темпу релизов Flutter. Riverpod это противоположный компромисс. Он делает одно дело (граф состояния с явными зависимостями) и заставляет вас опираться на стандартные Flutter API для маршрутизации и UI-оболочки. Миграция в основном механическая, но несколько шаблонов будут сопротивляться. В этом посте разбираются те, на которых спотыкается каждая команда.

## Что вы на самом деле переводите

Прежде чем трогать код, запишите, что GetX делает за вас. Большинство приложений опираются на пять вещей:

1. `GetxController` плюс `Rx<T>` / `.obs` для состояния.
2. `Get.put` / `Get.lazyPut` / `Get.find` для внедрения зависимостей.
3. `Obx` и `GetBuilder` для перерисовки виджетов при изменении состояния.
4. `Get.to`, `Get.toNamed`, `Get.back` для навигации.
5. `Get.snackbar`, `Get.dialog`, `Get.changeTheme` для UI-побочных эффектов.

Riverpod закрывает пункты 1-3 напрямую, при правильно настроенной кодогенерации. Он не делает 4 или 5 по дизайну. Вы замените навигацию на `go_router` (или встроенный `Navigator`), а снэкбары, диалоги и смена темы возвращаются к обычным Flutter-виджетам, читающим состояние из провайдера. Это та часть миграции, которая удивляет людей: Riverpod меньше по охвату, чем GetX, и в этом весь смысл.

## Добавьте Riverpod, не удаляя GetX

Постепенная миграция работает, только если обе библиотеки могут сосуществовать. Они могут, с одной оговоркой: `Get.put` сохраняет свой собственный сервис-локатор, а у Riverpod своё дерево провайдеров, поэтому у каждой части состояния в каждый момент времени ровно один владелец. Выбирайте этого владельца на уровне экрана, а не на уровне типа.

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

Оберните существующий `GetMaterialApp` в `ProviderScope`. Можно сохранить `GetMaterialApp` до миграции маршрутизации; два дерева не конфликтуют.

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

Добавьте `riverpod_lint` в `analysis_options.yaml` один раз. Он ловит две ошибки, которые кусаются больнее всего: чтение провайдера во время build с помощью `ref.read` и забытое `final` у notifier, который вы сохраняете.

## GetxController в Notifier, механический проход

Возьмите самый простой контроллер. Счётчики это hello-world для GetX, и преобразование почти строка в строку.

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

Эквивалент Riverpod 3.x использует кодогенерацию. Сгенерированный `counterProvider` играет роль `Get.put` плюс `Obx`: он владеет состоянием, знает, как перерисовывать зависящих от него потребителей, и сам уничтожается, когда никто его не читает.

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

Запустите `dart run build_runner watch -d` один раз и оставьте работать. Генератор выдаёт `counterProvider`, и виджет читает его так же, как раньше читал `Obx`:

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

Две вещи, которые надо усвоить. Во-первых, `ref.watch` подписывается, а `ref.read` нет. Используйте `ref.read` только внутри коллбэков (нажатий кнопок, методов жизненного цикла), никогда в методе build. Во-вторых, присваивание `state =` делает эквивалент `count.value++` плюс перерисовку, атомарно. Больше нет момента между `busy.value = true` и перерисовкой, когда кто-то ещё может наблюдать несогласованную пару полей. Это одно изменение убивает целый класс багов, которые GetX-приложения склонны накапливать.

## Асинхронная работа: AsyncNotifier заменяет ручной флаг загрузки

Большинство GetX-контроллеров носят с собой собственный `isLoading.obs`, потому что у `RxFuture` шероховатые края. Riverpod трактует асинхронность как состояние первого класса через `AsyncValue<T>`. Тот же шаблон загрузки списка пользователей сворачивается до этого:

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

Виджет получает состояния загрузки, ошибки и данных без единого булева поля:

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

Riverpod 3.0 также автоматически повторяет неуспешные провайдеры по умолчанию. Если вам это не нужно (например, 401 не должен повторяться), задайте `retry: (count, error) => null` на провайдере или глобально на `ProviderScope`. Прочитайте [заметки о повторах в миграции 3.0](https://riverpod.dev/docs/3.0_migration), прежде чем переключать; поведение по умолчанию действительно полезно, но в тестах оно может маскировать временные баги.

## Внедрение зависимостей: Get.find становится ref.watch

GetX использует глобальный сервис-локатор. Где угодно в приложении `Get.find<ApiClient>()` возвращает один и тот же экземпляр. Riverpod заменяет это провайдером, который конструирует значение один раз на `ProviderContainer`.

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

`ref.onDispose` это та часть, на которую у GetX никогда не было чистого ответа. Когда последний потребитель `dioProvider` исчезает, HTTP-клиент закрывается; если он возвращается, провайдер пересоздаётся, и вы получаете свежий `Dio`. Жизненный цикл наконец-то явный. Для сервисов, которые действительно живут вечно, отметьте провайдер `keepAlive: true` (или откажитесь от `autoDispose`) и владейте этим решением в коде, а не надейтесь, что `Get.put(permanent: true)` переживёт hot restart.

Чтобы оба механизма DI работали во время миграции, зарегистрируйте небольшой мост, передающий разрешённые GetX-синглтоны потребителям Riverpod:

```dart
// Bridge: read from GetX, expose as a Riverpod provider
@riverpod
LegacyAuthService legacyAuth(Ref ref) => Get.find<LegacyAuthService>();
```

Уберите мост, как только в GetX больше нечего регистрировать.

## Реактивные производные: где .obs действительно блистает, и как Riverpod это заменяет

`.obs` делает производное состояние почти бесплатным. `final fullName = ''.obs;` плюс `ever(firstName, (_) => fullName.value = '$firstName $lastName')` это одна строка. Эквивалент в Riverpod это отдельный провайдер, перечисляющий свои входы:

```dart
// flutter_riverpod 3.3.1
@riverpod
String fullName(Ref ref) {
  final first = ref.watch(firstNameProvider);
  final last = ref.watch(lastNameProvider);
  return '$first $last';
}
```

Преимущество в том, что `fullNameProvider` пересчитывается только когда один из его входов действительно меняется (Riverpod 3 использует `==` для фильтрации равенства, апгрейд от старой проверки `identical`), и любой виджет, читающий его, перерисовывается только когда производная строка меняется. Цена в том, что приходится называть каждый вход. Это именование самый сложный редакторский выбор миграции. Сопротивляйтесь искушению похоронить всё в одном мега-notifier; маленькие провайдеры лучше композируются и их гораздо проще тестировать.

Для производных, которым нужна отмена (поле поиска, бьющее по сети по мере ввода), используйте `AsyncNotifier` и отменяйте через `ref.onDispose` плюс `CancelToken`. Это заменяет `debounce(query, ..., time: ...)` из GetX кодом, который переживает unit-тесты.

## Маршрутизация: откажитесь от Get.to и переходите на go_router

Это шаг, который команды откладывают дольше всего, потому что маршрутизация GetX действительно работает. Заплатите цену рано. Как только `go_router` владеет навигацией, остальная миграция ускоряется, потому что вам больше не нужен `Get.context` в контроллерах.

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

Замените `Get.to(NextPage())` на `context.go('/next')`, `Get.toNamed('/users/42')` на `context.go('/users/42')`, а `Get.back()` на `context.pop()`. Строковые пути сначала ощущаются как откат от типизированных конструкторов страниц; на практике вы пишете тонкий `extension` на `BuildContext`, который оборачивает строки, а проверка ссылок приходит из `go_router_builder` или ваших тестов.

## Снэкбары, диалоги, темы: назад к обычному Flutter

`Get.snackbar` удобен, потому что ему не нужен `BuildContext`. Это удобство также причина, по которой его нельзя протестировать. Идиоматичный ответ Riverpod это сигнал, состоящий только из состояния, который потребляет UI:

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

Оберните часть дерева, у которой есть предок-`Scaffold`, в `ToastListener`. Теперь любой контроллер может вызвать `ref.read(toastProvider.notifier).show('Saved')` без обращения к `BuildContext`, а тесты проверяют состояние провайдера вместо перехвата overlay.

С темами аналогично. `Get.changeTheme` становится `themeProvider`, за которым следит `MaterialApp.router`. Локализация может либо продолжать использовать `Get.locale`, пока вы не мигрируете её последней, либо перейти на `flutter_localizations` плюс `localeProvider`.

## Тесты становятся быстрее и яснее

Самая большая выгода это в тестах. Тест GetX-контроллера обычно требует `Get.testMode = true` плюс аккуратной разборки синглтонов. Тест Riverpod создаёт `ProviderContainer`, переопределяет ровно те провайдеры, которые ему важны, и уничтожает контейнер в конце:

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

Переопределяйте провайдеры для подстановки фейков (`apiClientProvider.overrideWithValue(FakeApi())`), и в большинстве случаев фреймворк для моков уже не нужен. В Riverpod 3 слушатели приостанавливаются, когда не видны, но в тестах каждый контейнер по умолчанию "виден", если вы явно не моделируете обратное, поэтому изменение невидимо для существующих тестовых наборов.

## Подводные камни, которые миграция всегда задевает

**`autoDispose` против синглтонов.** Кодогенерируемые провайдеры `@riverpod` по умолчанию auto-dispose. Если вы преобразовали контроллер `Get.put(permanent: true)` и заметили, что состояние сбрасывается при уходе с экрана, отметьте провайдер `@Riverpod(keepAlive: true)`. Делайте это осознанно; перманентное состояние это утечка памяти, которая ждёт своего часа.

**Чтение провайдеров в `initState`.** Распространённый шаблон GetX это `final c = Get.find<MyController>()` в `initState`. Эквивалент Riverpod это `ref.read(myProvider.notifier)` в `initState`, но только внутри `ConsumerStatefulWidget`. Чтение внутри `build` нормально для `ref.watch`; чтение `notifier` один раз в `initState` и его сохранение это запах, потому что идентичность notifier может смениться после `ref.invalidate`. Предпочитайте `ref.read` в месте вызова.

**Фоновые задачи при сменах маршрутов.** Riverpod 3 приостанавливает слушателей в невидимых виджетах, что обычно то, что вам нужно, но это меняет тайминг работы, которая раньше держалась живой жадным `Obx` из GetX. Если обновление сети должно продолжаться, пока пользователь на другой вкладке, поручите эту работу `AsyncNotifier` с `keepAlive: true`, а не ожидайте, что приостановленный виджет будет её двигать.

**Hot restart сбрасывает GetX-сторону первой.** Во время фазы двух библиотек hot restart сбрасывает экземпляры `Get.put`, но состояние Riverpod выживает, если `ProviderScope` находится наверху дерева. Это действительно полезно для миграции: можно сделать hot restart, увидеть, как держится состояние, принадлежащее Riverpod, и убедиться, что осталось перенести.

**Ошибки сборки `Obx` после удаления.** Когда вы удаляете импорт GetX из файла, оставшиеся вызовы `Obx(...)` становятся жёсткой ошибкой компиляции, а не предупреждением во время выполнения. Поищите в проекте `Obx(` и `GetBuilder<` перед коммитом; компилятор их поймает, но один проход grep сэкономит цикл сборки.

## Как это вписывается в остальной Flutter-конвейер

Миграция редко единственная Flutter-задача в работе. Если вы также запускаете [многоверсионную CI-матрицу](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), зафиксируйте и `flutter_riverpod`, и сгенерированные файлы `*.g.dart` явно, чтобы апгрейд Dart SDK молча не перегенерировал шаблонный код, ломающий старую ветку. CPU-зависимая работа, которая раньше жила в GetX-контроллере (парсинг, хеширование, большие свёртки), и так принадлежит [Dart-изоляту](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), а переход на `AsyncNotifier` делает эту передачу чище, потому что состояние загрузки уже первоклассное. Если notifier должен вызывать нативный код, [добавьте его через platform channel без написания плагина](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/), а затем выставьте канал как отдельный провайдер, чтобы тесты могли его переопределить. А когда миграция завершена и вы выпускаете сборку, которую нужно отлаживать на реальном устройстве, [рабочий процесс iOS-с-Windows для реального устройства](/ru/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) по-прежнему применим; ничто в библиотеке состояния не меняет поведение порта observatory.

Самая короткая ментальная модель миграции: GetX обменивает корректность на эргономику, Riverpod обменивает эргономику на корректность. Вы не переписываете приложение, вы переименовываете и пересматриваете область видимости его графа состояния. Делайте это экран за экраном, оставьте фазу двух библиотек работать, пока не уйдёт каждый `Get.find`, и не пропускайте шаг с маршрутизацией. К тому моменту, когда последний импорт `package:get` выйдет из `pubspec.yaml`, кодовая база станет меньше, а тесты перестанут быть той частью, которой вы боитесь.

## Ссылки на источники

- [Руководство по миграции на Riverpod 3.0](https://riverpod.dev/docs/3.0_migration)
- [flutter_riverpod на pub.dev](https://pub.dev/packages/flutter_riverpod)
- [riverpod_generator на pub.dev](https://pub.dev/packages/riverpod_generator)
- [go_router на pub.dev](https://pub.dev/packages/go_router)
- [Рецепты тестирования Riverpod](https://riverpod.dev/docs/essentials/testing)
- [Пакет GetX на pub.dev](https://pub.dev/packages/get)
