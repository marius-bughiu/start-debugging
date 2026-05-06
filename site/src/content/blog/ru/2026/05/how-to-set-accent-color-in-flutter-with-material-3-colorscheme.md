---
title: "Как задать акцентный цвет в приложении Flutter с Material 3 ColorScheme"
description: "Правильный способ в 2026 году задать акцентный цвет в Flutter с Material 3: ColorScheme.fromSeed, сокращение colorSchemeSeed, семь вариантов DynamicSchemeVariant, тёмная тема, dynamic_color на Android 12+ и гармонизация фирменных цветов. Проверено на Flutter 3.27.1 и Dart 3.11."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-3"
  - "theming"
  - "how-to"
lang: "ru"
translationOf: "2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme"
translatedBy: "claude"
translationDate: 2026-05-06
---

Краткий ответ: в Material 3 больше нет «акцентного цвета». Ближайший единственный регулятор -- это начальный цвет (seed), который вы передаёте в `ColorScheme.fromSeed`. Используйте `ThemeData(colorSchemeSeed: Colors.deepPurple)` для самого простого случая или `ColorScheme.fromSeed(seedColor: ..., brightness: Brightness.light)`, когда нужно управлять вариантом, уровнем контраста или сочетанием светлой и тёмной схем. Из этого одного seed фреймворк выводит полную палитру M3: `primary`, `onPrimary`, `secondary`, `tertiary`, `surface`, `surfaceContainer` и остальное. Проверено на Flutter 3.27.1, Dart 3.11.

Это руководство показывает правильный путь в 2026 году, вещи, которые выглядят правильно, но ломаются в тёмной теме или на Android 12+, и как сохранить уже существующий фирменный цвет, не теряя тональную систему M3.

## Почему «акцентный цвет» исчез в M3

В Material 2 были `primaryColor` и `accentColor` -- две примерно независимые ручки. Вы их задавали, и виджеты вроде `FloatingActionButton`, `Switch` или курсор `TextField` выбирали одну или другую. В Material 3 этой терминологии больше нет. Спецификация заменяет обе единым набором ролей цвета, вычисляемых из одного seed:

- `primary`, `onPrimary`, `primaryContainer`, `onPrimaryContainer`
- `secondary`, `onSecondary`, `secondaryContainer`, `onSecondaryContainer`
- `tertiary`, `onTertiary`, `tertiaryContainer`, `onTertiaryContainer`
- `surface`, `onSurface`, `surfaceContainerLowest` ... `surfaceContainerHighest`
- `error`, `onError`, плюс варианты
- `outline`, `outlineVariant`, `inverseSurface`, `inversePrimary`

