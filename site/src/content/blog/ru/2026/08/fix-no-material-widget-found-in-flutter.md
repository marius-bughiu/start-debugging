---
title: "Исправление: No Material widget found во Flutter"
description: "Оберните поддерево в Material(type: MaterialType.transparency) или поместите экран в Scaffold. Сам по себе MaterialApp не даёт предка Material, поэтому TextField и InkWell падают."
pubDate: 2026-08-04
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material"
lang: "ru"
translationOf: "2026/08/fix-no-material-widget-found-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-04
---

`No Material widget found` означает, что только что построенный виджет (`TextField`, `InkWell`, `ListTile`, `Chip`, `Switch`, `Slider` и им подобные) прошёл вверх по дереву в поисках предка `Material` и не нашёл его. Самое быстрое безопасное исправление: обернуть поддерево в `Material(type: MaterialType.transparency, child: ...)`, что визуально ничего не меняет. Структурное исправление: поместить экран внутрь `Scaffold`. Обратите внимание, что `MaterialApp` сам по себе **не** предоставляет `Material`. Проверено на Flutter 3.44 stable, Dart 3.x.

## Ошибка в контексте

Утверждение выбрасывается из метода `build` падающего виджета, поэтому первая строка называет виджет, который не смог найти своего предка:

```
======== Exception caught by widgets library ===================================
The following assertion was thrown building TextField(dirty, state: _TextFieldState#3f2a1):
No Material widget found.

TextField widgets require a Material widget ancestor within the closest LookupBoundary.
In Material Design, most widgets are conceptually "printed" on a sheet of
material. In Flutter's material library, that material is represented by the
Material widget. It is the Material widget that renders ink splashes, for
instance. Because of this, many material library widgets require that there be
a Material widget in the tree above them.

To introduce a Material widget, you can either directly include one, or use a
widget that contains Material itself, such as a Card, Dialog, Drawer, or
Scaffold.

The specific widget that could not find a Material ancestor was:
  TextField
The ancestors of this widget were:
  Center
  Semantics
  ...
```

Есть и вторая формулировка, которая может встретиться вместо этой, и она описывает по-настоящему другую проблему:

```
No Material widget found within the closest LookupBoundary.
There is an ancestor Material widget, but it is hidden by a LookupBoundary.
```

Она означает, что `Material` выше по дереву всё же есть, но `LookupBoundary` намеренно блокирует обход. Ниже для неё отведён отдельный раздел.

## Каким виджетам действительно нужен предок Material

Это важно, потому что список короче, чем «всё из `package:flutter/material.dart`». Поиск `assert(debugCheckHasMaterial(context))` по `packages/flutter/lib/src/material/` в ветке stable Flutter 3.44 даёт реальный набор:

- `InkWell`, `InkResponse` (через `InkResponse.debugCheckContext`) и `Ink`
- `TextField`
- `ListTile`
- `Chip`, `InputChip`, `ActionChip`, `ChoiceChip`, `FilterChip`
- `Checkbox`, `Radio`, `Switch`, `Slider`
- `DropdownButton`
- `DataTable`
- `TabBar`
- `Stepper`
- `ExpandIcon`

Не менее полезно то, чего в списке *нет*. `ElevatedButton`, `FilledButton`, `OutlinedButton`, `TextButton`, `FloatingActionButton`, `Card` и `Tooltip` проверку не выполняют, потому что каждый из них строит собственный `Material` внутри себя, а затем размещает поверхность для чернил под своим собственным потомком. Именно поэтому экран, полный кнопок, прекрасно работает вне `Scaffold` ровно до момента, когда вы добавляете один `TextField` и всё разваливается.

`IconButton` представляет собой особый случай, о котором стоит знать. Его проверка находится только в ветке кода для Material 2: `build` досрочно возвращает `_SelectableIconButton`, когда `theme.useMaterial3` равно true, а `assert(debugCheckHasMaterial(context))` идёт после этого return. Поскольку начиная с Flutter 3.16 значение `useMaterial3` по умолчанию равно `true`, обычному `IconButton` предок `Material` больше не нужен. Верните тему в `useMaterial3: false`, и проверка снова начнёт срабатывать.

