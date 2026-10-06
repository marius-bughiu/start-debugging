---
title: "Исправление: BoxConstraints forces an infinite height во Flutter"
description: "Виджет запросил height: double.infinity внутри родителя без ограничения по высоте, например Column или ListView. Используйте Expanded, конечную высоту, LimitedBox или SliverFillRemaining."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
lang: "ru"
translationOf: "2026/10/fix-boxconstraints-forces-an-infinite-height-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-06
---

`BoxConstraints forces an infinite height` означает, что какой-то виджет потребовал высоту ровно `double.infinity` пикселей, а у его родителя не было ограничения по высоте, к которому можно было бы привести этот запрос. Обычные виновники: `SizedBox(height: double.infinity)`, `Container(height: double.infinity)`, `SizedBox.expand` или `BoxConstraints.expand()`, размещённые прямо внутри `Column`, `ListView` или `SingleChildScrollView`. Решение: перестать просить "бесконечность" там, где нет ничего конечного. Используйте `Expanded` внутри `Column`, задайте блоку реальное число, оберните его в `LimitedBox` или перейдите на `SliverFillRemaining`, когда нужно "занять остаток экрана, но при этом прокручиваться". Всё ниже воспроизведено на Flutter 3.44.8 (stable) и Dart 3.12.2.

Путаница в том, что `height: double.infinity` совершенно обычная идиома. В большинстве случаев она работает. Она ломается только тогда, когда ближайший предок, задающий ограничение по высоте, говорит "выбирай любую высоту", а именно так говорят колонки и прокручиваемые области.

## Ошибка в контексте

Это первый блок, который выводит Flutter. Трассировку стека я сократил: она занимает около 100 кадров `RenderProxyBoxMixin.performLayout`:

```
══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═══════════════════════════════
The following assertion was thrown during performLayout():
BoxConstraints forces an infinite height.
These invalid constraints were provided to _RenderColoredBox's layout() function by the following
function, which probably computed the invalid constraints in question:
  RenderConstrainedBox.performLayout (package:flutter/src/rendering/proxy_box.dart:296:14)
The offending constraints were:
  BoxConstraints(0.0<=w<=800.0, h=Infinity)
The relevant error-causing widget was:
  SizedBox
```

Три строки содержат всю нужную информацию:

- **`h=Infinity`** в проблемных ограничениях. Это *жёсткая* бесконечная высота: и минимум, и максимум равны бесконечности. Удовлетворить такое невозможно.
- **`RenderConstrainedBox.performLayout`** это функция, которая их вычислила. `RenderConstrainedBox` является объектом отрисовки за `SizedBox`, `ConstrainedBox` и той частью `Container`, которая отвечает за размеры. Поэтому виновник почти всегда один из этих трёх.
- **"The relevant error-causing widget was"** указывает файл и строку этого виджета. Нажмите на неё в IDE.

Ниже вы увидите каскад утверждений `RenderBox was not laid out`, по одному на каждого предка, плюс одно для `Scaffold`. Это побочные эффекты. Исправьте первую ошибку, и все они исчезнут. Если вы попали сюда из этого каскада, [разбор RenderBox was not laid out](/ru/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) объясняет, почему он нарастает именно так.

Родственное сообщение `BoxConstraints forces an infinite width.` это та же ошибка, повёрнутая на 90 градусов, а `BoxConstraints forces an infinite width and infinite height.` означает обе сразу. Всё в этой статье применимо к ним с заменой ширины и высоты.

## Почему это происходит

Раскладка во Flutter сводится к одному правилу: ограничения идут вниз, размеры идут вверх, позицию задаёт родитель. Каждый родитель передаёт потомку `BoxConstraints` с минимумом и максимумом для ширины и высоты.

Когда вы пишете `SizedBox(height: double.infinity)`, вы не задаёте высоту, равную бесконечности. Вы запрашиваете жёсткие ограничения `minHeight: infinity, maxHeight: infinity`, а `RenderConstrainedBox` затем согласует этот запрос с тем, что разрешил его собственный родитель, используя `BoxConstraints.enforce`:

```dart
// Flutter 3.44.8, package:flutter/src/rendering/box.dart (simplified)
BoxConstraints enforce(BoxConstraints constraints) {
  return BoxConstraints(
    minHeight: clampDouble(minHeight, constraints.minHeight, constraints.maxHeight),
    maxHeight: clampDouble(maxHeight, constraints.minHeight, constraints.maxHeight),
    // width is clamped the same way
  );
}
```

