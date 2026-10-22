---
title: "Expanded или Flexible во Flutter: разбор FlexFit.tight и FlexFit.loose"
description: "Используйте Expanded, когда дочерний виджет должен занять свою долю Row или Column, и Flexible, когда он может быть меньше своей доли. Замеры раскладки на Flutter 3.44 показывают, куда уходит оставшееся место, почему неплотные дочерние виджеты не отдают его соседям и когда при неограниченных ограничениях работает только Flexible."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
lang: "ru"
translationOf: "2026/10/expanded-vs-flexible-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-22
---

**Короткий ответ:** `Expanded` - это буквально `Flexible(fit: FlexFit.tight)`. Используйте `Expanded`, когда дочерний виджет должен занять свою долю `Row` или `Column` (списки, панели, всё, у чего есть фон). Используйте `Flexible` (по умолчанию `FlexFit.loose`), когда дочерний виджет может быть меньше своей доли; классический случай - `Text`, который должен обрезаться, если длинный, и прилегать к содержимому, если короткий. Оба получают одинаковый максимальный размер; только `Expanded` принуждает дочерний виджет к этому размеру. Всё ниже измерено с помощью `flutter test` на Flutter 3.44.8 / Dart 3.12.2.

Путаница понятна: в самых распространённых раскладках они выглядят одинаково. `ListView` или `Container` без дочернего виджета стремится занять всё доступное место, поэтому обёртка в любой из двух виджетов даёт те же пиксели. Разница проявляется, только когда дочернему виджету комфортно быть маленьким, и именно тогда люди получают растянутый чип, иконку, прижатую к дальнему краю строки, или зазор, который не могут объяснить.

## Сравнение с первого взгляда

| Поведение (Flutter 3.44)                                    | `Expanded`                         | `Flexible` (по умолчанию)              |
| ----------------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| Fit                                                         | `FlexFit.tight`                    | `FlexFit.loose`                        |
| Ограничение, передаваемое по главной оси                    | min = max = доля                   | min = 0, max = доля                    |
| Дочерний виджет меньше своей доли                           | растягивается до доли              | сохраняет свой размер                  |
| Неиспользованная часть доли                                 | нет                                | становится свободным местом, соседям не отдаётся |
| `mainAxisAlignment` оказывает влияние                       | нет (свободного места не остаётся) | да                                     |
| `Row(mainAxisSize: MainAxisSize.min)` сжимается             | нет, строка занимает всю ширину    | да                                     |
| Внутри неограниченной главной оси (прокручиваемый виджет)   | всегда assertion                   | допустимо при `mainAxisSize: MainAxisSize.min` |
| Настраиваемый `fit`                                         | нет                                | да                                     |

Если запомнить только одну строку, запомните третью: tight растягивает, loose не растягивает.

## Что фреймворк на самом деле делает с двумя вариантами fit

Исходный код достаточно короткий, чтобы его процитировать. В `packages/flutter/lib/src/widgets/basic.dart` на 3.44.8:

```dart
// Flutter 3.44.8, widgets/basic.dart
class Flexible extends ParentDataWidget<FlexParentData> {
  const Flexible({super.key, this.flex = 1, this.fit = FlexFit.loose, required super.child});
  // ...
}

class Expanded extends Flexible {
  const Expanded({super.key, super.flex, required super.child}) : super(fit: FlexFit.tight);
}
```

Ни один из этих виджетов ничего не раскладывает. Это `ParentDataWidget`, которые записывают `flex` и `fit` в `FlexParentData` дочернего виджета, а `RenderFlex` (объект рендеринга за `Row`, `Column` и `Flex`) читает их во время раскладки. Поэтому оба выбрасывают одну и ту же ошибку "must be placed inside Flex widgets", если поместить их под родителя, не являющегося flex.

`RenderFlex._computeSizes` в `rendering/flex.dart` работает в два прохода:

1. Раскладывает каждый дочерний виджет с `flex == 0` (обычные виджеты) по их естественному размеру и суммирует их размеры по главной оси.
2. Вычисляет `spacePerFlex = (maxMainSize - usedByNonFlexChildren) / totalFlex` **один раз**, затем раскладывает каждый flex-виджет с максимумом `spacePerFlex * flex`. Для `FlexFit.tight` минимум равен этому максимуму. Для `FlexFit.loose` минимум равен `0`.

