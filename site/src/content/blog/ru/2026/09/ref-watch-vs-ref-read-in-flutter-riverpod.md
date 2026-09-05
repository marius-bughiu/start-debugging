---
title: "ref.watch и ref.read в Riverpod: в чём разница и когда что использовать"
description: "ref.watch подписывается и перестраивает, ref.read читает один раз и никогда не перестраивает. Используйте watch в каждом методе build, а read только внутри обработчиков событий. Здесь матрица выбора, исходный код обоих методов во flutter_riverpod 3.4.3 и четыре тихих отказа: watch в обработчике, read в теле провайдера, read у провайдера autoDispose и read в роли оптимизации."
pubDate: 2026-09-05
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "ru"
translationOf: "2026/09/ref-watch-vs-ref-read-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-09-05
---

`ref.watch` регистрирует подписку, `ref.read` нет. Это единственное различие определяет всё остальное. Используйте `ref.watch` внутри методов `build`, как в `build` у `ConsumerWidget`, так и в `build` у провайдера или `Notifier`, а `ref.read` используйте в коде, который выполняется один раз в ответ на событие: `onPressed`, `onTap`, обработчик `Timer`, метод-мутатор у `Notifier`. Выбор здесь не компромисс по производительности, а правило о месте вызова: код, который выполняется заново при изменении состояния, должен использовать watch, а код, который выполняется ровно один раз, должен использовать read. Всё изложенное ниже проверено на `riverpod` и `flutter_riverpod` 3.4.3 (опубликованы 2026-09-03) на Flutter 3.47.2 stable с Dart 3.13.2, плюс `riverpod_lint` 3.1.9.

## Матрица выбора

| | `ref.watch` | `ref.read` |
| --- | --- | --- |
| Регистрирует подписку | да | нет |
| Перестраивает вызывающий код при изменении значения | да | никогда |
| Удерживает живым провайдер `autoDispose` | да | нет |
| Корректен внутри `build` | да, это единственное место | почти всегда ошибка |
| Корректен внутри `onPressed` / `onTap` / таймеров | нет | да, это единственное место |
| Корректен внутри `initState` | нет | да, для однократной инициализации |
| Корректен внутри метода-мутатора у `Notifier` | нет | да |
| Приостанавливается, когда виджет вне экрана (`TickerMode` в Riverpod 3) | да | неприменимо |
| Уведомления фильтруются по `==` | да | неприменимо |
| Бросает ошибку при вызове не в том месте | нет, отказывает молча | нет |
| Инструмент для сокращения перестроений | `.select` | не этот |

Две последние строки обходятся дороже всего по времени отладки. Ни у одного из методов нет проверки во время выполнения, а `ref.read` не является способом сократить перестроения.

## Эти два метода живут в двух разных классах

Riverpod предоставляет `watch` и `read` дважды, в двух не связанных между собой типах, и реализации действительно различаются.

`WidgetRef` вы получаете от `ConsumerWidget`, от builder-а `Consumer` или от `ConsumerState`. Его реализация находится в `ConsumerStatefulElement`:

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

`watch` кладёт `ProviderSubscription` в словарь `_dependencies`, свой у каждого element, и слушатель этой подписки вызывает `markNeedsBuild()`. `read` обращается к `ProviderContainer` с `listen: false` и вызывает у него `read`. Ни записи в словаре, ни слушателя, ни перестроения, никогда.

`Ref` получает тело провайдера или `Notifier`. Имена те же, механика другая:

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

На стороне провайдера `watch` это `listen` плюс `invalidateSelf`, что официальная документация прямо описывает в комментарии к `Ref.watch`. `read` это обычное чтение из container. Схема одинакова в обоих классах: watch строит ребро графа, read нет.

## Правило про место вызова, а не про провайдер

Задайте один вопрос: должна ли эта строка кода выполниться снова, когда значение изменится?

- Внутри `build` да. Весь смысл `build` в том, что Riverpod может вызвать его снова. Используйте `ref.watch`.
- Внутри `onPressed` нет. Пользователь нажмёт кнопку ещё раз, и обработчик выполнится снова со свежим значением. Используйте `ref.read`.

Официальная документация прямо говорит, что считается значением по умолчанию. Со страницы Riverpod про refs: "Do not use Ref.read as a mean to 'optimize' your code by avoiding Ref.watch. This will make your code more brittle." И из собственного комментария к `Ref.read` в 3.4.3: "If possible, avoid using [read] and prefer [watch], which is generally safer to use."

Вот форма, корректная во всех версиях Riverpod начиная с 2.0:

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

## `ref.watch` внутри обработчика не бросает ошибку, и в этом вся проблема

Если перенести `ref.watch(counterProvider)` внутрь замыкания `onPressed`, приложение соберётся, анализатор промолчит, а полученное значение будет верным. Ничто в `riverpod_lint` 3.1.9 это не пометит: набор правил такой: `missing_provider_scope`, `provider_dependencies`, `scoped_providers_should_specify_dependencies`, `avoid_build_context_in_providers`, `provider_parameters`, `avoid_public_notifier_properties`, `unsupported_provider_value`, `functional_ref`, `notifier_extends`, `avoid_ref_inside_state_dispose`, `avoid_keep_alive_dependency_inside_auto_dispose`, `notifier_build`, `riverpod_syntax_error`, `async_value_nullable_pattern` и `protected_notifier_properties`. Ни одно из них не про "watch вне build".