Именно это ограничение объясняет, почему идиома обычно работает. Внутри тела `Scaffold` родитель говорит `0 <= h <= 600`, поэтому бесконечность приводится к 600, и блок заполняет экран. Но `Column` даёт каждому потомку без flex по главной оси `0 <= h <= Infinity`, и вертикальный `ListView` или `SingleChildScrollView` делает то же самое. Приведение бесконечности к максимуму, равному бесконечности, оставляет бесконечность. Полученные ограничения передаются в `layout()` потомка, который запускает `debugAssertIsValid(isAppliedConstraint: true)`, видит бесконечный минимум и выбрасывает исключение.

Запомните правило: **`double.infinity` означает "настолько большой, насколько позволяет родитель". Это безопасно только тогда, когда родитель разрешает что-то конечное.**

## Минимальный пример, который можно вставить в новое приложение

Каждое из этих трёх тел выбрасывает ошибку на Flutter 3.44.8. Я запускал их как виджет-тесты внутри `MaterialApp(home: Scaffold(body: ...))`:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

// 1. A Column gives children unbounded height.
const columnRepro = Column(
  children: [
    Text('Header'),
    SizedBox(
      height: double.infinity,
      child: ColoredBox(color: Colors.red),
    ),
  ],
);

// 2. A vertical ListView gives children unbounded height.
final listRepro = ListView(
  children: [
    Container(height: double.infinity, color: Colors.red),
  ],
);

// 3. SizedBox.expand and BoxConstraints.expand() are the same request in disguise.
const scrollRepro = SingleChildScrollView(
  child: Column(
    children: [
      SizedBox.expand(child: ColoredBox(color: Colors.red)),
    ],
  ),
);
```

Проблемные ограничения немного отличаются: пример с `Column` сообщает `BoxConstraints(0.0<=w<=800.0, h=Infinity)`, потому что поперечная ось колонки нежёсткая, а примеры с `ListView` и `SizedBox.expand` сообщают `BoxConstraints(w=800.0, h=Infinity)`. Ошибка та же, исправление то же.

Одна деталь, которая сбивает с толку: если у `SizedBox` **нет потомка**, этого сообщения вы не получите вовсе. Вы получите `RenderConstrainedBox object was given an infinite size during layout`, потому что вызывать `layout()` не у кого, и блок пытается принять бесконечный размер сам. Причина та же, формулировка другая.

## Исправление подробно

Выбирайте исправление, спросив себя, чего именно вы хотели добиться бесконечной высотой.

### 1. "Заполнить оставшееся место в Column": используйте Expanded

Это самое частое намерение. Внутри `Column` способ сказать "займи всё, что осталось" это flex-потомок, а не бесконечный размер:

```dart
// Flutter 3.44.8, Dart 3.12.2
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Container(color: Colors.red), // no height at all
    ),
  ],
)
```

В моём тесте на поверхности 800x600 красный блок получил `Size(800.0, 580.0)`: полная высота минус строка заголовка. `Expanded` работает, потому что `Column` раскладывает flex-потомков последними, когда уже знает, сколько места заняли потомки с фиксированным размером, и передаёт им жёсткую конечную высоту.

Это работает только тогда, когда у самой `Column` ограниченная высота. Если эта `Column` находится внутри `SingleChildScrollView`, `Expanded` заменит эту ошибку на `RenderFlex children have non-zero flex but incoming height constraints are unbounded`. Это та же проблема уровнем выше, и с ней справляются исправления 3 и 4.

### 2. "Мне просто нужно, чтобы блок был высоким": задайте конечное число

Если блок находится внутри прокручиваемой области, он будет прокручиваться, поэтому "заполнить экран" обычно не то, что вы имели в виду. Задайте реальную высоту или вычислите её из размера экрана:

```dart
// Flutter 3.44.8, Dart 3.12.2
Builder(
  builder: (context) => ListView(
    children: [
      SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.5,
        child: const ColoredBox(color: Colors.red),
      ),
      // ... more children
    ],
  ),
)
```

Это дало блок `Size(800.0, 300.0)` на поверхности высотой 600 пикселей. Предпочитайте `MediaQuery.sizeOf(context)` вместо `MediaQuery.of(context).size`: он перестраивает виджет только при изменении размера, а не при каждом изменении `MediaQuery`, например при появлении клавиатуры.

Если виджет переиспользуемый и вы не знаете, попадёт ли он в ограниченного или неограниченного родителя, используйте `LimitedBox`. Он ничего не делает, когда родитель ограничен, и задаёт предел максимуму, когда нет:

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: [
    LimitedBox(
      maxHeight: 200,
      child: Container(height: double.infinity, color: Colors.red),
    ),
  ],
)
```