Важна именно деталь "один раз". Доля определяется до измерения любого гибкого дочернего виджета. Если неплотный дочерний виджет использует меньше своей доли, остаток не передаётся его соседям. Он становится свободным местом для `mainAxisAlignment`, что и является источником большинства вопросов "откуда этот зазор".

## Замеры: один и тот же дочерний виджет при обоих вариантах fit

Все числа ниже получены из виджет-тестов, которые фиксируют `Row` в блоке шириной 400 логических пикселей и считывают `tester.getSize` и `tester.getTopLeft`. Вот тестовая обвязка и первый случай:

```dart
// Flutter 3.44.8, Dart 3.12.2, flutter_test
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(width: 400, height: 100, child: child),
      ),
    );

const a = Key('a'), b = Key('b');

void main() {
  testWidgets('tight vs loose with a small child', (t) async {
    await t.pumpWidget(host(Row(children: [
      Expanded(child: SizedBox(key: a, width: 50, height: 10)),
      Flexible(child: SizedBox(key: b, width: 50, height: 10)),
    ])));
    print('Expanded=${t.getSize(find.byKey(a))} '
        'Flexible=${t.getSize(find.byKey(b))}');
  });
}
```

Вывод: `Expanded=Size(200.0, 10.0) Flexible=Size(50.0, 10.0)`. Обоим дочерним виджетам предложили по 200 пикселей (400, поделённые на суммарный flex 2). `SizedBox(width: 50)` под `Expanded` был перекрыт плотным ограничением и стал шириной 200; под `Flexible` он сохранил свои 50. `width: 50` - это просьба, а плотное ограничение от родителя всегда побеждает.

Полный набор проб, та же строка в 400 px:

| Раскладка (Flutter 3.44.8)                                                     | Результат                                           |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `Expanded(SizedBox(w: 50))` + `Flexible(SizedBox(w: 50))`                      | 200 и 50                                            |
| `Flexible(SizedBox(w: 50))` + `Flexible(SizedBox(w: 1000))`                    | 50 и 200, 150 px не использованы в конце            |
| `SizedBox(w: 100)` + `Expanded(flex: 2)` + `Flexible(flex: 1, SizedBox(w: 40))` | 200 и 40, 60 px не использованы                    |
| `Flexible(fit: FlexFit.tight, SizedBox(w: 50))` + `SizedBox(w: 100)`           | 300, идентично `Expanded`                           |
| `Flexible(Container(color: ...))` + `SizedBox(w: 100)`                         | 300 x 100, неплотный fit ничего не изменил          |

Стоит усвоить вторую строку. 1000-пиксельный дочерний виджет был зажат до 200, хотя его сосед использовал только 50, потому что неиспользованные соседом 150 никогда не перераспределялись. Если нужно "маленький берёт, сколько ему нужно, а большой получает остальное", маленький не должен быть гибким вообще: сделайте его обычным дочерним виджетом, а `Expanded` оставьте только для большого.

Последняя строка объясняет, почему многие делают вывод "Flexible и Expanded - одно и то же". `Container` без дочернего виджета, без ширины и без выравнивания принимает наибольший размер, который позволяют его ограничения. Дайте ему неплотный максимум 300, и он выберет 300. То же верно для `ListView`, `TextField` (который заполняет свою ширину) и всего остального, что по умолчанию расширяется. С жадными дочерними виджетами fit незаметен.

## Когда выбирать Expanded

