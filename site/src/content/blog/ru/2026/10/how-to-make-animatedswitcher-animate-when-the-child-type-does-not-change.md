---
title: "Как заставить AnimatedSwitcher анимировать смену, если тип дочернего виджета не меняется во Flutter"
description: "AnimatedSwitcher запускает переход только тогда, когда Widget.canUpdate считает новый дочерний виджет другим, поэтому Text на Text без ключа просто обновляется на месте. Здесь описано исправление в одну строку, где именно должен стоять ключ, почему UniqueKey - ловушка, ошибка направления сдвига из-за статического transitionBuilder и скачок раскладки из-за Stack по умолчанию. Всё проверено виджет-тестами на Flutter 3.44.8."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Коротко:** задайте прямому дочернему виджету `AnimatedSwitcher` ключ, который меняется всякий раз, когда меняется содержимое, обычно это `ValueKey`, построенный из отображаемых данных: `Text('$count', key: ValueKey<int>(count))`. `AnimatedSwitcher` решает, запускать ли переход, с помощью `Widget.canUpdate`, который сравнивает только `runtimeType` и `key`. Два виджета `Text` без ключа с точки зрения фреймворка являются "одним и тем же виджетом", поэтому старый обновляется на месте и ничего не анимируется. Всё ниже проверено виджет-тестами на Flutter 3.44.8 (Dart 3.12.2), а исходный код `_AnimatedSwitcherState` в текущей ветке `stable` побайтово совпадает.

Дальше в статье показана конкретная строка во фреймворке, из-за которой это происходит, минимальный пример с выводом теста, место, где должен стоять ключ (ключ на уровень глубже ничего не даёт), причина, по которой `UniqueKey` - неверное решение, и три подводных камня, которые появляются сразу после того, как переход заработал: сдвиги в неверную сторону, скачок содержимого в центр и потеря состояния дочерних виджетов.

## Единственное сравнение, которое делает AnimatedSwitcher

`AnimatedSwitcher` - это `StatefulWidget`, который хранит "текущую запись" (дочерний виджет и собственный `AnimationController`) и набор уходящих записей, которые ещё затухают. Когда родитель перестраивает его с новым `child`, `didUpdateWidget` выполняет такую проверку, взятую прямо из `packages/flutter/lib/src/widgets/animated_switcher.dart`:

```dart
// Flutter 3.44.8, _AnimatedSwitcherState.didUpdateWidget
final hasNewChild = widget.child != null;
final hasOldChild = _currentEntry != null;
if (hasNewChild != hasOldChild ||
    hasNewChild && !Widget.canUpdate(widget.child!, _currentEntry!.widgetChild)) {
  // Child has changed, fade current entry out and add new entry.
  _childNumber += 1;
  _addEntryForNewChild(animate: true);
} else if (_currentEntry != null) {
  // Child has been updated. ... keep the key from the previous transition
  // so that we update the transition instead of replacing it.
  _currentEntry!.widgetChild = widget.child!;
  _updateTransitionForEntry(_currentEntry!);
}
```

А `Widget.canUpdate` - это одна строка:

```dart
// Flutter 3.44.8, framework.dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key;
}
```

Обратите внимание на то, что не сравнивается: текст, цвет, URL изображения, вообще ни одно поле. Переход запускается ровно в трёх случаях: дочерний виджет меняется с `null` на не-null, с не-null на `null`, либо у нового дочернего виджета другой тип времени выполнения или другой ключ. Если вы переходите от `Text('1')` к `Text('2')`, ничего из этого не выполняется, поэтому ветка `else` подставляет виджет в существующую запись, и пользователь видит мгновенную смену. В документации API об этом сказано прямо, но симптом ("мой AnimatedSwitcher ничего не делает") редко заставляет туда заглянуть. Если вам нужна общая теория этого сравнения, я разбирал её в статье [что такое Flutter Key и когда его отсутствие вызывает ошибки](/ru/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/).

## Минимальный пример, который можно запустить как тест

Самый быстрый способ понять, идёт ли переход, - посчитать виджеты `FadeTransition` в середине анимации. Стандартный `transitionBuilder` оборачивает каждую запись, входящую и уходящую, в один `FadeTransition`, так что один означает "перехода нет", а два означает "идёт перекрёстное затухание".

