---
title: "Как определить собственные дизайн-токены через ThemeExtension и анимировать их при переключении между светлой и тёмной темой во Flutter"
description: "Унаследуйте класс от ThemeExtension, зарегистрируйте по одному экземпляру в каждом ThemeData через список extensions, читайте его через Theme.of(context).extension<T>() и напишите настоящий lerp, чтобы AnimatedTheme в MaterialApp интерполировал ваши токены при переключении светлой и тёмной темы. Разобраны цвета, радиусы, тени, текстовые стили и булевы значения, падение при отсутствующем расширении, ловушка copyWith, которая отбрасывает все остальные расширения, и причина, по которой нужны == и hashCode. Всё проверено виджет-тестами на Flutter 3.44.8."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "theming"
  - "material-3"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Краткий ответ:** создайте класс с аннотацией `@immutable`, наследующий `ThemeExtension<AppTokens>`, добавьте в него поля, нужные вашей дизайн-системе (цвета, радиусы, отступы, тени, текстовые стили), и реализуйте `copyWith` и `lerp`. Положите один экземпляр в `ThemeData(extensions: [...])` для `theme` и другой для `darkTheme`, а затем читайте его где угодно через `Theme.of(context).extension<AppTokens>()!`. `MaterialApp` уже оборачивает ваше приложение в `AnimatedTheme`, который на каждом кадре при смене темы вызывает `ThemeData.lerp`, а тот, в свою очередь, вызывает ваш `lerp`. Если ваш `lerp` интерполирует каждое поле через `Color.lerp`, `lerpDouble`, `BorderRadius.lerp` и им подобные, ваши токены плавно переходят между светлой и тёмной темой за те же 200 мс, что и встроенная `ColorScheme`. Всё описанное ниже проверено виджет-тестами на Flutter 3.44.8 (Dart 3.12.2).

Дальше в статье разбирается, чем `ThemeExtension` на самом деле является внутри `ThemeData`, приводится полный класс токенов с семью разными типами полей, подключение в `MaterialApp`, управление анимацией и четыре ловушки, на которые я наткнулся в тестах: расширение, существующее только в одной теме, `copyWith`, молча удаляющий другие ваши расширения, анимация, перезапускающаяся при каждой перестройке, и булевы значения, переключающиеся ровно на половине пути.

## Почему ColorScheme недостаточно для дизайн-токенов

В `ColorScheme` из Material 3 около 45 ролей, и если задать фирменный цвет через `ColorScheme.fromSeed`, вы бесплатно получаете согласованную палитру (см. [как задать акцентный цвет через ColorScheme в Material 3](/ru/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)). Но в настоящей дизайн-системе есть токены, о которых Material не задумывался: зелёный цвет "success", не совпадающий с `tertiary`, приподнятая поверхность карточки, отличающаяся от `surfaceContainerHigh` на пару процентов, текстовый стиль для блоков кода, радиус карточки, тень, которая есть в светлой теме и исчезает в тёмной.

Все обычные обходные пути плохи. Глобальный класс `AppColors` со статическими константами не может меняться вместе с яркостью. Тернарный оператор `context.isDark ? x : y`, разбросанный по виджетам, переключается мгновенно, пока остальное приложение анимируется, и это выглядит как сбой. Собственный `InheritedWidget` работает, но тогда вам придётся заново строить механизм анимации, который в `ThemeData` уже есть.

