---
title: "Исправление: A RenderViewport expected a child of type RenderSliver but received a child of type RenderBox (Flutter CustomScrollView)"
description: "Список slivers у CustomScrollView принимает только слайверы. Оберните box-виджеты в SliverToBoxAdapter или замените ListView/Padding/Column на SliverList и SliverPadding."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "slivers"
  - "layout"
lang: "ru"
translationOf: "2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview"
translatedBy: "claude"
translationDate: 2026-07-05
---

`A RenderViewport expected a child of type RenderSliver but received a child of type RenderParagraph` (или `RenderFlex`, или `RenderErrorBox`, или любой другой `RenderBox`) означает, что вы поместили обычный виджет прямо в список `slivers` у `CustomScrollView`. Всё в `slivers` должно быть слайвером. Самое быстрое решение -- обернуть проблемный box-виджет в `SliverToBoxAdapter`; более правильное решение для списка -- заменить `ListView` на `SliverList.builder`, а `Padding` на `SliverPadding`. Проверено на Flutter 3.x (3.44), Dart 3.x.

## Ошибка в контексте

Flutter выбрасывает её во время раскладки, ещё до отрисовки чего-либо. Конкретный тип после "received a child of type" меняется в зависимости от того, что вы поместили в список -- `RenderParagraph` для `Text`, `RenderFlex` для `Column` или `Row`, `RenderErrorBox`, когда билдер внутри списка выбросил исключение, -- но форма всегда одна и та же:

```
FlutterError (A RenderViewport expected a child of type RenderSliver but received a
child of type RenderParagraph.
RenderObjects expect specific types of children because they coordinate with their
children during layout and paint. For example, a RenderSliver cannot be the child of
a RenderBox because a RenderSliver does not understand the RenderBox layout protocol.

The RenderViewport that expected a RenderSliver child was created by:
  Viewport ← IgnorePointer ← Semantics ← Listener ← _GestureSemantics ←
    Scrollable ← PrimaryScrollController ← CustomScrollView ← ...

The RenderParagraph that did not match the expected child type was created by:
  Text ← ...)
```

Два блока "created by" -- это полезная часть. Первый называет виджет прокрутки, который ожидал слайвер (почти всегда ваш `CustomScrollView`). Второй называет конкретный виджет, который слайвером не был. Читайте сначала второй блок: он указывает прямо на строку, которую нужно изменить.

## Почему viewport отказывается принимать box-потомка

У Flutter два протокола раскладки, а не один. Обычные виджеты вроде `Container`, `Text`, `Row` и `Column` раскладываются как box'ы: родитель передаёт вниз ограничения по ширине и высоте, потомок возвращает конкретный `Size`, и на этом всё. Их render-объекты -- это подклассы `RenderBox` (`RenderParagraph`, `RenderFlex` и так далее).

Слайверы используют другой, более богатый протокол, созданный для прокрутки. Слайвер не просто сообщает размер. Во время раскладки он получает `SliverConstraints`, описывающий, какая его часть уже прокручена за пределы экрана, сколько места осталось во viewport, смещение прокрутки, направление оси и многое другое. Он возвращает `SliverGeometry`, описывающий, сколько места он отрисовал, сколько занял по оси прокрутки, каков его размер для hit-теста и хочет ли он быть видимым. Именно этот обмен позволяет `SliverAppBar` сжиматься при прокрутке, а `SliverList` строить только те строки, что сейчас на экране. Его render-объекты -- это подклассы `RenderSliver`.

`RenderViewport` -- render-объект, стоящий за `CustomScrollView`, -- говорит со своими потомками только на протоколе слайверов. Он передаёт каждому потомку `SliverConstraints` и ожидает обратно `SliverGeometry`. Если вы дадите ему `RenderBox`, этот box понятия не имеет, что делать с `SliverConstraints`; он не реализует метод, который viewport собирается вызвать. Вместо того чтобы упасть где-то глубоко в раскладке с непонятным null, фреймворк заранее проверяет тип потомка и выбрасывает это утверждение. Сообщение чётко излагает правило: "a RenderSliver cannot be the child of a RenderBox because a RenderSliver does not understand the RenderBox layout protocol", и то же самое верно в обратную сторону, что как раз и есть то несоответствие, с которым вы столкнулись.

Так что это не тонкий баг с ограничениями вроде [RenderBox was not laid out](/ru/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) и не [переполнение RenderFlex](/ru/2026/05/fix-renderflex-overflowed-in-flutter/). Это несоответствие типов: box-виджет стоит там, где место слайверу.

## Минимальный пример воспроизведения

