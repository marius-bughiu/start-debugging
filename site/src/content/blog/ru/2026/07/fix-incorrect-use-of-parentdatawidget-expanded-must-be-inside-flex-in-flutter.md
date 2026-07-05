---
title: "Решение: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets (Flutter)"
description: "Эта ошибка означает, что Expanded или Flexible не является прямым потомком Row, Column или Flex. Переместите его непосредственно под flex-виджет или уберите Expanded, если родитель не flex."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
lang: "ru"
translationOf: "2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-05
---

`Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets` означает, что `Expanded` (или `Flexible`) не является прямым потомком `Row`, `Column` или `Flex`. Между ними находится какой-то другой виджет -- `Container`, `SizedBox`, `Padding`, `Center`, `Stack` или `Wrap`. Исправьте это, сделав `Expanded` прямым потомком flex, или полностью убрав `Expanded`, если родитель не flex. Проверено на Flutter 3.x (3.44), Dart 3.x.

## Ошибка в контексте

Flutter выбрасывает это на фазе build, в виде утверждения, до того как выполняется раскладка. Короткая строка-сводка -- та, которую люди ищут, но полное сообщение в актуальном Flutter говорит вам точно, какой виджет неверен и во что он неверно вложен:

```
Incorrect use of ParentDataWidget.

The ParentDataWidget Expanded(flex: 1) wants to apply ParentData of type
FlexParentData to a RenderObject, which has been set up to accept ParentData of
incompatible type BoxParentData.

Usually, this means that the Expanded widget has the wrong ancestor
RenderObjectWidget. Typically, Expanded widgets are placed directly inside Flex
widgets.
The offending Expanded is currently placed inside a SizedBox widget.

The ownership chain for the RenderObject that received the incompatible parent data
was:
  SizedBox ← Expanded ← Column ← ...
```

Две строки несут всю информацию. "wants to apply ParentData of type `FlexParentData` to a RenderObject, which has been set up to accept ParentData of incompatible type `BoxParentData`" -- это несовместимость типов. "The offending Expanded is currently placed inside a `SizedBox` widget" называет неверного родителя по типу виджета. В более старых версиях Flutter всё это сводится к сводке, которую вы, вероятно, ввели в строку поиска: `Expanded widgets must be placed inside Flex widgets`.

## Почему родитель Flex обязателен, а не просто рекомендуется

`Expanded` ничего не рисует. Это `ParentDataWidget`: его единственная задача -- прикрепить к своему потомку фрагмент конфигурации, чтобы родительский render object знал, как расположить этого потомка. Для `Expanded` эта конфигурация -- flex-фактор, и она живёт в объекте типа `FlexParentData`.

Вот механизм. За `Row`, `Column` или `Flex` стоит `RenderFlex`. Когда `RenderFlex` принимает потомка, он настраивает у этого потомка слот `FlexParentData` для хранения flex-значения и fit. `Expanded` поднимается к своему родительскому render object и вызывает `applyParentData`, который записывает `flex` и `fit` в этот слот. `RenderFlex` читает слот во время раскладки: потомки с flex-фактором делят оставшееся пространство главной оси пропорционально своим факторам. Это рукопожатие -- единственная причина, по которой `Expanded` работает.

Любой другой render object настраивает другой тип `ParentData`. `SizedBox`, `Container` или `Padding` даёт своему единственному потомку `BoxParentData`. `Stack` даёт потомкам `StackParentData`. `Wrap` даёт потомкам `WrapParentData`. Ни у одного из них нет поля `flex`, а `FlexParentData` нельзя записать в слот `BoxParentData`. Поэтому, когда `Expanded` пытается вызвать `applyParentData` на не-flex-родителе, проверка `debugIsValidRenderObject` фреймворка сразу же ловит несовместимость типов и выбрасывает ошибку, вместо того чтобы молча игнорировать flex-фактор или падать позже во время раскладки. Сообщение генерируется из `debugTypicalAncestorWidgetDescription` виджета, которое для `Expanded` равно "Flex widgets", -- отсюда и берётся формулировка "must be placed inside Flex widgets".

Это отличается от [переполнения RenderFlex](/ru/2026/05/fix-renderflex-overflowed-in-flutter/), которое происходит, когда `Row` или `Column` не хватает места во время раскладки. Это срабатывает раньше, во время build, и является ошибкой типа: flex-конфигурации некуда корректно приземлиться.

## Минимальное воспроизведение

