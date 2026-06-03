---
title: "Решение: RenderBox was not laid out в Flutter"
description: "RenderBox was not laid out почти всегда вторичная ошибка. Найдите первое утверждение layout выше, обычно это scrollable с неограниченными ограничениями, и исправьте его."
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderbox"
lang: "ru"
translationOf: "2026/06/fix-renderbox-was-not-laid-out-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-03
---

`RenderBox was not laid out` означает, что Flutter попытался отрисовать или выполнить hit-test для render box, размер которого так и не был вычислен. Это почти всегда производная ошибка: более раннее утверждение layout прервало `performLayout` для части дерева, и это сообщение лишь обломки. Настоящее решение в том, чтобы прокрутить консоль вверх до первой ошибки, которая обычно представляет собой scrollable (`ListView`, `GridView`, `SingleChildScrollView`), получивший неограниченные ограничения по своей оси прокрутки. Ограничьте этот виджет через `Expanded`, фиксированный размер или `shrinkWrap`, и ошибка исчезнет. В этом руководстве используется Flutter 3.44 (стабильный, май 2026) и Dart 3.x.

Срабатывает утверждение `hasSize` в `package:flutter/src/rendering/box.dart`. `RenderBox` получает размер только во время своего прохода `performLayout`. Если layout для этого box ни разу не отработал успешно, запрос `.size` (что делают и отрисовка, и hit-testing) активирует защиту. Поэтому сообщение точное, но само по себе бесполезное: оно называет жертву, а не виновника.

## Ошибка в контексте

Блок в консоли выглядит так. Точное имя виджета и шестнадцатеричные ID меняются, но форма постоянна:

```
======== Exception caught by rendering library =====================
The following assertion was thrown during performLayout():
RenderBox was not laid out: RenderShrinkWrappingViewport#4aefd
  relayoutBoundary=up13 NEEDS-PAINT NEEDS-COMPOSITING-BITS-UPDATE
'package:flutter/src/rendering/box.dart': Failed assertion: line 1966
  pos 12: 'hasSize'

The relevant error-causing widget was:
  ListView  lib/widgets/feed.dart:58
====================================================================
```

Важны две детали. Во-первых, названный render object (`RenderShrinkWrappingViewport`, `RenderPadding`, `RenderRepaintBoundary`, что угодно) говорит, какое поддерево не смогло выполнить layout. Во-вторых, что важнее, это редко единственное исключение. В режиме debug Flutter печатает первый сбой, а затем продолжает попытки рендеринга, что порождает каскад этих утверждений `hasSize`. Сообщение, на которое нужно реагировать, находится наверху каскада, а не там, куда упал ваш взгляд.

## Почему это происходит

`RenderBox` имеет размер только после того, как `performLayout` назначит его. Три ситуации оставляют box без размера:

Box получил ограничения, которые он не может удовлетворить, поэтому его собственный `performLayout` выбросил исключение. Классический случай это scrollable, получивший неограниченное ограничение по своей оси прокрутки. Вертикальному `ListView` нужна ограниченная высота, чтобы знать, сколько viewport рендерить; дайте ему бесконечную высоту, и он выбросит `Vertical viewport was given unbounded height`, layout прервётся, и каждый предок, который затем попытается прочитать свой размер, сообщит `RenderBox was not laid out`.

Родитель отрисовал или выполнил hit-test для ребёнка, не выполнив сначала его layout. Это баг пользовательского `RenderObject`: вы написали render object, чей `paint` читает `child.size`, но чей `performLayout` забыл вызвать `child.layout(...)`. Ребёнок так и не получил размер.

Кто-то прочитал `.size` вне фазы layout. Чтение `context.size` или `renderBox.size` во время `build`, `initState` или синхронного колбэка, до того как первый кадр выполнил layout виджета, активирует то же самое утверждение. Размер попросту ещё не существует.

Объединяющее правило это контракт layout во Flutter: ограничения идут вниз, размеры возвращаются вверх, и размер box действителен только между завершением его `performLayout` и следующим `markNeedsLayout`. Подробнее на официальной странице [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), самом полезном документе для любой ошибки layout во Flutter.

## Минимальное воспроизведение, которое можно вставить в новое приложение

Самый частый триггер на сегодня: `ListView`, помещённый непосредственно внутрь `Column`. `Column` даёт своим детям неограниченную высоту по главной оси, `ListView` хочет ограниченную высоту, и layout падает.

```dart
// Flutter 3.44, Dart 3.x -- throws, layout aborts, "RenderBox was not laid out" follows.
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: FeedScreen()));

class FeedScreen extends StatelessWidget {
  const FeedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          const Text('Latest'),
          // ListView inside a Column: unbounded height on the main axis.
          ListView(
            children: const [
              ListTile(title: Text('One')),
              ListTile(title: Text('Two')),
              ListTile(title: Text('Three')),
            ],
          ),
        ],
      ),
    );
  }
}
```

Запустите это, и первая ошибка в консоли это `Vertical viewport was given unbounded height`. Утверждения `RenderBox was not laid out` под ней это следствие, а не причина. Решение в том, чтобы ограничить `ListView`.

