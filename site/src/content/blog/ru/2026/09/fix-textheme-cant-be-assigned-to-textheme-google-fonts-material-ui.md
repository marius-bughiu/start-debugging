---
title: "Исправление: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' с google_fonts"
description: "Приложение импортирует material_ui, а google_fonts 8.2.1 по-прежнему возвращает TextTheme из SDK. Пока google_fonts не мигрирует, собирайте TextTheme сами через tear-off GoogleFonts.roboto."
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material-design"
  - "google-fonts"
lang: "ru"
translationOf: "2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui"
translatedBy: "claude"
translationDate: 2026-09-11
---

В одной программе у вас оказались два разных класса с именем `TextTheme`. Приложение импортирует `package:material_ui/material_ui.dart`, поэтому `ThemeData.textTheme` ожидает копию `TextTheme` из `material_ui`. `google_fonts` 8.2.1, последний релиз, всё ещё импортирует `package:flutter/material.dart`, поэтому `GoogleFonts.robotoTextTheme()` возвращает копию из SDK. Для Dart это несвязанные типы. Исправление, которое работает уже сегодня: перестаньте вызывать хелперы `...TextTheme()` и применяйте шрифт к каждому стилю через tear-off `GoogleFonts.roboto`. Он возвращает `TextStyle`, а этот тип у обеих копий общий. `MaterialUiCompatibilityBridge` здесь не поможет, потому что это ошибка времени компиляции.

Всё, что описано ниже, воспроизведено на Flutter 3.44.8 (Dart 3.12.2) с `material_ui` 1.2.0, `cupertino_ui` 1.0.2 и `google_fonts` 8.2.1 и сверено с исходниками `google_fonts` в ветке main репозитория `flutter/packages` по состоянию на 2026-09-11. Та же ошибка воспроизводится на стабильной линейке 3.47 и на master, потому что несоответствие находится в пакете, а не в SDK.

## Что печатают анализатор и компилятор

`flutter analyze` и IDE выдают короткую форму, которая выглядит бессмыслицей, потому что имена двух типов совпадают:

```text
error • The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?'.  • lib/main.dart:13:20 • argument_type_not_assignable
```

Front end компилятора, который работает при `flutter run`, `flutter build` и `flutter test`, полезнее. Он нумерует оба типа и показывает, где находится каждый из них:

```text
lib/main.dart:13:47: Error: The argument type 'TextTheme/*1*/' can't be assigned to the parameter type 'TextTheme/*2*/?'.
 - 'TextTheme/*1*/' is from 'package:flutter/src/material/text_theme.dart' ('/opt/homebrew/share/flutter/packages/flutter/lib/src/material/text_theme.dart').
 - 'TextTheme/*2*/' is from 'package:material_ui/src/text_theme.dart' ('/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.2.0/lib/src/text_theme.dart').
        textTheme: GoogleFonts.robotoTextTheme(),
                                              ^
```

Второе сообщение и есть диагноз. Если в вашем упоминаются `package:flutter/src/material/...` и `package:material_ui/src/...`, вы по адресу. Если там две другие библиотеки, переходите к разделу о похожих ошибках в конце.

## Откуда берутся два класса TextTheme

Начиная с Flutter 3.44, Material и Cupertino поставляются как отдельные пакеты `material_ui` и `cupertino_ui`. `material_ui` 1.0.0, опубликованный 2026-08-12, это копия библиотеки Material, которую заморозили в SDK в апреле. Это не реэкспорт. `material_ui/lib/src/text_theme.dart` объявляет собственный `class TextTheme`, так же как собственные `ThemeData`, `Theme` и `ColorScheme`.

Идентичность типа в Dart определяется библиотекой, где он объявлен, а не именем. У `TextTheme` из `package:flutter/src/material/text_theme.dart` и `TextTheme` из `package:material_ui/src/text_theme.dart` одинаковые поля и одинаковый код, но ни один не является подтипом другого, поэтому ни один нельзя присвоить другому.