То, что в M2 было вашим accent, чаще всего отображается на `primary` в M3, а иногда на `tertiary`, если вы использовали accent для подсветки. [Документация Material 3 о ролях цвета](https://m3.material.io/styles/color/roles) -- канонический источник, какая роль идёт на какую поверхность.

Практическое следствие: если вы найдёте старый ответ на StackOverflow со словами «задайте `ThemeData.accentColor`», это свойство всё ещё компилируется в нескольких узких путях, но ни один виджет Material 3 его не читает. Вы потратите вечер, удивляясь, почему ничего не меняется. Оно устарело и для виджетов M3 фактически является no-op.

## Минимальный корректный шаблон

Material 3 включён по умолчанию в Flutter 3.16 и новее. Задавать `useMaterial3: true` больше не нужно. Самый простой и идиоматичный акцентный цвет для нового приложения:

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Demo',
      theme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.light,
      ),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.dark,
      ),
      themeMode: ThemeMode.system,
      home: const Scaffold(),
    );
  }
}
```

`colorSchemeSeed` -- это сокращение внутри `ThemeData`, эквивалентное:

```dart
// What colorSchemeSeed expands to internally
ThemeData(
  colorScheme: ColorScheme.fromSeed(
    seedColor: Colors.deepPurple,
    brightness: Brightness.light,
  ),
);
```

Если вам нужны только seed и яркость, предпочитайте `colorSchemeSeed`. Обращайтесь к `ColorScheme.fromSeed` напрямую, когда требуется настроить вариант, уровень контраста или переопределить одну-две конкретные роли.

## Выбор DynamicSchemeVariant

Начиная с Flutter 3.22 конструктор `ColorScheme.fromSeed` принимает параметр `dynamicSchemeVariant`. Он выбирает, какой алгоритм Material Color Utilities выводит палитру. Опции, в порядке того, насколько настойчиво они сохраняют видимость seed:

- `DynamicSchemeVariant.tonalSpot` (по умолчанию): стандартный рецепт Material 3. Средняя насыщенность, сбалансированный. Seed становится источником `primary`, а `secondary` и `tertiary` берутся из соседних оттенков.
- `DynamicSchemeVariant.fidelity`: держит `primary` очень близко к точному цвету seed. Используйте, когда бренд хочет, чтобы seed отображался буквально.
- `DynamicSchemeVariant.content`: похож на `fidelity`, но рассчитан на палитры, выведенные из контента (например, доминирующий цвет hero-изображения).
- `DynamicSchemeVariant.monochrome`: оттенки серого. `primary`, `secondary`, `tertiary` -- все нейтральные.
- `DynamicSchemeVariant.neutral`: низкая хрома. Seed едва подкрашивает результат.
- `DynamicSchemeVariant.vibrant`: усиливает хрому. Подходит для игривых или насыщенных медиа приложений.
- `DynamicSchemeVariant.expressive`: вращает `secondary` и `tertiary` дальше по кругу. Визуально более активный.
- `DynamicSchemeVariant.rainbow`, `DynamicSchemeVariant.fruitSalad`: экстремальные варианты, чаще встречающиеся в лаунчерах Material You, чем в обычных приложениях.

Конкретный пример. Если ваш фирменный цвет точно `#7B1FA2` и маркетинг уже одобрил именно этот фиолетовый, `tonalSpot` его обесцветит. `fidelity` его сохранит:

```dart
// Flutter 3.27.1
final brand = const Color(0xFF7B1FA2);

final lightScheme = ColorScheme.fromSeed(
  seedColor: brand,
  brightness: Brightness.light,
  dynamicSchemeVariant: DynamicSchemeVariant.fidelity,
);
```

Выберите вариант один раз, затем примените его и для светлой, и для тёмной яркости, чтобы внешний вид оставался одинаковым между темами.

## Как правильно сочетать светлую и тёмную схемы

Создавать два экземпляра `ColorScheme` из одного seed (по одному на `Brightness`) -- правильный подход. Фреймворк перегенерирует тональную палитру для каждой яркости, чтобы соотношения контраста оставались выше минимумов M3. Не инвертируйте цвета вручную.

```dart
// Flutter 3.27.1
final seed = Colors.indigo;

final light = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.light,
);
final dark = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.dark,
);

return MaterialApp(
  theme: ThemeData(colorScheme: light),
  darkTheme: ThemeData(colorScheme: dark),
  themeMode: ThemeMode.system,
  home: const Home(),
);
```

Распространённая ошибка: построить светлую тему с `Brightness.light`, но забыть передать `Brightness.dark` в тёмную тему. Тогда тёмная схема использует светлые тона, которые на чёрной поверхности выглядят выцветшими и не проходят контраст WCAG AA на основном тексте. Всегда передавайте обе.

Если требуется дополнительный контроль над контрастом, `ColorScheme.fromSeed` принимает `contrastLevel` от `-1.0` (ниже контраст) до `1.0` (выше контраст). Значение по умолчанию `0.0` соответствует спецификации M3. Более высокий контраст полезен, когда приложение должно проходить корпоративные аудиты доступности.

## Использование фирменного цвета с сохранением генерации M3

Иногда фирменный цвет нельзя менять, но остальная палитра гибкая. Используйте `ColorScheme.fromSeed` и переопределите одну роль:

```dart
// Flutter 3.27.1
final scheme = ColorScheme.fromSeed(
  seedColor: Colors.indigo,
  brightness: Brightness.light,
).copyWith(
  primary: const Color(0xFF1E3A8A), // exact brand
);
```

Так всё остальное (`secondary`, `tertiary`, `surface` и т. д.) останется в алгоритмически выведенной палитре, а закреплён только `primary`. Не переопределяйте больше одной-двух ролей. Смысл системы M3 в том, что роли взаимно согласованы. Закрепление четырёх цветов обычно где-нибудь ломает контраст.

Более безопасная альтернатива при наличии нескольких обязательных фирменных цветов -- гармонизировать их относительно seed, а не подменять роли. Material Color Utilities предоставляют `MaterialDynamicColors.harmonize`, доступный через пакет [`dynamic_color`](https://pub.dev/packages/dynamic_color):

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';

final brandError = const Color(0xFFD32F2F);
final harmonized = brandError.harmonizeWith(scheme.primary);
```

`harmonizeWith` слегка сдвигает фирменный оттенок к seed, чтобы оба сосуществовали визуально, не теряя идентичности бренда. Это правильный инструмент, когда дизайн-система требует точный красный, например, для кнопок ошибок или деструктивных действий.

## Material You: динамический цвет на Android 12+

Если вы выпускаете приложение для Android 12 и выше, система может передать вам `ColorScheme`, выведенный из обоев. Подключите его через `DynamicColorBuilder` из `dynamic_color`. На iOS, web, desktop или старом Android builder возвращает `null`, и вы откатываетесь к своему seed.

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/material.dart';

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return DynamicColorBuilder(
      builder: (lightDynamic, darkDynamic) {
        final ColorScheme light = lightDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.light,
            );
        final ColorScheme dark = darkDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.dark,
            );

        return MaterialApp(
          theme: ThemeData(colorScheme: light),
          darkTheme: ThemeData(colorScheme: dark),
          themeMode: ThemeMode.system,
          home: const Home(),
        );
      },
    );
  }
}
```

Тонкий момент: `lightDynamic` и `darkDynamic` не всегда выводятся из одних и тех же обоев. На некоторых устройствах Pixel тёмная схема приходит из другого источника. Считайте их независимыми. Если нужно гармонизировать фирменный красный с той схемой, к которой пришёл пользователь, делайте `brandRed.harmonizeWith(scheme.primary)` на каждом build, а не один раз при старте.

## Чтение цвета в виджетах

Когда схема задана, обращайтесь к ролям через `Theme.of(context).colorScheme`. Не зашивайте hex-значения внутрь виджетов и не используйте M2-геттеры `primaryColor` / `accentColor`.

```dart
// Flutter 3.27.1
class CallToAction extends StatelessWidget {
  const CallToAction({super.key, required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
      ),
      onPressed: () {},
      child: Text(label),
    );
  }
}
```

`FilledButton` уже использует `primary` и `onPrimary` по умолчанию, поэтому явный `styleFrom` приведён только для демонстрации имён ролей. У большинства виджетов M3 разумные значения по умолчанию, поэтому самый простой ответ на «как мне стилизовать кнопки акцентным цветом» -- «выберите правильный виджет», а не «переопределите style».

Быстрая карта перехода с M2 на M3:

| Идея M2 | Роль M3 |
| --- | --- |
| `accentColor` для подсветки переключателей, ползунков, FAB | `primary` |
| `accentColor` как мягкий фон чипа | `secondaryContainer` с текстом `onSecondaryContainer` |
| `accentColor` как «третья» подсветка | `tertiary` |
| `primaryColor` в app bar | `primary` (или `surface` для стандартного app bar M3) |
| `cardColor` | `surfaceContainer` |
| `dividerColor` | `outlineVariant` |
| `disabledColor` | `onSurface` с прозрачностью 38% |

## Вещи, которые выглядят правильно, но неверны

Пять ошибок, которые я вижу каждую неделю:

1. **Установка `useMaterial3: false`** в новом приложении, чтобы «упростить стилизацию», и затем вопрос, почему `colorSchemeSeed` всё ещё даёт оттенки M3. `colorSchemeSeed` существует только в M3. Отказываясь от M3, вы отказываетесь и от схем цвета на основе seed. Оставайтесь на M3, если нет жёсткого требования.
2. **Создание одного `ColorScheme` и переиспользование его для обеих тем.** Светлая схема на чёрном фоне не проходит контраст. Создайте две схемы из одного seed.
3. **Вызов `ColorScheme.fromSeed` внутри `build()`** виджета на самом верху дерева. Это запускает Material Color Utilities на каждом rebuild, не катастрофично, но расточительно. Создайте схему один раз в `main` или в `State` вашего `App`, а затем передавайте её вниз.
4. **Использование `Colors.deepPurple.shade300` в качестве seed.** Seed работает лучше всего, когда насыщен и имеет ясный оттенок. Выцветший вариант даёт выцветшую палитру. Передавайте базовый цвет (например, `Colors.deepPurple`, который и есть оттенок 500) и позвольте `tonalSpot` сделать работу по обесцвечиванию для более светлых ролей.
5. **Жёстко прописывать hex-цвет для FAB или для thumb выбранного `Switch`**, потому что «акцентного цвета больше нет». Роль -- `primary`. Если `primary` не выглядит правильно на этой поверхности, не так выбран вариант, а не виджет.

## Уборка старого приложения: миграция за 5 минут

Если в приложении уже где-то есть `accentColor` или `primarySwatch`, самая дешёвая корректная миграция:

1. Удалить `accentColor` и `primarySwatch` из `ThemeData(...)`.
2. Добавить `colorSchemeSeed: <ваш старый primary>`.
3. Удалить `useMaterial3: false`, если он есть; M3 -- значение по умолчанию в 3.16+.
4. Найти в проекте `Theme.of(context).accentColor`, `theme.primaryColor` и `theme.colorScheme.background` (переименован в `surface` в новых Flutter) и заменить каждое на правильную роль M3 из таблицы выше.
5. Запустить `flutter analyze`. Всё, что продолжает предупреждать об устаревшем свойстве темы, обрабатывается так же.

Самое заметное визуальное изменение после этого -- стандартный фон `AppBar` теперь `surface`, а не `primary`. Если хотите вернуть цветной app bar, задайте `appBarTheme: AppBarTheme(backgroundColor: scheme.primary, foregroundColor: scheme.onPrimary)`. Многие команды постфактум обнаруживают, что им на самом деле больше нравится app bar M3 с `surface`, как только привыкают.

## Связанное чтение

Если вы одновременно мигрируете более крупное Flutter-приложение, [пошаговая миграция с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) и [руководство по профилированию подёргиваний с DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) покрывают две вещи, которые часто всплывают при обновлении темы: оборот в управлении состоянием и неожиданные шторма rebuild. Для нативных мостов (например, чтобы получить системный сигнал темы, недоступный из чистого Flutter) см. [добавление платформо-специфичного кода без плагинов](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). А если ваша CI-матрица охватывает старые и новые SDK Flutter во время миграции, статья о [таргетинге нескольких версий Flutter в одном CI-пайплайне](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) держит обе ветки зелёными.

## Источники

- Flutter API: [`ColorScheme.fromSeed`](https://api.flutter.dev/flutter/material/ColorScheme/ColorScheme.fromSeed.html)
- Flutter API: [`ThemeData.colorSchemeSeed`](https://api.flutter.dev/flutter/material/ThemeData/colorSchemeSeed.html)
- Flutter API: [`DynamicSchemeVariant`](https://api.flutter.dev/flutter/material/DynamicSchemeVariant.html)
- Спецификация Material 3: [роли цвета](https://m3.material.io/styles/color/roles)
- pub.dev: [`dynamic_color`](https://pub.dev/packages/dynamic_color) для Material You и гармонизации