- **Прокручиваемый виджет внутри `Column`.** `Column(children: [Header(), Expanded(child: ListView(...))])` - канонический вариант раскладки. Списку нужна ограниченная высота, и она должна быть ровно равна оставшейся высоте, чтобы протяжённость прокрутки была правильной. Это первое исправление из [руководства по ListView внутри Column](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/), а [причина, по которой оно лучше `shrinkWrap` для длинных списков](/ru/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/), в том, что список продолжает лениво строить своих дочерних виджетов.
- **Панели с фоном, рамкой или областью нажатия.** Цветная боковая панель и область содержимого в соотношении 1:3 должны использовать `Expanded(flex: 1)` и `Expanded(flex: 3)`, чтобы цвета шли от края до края независимо от того, что измеряет содержимое.
- **Пропорциональные сетки из `Row`.** Если три ячейки должны выровняться с тремя ячейками следующей строки, плотные fit гарантируют одинаковую ширину. Неплотные позволяют каждой строке "плыть" вслед за содержимым.
- **Раздвигание элементов.** `Spacer()` - это `Expanded(flex: flex, child: SizedBox.shrink())`. В пробе `SizedBox(w: 50)`, `Spacer()`, `SizedBox(w: 50)` ставит второй блок в x = 350, вплотную к правому краю.

## Когда выбирать Flexible

- **Текст, который должен обрезаться, только когда это необходимо.** Это самый важный случай в реальных приложениях. Сравните подпись, за которой следует иконка:

```dart
// Flutter 3.44.8: label that hugs its text but ellipsizes when long
Row(
  children: [
    Flexible(
      child: Text(
        userName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
    const Icon(Icons.verified, size: 16),
  ],
)
```

Измерено в строке 400 px внутри `Scaffold` при `userName = 'Short'`: под `Flexible` текст имеет ширину 71.25 px, а иконка стоит в x = 71.25, прямо рядом с именем. Замените на `Expanded`, и текст станет шириной 376 px, а иконку вытолкнет в x = 376, к дальнему краю строки. Для длинного имени обе версии ограничивают текст 376 px и показывают многоточие, так что исправление переполнения одинаково, но только `Flexible` сохраняет правильный вид короткого случая. Если вы здесь из-за жёлто-чёрной полосы, другие причины разобраны в [руководстве по RenderFlex overflowed](/ru/2026/05/fix-renderflex-overflowed-in-flutter/).

- **Чипы, бейджи и кнопки, которые должны сохранять свой естественный размер,** но не должны переполняться на узких экранах или при крупном тексте специальных возможностей. Плотные fit растягивают их область нажатия на всю строку.
- **Когда нужно, чтобы `mainAxisAlignment` работал.** С двумя неплотными дочерними виджетами по 50 px и `MainAxisAlignment.spaceBetween` второй виджет оказывается в x = 350. С двумя `Expanded` выравнивание игнорируется, и второй оказывается в x = 200, потому что в плотной раскладке нет свободного места для распределения.
- **Строки, подгоняющиеся под содержимое.** `Row(mainAxisSize: MainAxisSize.min, children: [Flexible(child: SizedBox(width: 50)), SizedBox(width: 20)])` дала ширину 70 px. Та же строка с `Expanded` дала все 400 px, потому что плотный дочерний виджет потребляет всё место, которое предлагает родитель, и для `MainAxisSize.min` ничего не остаётся минимизировать. Это бьёт по тем, кто делает контейнер-"таблетку", который должен облегать свою подпись.

## Подвох, который выбирает за вас: неограниченная главная ось

Поместите `Column` внутрь `SingleChildScrollView` (или `Row` внутрь горизонтального `ListView`), и flex получит бесконечное ограничение по главной оси. `RenderFlex` не может разделить бесконечность, поэтому в `_computeSizes` он устанавливает `canFlex = false` и раскладывает каждый дочерний виджет так, будто у него вообще нет flex.

Что будет дальше, зависит от fit. Отладочная проверка `_debugCheckConstraints` выбрасывает исключение, если у дочернего виджета ненулевой flex **и** либо flex использует `MainAxisSize.max`, либо дочерний виджет имеет `FlexFit.tight`:

```dart
// Flutter 3.44.8: throws in debug
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Expanded(child: SizedBox(height: 50)),
    ],
  ),
)
// RenderFlex children have non-zero flex but incoming height constraints are unbounded.
```

```dart
// Flutter 3.44.8: lays out fine, child is 50 px tall
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Flexible(child: SizedBox(height: 50)),
    ],
  ),
)
```

