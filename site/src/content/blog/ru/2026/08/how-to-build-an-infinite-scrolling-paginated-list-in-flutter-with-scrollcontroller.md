---
title: "Как построить список с бесконечной прокруткой и пагинацией во Flutter с помощью ScrollController"
description: "Присоедините ScrollController к ListView.builder, запрашивайте следующую страницу, когда position.extentAfter опускается ниже порога предзагрузки, и защитите запрос флагами isLoading, hasMore и error. Полная реализация плюс ловушка слишком короткой первой страницы."
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "listview"
  - "scrollcontroller"
  - "pagination"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller"
translatedBy: "claude"
translationDate: 2026-08-04
---

Чтобы построить список с бесконечной прокруткой во Flutter, присоедините `ScrollController` к `ListView.builder`, слушайте изменения прокрутки и запрашивайте следующую страницу, когда `position.extentAfter` опускается ниже порога предзагрузки в несколько сотен пикселей. Сам слушатель обязан быть идемпотентным: он срабатывает на каждом кадре прокрутки, поэтому фактическая загрузка должна стоять за защитой из `isLoading`/`hasMore`/`error`, иначе за один бросок пальца вы отправите десяток одинаковых запросов. В этой статье всё собирается на Flutter 3.44.8 (Dart 3.12.2), а затем разбираются два сценария отказа, которые доходят до продакшена: первая страница, слишком короткая для прокрутки, и цикл повторов, который добивает недоступный API.

## Почему `pixels >= maxScrollExtent` -- неправильный триггер

Почти любое руководство начинается отсюда:

```dart
// Flutter 3.44.8, Dart 3.12.2 -- do not ship this
_controller.addListener(() {
  if (_controller.position.pixels >= _controller.position.maxScrollExtent) {
    _loadMore();
  }
});
```

Здесь неверны три вещи.

Во-первых, `ScrollController` уведомляет своих слушателей при каждом изменении позиции прокрутки, то есть во время броска -- один раз за кадр при 60Гц или 120Гц. Если `_loadMore()` -- это незащищённый `await api.fetch(...)`, условие остаётся истинным всё время, пока список прижат к низу, и вы отправляете новый запрос каждый кадр, пока не придёт первый ответ. На устройстве со 120Гц и задержкой в 300мс это примерно 36 дублирующих запросов.

Во-вторых, `maxScrollExtent` -- это ровно самый низ. Ждать его означает, что контент у пользователя закончился раньше, чем вы начали просить ещё, и он смотрит на пустое место всё время сетевого обмена. Viewport во Flutter строит `cacheExtent`, равный `RenderAbstractViewport.defaultCacheExtent`, то есть `250.0` логических пикселей за видимой границей. Срабатывание, пока в этой полосе ещё есть контент, накладывает загрузку на прокрутку, а не тянет её следом.

В-третьих, к `ScrollController.position` небезопасно обращаться без проверок. Геттер стоит за двумя проверками:

```dart
ScrollPosition get position {
  assert(_positions.isNotEmpty, 'ScrollController not attached to any scroll views.');
  assert(_positions.length == 1, 'ScrollController attached to multiple scroll views.');
  return _positions.single;
}
```

Обе срабатывают в отладочных сборках, и обе достижимы из обычного кода, как показано в разделе про ловушки ниже.

Исправление первых двух пунктов -- срабатывать по `extentAfter`, который документация `ScrollPosition` определяет как количество контента, условно расположенного ниже viewport. Когда `extentAfter` равен 400, у пользователя ещё остаётся 400 логических пикселей уже построенных строк, и этого разбега обычно хватает, чтобы полностью скрыть загрузку.

## Сборка в четыре шага

Весь шаблон -- это четыре подвижные части. Всё остальное относится к отображению.

