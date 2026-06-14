---
title: "Решение: Bad state: Cannot use \"ref\" after the widget was disposed во Flutter Riverpod"
description: "Этот сбой означает, что WidgetRef использовали после того, как его виджет покинул дерево, обычно в асинхронном колбэке. Прочитайте всё нужное до await и защитите проверкой mounted."
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ru"
translationOf: "2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-06-14
---

Ваш код обратился к `WidgetRef` из Riverpod после того, как владеющий им виджет был уничтожен. Обычный виновник -- асинхронный колбэк (`await`, `Future.then`, `Timer` или слушатель потока), который завершается уже после того, как пользователь покинул экран, и затем вызывает `ref.read`, `ref.watch` или `ref.listen`. Решение в том, чтобы прочитать всё нужное из `ref` до `await`, а любую последующую работу защитить проверкой `if (!mounted) return;`. В этом руководстве используются Flutter 3.44 (стабильная версия, май 2026), Dart 3.x и Riverpod 3.0 (выпущен в сентябре 2025).

`WidgetRef` привязан к времени жизни виджета, из которого он получен. В момент, когда этот виджет удаляется из дерева, ref становится недействительным, и любое дальнейшее использование выбрасывает исключение. Это сделано намеренно: уничтоженный виджет не должен читать или записывать providers, и Riverpod предпочитает падать с шумом, а не молча протекать состоянием в экран, который пользователь уже покинул.

## Ошибка в контексте

Полное сообщение, которое выбрасывает Riverpod, выглядит так:

```
Unhandled Exception: Bad state: Cannot use "ref" after the widget was disposed.
#0      ProviderElementBase._assertNotDisposed (package:flutter_riverpod/...)
#1      ConsumerStatefulElement.read (package:flutter_riverpod/src/consumer.dart)
#2      _CheckoutScreenState._submit.<anonymous closure> (package:my_app/checkout_screen.dart:42)
...
```

Кадр в вашем собственном коде называет строку, которая обратилась к мёртвому ref: вызов `ref.read(...)`, `ref.watch(...)` или `ref.listen(...)`. Этот кадр -- место, где исключение всплывает, но причина, по которой оно сработало, лежит раньше во времени, когда виджет был уничтожен до того, как эта строка выполнилась.

Есть близкий вариант с немного другим существительным:

```
Bad state: Cannot use "ref" after the provider was disposed.
```

Этот приходит от `Ref` внутри `Notifier` или `AsyncNotifier`, а не от `WidgetRef` в виджете. То же семейство, та же первопричина, другой владелец. Версия виджета говорит "widget"; версия provider говорит "provider". Решение немного отличается, и раздел про Notifiers ниже его охватывает.

## Почему так происходит

Есть четыре причины, примерно в порядке частоты.

`WidgetRef` был захвачен в асинхронном колбэке, который пережил виджет. Вы запустили `await`, `Future.then`, `Timer` или `stream.listen`, пока экран был жив, пользователь закрыл маршрут (что уничтожает `ConsumerState` и делает его `ref` недействительным), а затем колбэк завершился и вызвал `ref.read`. Это самая частая причина, потому что она падает только при совпадении тайминга: проходит каждый раз, когда ожидаемая работа быстрая, и падает, когда сеть медленная или пользователь шустрый.