`ThemeExtension` появился во Flutter 3.0 (PR #98033) именно для этого. Он позволяет подвесить к `ThemeData` собственные типизированные объекты, а поскольку `ThemeData.lerp` о них знает, они участвуют в анимациях темы.

## Что ThemeData делает с вашим расширением

Весь механизм достаточно мал, чтобы прочитать его за один присест. Из `packages/flutter/lib/src/material/theme_data.dart` во Flutter 3.44.8:

```dart
// Flutter 3.44.8, theme_data.dart (abridged)
abstract class ThemeExtension<T extends ThemeExtension<T>> {
  const ThemeExtension();

  Object get type => T;

  ThemeExtension<T> copyWith();

  ThemeExtension<T> lerp(covariant ThemeExtension<T>? other, double t);
}

// On ThemeData:
final Map<Object, ThemeExtension<dynamic>> extensions;

T? extension<T>() => extensions[T] as T?;
```

Отсюда следуют три факта:

1. Расширения хранятся в `Map` с ключом `type`, то есть обобщённым аргументом `T`. Расширение каждого типа может быть не более одного, а поиск сводится к чтению из словаря.
2. `extension<T>()` возвращает `T?`. Если в текущей теме нет записи для `T`, вы получите `null`, а не исключение.
3. `lerp` целиком на вашей совести. Фреймворк никогда не заглядывает в ваши поля.

А вот как `ThemeData.lerp` объединяет два словаря:

```dart
// Flutter 3.44.8, ThemeData._lerpThemeExtensions
final Map<Object, ThemeExtension<dynamic>> newExtensions = a.extensions.map((
  Object id,
  ThemeExtension<dynamic> extensionA,
) {
  final ThemeExtension<dynamic>? extensionB = b.extensions[id];
  return MapEntry<Object, ThemeExtension<dynamic>>(id, extensionA.lerp(extensionB, t));
});
// Add [b]-only extensions.
newExtensions.addEntries(
  b.extensions.entries.where(
    (MapEntry<Object, ThemeExtension<dynamic>> entry) => !a.extensions.containsKey(entry.key),
  ),
);
```

Для каждого расширения из темы "откуда" вызывается `lerp(matching, t)`, где `matching` может быть `null`. Расширения, которые есть только в теме "куда", копируются без интерполяции. Запомните это для раздела с ловушками.

## Пошагово: создаём анимируемый набор токенов

1. Определите подкласс `ThemeExtension<AppTokens>` с аннотацией `@immutable` и только неnullable-полями.
2. Реализуйте `copyWith`, чтобы вызывающий код мог переопределять отдельные токены.
3. Реализуйте `lerp`, используя подходящий вспомогательный `lerp` для каждого типа поля.
4. Переопределите `==` и `hashCode`, чтобы равные наборы токенов считались равными.
5. Зарегистрируйте светлый экземпляр в `theme` и тёмный в `darkTheme`.
6. Читайте токены через геттер в расширении `BuildContext`.

### Шаги с 1 по 4: класс токенов

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:ui' show lerpDouble;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

@immutable
class AppTokens extends ThemeExtension<AppTokens> {
  const AppTokens({
    required this.surfaceRaised,
    required this.success,
    required this.cardRadius,
    required this.cardElevationShadow,
    required this.gap,
    required this.codeStyle,
    required this.useHairlineBorders,
  });

  final Color surfaceRaised;
  final Color success;
  final BorderRadius cardRadius;
  final List<BoxShadow> cardElevationShadow;
  final double gap;
  final TextStyle codeStyle;
  final bool useHairlineBorders;

  static const light = AppTokens(
    surfaceRaised: Color(0xFFFFFFFF),
    success: Color(0xFF1B873F),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x1F000000), blurRadius: 12, offset: Offset(0, 4)),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFF24292F)),
    useHairlineBorders: false,
  );

  static const dark = AppTokens(
    surfaceRaised: Color(0xFF1E2228),
    success: Color(0xFF4ADE80),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x00000000), blurRadius: 0, offset: Offset.zero),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFFE6EDF3)),
    useHairlineBorders: true,
  );

  @override
  AppTokens copyWith({
    Color? surfaceRaised,
    Color? success,
    BorderRadius? cardRadius,
    List<BoxShadow>? cardElevationShadow,
    double? gap,
    TextStyle? codeStyle,
    bool? useHairlineBorders,
  }) {
    return AppTokens(
      surfaceRaised: surfaceRaised ?? this.surfaceRaised,
      success: success ?? this.success,
      cardRadius: cardRadius ?? this.cardRadius,
      cardElevationShadow: cardElevationShadow ?? this.cardElevationShadow,
      gap: gap ?? this.gap,
      codeStyle: codeStyle ?? this.codeStyle,
      useHairlineBorders: useHairlineBorders ?? this.useHairlineBorders,
    );
  }

  @override
  AppTokens lerp(AppTokens? other, double t) {
    if (other is! AppTokens) return this;
    return AppTokens(
      surfaceRaised: Color.lerp(surfaceRaised, other.surfaceRaised, t)!,
      success: Color.lerp(success, other.success, t)!,
      cardRadius: BorderRadius.lerp(cardRadius, other.cardRadius, t)!,
      cardElevationShadow:
          BoxShadow.lerpList(cardElevationShadow, other.cardElevationShadow, t)!,
      gap: lerpDouble(gap, other.gap, t)!,
      codeStyle: TextStyle.lerp(codeStyle, other.codeStyle, t)!,
      useHairlineBorders: t < 0.5 ? useHairlineBorders : other.useHairlineBorders,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppTokens &&
          other.surfaceRaised == surfaceRaised &&
          other.success == success &&
          other.cardRadius == cardRadius &&
          listEquals(other.cardElevationShadow, cardElevationShadow) &&
          other.gap == gap &&
          other.codeStyle == codeStyle &&
          other.useHairlineBorders == useHairlineBorders;

  @override
  int get hashCode => Object.hash(
        surfaceRaised,
        success,
        cardRadius,
        Object.hashAll(cardElevationShadow),
        gap,
        codeStyle,
        useHairlineBorders,
      );
}
```

Некоторые решения здесь сделаны намеренно:

- **Неnullable-поля.** В официальном примере из репозитория Flutter (`examples/api/lib/material/theme/theme_extension.1.dart`) используется `Color?`. Это компилируется, но тогда в каждом месте использования нужны `!` или запасное значение, а `Color.lerp(null, x, t)` плавно проявляется из прозрачного, что редко бывает нужно. Если токен в вашей дизайн-системе есть всегда, делайте его обязательным.
- **Тип параметра `lerp` равен `AppTokens?`, а не `ThemeExtension<AppTokens>?`.** В базовой сигнатуре параметр помечен как `covariant`, поэтому его тип можно сузить. Проверка `other is! AppTokens` покрывает и случай `null`.
- **Для каждого типа поля есть подходящий статический `lerp`.** Существуют `Color.lerp`, `lerpDouble`, `BorderRadius.lerp`, `EdgeInsets.lerp`, `TextStyle.lerp`, `BoxShadow.lerpList`, `Gradient.lerp`, `Offset.lerp` и `Size.lerp`. Они возвращают nullable-типы, потому что принимают nullable-аргументы, отсюда `!`, когда оба аргумента не равны null.
- **Дискретные значения переключаются на середине пути.** У `true` и `false` нет осмысленного промежуточного значения. Сам `ThemeData` использует шаблон `t < 0.5 ? a : b` для таких вещей, как `platform` и `useMaterial3`, поэтому я его копирую.
- **"Исчезающая" тень это прозрачная тень, а не пустой список.** `BoxShadow.lerpList` умеет интерполировать списки разной длины, но тень с той же геометрией и нулевой альфой даёт чистый плавный переход. В моём тесте на полпути альфа тени составила `0.0608`, примерно половину светлого значения `0x1F` (`0.1216`), то есть именно тот плавный переход, который нужен.

### Шаг 5: регистрируем оба экземпляра

```dart
// Flutter 3.44.8
MaterialApp(
  theme: ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.light],
  ),
  darkTheme: ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: Colors.teal,
      brightness: Brightness.dark,
    ),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.dark],
  ),
  themeMode: themeMode, // ThemeMode.system, .light or .dark
  home: const HomePage(),
);
```

Больше для анимации ничего подключать не нужно. `_MaterialAppState._materialBuilder` выбирает `theme` или `darkTheme` в зависимости от `themeMode` и яркости платформы, а затем оборачивает поддерево в `AnimatedTheme(data: theme, duration: ..., curve: ...)`. Когда выбранный `ThemeData` меняется, `AnimatedTheme` запускает `ThemeDataTween`, чей `lerp` буквально равен `ThemeData.lerp(begin!, end!, t)`. Теперь ваши токены являются частью этого твина.

Это работает как тогда, когда ваш собственный код переключает `themeMode`, так и тогда, когда пользователь включает тёмный режим в ОС при `themeMode` равном `ThemeMode.system`.

### Шаг 6: читаем токены без лишней церемонии

`Theme.of(context).extension<AppTokens>()!` слишком длинно. Расширение `BuildContext` делает места использования похожими на код дизайн-системы:

```dart
// Flutter 3.44.8
extension AppTokensContext on BuildContext {
  AppTokens get tokens => Theme.of(this).extension<AppTokens>()!;
}