`google_fonts` 8.2.1 был опубликован 2026-07-31, до того как `material_ui` дошёл до 1.0. В его `lib/src/google_fonts_all_parts.dart` по-прежнему стоит:

```dart
// google_fonts 8.2.1, lib/src/google_fonts_all_parts.dart
import 'package:flutter/material.dart';
```

и каждый сгенерированный хелпер `...TextTheme` построен на этом импорте:

```dart
// google_fonts 8.2.1, lib/src/google_fonts_parts/part_r.dart (trimmed)
static TextTheme robotoTextTheme([TextTheme? textTheme]) {
  textTheme ??= ThemeData.light().textTheme;
  return TextTheme(
    displayLarge: roboto(textStyle: textTheme.displayLarge),
    // ...14 more styles
  );
}
```

И параметр, и возвращаемый тип здесь это `TextTheme` из SDK. Как только ваш файл импортирует `material_ui` вместо `package:flutter/material.dart`, а именно это и делает `dart fix --apply --code=migrate_design_widgets`, каждый вызов `GoogleFonts.xxxTextTheme()` перестаёт компилироваться. Проблема отслеживается в [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067), открытом на следующий день после выхода `material_ui` 1.0.0.

## Минимальное воспроизведение

```yaml
# pubspec.yaml, Flutter 3.44.8
dependencies:
  flutter:
    sdk: flutter
  google_fonts: ^8.2.1
  material_ui: ^1.2.0
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: ThemeData(
        textTheme: GoogleFonts.robotoTextTheme(), // error here
      ),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

Верните импорт на `package:flutter/material.dart`, и код скомпилируется. Поэтому так много сообщений об этой ошибке содержат слова "previously working".

## Почему MaterialUiCompatibilityBridge не помогает

Мост, который добавили в `material_ui` 0.0.3, это первое, что пробуют люди, и именно его первым предложил мейнтейнер в #191067. Эту ошибку он не исправляет и не может исправить. Мост - это виджет. Он вставляет в дерево унаследованные виджеты `Theme` и `Localizations` старого образца, чтобы не мигрированный пакет, вызывающий `Theme.of(context)` во время выполнения, что-то нашёл. Это покрывает зависимости, которые *читают* состояние Material из `BuildContext`.

`google_fonts` ничего не читает из дерева. Он *возвращает* тип Material из SDK в своём публичном API, и это значение попадает в ваш код как аргумент, который проверка типов отклоняет ещё до появления какого-либо виджета. [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448) описывает это ограничение в общем виде и приводит случай `google_fonts` как пример из first-party пакетов. Если код не компилируется, никакая обёртка-виджет тут ни при чём.

## Исправление 1: применяйте шрифт к каждому стилю через tear-off (рекомендуется)

`TextStyle` объявлен в `package:flutter/painting.dart`, который входит в SDK и общий для обеих копий Material. `GoogleFonts.roboto(...)` возвращает `TextStyle`. Значит, заменить нужно только пятнадцатистрочный цикл, который делает за вас хелпер `...TextTheme`, и написать его можно для `TextTheme` из `material_ui`:

```dart
// lib/theme/google_text_theme.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

/// Applies a Google Font to every style of a material_ui [TextTheme].
///
/// Pass a tear-off such as `GoogleFonts.roboto`. Only [TextStyle] crosses
/// the package boundary, and TextStyle lives in package:flutter/painting.dart,
/// which both copies of Material share.
TextTheme withGoogleFont(
  TextTheme base,
  TextStyle Function({TextStyle? textStyle}) font,
) {
  TextStyle? apply(TextStyle? style) =>
      style == null ? null : font(textStyle: style);

  return base.copyWith(
    displayLarge: apply(base.displayLarge),
    displayMedium: apply(base.displayMedium),
    displaySmall: apply(base.displaySmall),
    headlineLarge: apply(base.headlineLarge),
    headlineMedium: apply(base.headlineMedium),
    headlineSmall: apply(base.headlineSmall),
    titleLarge: apply(base.titleLarge),
    titleMedium: apply(base.titleMedium),
    titleSmall: apply(base.titleSmall),
    bodyLarge: apply(base.bodyLarge),
    bodyMedium: apply(base.bodyMedium),
    bodySmall: apply(base.bodySmall),
    labelLarge: apply(base.labelLarge),
    labelMedium: apply(base.labelMedium),
    labelSmall: apply(base.labelSmall),
  );
}
```

Тип параметра `font` - это приём, который делает вызовы короткими. У каждого сгенерированного метода шрифта сигнатура `TextStyle Function({TextStyle? textStyle, Color? color, double? fontSize, ...})`. Функциональный тип с большим числом необязательных именованных параметров является подтипом типа с меньшим числом, поэтому `GoogleFonts.roboto`, `GoogleFonts.lato` или `GoogleFonts.pangolin` можно передать напрямую.

Затем сначала соберите тему, а потом замените её text theme:

```dart
// lib/main.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