Наименьший вариант -- `Expanded`, обёрнутый в любой виджет с единственным потомком:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Sidebar extends StatelessWidget {
  const Sidebar({super.key});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 200,
      child: Expanded(          // wrong: SizedBox is not a Flex
        child: ListView(
          children: const [Text('a'), Text('b')],
        ),
      ),
    );
  }
}
```

`SizedBox` даёт своему потомку `BoxParentData`. `Expanded` хочет записать `FlexParentData`. Build падает. Идентичный сбой возникает, если заменить `SizedBox` на `Container`, `Padding`, `Center`, `Align`, `Card`, `Wrap` или `Stack` -- на что угодно, что не является `Row`, `Column` или `Flex`.

## Решение 1: сделайте Expanded прямым потомком Row, Column или Flex

Если flex-родитель у вас действительно есть, а промежуточный виджет вкрался, исправление -- переупорядочить так, чтобы `Expanded` находился непосредственно под flex. Это самый распространённый случай: кто-то обернул flex-потомка в `Padding` или `Container` для оформления, и `Expanded` оказался не с той стороны.

Неверно -- `Expanded` внутри `Padding`, а `Padding` -- это box:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Padding(
      padding: const EdgeInsets.all(8),
      child: Expanded(child: content),   // throws: parent is Padding
    ),
  ],
)
```

