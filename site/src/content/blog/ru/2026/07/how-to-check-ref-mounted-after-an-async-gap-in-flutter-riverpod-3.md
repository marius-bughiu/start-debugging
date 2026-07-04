---
title: "Как проверять Ref.mounted после асинхронного разрыва во Flutter Riverpod 3"
description: "В Notifier сначала получите зависимости до await, а затем защитите запись в state с помощью if (!ref.mounted) return. Это замена в Riverpod 3.0 для старого миксина с onDispose, которая предотвращает UnmountedRefException, когда provider уничтожается посреди await. Проверено на flutter_riverpod 3.x, Flutter 3.44, Dart 3.x."
pubDate: 2026-07-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
lang: "ru"
translationOf: "2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3"
translatedBy: "claude"
translationDate: 2026-07-04
---

Правило короткое: внутри `Notifier` или `AsyncNotifier` вызов `await` может уничтожить provider до того, как ваш код возобновится, а запись `state` в уничтоженный provider выбрасывает исключение. Поэтому прочитайте всё нужное из `ref` до первого `await`, выполните асинхронную работу, а затем защитите запись `state` с помощью `if (!ref.mounted) return;`. `Ref.mounted` является свойством из Riverpod 3.0 и близнецом `BuildContext.mounted` со стороны provider, и это поддерживаемый способ спросить "жив ли ещё этот provider?" после асинхронного разрыва. Это руководство проверено на `flutter_riverpod` 3.x (линия 3.0 вышла в сентябре 2025 года; текущая версия: 3.3.2), Flutter 3.44 (стабильная, май 2026 года) и Dart 3.x.

Если вы когда-либо писали собственный миксин, переключающий булево значение в `ref.onDispose`, чтобы проверить его после await, теперь его можно удалить. `Ref.mounted` делает именно это, корректно и без шаблонного кода.

## Почему await может оставить provider уничтоженным

`Ref` provider привязан к времени жизни этого provider. Когда provider уничтожается, его `Ref` становится недействительным, и Riverpod 3.0 выбрасывает исключение при любом дальнейшем взаимодействии с ним, включая чтение `ref`, вызов `ref.read` или присваивание `state`. Вы получаете исключение `UnmountedRefException`: "использование `ref` или `state` после асинхронного разрыва выбросит исключение, если notifier уже размонтирован".

Причина, по которой это кусается именно после `await`, кроется в асинхронном разрыве. Три вещи могут уничтожить provider, пока вы приостановлены на `Future`:

Provider с `autoDispose` теряет последнего слушателя. Если виджет, наблюдающий за provider, снимается со стека во время await, у provider не остаётся слушателей, поэтому Riverpod уничтожает его. Ваше продолжение затем просыпается с мёртвым `Ref`.

Provider явно инвалидируется. Другая часть приложения вызывает `ref.invalidate(myProvider)` или `ref.refresh(myProvider)` во время разрыва, что разбирает текущий экземпляр и создаёт новый. `Ref` старого экземпляра, который держит ваш приостановленный метод, теперь уничтожен.

Зависимость меняется. Provider делает `watch` за чем-то, что изменилось, вынуждая пересборку. `Ref` предыдущей сборки списывается.