import 'theme/google_text_theme.dart';

ThemeData buildTheme(Brightness brightness) {
  final base = ThemeData(
    brightness: brightness,
    colorSchemeSeed: Colors.indigo,
  );
  return base.copyWith(
    textTheme: withGoogleFont(base.textTheme, GoogleFonts.roboto),
  );
}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

С этим кодом `flutter analyze` не выдаёт замечаний, а виджет-тест подтверждает, что результат совпадает с тем, что раньше выдавал `GoogleFonts.robotoTextTheme()`: каждый стиль получает `fontFamily: 'Roboto_regular'` с `fontFamilyFallback: ['Roboto']`, именно так `google_fonts` называет загруженный вариант.

В одном отношении эта версия даже лучше вызова, который она заменяет. `robotoTextTheme()` без аргумента начинает с `ThemeData.light().textTheme`, поэтому если вы использовали его и в `darkTheme`, не передав `ThemeData.dark().textTheme`, то получали тёмный текст на тёмной поверхности. Построение от `base.textTheme` для каждой яркости даёт правильные цвета по построению. В упомянутом тесте светлый `bodyMedium` разрешается в почти чёрный `Color(0xFF1B1B21)`, а тёмный `bodyMedium` в почти белый `Color(0xFFE4E1E9)`.

Когда миграция появится в upstream, удалить этот файл и вернуться к `GoogleFonts.robotoTextTheme(base.textTheme)` можно изменением в одну строку на каждую тему.

### Когда имя семейства известно только во время выполнения

Если пользователи выбирают шрифт на экране настроек, вы, скорее всего, вызывали `GoogleFonts.getTextTheme(name)`, у которого та же проблема. Оберните `getFont`, который возвращает `TextStyle`:

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
TextTheme withGoogleFontNamed(TextTheme base, String family) =>
    withGoogleFont(
      base,
      ({TextStyle? textStyle}) =>
          GoogleFonts.getFont(family, textStyle: textStyle),
    );
```

Имейте в виду цену. `getFont` ищет семейство в `GoogleFonts.asMap()`, константной map, которая ссылается на каждый сгенерированный метод шрифта, поэтому компилятор больше не может выбросить неиспользуемые методы через tree shaking. Прямой tear-off из исправления 1 ссылается на один шрифт. На эту разницу в размере нацелена точка входа `google_fonts_lite.dart` из [flutter/packages#11433](https://github.com/flutter/packages/pull/11433): её слили 2026-09-04, но ещё не опубликовали. Используйте `getFont`, только если вам действительно нужно имя во время выполнения.

## Исправление 2: конвертируйте существующий legacy TextTheme на границе

Если `TextTheme` из SDK приходит к вам откуда-то, что вы не контролируете, например из общего пакета тем, который на этой неделе изменить нельзя, конвертируйте его поле за полем. Импортируйте legacy-библиотеку с префиксом и конструкцией `show`, чтобы в файл не просочилось ни одно другое имя:

```dart
// lib/theme/legacy_adapter.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
// Temporary: delete once google_fonts ships a material_ui release.
import 'package:flutter/material.dart' as legacy show TextTheme;
import 'package:material_ui/material_ui.dart';

