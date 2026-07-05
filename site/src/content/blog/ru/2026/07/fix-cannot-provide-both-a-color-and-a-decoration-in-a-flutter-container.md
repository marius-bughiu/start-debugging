---
title: "Исправление: Cannot provide both a color and a decoration в Container во Flutter"
description: "Перенесите цвет внутрь decoration: используйте decoration: BoxDecoration(color: ...) вместо передачи color и decoration в один и тот же Container."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "container"
lang: "ru"
translationOf: "2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container"
translatedBy: "claude"
translationDate: 2026-07-05
---

Исправление в одну строку: удалите аргумент `color:` у вашего `Container` и поместите этот цвет внутрь `BoxDecoration`, как `decoration: BoxDecoration(color: Colors.blue, ...)`. Утверждение срабатывает, потому что параметр `color` у `Container` есть не что иное, как сокращение для `decoration: BoxDecoration(color: color)`, поэтому передача обоих дала бы виджету два конкурирующих определения фона, и Flutter отказывается угадывать, какое побеждает.

```text
Cannot provide both a color and a decoration
The color argument is just a shorthand for "decoration: BoxDecoration(color: color)".

'package:flutter/src/widgets/container.dart':
Failed assertion: line 273 pos 15: 'color == null || decoration == null'
```

Эта статья написана для Flutter 3.x (проверено на 3.44) и Dart 3.x. Утверждение `Container` читается одинаково со времён 1.x, поэтому всё здесь чисто применимо по всей линии 3.x и назад до 2.x. Проверка находится в `package:flutter/src/widgets/container.dart`; номер строки в вашей трассировке стека может отличаться на несколько между версиями SDK, но выражение утверждения `color == null || decoration == null` стабильно.

## Почему Container запрещает color и decoration вместе

`Container` -- это виджет для удобства. Он ничего не рисует сам; он собирает стек более простых виджетов (`Padding`, `DecoratedBox`, `ConstrainedBox`, `Transform` и компания) в зависимости от того, какие аргументы вы передаёте. Аргумент `color` -- это наименьший возможный кусочек этой композиции: когда вы его задаёте, `Container` внутренне строит `DecoratedBox` с `BoxDecoration(color: color)`. Это и есть полный смысл `color`. Это синтаксический сахар.

`decoration` -- это полномощная версия того же самого. `BoxDecoration` может нести цвет фона, границу, скруглённые углы, градиент, тень и фоновое изображение одновременно. Поскольку у `BoxDecoration` уже есть собственное поле `color`, позволить вам также передать `color` верхнего уровня создало бы неоднозначный виджет: какой цвет рисует, тот, что у `Container`, или тот, что у `BoxDecoration`? Вместо того чтобы молча выбрать победителя (и заставить половину сообщества предположить противоположное правило), фреймворк выбрасывает утверждение на этапе конструирования и заставляет вас быть явным. Конструктор содержит простой `assert(color == null || decoration == null, ...)`, поэтому это выбрасывается только в отладочных и профильных сборках, где утверждения выполняются.

Есть и вторая, более тонкая причина в собственных словах фреймворка: `decoration` может рисовать поверх цвета фона. `BoxDecoration` с `DecorationImage` или градиентом рисует по всей заливке блока, поэтому отдельный `color` под ним иногда был бы виден, а иногда нет, в зависимости от непрозрачности декорации. Слияние обоих в один `BoxDecoration` устраняет весь этот класс путаницы вида "почему не отображается мой цвет".

## Наименьший репро, который его вызывает

Любой `Container`, которому нужны и сплошной фон, и граница, натыкается на это немедленно. Это канонический случай, потому что естественная первая попытка -- потянуться к `color` для заливки и к `decoration` для границы:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: DecorationDemo()));

class DecorationDemo extends StatelessWidget {
  const DecorationDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Container(
          width: 200,
          height: 120,
          // Both set at once -> assertion throws before the first frame.
          color: Colors.blue,
          decoration: BoxDecoration(
            border: Border.all(color: Colors.black, width: 2),
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Center(child: Text('Card')),
        ),
      ),
    );
  }
}
```

Запустите его, и приложение никогда не нарисует ни одного кадра. Утверждение выбрасывается внутри конструктора `Container`, поэтому ошибка возникает в тот момент, когда выполняется `build`, а не позже во время компоновки. Этот момент -- полезный сигнал: в отличие от `RenderFlex overflowed` или `RenderBox was not laid out`, которые происходят во время фазы компоновки, это нарушение контракта на этапе конструирования.

## Исправление, в порядке того, как часто оно вам нужно

### Исправление 1: перенесите цвет внутрь BoxDecoration

Это правильно практически каждый раз. Если вы передаёте `decoration`, удалите аргумент `color` и задайте вместо него `BoxDecoration.color`:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  decoration: BoxDecoration(
    color: Colors.blue,               // was the top-level `color:`
    border: Border.all(color: Colors.black, width: 2),
    borderRadius: BorderRadius.circular(12),
  ),
  child: const Center(child: Text('Card')),
)
```