1. **Храните состояние пагинации в `State`, а не в билдере.** Вам нужны накопленный `List<T>`, курсор или номер страницы для следующего запроса и три флага: `_isLoading`, `_hasMore` и `_error`. Именно эти три флага делают безопасным вызов слушателя прокрутки на каждом кадре.
2. **Присоедините `ScrollController` в `initState` и отсоедините в `dispose`.** Вызовите `removeListener` до `dispose()` у контроллера, а первую страницу запустите из `initState`, чтобы на первом кадре список никогда не оказался пустым без индикатора загрузки.
3. **Срабатывайте по `extentAfter`, а не по `pixels`.** В слушателе выходите сразу, если у контроллера нет клиентов, если загрузка уже идёт, если сервер сообщил, что страниц больше нет, или если прошлая попытка провалилась. Только после этого сравнивайте `extentAfter` с вашим порогом предзагрузки.
4. **Рисуйте одну дополнительную строку под хвостовое состояние.** Задайте `itemCount` как `items.length + 1`, пока есть что догружать или есть ошибка для показа, и пусть `itemBuilder` возвращает для этого последнего индекса индикатор загрузки, строку повтора или ничего. Именно это превращает состояние загрузки в то, что пользователь видит и на что может отреагировать.

## Полная реализация

```dart
// Flutter 3.44.8, Dart 3.12.2
class FeedPage extends StatefulWidget {
  const FeedPage({super.key});

  @override
  State<FeedPage> createState() => _FeedPageState();
}

class _FeedPageState extends State<FeedPage> {
  // Default viewport cacheExtent is 250.0 px, so 400 leaves runway.
  static const double _prefetchExtent = 400;
  static const int _pageSize = 20;

  final ScrollController _controller = ScrollController();
  final List<Post> _items = [];

  String? _cursor;
  bool _isLoading = false;
  bool _hasMore = true;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onScroll);
    _loadMore();
  }

  @override
  void dispose() {
    _controller.removeListener(_onScroll);
    _controller.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_controller.hasClients) return;
    if (_isLoading || !_hasMore || _error != null) return;
    if (_controller.position.extentAfter > _prefetchExtent) return;
    _loadMore();
  }

  Future<void> _loadMore() async {
    if (_isLoading || !_hasMore) return;

    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final page = await api.fetchFeed(after: _cursor, limit: _pageSize);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _hasMore = page.nextCursor != null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      _isLoading = false;
      if (mounted) setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool showTail = _hasMore || _error != null;

    return ListView.builder(
      controller: _controller,
      itemCount: _items.length + (showTail ? 1 : 0),
      itemBuilder: (context, index) {
        if (index < _items.length) {
          return PostTile(post: _items[index]);
        }
        if (_error != null) {
          return _RetryTile(error: _error!, onRetry: _retry);
        }
        return const Padding(
          padding: EdgeInsets.all(16),
          child: Center(child: CircularProgressIndicator()),
        );
      },
    );
  }

  void _retry() {
    setState(() => _error = null);
    _loadMore();
  }
}
```

Обратите внимание на разделение между `_onScroll` и `_loadMore`. `_onScroll` отказывается работать, когда `_error != null`; `_loadMore` -- нет. Эта асимметрия сделана намеренно и именно она обрывает цикл повторов, описанный ниже. Слушатель прокрутки никогда не повторит упавшую страницу автоматически, а кнопка повтора может, потому что сначала сбрасывает `_error`.

Блок `finally` присваивает `_isLoading = false` обычным присваиванием до проверки `mounted`. Если положить присваивание внутрь `setState`, который выполняется только у смонтированного виджета, то размонтирование во время запроса оставит флаг залипшим в true; для уничтоженного виджета это безвредно, но усложняет рассуждения о конечном автомате, когда эта же логика контроллера позже переедет в notifier Riverpod.

## Короткая первая страница, которая никогда не прокручивается

Это тот баг, который чаще всего доезжает до продакшена, потому что проявляется только на высоких экранах. Если первая страница вернула 20 строк, а в viewport помещается 30, то `maxScrollExtent` равен `0.0`, прокрутка невозможна, `ScrollController` никогда не уведомляет, и список навсегда остаётся с 20 элементами. На телефоне в портретной ориентации всё идеально, а на планшете, на десктопе и в вебе с развёрнутым окном выглядит сломанным.

`ScrollController` здесь не поможет, потому что прокрутки не было. Самое дешёвое решение -- перепроверить после кадра, который разложил новые строки:

