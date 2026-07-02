---
title: "Как объединить ListView и GridView в одной прокрутке с помощью sliver-ов во Flutter"
description: "Разместите список и сетку в одной непрерывной прокрутке без вложенных прокручиваемых виджетов. Используйте CustomScrollView со SliverList и SliverGrid и обойдите ловушку shrinkWrap, которая незаметно убивает производительность."
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "slivers"
  - "listview"
lang: "ru"
translationOf: "2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-02
---

Вам нужен экран, где список плавно переходит в сетку (или наоборот) и всё это прокручивается как единое целое. Неверный инстинкт -- сложить `ListView` и `GridView` в `Column` и потянуться за `shrinkWrap: true`, чтобы они уместились. Это компилируется, но при этом строит все элементы заранее и даёт вам две позиции прокрутки, конфликтующие друг с другом. Правильный ответ -- один `CustomScrollView`, секции которого являются sliver-ами: `SliverList` для части-списка, `SliverGrid` для части-сетки, `SliverToBoxAdapter` для любого обычного виджета между ними. Один viewport, одна физика прокрутки, полная ленивость. В этом посте показана рабочая раскладка на Flutter 3.x (проверено на 3.44, Dart 3.x), объясняется, почему наивный вариант медленный, и разбираются детали отступов, паддинга и количества колонок, на которых люди спотыкаются.

## Почему нельзя просто сложить два прокручиваемых виджета

И `ListView`, и `GridView` -- это прокручиваемые viewport-ы. Каждый из них владеет собственной позицией прокрутки и ожидает, что ему передадут ограниченную высоту, чтобы он знал, какой высоты его окно. Поместите два таких в `Column` и вы упрётесь в ту же стену, что описана в [как вложить ListView внутрь Column без ошибки неограниченной высоты](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/): `Column` предлагает каждому дочернему элементу неограниченное вертикальное пространство, а прокручиваемый виджет отказывается раскладываться в бесконечность.

Обычная заплатка -- `shrinkWrap: true` на обоих, обёрнутых в `SingleChildScrollView`:

```dart
// Flutter 3.x (tested 3.44) -- the anti-pattern, do not ship this
SingleChildScrollView(
  child: Column(
    children: [
      ListView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        itemCount: posts.length,
        itemBuilder: (context, i) => PostTile(posts[i]),
      ),
      GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
        ),
        itemCount: photos.length,
        itemBuilder: (context, i) => PhotoTile(photos[i]),
      ),
    ],
  ),
)
```

Это отрисовывается, и для десятка элементов всё нормально. Но `shrinkWrap: true` заставляет каждый прокручиваемый виджет построить и измерить каждого из своих дочерних элементов на первом кадре, чтобы он мог сообщить конечную высоту. Вы выбросили ленивую переработку, которая держит списки Flutter плавными. На ленте из нескольких сотен фотографий это сотни виджетов, построенных до первой отрисовки, -- всплеск, который можно наблюдать на временной шкале (см. [как профилировать подтормаживания в приложении Flutter с помощью DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)). Хуже того, теперь у вас три прокручиваемых виджета (внешний `SingleChildScrollView` плюс два внутренних, которые вам пришлось отключить через `NeverScrollableScrollPhysics`), присутствующих лишь ради того, чтобы один из них мог фактически прокручиваться. Это неправильная форма для этой задачи.

## Что такое sliver, в одном абзаце

Sliver -- это прокручиваемая область, которая напрямую сообщает родительскому viewport-у, какая её часть сейчас видима и сколько нужно отрисовать. Вместо "вот моя полная высота, дайте мне окно" sliver говорит "вы прокручены до смещения X с viewport-ом высотой H, поэтому я разложу ровно те дочерние элементы, которые попадают в этот диапазон". Именно этот протокол делает `SliverList` ленивым: ему никогда не нужно знать свою полную высоту, поэтому нет рукопожатия неограниченной высоты, которое могло бы провалиться, и нет необходимости строить дочерние элементы за пределами экрана. `CustomScrollView` -- это viewport, который размещает список таких sliver-ов и прокручивает их все как одну непрерывную поверхность. Поскольку каждая секция является sliver-ом, они делят единую позицию прокрутки своего родителя, а это именно то поведение, которого вы хотели.

## Рабочая раскладка: SliverList, затем SliverGrid