Верно -- `Expanded` является прямым потомком `Column`, а `Padding` идёт внутри него:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: content,
      ),
    ),
  ],
)
```

Правило, которое нужно усвоить: `Expanded` должен быть самым внешним виджетом в этой ячейке списка `children`. Всё, что вы хотите оформить, дополнить отступами или задать по размеру, идёт внутрь его `child`, а не вокруг него.

## Решение 2: уберите Expanded, когда родитель вообще не flex

Если над виджетом действительно нет ни `Row`, ни `Column`, ни `Flex`, то `Expanded` -- неверный инструмент, и никакая степень вложенности не сделает его допустимым. Вам нужен другой способ заполнить пространство:

- **Чтобы заполнить ширину или высоту родителя**, задайте размер потомку напрямую. Используйте `SizedBox(width: double.infinity)`, `SizedBox.expand` или `double.infinity` в ограничениях `Container`:

```dart
// Flutter 3.x (tested 3.44)
// Was: Container(child: Expanded(child: button))  -- illegal
SizedBox(
  width: double.infinity,
  child: button,
)
```

- **Чтобы заполнить долю родителя**, используйте `FractionallySizedBox`:

```dart
// Flutter 3.x (tested 3.44)
FractionallySizedBox(
  widthFactor: 0.5,
  child: button,
)
```

- **Если вам на самом деле было нужно пропорциональное разделение**, вы тянулись к `Expanded` по правильной причине, но забыли о flex-родителе. Введите его. Оберните группу в `Row` или `Column` и поместите `Expanded`-потомков непосредственно внутрь:

```dart
// Flutter 3.x (tested 3.44)
Row(
  children: [
    Expanded(flex: 2, child: leftPane),
    Expanded(flex: 1, child: rightPane),
  ],
)
```

Выбирайте по намерению. Если у вас всегда только один потомок, flex вам вообще не нужен -- задайте размер box. Если вы делите пространство между братьями, вам нужен настоящий flex-родитель.

## Решение 3: остерегайтесь RenderObjectWidget, спрятавшегося на пути

Контракт `Expanded` строже, чем "где-то под Column". Документация утверждает, что путь от `Expanded` вверх до охватывающего его `Row`, `Column` или `Flex` должен содержать **только** `StatelessWidget` или `StatefulWidget`. В тот момент, когда на этом пути появляется `RenderObjectWidget`, он становится родителем, получающим parent data, и несовместимость выбрасывает ошибку.

Это подводит двумя коварными способами:

**`Container` с определёнными свойствами вставляет render-виджеты.** `Container` -- это композиция: задайте ему `padding`, и он оборачивает своего потомка в `Padding`; задайте ему `color` или `decoration`, и он добавляет `DecoratedBox`; задайте ему `alignment`, и он добавляет `Align`. Так что `Container(padding: ..., child: Expanded(...))` помещает `Padding` (`RenderObjectWidget`) непосредственно над вашим `Expanded`, хотя вы никогда не писали `Padding`. Это замаскированное воспроизведение из Решения 1.

**Ваш собственный `RenderObjectWidget` на пути.** Если у вас есть самописный render-виджет, оборачивающий потомков до того, как они достигнут `Column`, применяется то же правило. Собственные обёртки `StatelessWidget` и `StatefulWidget` допустимы; собственный `RenderObjectWidget` -- нет.

Вывод: недостаточно, чтобы `Flex` был предком. `Expanded` должен достигать его через одни лишь простые композиционные виджеты.

## Подводные камни и похожие случаи

**`flex: 0` всё равно выбрасывает ошибку.** Заманчиво думать, что `Expanded(flex: 0)` -- это no-op, который фреймворк пропустил бы. Это не так. Проверка типа parent data выполняется независимо от значения flex, поэтому `Expanded(flex: 0)` внутри `Wrap` падает ровно с той же ошибкой, называя `WrapParentData` несовместимым типом. Это подтверждено как задуманное поведение в [issue 154950 flutter/flutter](https://github.com/flutter/flutter/issues/154950). Если вам нужен потомок, участвующий в `Wrap` с фиксированной шириной, дайте ему `SizedBox`, а не `Expanded`.

**У `Flexible` правило идентично.** `Expanded` -- это просто `Flexible` с `fit: FlexFit.tight`. `Flexible` тоже является `ParentDataWidget<FlexParentData>`, поэтому размещение `Flexible` внутри не-flex-родителя выбрасывает ту же ошибку "Flexible widgets must be placed inside Flex widgets". Замена `Expanded` на `Flexible` никогда не исправляет эту ошибку -- она лишь меняет имя виджета в сообщении.

**`Positioned` вне `Stack` -- баг той же формы.** Если вы видите `Incorrect use of ParentDataWidget. Positioned widgets must be placed directly inside Stack widgets`, это ровно тот же механизм с другими типами: `Positioned` записывает `StackParentData` и нуждается в `Stack` (за которым стоит `RenderStack`) в качестве родителя. Схема исправления идентична -- сделайте его прямым потомком `Stack` или используйте раскладку без позиционирования.

**Условное выражение или spread, дающий `Expanded` на верхнем уровне.** Построение потомков с помощью хелпера, spread `...[]` или тернарного оператора может случайно передать `Expanded` не-flex-родителю, когда выбирается ветка, которую вы не тестировали. Ошибка называет родителя во время выполнения, поэтому доверяйте "currently placed inside a X widget" больше, чем тому, как выглядит исходный код на первый взгляд.

**Ошибка утверждается только в debug-сборках.** Проверка `debugIsValidRenderObject` -- это утверждение режима debug. В release-сборке утверждение вырезается при компиляции, flex-данные молча отбрасываются, и вы получаете едва заметно неверную раскладку вместо падения -- что диагностировать сложнее. Всегда разрешайте это в debug перед публикацией; не думайте, что release-сборка, которая "выглядит нормально", корректна.

## Связанное

- [Решение: A RenderFlex overflowed in Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) -- другая ошибка `Row`/`Column`, выбрасываемая во время раскладки, когда flex-потомки просят больше места, чем есть.
- [Решение: RenderBox was not laid out in Flutter](/ru/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) -- утверждение времени раскладки, которое часто встречается в той же обвязке скролла и flex.
- [Решение: A RenderViewport expected a RenderSliver в Flutter CustomScrollView](/ru/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) -- та же идея "неверного протокола", но для sliver против box, а не flex-parent data против box.
- [Как вложить ListView внутрь Column без ошибки неограниченной высоты](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- где `Expanded` является верным ответом, задавая `ListView` ограниченную высоту внутри `Column`.

## Источники

- [Класс Expanded, справочник API Flutter](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- утверждает, что `Expanded` должен быть потомком `Row`, `Column` или `Flex`, и на пути должны быть только Stateless/Stateful виджеты.
- [Класс ParentDataWidget, справочник API Flutter](https://api.flutter.dev/flutter/widgets/ParentDataWidget-class.html) -- `applyParentData`, `debugTypicalAncestorWidgetDescription` и проверка допустимости, которая генерирует это сообщение.
- [Класс Flexible, справочник API Flutter](https://api.flutter.dev/flutter/widgets/Flexible-class.html) -- базовый класс `Expanded`, подчиняющийся тому же требованию flex-родителя.
- [issue 154950 flutter/flutter](https://github.com/flutter/flutter/issues/154950) -- подтверждает, что ошибка по-прежнему срабатывает для `Expanded(flex: 0)` внутри не-flex-родителя, и это сделано намеренно.