Оба варианта проверены в пробе: вариант с `Expanded` вызвал assertion, вариант с `Flexible` разложил дочерний виджет 10 x 50 без исключения. Это важно для переиспользуемых виджетов. Если компонент оборачивает часть себя в `Expanded`, его нельзя поместить в прокручиваемый столбец. Если он использует `Flexible`, а его столбец использует `MainAxisSize.min`, он деградирует мягко: родитель ограничен - он гибкий; родитель не ограничен - он принимает естественный размер. Учтите, что в неограниченном случае `Flexible` фактически ничего не делает, поэтому жадный дочерний виджет под ним (`ListView`) всё равно выбросит собственную ошибку "unbounded height".

## Мелкие подвохи и варианты

**`flex: 0` отключает виджет.** `RenderFlex` проверяет `flex > 0`, прежде чем считать дочерний виджет гибким. `Flexible(flex: 0, ...)` раскладывается как обычный дочерний виджет. `Spacer` проверяет assertion `flex > 0`, чтобы вы не сделали этого случайно.

**`Flexible(fit: FlexFit.tight)` и `Expanded` взаимозаменяемы.** Проба дала одинаковые размеры. Предпочитайте `Expanded` ради читаемости; к явному `fit` прибегайте, только когда он вычисляется, например `Flexible(fit: isCompact ? FlexFit.loose : FlexFit.tight, child: ...)`.

**Поперечная ось не затрагивается.** Оба виджета ограничивают только главную ось. Если нужно, чтобы дочерний виджет заполнял и поперечную ось, это `crossAxisAlignment: CrossAxisAlignment.stretch` у `Row` или `Column`, а не другой flex-виджет.

**Сначала вычитается `spacing`.** Начиная с Flutter 3.27 у `Row` и `Column` есть параметр `spacing`. `_computeSizes` заранее закладывает в использованное место `spacing * (childCount - 1)` перед делением, так что промежутки вычитаются до вычисления любой flex-доли.

**Не вкладывайте их друг в друга.** `Expanded(child: Flexible(...))` выбрасывает ошибку ParentDataWidget, потому что родитель внутреннего виджета не является flex. Полный список обёрток, которые это вызывают, см. в [исправлении "Expanded widgets must be placed inside Flex widgets"](/ru/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/).

## Рекомендация и контекст за ней

По умолчанию используйте `Expanded`. Большинство гибких дочерних виджетов в реальных приложениях - это прокручиваемые виджеты, панели или поля, которым и так нужно всё место, а плотные fit дают предсказуемые, выровненные раскладки без сюрпризов со свободным местом.

Переходите на `Flexible` ровно в трёх ситуациях: у дочернего виджета есть естественный размер, который нужно сохранить (текст рядом с иконкой, чип), вам нужно, чтобы `mainAxisAlignment` или `MainAxisSize.min` продолжали работать, либо вы пишете переиспользуемый виджет, который может оказаться внутри прокручиваемого виджета. А когда поймаете себя на том, что ставите `Flexible` на двух соседей, ожидая, что маленький отдаст место большому, остановитесь: сделайте маленький обычным дочерним виджетом, а большой `Expanded`, потому что `RenderFlex` никогда не перераспределяет неиспользованную долю неплотного дочернего виджета.

## Связанные материалы

- [Исправление "A RenderFlex overflowed by N pixels" во Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) для случаев переполнения, где исправлением является выбор между этими двумя виджетами.
- [Почему ListView внутри Column выбрасывает ошибку неограниченной высоты](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) и четыре способа её ограничить.
- [shrinkWrap, Expanded или slivers для длинных списков](/ru/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/), когда гибкий дочерний виджет - прокручиваемый.
- [Исправление "Incorrect use of ParentDataWidget"](/ru/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/), когда `Expanded` или `Flexible` не является прямым дочерним виджетом flex.

## Источники

- [Flexible class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Flexible-class.html)
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html)
- [FlexFit enum, Flutter API reference](https://api.flutter.dev/flutter/rendering/FlexFit.html)
- [Spacer class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Spacer-class.html)
- [RenderFlex source, flutter/flutter `rendering/flex.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/rendering/flex.dart)
- [Understanding constraints, Flutter docs](https://docs.flutter.dev/ui/layout/constraints)
