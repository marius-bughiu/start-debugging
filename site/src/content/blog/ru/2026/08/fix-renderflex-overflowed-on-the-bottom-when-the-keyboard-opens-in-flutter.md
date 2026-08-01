---
title: "Исправление: A RenderFlex overflowed by N pixels on the bottom при открытии клавиатуры во Flutter"
description: "Клавиатура уменьшает максимальную высоту тела Scaffold, поэтому Column, которая едва помещалась, теперь переполняется. Оберните тело в скроллируемый виджет вместо отключения resizeToAvoidBottomInset."
pubDate: 2026-08-01
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "keyboard"
lang: "ru"
translationOf: "2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-01
---

Оберните тело `Scaffold` в `SingleChildScrollView` (или превратите `Column` в `ListView`). Клавиатура не накладывается на ваш layout, она его сжимает: `Scaffold` вычитает `MediaQuery.viewInsets.bottom` из максимальной высоты, которую передаёт телу, поэтому `Column`, ровно заполнявшая экран, теперь выходит за бюджет ровно на высоту клавиатуры. Установка `resizeToAvoidBottomInset: false` тоже убирает полосатую метку, но делает это ценой того, что клавиатура закрывает ваше текстовое поле, а этого почти никогда не хотят. Пост написан для Flutter 3.x (проверено на 3.44) и Dart 3.x.

```text
The following assertion was thrown during layout:
A RenderFlex overflowed by 291 pixels on the bottom.

The relevant error-causing widget was:
  Column  Column:file:///Users/me/app/lib/screens/login_screen.dart:37:18

The overflowing RenderFlex has an orientation of Axis.vertical.
The edge of the RenderFlex that is overflowing has been marked in the
rendering with a yellow and black striped pattern.
```

Признак того, что это именно вариант с клавиатурой, а не [обычное переполнение RenderFlex](/ru/2026/05/fix-renderflex-overflowed-in-flutter/), это момент возникновения: layout чистый, пока вы не коснётесь `TextField`, число в сообщении подозрительно близко к высоте клавиатуры (от 250 до 350 логических пикселей на большинстве телефонов), и оно исчезает, как только клавиатура закрывается.

## Почему клавиатура сжимает тело, а не накрывает его

На Android шаблон проекта Flutter задаёт `android:windowSoftInputMode="adjustResize"` для `MainActivity`, поэтому платформа меняет размер представления Flutter, а не сдвигает его. Движок сообщает Dart о закрытой области через `MediaQueryData.viewInsets`, и документация API определяет это точно: когда клавиатура мобильного устройства видима, `viewInsets.bottom` соответствует верхней границе клавиатуры.

Дальше арифметику выполняет `Scaffold`. В `_ScaffoldState.build` он вычисляет минимальные отступы, которые надо оставить свободными:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final EdgeInsets minInsets = MediaQuery.paddingOf(
  context,
).copyWith(bottom: _resizeToAvoidBottomInset ? MediaQuery.viewInsetsOf(context).bottom : 0.0);
```

а в `_ScaffoldLayout.performLayout` превращает их в бюджет высоты для тела:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final double contentBottom = math.max(
  0.0,
  bottom - math.max(minInsets.bottom, bottomWidgetsHeight),
);

if (hasChild(_ScaffoldSlot.body)) {
  double bodyMaxHeight = math.max(0.0, contentBottom - contentTop);
  // ...
```

`_resizeToAvoidBottomInset` равно `widget.resizeToAvoidBottomInset ?? true`, то есть это путь по умолчанию. На экране высотой 852 пикселя с app bar в 56 пикселей и клавиатурой в 291 пиксель значение `maxHeight` для тела падает с 796 до 505. Ваша `Column` по-прежнему хочет 796. `RenderFlex` не обрезает и не прокручивает, поэтому он рисует полосатое предупреждение и сообщает разницу, а это ровно те самые 291 пиксель из сообщения. Число совпадает с высотой клавиатуры, потому что раньше layout помещался без единого пикселя запаса.

## Воспроизведение, которое помещается на экран, а потом перестаёт

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: LoginScreen()));

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const FlutterLogo(size: 160),
            const TextField(decoration: InputDecoration(labelText: 'Email')),
            const TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
            FilledButton(onPressed: () {}, child: const Text('Sign in')),
          ],
        ),
      ),
    );
  }
}
```

Это отрисовывается идеально. Коснитесь любого из полей, и появляется переполнение. В дереве виджетов ничего не изменилось, изменилась только входящая `maxHeight`.

## Решения в том порядке, в котором их стоит пробовать

### 1. Сделайте тело прокручиваемым

Это правильное решение практически для любой формы, и именно его рекомендует [документация по типичным ошибкам Flutter](https://docs.flutter.dev/testing/common-errors) для переполнения снизу. Viewport даёт своему потомку неограниченное пространство по главной оси, поэтому `Column` перестаёт зависеть от того, что клавиатура сделала со `Scaffold`:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: SingleChildScrollView(
  padding: const EdgeInsets.all(24),
  child: Column(
    children: [
      const FlutterLogo(size: 160),
      const SizedBox(height: 24),
      const TextField(decoration: InputDecoration(labelText: 'Email')),
      const SizedBox(height: 12),
      const TextField(
        obscureText: true,
        decoration: InputDecoration(labelText: 'Password'),
      ),
      const SizedBox(height: 24),
      FilledButton(onPressed: () {}, child: const Text('Sign in')),
    ],
  ),
),
```