Вот всё целиком. Шапка, секция-список и секция-сетка в одной прокрутке:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class FeedPage extends StatelessWidget {
  const FeedPage({super.key, required this.posts, required this.photos});

  final List<Post> posts;
  final List<Photo> photos;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: CustomScrollView(
        slivers: [
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Latest posts',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverList.builder(
            itemCount: posts.length,
            itemBuilder: (context, index) => PostTile(posts[index]),
          ),
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Photos',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverGrid.builder(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 1,
            ),
            itemCount: photos.length,
            itemBuilder: (context, index) => PhotoTile(photos[index]),
          ),
        ],
      ),
    );
  }
}
```

Прокрутите это, и список перетекает в сетку как единая поверхность. Обе секции ленивы: строятся только плитки внутри viewport-а (плюс небольшой кеш), сколько бы постов или фотографий у вас ни было. Позиция прокрутки одна, поэтому бросок, начатый в списке, продолжается в сетку без стыка.

Здесь работают три типа sliver-ов, и это те три, которые вы будете использовать почти везде:

1. **`SliverToBoxAdapter`** оборачивает любой обычный блочный виджет (заголовок, баннер, разделитель), чтобы он мог находиться в списке sliver-ов. Он строит своего дочернего элемента жадно, что правильно для одного небольшого виджета, но неправильно для длинного списка, поэтому никогда не помещайте `ListView` или большой `Column` внутрь него. Используйте его для одиночных виджетов между вашими ленивыми секциями.
2. **`SliverList.builder`** -- это ленивый список. Тот же API `itemCount` / `itemBuilder`, что вы знаете по `ListView.builder`, минус viewport, потому что охватывающий `CustomScrollView` теперь и есть viewport.
3. **`SliverGrid.builder`** -- это ленивая сетка. Она принимает `gridDelegate`, который управляет колонками, ровно как `GridView.builder`.

## Управление колонками сетки

`gridDelegate` -- это место, где вы решаете, сколько колонок в сетке и как расставлены плитки. Два делегата покрывают почти все случаи.

`SliverGridDelegateWithFixedCrossAxisCount` фиксирует определённое количество колонок. Используйте его, когда количество является дизайнерским решением ("всегда 3 в ряд"):

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
  crossAxisCount: 3,   // exactly 3 columns
  mainAxisSpacing: 8,  // vertical gap between rows
  crossAxisSpacing: 8, // horizontal gap between columns
  childAspectRatio: 1, // width / height of each tile; 1 = square
),
```

`SliverGridDelegateWithMaxCrossAxisExtent` вместо этого ограничивает ширину каждой плитки и позволяет Flutter вычислить количество колонок из доступной ширины. Это отзывчивый выбор: телефон получает 2 колонки, планшет получает 5, без `LayoutBuilder`:

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
  maxCrossAxisExtent: 180, // each tile is at most 180px wide
  mainAxisSpacing: 8,
  crossAxisSpacing: 8,
  childAspectRatio: 1,
),
```

Самая частая проблема с сеткой -- плитки, которые выглядят растянутыми или сплющенными, и причина почти всегда в `childAspectRatio`. Это ширина, делённая на высоту. Значение по умолчанию -- `1.0` (квадрат). Если ваши плитки-фотографии выше, чем шире, опустите соотношение ниже 1 (например, `0.75` для портретной карточки 3:4); если они шире, поднимите его выше 1. Несоответствие `childAspectRatio` не выбрасывает исключение, оно просто молча искажает каждую плитку, поэтому его стоит задавать осознанно, а не оставлять на значение по умолчанию.

## Добавление паддинга без потери ленивости

Оборачивание sliver-а в обычный виджет `Padding` не работает, потому что `Padding` ожидает блочного дочернего элемента, а не sliver. Sliver-эквивалент -- это `SliverPadding`:

```dart
// Flutter 3.x (tested 3.44)
SliverPadding(
  padding: const EdgeInsets.symmetric(horizontal: 16),
  sliver: SliverGrid.builder(
    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
      crossAxisCount: 3,
      mainAxisSpacing: 8,
      crossAxisSpacing: 8,
    ),
    itemCount: photos.length,
    itemBuilder: (context, index) => PhotoTile(photos[index]),
  ),
)
```

Обратите внимание на параметр `sliver:`, а не `child:`. `SliverPadding` создаёт отступ вокруг sliver-а и остаётся ленивым. Обращайтесь к нему всякий раз, когда секции нужно пространство от краёв экрана; оборачивание всего тела `CustomScrollView` в один большой `Padding` испортило бы вычисление отступов сетки и является неправильным слоем для добавления полей.

## Прокручиваемая шапка, которая сворачивается

Поскольку у вас уже есть `CustomScrollView`, добавление `SliverAppBar`, который раскрывается и сворачивается при прокрутке, практически бесплатно. Это классическая причина, по которой люди вообще переходят на sliver-ы:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(
      title: Text('Explore'),
      floating: true,      // reappears as soon as you scroll up
      expandedHeight: 160,
      flexibleSpace: FlexibleSpaceBar(
        background: ColoredBox(color: Colors.indigo),
      ),
    ),
    SliverList.builder(
      itemCount: posts.length,
      itemBuilder: (context, i) => PostTile(posts[i]),
    ),
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
      ),
      itemCount: photos.length,
      itemBuilder: (context, i) => PhotoTile(photos[i]),
    ),
  ],
)
```