class TokenCard extends StatelessWidget {
  const TokenCard({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      padding: EdgeInsets.all(tokens.gap),
      decoration: BoxDecoration(
        color: tokens.surfaceRaised,
        borderRadius: tokens.cardRadius,
        boxShadow: tokens.cardElevationShadow,
        border: tokens.useHairlineBorders
            ? Border.all(color: Theme.of(context).colorScheme.outlineVariant, width: 0.5)
            : null,
      ),
      child: DefaultTextStyle.merge(style: tokens.codeStyle, child: child),
    );
  }
}
```

Поскольку `Theme.of` регистрирует зависимость от унаследованной темы, `TokenCard` перестраивается на каждом кадре анимации темы и видит интерполированные значения. Обратите внимание, что `Container` с одновременно заданными `color` и `decoration` выбрасывает исключение, поэтому цвет находится внутри `BoxDecoration` (полная история в [разборе ошибки "Cannot provide both a color and a decoration"](/ru/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)).

## Доказываем, что токены действительно анимируются

Визуальная проверка на 200 мс ненадёжна. Виджет-тест, который прокручивает время до середины анимации, надёжен:

```dart
// Flutter 3.44.8, flutter_test
AppTokens? seen;

class Probe extends StatelessWidget {
  const Probe({super.key});
  @override
  Widget build(BuildContext context) {
    seen = Theme.of(context).extension<AppTokens>();
    return const SizedBox();
  }
}