Заодно поправьте ещё две вещи. Уберите `mainAxisAlignment: MainAxisAlignment.spaceBetween`: внутри viewport доступное пространство бесконечно, поэтому выравниванию по главной оси нечего распределять и оно молча ничего не делает. Замените отступы явными `SizedBox`. А если список длинный или строится из данных, используйте `ListView` или `ListView.builder`, чтобы потомки создавались лениво; компромиссы здесь те же, что описаны в [shrinkWrap vs Expanded vs slivers для длинных списков](/ru/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

У этого решения есть бонус: `EditableText` прокручивает сфокусированное поле в видимую область через ближайший предок `Scrollable`, с отступом из `TextField.scrollPadding`, значение по умолчанию `EdgeInsets.all(20.0)`. Без прокручиваемого предка прокручивать нечего, и именно поэтому поле под вашим пальцем иногда остаётся скрытым, даже когда переполнение не видно.

### 2. Заполнять экран, когда есть место, и прокручивать, когда его нет

У решения со scroll view есть косметическая цена: на высоком экране с закрытой клавиатурой содержимое сбивается кверху вместо того, чтобы распределиться. Шаблон из [документации API SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html) исправляет это, задавая `Column` минимальную высоту, равную viewport, и заставляя её быть ровно такой высоты, как её содержимое, когда оно больше:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: LayoutBuilder(
  builder: (context, viewportConstraints) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: viewportConstraints.maxHeight - 48),
        child: IntrinsicHeight(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: const [
              FlutterLogo(size: 160),
              TextField(decoration: InputDecoration(labelText: 'Email')),
              TextField(
                obscureText: true,
                decoration: InputDecoration(labelText: 'Password'),
              ),
            ],
          ),
        ),
      ),
    );
  },
),
```

Обе обёртки несут нагрузку. Без `ConstrainedBox` колонка сжимается по содержимому и никогда не заполняет высокий экран; без `IntrinsicHeight` она принимает минимальную высоту, даже когда потомкам нужно больше, и вы снова получаете переполнение. `LayoutBuilder` видит ограничения уже с учётом клавиатуры, потому что находится внутри слота тела, так что из `viewportConstraints.maxHeight` клавиатура уже вычтена.

Документация прямо говорит о цене: поддерево раскладывается дважды, один раз для внутренних размеров и один раз по-настоящему. Для формы входа приемлемо, для страницы настроек на пятьдесят строк плохо.

### 3. Используйте SliverFillRemaining вместо IntrinsicHeight

Если проход по внутренним размерам заметен во времени кадра, выразите то же намерение через slivers. `SliverFillRemaining(hasScrollBody: false)` позволяет потомку заполнить оставшийся viewport, и по контракту API, если протяжённость потомка превышает viewport, sliver уступает размеру потомка вместо того, чтобы его переопределять, а это ровно то поведение, которое нужно при появлении клавиатуры:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: CustomScrollView(
  slivers: [
    SliverFillRemaining(
      hasScrollBody: false,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: const [
            FlutterLogo(size: 160),
            TextField(decoration: InputDecoration(labelText: 'Email')),
            TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
          ],
        ),
      ),
    ),
  ],
),
```

Одно правило, которое надо помнить: всё, что находится непосредственно внутри `CustomScrollView.slivers`, обязано быть sliver. Если положить туда `Column` без обёртки, вы получите [RenderViewport expected a RenderSliver child](/ru/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/).

### 4. resizeToAvoidBottomInset: false, и только осознанно

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Scaffold(
  resizeToAvoidBottomInset: false,
  body: /* ... */,
)
```

Перечитайте исходный код выше: это выставляет `minInsets.bottom` в `0.0`, тело сохраняет полную высоту, а клавиатура рисуется поверх всего, что там внизу. Ничего не исправлено, просто предупреждению о переполнении не о чем предупреждать. Это оправдано на экране, где поле ввода находится в верхней трети, на полноэкранной карте или изображении с камеры, где изменение размера выглядело бы резко, или на экране чата, где вы сами управляете отступом. Для формы это неверный ответ, потому что за клавиатурой оказывается именно то поле, в котором пользователь печатает.

## Детали, из-за которых ходят по кругу

**Внутри тела Scaffold `viewInsets.bottom` равно `0`.** Это самая запутанная часть всей темы. `Scaffold` передаёт телу изменённый `MediaQuery`:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
if (removeBottomInset) {
  data = data.removeViewInsets(removeBottom: true);
}
```

а слот тела регистрируется с `removeBottomInset: _resizeToAvoidBottomInset`. Поэтому при настройках по умолчанию виджет внутри `Scaffold.body`, читающий `MediaQuery.viewInsetsOf(context).bottom`, получает `0.0` даже при открытой клавиатуре, потому что `Scaffold` уже израсходовал этот отступ, сжав тело. Добавление вручную `Padding(padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom))` там ничего не даёт. Чтобы прочитать настоящее значение, читайте его выше `Scaffold` или задайте `resizeToAvoidBottomInset: false` и возьмите обработку отступа на себя.