Riverpod 3.0 сделал первый случай более редким, приостанавливая слушателей на время пересборки вместо немедленного их сбрасывания, так что provider, который просто пересобирается, не уничтожается охотно. Но по-настоящему осиротевший provider с `autoDispose`, теряющий всех наблюдателей посреди await, всё равно уничтожается. Изменение жизненного цикла сократило ложные срабатывания; оно не устранило настоящие. Это в точности сценарий, отслеживаемый в [issue 4096 riverpod](https://github.com/rrousselGit/riverpod/issues/4096).

Важная ментальная модель: сбой зависит от времени. Когда ожидаемая работа быстрая, provider обычно ещё жив при возобновлении, и всё работает. Когда сеть медленная или пользователь навигирует быстро, provider уничтожается первым, и запись `state` падает. Вот почему этот баг проходит код-ревью, проходит на вашей машине и падает в продакшене.

## Минимальное воспроизведение

Этот `AsyncNotifier` получает список, а затем записывает его обратно в `state` после await. Он компилируется, запускается и проходит каждый раз, когда получение быстрое.

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

Запустите `refresh()`, снимите экран со стека в течение 800 миллисекунд, и строка `state = AsyncData(orders)` выбросит исключение. С получением всё в порядке. Проблема в том, что `refresh` предположил, что provider всё ещё будет существовать при завершении `Future`, а для provider с `autoDispose`, чей наблюдатель ушёл, его нет.

## Исправление, шаг за шагом

Два правила покрывают почти все случаи. Получите зависимости до разрыва и защитите запись в state после него.

1. **Прочитайте каждую нужную зависимость до первого `await`.** Пока provider гарантированно жив (синхронная часть вашего метода), вызовите `ref.read` для каждой службы, репозитория или notifier, который вы будете использовать, и сохраните результаты в локальных переменных. Ссылка на обычный объект не устаревает при уничтожении provider; устаревает только `Ref`.

2. **Выполните асинхронную работу.** Дождитесь ваших `Future`, используя захваченные локальные переменные. Не трогайте `ref` внутри ожидаемых выражений, если можете этого избежать.

3. **Защитите возобновление с помощью `ref.mounted`.** Непосредственно перед присваиванием `state` (или вызовом любого метода `ref`) проверьте `if (!ref.mounted) return;`. Если provider был уничтожен во время разрыва, вы аккуратно выходите вместо выбрасывания исключения.

4. **Присвойте `state`.** Теперь запись попадает на живой provider.

Вот исправленный notifier:

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

`repo` представляет собой долговечную ссылку на объект; она прекрасно работает после await, даже если provider мёртв. Именно проверка `ref.mounted` останавливает сбой: она возвращает `false`, когда provider уничтожен, поэтому присваивание `state` никогда не выполняется против недействительного `Ref`. Это та же дисциплина, что удерживает в безопасности [состояния загрузки и ошибки с AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), и она структурно идентична [защите BuildContext после await](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) на стороне виджета.

Официальная документация Riverpod 3.0 показывает именно этот шаблон:

```dart
// From the Riverpod 3.0 "what's new" docs.
Future<void> addTodo(String title) async {
  final newTodo = await api.addTodo(title);
  if (!ref.mounted) return;
  state = [...state, newTodo];
}
```

## ref.mounted, WidgetRef и context.mounted: какая проверка куда

Самый частый источник путаницы состоит в том, какое `mounted` вам нужно, потому что их три, и они живут на трёх разных объектах.

`ref.mounted` находится на `Ref` provider, том, что вы получаете внутри `Notifier`, `AsyncNotifier` или в теле функционального provider (`Ref ref`). Используйте его, когда асинхронный код живёт в provider. Это свойство, добавленное в Riverpod 3.0; в 2.x его не было.

`context.mounted` находится на `BuildContext`. Используйте его, когда асинхронный код живёт в виджете и вам нужно тронуть дерево после (`Navigator`, `ScaffoldMessenger`, `Theme.of`). Линт `use_build_context_synchronously` анализатора Dart обеспечивает эту проверку.

`State.mounted` находится на `State` (и, следовательно, на `ConsumerState`). Используйте его в `ConsumerStatefulWidget` перед вызовом `setState` или чтением `WidgetRef` после await. Обратите внимание на ловушку: `WidgetRef` в виджете не является тем же объектом, что `Ref` provider, и у него нет `ref.mounted`. В виджете вы защищаете с помощью `context.mounted` или `State.mounted`, а не `ref.mounted`.

Практическое правило: если кадр стека, выбрасывающий исключение, находится внутри `Notifier` или `AsyncNotifier`, вам нужен `ref.mounted`. Если он внутри `ConsumerState` или `ConsumerWidget` (build/колбэк), вам нужен `context.mounted` или `State.mounted`. Ошибка здесь становится корнем тесно связанного [сбоя Cannot use "ref" after the widget was disposed](/ru/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/), чьим проактивным ответом на вариант со стороны provider является это руководство.

## Миксин из 2.x, который теперь можно удалить

До Riverpod 3.0 не было `Ref.mounted`, поэтому обходным решением сообщества был миксин, отслеживавший уничтожение вручную:

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

Это работало, но сопровождающий Riverpod явно не рекомендовал этот подход, и у него были острые углы (нужно было не забыть зарегистрировать `onDispose`, а флаг жил на экземпляре notifier, а не на ref). В 3.0 весь миксин схлопывается в одно свойство:

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

Если вы обновляетесь с 2.x и видите миксин `NotifierMounted` (или любой самодельный флаг `_mounted`) в своей кодовой базе, теперь это мёртвый груз. Удалите миксин, удалите строку `ref.onDispose(setUnmounted)` и замените `if (mounted)` на `if (!ref.mounted) return;`.

## Подводные камни и крайние случаи

**`ref.mounted` не заменяет очистку через `ref.onDispose`.** Защита предотвращает запись в уничтоженный provider; она не очищает ресурсы. Если ваш provider владеет подпиской, сокетом или таймером, зарегистрируйте их разбор через `ref.onDispose` в `build`. И не вызывайте `ref.read` внутри колбэка `onDispose`: provider в этот момент уже уничтожается, поэтому `ref` недействителен, и вы снова наткнётесь на `UnmountedRefException`. Линт `avoid-ref-inside-state-dispose` из DCM помечает именно это.

**Чтение provider с `autoDispose` через `.future` может уничтожить его после первого await.** Есть тонкий случай, обсуждаемый в [обсуждении 4293 riverpod](https://github.com/rrousselGit/riverpod/discussions/4293), когда provider с `autoDispose`, прочитанный через свой `.future`, уничтожается после первого `await`, потому что временный слушатель, созданный чтением, освобождается. Если вы связываете чтения через awaits, держите настоящего слушателя живым (наблюдайте за ним или используйте `ref.keepAlive()`), а не предполагайте, что `.future` держит provider открытым.

**`ref.keepAlive()` меняет расчёт.** Provider, который вы закрепили с помощью `ref.keepAlive()`, не выполнит `autoDispose`, когда его последний виджет уйдёт, поэтому причина "потерял последнего слушателя" исчезает. Он всё ещё может быть уничтожен явным `invalidate` или `refresh`, так что сохраняйте защиту `ref.mounted`, но понимайте, что закрепление убирает самый частый триггер.

**`AsyncValue.guard` не защищает монтирование.** `AsyncValue.guard` превращает выброшенное исключение в `AsyncError`, чтобы ошибка попала в ваше состояние вместо падения. Он ничего не делает с уничтожением. Вам всё ещё нужен `if (!ref.mounted) return;` после него, перед присваиванием защищённого результата в `state`. Эти два механизма решают разные проблемы: `guard` обрабатывает провал Future, `ref.mounted` обрабатывает исчезновение provider.

**У `ConsumerWidget` нет `ref.mounted`.** Его `ref` является `WidgetRef`, а не `Ref` provider. Если вы захватили `WidgetRef` в асинхронном колбэке внутри `ConsumerWidget` без состояния, проверять `mounted` негде. Перенесите асинхронную работу в Notifier, чтобы она выполнялась за долговечным `Ref` provider (именно такую форму даёт [миграция с FutureBuilder на AsyncNotifier](/ru/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)), или переключитесь на `ConsumerStatefulWidget`, чтобы иметь `State.mounted`.

**Начало выбрасывать исключение только после обновления до 3.0.** Riverpod 3.0 выбрасывает исключение при взаимодействии после уничтожения, тогда как 2.x иногда молча его терпел. Код, который "работал" раньше, уже писал в уничтоженный provider; 3.0 вывел на поверхность латентный баг, а не создал его. Добавьте защиту, не откатывайтесь на 2.x, чтобы скрыть его.

## Пусть линтер ловит те, что вы пропустили

Защита является привычкой, а привычки дают сбои. Два правила статического анализа превращают "не забудь проверить `ref.mounted`" в ошибку компиляции. DCM поставляет `use-ref-and-state-synchronously`, помечающий доступ к `ref` или `state` после асинхронного разрыва, которому не предшествует проверка mounted, и `avoid-ref-inside-state-dispose` для случая с `onDispose`. Собственный набор линтов Riverpod включает эквиваленты. Из коробки компилятор Dart не предупредит вас о `ref` после await так, как он это делает для `BuildContext`, поэтому включение этих правил составляет разницу между отловом бага в CI и отловом его в отчёте о сбое.

Единственная дисциплина, устраняющая весь этот класс багов: относитесь к `Ref` provider точно так же, как к `BuildContext`. Он действителен синхронно, `await` может сделать его недействительным, поэтому читайте нужное до разрыва и защищайте каждое обращение к `ref` или `state` после await с помощью `if (!ref.mounted) return;`. Впишите это в свой рефлекс async-notifier, и `UnmountedRefException` перестанет появляться. Это одна из причин, почему [принадлежащий Notifier жизненный цикл Riverpod является выбором по умолчанию для управления состоянием в 2026 году](/ru/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/).

## Связанное

- [Fix: Cannot use "ref" after the widget was disposed in Flutter Riverpod](/ru/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) представляет собой реактивный аналог: сбой, который вы получаете, когда пропускаете эту защиту, как на стороне виджета, так и на стороне provider.
- [Как безопасно использовать BuildContext после await во Flutter](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) обеспечивает ту же защиту для `context.mounted` на стороне виджета.
- [Как показывать состояния загрузки и ошибки с AsyncValue во Flutter Riverpod](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) показывает шаблон `AsyncNotifier` плюс `AsyncValue.guard`, который эта защита оберегает.
- [Миграция с FutureBuilder на Riverpod AsyncNotifier во Flutter](/ru/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) переносит асинхронную работу в provider, где доступен `ref.mounted`.
- [Provider vs Riverpod vs Bloc для управления состоянием во Flutter в 2026 году](/ru/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) объясняет, почему принадлежащий Notifier жизненный цикл является современным стандартом.

## Источники

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- вводит `Ref.mounted`, шаблон `if (!ref.mounted) return;` и изменение жизненного цикла с приостановкой слушателей при пересборке.
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- о времени жизни `Ref` provider по сравнению с `WidgetRef`.
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- использование `ref` в notifier после асинхронного разрыва и исправление 3.0.
- [rrousselGit/riverpod discussion 4293](https://github.com/rrousselGit/riverpod/discussions/4293) -- почему provider с `autoDispose` уничтожаются после первого `await` при чтении через `.future`.
- [DCM use-ref-and-state-synchronously rule](https://dcm.dev/docs/rules/riverpod/use-ref-and-state-synchronously/) -- линт, обеспечивающий проверку mounted после асинхронного разрыва.
- [How to Check if an AsyncNotifier is Mounted with Riverpod, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- старый миксин из 2.x и замена `ref.mounted` из 3.0.
</content>
