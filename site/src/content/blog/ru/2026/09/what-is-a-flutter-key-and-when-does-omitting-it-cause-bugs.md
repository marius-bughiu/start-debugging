---
title: "Что такое Key во Flutter и когда его отсутствие приводит к багам?"
description: "Key это половина идентичности в Widget.canUpdate, единственной строке фреймворка, которая решает, будет ли Element вместе со своим State переиспользован или выброшен. Что это значит на практике, какие изменения списка портят состояние без ключей, какой тип ключа выбрать и где ключ должен стоять, чтобы работать."
pubDate: 2026-09-04
tags:
  - "flutter"
  - "dart"
  - "state-management"
  - "listview"
lang: "ru"
translationOf: "2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs"
translatedBy: "claude"
translationDate: 2026-09-04
---

`Key` это половина идентичности единственного сравнения, по которому Flutter решает, можно ли переиспользовать существующий `Element` (и висящий на нём `State`) для нового `Widget`. Это сравнение выглядит так: `oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key`. Без ключа дочерние виджеты одного типа сопоставляются чисто по позиции в списке детей, поэтому любое изменение, сдвигающее элемент (перестановка, удаление из середины, фильтрация), оставляет состояние привязанным к старому слоту, пока данные съезжают в другой. Ключ нужен ровно тогда, когда виджет с состоянием может менять позицию среди своих соседей. Всё ниже относится к текущему каналу stable, Flutter 3.47.2 с Dart 3.13.2, но правила согласования не менялись со времён Flutter 1.

## Ключи это вход для canUpdate, и больше ничего

Фреймворк держит три параллельных дерева: неизменяемую конфигурацию `Widget`, дерево `Element`, которое переживает перестроения, и дерево `RenderObject`, которое раскладывает и рисует. Объекты `State` принадлежат элементам, а не виджетам. Когда родитель перестраивается, каждая позиция ребёнка разрешается через `Element.updateChild`, который задаёт один вопрос:

```dart
// package:flutter/src/widgets/framework.dart, Flutter 3.47.2
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType &&
      oldWidget.key == newWidget.key;
}
```

Если возвращается `true`, существующий элемент сохраняется и переконфигурируется: его `State` выживает, `didUpdateWidget` вызывается, `initState` нет. Если возвращается `false`, старый элемент деактивируется и создаётся совершенно новый, а значит `dispose` на выходе и `initState` на входе. Если новый виджет равен null, ребёнок просто удаляется.

Из этой сигнатуры прямо следуют две вещи. Первая: null это вполне допустимое значение ключа, а `null == null` даёт `true`, поэтому два виджета одного типа без ключей всегда совпадают. Вторая: ключи никогда не сравниваются между разными родителями, их смотрят только среди детей одного элемента. Документация формулирует это прямо: ключи должны быть уникальны среди элементов с общим родителем.

## Проход согласования, который решает, какой ребёнок какой