То, что происходит на самом деле, хуже падения. Взгляните ещё раз на `ConsumerStatefulElement.build`:

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

Каждый build подменяет `_dependencies` новым словарём и закрывает всё, что осталось от предыдущего. `ref.watch`, вызванный из `onPressed`, выполняется, когда `_oldDependencies` равен `null`, поэтому он вставляет совершенно новую подписку в живой словарь `_dependencies`. С этого момента и до следующего перестроения виджет подписан на провайдер, который его метод `build` вообще не упоминает. Если провайдер изменится в этом окне, сработает `markNeedsBuild` и виджет перестроится. Затем перестроение отбросит подписку, потому что `build` её не регистрирует заново, и второе изменение не сделает ничего.

Это одноразовая реактивность, зависящая от тайминга кадров. Ровно тот класс ошибок, который воспроизводится только на медленном устройстве.

Обратите внимание на контраст с `ref.listen`, который себя защищает:

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

`listen` проверяет это через assert в отладочных сборках. `watch` нет. Не воспринимайте отсутствие проверки как разрешение.

## `ref.read` в теле провайдера навсегда замораживает зависимость

Та же ошибка на стороне провайдера ещё тише, потому что нет виджета, чьё отсутствие перестроения было бы заметно.

```dart
// riverpod 3.4.3, WRONG
final localeProvider = NotifierProvider<LocaleNotifier, Locale>(LocaleNotifier.new);

final greetingProvider = Provider<String>((ref) {
  // No graph edge. This provider will never be recomputed when the locale changes.
  final locale = ref.read(localeProvider);
  return locale.languageCode == 'fr' ? 'Bonjour' : 'Hello';
});
```

`greetingProvider` вычисляется один раз и кеширует результат. Смена локали перестраивает `localeProvider` и каждый виджет, который его наблюдает, а `greetingProvider` остаётся сидеть на устаревшей строке, пока что-нибудь другое его не инвалидирует. Замените на `ref.watch(localeProvider)`, и ребро появится: `Ref.watch` вызывает `_invalidateSelf(asReload: true)` при каждом изменении, поэтому `greetingProvider` пересчитывается по требованию.

То же самое верно внутри `Notifier`. Комментарий к `Notifier.build` в 3.4.3 говорит об этом прямо: "It is safe to use [Ref.watch] or [Ref.listen] inside this method." Watch в `build`. В `increment()` или `submit()` read.

## `ref.read` у провайдера `autoDispose` выбрасывает работу впустую

Именно эта ситуация порождает баг-репорты с заголовком "моё состояние сбрасывается в ноль".

Автоматическое уничтожение отслеживается по слушателям, а не по чтениям. При генерации кода у `@riverpod` по умолчанию `keepAlive: false`, поэтому каждый сгенерированный провайдер уничтожается автоматически, если вы не укажете иное:

```dart
// riverpod_annotation 3.x
final class Riverpod {
  const Riverpod({
    this.keepAlive = false,
    ...
  });
}
```

Написанные вручную провайдеры устроены наоборот. `NotifierProvider` и `Provider` в `riverpod` 3.4.3 оба объявляют `super.isAutoDispose = false`, то есть по умолчанию остаются живыми, а включаете вы уничтожение через `NotifierProvider.autoDispose` или `isAutoDispose: true`.

Теперь рассмотрим сгенерированный, автоматически уничтожаемый счётчик, который никто на экране не наблюдает:

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

`ref.read` создаёт провайдер, выполняет `build()`, возвращает notifier и не добавляет ни одного слушателя. Документация про уничтожение описывает тайминг: когда число слушателей достигает нуля, провайдер считается "not used", Riverpod "waits for one frame", и если он всё ещё не используется, провайдер уничтожается. Значит, инкремент попадает в `Counter`, который сносится кадром позже. Следующее нажатие начинается снова с `0`.

Исправление не в том, чтобы поставить `ref.watch` в обработчик. Нужно, чтобы кто-то законно наблюдал провайдер, обычно это виджет, отображающий счётчик, либо вызвать `ref.keepAlive()` внутри `build`, если состояние действительно должно пережить своих слушателей.

## Наблюдайте значение, читайте notifier

`ref.read(counterProvider.notifier)` это канонический способ добраться до методов-мутаторов, и он дословно приведён в комментарии к `Notifier`. `ref.watch(counterProvider.notifier)` не преступление, но бесполезен: в 3.x Riverpod фильтрует все уведомления по `==`, а комментарий к `Notifier` утверждает, что при повторном выполнении `build` "the [Notifier] will **not** be recreated. Its instance will be preserved between executions of [build]." Один и тот же экземпляр равен сам себе, поэтому наблюдение за `.notifier` почти никогда ничего не выдаёт. Оно срабатывает только когда провайдер полностью уничтожается и создаётся заново. Вы получаете подписку, которая не даёт вам ничего, кроме удержания от автоматического уничтожения, о котором вы не просили.