Любой не-слайверный виджет в списке `slivers` вызывает эту ошибку. Вот самая короткая версия -- голый `Text` там, где должен быть слайвер:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Feed extends StatelessWidget {
  const Feed({super.key});

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        const Text('Recent activity'), // RenderParagraph, not a sliver
        SliverList.builder(
          itemCount: 20,
          itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
        ),
      ],
    );
  }
}
```

С `SliverList.builder` всё в порядке. Проблема в `Text`: он становится `RenderParagraph`, viewport ожидал `RenderSliver`, и раскладка выбрасывает исключение. То же самое происходит, если вы поместите в `slivers` `Column`, `Padding`, `Center`, `ListView` или целый пользовательский виджет страницы. Если это не слайвер, viewport его отвергает.

## Решение 1: обернуть один box-виджет в SliverToBoxAdapter

Для одиночного box-виджета -- заголовка, баннера, карточки, ряда кнопок -- оберните его в `SliverToBoxAdapter`. Этот виджет является слайвером, вся задача которого -- разместить одного потомка `RenderBox` и переводить между двумя протоколами: он измеряет box, а затем сообщает viewport подходящий `SliverGeometry`.

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 20,
      itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
    ),
  ],
)
```

Это прямое решение и правильное, когда box-содержимое действительно представляет собой единый кусок фиксированного размера. Это тот слайвер, к которому вы тянетесь первым, когда заголовок, отступ или сводная карточка должны стоять над вашими списками в одном виджете прокрутки.

Единственное, что стоит знать: `SliverToBoxAdapter` строит своего потомка сразу и держит его живым независимо от того, на экране он или нет, потому что у box нет понятия ленивости. Для заголовка это нормально. Для длинного списка это неправильно -- об этом Решение 2.

## Решение 2: использовать SliverList / SliverGrid для списков, а не обёрнутый ListView

Самая частая ошибка -- поместить `ListView` в `slivers`, а затем, когда появляется эта ошибка, обернуть `ListView` в `SliverToBoxAdapter`. Это заглушает утверждение, но форма неправильная. Теперь у вас прокручиваемое внутри прокручиваемого, и внутренний `ListView` получает от адаптера неограниченную высоту -- то же семейство сбоев, что и при [вложении ListView в Column](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/). Даже если вы заставите это работать с `shrinkWrap`, вы выбрасываете ленивое построение: каждая строка строится заранее.

Весь смысл `CustomScrollView` в том, что его секции -- это слайверы, делящие один viewport. Поэтому используйте слайверный список, а не обёрнутый `ListView`:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: Text('Recent activity')),

    // Lazy: only builds rows near the viewport. Direct replacement for ListView.builder.
    SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    ),

    // Grid section in the same scroll view.
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2),
      itemCount: photos.length,
      itemBuilder: (context, i) => Image.network(photos[i]),
    ),
  ],
)
```

`SliverList.builder`, `SliverList.separated`, `SliverFixedExtentList` и `SliverGrid.builder` -- это слайверные эквиваленты билдеров `ListView`/`GridView`. Они сохраняют ленивое построение, которое делает длинные списки дешёвыми, и встают прямо в `slivers`. Если вам нужны список и сетка, текущие в одной непрерывной прокрутке, это подходящая для этого раскладка -- полный шаблон смотрите в [смешивании ListView и GridView с помощью слайверов](/ru/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

## Решение 3: SliverPadding вместо Padding, SliverFillRemaining вместо box

Правило box-против-слайвера ловит и виджеты-обёртки. Если вы обернёте слайвер в `Padding`, чтобы добавить отступ, `Padding` является `RenderBox`, и viewport его отвергнет. Версия, знающая о слайверах, -- это `SliverPadding`, которая добавляет отступ слайверному потомку и сама остаётся слайвером:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    SliverPadding(
      padding: const EdgeInsets.all(16),
      sliver: SliverList.builder(       // note: 'sliver:', not 'child:'
        itemCount: items.length,
        itemBuilder: (context, i) => Text(items[i]),
      ),
    ),
  ],
)
```

Следите за именем параметра: `SliverPadding` принимает `sliver:`, а не `child:`, потому что его потомок сам должен быть слайвером. Та же идея покрывает несколько других частых нужд:

- **Box, который должен заполнить оставшийся viewport** (сообщение о пустом состоянии, центрированное в оставшемся месте): `SliverFillRemaining(child: ...)`.
- **Box, который должен быть ровно в один экран высотой**: `SliverFillViewport`.
- **Закреплённый или плавающий заголовок, сжимающийся при прокрутке**: `SliverAppBar`, который уже является слайвером, так что он идёт в `slivers` напрямую.
- **Группировка нескольких слайверов для применения одного клипа или оформления**: `SliverMainAxisGroup` / `SliverCrossAxisGroup`.