extension LegacyTextThemeToMaterialUi on legacy.TextTheme {
  TextTheme toMaterialUi() => TextTheme(
        displayLarge: displayLarge,
        displayMedium: displayMedium,
        displaySmall: displaySmall,
        headlineLarge: headlineLarge,
        headlineMedium: headlineMedium,
        headlineSmall: headlineSmall,
        titleLarge: titleLarge,
        titleMedium: titleMedium,
        titleSmall: titleSmall,
        bodyLarge: bodyLarge,
        bodyMedium: bodyMedium,
        bodySmall: bodySmall,
        labelLarge: labelLarge,
        labelMedium: labelMedium,
        labelSmall: labelSmall,
      );
}
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final theme = ThemeData(
  textTheme: GoogleFonts.pangolinTextTheme().toMaterialUi(),
);
```

Это компилируется, потому что каждое поле имеет тип `TextStyle`. Для `TextTheme` это работает именно потому, что класс представляет собой простой набор из пятнадцати стилей. Обобщить приём нельзя: #191448 показывает, что тот же адаптер ломается уровнем глубже для типов вроде `FloatingActionButtonLocation`, чьи методы принимают другие типы Material в качестве аргументов. Кроме того, здесь сохраняется описанное выше значение по умолчанию только для светлой темы и возвращается импорт Material из SDK, от которого миграция должна была избавить. Поэтому держите этот код в одном файле с комментарием и отдавайте предпочтение исправлению 1.

## Исправление 3: дождитесь миграции google_fonts

Сам `google_fonts` мигрируют два pull request: [flutter/packages#12489](https://github.com/flutter/packages/pull/12489), открытый 2026-08-17 и связанный с #191067, и [flutter/packages#12810](https://github.com/flutter/packages/pull/12810), открытый 2026-09-09 в рамках общей для экосистемы задачи [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322). Второй к тому же поднимает минимальные версии пакета до Flutter 3.44 и Dart 3.12. На 2026-09-11 ни один из них не слит. Когда это произойдёт, хелперы `...TextTheme` будут принимать и возвращать тип из `material_ui`, и исходная однострочная версия снова скомпилируется. Следите за [changelog google_fonts](https://pub.dev/packages/google_fonts/changelog).

Два способа переждать, которые я не рекомендую для приложения в продакшене:

- **Вернуть старый импорт только в файле темы.** Это не работает. `ThemeData` в этом файле становится `ThemeData` из SDK, и ваш `MaterialApp` из `material_ui` отклоняет его с той же ошибкой, просто на один тип выше. Всё приложение должно быть на одной стороне.
- **Git-ссылка в `dependency_overrides` на ветку открытого PR.** Это компилируется, и один из комментаторов в #191067 предлагает именно это. Но вы выпускаете непроверенный код из форка. Если всё же решитесь, фиксируйте `ref:` на SHA коммита, а не на ветке.

Если исправление 1 по какой-то причине не подходит, честная альтернатива - отложить миграцию на `material_ui`, пока не выйдет новый `google_fonts`. Библиотека Material внутри SDK заморожена, но на 3.47 по-прежнему работает.

## Подвох: насыщенности шрифта в теме ещё нет

Хелперы `...TextTheme` всегда так себя вели, и исправление 1 это унаследовало: во время сборки `ThemeData.textTheme` содержит только цвета и семейства. Размеры и насыщенность берутся из `Typography.englishLike` и подмешиваются позже, когда `Theme.of` локализует тему. Поэтому когда `google_fonts` видит `titleMedium`, насыщенность равна `null`, он выбирает обычный вариант, и стиль получает `fontFamily: 'Roboto_regular'`. Во время выполнения `Theme.of(context).textTheme.titleMedium` разрешается в `Roboto_regular` с `FontWeight.w500`, то есть движок отрисовывает стиль с насыщенностью 500 из файла с насыщенностью 400.

Если заголовкам и меткам нужен настоящий файл medium, подмешайте геометрию до применения шрифта:

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final geometry = Typography.material2021().englishLike.merge(base.textTheme);
final textTheme = withGoogleFont(geometry, GoogleFonts.roboto);
// titleMedium -> fontFamily 'Roboto_500', fontWeight w500
```