Widget app(ThemeMode mode) => MaterialApp(
      theme: ThemeData(extensions: const [AppTokens.light]),
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        extensions: const [AppTokens.dark],
      ),
      themeMode: mode,
      home: const Probe(),
    );

testWidgets('tokens interpolate during a theme switch', (tester) async {
  await tester.pumpWidget(app(ThemeMode.light));
  expect(seen!.surfaceRaised, AppTokens.light.surfaceRaised);

  await tester.pumpWidget(app(ThemeMode.dark));
  await tester.pump(const Duration(milliseconds: 100)); // halfway of 200 ms
  expect(seen!.surfaceRaised, isNot(AppTokens.light.surfaceRaised));
  expect(seen!.surfaceRaised, isNot(AppTokens.dark.surfaceRaised));

  await tester.pumpAndSettle();
  expect(seen!.surfaceRaised, AppTokens.dark.surfaceRaised);
});
```

На 100 мс цвет поверхности был `Color(red: 0.5588, green: 0.5667, blue: 0.5784)`, почти точная середина между белым и `#1E2228`. Кривая по умолчанию равна `Curves.linear`, поэтому `t` равно отношению прошедшего времени к длительности.

## Управление длительностью и кривой

`MaterialApp` предоставляет анимацию через два старых параметра и один новый:

```dart
// Flutter 3.44.8
MaterialApp(
  // Older API, still supported:
  themeAnimationDuration: const Duration(milliseconds: 350),
  themeAnimationCurve: Curves.easeInOut,

  // Newer API, takes precedence when non-null:
  themeAnimationStyle: AnimationStyle(
    duration: const Duration(milliseconds: 350),
    curve: Curves.easeInOutCubic,
  ),
  // ...
);
```