Вы использовали `ref` внутри `dispose()`. `ConsumerState.dispose()`, который вызывает `ref.read` для очистки (отменить подписку, сбросить буфер, уведомить provider), упирается в эту ошибку, потому что к моменту выполнения `dispose` `WidgetRef` уже разобран. Команда Riverpod отслеживает именно эту форму в [issue 4142](https://github.com/rrousselGit/riverpod/issues/4142): виджет всё ещё выглядит смонтированным, но ref элемента уже исчез. Очистка должна происходить через собственный `ref.onDispose` provider, а не через `dispose` виджета.

Вы сохранили `WidgetRef` в долгоживущем объекте. Контроллер, сервис или класс «логики», который удерживает `ref`, полученный в `build`, будет хранить устаревшую ссылку. Когда виджет перестраивается или уходит, эта сохранённая ссылка указывает на уничтоженный элемент. `WidgetRef` -- не долговечный дескриптор; он действителен только для экземпляра виджета, который им владеет.

Provider был уничтожен через асинхронный разрыв внутри Notifier. В `autoDispose`-Notifier вы делаете `await` чего-то, provider теряет своего последнего слушателя (или становится недействительным) во время разрыва, Riverpod его уничтожает, и строка после `await` читает `ref`. Это вариант "after the provider was disposed". Riverpod 3.0 сделал его реже, приостанавливая слушателей при перестроении вместо немедленного удаления, но `autoDispose`-provider, который действительно теряет всех своих наблюдателей в середине await, всё равно уничтожается. Тема обсуждается в [issue 4096 riverpod](https://github.com/rrousselGit/riverpod/issues/4096).

Базовый контракт из примечаний к выпуску Riverpod 3.0: "Refs and Notifiers can no longer be interacted with after they have been disposed". Riverpod 3.0 выбрасывает исключение при любом взаимодействии после уничтожения вместо того, чтобы его терпеть, и поэтому код, который раньше молча падал в 2.x, теперь шумно вылетает. Это фреймворк делает свою работу.

## Минимальное воспроизведение

Этот экран падает, когда вы покидаете его до завершения отправки. Он компилируется и запускается, и проходит каждый раз, когда сеть быстрая.

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

Нажмите "Place order", а затем закройте экран в течение 800 миллисекунд. `ConsumerState` уничтожается, его `ref` становится недействительным, `Future` завершается, и `ref.read(cartProvider.notifier)` выбрасывает исключение. Сбой зависит от тайминга, и именно поэтому он переживает код-ревью и попадает в продакшен.

## Решение, подробно

Решения упорядочены по тому, насколько я их рекомендую. Выберите то, что соответствует вашей причине.

### 1. Читайте до await, остальное защитите через mounted (рекомендуется)

Два правила покрывают почти любой случай на стороне виджета. Во-первых, разрешите всё, что нужно из `ref`, до `await`, пока виджет гарантированно жив. Во-вторых, после `await` проверьте `mounted`, прежде чем трогать дерево, вызывать `setState` или делать любой следующий вызов `ref`.

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

`cart` -- это ссылка на обычный объект (notifier); она не устаревает, когда виджет уничтожается, поэтому вызов `cart.clear()` после await безопасен. Проверка `mounted` не даёт вам также управлять UI (`setState`, `Navigator.push`, вызов `ScaffoldMessenger`) на мёртвом виджете. `mounted` здесь -- стандартный `State.mounted`, который `ConsumerState` предоставляет как любой другой `State`.

Правило то же самое, что исправляет сбои уничтожения контроллеров: после каждого `await` в методе `State` следующая строка, которая трогает `this`, `ref` или дерево, должна предваряться проверкой `mounted`. Линт анализатора Dart `use_build_context_synchronously` ловит версию этой ошибки с `BuildContext`; относитесь к `ref` точно так же. Та же дисциплина появляется в [решении для TextEditingController, использованного после уничтожения](/ru/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/), потому что это тот же класс багов с другим объектом.

### 2. В Notifier проверяйте ref.mounted после асинхронного разрыва

Если сбой -- это вариант "after the provider was disposed", вы находитесь внутри `Notifier` или `AsyncNotifier`, а не виджета. Riverpod 3.0 добавил `Ref.mounted`, эквивалент `BuildContext.mounted` на стороне provider. Прочитайте зависимости до await, а затем поставьте запись состояния в зависимость от `ref.mounted`.

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

До Riverpod 3.0 не было `ref.mounted`, и обычным обходным решением был небольшой mixin, который переключает флаг в `ref.onDispose`. В 3.0 этот mixin можно удалить: `ref.mounted` -- поддерживаемая проверка. Установка `state` на уничтоженном notifier -- это то, что выбрасывает исключение, поэтому защита ставится непосредственно перед присваиванием. Это та же форма, которая держит [состояния загрузки и ошибки с AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) безопасными через асинхронный разрыв.

### 3. Не храните WidgetRef в классе логики

Если сбой не асинхронный, часто это сохранённый ref. `WidgetRef` принадлежит одному виджету и умирает вместе с ним, поэтому контроллер или сервис, который его удерживает, рано или поздно разыменует труп. Перенесите логику в Notifier и позвольте ему использовать всегда живой `Ref` provider.

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

Виджеты затем вызывают `ref.read(sessionProvider.notifier).signOut()` из обработчика событий, и долгая работа живёт за `Ref`, который Riverpod держит живым, пока provider используется. Виджету никогда не нужно переживать собственный `ref`. Перенос владения жизненным циклом из виджетов в Notifiers -- это именно та форма, на которой строится [миграция с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/), и одна из причин, почему [Riverpod -- выбор по умолчанию для управления состоянием в 2026](/ru/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/).

### 4. Никогда не используйте ref внутри dispose() виджета

Очистка, которой нужен provider, не место в `ConsumerState.dispose()`, потому что к этому моменту `WidgetRef` уже недействителен. У неё есть два правильных дома. Если ресурс принадлежит provider, зарегистрируйте очистку через `ref.onDispose` внутри этого provider, где она выполнится, когда provider будет уничтожен:

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

Если вам действительно нужно что-то сделать при разборе виджета, захватите обычный объект (notifier, подписку, значение) в `initState` или `didChangeDependencies` и сохраните его в поле, затем используйте это поле в `dispose()`. Не вызывайте `ref.read` из самого `dispose`.

## Подводные камни и варианты

`Cannot use "ref" after the provider was disposed`. Близнец этой ошибки со стороны Notifier, охваченный решением 2 выше. Если кадр стека находится внутри `Notifier`/`AsyncNotifier`, а не `ConsumerState`, вам нужен `ref.mounted`, а не `State.mounted`. Два сообщения различаются одним словом, и это слово говорит, какую проверку использовать.

`ref.read` в `onPressed` работает, `ref.read` после `await` в том же обработчике -- нет. Синхронная часть обработчика событий выполняется, пока виджет жив, поэтому простой `ref.read` в начале `onPressed` в порядке. Только код после `await` может приземлиться на уничтоженный виджет. Разделительная линия -- первый `await`, а не обработчик.

Сбой случается только иногда. Это сигнатура асинхронной причины, а не нестабильного фреймворка. Быстрый бэкенд его прячет; медленный или шустрый пользователь его обнажают. Воспроизведите его детерминированно, добавив искусственный `Future.delayed` перед вызовом `ref` и закрыв экран во время задержки, ровно как делает воспроизведение выше.

Началось после обновления до Riverpod 3.0. Riverpod 3.0 выбрасывает исключение при взаимодействии после уничтожения там, где 2.x иногда его терпел. Код, который «работал» раньше, уже трогал уничтоженный ref; 3.0 вытащил на свет скрытый баг, а не внёс новый. Примечания к выпуску прямо утверждают, что refs и notifiers больше нельзя использовать после уничтожения. Исправьте доступ, а не откатывайтесь на 2.x, чтобы его скрыть.

`ConsumerWidget` (без состояния), вызывающий это. У `ConsumerWidget` нет `mounted`, потому что у него нет `State`. Если вы захватываете его `ref` в колбэке, который переживает виджет, перейдите на `ConsumerStatefulWidget`, чтобы иметь флаг `mounted` для защиты, или перенесите асинхронную работу в Notifier (решение 3), чтобы виджет никогда не удерживал ref дольше собственной жизни.

`use_build_context_synchronously` не помечает `ref`. У линта анализатора, который ловит `BuildContext`, использованный после await, нет встроенного эквивалента для `WidgetRef`. Статические анализаторы вроде DCM и набор линтов Riverpod 3.0 добавляют для этого правила (использовать ref и state синхронно), и их стоит включить, но из коробки компилятор не предупредит. Относитесь к каждому `ref` после `await` как к подозрительному, так же как вы относитесь к `context`.

Единственная дисциплина, которая устраняет весь этот класс багов: `WidgetRef` действителен только внутри синхронного тела виджета, который им владеет, поэтому читайте всё нужное до любого `await`, защищайте всё последующее через `mounted` (виджеты) или `ref.mounted` (Notifiers) и держите долговечную логику в providers, а не в виджетах, которые приходят и уходят. Встройте это в свой рефлекс для асинхронных обработчиков, и ошибка перестанет появляться. Это тот же рефлекс защиты через `mounted`, который исправляет [ошибку setState или markNeedsBuild, вызванную во время build](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/), а медленный тайминг ответа, который её запускает, обычно прослеживается до того, [как приложение обрабатывает сетевые ошибки](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/).

## Похожие материалы

- [Решение: A TextEditingController was used after being disposed во Flutter](/ru/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) -- тот же сбой после уничтожения для контроллеров, с той же защитой через mounted.
- [Как показывать состояния загрузки и ошибки с AsyncValue во Flutter Riverpod](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) держит асинхронные результаты в состоянии Notifier, вне опасного пути после await.
- [Решение: setState() or markNeedsBuild() called during build во Flutter](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) разделяет дисциплину защиты через mounted для асинхронных колбэков.
- [Как мигрировать приложение Flutter с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) показывает, как перенести логику в Notifiers, владеющие долговечным Ref.
- [Provider vs Riverpod vs Bloc для управления состоянием во Flutter в 2026](/ru/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) объясняет, почему жизненный цикл в руках Notifier -- современный выбор по умолчанию.

## Источники

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- вводит `Ref.mounted` и правило "refs and notifiers can no longer be interacted with after they have been disposed".
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- о времени жизни `WidgetRef` по сравнению с `Ref` provider.
- [rrousselGit/riverpod issue 4142](https://github.com/rrousselGit/riverpod/issues/4142) -- ошибка, выбрасываемая при использовании `ref` в колбэке `dispose` виджета.
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- использование `ref` в Notifier после асинхронного разрыва и решение с приостановкой слушателей в 3.0.
- [Как проверить, смонтирован ли AsyncNotifier, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- паттерн `ref.mounted` в Riverpod 3.0 и устаревший mixin из 2.x.