```dart
// Flutter 3.44.8: run after layout so maxScrollExtent is real.
void _fillViewportIfNeeded() {
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted || !_controller.hasClients) return;
    if (_error != null || !_hasMore) return;
    if (_controller.position.maxScrollExtent == 0) _loadMore();
  });
}
```

Вызывайте это в конце ветки успеха в `_loadMore`. Процесс завершается: каждый проход либо делает контент выше viewport (тогда `maxScrollExtent > 0`), либо исчерпывает ленту (тогда `_hasMore` становится false).

Более полное решение -- `ScrollMetricsNotification`, которое Flutter отправляет, когда `ScrollMetrics` прокручиваемой области изменились без всякой прокрутки, в том числе когда контент вырос или уменьшился и когда родительское окно изменило размер. Обёртка списка в него закрывает случай планшета, случай изменения размера окна на десктопе и случай, когда экранная клавиатура закрывается и viewport внезапно становится выше:

```dart
// Flutter 3.44.8, Dart 3.12.2
NotificationListener<ScrollMetricsNotification>(
  onNotification: (notification) {
    if (notification.metrics.maxScrollExtent == 0 && _error == null) {
      _loadMore();
    }
    return false; // let it keep bubbling
  },
  child: ListView.builder(/* ... */),
)
```

Возвращайте `false` из `onNotification`. Возврат `true` обрывает подъём уведомления по дереву, что тихо ломает любого предка, который на него рассчитывает, например `Scrollbar` или `RefreshIndicator`.

## Цикл повторов, который добивает недоступный API

Допустим, защита в `_onScroll` была бы только `if (_isLoading || !_hasMore) return;`. Пользователь внизу, запрос падает, `_isLoading` становится false, `_hasMore` всё ещё true, а позиция не сдвинулась. Следующее уведомление о прокрутке, которое приходит при малейшем движении пальца, снова вызывает `_loadMore`. Каждый отказ немедленно порождает ещё один запрос, поэтому обрыв сети превращается в лавину запросов, которая не даёт радиомодулю заснуть и сажает батарею.

Добавление `_error != null` в защиту прокрутки превращает отказ в терминальное состояние, которое снимает только явное действие пользователя. Если нужно автоматическое восстановление, ставьте его за backoff, а не за слушатель прокрутки, и ограничьте число попыток. Общая форма этого, включая то, какие исключения стоит повторять, разобрана в статье [как аккуратно обрабатывать сетевые ошибки в приложении Flutter](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/).

## Ловушки, на которые вы наступите

