---
title: "Миграция Flutter-приложения с Color.withOpacity на Color.withValues (Flutter 3.27+)"
description: "Замените устаревшие Color.withOpacity, opacity, value, red, green, blue и alpha на withValues, .a/.r/.g/.b и toARGB32. Что dart fix перепишет за вас, четыре геттера, которые он оставляет, почему после замены ломаются точные проверки цветов и поиск в Map<Color, T> и как withOpacity молча теряет Display P3. Измерено на Flutter 3.44.8 с Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "colors"
lang: "ru"
translationOf: "2026/10/migrate-a-flutter-app-from-color-withopacity-to-color-withvalues"
translatedBy: "claude"
translationDate: 2026-10-23
---

`Color.withOpacity` объявлен устаревшим начиная с Flutter 3.27.0, когда `dart:ui` начал хранить компоненты цвета в виде значений с плавающей точкой вместе с `ColorSpace`. Замена: `color.withValues(alpha: x)`, а её соседи: `.a` вместо `.opacity`, `toARGB32()` вместо `.value` и `.r`/`.g`/`.b` (числа double от 0.0 до 1.0) вместо `.red`/`.green`/`.blue` (целые от 0 до 255). `dart fix --apply` перепишет `withOpacity`, `opacity` и `value` за вас, но `red`, `green`, `blue` и `alpha` оставит вам. Замена не чисто косметическая: `withOpacity(0.5)` сохраняет альфу `0.50196` (128/255), а `withValues(alpha: 0.5)` сохраняет ровно `0.5`, поэтому эти два цвета больше не `==`. Любой тест вида `expect(color, const Color(0x80000000))` и любой `Map<Color, T>` с ключами по старому значению ломаются после миграции. Типичному приложению нужно от 30 минут до часа, большая часть уходит на тесты. Всё ниже запускалось на Flutter 3.44.8 (Dart 3.12.2).

## Зачем уходить от withOpacity сейчас

- **Точность.** `withOpacity` квантует альфу до 8 бит: его тело буквально `withAlpha((255.0 * opacity).round())`. `withValues` сохраняет переданное вами значение double. Для анимаций, которые затухают через много мелких шагов, это разница между 256 возможными уровнями альфы и непрерывными.
- **Цветовые пространства.** `withValues` сохраняет `colorSpace` получателя. `withOpacity` и `withAlpha` идут через `Color.fromARGB`, который всегда создаёт цвет sRGB, поэтому цвет Display P3 возвращается помеченным как sRGB. Подробнее об этом в разделе про подводные камни.
- **Устаревшее станет удалённым.** Руководство по миграции Flutter описывает удаление 8-битного API как "Phase 2", которая ещё не наступила. Когда она наступит, каждый оставшийся `withOpacity`, `.value` и `.red` превратится из диагностики уровня `info` в ошибку компиляции.
- **Шум.** В большом приложении только от этих геттеров могут быть сотни срабатываний `deprecated_member_use`, и они закапывают те устаревшие API, на которые действительно нужно реагировать.

## Что меняется в приложении

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| Тесты с точным равенством `Color` | `withValues(alpha: 0.5) != const Color(0x80000000)`; используйте `isSameColorAs` | высокая |
| Ключи `Map<Color, T>` / `Set<Color>` | Старый и новый цвета хешируются по-разному; поиск возвращает `null` | высокая |
| Арифметика с `.red`/`.green`/`.blue` | Замены это double от 0.0 до 1.0; целочисленные пороги вроде `< 128` молча ломаются | высокая |
| Места вызова `withOpacity(x)` | Становится `withValues(alpha: x)`, применяется через `dart fix` | низкая |
| `.value` / `.opacity` | Становятся `toARGB32()` / `.a`, применяется через `dart fix` | низкая |
| Классы, которые `implements Color` | Должны реализовать `a`, `r`, `g`, `b`, `colorSpace`, `toARGB32`, `withValues` | средняя |

## Подготовка

- Flutter 3.27.0 или новее, лучше актуальная стабильная версия. `CupertinoDynamicColor.withValues` и его правило `dart fix` появились позже (сообщения об устаревании говорят "deprecated after v3.33.0-1.0.pre"), поэтому приложениям с большим количеством Cupertino стоит быть на 3.35 или новее.
- Чистый `git status`, чтобы просмотреть результат `dart fix` одним диффом.
- Проходящий набор тестов до начала работы. Падения из-за равенства цветов основной сигнал того, что что-то изменилось, и они должны быть единственными падениями.
- Список мест, где цвета сохраняются (shared preferences, JSON, база данных). Именно там важны преобразования в целые числа.