Задайте `pinned: true`, чтобы бар оставался прикреплённым сверху, `floating: true`, чтобы он возвращался при любой прокрутке вверх, и `expandedHeight` вместе с `flexibleSpace`, чтобы получить сворачивание из большого в маленький. Ничего из этого невозможно с обычным `Column` из прокручиваемых виджетов, и это конкретная выгода от перехода на sliver-ы.

## Подводные камни, которые действительно кусаются

**Не вкладывайте прокручиваемый виджет внутрь sliver-а.** Весь смысл -- один viewport. Помещение `ListView` внутрь `SliverToBoxAdapter` снова вводит ошибку неограниченной высоты и вторую позицию прокрутки. Если у вас есть горизонтально прокручиваемый ряд внутри вертикального `CustomScrollView`, это нормально (другая ось, задайте ему фиксированную высоту через `SliverToBoxAdapter`, оборачивающий `SizedBox`), но никогда не вкладывайте прокручиваемый виджет по той же оси.

**Ключи важны, когда элементы переупорядочиваются.** Если элементы списка или сетки могут вставляться, удаляться или переупорядочиваться, дайте каждой плитке `ValueKey`, привязанный к её данным, чтобы Flutter сопоставлял правильное состояние с правильным виджетом при пересборках. Без ключей удалённая строка может оставить своё состояние привязанным к неправильной плитке.

**Следите за случаем пустой секции.** `SliverList` или `SliverGrid` с `itemCount: 0` просто ничего не рисует, что вам и нужно, но если вы также хотите заглушку "пока нет фотографий", используйте `SliverToBoxAdapter` или `SliverFillRemaining`, чтобы показать её, а не пустую сетку.

**`SliverFillRemaining` заполняет оставшийся viewport.** Если список плюс сетка не заполняют экран и вы хотите закрепить подвал или пустое состояние внизу видимой области, `SliverFillRemaining(hasScrollBody: false, child: ...)` берёт ровно оставшуюся высоту. Это sliver-версия `Expanded` для последней секции.

**Группировка sliver-ов вместе.** Если вы строите несколько пар список-и-сетка и хотите рассматривать каждую пару как единое целое (например, чтобы применить один фон), `SliverMainAxisGroup` (Flutter 3.16+) складывает дочерние sliver-ы вдоль оси прокрутки, чтобы они вели себя как один sliver. Для простой пары список-плюс-сетка он редко нужен, но это инструмент, когда у секции есть внутренняя структура.

## Когда обычный GridView или ListView всё же уместен

Sliver-ы -- это ответ, когда вы объединяете секции в одной прокрутке. Они избыточны, когда у вас один список или одна сетка и больше ничего с ними не прокручивается. Одиночный `GridView.builder` внутри тела `Scaffold` уже ленив и уже является viewport-ом; оборачивание его в `CustomScrollView` с одним `SliverGrid` добавляет церемоний без выгоды. Обращайтесь к sliver-ам в тот момент, когда у вас две или больше прокручиваемых секций, сворачивающаяся шапка или шапка, которая должна уходить вместе с содержимым. Для всего остального обычные виджеты подойдут, и если ваша единственная проблема -- это один список, отказывающийся уместиться в `Column`, то четыре решения в [посте о неограниченной высоте](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- более короткая дорога.

Ещё одна привычка, которую стоит сохранить: если какая-либо секция использует `ScrollController` (например, чтобы перейти в объединённом представлении к секции), прикрепляйте его к `CustomScrollView`, а не к отдельным sliver-ам (sliver-ы не принимают контроллер), и [освобождайте его](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) в вашем `State.dispose`, чтобы не допустить утечки. И если плитка внутри сетки когда-либо выходит за пределы своей ячейки, это проявляется как предупреждение [RenderFlex overflowed](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) внутри плитки, никак не связанное с обвязкой sliver-ов и исправляемое на уровне плитки.

## Мысленная модель, которую стоит удержать

`CustomScrollView` -- это один viewport; каждая секция, которую вы в него помещаете, является sliver-ом, и sliver-ы делят эту единую позицию прокрутки, при этом каждый остаётся ленивым. `SliverList` и `SliverGrid` -- это ленивые список и сетка, `SliverToBoxAdapter` -- аварийный люк для одиночных блочных виджетов, `SliverPadding` добавляет поля, а `SliverAppBar` -- сворачивающаяся шапка, которую вы получаете почти бесплатно. Как только вы перестаёте думать "сложить два прокручиваемых виджета" и начинаете думать "одна прокрутка, состоящая из sliver-ов", объединение списка и сетки перестаёт быть борьбой с движком раскладки и становится четырьмя строчками композиции.

## Источники

- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- размещение нескольких sliver-ов в одном viewport-е, включая пример SliverAppBar + SliverList + SliverGrid.
- [SliverGrid class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverGrid-class.html) -- конструкторы builder/count/extent и два делегата сетки.
- [SliverList class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- поведение ленивого списка и заметка о SliverFixedExtentList.
- [Using slivers to achieve fancy scrolling, Flutter docs](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- протокол sliver-ов и как viewport-ы согласовывают отрисовываемый экстент.