Внутри `ListView` этот контейнер был разложен как `Size(800.0, 200.0)` без ошибки. Поместите тот же виджет в ограниченного родителя, и он заполнит родителя. Именно этот приём рекомендует официальное руководство "Understanding constraints" для такой ситуации.

### 3. "Заполнить экран, но прокручиваться, если содержимое выше": SliverFillRemaining

Это случай формы входа: колонка должна тянуться до низа области просмотра, чтобы кнопка находилась внизу, но прокручиваться на маленьких телефонах или при открытой клавиатуре. `SliverFillRemaining` с `hasScrollBody: false` создан именно для этого:

```dart
// Flutter 3.44.8, Dart 3.12.2
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: SizedBox(height: 100)),
    SliverFillRemaining(
      hasScrollBody: false,
      child: Container(color: Colors.red),
    ),
  ],
)
```

Красный блок получил `Size(800.0, 500.0)`: ровно область просмотра минус заголовок в 100 пикселей. `hasScrollBody: false` сообщает слайверу, что его потомок сам не является прокручиваемым, поэтому он задаёт потомку размер не меньше оставшегося пространства, а если собственная высота потомка больше, то её. Если потомок это `ListView` или другая прокручиваемая область, оставьте `hasScrollBody` в значении по умолчанию `true`.

### 4. То же самое без слайверов: LayoutBuilder плюс ConstrainedBox

Если вы не готовы переводить экран на `CustomScrollView`, документация `SingleChildScrollView` описывает приём, который один раз считывает высоту области просмотра и превращает её в *минимум* вместо жёсткого бесконечного размера:

```dart
// Flutter 3.44.8, Dart 3.12.2
LayoutBuilder(
  builder: (context, viewport) => SingleChildScrollView(
    child: ConstrainedBox(
      constraints: BoxConstraints(minHeight: viewport.maxHeight),
      child: IntrinsicHeight(
        child: Column(
          children: [
            const Text('top'),
            Expanded(child: Container(color: Colors.red)),
            const Text('bottom'),
          ],
        ),
      ),
    ),
  ),
)
```