## Шаги миграции

1. **Составьте перечень устаревших членов.** Запустите `flutter analyze` и отфильтруйте геттеры цвета, чтобы знать, чего `dart fix` не коснётся:

    ```bash
    # Flutter 3.44.8
    flutter analyze 2>&1 | grep deprecated_member_use | grep -E "'(withOpacity|opacity|value|red|green|blue|alpha)'"
    ```

    На таком примере файла:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (before)
    import 'package:flutter/material.dart';

    Color scrim(Color base) => base.withOpacity(0.54);

    bool isDark(Color c) => (c.red * 0.299 + c.green * 0.587 + c.blue * 0.114) < 128;

    int serialize(Color c) => c.value;

    double fade(Color c) => c.opacity;

    int alphaByte(Color c) => c.alpha;
    ```

    анализатор сообщает о семи `deprecated_member_use` уровня info, по одному на каждый член, и каждое содержит рекомендуемую замену, например `'red' is deprecated and shouldn't be used. Use (*.r * 255.0).round().clamp(0, 255).`

    Проверка: у вас есть число. Сохраните его, вы сравните с ним на шаге 3.

2. **Примените исправления на основе данных.** Flutter поставляет правила `fix_data` ровно для трёх членов `Color`: `withOpacity` в `withValues(alpha: ...)`, `opacity` в `a` и `value` в `toARGB32()`. Сначала предпросмотр, затем применение:

    ```bash
    # Flutter 3.44.8
    dart fix --dry-run .
    dart fix --apply .
    ```

    Пробный запуск на примере сообщает `deprecated_member_use - 3 fixes`, а дифф такой:

    ```diff
    -Color scrim(Color base) => base.withOpacity(0.54);
    +Color scrim(Color base) => base.withValues(alpha: 0.54);
    -int serialize(Color c) => c.value;
    +int serialize(Color c) => c.toARGB32();
    -double fade(Color c) => c.opacity;
    +double fade(Color c) => c.a;
    ```

    Такие же правила есть для `CupertinoDynamicColor.withOpacity`. В монорепозитории запустите команду один раз из корня; анализатор подхватит каждый вложенный `pubspec.yaml`.

    Проверка: `flutter analyze` теперь сообщает о четырёх устареваниях цвета вместо семи, и все они относятся к `red`, `green`, `blue` или `alpha`.

