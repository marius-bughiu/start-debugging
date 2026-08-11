---
title: "Как заменить устаревшие groupValue и onChanged у Radio во Flutter на RadioGroup"
description: "Radio.groupValue и Radio.onChanged объявлены устаревшими после Flutter 3.32, а RadioGroup появился в 3.35. Пошаговая миграция для Radio, RadioListTile и CupertinoRadio, почему dart fix не сделает её за вас, и ловушка вывода обобщённых типов, из-за которой мигрированный radio молча остаётся отключённым. Проверено на Flutter 3.44.2 stable."
pubDate: 2026-08-11
updatedDate: 2026-08-11
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material"
  - "accessibility"
lang: "ru"
translationOf: "2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup"
translatedBy: "claude"
translationDate: 2026-08-11
---

Если `flutter analyze` сообщает, что `groupValue` и `onChanged` устарели у `Radio`, `RadioListTile` или `CupertinoRadio`, решение состоит в том, чтобы вынести обе эти свойства из отдельных radio и поднять их в один предок `RadioGroup<T>`, который их оборачивает. Закладывайте примерно десять минут на экран: работа механическая, но `dart fix` не сделает её за вас (я проверил, см. ниже), и есть одна ловушка, которая не выдаёт вообще никакой ошибки, а просто оставляет radio, переставший реагировать на нажатия. Пометка устаревшими появилась после `v3.32.0-0.0.pre`, `RadioGroup` вышел во Flutter 3.35, а старые свойства всё ещё присутствуют в stable 3.44. Всё изложенное проверено на Flutter 3.44.2 stable с Dart 3.12.

## Почему Flutter вынес состояние группы из radio

В старом API не было понятия группы. Каждый `Radio` независимо сравнивал собственное `value` с `groupValue`, который вы передавали каждому по отдельности, а значит сам фреймворк никогда не знал, какие radio относятся к одной группе. Для отрисовки точки этого достаточно, а для доступности бесполезно.