`LayoutBuilder` находится снаружи прокручиваемой области, поэтому `viewport.maxHeight` конечен (здесь 600). `ConstrainedBox` задаёт колонке нижнюю границу 600, но не верхнюю, а `IntrinsicHeight` даёт `Column` ограниченную высоту, так что `Expanded` допустим. Мой тест дал красный блок высотой 560 пикселей между двумя строками текста. `IntrinsicHeight` стоит дополнительного прохода раскладки по своему поддереву: для формы это нормально, для длинного списка нет. Для длинного содержимого используйте исправление 3 или варианты из статьи [shrinkWrap vs Expanded vs slivers](/ru/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

### 5. "Совпасть по высоте со строкой": IntrinsicHeight плюс stretch

Очень частый источник этой ошибки внутри списков: цветная боковая полоса или вертикальный разделитель, который должен быть такой же высоты, как сосед:

```dart
// Flutter 3.44.8, Dart 3.12.2
// Throws: BoxConstraints(w=4.0, h=Infinity)
ListView(
  children: const [
    Row(
      children: [
        SizedBox(width: 4, height: double.infinity, child: ColoredBox(color: Colors.blue)),
        Text('item'),
      ],
    ),
  ],
)
```

`Row` передаёт полосе своё собственное неограниченное вертикальное ограничение. Попросите строку сначала измерить самого высокого потомка, а затем растянуть всех под него:

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: const [
    IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(width: 4, child: ColoredBox(color: Colors.blue)),
          Text('item\nline2'),
        ],
      ),
    ),
  ],
)
```

У полосы вообще нет `height`: `CrossAxisAlignment.stretch` даёт ей жёсткую высоту, равную высоте строки, а `IntrinsicHeight` делает эту высоту конечной. Один `IntrinsicHeight` на элемент списка обходится достаточно дёшево для типичных списков.

## Подводные камни и похожие ошибки

- **`double.maxFinite` не является исправлением.** Замена `double.infinity` на `double.maxFinite` заглушает утверждение, но в моём тесте блок был разложен как `Size(0.0, 1.7976931348623157e+308)`. Вы построили блок выше вселенной, и всё под ним недостижимо. Если вы встретите такое "исправление" в код-ревью, это та же ошибка, только спрятанная.
- **Проверка работает только в режиме отладки.** `debugAssertIsValid` выполняется внутри `assert`, поэтому релизные сборки её пропускают, и вместо красного экрана вы получаете серую область или пропавшее содержимое. Всегда воспроизводите ошибки раскладки в режиме отладки.
- **Горизонтальный `ListView` в порядке.** `ListView(scrollDirection: Axis.horizontal)` даёт потомкам ограниченную *высоту* (свою собственную), поэтому `height: double.infinity` внутри него приводится корректно: мой тест дал `Size(100.0, 600.0)`. В таком списке ломает именно `width: double.infinity`.
- **`Vertical viewport was given unbounded height`** это обратная ситуация: прокручиваемая область помещена внутрь `Column`, а не бесконечный блок внутрь прокручиваемой области. Исправления пересекаются, и [руководство по ListView внутри Column](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) разбирает этот случай подробно.
- **`TextField` внутри `Row`** на Flutter 3.44.8 даёт в качестве первой ошибки `An InputDecorator, which is typically created by a TextField, cannot have an unbounded width`, а не сообщение `BoxConstraints`. Оберните поле в `Expanded` или в `SizedBox` с фиксированной шириной.
- **`IntrinsicHeight` вокруг `ListView`** не выбрасывает эту ошибку. Он выбрасывает `RenderViewport does not support returning intrinsic dimensions`, потому что ленивая область просмотра отказывается измерять всех своих потомков. Никогда не оборачивайте прокручиваемую область в intrinsic-виджет.
- **`UnconstrainedBox`** полностью снимает ограничения родителя, поэтому любой бесконечный потомок внутри него выбрасывает эту ошибку даже на экране с ограниченными размерами. Поставьте между ними `LimitedBox` или уберите `UnconstrainedBox`.
- **`Column`, которая переполняется вместо исключения,** это другая проблема: содержимое конечно, но слишком высокое. Смотрите [руководство по RenderFlex overflowed](/ru/2026/05/fix-renderflex-overflowed-in-flutter/).

## Поиск виновника в большом дереве виджетов

Когда "relevant error-causing widget" указывает на общий компонент, откройте Flutter DevTools, выберите виджет в Widget Inspector и посмотрите на ограничения в Layout Explorer. Поднимайтесь по дереву, пока не найдёте первого предка, у которого ограничение по высоте равно `Infinity`: это `Column`, `ListView`, `Row` или `UnconstrainedBox`, снявший предел. Исправление применяется либо к этому предку (ограничьте его), либо к потомку (перестаньте просить бесконечность). Поиск в коде по `double.infinity`, `.expand(` и `BoxConstraints.expand` обычно находит кандидата меньше чем за минуту.

## Связанные материалы

- [Исправление: RenderBox was not laid out во Flutter](/ru/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), каскад, который следует за этой ошибкой.
- [Как вложить ListView в Column без ошибки неограниченной высоты](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/).
- [shrinkWrap vs Expanded vs slivers для длинных списков во Flutter](/ru/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).
- [Исправление: A RenderFlex overflowed во Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/).
- [Исправление: RenderViewport expected a RenderSliver в CustomScrollView](/ru/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/), если вы столкнётесь с ней при переходе на `SliverFillRemaining`.

## Источники

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) (документация Flutter), включая примеры с `LimitedBox` и `UnconstrainedBox`.
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors) (документация Flutter).
- [BoxConstraints.enforce](https://api.flutter.dev/flutter/rendering/BoxConstraints/enforce.html) и [BoxConstraints.debugAssertIsValid](https://api.flutter.dev/flutter/rendering/BoxConstraints/debugAssertIsValid.html) (справочник API).
- [SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html), раздел "Centering, spacing, or aligning fixed-height content".
- [SliverFillRemaining](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html) и [LimitedBox](https://api.flutter.dev/flutter/widgets/LimitedBox-class.html) (справочник API).
- `packages/flutter/lib/src/rendering/box.dart` и `proxy_box.dart` в SDK Flutter 3.44.8, прочитаны локально.
