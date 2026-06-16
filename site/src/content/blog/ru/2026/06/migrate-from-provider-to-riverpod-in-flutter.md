---
title: "Миграция с provider на Riverpod во Flutter (provider 6.1.5 на Riverpod 3.x)"
description: "Пошаговая миграция с пакета provider на Riverpod 3.x в реальном приложении Flutter: ChangeNotifierProvider на Notifier, MultiProvider на ProviderScope, context.watch на ref.watch, ProxyProvider на композицию через ref.watch, плюс подводные камни с равенством и жизненным циклом. Проверено на Flutter 3.27.1, Dart 3.11, provider 6.1.5, flutter_riverpod 3.3.1."
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
lang: "ru"
translationOf: "2026/06/migrate-from-provider-to-riverpod-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-16
---

Коротко: добавьте `flutter_riverpod` рядом с `provider`, оберните приложение в `ProviderScope` вместо `MultiProvider` и мигрируйте по одной возможности за раз, начиная с листьев дерева зависимостей. Каждый `ChangeNotifier` становится `Notifier` (или `AsyncNotifier` для асинхронной работы), `context.watch<T>()` становится `ref.watch(myProvider)`, `Provider.of` и `context.read` становятся `ref.read`, а каждый `ProxyProvider` сворачивается в обычный `ref.watch` другого провайдера. Приложение малого или среднего размера это работа на один-три дня; ломается не синтаксис, а то, что Riverpod сравнивает состояние по равенству и поддерживает провайдеры живыми иначе, чем это делает `provider`. Проверено на Flutter 3.27.1, Dart 3.11, provider 6.1.5, flutter_riverpod 3.3.1, riverpod_annotation 2.6.1 и riverpod_generator 2.6.5.

Пакет `provider` (на данный момент 6.1.5) был ответом по умолчанию для управления состоянием во Flutter с 2019 года, и он по-прежнему работает. Но его автор, Remi Rousselet, написал Riverpod специально для того, чтобы исправить структурные проблемы `provider`: состояние, читаемое через `BuildContext`, означает `ProviderNotFoundException` во время выполнения вместо ошибки компиляции, вложенность `ProxyProvider` становится нечитаемой после двух зависимостей, и у вас не может быть двух провайдеров одного типа без трюков с `ValueKey`. Riverpod сохраняет ментальную модель (граф объектов, которые перестраивают виджеты при изменении) и убирает связку с `BuildContext`. Это руководство представляет собой механическую миграцию начиная с листьев, которая не требует переписывания.

## Зачем уходить с provider

- **Безопасность на этапе компиляции вместо `ProviderNotFoundException`.** В `provider` чтение типа, которого нет выше по дереву, выбрасывает исключение во время выполнения. В Riverpod провайдеры это глобальные объекты верхнего уровня, поэтому опечатка это ошибка компиляции, и ничего не нужно "находить".
- **Больше никакой пирамиды `MultiProvider`.** В Riverpod нет дерева провайдеров, которое нужно собирать. Один `ProviderScope` в корне заменяет весь список `MultiProvider(providers: [...])`, а зависимости между провайдерами выражаются через `ref.watch`, а не через порядок вложенности.
- **Два провайдера одного типа, бесплатно.** `provider` ключует всё по типу, поэтому два `ChangeNotifierProvider<CartModel>` конфликтуют. Riverpod ключует по объекту провайдера, поэтому здесь нет проблемы.
- **Auto-dispose и family, которые действительно компонуются.** Riverpod даёт вам `autoDispose` и параметризованные (`family`) провайдеры как первоклассные возможности, которые `provider` лишь приближённо воспроизводит через ручной `ChangeNotifierProvider.value` и управление ключами.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| Корневая привязка | `MultiProvider` заменён единственным `ProviderScope` | средняя |
| Чтения | `context.watch<T>()` / `Provider.of<T>(context)` заменены на `ref.watch` / `ref.read` | высокая |
| Notifier | `ChangeNotifier` + `notifyListeners()` заменены на `Notifier` + переприсваивание состояния | высокая |
| Семантика перестроения | Riverpod сравнивает состояние по `==`; мутация на месте больше не перестраивает | высокая |
| Композиция | `ProxyProvider` заменён на `ref.watch` зависимости | средняя |
| Виджеты | `StatelessWidget` / `StatefulWidget` становятся `ConsumerWidget` / `ConsumerStatefulWidget` | средняя |
| Жизненный цикл | `provider` уничтожается при удалении из дерева; Riverpod хранит состояние до `autoDispose` | средняя |

Две строки с серьёзностью `высокая` в областях перестроения и notifier это то, на чём команды теряют время. Всё остальное это поиск с заменой.