```dart
// Flutter 3.44.8, Dart 3.12.2 -- test/switcher_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 300),
        child: child,
      ),
    );

int fades(WidgetTester t) => find.byType(FadeTransition).evaluate().length;

void main() {
  testWidgets('no key: same type is updated in place', (t) async {
    await t.pumpWidget(host(const Text('1')));
    await t.pumpWidget(host(const Text('2')));
    await t.pump(const Duration(milliseconds: 100));
    print('no key -> ${fades(t)}'); // no key -> 1
  });

  testWidgets('ValueKey on the direct child animates', (t) async {
    await t.pumpWidget(host(const Text('1', key: ValueKey(1))));
    await t.pumpWidget(host(const Text('2', key: ValueKey(2))));
    await t.pump(const Duration(milliseconds: 100));
    print('ValueKey -> ${fades(t)}'); // ValueKey -> 2
    await t.pumpAndSettle();
    print('settled -> ${fades(t)}'); // settled -> 1
  });
}
```

Без ключа через 100 мс от 300-миллисекундной анимации остаётся один `FadeTransition`, то есть анимации не существует. С `ValueKey` их два, а после `pumpAndSettle` уходящая запись уничтожена и удалена.

## Исправление в реальном виджете

Вот то же исправление в виджете приложения. Ключ ставится на виджет, который вы передаёте как `child`, и строится из значения, которое должно запускать переход:

```dart
// Flutter 3.44.8, Dart 3.12.2
class Counter extends StatefulWidget {
  const Counter({super.key});
  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int _count = 0;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 250),
          transitionBuilder: (child, animation) =>
              ScaleTransition(scale: animation, child: child),
          child: Text(
            '$_count',
            key: ValueKey<int>(_count), // the whole fix
            style: Theme.of(context).textTheme.displayMedium,
          ),
        ),
        FilledButton(
          onPressed: () => setState(() => _count++),
          child: const Text('Increment'),
        ),
      ],
    );
  }
}
```

Тот же приём покрывает все случаи "тот же тип, другое содержимое", с которыми сталкиваются:

- Смена изображений: `Image.network(url, key: ValueKey(url))`.
- Смена значков: `Icon(isPlaying ? Icons.pause : Icons.play_arrow, key: ValueKey(isPlaying))`.
- Переключение между состояниями модели: `key: ValueKey(user.id)` на карточке профиля, чтобы редактирование того же пользователя не анимировалось, а выбор другого пользователя анимировался.
- Ветки загрузки, ошибки и данных, которые случайно возвращают виджеты одного типа (например, три `Center`): задайте им `ValueKey('loading')`, `ValueKey('error')`, `ValueKey('data')`. Если асинхронное состояние приходит из Riverpod, это естественно сочетается с [показом состояний загрузки и ошибки через AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

Выбирая, что положить в ключ, вы выбираете, когда сработает анимация. Ключ, построенный из `count`, анимирует каждое увеличение. Ключ, построенный из `count ~/ 10`, анимирует только при смене разряда десятков, а внутренний текст по-прежнему обновляется на месте.

## Ключ должен стоять на прямом дочернем виджете

`canUpdate` всегда смотрит только на `widget.child`, то есть на виджет, который вы передаёте в `AnimatedSwitcher` напрямую. Ключ на чём-то вложенном для этого сравнения невидим:

```dart
// Flutter 3.44.8 -- does NOT animate
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: Padding(
    padding: const EdgeInsets.all(8),
    child: Text('$_count', key: ValueKey<int>(_count)), // too deep
  ),
)
```

В моём тесте это дало один `FadeTransition` в середине анимации, как и совсем без ключа. У внешнего `Padding` нет ключа и тип каждый раз один и тот же, поэтому переключатель обновляет его на месте, а внутренний `Text` сам по себе получает новый элемент без какого-либо перехода. Перенесите ключ на `Padding` (или на любой ваш виджет верхнего уровня, часто это `Container`, `Card` или собственный `StatelessWidget`), и всё заработает.

Это же касается случая, когда дочерний виджет - ваш собственный класс:

```dart
// Flutter 3.44.8
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: StatusBadge(status: status, key: ValueKey(status)),
)
```

Достаточно передать `key` через `super.key` в конструкторе `StatusBadge`. Ключ на чём-то внутри `StatusBadge.build` не поможет.

## Почему UniqueKey - неверное решение

Первый ответ, который находят многие, - `key: UniqueKey()`. Он действительно заставляет переключатель анимировать, но анимирует при каждой перестройке родителя, а не только при смене содержимого:

```dart
// Flutter 3.44.8, Dart 3.12.2
testWidgets('UniqueKey animates on every rebuild', (t) async {
  await t.pumpWidget(host(Text('1', key: UniqueKey())));
  await t.pumpWidget(host(Text('1', key: UniqueKey()))); // same text
  await t.pump(const Duration(milliseconds: 100));
  print(fades(t)); // 2
});
```

Тот же текст, полное перекрёстное затухание. На реальном экране родитель перестраивается по причинам, не связанным с переключаемым содержимым: изменение `MediaQuery` при открытии клавиатуры, смена темы, посторонний `setState`, уведомление от провайдера. Каждая из них перезапускает переход, и каждая отбрасывает элемент и состояние дочернего виджета. Противоположная ошибка - постоянный ключ, например `ValueKey('label')` на `Text`, строка которого меняется. Такой ключ никогда не меняется, поэтому `canUpdate` возвращает true и ничего не анимируется. Мой тест подтвердил один `FadeTransition` и мгновенно показанный новый текст. Всегда строите ключ из данных.

## Быстрые переключения и дочерний виджет null

Два поведения, о которых стоит знать, чтобы не принять их за ошибки:

1. Если дочерний виджет снова меняется до окончания предыдущего перехода, переключатель ничего не отменяет. Текущая запись переносится в набор уходящих и разворачивается в обратную сторону, поэтому одновременно могут затухать несколько дочерних виджетов. Переключение 1, 2, 3 в течение 100 мс оставило в дереве три виджета `FadeTransition`. Поэтому же один и тот же ключ может безопасно вернуться: каждый переход обёрнут в `KeyedSubtree` с ключом из внутреннего счётчика (`_childNumber`), так что новый дочерний виджет с ключом `A` никогда не путается с уходящим, у которого тоже ключ `A`.
2. Установка `child: null` - допустимый способ анимированно убрать содержимое. `hasNewChild != hasOldChild` запускает переход, старый дочерний виджет затухает, и ничего не появляется.

## Подводный камень: сдвиги в неверную сторону

Когда перекрёстное затухание работает, следующая просьба обычно - горизонтальный сдвиг: новое значение въезжает справа, старое уезжает влево. Наивная версия сдвигает оба дочерних виджета от правого края и к нему же, потому что контроллер уходящего виджета просто идёт в обратную сторону по той же интерполяции. Стандартный приём - проверять в `transitionBuilder`, является ли оборачиваемый дочерний виджет текущим:

```dart
// Flutter 3.44.8, Dart 3.12.2
Widget _slide(Widget child, Animation<double> animation) {
  final incoming = child.key == ValueKey<int>(_count);
  final offset = Tween<Offset>(
    begin: Offset(incoming ? 1 : -1, 0),
    end: Offset.zero,
  ).animate(animation);
  return ClipRect(child: SlideTransition(position: offset, child: child));
}
```

Вот тонкий момент. `AnimatedSwitcher` повторно вызывает `transitionBuilder` для уходящих записей только когда `widget.transitionBuilder != oldWidget.transitionBuilder`. Функциональный литерал, написанный прямо в `build`, например `transitionBuilder: (c, a) => _slide(c, a)`, создаёт новый объект замыкания при каждой сборке, поэтому сравнение истинно, все записи перестраиваются с актуальным `_count`, и старый дочерний виджет корректно помечается как уходящий. Передача метода как значения, `transitionBuilder: _slide`, или построитель, хранящийся в поле, могут оказаться равными между сборками, и тогда уходящая запись сохраняет переход, с которым была создана, когда была входящей. Я запустил оба варианта и прочитал смещения `SlideTransition` на середине анимации:

```text
inline closure:   child 1 dx=-0.50   child 2 dx=0.50
stored function:  child 1 dx= 0.50   child 2 dx=0.50
```

Со сохранённой функцией старый дочерний виджет уезжает обратно вправо, поверх нового. Если вы пишете `transitionBuilder`, учитывающий направление, передавайте его как встроенное замыкание (или иным образом обеспечьте новый объект при каждой смене ключа) и добавьте тест вроде приведённого выше, чтобы рефакторинг в передачу метода не сломал это незаметно.

## Подводный камень: содержимое прыгает в центр или размер резко меняется

Стандартный `layoutBuilder` помещает уходящие дочерние виджеты и текущий в `Stack` с `alignment: Alignment.center`. Два видимых побочных эффекта:

- Содержимое, выровненное по левому краю, например подпись в `Row` или подзаголовок `ListTile`, во время перехода прыгает в центр.
- `Stack` имеет размер самого большого дочернего виджета, поэтому когда длинная строка заменяется короткой, место сжимается только после исчезновения старого виджета.

Оба случая исправляются собственным `layoutBuilder`, при желании обёрнутым в `AnimatedSize` для плавного изменения размера:

```dart
// Flutter 3.44.8, Dart 3.12.2
AnimatedSize(
  duration: const Duration(milliseconds: 200),
  alignment: Alignment.centerLeft,
  child: AnimatedSwitcher(
    duration: const Duration(milliseconds: 200),
    layoutBuilder: (currentChild, previousChildren) => Stack(
      alignment: Alignment.centerLeft,
      children: [
        ...previousChildren,
        if (currentChild != null) currentChild,
      ],
    ),
    child: Text(status, key: ValueKey(status)),
  ),
)
```

Держите `previousChildren` перед `currentChild`, чтобы входящий виджет рисовался сверху, как и в варианте по умолчанию.

## Подводный камень: состояние дочернего виджета теряется

Изменившийся ключ означает новый элемент. Любой `State` ниже переключаемого дочернего виджета, например контроллер `TextField`, созданный в `initState`, позиция прокрутки или флаг раскрытия, создаётся заново для входящего виджета. В моём тесте элемент до и после смены ключа был разными объектами. Обычно это именно то, что нужно для "показать другую вещь", но это неверный инструмент для "анимировать свойство той же вещи". Если пользователь вводит текст в поле, а вы строите ключ из этого текста, каждое нажатие клавиши пересоздаёт поле и сбрасывает фокус.

Для изменения свойств одного и того же виджета используйте неявную анимацию: `AnimatedDefaultTextStyle`, `AnimatedContainer`, `AnimatedOpacity` или `TweenAnimationBuilder` для произвольного значения. Они сохраняют элемент и интерполируют свойство. `AnimatedSwitcher` предназначен для замены содержимого, а ключ - это способ сообщить ему, что содержимое заменено. Если переход должен идти между экранами, а не внутри одного, посмотрите [Hero-анимацию между двумя экранами](/ru/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/) или [собственные переходы между страницами](/ru/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/).

## Чек-лист, если AnimatedSwitcher ничего не делает

1. Поставьте ключ на виджет, передаваемый напрямую как `child`, а не на что-то внутри него.
2. Стройте ключ из данных, которые должны запускать переход, обычно `ValueKey(value)`, и никогда не используйте `UniqueKey()`, создаваемый в `build`.
3. Проверьте, что ключ действительно меняется: постоянный `ValueKey('x')` для этой цели равен отсутствию ключа.
4. Убедитесь, что сам `AnimatedSwitcher` не пересоздаётся: если предок меняет тип или ключ, состояние переключателя создаётся с нуля, и первый дочерний виджет показывается без анимации (`initState` вызывает `_addEntryForNewChild(animate: false)`).
5. Если вы используете `transitionBuilder`, учитывающий направление, передавайте его как встроенное замыкание, чтобы уходящие записи перестраивались.
6. Исправляйте выравнивание и размер с помощью собственного `layoutBuilder` и `AnimatedSize`.

### Читайте дальше

- [Что такое Flutter Key и когда его отсутствие вызывает ошибки?](/ru/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [Как показывать состояния загрузки и ошибки через AsyncValue во Flutter Riverpod](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Как добавить Hero-анимацию между двумя экранами во Flutter](/ru/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/)
- [Миграция собственных переходов между страницами после реорганизации построителей переходов страниц во Flutter](/ru/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/)
- [Исправление: setState() или markNeedsBuild() вызван во время build во Flutter](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)

## Источники

- [AnimatedSwitcher class, Flutter API docs](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher-class.html)
- [AnimatedSwitcher.layoutBuilder, Flutter API docs](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher/layoutBuilder.html)
- [Widget.canUpdate, Flutter API docs](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [animated_switcher.dart on the stable branch, flutter/flutter](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/widgets/animated_switcher.dart)
- [Implicit animations, Flutter docs](https://docs.flutter.dev/codelabs/implicit-animations)