Ментальная модель: для каждого box-виджета, который вы обычно используете, либо оберните его (`SliverToBoxAdapter`, `SliverFillRemaining`), либо найдите его слайверного двойника (`SliverList`, `SliverGrid`, `SliverPadding`, `SliverAppBar`).

## Подводные камни и похожие случаи

**Билдер внутри slivers, который выбрасывает исключение, показывает ту же самую ошибку.** Когда полученный тип -- `RenderErrorBox`, потомком был `ErrorWidget`: что-то внутри `StreamBuilder` или `FutureBuilder`, стоящего в ваших `slivers`, выбросило исключение во время построения, Flutter подставил свой красный box с ошибкой (`RenderBox`), и viewport этот box отверг. Решение состоит из двух частей: сделать так, чтобы билдер возвращал слайвер на каждом пути, и обработать случай ошибки. `StreamBuilder` в `slivers` должен возвращать слайвер из своего `builder`, включая ветки ошибки и загрузки:

```dart
// Flutter 3.x (tested 3.44)
StreamBuilder<List<String>>(
  stream: feed,
  builder: (context, snapshot) {
    if (snapshot.hasError) {
      return const SliverToBoxAdapter(child: Text('Could not load feed'));
    }
    if (!snapshot.hasData) {
      return const SliverToBoxAdapter(child: Center(child: CircularProgressIndicator()));
    }
    final items = snapshot.data!;
    return SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    );
  },
)
```

Если вы вернёте голый `Text` или `CircularProgressIndicator` из любой ветки, вы снова получите исходную ошибку. (Раз уж вы здесь: если `FutureBuilder` перезапускает свой future при каждой перестройке, это отдельный баг, который стоит исправить -- см. [как остановить FutureBuilder от пересоздания своего Future](/ru/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).)

**Обратное несоответствие читается почти так же.** Если вы поместите слайвер туда, где место box'у -- скажем, `SliverList` внутри `Column`, -- вы получите "A RenderObjectWithChildMixin expected a child of type RenderBox but received a child of type RenderSliverList" или "expected a RenderBox but received a RenderSliverPadding". То же правило, обратное направление: слайверы живут только внутри viewport (`CustomScrollView` или области слайверов у `NestedScrollView`), никогда напрямую внутри `Column`, `Center` или `Padding`. Чтобы превратить слайвер обратно во что-то, что примет box-родитель, вы, как правило, этого не делаете: вы перестраиваете так, чтобы слайвер оказался внутри `CustomScrollView`.

**`SliverToBoxAdapter` -- не место, чтобы спрятать длинный список.** Это работает, поэтому соблазнительно, но убивает ленивость: адаптер строит всё своё поддерево потомков немедленно. Обернуть в него `ListView` на 5000 строк (или `Column` из 5000 потомков) означает построить все 5000 на первом кадре, что взвинчивает время раскладки и проявляется как подтормаживание на таймлайне. Используйте его для заголовков и одиночных карточек; используйте `SliverList.builder` для всего, что прокручивается.

**Hot reload иногда не может восстановиться после этого.** Поскольку утверждение срабатывает во время раскладки, hot reload после исправления кода может изредка оставить дерево рендеринга в застрявшем состоянии. Если ошибка сохраняется после того, как вы явно исправили проблемную строку, сделайте hot restart (`R`), а не hot reload (`r`).

## Похожие материалы

- [Как смешать ListView и GridView в одном виджете прокрутки с помощью слайверов](/ru/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- правильная многосекционная раскладка `CustomScrollView`, к которой подталкивает вас эта ошибка.
- [Как вложить ListView внутрь Column без ошибки неограниченной высоты](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- сбой, с которым вы столкнётесь, если "исправите" это, обернув ListView в box.
- [Исправление: RenderBox was not laid out в Flutter](/ru/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) -- другое утверждение времени раскладки, с которым вы встречаетесь при настройке виджетов прокрутки.
- [Исправление: A RenderFlex overflowed в Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) -- проблема с ограничениями в `Row`/`Column`, box-сторонний родственник этой проблемы.

## Источники

- [Класс RenderViewport, справочник API Flutter](https://api.flutter.dev/flutter/rendering/RenderViewport-class.html) -- render-объект, который говорит на протоколе слайверов и отвергает box-потомков.
- [Класс SliverToBoxAdapter, справочник API Flutter](https://api.flutter.dev/flutter/widgets/SliverToBoxAdapter-class.html) -- оборачивание одиночного box-виджета как слайвера.
- [Класс SliverList, справочник API Flutter](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- ленивый слайвер-список и его конструкторы `.builder` / `.separated`.
- [flutter/flutter issue 126064](https://github.com/flutter/flutter/issues/126064) -- вариант с `RenderErrorBox`, где выбрасывающий исключение билдер внутри `slivers` производит это же утверждение.