## Контрольный список перед стартом

- Установлены Flutter 3.27.1 / Dart 3.11 (или новее): `flutter --version`.
- Чистое рабочее дерево `git` и ветка, которую можно выбросить.
- Инвентаризация каждого провайдера, который вы регистрируете сегодня. Прогрепайте кодовую базу: `grep -rn "ChangeNotifierProvider\|ProxyProvider\|FutureProvider\|StreamProvider\|Provider.of\|context.watch\|context.read" lib/`.
- Пометка рядом с каждым из них о том, зависит ли от него что-нибудь. Мигрируйте сначала то, от чего ничего не зависит.
- Работающий набор тестов, пусть даже тонкий. Вы будете запускать его после каждого шага.

## Шаги миграции

1. **Добавьте Riverpod рядом с provider в `pubspec.yaml`.** Не удаляйте `provider` пока что. Оба пакета сосуществуют, потому что владеют отдельными деревьями; у конкретного куска состояния в каждый момент времени ровно один владелец, поэтому мигрируйте по возможности, а не по типу.

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

   Проверка: `flutter pub get` разрешается без конфликтов версий.

2. **Оберните корень приложения в `ProviderScope` и пока что оставьте `MultiProvider` внутри него.** `ProviderScope` это место, где Riverpod хранит всё состояние провайдеров. Это не список провайдеров, это единая граница. Оставьте существующий `MultiProvider` под ним, чтобы немигрированные экраны продолжали работать.

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

   Проверка: приложение по-прежнему собирается и работает идентично. Пока ничего не переехало.

3. **Преобразуйте один листовой `ChangeNotifier` в `Notifier`.** Выберите модель, от которой ничего больше не зависит. В `provider` вы изменяете поле и вызываете `notifyListeners()`. В Riverpod `build()` возвращает начальное состояние, и вы переприсваиваете `state`, чтобы уведомить. Никакого `notifyListeners()` нет.

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

   Запустите `dart run build_runner build --delete-conflicting-outputs`, чтобы сгенерировать `cartProvider`. Проверка: генератор создаёт `cart_model.g.dart` без ошибок.

4. **Переключите экран, который его потребляет, на `ConsumerWidget`.** `StatelessWidget` становится `ConsumerWidget`, и `build` получает `WidgetRef ref`. `context.watch<CartModel>()` становится `ref.watch(cartProvider)`. Для вызова метода `context.read<CartModel>().add(x)` становится `ref.read(cartProvider.notifier).add(x)`.

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

   Если у виджета уже было собственное состояние, используйте `ConsumerStatefulWidget` плюс `ConsumerState`, где `ref` доступен как поле. Удалите строку `ChangeNotifierProvider(create: (_) => CartModel())` из `MultiProvider`. Проверка: экран ведёт себя так же, а список `MultiProvider` стал на один короче.

5. **Замените `ProxyProvider` композицией через `ref.watch`.** Это шаг, который удаляет больше всего кода. `ProxyProvider`, который строит B из A, становится провайдером, который просто наблюдает за A.

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

   `ref.watch(...select(...))` это прямая замена `context.select` из `provider`, и это означает, что `apiClient` перестраивается только при изменении `token`, а не при каждом обновлении `AuthModel`. Проверка: зависимые виджеты перестраиваются при изменении вышестоящего провайдера.

6. **Мигрируйте `FutureProvider` и `StreamProvider` на их эквиваленты в Riverpod.** Имена те же; отличается только привязка. `FutureProvider` из `provider` читается через обвязку в стиле `context.watch<AsyncSnapshot>`; вариант в Riverpod возвращает `AsyncValue<T>`, который вы разбираете напрямую.

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

   Проверка: состояния загрузки и ошибки отрисовываются без ручных флагов `bool isLoading`. Подробнее об этом паттерне смотрите в связанной статье про AsyncValue ниже.

7. **Удалите зависимость `provider`.** Как только `MultiProvider` опустеет, удалите его из `main.dart`, затем уберите `provider: ^6.1.5` из `pubspec.yaml` и запустите `flutter pub get`. Компилятор отметит любые оставшиеся вызовы `context.watch`/`context.read`/`Provider.of`. Проверка: проект компилируется без единой ссылки на `package:provider`.

## Проверка

Прогоните этот контрольный список после последнего шага, а не только в самом конце:

- `flutter analyze` сообщает об отсутствии ошибок и предупреждений `riverpod_lint`.
- `dart run build_runner build --delete-conflicting-outputs` завершается чисто.
- `flutter test` проходит. Тесты Riverpod используют `ProviderContainer` (или `ProviderContainer.test()` в 3.x) и `container.read(provider)`, заменяя ваши старые модульные тесты `ChangeNotifier`.
- Ручной дымовой прогон: каждый мигрированный экран по-прежнему перестраивается при изменении состояния, и ни один экран не выбрасывает `ProviderNotFoundException` (по построению их не должно остаться).
- `grep -rn "package:provider" lib/` ничего не возвращает.

## План отката

Эта миграция обратима по возможностям именно потому, что оба пакета сосуществуют. Если мигрированный экран ведёт себя неправильно, откатите коммит этого экрана: верните строку `ChangeNotifierProvider` обратно в `MultiProvider`, восстановите класс `ChangeNotifier` и измените виджет обратно на `StatelessWidget`. Поскольку вы мигрировали начиная с листьев и по одной возможности на коммит, никакой откат не затрагивает больше одного экрана. Не удаляйте `provider` из `pubspec.yaml` (шаг 7), пока не будете уверены, поскольку это единственная дверь в один конец в этой последовательности.

## Подводные камни, на которые мы наткнулись

**Мутация на месте перестаёт перестраивать.** Это сюрприз номер один. В `provider` `_items.add(x); notifyListeners()` работает, потому что уведомлением управляете вы. В Riverpod `Notifier` фреймворк перестраивает только тогда, когда `state` присваивается значение, которое не `==` старому. `state.add(x)` изменяет тот же список, ссылка не меняется, и ничего не перестраивается. Всегда присваивайте новую коллекцию: `state = [...state, x]`. То же относится к объектам модели, поэтому неизменяемое состояние (records, `copyWith` или класс `freezed`) естественно сочетается с Riverpod.

**Провайдеры не уничтожаются, когда виджет покидает дерево.** `ChangeNotifierProvider` из `provider` уничтожается, когда его поддерево удаляется. Провайдер Riverpod по умолчанию хранит своё состояние на всё время жизни `ProviderScope`. Если вы полагались на то, что контроллер экрана сбрасывается, когда вы уходите с него, теперь вам нужен `autoDispose` (или, при генерации кода, это поведение по умолчанию для аннотированных провайдеров, если вы не вызываете `ref.keepAlive()`). Проверьте любой провайдер, чьё прежнее поведение зависело от уничтожения на основе дерева.

**`ref.read` внутри `build()` это ловушка.** Чтение другого провайдера через `ref.read` внутри `Notifier.build()` или `build` виджета делает снимок значения один раз и никогда его не обновляет. Используйте `ref.watch` для всего, что должно реагировать, и приберегите `ref.read` для обработчиков событий вроде колбэков кнопок. `riverpod_lint` отмечает большинство из этих случаев за вас, поэтому стоит установить эту dev-зависимость в первый же день.

**`Consumer` существует в обоих пакетах.** Если вы импортируете оба во время миграции, `Consumer` становится неоднозначным. `Consumer` из Riverpod принимает билдер `(context, ref, child)`; `Consumer` из `provider` принимает `(context, value, child)`. Предпочитайте преобразование всего виджета в `ConsumerWidget`, а не вставку `Consumer` из Riverpod в виджет эпохи provider, и так вы полностью избежите конфликта импортов.

Миграция вознаграждает за скуку: один лист, один коммит, прогон тестов, повтор. К тому моменту, когда вы удалите `provider` из `pubspec.yaml`, рискованная часть случилась неделями раньше, маленькими обратимыми шагами.

## Связанное

- Если вы приходите из другой библиотеки управления состоянием, [миграция с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) описывает тот же подход начиная с листьев для более тяжёлого фреймворка.
- Ещё не определились? [Сравнение provider, Riverpod и Bloc](/ru/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) раскладывает компромиссы перед тем, как вы определитесь.
- Про асинхронную сторону: [состояния загрузки и ошибки с AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) подробно разбирает `when` и `AsyncNotifier`.
- Приходите из чистого `FutureBuilder`? Смотрите [FutureBuilder/StreamBuilder против Riverpod AsyncValue](/ru/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).
- Самая частая ошибка времени выполнения после миграции: [Cannot use ref after the widget was disposed](/ru/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

## Источники

- [Документация Riverpod: миграция с pkg:provider (быстрый старт)](https://riverpod.dev/docs/from_provider/quickstart)
- [Документация Riverpod: от ChangeNotifier](https://riverpod.dev/docs/migration/from_change_notifier)
- [Документация Riverpod: что нового в 3.0](https://riverpod.dev/docs/whats_new)
- [provider 6.1.5 на pub.dev](https://pub.dev/packages/provider/versions/6.1.5)
- [Список изменений flutter_riverpod](https://pub.dev/packages/flutter_riverpod/changelog)
