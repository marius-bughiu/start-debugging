---
title: "Что такое Key во Flutter и когда его отсутствие приводит к багам?"
description: "Ключи Flutter сохраняют идентичность строк при перестановке. Когда достаточно ValueKey, когда ленивому builder нужен индекс и как GlobalKey переносит состояние."
pubDate: 2026-09-04
updatedDate: 2026-11-02
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

Ключ Flutter помогает родителю сопоставить новую конфигурацию виджета с существующим элементом. `Widget.canUpdate` проверяет равенство `runtimeType` и ключей. Строка без ключа может сохранить старое состояние, когда её позицию займут другие данные. Это существенно для контроллера текста, фокуса или анимации конкретного элемента.

**Исправление, 2 ноября 2026 года.** Одного стабильного ключа иногда недостаточно при изменении порядка ленивого builder, а деактивация не означает немедленного освобождения. Пять widget-тестов на Flutter 3.44.8 / Dart 3.12.2 проверили обычные и ленивые строки, а также перенос с `GlobalKey`. Примеры используют библиотеку widgets.

## Обычные соседи: идентифицируйте элемент, а не позицию

```dart
import 'package:flutter/widgets.dart';

class RowLabel extends StatefulWidget {
  const RowLabel(this.id, {super.key});
  final String id;

  @override
  State<RowLabel> createState() => _RowLabelState();
}

class _RowLabelState extends State<RowLabel> {
  late final String createdFor = widget.id;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 48,
    child: Text('row=${widget.id}, state=$createdFor'),
  );
}

Widget rows(List<String> ids, {required bool stableKeys}) => Column(
  children: [
    for (final id in ids)
      RowLabel(id, key: stableKeys ? ValueKey<String>(id) : null),
  ],
);
```

Покажите `rows(['A', 'B'], stableKeys: false)` под `Directionality`, затем перестройте с `['B', 'A']`. Первая строка выводит `row=B, state=A`: конфигурация изменилась, а состояние позиции осталось. При `stableKeys: true` состояние A перемещается вместе с A. `ValueKey(index)` идентифицировал бы позицию. Идентификаторы должны быть стабильны и уникальны среди соседей.

Назначайте ключ непосредственному ребёнку, которого переставляет родитель. Если строка обёрнута в `Padding`, ключ нужен самому `Padding`. Смена ключа может также намеренно сбросить единственное поддерево при переходе на другую запись. Для анимации виджетов одного типа см. [AnimatedSwitcher и ключи ребёнка](/ru/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/).

## Ленивому builder нужен новый индекс по ключу

`ListView.builder` создаёт детей по требованию. При изменении порядка `findChildIndexCallback` сообщает делегату текущий индекс построенного ребёнка. Стройте соответствие из тех же упорядоченных данных, что и `itemBuilder`, и возвращайте `null` для удалённых ID:

```dart
Widget lazyRows(List<String> ids, {bool remap = true}) {
  final indexById = {for (var i = 0; i < ids.length; i++) ids[i]: i};
  int? indexForKey(Key key) => key is ValueKey<String> ? indexById[key.value] : null;

  return ListView.builder(
    itemCount: ids.length,
    findChildIndexCallback: remap ? indexForKey : null,
    itemBuilder: (_, index) {
      final id = ids[index];
      return RowLabel(id, key: ValueKey<String>(id));
    },
  );
}
```

В тесте видимые строки `[A, B, C]` переставлялись в `[C, B, A]`. С callback A сохранила тот же объект `State`; при `remap: false` в этом примере состояние было создано заново. Flutter указывает, что отсутствие соответствия индексов **может** привести к потере состояния. Ключ также не гарантирует сохранение невидимого ребёнка. Долговременные данные храните в модели и выбирайте keep-alive для нужных строк.

## Деактивация, повторная вставка и освобождение

Совместимый stateful-элемент может получить новую конфигурацию без создания нового `State`. При удалении он сначала деактивируется. Поддерево с `GlobalKey` можно в том же кадре вставить под другого родителя и активировать с сохранением состояния. При окончательном удалении после деактивации вызывается `dispose`.

В тесте перенос между родителями дал `init → deactivate → activate` с тем же состоянием. Удаление в следующем кадре дало `deactivate → dispose`. Освобождайте принадлежащие виджету контроллеры в `dispose`. См. [освобождение контроллеров](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) и [обращение к предкам после деактивации](/ru/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/).

## Выбор ключа

| Ключ | Что идентифицирует |
| --- | --- |
| `ValueKey(id)` | Равные тип и значение. Для обычной строки используйте стабильный предметный ID. |
| `ObjectKey(object)` | Тот же экземпляр объекта. Пересоздание модели может изменить идентичность. |
| `UniqueKey()` | Конкретный экземпляр ключа. Новый ключ при каждом build вызывает повторные замены. |
| `PageStorageKey(value)` | Место в `PageStorage`, часто для сохранённой позиции прокрутки. Не сохраняет весь объект состояния. |
| `GlobalKey` | Уникальная идентичность во всём дереве для переноса в одном кадре или доступа к состоянию. Храните экземпляр вне `build`. |

Для фиксированных stateless-детей или последовательности с добавлением только в конец ключ может не давать преимуществ. Используйте ключ элемента, если его состояние должно следовать за ним при изменениях списка.

## Источники

- [Widget.canUpdate](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Inside Flutter: linear reconciliation](https://docs.flutter.dev/resources/inside-flutter)
- [SliverChildBuilderDelegate.findChildIndexCallback](https://api.flutter.dev/flutter/widgets/SliverChildBuilderDelegate/findChildIndexCallback.html)
- [State.deactivate](https://api.flutter.dev/flutter/widgets/State/deactivate.html) · [GlobalKey](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [PageStorageKey](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