**Модальные bottom sheet это исключение.** Маршрут `showModalBottomSheet` не является телом `Scaffold`, поэтому там `viewInsets` не тронут и приём с padding работает правильно. Совмещайте его с `isScrollControlled: true`, иначе высота листа ограничится половиной экрана:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
showModalBottomSheet(
  context: context,
  isScrollControlled: true,
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: const ComposeForm(),
  ),
);
```

**bottomNavigationBar не складывается с клавиатурой.** В `contentBottom` используется `math.max(minInsets.bottom, bottomWidgetsHeight)`, а не сумма. Как только клавиатура выше панели навигации, тело сжимается только на высоту клавиатуры, а сама панель сохраняет своё место внизу scaffold, под клавиатурой. Если она должна исчезать во время ввода, скрывайте её сами: прочитайте `MediaQuery.viewInsetsOf(context).bottom` из `Builder`, размещённого выше `Scaffold`, и передайте `bottomNavigationBar: inset > 0 ? null : const MyNavBar()`.

**Кто-то поменял `windowSoftInputMode` на `adjustPan`.** Если на Android переполнение не появляется, но поле закрыто, или `viewInsets.bottom` навсегда остаётся `0`, проверьте `android/app/src/main/AndroidManifest.xml`. Шаблон Flutter поставляет `android:windowSoftInputMode="adjustResize"`; когда-то ответ на Stack Overflow убедил кого-то перейти на `adjustPan`, и теперь платформа сдвигает окно вместо того, чтобы сообщать об отступе.

**Обернуть виновника в `Expanded` здесь неверный рефлекс.** `Expanded` это решение для горизонтального случая, когда один жадный потомок съедает `Row`. В случае с клавиатурой все потомки уже имеют естественный размер, и сумма просто превышает бюджет, поэтому `Expanded` либо отбирает место у виджета, которому оно было нужно, либо переносит переполнение на соседа. А `Expanded`, оказавшийся вне `Flex`, вместо этого даст вам [Incorrect use of ParentDataWidget](/ru/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/).

**Закрывайте клавиатуру при перетаскивании.** Как только тело начинает прокручиваться, добавьте `keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag` к scroll view. Это одна строка, и она снимает самую частую претензию к экранам с формами.

**Похожие ошибки.** `Vertical viewport was given unbounded height` это зеркальный случай, прокручиваемый виджет внутри неограниченного родителя, разобранный в [вложении ListView внутрь Column](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/). `RenderBox was not laid out` обычно это второе исключение после настоящего сбоя layout; прокрутите вверх к первому. А если переполнение появляется при масштабе текста 1.5x, а не при открытии клавиатуры, это тот же класс ошибки с другим триггером, подробно разобранный в [общем посте о переполнении RenderFlex](/ru/2026/05/fix-renderflex-overflowed-in-flutter/).

## Связанные материалы

- [Исправление: A RenderFlex overflowed by N pixels во Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) это родительский пост для горизонтального варианта и варианта с масштабом текста той же проверки.
- [Как вложить ListView в Column без ошибки о неограниченной высоте](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) разбирает случай, когда сама форма содержит список.
- [shrinkWrap vs Expanded vs slivers для длинных списков во Flutter](/ru/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) объясняет, почему `ListView.builder` выигрывает у `SingleChildScrollView`, когда содержимое растёт.
- [Исправление: RenderViewport expected a RenderSliver child](/ru/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) это ошибка, которая ждёт вас на пути со slivers.
- [Исправление: Incorrect use of ParentDataWidget, Expanded должен быть внутри Flex](/ru/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) описывает, чем оборачивается слишком поспешное обращение к `Expanded`.

## Источники

- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors), официальная страница, определяющая проверку переполнения RenderFlex и её канонические решения.
- [Scaffold.resizeToAvoidBottomInset](https://api.flutter.dev/flutter/material/Scaffold/resizeToAvoidBottomInset.html), где задокументировано значение по умолчанию `true` и зависимость от `MediaQueryData.viewInsets`.
- [MediaQueryData.viewInsets](https://api.flutter.dev/flutter/widgets/MediaQueryData/viewInsets.html), источник определения "viewInsets.bottom соответствует верхней границе клавиатуры" и разграничения с `padding` и `viewPadding`.
- [scaffold.dart в ветке stable](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/scaffold.dart), где находятся `minInsets`, `contentBottom` и вызов `removeViewInsets` для тела.
- [Справочник класса SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html), где описан рецепт `LayoutBuilder` плюс `ConstrainedBox` плюс `IntrinsicHeight` и его цена.
- [Справочник класса SliverFillRemaining](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html), для точной семантики `hasScrollBody: false`.
- [EditableText.scrollPadding](https://api.flutter.dev/flutter/widgets/EditableText/scrollPadding.html), где объясняется автоматическая прокрутка в видимую область и значение по умолчанию `EdgeInsets.all(20.0)`.