Оба результата я проверил в виджет-тесте. Компромисс: размеры для английского теперь зашиты, поэтому если вы поставляете приложение на китайском, японском или корейском, выбирайте геометрию по локали (`Typography.material2021().tall` или `.dense`). По той же причине `TextTheme.apply(fontFamily: GoogleFonts.roboto().fontFamily)` - ловушка: он выставляет `'Roboto_regular'` для каждого стиля, какой бы ни была его насыщенность.

## Похожие ошибки, которые не являются этим багом

- **`The argument type 'TextTheme' can't be assigned to the parameter type 'CupertinoTextThemeData'`.** Вы передали text theme из Material в `CupertinoThemeData.textTheme`. Это разные классы по замыслу, о чём сообщали ещё в 2022 году в [material-foundation/flutter-packages#227](https://github.com/material-foundation/flutter-packages/issues/227). Хелпера `...TextTheme` для Cupertino нет: соберите `CupertinoTextThemeData` сами и передайте объекты стилей `GoogleFonts.lato()` в его `textStyle` и связанные параметры.
- **То же сообщение, но компилятор называет один из ваших файлов.** Класс `TextTheme` в вашем коде или в сгенерированном файле design-токенов перекрывает класс из Material. Нумерованный вывод компилятора показывает, какой файл переименовать.
- **То же сообщение для `ColorScheme`.** Это был `dynamic_color`, который возвращал `ColorScheme` из SDK из `DynamicColorBuilder`. Это исправлено: `dynamic_color` 2.1.0 зависит от `material_ui`, что мейнтейнер подтвердил в [material-foundation/flutter-packages#698](https://github.com/material-foundation/flutter-packages/issues/698).
- **Код компилируется, но виджеты пакета падают с "Could not find an ancestor of type Theme".** Это вторая половина того же разделения, проявляющаяся во время выполнения, и именно этот случай `MaterialUiCompatibilityBridge` исправляет.

## Связанные статьи

- Полная миграция, из которой возникает эта ошибка, включая случаи, когда нужен мост совместимости, описана в статье [о миграции импортов Material и Cupertino во Flutter на material_ui и cupertino_ui](/ru/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- О том, почему Material вообще покинул SDK, читайте в статье [Flutter 3.44 выносит Material и Cupertino из SDK](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Если вы переписывали импорты во всём монорепозитории, статья [о запуске dart fix по всему репозиторию](/ru/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) объясняет, как ограничить его область и проверять изменения пакет за пакетом.
- Тот же подход "сначала ThemeData", что и в исправлении 1, применим и к цветам: [задание акцентного цвета через ColorScheme в Material 3](/ru/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/).
- Если ошибка поиска предка возникает в вашем собственном коде, а не в зависимости, читайте [исправление "No Material widget found" во Flutter](/ru/2026/08/fix-no-material-widget-found-in-flutter/).

## Источники

- [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067), конфликт `TextTheme` из material_ui с `google_fonts`
- [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448), `MaterialUiCompatibilityBridge` не покрывает связанность через сигнатуры API
- [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322), миграция first-party пакетов на `material_ui` и `cupertino_ui`
- [flutter/packages#12489](https://github.com/flutter/packages/pull/12489) и [flutter/packages#12810](https://github.com/flutter/packages/pull/12810), открытые pull request с миграцией `google_fonts`
- [flutter/packages#11433](https://github.com/flutter/packages/pull/11433), точка входа `google_fonts_lite.dart`
- [google_fonts на pub.dev](https://pub.dev/packages/google_fonts), версия 8.2.1, и его [исходники](https://github.com/flutter/packages/tree/main/packages/google_fonts)
- [material_ui на pub.dev](https://pub.dev/packages/material_ui), версия 1.2.0, и его [changelog](https://pub.dev/packages/material_ui/changelog)
- [argument_type_not_assignable](https://dart.dev/diagnostics/argument_type_not_assignable), диагностика Dart