Вопреки распространённому мнению, Flutter не выполняет универсальный диф деревьев. Каждый элемент согласует свой собственный список детей линейным проходом `O(N)`, описанным в [Inside Flutter](https://docs.flutter.dev/resources/inside-flutter):

1. Идём по обоим спискам сверху, сопоставляя, пока совпадают `runtimeType` и `key`.
2. Идём по обоим спискам снизу, делая то же самое.
3. Оставшийся несопоставленный диапазон в середине: старые дети кладутся в хеш-таблицу по своему `key`, затем новый средний диапазон обходится и каждый элемент ищется в таблице.
4. Старые дети без пары отмонтируются; новые виджеты без пары получают свежие элементы.

Шаг 3 это то, ради чего ключи и нужны. Ребёнку без ключа нечего положить в хеш-таблицу, поэтому его можно сопоставить только позиционными проходами шагов 1 и 2. Именно поэтому списки без ключей переживают добавление в конец (шаг 1 сопоставляет всё, а хвост оказывается новым) и тихо ломаются на всём остальном.

## Минимальное воспроизведение: состояние, которое остаётся на месте

Две плитки, каждая выбирает цвет один раз в своём `State`, плюс кнопка, переворачивающая список. Ничего экзотического. Начиная с Flutter 3.47 виджеты Material живут в отдельном пакете, поэтому импорт отличается от старых примеров; если ваши всё ещё указывают на копию из SDK, посмотрите разбор [переноса импортов на material_ui](/ru/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'dart:math';
import 'package:material_ui/material_ui.dart';

class ColorTile extends StatefulWidget {
  const ColorTile({super.key, required this.label});

  final String label;

  @override
  State<ColorTile> createState() => _ColorTileState();
}

class _ColorTileState extends State<ColorTile> {
  // Chosen once when the State is created, and never again.
  late final Color color = Color(0xFF000000 | Random().nextInt(0xFFFFFF));

  @override
  Widget build(BuildContext context) => Container(
        width: 120,
        height: 120,
        color: color,
        alignment: Alignment.center,
        child: Text(widget.label),
      );
}
```

```dart
// Flutter 3.47.2, Dart 3.13.2
class _TileSwapperState extends State<TileSwapper> {
  List<String> labels = ['A', 'B'];

  @override
  Widget build(BuildContext context) => Column(
        children: [
          Row(
            // No keys.
            children: [for (final l in labels) ColorTile(label: l)],
          ),
          TextButton(
            onPressed: () => setState(() => labels = labels.reversed.toList()),
            child: const Text('Swap'),
          ),
        ],
      );
}
```

Нажмите Swap, и буквы поменяются местами, а цвета нет. В слоте 0 был `ColorTile` с ключом null, новый слот 0 это тоже `ColorTile` с ключом null, `canUpdate` возвращает `true`, поэтому элемент и его `_ColorTileState` переиспользуются, а меняется только `widget.label`. Цвет это состояние, и состояние осталось там, где было.

Добавление идентичности решает проблему:

```dart
// Flutter 3.47.2, Dart 3.13.2
children: [for (final l in labels) ColorTile(key: ValueKey(l), label: l)],
```

Теперь позиционные проходы не срабатывают с обеих сторон, оба ребёнка попадают в средний диапазон, хеш-таблица сопоставляет `ValueKey('A')` с элементом из слота 0, и этот элемент переносится в слот 1 вместе со своим цветом.

## Версия этого бага, которая доходит до продакшена

Случайный цвет это игрушка. Тот же механизм портит настоящие данные всякий раз, когда состояние живёт внутри виджета строки:

```dart
// Flutter 3.47.2, Dart 3.13.2
// Each row owns a TextEditingController in its State.
Column(
  children: [
    for (final task in tasks) TaskRow(task: task), // no key
  ],
)
```

Удалите задачу с индексом 0. Список уменьшается на единицу, и все оставшиеся задачи сдвигаются вверх. Согласование сопоставляет старый слот 0 с новым слотом 0, поэтому контроллер с недописанной заметкой к удалённой задаче теперь сидит в строке, которая отрисовывает *следующую* задачу. `didUpdateWidget` срабатывает с другим `widget.task`, но текст контроллера, смещение прокрутки, чекбокс, флаг раскрытия, focus node, ничего из этого не выводится из `widget`, поэтому ничего из этого не переезжает. Пользователь видит свой текст напротив чужой записи, а при сохранении вы туда его и записываете. Та же форма проявляется в expansion tile, которая держит открытой не ту панель, в анимациях, перезапускающихся не в той строке, и в ошибках валидации, привязанных к полю, которого никто не трогал. Контроллерам, создаваемым на строку, к тому же нужна обычная дисциплина жизненного цикла, а это отдельная и столь же частая утечка: смотрите [как освобождать контроллеры во Flutter](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

`ValueKey(task.id)` на `TaskRow` чинит всё это разом.

## Ставьте ключ на самый внешний виджет в списке

Ключи сопоставляются среди соседей под одним родителем. Если вы оборачиваете строку, соседом становится обёртка, значит ключ нужен обёртке:

```dart
// Wrong: Padding is unkeyed, so Paddings match positionally. The TaskRows
// inside then get compared slot-for-slot, their keys disagree, canUpdate
// returns false, and every row's State is destroyed and rebuilt.
for (final task in tasks)
  Padding(
    padding: const EdgeInsets.all(8),
    child: TaskRow(key: ValueKey(task.id), task: task),
  ),

// Right: the key sits on the widget that is directly a child of the list.
for (final task in tasks)
  Padding(
    key: ValueKey(task.id),
    padding: const EdgeInsets.all(8),
    child: TaskRow(task: task),
  ),
```

Неправильный вариант хуже, чем полное отсутствие ключа: вместо того чтобы перепутать состояние, он выбрасывает его при каждой перестановке, что выглядит как мерцание, перезапуск анимаций и очищенные текстовые поля.

Второй гарантированный способ написать бесполезный ключ это `ValueKey(index)`. Индекс и *есть* та позиционная идентичность, которая у вас уже была, поэтому ключ по нему воспроизводит поведение без ключей один в один, выглядя при этом как исправление. Берите то, что принадлежит самому элементу: идентификатор в базе, UUID, slug.

## Какой тип ключа

| Тип | Идентичность | Когда брать |
| ---- | -------- | ----------------- |
| `ValueKey<T>(v)` | `runtimeType` и `v ==` | У элемента есть устойчивое доменное значение: id, slug, строка с датой в ISO. Вариант по умолчанию. |
| `ObjectKey(o)` | `identical(o, other.value)` | Модель переопределяет `==` по значению (records, классы Freezed), но два равных экземпляра должны остаться различимыми. |
| `UniqueKey()` | Равен только самому себе | Нужно один раз принудительно создать новое поддерево. Никогда не создавайте его внутри `build`: новый экземпляр на каждом кадре означает `canUpdate` false на каждом кадре и поддерево, которое вечно строится с нуля. |
| `PageStorageKey<T>(v)` | `ValueKey`, который дополнительно именует слот в окружающем `PageStorage` | Сохранить смещение прокрутки через push маршрута или переключение вкладки, когда сам элемент уничтожается. |
| `GlobalKey` | Уникален во всём приложении; даёт `currentState`, `currentContext`, `currentWidget` | Перенести поддерево к другому родителю вместе с состоянием или добраться до `FormState` снаружи его поддерева. |

`Key('some string')` это фабрика, возвращающая `ValueKey<String>`, то есть то же самое, но короче.

## GlobalKey это другой инструмент, и он реально стоит дорого

`GlobalKey` это единственный ключ, работающий между разными родителями, что и делает возможным перенос поддерева, и единственный, который отдаёт вам `State` ребёнка:

```dart
// Flutter 3.47.2, Dart 3.13.2
class _CheckoutFormState extends State<CheckoutForm> {
  // Long-lived: a field on the State, not a local in build().
  final _formKey = GlobalKey<FormState>();

  void _submit() {
    if (_formKey.currentState?.validate() ?? false) {
      _formKey.currentState!.save();
    }
  }

  @override
  Widget build(BuildContext context) => Form(key: _formKey, child: /* ... */);
}
```

Здесь кусаются три вещи. Перенос через `GlobalKey` документирован как относительно дорогой: он вызывает `State.deactivate` и заставляет перестроиться каждый виджет, зависящий от `InheritedWidget` в этом поддереве, что заодно является самым быстрым путём к [поиску предка у деактивированного виджета](/ru/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/). Создание ключа внутри `build` уничтожает состояние поддерева на каждом кадре, и делает это молча: `GestureDetector` под пересоздаваемым `GlobalKey` просто перестаёт отслеживать жест посреди перетаскивания. А два живых виджета с одним и тем же `GlobalKey` это assert, "Multiple widgets used the same GlobalKey", из-за чего общий экземпляр виджета, переиспользованный в двух ветках `TabBarView` или под вложенными `Navigator`, падает, а не деградирует.

Берите `LocalKey`, если только вам специально не нужна идентичность между родителями или `currentState`.

## Ключи работают и в обратную сторону: принудительный сброс

Поскольку `canUpdate`, вернувший false, означает сначала dispose, затем initState, намеренная смена ключа это самый чистый способ сбросить поддерево. Панель деталей, переключающая запись в пределах одного маршрута, это стандартный случай:

```dart
// Flutter 3.47.2, Dart 3.13.2
// Without the key, switching selectedOrderId reuses the same State, so the
// TextEditingController inside OrderEditor still holds the previous order's
// notes and any AnimationController keeps its current value.
OrderEditor(
  key: ValueKey(selectedOrderId),
  orderId: selectedOrderId,
)
```

Это тот же сбой, из-за которого `Future`, созданный в `build`, перезапускается при посторонних перестроениях, только с другой стороны: иногда сброс нужен, иногда его надо предотвратить, и решающий вопрос всегда один, изменилась ли идентичность. Рядом стоит прочитать [версию этой проблемы с FutureBuilder](/ru/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

Для двух виджетов ключ обязателен, а не желателен: `Dismissible` падает на assert при null-ключе, потому что свайп для удаления с позиционным сопоставлением увёл бы анимацией не ту строку, а `ReorderableListView` требует ключ на каждом ребёнке ровно по той же причине.

## Когда ключ можно не ставить

- **В поддереве нет состояния.** Если всё под ребёнком stateless и каждый пиксель выводится из полей самого виджета, позиционное сопоставление даёт правильный результат. Перестановка stateless детей без ключей стоит немного лишней работы на перестроение, но это не ошибка корректности.
- **Список растёт только с конца.** Ленты, в которые только добавляют, полностью покрываются проходом сверху.
- **Соседние дети уже различаются по `runtimeType`.** `canUpdate` и так false, ключ ничего не меняет.
- **Вы ставите ключ единственному ребёнку, у которого никогда не бывает соседей.** У `body` в `Scaffold` один слот, различать нечего.

Параметр `super.key` в конструкторе каждого виджета это соглашение для вызывающего кода, а не намёк на то, что туда нужно что-то передавать.

## Два ограничения, о которых стоит знать, прежде чем полагаться на ключи

Ключи не отменяют переработку вьюпорта. `ListView.builder` и семейство sliver-ов уничтожают элементы, как только элемент уходит за cache extent, с ключом или без, и перестраивают их на обратном пути. Если строка должна помнить что-то через эту границу, либо поднимайте состояние в модель, либо подключайте `AutomaticKeepAliveClientMixin` ценой той памяти, которую переработка и экономила. Это тот же вопрос бюджета, который возникает, когда вы [объединяете списочные и сеточные секции в одной прокрутке с помощью sliver-ов](/ru/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

А дублирующиеся `LocalKey` среди соседей это assert в режиме debug, "Duplicate keys found. If multiple keyed widgets exist as children of another widget, they must have unique keys", который поднимает `debugChildrenHaveDuplicateKeys`. Обычно это значит, что выбранное под ключ поле не так уникально, как вы предполагали, то есть баг данных в одежде ошибки фреймворка.

Более глубокая мысль в том, что ключ чинит согласование, а не архитектуру. Каждый из перечисленных багов существует потому, что состояние на элемент живёт внутри `State` виджета, где его идентичность по умолчанию позиционная. Состояние, принадлежащее задаче, должно жить вместе с задачей, и как только это так, вопрос перестановки перестаёт быть вопросом. В этом состоит большая часть аргумента за [перенос состояния из setState в notifier из Riverpod](/ru/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/). Для по-настоящему эфемерного состояния на элемент, вроде смещений прокрутки, фокуса и контроллеров анимации, ключи остаются правильным ответом, и там их стоит расставлять осознанно, а не рассыпать.

## Похожие статьи

- [Как освобождать контроллеры во Flutter, чтобы избежать утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Решение: Looking up a deactivated widget's ancestor is unsafe во Flutter](/ru/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/)
- [Как инициализировать Future, чтобы FutureBuilder не пересоздавал его при каждой перестройке](/ru/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [Как объединить ListView и GridView в одной прокрутке с помощью sliver-ов](/ru/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/)
- [Перенос StatefulWidget с setState на Notifier из Riverpod во Flutter](/ru/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)

## Источники

- [Inside Flutter: линейное согласование](https://docs.flutter.dev/resources/inside-flutter)
- [Widget.canUpdate, документация API Flutter](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Element.updateChild, документация API Flutter](https://api.flutter.dev/flutter/widgets/Element/updateChild.html)
- [Класс Key, документация API Flutter](https://api.flutter.dev/flutter/foundation/Key-class.html)
- [Класс GlobalKey, документация API Flutter](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [Класс PageStorageKey, документация API Flutter](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
- [debugChildrenHaveDuplicateKeys, документация API Flutter](https://api.flutter.dev/flutter/widgets/debugChildrenHaveDuplicateKeys.html)
- [AutomaticKeepAliveClientMixin, документация API Flutter](https://api.flutter.dev/flutter/widgets/AutomaticKeepAliveClientMixin-mixin.html)
- [Что нового во Flutter 3.47, блог Flutter](https://flutter.dev/blog/whats-new-in-flutter-3-47)