Итак: `ref.watch(provider)` для значения, `ref.read(provider.notifier)` для методов.

## `initState` не хочет ни того, ни другого

В `ConsumerState` метод `initState` выполняется до первого `build`. `ref.watch` там не бросает ошибку, но созданную им подписку первый build отбрасывает, если только `build` случайно не наблюдает тот же провайдер, из-за чего поведение становится случайным. `ref.listen` бросает свою проверку `debugDoingBuild`. Поддерживаемый API это `listenManual`:

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

`listenManual` намеренно читает container с `listen: false`, чтобы быть безопасным в `initState`, а `ConsumerStatefulElement.unmount` закрывает ручные слушатели после выполнения `State.dispose`. Закрывать его самому не нужно, хотя возвращаемая подписка это позволяет.

Раз уж вы в коде жизненного цикла `State`, вспомните про другой конец: обращение к `ref` в `dispose` бросает ошибку, и правило `avoid_ref_inside_state_dispose` из `riverpod_lint` существует именно для этого. Сообщение в 3.4.3 такое: `Using "ref" when a widget is about to or has been unmounted is unsafe.`, это текущая формулировка старой [ошибки Cannot use "ref" after the widget was disposed](/ru/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

## Riverpod 3 приостанавливает подписки watch, и это убивает последний довод за read

Фольклор "read дешевле" появился до Riverpod 3. В 3.x подписки, созданные через `WidgetRef.watch`, участвуют в `TickerMode`:

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

Когда виджет уходит с экрана, в неактивной вкладке `TabBarView` или под наложенным сверху маршрутом, все его подписки watch приостанавливаются, и стоящие за ними провайдеры перестают работать. Переход на `ref.read` не даёт сопоставимой экономии, потому что у `ref.read` изначально нет подписки, которую можно было бы приостановить. Стоимость watch во время выполнения это одна запись в `HashMap` плюс один вызов слушателя, и не это бьёт по вашему бюджету кадра.

Если вам действительно нужно меньше перестроений, инструмент это `.select`, а не `read`:

```dart
// flutter_riverpod 3.4.3
// Rebuilds on every user field change:
final user = ref.watch(userProvider);
Text(user.name);

// Rebuilds only when the name changes, because select's output is compared with ==:
final name = ref.watch(userProvider.select((u) => u.name));
Text(name);
```

`select` сохраняет подписку, а значит сохраняет и реактивность, и удержание от уничтожения, и лишь фильтрует, что считать изменением. Вот это и есть оптимизация. `ref.read` не оптимизация, это удаление возможности.

Учтите, что фильтрация по `==` в Riverpod 3.0 глобальна и одинаково применяется к `watch`, `select` и `listen`, что даёт собственный класс сюрпризов, когда ваш класс состояния не реализует равенство. Если watch не срабатывает там, где вы этого ждёте, проверьте `==` прежде чем винить место вызова: это тот же механизм, что стоит за [StreamProvider, теряющим события в Riverpod 3.0](/ru/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## Что писать на практике

По умолчанию берите `ref.watch`. К `ref.read` обращайтесь ровно в трёх местах: в обработчике события, в методе-мутаторе у `Notifier` и в случае `Ref`, который вы намеренно сохранили в обычном сервисном классе, чтобы сервис мог получать текущие значения, не пересоздаваясь, а это как раз сценарий, который показывает собственная документация `Ref.read`. Везде остальном watch. Если вы заменяете watch на read, чтобы что-то перестало перестраиваться, вы нашли повод для `select` или провайдер со слишком крупной областью, а не причину вырезать ребро из графа.

И если `ref.watch` выглядит уместным в обработчике, вам, скорее всего, нужен `ref.listen` в `build` (для побочных эффектов, пока виджет жив) или `ref.listenManual` в `initState` (для побочных эффектов, привязанных к `State`).

## Похожие статьи

- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/ru/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)
- [Проверка ref.mounted после асинхронного разрыва в Riverpod 3](/ru/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [Какой пакет Riverpod ставить: riverpod, flutter_riverpod или hooks_riverpod](/ru/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [Показ состояний загрузки и ошибки через AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Полное руководство по миграции с Riverpod 2.x на 3.0](/ru/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)

## Источники

- [Refs](https://riverpod.dev/docs/concepts2/refs), официальная страница про `Ref.watch`, `Ref.read` и `Ref.listen`.
- [Automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose), про льготный период в один кадр и отслеживание по числу слушателей.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new), про фильтрацию по `==` и приостановку на основе `TickerMode`.
- [flutter_riverpod 3.4.3 на pub.dev](https://pub.dev/packages/flutter_riverpod/versions/3.4.3), источник процитированного выше `ConsumerStatefulElement`.
- [riverpod 3.4.3 на pub.dev](https://pub.dev/packages/riverpod/versions/3.4.3), источник процитированных выше `Ref.watch` и `Ref.read`.
- [riverpod_lint 3.1.9 на pub.dev](https://pub.dev/packages/riverpod_lint), полный список правил, на который ссылается статья.