[Паттерн группы радиокнопок WAI-ARIA](https://www.w3.org/WAI/ARIA/apg/patterns/radio) требует, чтобы группа вела себя как одна остановка в порядке табуляции, а стрелки перемещали выбор внутри неё. Реализовать это без widget, который владеет всем набором, невозможно. `RadioGroup` и есть такой widget, и именно поэтому был сделан редизайн, а не косметическая чистка API.

Поведение, которое вы получаете бесплатно после миграции, подтверждено мной в widget-тесте на 3.44.2:

- **Tab и Shift+Tab** переводят фокус внутрь всей группы и наружу, а не по каждому radio по очереди.
- **Стрелки** перемещают выбор между radio в порядке чтения и заворачивают на краях. Начав с `Flavor.vanilla` и нажав стрелку вниз дважды, выбор прошёл от `vanilla` к `chocolate` и обратно к `vanilla`.
- **Пробел** переключает сфокусированный radio.

Есть и более мелкий выигрыш: сами radio становятся короче. `Radio<int>` в мигрированном дереве это `Radio<int>(value: 0)` и больше ничего.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| `Radio.groupValue` / `Radio.onChanged` | Устарели; переносятся в предок `RadioGroup<T>` | высокая |
| `RadioListTile.groupValue` / `.onChanged` | Та же пометка, то же решение | высокая |
| `CupertinoRadio.groupValue` / `.onChanged` | Та же пометка, то же решение | высокая |
| Отключение одного radio | `onChanged: null` заменён на `enabled: false` | средняя |
| Вывод обобщённых типов | `RadioGroup<T>` ищется по точному типу, и `T` выводится иначе, чем у radio | высокая |
| Порядок табуляции | Группа теперь одна остановка вместо N | средняя |
| `RadioListTile.selected` | По-прежнему не согласуется автоматически с отмеченным состоянием | низкая |
| Автоматическая миграция | Правила `dart fix` не существует; это ручная правка | средняя |

## Предварительная проверка

- Flutter 3.35 или новее. `RadioGroup` появился в `3.34.0-0.0.pre` и дошёл до stable в 3.35, так что в более старых версиях класса просто нет. Проверьте командой `flutter --version`.
- Найдите все места использования: `flutter analyze` сообщает о каждом как о `deprecated_member_use`. На тестовом файле он выдал `'groupValue' is deprecated and shouldn't be used. Use a RadioGroup ancestor to manage group value instead. This feature was deprecated after v3.32.0-0.0.pre.`
- Не рассчитывайте на `dart fix`. Я запустил `dart fix --dry-run` на проекте, полном устаревших вызовов `Radio`, под 3.44.2 и получил `Nothing to fix!`. В каталоге фреймворка `lib/fix_data/fix_material` нет никакого `fix_radio*.yaml`, и это логично: обернуть widget в новый предок это структурная правка, а не переименование параметра.
- Проверьте зависимости. Некоторые пакеты с pub.dev до сих пор используют старый API внутри ([flutter/flutter#170915](https://github.com/flutter/flutter/issues/170915) отслеживает это для официальных пакетов). Чужой widget вы мигрировать не можете, да это и не нужно: устаревшие свойства продолжают работать.

## Шаги миграции

1. **Оберните группу в `RadioGroup<T>` и перенесите туда `groupValue` и `onChanged`.** Это вся миграция в одной правке. Переменная состояния и вызов `setState` остаются на месте; переезжают только свойства.

   Было, на Flutter 3.44:

   ```dart
   // Flutter 3.44, Dart 3.12 - deprecated API
   Widget build(BuildContext context) {
     return Column(
       children: <Widget>[
         Radio<Flavor>(
           value: Flavor.vanilla,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
         Radio<Flavor>(
           value: Flavor.chocolate,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
       ],
     );
   }
   ```

   Стало:

   ```dart
   // Flutter 3.44, Dart 3.12 - RadioGroup API
   Widget build(BuildContext context) {
     return RadioGroup<Flavor>(
       groupValue: _flavor,
       onChanged: (Flavor? v) => setState(() => _flavor = v),
       child: const Column(
         children: <Widget>[
           Radio<Flavor>(value: Flavor.vanilla),
           Radio<Flavor>(value: Flavor.chocolate),
         ],
       ),
     );
   }
   ```

   Проверка: `flutter analyze` по этому файлу падает с четырёх сообщений `deprecated_member_use` до нуля, а нажатие на второй radio по-прежнему обновляет состояние.

2. **Всегда пишите аргумент типа явно и у группы, и у radio.** Вывод типов не даст ожидаемого результата, когда тип значения допускает null. Пишите `RadioGroup<Flavor?>` и `Radio<Flavor?>`, никогда не голый `RadioGroup(...)`. Следующий раздел объясняет, почему это важнее, чем кажется.

   Проверка: поищите в diff `RadioGroup(` без `<`. Каждое совпадение это скрытая ошибка.

3. **Замените `onChanged: null` на `enabled: false` у каждого radio, который вы отключали.** В старом API null-колбэк был способом сделать один вариант неактивным. `RadioGroup.onChanged` объявлен `required` и не допускает null, так что этот рычаг на уровне группы исчез и переехал к каждому radio.

   ```dart
   // Flutter 3.44 - one disabled option inside an otherwise live group
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: const Column(
       children: <Widget>[
         Radio<int>(value: 0),
         Radio<int>(value: 2, enabled: false),
       ],
     ),
   )
   ```

   Проверка: отключённый radio отрисовывается серым, а его узел семантики содержит `hasEnabledState` без `isEnabled`.

4. **Сделайте ту же правку для `RadioListTile` и `CupertinoRadio`.** Они принимают тот же предок `RadioGroup`. У `RadioListTile` вдобавок остаётся собственное свойство `enabled`, вычисляемое как `widget.enabled ?? (widget.onChanged != null || registry != null)`.

   ```dart
   // Flutter 3.44 - RadioListTile inside a lazy list
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: ListView.builder(
       itemCount: options.length,
       itemBuilder: (BuildContext context, int i) =>
           RadioListTile<int>(value: i, title: Text(options[i])),
     ),
   )
   ```

   Проверка: это работает и с ленивым построением. В `ListView.builder` на 200 элементов, где реально построено было только 11 плиток, нажатие на элемент 3 установило значение группы в 3.

5. **Разделяйте смешанные группы по типу или вкладывайте их.** Если в одной колонке лежат radio с двумя разными типами значений, оберните внутренний набор в собственный `RadioGroup`. Вложенность работает, потому что поиск идёт по типу, а при совпадающих типах побеждает ближайший предок. Я подтвердил, что `RadioGroup<String>`, вложенный в другой `RadioGroup<String>`, направляет нажатия только в `onChanged` внутренней группы.

   Проверка: нажмите по одному radio из каждой подгруппы и убедитесь, что каждый колбэк сработал ровно один раз.

6. **Запустите анализатор и widget-тесты.** `flutter analyze` не должен выдавать ни одного `deprecated_member_use` для членов radio, а любой тест, нажимающий на radio, должен продолжать проходить. Именно тесты ловят описанный ниже молчаливый сбой.

## Проверка результата

После миграции выполните эти четыре проверки, прежде чем считать экран готовым:

- `flutter analyze` не выдаёт ни одного `deprecated_member_use`, связанного с radio.
- Каждый radio по-прежнему заметно реагирует на нажатие. Мигрированный radio, отрисованный серым, это описанный ниже режим отказа, а не проблема стилей.
- Клавиатура: перейдите табуляцией в группу, нажмите стрелку вниз, убедитесь, что выбор сместился. Это та самая возможность, ради которой вы мигрировали, так что проверить её один раз на экран стоит.
- Скринридер или `debugDumpSemanticsTree`: узел семантики рабочего radio несёт `isEnabled` и действие `tap`. Мёртвый несёт `hasEnabledState`, но не `isEnabled`.

## План отката

Эта миграция действительно обратима. Устаревшие свойства всё ещё существуют в stable 3.44 и не назначены к удалению ни в одной анонсированной версии, так что `git revert` коммита с миграцией компилируется и работает ровно как раньше. Всё равно делайте работу в отдельной ветке, потому что режим отказа здесь молчаливый и вам понадобится чистый diff для bisect.

## Ловушка: мигрированный radio, который молча перестаёт работать

Это та часть, которую официальное руководство по миграции не покрывает, и она стоит за [flutter/flutter#175705](https://github.com/flutter/flutter/issues/175705), issue, закрытым без диагноза.

Два факта складываются неудачно.

Во-первых, `Radio` без предка `RadioGroup` и без `onChanged` не бросает исключение. Посмотрите, как это вычисляет `_RadioState`:

```dart
// packages/flutter/lib/src/material/radio.dart, Flutter 3.44 stable
bool get _enabled =>
    widget.enabled ??
    (widget.onChanged != null ||
        widget.groupRegistry != null ||
        RadioGroup.maybeOf<T>(context) != null);
```

Когда все три равны null, `_enabled` становится `false`, и radio отрисовывается как отключённый элемент управления. Утверждение `'Radio is enabled but has no Radio.onChange or registry above'` срабатывает только если вы явно передали `enabled: true`. Я отрисовал два widget `Radio<Flavor>` вообще без группы: ни одного исключения, а узел семантики вернулся как `flags: [hasCheckedState, hasEnabledState, isInMutuallyExclusiveGroup]`. Обратите внимание, чего не хватает: `isEnabled` и любого действия нажатия.

Во-вторых, `RadioGroup` находится по точному обобщённому типу:

```dart
// packages/flutter/lib/src/widgets/radio_group.dart, Flutter 3.44 stable
static RadioGroupRegistry<T>? maybeOf<T>(BuildContext context) {
  return context.dependOnInheritedWidgetOfExactType<_RadioGroupStateScope<T>>()?.state;
}
```

`dependOnInheritedWidgetOfExactType` означает, что `_RadioGroupStateScope<Flavor>` не удовлетворяет поиску `_RadioGroupStateScope<Flavor?>`. Ковариантность здесь не помогает.

Теперь сложите это с выводом типов Dart. `RadioGroup` объявляет `T? groupValue`, тогда как `Radio` и `RadioListTile` объявляют `T value`. Передайте обоим переменную, допускающую null, и они выведут разные аргументы типа:

```dart
// Flutter 3.44, Dart 3.12
String? selected;
final group = RadioGroup(groupValue: selected, onChanged: (v) {}, child: const SizedBox());
final tile = RadioListTile(value: selected, title: const Text('x'));
// group.runtimeType -> RadioGroup<String>
// tile.runtimeType  -> RadioListTile<String?>
```

Это типы времени выполнения, напечатанные реальным прогоном теста. Группа это `RadioGroup<String>`; плитка это `RadioListTile<String?>`. Плитка ищет `_RadioGroupStateScope<String?>`, ничего не находит, вычисляет `_enabled` как `false` и отрисовывается мёртвой. Ни исключения, ни предупреждения анализатора.

Воспроизведение имеет ровно ту форму, с которой сталкиваются при миграции варианта "System default", где `null` это законный выбор. В группе, где одна плитка получила `Flavor?`, а её сосед `Flavor`, семантика вернулась такой:

```text
System  -> flags: [hasEnabledState, hasSelectedState]
Vanilla -> actions: [focus, tap], flags: [hasEnabledState, isEnabled, isFocusable, hasSelectedState]
```

Нажатие на "System" вызвало `onChanged` группы ноль раз. Нажатие на "Vanilla" вызвало его один раз.

Решение состоит в том, чтобы зафиксировать аргумент типа с обеих сторон:

```dart
// Flutter 3.44 - explicit nullable type argument on group and tiles
RadioGroup<Flavor?>(
  groupValue: _flavor,
  onChanged: (Flavor? v) => setState(() => _flavor = v),
  child: const Column(
    children: <Widget>[
      RadioListTile<Flavor?>(value: null, title: Text('System')),
      RadioListTile<Flavor?>(value: Flavor.vanilla, title: Text('Vanilla')),
    ],
  ),
)
```

С явно выписанным `RadioGroup<Flavor?>` нажатие на "System" корректно устанавливает значение группы в `null`. Это и есть ответ на закрытый issue: значения, допускающие null, не отключены по замыслу, просто выведенные аргументы типа не совпали.

## Мелкие ловушки, о которых стоит знать

**`toggleable` остался у radio.** Это не свойство уровня группы. `Radio<Flavor>(value: Flavor.vanilla, toggleable: true)` внутри `RadioGroup<Flavor>` по-прежнему вызывает `onChanged` группы со значением `null`, когда вы нажимаете на уже выбранный вариант. Проверено на 3.44.2. Значит, ваш `groupValue` обязан допускать null, если вы этим пользуетесь, что возвращает вас прямо к описанной выше ловушке вывода типов.

**Отключения на уровне группы нет.** `RadioGroup.onChanged` обязателен и не допускает null, так что сделать всю группу неактивной, обнулив один колбэк, как раньше, не получится. Ставьте `enabled: false` на каждый radio или пройдитесь по списку вариантов и передайте флаг.

**`RadioListTile.selected` по-прежнему ручной.** Фреймворк документирует, что "no effort is made to automatically coordinate the selected state and the checked state", и предписывает ставить `selected: true`, когда `value` совпадает с `RadioGroup.groupValue`. Миграция этого не меняет; сравнивать по-прежнему приходится вручную.

**Навигация с клавиатуры доходит только до построенных radio.** В `ListView.builder` стрелки могут перемещаться только по тем плиткам, которые в данный момент есть в дереве widget. В моей пробе на 200 элементов построено было 11. Для длинного списка вариантов это реальное ограничение доступности и хороший повод предпочесть ограниченную `Column` внутри scroll view ленивому построению для групп radio. Если ленивый список всё же нужен, [паттерны списков с бесконечной прокруткой](/ru/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/) остаются в силе.

**`Radio.adaptive` в порядке.** Он передаёт `groupRegistry: _effectiveRegistry` и `enabled: _enabled` вниз в `CupertinoRadio`, так что адаптивный radio внутри `RadioGroup` подхватывает реестр на iOS и macOS без дополнительной работы.

**Для собственных radio-подобных widget реализуйте реестр.** `RadioGroupRegistry<T>` это небольшой публичный интерфейс (`groupValue`, `onChanged`, `registerClient`, `unregisterClient`), а `RawRadio` принимает `groupRegistry` напрямую. Это поддерживаемый путь, если вы строите собственный оформленный элемент управления, который должен участвовать в клавиатурной навигации группы. `RawRadio` утверждает `'an enabled raw radio must have a registry'`, так что подключите реестр до того, как включать элемент.

Миграция не срочная, поскольку устаревшие свойства всё ещё компилируются на 3.44. Сделать её всё равно стоит, потому что поведение доступности вы не дооснастите самостоятельно, и потому что каждый экран, оставленный на старом API, это экран, который вы будете мигрировать позже в условиях нехватки времени. Сделайте это сейчас, выпишите аргументы типа и позвольте анализатору сказать вам, когда работа закончена.

## Похожие материалы

- [Исправление: No Material widget found во Flutter](/ru/2026/08/fix-no-material-widget-found-in-flutter/)
- [Как защитить setState проверкой mounted после асинхронного разрыва во Flutter](/ru/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [Переход с Riverpod 2.x на Riverpod 3.0 во Flutter](/ru/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [Как освобождать контроллеры во Flutter, чтобы избежать утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Как построить список с бесконечной прокруткой и пагинацией во Flutter с помощью ScrollController](/ru/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/)

## Источники

- [Redesigned the Radio widget, ломающие изменения Flutter](https://docs.flutter.dev/release/breaking-changes/radio-api-redesign)
- [Класс RadioGroup, документация API Flutter](https://api.flutter.dev/flutter/widgets/RadioGroup-class.html)
- [Класс Radio, документация API Flutter](https://api.flutter.dev/flutter/material/Radio-class.html)
- [Класс RadioListTile, документация API Flutter](https://api.flutter.dev/flutter/material/RadioListTile-class.html)
- [Issue 113562: семантика группы радиокнопок](https://github.com/flutter/flutter/issues/113562)
- [PR 168161: введение RadioGroup](https://github.com/flutter/flutter/pull/168161)
- [Issue 175705: значение null в RadioGroup](https://github.com/flutter/flutter/issues/175705)
- [WAI-ARIA Authoring Practices: паттерн группы радиокнопок](https://www.w3.org/WAI/ARIA/apg/patterns/radio)