Значение по умолчанию равно `kThemeAnimationDuration`, то есть 200 мс. Если передать `themeAnimationStyle: AnimationStyle.noAnimation`, `AnimatedTheme` заменяется обычным `Theme`, и переключение происходит мгновенно. Я убедился, что в этом режиме уже самый первый кадр после переключения сообщает тёмный `surfaceRaised`. Это правильная настройка для golden-тестов и для пользователей, включивших "уменьшение движения", которое можно прочитать через `MediaQuery.disableAnimationsOf(context)`.

## Ловушки, проявившиеся в тестах

### Расширение, отсутствующее в одной теме, ломается в конце анимации

Допустим, вы зарегистрировали `AppTokens.light` в `theme`, но забыли про `darkTheme`. Во время анимации `_lerpThemeExtensions` вызывает `AppTokens.light.lerp(null, t)`, который возвращает `this`, поэтому виджеты продолжают видеть светлые токены. В моём тесте кадр на середине вернул экземпляр `AppTokens`. Затем твин доходит до `t == 1.0`, `Tween.transform` возвращает `end` напрямую, а в `end` нет никакого `AppTokens`. `extension<AppTokens>()` возвращает `null`, и `context.tokens` выбрасывает ошибку проверки на null на последнем кадре.

В итоге получается падение, которое происходит только после переключения темы, а такое проще всего пропустить. Решение структурное: собирайте обе темы одной функцией, чтобы список расширений всегда присутствовал.

```dart
// Flutter 3.44.8
ThemeData buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  return ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal, brightness: brightness),
    extensions: <ThemeExtension<dynamic>>[
      isDark ? AppTokens.dark : AppTokens.light,
    ],
  );
}
```

### ThemeData.copyWith(extensions: ...) заменяет весь словарь

Эта ловушка срабатывает, когда вы переопределяете один токен для одного поддерева. Исходный код `ThemeData.copyWith` таков:

```dart
extensions: (extensions != null) ? _themeExtensionIterableToMap(extensions) : this.extensions,
```

Слияния нет. В моём тесте тема с `AppTokens` и `BrandTokens`, прошедшая через `copyWith(extensions: [BrandTokens(...)])`, вернула `null` из `extension<AppTokens>()`. Чтобы переопределить одно расширение и сохранить остальные, сначала разверните существующие значения. Более поздние элементы побеждают, потому что словарь строится циклом `for` с ключом `type`:

```dart
// Flutter 3.44.8
final theme = Theme.of(context);
return Theme(
  data: theme.copyWith(
    extensions: [
      ...theme.extensions.values,
      context.tokens.copyWith(gap: 8), // overrides AppTokens only
    ],
  ),
  child: const CompactSection(),
);
```

Не указывайте тип литерала списка здесь. Запись `<ThemeExtension<dynamic>>[...]` на Dart 3.12.2 не компилируется с ошибкой "Can't assign spread elements of type 'ThemeExtension<dynamic>' to collection elements of type 'ThemeExtension<ThemeExtension<dynamic>>'", что является особенностью самоссылающегося ограничения `T extends ThemeExtension<T>`. Если позволить выводу типов выбрать тип элементов, код компилируется и работает правильно: в моём тесте поддерево увидело `gap: 8.0` и нетронутое расширение `BrandTokens`.

Обычный виджет `Theme` не анимируется. Если сама подмена должна плавно переходить (например, секция "опасной зоны", подсвечивающаяся при наведении), используйте `AnimatedTheme` напрямую.

### Без == и hashCode анимация темы перезапускается при каждой перестройке

`ThemeData.==` сравнивает `extensions` через `mapEquals`, который вызывает `==` у каждого расширения. Если ваш класс не переопределяет `==`, два экземпляра с одинаковыми значениями не равны. Это важно, как только вы создаёте токены во время выполнения вместо `const`-экземпляров, например из выбранного пользователем акцентного цвета или через `AppTokens.light.copyWith()` внутри `build`.