Один `BoxDecoration` теперь владеет всем внешним видом: заливкой, границей и радиусом угла. Это та форма, которую вы хотите для любой карточки, чипа, значка или фона кнопки, потому что в тот момент, когда вам нужна граница или скруглённые углы, вы всё равно оказались бы в `BoxDecoration`.

### Исправление 2: если вам нужен только плоский цвет, оставьте color и удалите decoration

Если вы потянулись к `decoration` только чтобы добавить скруглённые углы или границу, это намеренно, и Исправление 1 -- правильное. Но если `decoration` закралась из копипаста, а всё, что вам действительно нужно, -- это сплошная заливка без границы, градиента или радиуса, сделайте наоборот: оставьте `color` верхнего уровня и удалите `decoration` полностью.

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  color: Colors.blue,   // fine on its own; no decoration present
  child: const Center(child: Text('Card')),
)
```

Сокращение `color` не устарело и не порицается для случая плоской заливки. Оно читается чище, чем оборачивание одного цвета в `BoxDecoration`, и производит тот же `DecoratedBox` под капотом. Тянитесь к полному `BoxDecoration` только тогда, когда вам нужна одна из его дополнительных возможностей.

### Исправление 3: откажитесь от Container полностью ради простого цветного блока

Когда у вашего `Container` нет отступов, нет ограничений сверх размера и нет трансформации, а вы хотите лишь прямоугольник цвета, `ColoredBox` -- более лёгкий виджет, и у него никогда не бывает этой неоднозначности, потому что он принимает обязательный `color` и никакой декорации:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
const ColoredBox(
  color: Colors.blue,
  child: SizedBox(
    width: 200,
    height: 120,
    child: Center(child: Text('Card')),
  ),
)
```

`ColoredBox` может быть `const`, когда его ребёнок `const`, что позволяет Flutter пропустить его перестроение и перерисовку. Это реальный, хотя и небольшой, выигрыш в списке из множества статичных плиток. Для чего угодно с границей или радиусом вернитесь к Исправлению 1; `ColoredBox` не может это нарисовать.

## Где это реально кусается в настоящем коде

### Оформление виджета через распространение общей декорации

Дизайн-системы часто держат общий `BoxDecoration`, а затем пытаются переопределить только цвет для каждого экземпляра:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: passes both the reused decoration AND a color override.
Container(
  color: theme.colorScheme.surfaceContainerHigh,
  decoration: cardDecoration, // already a BoxDecoration
  child: content,
)
```

Вы не можете наложить `color` верхнего уровня поверх существующего `BoxDecoration`. Используйте вместо этого `copyWith` у декорации, для чего он ровно и предназначен:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  decoration: cardDecoration.copyWith(
    color: theme.colorScheme.surfaceContainerHigh,
  ),
  child: content,
)
```

Если вы здесь берёте цвета из `ColorScheme` Material 3, роли (`surface`, `surfaceContainerHigh`, `primaryContainer`) важны для контраста как в светлом, так и в тёмном режиме; см. [как задать акцентный цвет в приложении Flutter с помощью ColorScheme Material 3](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/), чтобы понять, к какой роли обращаться.

### У AnimatedContainer ровно то же правило

`AnimatedContainer` разделяет контракт конструктора `Container`, поэтому идентичное утверждение срабатывает и там. Ловушка хуже, потому что цвет анимируют, интерполируя `color` верхнего уровня, пока статичная `decoration` предоставляет границу:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: AnimatedContainer with both color and decoration.
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  color: _selected ? Colors.blue : Colors.grey,
  decoration: BoxDecoration(border: Border.all()),
)
```

Анимируйте цвет внутри `BoxDecoration`, и `AnimatedContainer` интерполирует всю декорацию за вас, границу включительно:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  decoration: BoxDecoration(
    color: _selected ? Colors.blue : Colors.grey,
    border: Border.all(),
  ),
)
```

`BoxDecoration` реализует lerp, необходимый для того, чтобы граница и цвет анимировались вместе, чего версия с двумя аргументами никогда не смогла бы.

### Условие, оставляющее оба заданными