## Почему MaterialApp недостаточно

Это та часть, на которой спотыкаются почти все, и по названию она не очевидна. `MaterialApp` даёт вам `Theme`, `MaterialLocalizations`, `Navigator`, `ScaffoldMessenger` и `WidgetsApp`. Он нигде не вставляет `Material`. В `packages/flutter/lib/src/material/app.dart` нет ни одной конструкции `Material(`.

`Material` приходит из `Scaffold`. Метод `build` его состояния оборачивает всю раскладку в него:

```dart
// Flutter 3.44, packages/flutter/lib/src/material/scaffold.dart
child: ScrollNotificationObserver(
  child: Material(
    color: widget.backgroundColor ?? themeData.scaffoldBackgroundColor,
    child: Builder(...),
  ),
),
```

То же верно для `Card`, `Dialog`, `Drawer` и листа, который строит `showModalBottomSheet`: каждый из них создаёт `Material` вокруг своего потомка. Это ровно тот список, который приводит подсказка в тексте ошибки, и он такой именно потому, что это виджеты, которые действительно так делают.

## Минимальное воспроизведение

Двенадцать строк, и падение на первом кадре:

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      home: Center(child: TextField()), // throws: No Material widget found.
    );
  }
}
```

Замените `TextField` на `ElevatedButton`, и всё отрисуется. Замените на `ListTile`, и падение повторится. Виноват никогда не `MaterialApp`, а отсутствие `Scaffold` (или любого другого носителя `Material`) между приложением и виджетом.

## Исправление 1: поместите экран внутрь Scaffold

Если падающий виджет является частью экрана, это правильное исправление, а не обходной путь. Вы получаете `Material`, а вместе с ним цвет фона, место под панель приложения, обработку безопасной зоны и отступы под клавиатуру, на которые виджет неявно рассчитывал:

```dart
// Flutter 3.44, Dart 3.x
class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Sign in')),
        body: const Padding(
          padding: EdgeInsets.all(16),
          child: TextField(
            decoration: InputDecoration(labelText: 'Email'),
          ),
        ),
      ),
    );
  }
}
```

Берите одно из остальных исправлений только тогда, когда `Scaffold` действительно неуместен: запись в overlay, тест виджета, фрагмент, отрисованный вне обычного дерева маршрутов.

## Исправление 2: Material с MaterialType.transparency

Когда нужна поверхность для чернил, но не визуальные эффекты, это исправление не стоит вам ничего:

```dart
// Flutter 3.44, Dart 3.x
Material(
  type: MaterialType.transparency,
  child: InkWell(
    onTap: _handleTap,
    child: const Padding(
      padding: EdgeInsets.all(12),
      child: Text('Tap me'),
    ),
  ),
)
```

Тип важнее, чем кажется. От него зависят две вещи, обе видны в методе build класса `Material`:

```dart
// Flutter 3.44, packages/flutter/lib/src/material/material.dart
final Color? backgroundColor = widget.color ?? switch (widget.type) {
  MaterialType.canvas => theme.canvasColor,
  MaterialType.card => theme.cardColor,
  MaterialType.button || MaterialType.circle || MaterialType.transparency => null,
};
// ...
child: _InkFeatures(
  absorbHitTest: widget.type != MaterialType.transparency,
  color: backgroundColor,
  ...
),
```

Голый `Material(child: ...)` по умолчанию использует `MaterialType.canvas`, который рисует непрозрачный прямоугольник цвета `theme.canvasColor` поверх всего, что было позади, и выставляет `absorbHitTest: true`, поглощая события указателя, ранее проходившие к виджетам ниже. `MaterialType.transparency` ничего не рисует и ничего не поглощает. Если вы латаете существующую раскладку, всегда начинайте с `transparency`, чтобы не обменять падение на молча сломанный жест или белый прямоугольник поверх градиента.

От чего `transparency` вас не избавляет: `Material` всегда оборачивает своего потомка в `AnimatedDefaultTextStyle` со стилем `widget.textStyle ?? Theme.of(context).textTheme.bodyMedium`. Если `Text` без стиля внутри только что обёрнутого поддерева внезапно изменил размер или цвет, причина в этом. Передайте явный `textStyle` или задайте стиль на самих виджетах `Text`.

## Исправление 3: используйте контейнерный виджет, который уже несёт Material

Иногда правильный ответ состоит не в `Scaffold` и не в голом `Material`, потому что контейнер вам и так был нужен:

```dart
// Flutter 3.44, Dart 3.x
Card(
  child: ListTile(                    // ListTile asserts; Card supplies the Material
    leading: const Icon(Icons.person),
    title: const Text('Marius'),
    onTap: _openProfile,
  ),
)
```

`showDialog`, `showModalBottomSheet` и `Drawer` дают `Material` бесплатно, поэтому `ListTile` и `TextField` работают внутри них без `Scaffold`. Следить стоит за сценарием с `showGeneralDialog`: его `pageBuilder` возвращает ваш виджет как есть, без какой-либо обёртки `Material`. Оберните его сами или используйте `Dialog`.

С записями `Overlay` та же форма проблемы. Builder у `OverlayEntry` монтируется как потомок `Overlay`, а не вашего `Scaffold`, поэтому он не наследует `Material` из `Scaffold`, как бы глубоко в дереве ни находился код, который его вставил.

## Исправление 4: тем, кто использует WidgetsApp, нужен MaterialApp

Если корнем вашего приложения служит `WidgetsApp` или `CupertinoApp`, а виджеты Material вы всё равно применяете, вы получите эту ошибку плюс её родственницу `No MaterialLocalizations found`. Это закрыли как некорректное использование в [flutter/flutter#103843](https://github.com/flutter/flutter/issues/103843), и сопровождающие правы: либо переходите на `MaterialApp`, либо добавляйте области `Material` и `Localizations` самостоятельно. `MaterialApp` оказывается более дешёвым ответом почти для всех.

## Вариант с LookupBoundary

Формулировка `within the closest LookupBoundary` означает, что обход был перехвачен. `debugCheckHasMaterial` использует `LookupBoundary.findAncestorWidgetOfExactType<Material>(context)`, а не обычный обход элементов, и `LookupBoundary` останавливает его намертво, даже когда выше сидит вполне пригодный `Material`.

В коде фреймворка такую границу вставляет единственное место, а именно `view.dart`:

```dart
// Flutter 3.44, packages/flutter/lib/src/widgets/view.dart (ViewAnchor.build)
return _MultiChildComponentWidget(
  views: <Widget>[if (view != null) LookupBoundary(child: view!)],
  child: child,
);
```

Поэтому если вы отрисовываете во вторую `FlutterView` через `ViewAnchor` (всплывающая подсказка в собственном представлении платформы, второе окно на десктопе), граница поставлена намеренно: содержимое того представления образует отдельное дерево отрисовки, и оно не должно молча зависеть от предков в родительском представлении. Исправление в том, чтобы дать новому представлению собственный `Material` (или собственный `Scaffold`), а не пытаться пробиться сквозь границу. Это один из самых острых углов, когда вы [включаете поддержку нескольких окон в десктопном приложении на Flutter](/ru/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/).

Если `LookupBoundary` вставили вы сами, чтобы изолировать поддерево, действует то же правило: всё, что нужно поддереву, должно находиться внутри него.

## Подводные камни и похожие ошибки

**В debug падает, в release нет.** `debugCheckHasMaterial` обёрнут в `assert(() { ... }())`, поэтому из release-сборок он вырезается целиком, и функция просто возвращает `true`. `TextField` без `Material` отрисуется в `--release` и упадёт в debug, и это ровно та путаница, что стоит за issue 103843. Не считайте «в release работает» доказательством, что с деревом всё в порядке. Как только чернильный эффект действительно сработает, выполнится `Material.of(context)`, а он выбрасывает исключение и в release: "Material.of() was called with a context that does not contain a Material widget."

**Всплеск не виден, но ошибки нет.** Другой баг, тот же район. Чернильные всплески рисуются на самом `Material`, *под* всем, что нарисовано сверху, поэтому `InkWell`, обёрнутый в `Container(color: ...)`, рисует свой всплеск за непрозрачной заливкой контейнера. Замените `Container(color: x)` на `Ink(color: x)` (или задайте цвет на `Material`), потому что `Ink` рисует своё оформление на родительском `Material`, и всплеск оказывается сверху. Смежная тема: [Cannot provide both a color and a decoration в Container во Flutter](/ru/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/).

**Тесты виджетов падают там, где приложение работает.** `tester.pumpWidget(const TextField())` падает по той же причине, что и `runApp`. Тестам виджетов нужны явно прописанные предки: `MaterialApp(home: Scaffold(body: TextField()))` или как минимум `Material(child: Directionality(textDirection: TextDirection.ltr, child: ...))`. Отсутствие `Directionality` и отсутствие `MediaQuery` дают ошибку той же формы из `debugCheckHasDirectionality` и `MediaQuery.of`.

**Не оборачивайте всё приложение в один Material.** Это работает, и это ловушка. Единственный `Material` на уровне приложения заставляет все чернильные всплески отрисовываться на одной поверхности, ломает цвета фона на уровне отдельных экранов и применяет один стиль текста `bodyMedium` по умолчанию везде. Добавляйте `Material` в минимальной области, которой достаточно для устранения ошибки.

**Вложенный Material меняет поверхность, на которую ложатся всплески.** `Material.of` находит *ближайшего* предка, поэтому внутренний `Material` с `borderRadius` или `shape` обрезает всплески по этой форме. Обычно для собственной карточки это то, что нужно, а изредка это и есть причина, почему всплеск выглядит квадратным там, где вы ждали скруглённый.

**`No MaterialLocalizations found` относится к другому отсутствующему предку.** Тот же механизм обхода вверх, другая область, ошибку выдаёт `debugCheckHasMaterialLocalizations`. Добавление `Material` её не исправит; поможет `MaterialApp` или делегат `Localizations`.

## Похожие материалы

- [Исправление: ScaffoldMessenger.of() was called with a context that does not contain a Scaffold](/ru/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/): тот же сбой поиска предка на уровень выше, плюс приём с `Builder` для получения контекста ниже нужного виджета.
- [Исправление: Looking up a deactivated widget's ancestor is unsafe во Flutter](/ru/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/): когда предок существует, но поиск происходит в неподходящий момент жизненного цикла.
- [Исправление: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/ru/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/): ещё одно структурное утверждение «не то место в дереве виджетов», которое Flutter ловит во время build.
- [Как включить поддержку нескольких окон в десктопном приложении на Flutter](/ru/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/): где `LookupBoundary` начинает блокировать поиск предков в реальных приложениях.
- [Как задать акцентный цвет в приложении на Flutter через ColorScheme в Material 3](/ru/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/): значения `canvasColor` и `scaffoldBackgroundColor`, которые `Material` подхватывает, если вы не передали свой цвет.

## Источники

- [debugCheckHasMaterial, справочник API Flutter](https://api.flutter.dev/flutter/material/debugCheckHasMaterial.html): само утверждение, включая ветку с `LookupBoundary` и точный текст подсказки.
- [Класс Material, справочник API Flutter](https://api.flutter.dev/flutter/material/Material-class.html): значения `MaterialType`, обрезка, подъём и способ подключения чернильных эффектов.
- [Класс Ink, справочник API Flutter](https://api.flutter.dev/flutter/material/Ink-class.html): почему всплески скрываются непрозрачным оформлением, нарисованным поверх `Material`, и как `Ink` этого избегает.
- [flutter/flutter#103843: Error "No Material widget found.", but not in release build](https://github.com/flutter/flutter/issues/103843): подтверждённое сопровождающими утверждение, работающее только в debug, закрыто как некорректное использование `WidgetsApp`.
- [flutter/flutter `packages/flutter/lib/src/material/debug.dart` (stable)](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/debug.dart): исходный код `debugCheckHasMaterial` и `debugCheckHasMaterialLocalizations`.