## Решение, подробно

Решения упорядочены по тому, как часто они оказываются верным ответом. Выбирайте исходя из того, что на самом деле нужно box без размера.

### 1. Задайте scrollable ограниченный размер через Expanded (рекомендуется)

Когда scrollable живёт внутри `Column` или `Row` и должен заполнить оставшееся пространство, оберните его в `Expanded`. `Expanded` передаёт ребёнку жёсткое (tight), ограниченное ограничение по главной оси, именно то, что нужно viewport:

```dart
// Flutter 3.44, Dart 3.x -- Expanded gives the ListView a bounded height.
Column(
  children: [
    const Text('Latest'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('One')),
          ListTile(title: Text('Two')),
          ListTile(title: Text('Three')),
        ],
      ),
    ),
  ],
)
```

Это сохраняет `ListView` ленивым: он строит только видимые на экране строки и прокручивает остальное, что и нужно для любого списка, который может расти. Это верное решение для ленты, списка результатов поиска или любой прокручиваемой области с заголовком над ней.

### 2. Используйте shrinkWrap, когда список короткий и должен подстраиваться под содержимое

Если список действительно маленький и конечный (горстка строк настроек, фиксированное меню) и вы хотите, чтобы он занимал только высоту своего содержимого, задайте `shrinkWrap: true`. Это говорит `ListView` измерить своих детей и сообщить их суммарную высоту вместо требования ограниченного viewport:

```dart
// Flutter 3.44, Dart 3.x -- shrinkWrap sizes the list to its children.
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        ListTile(title: Text('Profile')),
        ListTile(title: Text('Notifications')),
        ListTile(title: Text('Privacy')),
      ],
    ),
  ],
)
```

Компромисс реален: `shrinkWrap` выполняет layout всех детей заранее, сводя на нет ленивый рендеринг, который делает `ListView` дешёвым. Используйте его только для коротких ограниченных списков. Для всего, что может вырасти до десятков элементов, вернитесь к решению 1. Добавление `physics: NeverScrollableScrollPhysics()` не даёт внутреннему списку прокручиваться независимо, что обычно и нужно, когда внешний `Column` является поверхностью прокрутки.

### 3. Задайте box явное ограниченное ограничение

Иногда верный ответ это конкретный размер. `SizedBox` с фиксированной высотой или `ConstrainedBox` с максимальной высотой даёт scrollable границу, с которой можно работать:

```dart
// Flutter 3.44, Dart 3.x -- a fixed viewport height for a horizontal carousel.
SizedBox(
  height: 200,
  child: ListView(
    scrollDirection: Axis.horizontal,
    children: const [/* cards */],
  ),
)
```

Горизонтальный `ListView` внутри `Column` это зеркальное отражение воспроизведения: `Column` ограничивает ширину, но оставляет высоту неограниченной, а горизонтальному viewport нужна ограниченная высота. Фиксированная `height` решает это чисто. Используйте `ConstrainedBox(constraints: BoxConstraints(maxHeight: 300))`, когда содержимое может быть короче предела.

### 4. Выполните layout ребёнка прежде, чем читать его размер в пользовательском RenderObject

Если вы написали пользовательский `RenderObject` (или подкласс `RenderBox`), утверждение говорит вам, что `performLayout` обратился к размеру ребёнка до выполнения его layout. Всегда вызывайте `child.layout(...)` перед чтением `child.size`:

```dart
// Flutter 3.44, Dart 3.x -- lay out the child, THEN read its size.
@override
void performLayout() {
  final BoxConstraints childConstraints = constraints.loosen();
  child!.layout(childConstraints, parentUsesSize: true); // must come first
  size = constraints.constrain(child!.size);              // now .size is valid
}
```