Самый неприятный вариант компилируется нормально и выбрасывается только в одной ветке. Кто-то добавляет границу условно, но забывает перенести цвет:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG on the highlighted branch only.
Container(
  color: Colors.white,
  decoration: isHighlighted
      ? BoxDecoration(border: Border.all(color: Colors.amber, width: 2))
      : null,
  child: child,
)
```

Когда `isHighlighted` равно false, `decoration` -- `null`, и утверждение проходит, поэтому код выглядит правильным на каждом скриншоте, пока пользователь не подсветит строку. Протолкните цвет в обе ветки (или в один `BoxDecoration`, построенный с условной границей), чтобы не было состояния, в котором оба не равны null.

## Найти, какой Container виноват в большом дереве

Сообщение утверждения называет файл и строку внутри `container.dart`, а не ваш виджет. Чтобы найти ваш виновный `Container`:

1. Прочитайте трассировку стека под утверждением. Первый кадр в вашем собственном коде (файл под `lib/`) -- это метод `build`, создавший неверный `Container`. В большинстве версий Flutter печатает "The relevant error-causing widget was", за которым следует ваш виджет и его местоположение в исходнике.
2. Если трассировка не помогает, потому что `Container` строится в цикле или в общем билдере, сделайте grep по проекту на `color:` и `decoration:`, появляющиеся близко друг к другу. Регулярное выражение `Container\([^)]*color:[^)]*decoration:` ловит большинство однострочных случаев; многострочные требуют ручного просмотра общей карточки или плитки.
3. Поскольку это выбрасывается на этапе конструирования, hot reload выявляет это мгновенно. Добавьте границу или декорацию, сохраните, и если кадр покраснеет, у вас на экране нужный виджет.

Это поведение на этапе конструирования противоположно утверждениям компоновки вроде [RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), которые появляются только после запуска конвейера компоновки и часто указывают на несколько виджетов в стороне от настоящей причины.

## Подводные камни и похожие ошибки

- **`BoxDecoration.color` против `Container.color` и порядок отрисовки.** Они не идентичны во всех случаях. `Container.color` рисует за ребёнком, но также за любой `decoration`, будь она разрешена; `BoxDecoration.color` рисует как часть декорации, которая находится за `foregroundDecoration`. Для плоской заливки результат -- тот же пиксель, но если вы также используете `foregroundDecoration`, порядок слоёв важен.
- **Всплески `Ink` и `InkWell` исчезают поверх цветного Container.** Если вы дали `Container` `color`, а затем обернули ребёнка в `InkWell`, рябь рисуется за цветом `Container` и пропадает. Исправление -- тот же ход: удалите `Container.color` и используйте виджет `Ink` с `decoration` или `Material` с цветом, чтобы слой чернил находился над заливкой.
- **`The following assertion was thrown building` с другим сообщением.** Если ваша ошибка упоминает `Incorrect use of ParentDataWidget` вместо color и decoration, это отдельный баг контракта компоновки; см. [Incorrect use of ParentDataWidget: Expanded должен быть внутри Flex](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/).
- **Release-сборки скрывают это, а не чинят.** Поскольку проверка -- это `assert`, release-сборка её убирает и рисует с тем аргументом, который сохранил конструктор. Не выпускайте в предположении, что "в release работает". Оно работает случайно, и следующий скачок SDK может изменить, какой аргумент побеждает.
- **`DecoratedBox` выбрасывает ту же концептуальную ошибку иначе.** У `DecoratedBox` вообще нет аргумента `color`, только `decoration`, поэтому там вы не сможете наткнуться на это утверждение. Если вы использовали `DecoratedBox` и хотели цвет, он всегда идёт в `BoxDecoration`.

## Похожее

- [Исправление: A RenderFlex overflowed во Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) -- другое утверждение, на которое новички натыкаются первым при построении компоновок карточек и строк.
- [Исправление: RenderBox was not laid out во Flutter](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) охватывает ошибку на этапе компоновки, которая, в отличие от этой, указывает в сторону от настоящей причины.
- [Исправление: Incorrect use of ParentDataWidget: Expanded должен быть внутри Flex](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) -- родственное утверждение контракта конструирования, которое стоит уметь распознавать.
- [Как задать акцентный цвет в приложении Flutter с помощью ColorScheme Material 3](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) объясняет, какую роль `ColorScheme` подавать в ваш `BoxDecoration.color`.

## Источники

- [Конструктор Container.new -- API Flutter](https://api.flutter.dev/flutter/widgets/Container/Container.html), который документирует сокращение `color` и правило "cannot provide both" дословно.
- [Справочник класса BoxDecoration](https://api.flutter.dev/flutter/painting/BoxDecoration-class.html), декорация, которая владеет `color`, `border`, `borderRadius`, `gradient` и `boxShadow`.
- [flutter/flutter issue #119484](https://github.com/flutter/flutter/issues/119484), отслеживающий issue, где обсуждается, как сообщение об ошибке могло бы быть яснее.
- [flutter/flutter issue #31312](https://github.com/flutter/flutter/issues/31312), исходный отчёт, показывающий точное утверждение и трассировку стека из `container.dart`.