Я проверил это, перестроив `MaterialApp` со свежим, но идентичным экземпляром `copyWith()` после завершения первой анимации. Без `==` `tester.hasRunningAnimations` было равно `true`: `AnimatedTheme` увидел "новую" тему и запустил ещё один 200-миллисекундный твин, перестраивая все зависящие от темы виджеты в течение 12 кадров без какого-либо визуального изменения. После добавления показанных выше переопределений `==` и `hashCode` тот же тест сообщил `false`. Если не хочется писать их вручную, пакеты вроде `theme_extensions_builder` генерируют `copyWith`, `lerp`, `==` и `hashCode` по аннотации.

### Булевы значения и перечисления переключаются ровно при t = 0.5

С шаблоном `t < 0.5` значение `useHairlineBorders` уже было `true` на кадре 100 мс, потому что `t` равнялось ровно `0.5`. Это согласуется с тем, как `ThemeData` интерполирует собственные дискретные поля, но означает, что рамка может внезапно появиться посреди плавного перехода цвета. Если это выглядит неправильно, выразите внешний вид непрерывным токеном: замените булево значение цветом рамки `Color`, который переходит от прозрачного к `outlineVariant`, и доверьте остальное `Color.lerp`.

### Ключ это обобщённый аргумент, а не тип времени выполнения

`type` возвращает `T`, то есть аргумент типа, переданный в `ThemeExtension`, а не `runtimeType`. Если написать `class BrandAppTokens extends AppTokens`, его экземпляр будет сохранён под ключом `AppTokens` и заменит базовый. Обычно это именно то, что нужно для white-label, но это значит, что зарегистрировать базовый класс и подкласс рядом нельзя.

## Место ThemeExtension среди других инструментов оформления

Сначала используйте `ColorScheme` для всего, что потребляют компоненты Material, потому что кнопки, чипы и панели приложения никогда не прочитают ваше расширение. Используйте темы компонентов (`CardThemeData`, `FilledButtonThemeData`), когда нужно изменить внешний вид виджета Material везде. Используйте `ThemeExtension` для всего, что нужно вашим собственным виджетам и для чего в Material нет места. Если вы ещё и загружаете шрифты через `google_fonts`, держите `TextTheme` в `ThemeData.textTheme` и кладите в расширение только нестандартные стили (блоки кода, числовые дисплеи); несоответствие типов, которое иногда там возникает, разобрано в [исправлении с TextTheme в google_fonts](/ru/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/).

Та же модель "окружающего значения от ближайшего унаследованного виджета" лежит в основе `IconTheme`, что объясняет, почему иконки подхватывают цвета, которые вы не задавали, как описано в [статье о том, как остановить окрашивание ImageIcon цветом IconTheme](/ru/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/). А если кнопка переключения темы меняет иконку солнца на иконку луны, то [AnimatedSwitcher нужен ключ, чтобы анимировать эту замену](/ru/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/).

### Читайте дальше

- [Как задать акцентный цвет во Flutter-приложении через ColorScheme в Material 3](/ru/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [Как заставить AnimatedSwitcher анимироваться, когда тип дочернего виджета не меняется](/ru/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/)
- [Как остановить окрашивание ImageIcon окружающим цветом IconTheme](/ru/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/)
- [Fix: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' with google_fonts](/ru/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/)

## Источники

- [`ThemeExtension` class, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeExtension-class.html)
- [`ThemeData.extensions` property, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeData/extensions.html)
- [`MaterialApp.themeAnimationStyle`, Flutter API docs](https://api.flutter.dev/flutter/material/MaterialApp/themeAnimationStyle.html)
- [`theme_data.dart` source on GitHub](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/material/theme_data.dart)
- [Official `ThemeExtension` sample, `theme_extension.1.dart`](https://github.com/flutter/flutter/blob/master/examples/api/lib/material/theme/theme_extension.1.dart)
- [Introduce Theme extensions (flutter/flutter#98033)](https://github.com/flutter/flutter/pull/98033)