3. **Перепишите целочисленные геттеры вручную, сохраняя масштаб.** Именно отсюда берутся настоящие баги. `.red` возвращает `int` от 0 до 255; `.r` возвращает `double` от 0.0 до 1.0. Замена одного другим компилируется без проблем, потому что оба это `num`, а сравнение после этого навсегда неверно:

    ```dart
    // Flutter 3.44.8: compiles, always returns true
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 128;
    ```

    Либо переведите всё выражение на шкалу 0-1, либо явно преобразуйте там, где вам действительно нужны байты:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (after)
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 0.5;

    // Or, better for contrast decisions, the built-in WCAG luminance:
    bool isDarkWcag(Color c) => c.computeLuminance() < 0.179;

    extension ColorBytes on Color {
      int get alpha8 => (a * 255.0).round().clamp(0, 255);
      int get red8 => (r * 255.0).round().clamp(0, 255);
      int get green8 => (g * 255.0).round().clamp(0, 255);
      int get blue8 => (b * 255.0).round().clamp(0, 255);
    }

    int alphaByte(Color c) => c.alpha8;
    ```

    Расширение использует ту самую формулу, которую предлагает сообщение об устаревании, и совпадает с `toARGB32()`, который внутри делает `(x * 255.0).round().clamp(0, 255)` для каждого канала. Для `Colors.blue[500]` (`0xFF2196F3`) `.red` равен `33`, а `.r` равен `0.12941176470588237`.

    Проверка: `flutter analyze` сообщает ноль устареваний цвета, а `grep -rnE '\.(red|green|blue)\b' lib/` не показывает мест, где double в стиле `.r` сравнивается с литералом размером в байт.

4. **Исправьте точные проверки цветов в тестах.** Запустите набор тестов. Любой тест, сравнивающий мигрированный цвет с целочисленным литералом, теперь падает, потому что литерал проходит через 8-битный конструктор и получает альфу 128/255:

    ```dart
    // Flutter 3.44.8, flutter_test
    import 'package:flutter/material.dart';
    import 'package:flutter_test/flutter_test.dart';

    Color scrim() => Colors.black.withValues(alpha: 0.5);

    void main() {
      // Fails after the migration
      test('exact', () => expect(scrim(), const Color(0x80000000)));
      // Passes
      test('same color', () => expect(scrim(), isSameColorAs(const Color(0x80000000))));
    }
    ```

    Падающий тест печатает:

    ```text
    Expected: Color:<Color(alpha: 0.5020, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
      Actual: Color:<Color(alpha: 0.5000, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
    ```

    `isSameColorAs` сравнивает каждый компонент с порогом по умолчанию `colorEpsilon = 0.004` (примерно один 8-битный шаг) и требует одинаковый `colorSpace`. Используйте его везде, где тест сравнивает цвета, полученные арифметикой. Если вы предпочитаете оставить ожидание точным, запишите его тем же конструктором, что использует код: `Colors.black.withValues(alpha: 0.5)`.

    Проверка: `flutter test` зелёный, а в тестах изменены только матчеры, но не новые ожидаемые значения.

5. **Проверьте коллекции с цветами в качестве ключей и сохранённые значения.** Найдите `Map<Color`, `Set<Color>`, `switch` по цветам и всё, что хранит `toARGB32()`. Важны оба направления круговой передачи, а измеренное поведение показано в следующем разделе.

    Проверка: модульный тест, который сохраняет и заново загружает выбранный пользователем цвет, использует `isSameColorAs`, а не `==`.

## Проверка результата

После описанных шагов запустите:

```bash
# Flutter 3.44.8
flutter analyze
flutter test
dart fix --dry-run .
```

`flutter analyze` не должен показывать `deprecated_member_use` для членов `Color`, `flutter test` должен быть зелёным, а `dart fix --dry-run` должен вывести `Nothing to fix!` для правил цвета. Затем запустите приложение и проверьте экраны с полупрозрачными наложениями (скримы, отключённые кнопки, цвета ряби и наведения из вашей темы). Визуально ничего не должно сместиться: для любой альфы, которую вы передавали в `withOpacity`, `toARGB32()` старого и нового цветов совпадает (`0x80000000` в обоих случаях при 0.5), так что всё, что квантуется до 8 бит, оказывается одинаковым.

## Откат

Миграция обратима: `withOpacity`, `.opacity`, `.value` и целочисленные геттеры по-прежнему существуют в 3.44.8 и сохраняют прежнюю семантику, поэтому `git revert` коммита миграции восстанавливает точное поведение. Откатиться нельзя лишь на будущий релиз Flutter, где Phase 2 уже удалила их. Если нужно какое-то время оставаться на устаревшем API, подавляйте диагностику на уровне файла через `// ignore_for_file: deprecated_member_use`, а не глобально, чтобы остальные устаревания оставались видимыми.

## Подводные камни реальной миграции

Всё это получено в одном пробном тесте на Flutter 3.44.8. Числа это напечатанный вывод, а не оценки.

### Старый и новый цвет не равны и не имеют равных хешей

```dart
// Flutter 3.44.8
final o = Colors.black.withOpacity(0.5);
final v = Colors.black.withValues(alpha: 0.5);

print(o.a);                          // 0.5019607843137255
print(v.a);                          // 0.5
print(o == v);                       // false
print(o.toARGB32() == v.toARGB32()); // true (both 0x80000000)
print({o: 'x'}[v]);                  // null
```

`Color.==` сравнивает `a`, `r`, `g`, `b` и `colorSpace` как double, а `hashCode` хеширует те же поля. Если половина кодовой базы мигрирована, а другая нет, цвет, созданный в одной половине, не найдёт свою запись в карте, построенной другой половиной. Мигрируйте таблицу поиска и все места, которые к ней обращаются, одним коммитом либо используйте в качестве ключа карты `toARGB32()`.

### Сохранение через toARGB32 возвращает старый цвет

```dart
// Flutter 3.44.8
final stored = v.toARGB32();
print(Color(stored) == v); // false
print(Color(stored) == o); // true
```

`toARGB32()` с потерями по замыслу: он округляет каждый канал до байта. Цвет, восстановленный через `Color(int)`, получает альфу `128/255`, то есть значение `withOpacity`, а не то, которое вы сохраняли. Для отрисовки этого достаточно, а для проверок равенства вроде "сохранённый акцентный цвет всё ещё выбранный" это неверно. Если важна точность круговой передачи, храните четыре double и имя цветового пространства и собирайте цвет через `Color.from(alpha: ..., red: ..., green: ..., blue: ..., colorSpace: ...)`.

### `.a` это не `.opacity` под новым именем

`dart fix` переименовывает `opacity` в `a`, но старый геттер вычислялся из 8-битной альфы. Для `Colors.black.withValues(alpha: 0.3)` `.opacity` возвращает `0.30196078431372547`, а `.a` возвращает `0.3`. Код, который сравнивал `opacity` с литералом вроде `0.30196` или использовал его как ключ карты, после переименования меняет поведение. Это редкость, но это единственное изменение `dart fix`, не нейтральное семантически.

### withOpacity молча преобразует цвета Display P3 в sRGB

```dart
// Flutter 3.44.8
const p3 = Color.from(alpha: 1, red: 1, green: 0, blue: 0, colorSpace: ColorSpace.displayP3);

print(p3.withOpacity(0.5));
// Color(alpha: 0.5020, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)
print(p3.withValues(alpha: 0.5));
// Color(alpha: 0.5000, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.displayP3)
```

Красный P3 лежит за пределами sRGB (в расширенном sRGB это `red: 1.0931, green: -0.2267, blue: -0.1501`), но `withOpacity` просто переименовывает те же значения компонентов в sRGB, и цвет заметно тускнеет. `withAlpha(128)` делает то же самое и не объявлен устаревшим, поэтому анализатор его не покажет. Если в приложении используются фирменные цвета с широким охватом, поищите через grep и `withAlpha(`, и замените его на `withValues(alpha: n / 255)`.

### withValues не проверяет диапазон

`Colors.black.withOpacity(1.5)` бросает `AssertionError` в отладочных сборках. `Colors.black.withValues(alpha: 1.5)` проходит и сохраняет `a == 1.5`; `toARGB32()` ограничивает его до `0xff000000`, но равенство и всё остальное, читающее `.a`, видит `1.5`. Если альфа получается арифметикой (например, значение анимации, умноженное на коэффициент), ограничивайте её сами через `clampDouble(x, 0, 1)`. `Color.lerp` ограничивает результат, так что твины безопасны.

### Классы, реализующие Color

Руководство отмечает, что Flutter в конечном счёте намерен сделать `Color` `sealed`. Если у вас есть класс с `implements Color` (некоторые пакеты тем делали так, чтобы обернуть динамический цвет), теперь он должен реализовать геттеры с плавающей точкой, `colorSpace`, `toARGB32` и `withValues`. Рекомендуемое направление это композиция: держите поле `Color` и отдавайте его, а не притворяйтесь цветом. Эталонная реализация это сам `CupertinoDynamicColor`: каждое переопределение перенаправляет в `_effectiveColor`.

## Связанные материалы

- Три механические замены на шаге 2 это стандартные исправления на основе данных; [запуск dart fix по всему репозиторию](/ru/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) разбирает флаги, случаи, когда он пишет "Nothing to fix" на грязном репозитории, и почему его код возврата бесполезен в CI.
- Большинство вызовов `withOpacity` в приложениях живут рядом с цветами темы. Если вы всё равно их трогаете, [установка акцентного цвета через Material 3 ColorScheme](/ru/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) показывает, как получать эти полупрозрачные варианты из схемы вместо ручного подбора альфы.
- Пользовательские дизайн-токены это место, где встречаются `Color.lerp` и точные сравнения цветов; см. [определение дизайн-токенов через ThemeExtension во Flutter](/ru/2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter/).
- Ещё одно устаревание, которое при будущем обновлении превратится в ошибку компиляции: [уход от describeEnum до того, как Flutter его удалит](/ru/2026/09/migrate-off-describeenum-before-flutter-removes-it/).
- Широкий цветовой охват попадает на экран только на Impeller; для настольных платформ [миграция Flutter-приложения для Windows или Linux на Impeller](/ru/2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller/) описывает переключение рендерера.

## Источники

- [Migration guide for wide gamut Color](https://docs.flutter.dev/release/breaking-changes/wide-gamut-framework) (docs.flutter.dev)
- [Migration guide for wide gamut CupertinoDynamicColor](https://docs.flutter.dev/release/breaking-changes/wide-gamut-cupertino-dynamic-color) (docs.flutter.dev)
- [`Color.withValues`](https://api.flutter.dev/flutter/dart-ui/Color/withValues.html) и [`Color.withOpacity`](https://api.flutter.dev/flutter/dart-ui/Color/withOpacity.html) (api.flutter.dev)
- [Матчер `isSameColorAs`](https://api.flutter.dev/flutter/flutter_test/isSameColorAs.html) (api.flutter.dev)
- [flutter/flutter#127855: Implement wide gamut color support in the Framework](https://github.com/flutter/flutter/issues/127855) и [flutter/engine#54737: Framework wide color](https://github.com/flutter/engine/pull/54737)
- [Исправления на основе данных `fix_dart_ui.yaml`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/fix_data/fix_dart_ui.yaml) (flutter/flutter)