1. **`ScrollController not attached to any scroll views.`** Чтение `.position` до первой раскладки или после того, как `ListView` уже исчез, роняет эту проверку. Легко наступить из post-frame колбэка, пережившего `Navigator.pop`. Защищайте каждое обращение через `hasClients`, который есть не что иное, как `_positions.isNotEmpty`.
2. **`ScrollController attached to multiple scroll views.`** Контроллер может сообщить позицию, только если его использует ровно одна прокручиваемая область. Передача одного и того же `_controller` в два `ListView` внутри `TabBarView` -- классический способ сюда попасть. Каждой вкладке нужен свой контроллер и своё состояние пагинации.
3. **Пагинация по offset уплывает в живой ленте.** Если сервер вставит строку, пока пользователь находится между страницей 2 и 3, `?page=3&size=20` вернёт окно, перекрывающееся со страницей 2, и пользователь увидит дубль и пропустит один элемент. У курсорной пагинации такого сценария отказа нет, поэтому пример выше протаскивает `nextCursor`, а не индекс страницы. Серверная половина, вместе с SQL и нужным индексом, разобрана в статье [keyset-пагинация (по курсору) в EF Core 11](/ru/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/).
4. **`setState` после `dispose`.** Каждый `await` в `_loadMore` -- это точка, где пользователь может нажать назад. Строка `if (!mounted) return;` после каждого await не опциональна; без неё вы получите `setState() called after dispose()`. Полное правило, включая то, почему `mounted` надо перепроверять после каждого разрыва, а не один раз в начале, изложено в статье [защита setState проверкой mounted после асинхронного разрыва](/ru/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/).
5. **Контроллер -- это ваш ресурс, который надо освобождать.** `ScrollController` наследуется от `ChangeNotifier`; если создавший его `State` его не освободит, замыкание слушателя удержит `State` и всё, что тот захватил. Это тот же класс утечки памяти, что и неосвобождённый `TextEditingController` или `AnimationController`, разобранный в статье [как освобождать контроллеры во Flutter, чтобы избежать утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
6. **`shrinkWrap: true` уничтожает весь смысл.** Список с shrink wrap строит всех детей на первом кадре, чтобы себя измерить, поэтому бесконечный список превращается в неограниченно растущую стоимость первого кадра. Если вы взялись за него, чтобы заглушить ошибку о неограниченной высоте, правильные альтернативы разобраны в статье [shrinkWrap против Expanded против слайверов для длинных списков](/ru/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

## Когда вместо контроллера брать `NotificationListener`

`ScrollController` -- не единственный способ читать метрики прокрутки. `NotificationListener<ScrollNotification>` получает те же числа через `notification.metrics`, вообще не владея контроллером:

```dart
// Flutter 3.44.8, Dart 3.12.2
NotificationListener<ScrollEndNotification>(
  onNotification: (notification) {
    if (notification.metrics.extentAfter < 400) _loadMore();
    return false;
  },
  child: ListView.builder(/* ... */),
)
```

Предпочитайте этот вариант, когда прокручиваемая область не ваша: внутри `NestedScrollView`, под `PrimaryScrollController`, или когда список -- это `CustomScrollView` с несколькими секциями слайверов и один контроллер не даёт понять, какую из них вы имели в виду. `ScrollEndNotification` к тому же срабатывает гораздо реже, чем слушатель контроллера, что снимает вопрос стоимости на кадр, но ценой отсутствия предзагрузки в середине броска.

Контроллер лучше, когда прокруткой надо ещё и *управлять*: `jumpTo`, `animateTo`, восстановление смещения или прокрутка к только что вставленному элементу. А если ваш список делит viewport с другим содержимым, слайверные эквиваленты применяются без изменений; логика пагинации та же, меняется только обёртка-виджет, как в статье [как смешать ListView и GridView в одной прокрутке с помощью слайверов](/ru/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

## Стоит ли просто взять пакет

`infinite_scroll_pagination` 5.1.1 упаковывает этот конечный автомат в `PagingController` вместе с `PagedListView` и `PagingListener` и берёт на себя хвостовые состояния, случай короткой первой страницы и интеграцию с pull to refresh. Это разумная зависимость для приложения со множеством постраничных экранов, ведь альтернатива -- скопировать приведённый выше `State` пять раз.

Пишите вручную, когда у вас один-два постраничных списка, когда состояние пагинации уже живёт в Riverpod или Bloc (тогда контроллер остаётся только триггером, а собственный контроллер пакета лишний), или когда контракт пагинации вашего API настолько необычен, что вы будете бороться с абстракцией. Если вы подключаете это к Riverpod, ветки загрузки и ошибки чисто ложатся на `AsyncValue`, что разобрано в статье [как показывать состояния загрузки и ошибки через AsyncValue во Flutter Riverpod](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Источники

- [ScrollPosition class](https://api.flutter.dev/flutter/widgets/ScrollPosition-class.html), документация API Flutter (`extentAfter`, `maxScrollExtent`, `atEdge`)
- [ScrollController class](https://api.flutter.dev/flutter/widgets/ScrollController-class.html), документация API Flutter (`hasClients`, `position`, `keepScrollOffset`)
- [ScrollMetricsNotification class](https://api.flutter.dev/flutter/widgets/ScrollMetricsNotification-class.html), документация API Flutter
- [RenderAbstractViewport.defaultCacheExtent](https://api.flutter.dev/flutter/rendering/RenderAbstractViewport/defaultCacheExtent-constant.html), документация API Flutter
- [Примечания к выпуску Flutter 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0), документация Flutter
- [infinite_scroll_pagination на pub.dev](https://pub.dev/packages/infinite_scroll_pagination)