Флаг `parentUsesSize: true` обязателен, когда собственный размер родителя зависит от ребёнка. Опустите его, и Flutter может пропустить relayout при изменении ребёнка, что порождает устаревшие layout, выглядящие как эта же ошибка с перерывами. Контракт задокументирован на [странице API RenderBox.size](https://api.flutter.dev/flutter/rendering/RenderBox/size.html): размер действителен только во время и после `performLayout`, а чтение его из родителя требует `parentUsesSize: true` в момент `layout`.

### 5. Отложите чтение размера до момента после первого кадра

Если вам нужен отрисованный размер виджета в Dart (чтобы спозиционировать overlay, задать размер соседу или вернуть измерение обратно в состояние), не читайте `context.size` во время `build`. Render box ещё не прошёл layout. Прочитайте его после кадра:

```dart
// Flutter 3.44, Dart 3.x -- the size exists only after layout has run.
@override
void initState() {
  super.initState();
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    final Size? size = context.size; // valid now: the frame has been laid out
    setState(() => _measuredHeight = size?.height);
  });
}
```

Чтобы измерять во время layout, а не после него, обратитесь к `LayoutBuilder` (который передаёт вам ограничения родителя) или к `RenderObject` с `parentUsesSize: true`, а не к чтению размера после кадра. Подход с чтением после кадра предназначен для случая "мне просто нужны финальные пиксели один раз".

## Подводные камни и похожие ошибки

- `Vertical viewport was given unbounded height` и `Horizontal viewport was given unbounded width` это первичные ошибки, *вызывающие* большинство каскадов `RenderBox was not laid out`. Если вы видите любую из них над утверждением `hasSize`, исправьте её, и остальные исчезнут. Решение это решения 1–3 выше.
- `A RenderFlex overflowed by N pixels` это другой сбой: flex выполнил layout нормально, но его дети превысили доступное пространство. Это рисует полосу, а не прерывает layout. См. [руководство по переполнению RenderFlex](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) для этого случая; это не то же самое, что box без размера.
- `BoxConstraints forces an infinite height`, выбрасываемое `IntrinsicHeight` или `IntrinsicWidth`, обёрнутыми вокруг scrollable. Intrinsic-виджеты делают спекулятивный проход layout, в котором scrollable отказываются участвовать. Уберите `IntrinsicHeight` или ограничьте scrollable напрямую через `SizedBox`.
- `TabBarView`, `PageView` или вложенный `ListView` внутри другого scrollable упирается в ту же стену неограниченных ограничений. Оберните внутренний scrollable в `Expanded` (если внешний это flex) или задайте ему фиксированную высоту, а `shrinkWrap` ставьте только когда внутренний список короткий.
- Чтение `renderBox.size` из `GlobalKey` сразу после `setState` возвращает размер *предыдущего* кадра или выбрасывает исключение, если виджет вообще ещё не прошёл layout. Всегда защищайте эти чтения через `addPostFrameCallback` и проверку `mounted`, та же дисциплина, что предотвращает сбои при disposal, рассмотренные в [руководстве по dispose контроллеров](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
- В режиме release утверждение вырезается компилятором, поэтому вместо красного экрана вы получаете пустую область, виджет нулевого размера или тихо пропущенную отрисовку. Именно поэтому вы исправляете причину в debug, а не проходите мимо предупреждения консоли: симптом меняет форму в release, но баг по-прежнему на месте.

## Как быстро найти настоящего виновника

Поскольку эта ошибка каскадирует, самый быстрый путь это читать консоль сверху вниз и остановиться на первом исключении. Затем сузьте поддерево:

1. Первая ошибка называет виджет и место в исходнике (`lib/widgets/feed.dart:58`). Откройте этот файл и посмотрите, что является родителем названного виджета. Scrollable, чей родитель это `Column`, `Row`, `IntrinsicHeight` или другой scrollable, и есть ваш подозреваемый.
2. Включите `debugPaintSizeEnabled = true;` в `main` (или переключите Debug Paint во Flutter Inspector), чтобы видеть контур каждого box. Box, который ничего не рисует или схлопывается в линию, и есть тот, у которого не получился layout.
3. Откройте Layout Explorer в DevTools и выберите падающий виджет. Его панель ограничений покажет, получил ли он `h=unbounded` или `w=unbounded`, что подтверждает диагноз. Если вы не пользовались DevTools для работы с layout, разбор в [профилировании джанка приложения Flutter с DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) охватывает открытие сессии на реальном устройстве; та же сессия управляет Layout Explorer.

Более глубокий урок в том, что `RenderBox was not laid out` никогда не является самим багом. Это Flutter сообщает, что не смог закончить работу, начатую более ранним виджетом. Приучите себя игнорировать самое громкое сообщение и находить первое, тихое, и эта ошибка перестанет быть загадкой. Держите свои scrollable ограниченными, выполняйте layout детей до их измерения и никогда не читайте размер до кадра, который его создаёт, и утверждение никогда не сработает.

## Связанное

- [Решение: A RenderFlex overflowed by N pixels в Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) это родственная ошибка layout: flex выполнил layout, но его дети не поместились, что является иным режимом сбоя, нежели box без размера.
- [Решение: setState() or markNeedsBuild() called during build в Flutter](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) это другая ошибка типа "я тронул framework в неподходящий момент", и у неё то же решение с post-frame-callback.
- [Как профилировать джанк приложения Flutter с DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) настраивает ту же сессию DevTools, чей Layout Explorer указывает на неограниченное ограничение, стоящее за этой ошибкой.
- [Как делать dispose контроллеров во Flutter, чтобы избежать утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) охватывает дисциплину `mounted` и жизненного цикла, которая сохраняет безопасными чтения размера после кадра.

## Источники

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), каноническое объяснение того, как сочетаются ограничения, размеры и протокол layout.
- [Справочник API RenderBox.size](https://api.flutter.dev/flutter/rendering/RenderBox/size.html), где указано, что размер box действителен только во время и после `performLayout` и требует `parentUsesSize: true` для чтений из родителя.
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors), официальный список, определяющий ошибки неограниченного viewport и переполнения, которые вызывают большинство этих каскадов.
- [flutter/flutter issue #130967](https://github.com/flutter/flutter/issues/130967), показательный отчёт о срабатывании утверждения `hasSize` от shrink-wrapping viewport с неограниченными ограничениями.
