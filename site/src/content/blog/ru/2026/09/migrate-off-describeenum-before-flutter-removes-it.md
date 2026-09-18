---
title: "Уходим от describeEnum во Flutter, пока его не удалили"
description: "describeEnum помечен устаревшим начиная с Flutter 3.16, а PR с его удалением уже одобрен. Как заменить каждый вызов на Enum.name (Flutter 3.47.4, Dart 3.13), что делать с классами, похожими на enum, и с диагностикой, как найти вызовы, спрятанные в зависимостях вроде flutter_svg 1.x, и как выглядит ошибка сборки после удаления."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "enums"
lang: "ru"
translationOf: "2026/09/migrate-off-describeenum-before-flutter-removes-it"
translatedBy: "claude"
translationDate: 2026-09-18
---

Почти для любой кодовой базы это 30 минут поиска и замены: `describeEnum(x)` превращается в `x.name`, `describeEnum`, переданный как tear-off, превращается в `(e) => e.name`, а циклы "строка обратно в enum", которые шли с ним в паре, становятся `MyEnum.values.byName(s)`. `dart fix` за вас этого не сделает, а подумать придётся только над теми местами вызова, где передаётся что-то, не являющееся настоящим Dart `Enum`. Реально время уходит на граф зависимостей: старый пакет вроде `flutter_svg` 1.1.6 до сих пор вызывает `describeEnum`, и в день удаления ваше приложение перестанет компилироваться в файле, который вам не принадлежит. Всё, что описано ниже, я проверил на Flutter 3.47.4 (Dart 3.13.3), текущем stable, а также на локальной сборке Flutter с применённым ожидающим удалением.

## Где на самом деле находится удаление

Хронология достаточно запутанная, чтобы разобраться в ней до того, как трогать код, потому что официальная документация и SDK сегодня расходятся.

- `describeEnum` был помечен устаревшим в [flutter/flutter#125016](https://github.com/flutter/flutter/pull/125016), который вошёл в 3.14.0-2.0.pre и вышел в stable 3.16. Сообщение об устаревании гласит: "Use the `name` getter on enums instead. This feature was deprecated after v3.14.0-2.0.pre."
- Удаление выполняет [flutter/flutter#190076](https://github.com/flutter/flutter/pull/190076), открытый 2026-07-27. Он удаляет функцию из `packages/flutter/lib/src/foundation/diagnostics.dart` вместе с её тестами. У него три одобрения, но на 2026-09-18 он всё ещё открыт: проверка "Google testing" падает, потому что внутреннему монорепозиторию Google сначала нужно поднять `flutter_svg` выше 2.0.0.
- Руководство по критическому изменению для этого удаления ([flutter/website#13682](https://github.com/flutter/website/pull/13682)) было смёржено 2026-08-18, и индекс критических изменений уже перечисляет "Removal of `describeEnum`" в разделе **Released in Flutter 3.47**. Это опережает реальность. Я проверил `diagnostics.dart` на теге `3.47.4`, на beta-теге `3.48.0-0.5.pre` и в `master`: `describeEnum` всё ещё определён во всех трёх.

Так что на канале stable сегодня ничего не ломается. Вы получаете лишь подсказку `deprecated_member_use` уровня `info`, которую большинство команд игнорирует с 2023 года. Как только #190076 смёржат, `master` сломается сразу, а следующая beta после этого сломается у всех, кто сидит на beta. Мигрировать сейчас стоит столько же, сколько мигрировать потом, только потом это случится посреди обновления, которое вам было нужно совсем по другой причине.

## Что ломается

| Область | Изменение | Серьёзность |
| ---- | ------ | -------- |
| `describeEnum(value)` в вашем коде | Ошибка компиляции: функции больше не существует | высокая, но исправляется тривиально |
| `describeEnum` в зависимости | Ошибка компиляции в файле пакета, приложение не собирается | высокая, нужно обновление пакета |
| `describeEnum` для классов, не являющихся `Enum` | Нет геттера `.name`, на который можно перейти | средняя, нужен локальный хелпер |
| `describeEnum` как tear-off (`.map(describeEnum)`) | Та же ошибка компиляции | низкая |
| `StringProperty(name, describeEnum(v))` в `debugFillProperties` | Работает после переписывания на `.name`, но `EnumProperty` лучшая замена | низкая |
| Поддержка `dart fix` | Отсутствует. Руководство Flutter прямо об этом говорит, а `dart fix --dry-run` сообщает "Nothing to fix!" | информационная |

## Чеклист перед началом

- Flutter 3.16 или новее. Каждый stable с тех пор содержит пометку об устаревании, так что анализатор найдёт места вызова за вас. Базовая версия здесь 3.47.4.
- Dart 2.15 или новее для геттера `name` и `values.byName`. Оба появились вместе с хелперами для enum в `dart:core` в Dart 2.15.0 (руководство Flutter говорит 2.14, но changelog Dart перечисляет их в 2.15.0). Любой проект на Flutter 3.x уже этому удовлетворяет.
- Чистый результат `flutter analyze` в качестве отправной точки, чтобы подсказки об устаревании не потерялись среди посторонних предупреждений.
- Вывод `flutter pub outdated` для вашего приложения, потому что шаг с зависимостями ниже может потребовать повышения мажорной версии.

## Как выглядит сбой после удаления

Чтобы получить настоящий текст ошибки, а не гадать, я применил diff из #190076 к временному checkout Flutter 3.47.4 и прогнал на нём тестовый проект. Анализатор сообщает:

```text
error • The function 'describeEnum' isn't defined. Try importing the library that defines 'describeEnum', correcting the name to the name of an existing function, or defining a function named 'describeEnum' • lib/legacy.dart:27:20 • undefined_function
```

`flutter run`, `flutter test` и `flutter build` вместо этого проходят через front-end компилятор, который выводит:

```text
lib/legacy.dart:27:20: Error: Method not found: 'describeEnum'.
String simple() => describeEnum(ThemeChoice.dark);
                   ^^^^^^^^^^^^
```

А проект, зависящий от `flutter_svg: 1.1.6`, падает ещё до того, как запустится хоть строчка вашего кода, и ошибка указывает в кеш pub:

```text
/Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196:33: Error: The method 'describeEnum' isn't defined for the type 'PictureConfiguration'.
      result.write('platform: ${describeEnum(platform!)}');
                                ^^^^^^^^^^^^
```

Если вы попали на этот пост по последнему сообщению, переходите сразу к шагу 5.

## Шаги миграции

1. **Найдите все места вызова с помощью анализатора.**
   Запустите `flutter analyze` и отфильтруйте по устареванию. На 3.47.4 каждое совпадение выглядит как строка `info`, заканчивающаяся на `deprecated_member_use`:

   ```bash
   # Flutter 3.47.4
   flutter analyze --no-fatal-infos | grep "'describeEnum' is deprecated"
   ```

   Обычный `grep -rn "describeEnum" lib test` находит те же места, плюс упоминания в doc-комментариях и в любых файлах, которые исключает ваш `analysis_options.yaml`. Проверка: у вас есть список файлов и номеров строк, и вы знаете, какие из них находятся в сгенерированных файлах (их нужно перегенерировать, а не править руками).

2. **Замените вызовы для настоящих enum на `.name`.**
   Для любого значения, статический тип которого `enum`, переписывание механическое. Это касается обычных enum, enhanced enum, enum, допускающих null, и tear-off:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   enum ThemeChoice { light, dark }

   // Before
   String simple() => describeEnum(ThemeChoice.dark);
   String? nullable(ThemeChoice? c) => c == null ? null : describeEnum(c);
   List<String> tearOff() => ThemeChoice.values.map(describeEnum).toList();

   // After
   String simple() => ThemeChoice.dark.name;
   String? nullable(ThemeChoice? c) => c?.name;
   List<String> tearOff() => ThemeChoice.values.map((e) => e.name).toList();
   ```

   Поведение идентично: начиная с Flutter 3.0, `describeEnum` начинается с `if (enumEntry is Enum) return enumEntry.name;`, так что для настоящих enum он уже был просто обёрткой вокруг `.name`. Это касается и enhanced enum, переопределяющих `toString()`. Enum, у которого `toString()` возвращает `Level(H)`, всё равно давал `high` из `describeEnum` и даёт `high` из `.name`. Проверка: `flutter analyze` не показывает оставшихся подсказок для этих файлов.

3. **Замените обратный поиск на `values.byName`.**
   Большая часть кода с `describeEnum` соседствует с самописным парсером, который обходит `values` и сравнивает строки. Замените обе половины вместе:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': describeEnum(c)};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.firstWhere((e) => describeEnum(e) == json['theme']);

   // After
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': c.name};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.byName(json['theme']! as String);
   ```

   Сериализованные строки не меняются, так что сохранённый JSON, shared preferences и аналитические события продолжают работать. А вот режим отказа меняется: для неизвестного значения старый цикл бросал `StateError: Bad state: No element`, тогда как `byName` бросает `ArgumentError: Invalid argument (name): No enum value with that name: "blue"`. Если вы ловите `StateError` вокруг этого разбора, обновите `catch`. Проверка: тест, прогоняющий каждое значение из `ThemeChoice.values` туда и обратно через `toJson`/`fromJson`, плюс один тест с неизвестной строкой.

4. **Дайте классам, похожим на enum, локальный хелпер.**
   `describeEnum` принимал `Object`, и для всего, что не было `Enum`, брал `toString()` и возвращал всё после первой точки. Это было рассчитано на "похожие на enum" классы времён до Dart 2.17, вроде этого, которые до сих пор встречаются в старых кодовых базах и в некоторых пакетах:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   class Channel {
     const Channel._(this._value);
     final String _value;
     static const Channel stable = Channel._('stable');
     static const Channel beta = Channel._('beta');
     @override
     String toString() => 'Channel.$_value';
   }
   ```

   `Channel.beta.name` не компилируется, потому что никакого `name` нет. Вариантов два. Лучший из них: превратить `Channel` в настоящий `enum`, что обычно возможно теперь, когда enhanced enum поддерживают поля и конструкторы. Когда это невозможно (класс приходит из пакета или у него есть не-const экземпляры), скопируйте запасную ветку в свой код:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   /// Local copy of the only describeEnum behaviour `.name` cannot replace.
   String enumLikeName(Object value) {
     final String description = value.toString();
     final int indexOfDot = description.indexOf('.');
     assert(
       indexOfDot != -1 && indexOfDot < description.length - 1,
       'The provided object "$value" is not an enum.',
     );
     return description.substring(indexOfDot + 1);
   }

   String fromObject(Object value) =>
       value is Enum ? value.name : enumLikeName(value);
   ```

   Проверка `value is Enum` важна для мест вызова с типом `Object` или `dynamic`, а именно там люди и передавали в `describeEnum` смесь enum и похожих на enum классов. Учтите, что `assert` выполняется только в debug-сборках. В release `describeEnum(42)` никогда не бросал исключение: `indexOf` возвращал -1, `substring(0)` возвращал `"42"`, и ваш код продолжал работу. Хелпер намеренно сохраняет это поведение, чтобы в продакшене ничего не изменилось. Проверка: тесты в debug-режиме для каждого похожего на enum типа возвращают те же строки, что и раньше.

5. **Исправьте вызовы в зависимостях.**
   Ваш собственный код это простая часть. Пакет, вызывающий `describeEnum`, ломает вашу сборку в тот день, когда функция исчезнет, и поиском с заменой его не исправить. Грепать кеш pub шумно, потому что там лежат все версии, которые вы когда-либо скачивали, поэтому сканируйте только те версии пакетов, которые ваше приложение реально разрешает, через `.dart_tool/package_config.json`:

   ```dart
   // Dart 3.13: list every describeEnum call in the packages your app resolves.
   // Save as tool/find_describe_enum.dart, run: dart run tool/find_describe_enum.dart
   import 'dart:convert';
   import 'dart:io';

   void main() {
     final config = File('.dart_tool/package_config.json');
     final json = jsonDecode(config.readAsStringSync()) as Map<String, dynamic>;
     final call = RegExp(r'\bdescribeEnum\s*[(),;]');
     for (final pkg in (json['packages'] as List).cast<Map<String, dynamic>>()) {
       if (pkg['name'] == 'flutter') continue; // defines it
       var rootUri = pkg['rootUri'] as String;
       if (!rootUri.endsWith('/')) rootUri += '/';
       final root = config.parent.uri.resolve(rootUri);
       final lib = Directory.fromUri(root.resolve(pkg['packageUri'] as String));
       if (!lib.existsSync()) continue;
       for (final f in lib.listSync(recursive: true).whereType<File>()) {
         if (!f.path.endsWith('.dart')) continue;
         final lines = f.readAsLinesSync();
         for (var i = 0; i < lines.length; i++) {
           if (call.hasMatch(lines[i]) && !lines[i].trimLeft().startsWith('//')) {
             print('${pkg['name']}: ${f.path}:${i + 1}');
           }
         }
       }
     }
   }
   ```

   Исправление с завершающим слешем здесь не для красоты. `package_config.json` хранит hosted-пакеты как `file:///.../flutter_svg-1.1.6` без завершающего слеша, и разрешение `lib/` относительно такого пути молча указывает на родительскую папку. В первой версии этого скрипта была именно эта ошибка, и он сообщал ноль совпадений для `flutter_svg` 1.1.6. Исправленная версия выводит:

   ```text
   flutter_svg: /Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196
   ```

   Для каждого пакета из отчёта проверьте, убрал ли вызов более новый релиз. Для `flutter_svg` ответ: любая 2.x. Я прогрепал 2.0.0 и 2.2.1, и ни одна не ссылается на `describeEnum` (последний релиз 2.3.0). Переход с 1.x на 2.x сам по себе полноценная миграция, потому что 2.0 перешла на `vector_graphics` и изменила API загрузчиков, но это тот же переход, который должен сделать внутренний код Google, прежде чем #190076 сможет влиться. Если пакет заброшен, сделайте форк, примените к нему шаг 2 и направьте на форк запись `dependency_overrides`. Проверка: скрипт не выводит ни одной строки для сторонних пакетов.

6. **Перепишите диагностику на `EnumProperty`.**
   Частым местом использования внутри виджетов и render-объектов был `debugFillProperties`. Механическое переписывание на `.name` компилируется, но типизированное свойство лучше:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   properties.add(StringProperty('choice', describeEnum(choice)));

   // After
   properties.add(EnumProperty<ThemeChoice>('choice', choice));
   ```

   Вывод немного отличается. `StringProperty` берёт своё значение в кавычки, поэтому DevTools и `toStringDeep()` показывали `choice: "dark"`, тогда как `EnumProperty` выводит `choice: dark`. Если у вас есть golden-тесты по `toStringDeep()` или `debugDescribeChildren`, обновите их. Начиная с Flutter 3.16, `EnumProperty<T>` требует `T extends Enum?`, так что для класса, похожего на enum, используйте вместо него `DiagnosticsProperty<Channel>`. Проверка: тесты диагностики проходят после перегенерации ожидаемых строк.

7. **Не дайте устаревшему вызову вернуться.**
   `deprecated_member_use` по умолчанию имеет уровень `info`, и именно поэтому эти вызовы пережили три года устаревания. Повысьте его в `analysis_options.yaml`:

   ```yaml
   # Flutter 3.47.4
   include: package:flutter_lints/flutter.yaml

   analyzer:
     exclude:
       - build/**
       - android/**
     errors:
       deprecated_member_use: error
   ```

   Добавьте `errors:` в существующий блок `analyzer:`. Когда я вместо этого дописал второй ключ `analyzer:` верхнего уровня, анализатор не пожаловался и продолжил сообщать `info`, так что повышение выглядело применённым, но не было им. С объединённым блоком `flutter analyze --no-fatal-infos` сообщает `error` и завершается с кодом 1. Имейте в виду, что так повышается уровень у всех устареваний, а не только у `describeEnum`. Если для одного PR это слишком много, оставьте `warning` и валите CI с `--fatal-warnings`. Проверка: добавьте вызов `describeEnum` во временный файл и убедитесь, что CI падает.

## Проверка

Я запустил версии "до" и "после" для каждого паттерна выше бок о бок в одном `flutter test` на Flutter 3.47.4:

| Паттерн | Результат `describeEnum` | Результат после миграции |
| ------- | --------------------- | --------------- |
| Обычный enum | `dark` | `dark` |
| Enhanced enum с переопределённым `toString()` | `high` | `high` |
| Класс, похожий на enum | `beta` | `beta` |
| Допускающий null, значение `null` | `null` | `null` |
| Tear-off по `values` | `[light, dark]` | `[light, dark]` |
| Значение enum с типом `Object` | `light` | `light` |
| JSON туда и обратно | `ThemeChoice.dark` | `ThemeChoice.dark` |
| Неизвестное значение JSON | `StateError` | `ArgumentError` |
| `debugFillProperties` | `choice: "dark"` | `choice: dark` |

После миграции чеклист короткий: `flutter analyze` чист с `deprecated_member_use: error`, сканирование зависимостей ничего не выводит для сторонних пакетов, и набор тестов проходит. Для полной уверенности возьмите ветку Flutter с применённым #190076 и запустите `flutter test`. Именно так были получены сообщения об ошибках выше.

## План отката

В вашем собственном коде откатывать нечего: `.name` и `values.byName` работают во всех версиях Flutter начиная с 3.0, так что мигрированный код работает и на SDK, который у вас сегодня, и на каждом SDK после удаления. Навредить может только мажорное обновление пакета на шаге 5. Сделайте его отдельным коммитом, чтобы можно было откатить изменение `pubspec.yaml` и `pubspec.lock` отдельно, сохранив чистку `describeEnum`.

## Подводные камни

- **`dart fix` не поможет.** В отличие от большинства устареваний во Flutter, у `describeEnum` нет data-driven исправления в `packages/flutter/lib/fix_data`, а руководство по удалению прямо говорит, что миграция не поддерживается `dart fix`. Если вы прогоняете `dart fix` по всему репозиторию ради других миграций, эта останется ручной.
- **Не заменяйте `describeEnum(e)` на `e.toString().split('.').last`.** Это самый популярный ответ на Stack Overflow, и он неверен для enhanced enum, переопределяющих `toString()`: `Level.high.toString().split('.').last` возвращает `Level(H)`.
- **Сгенерированный код.** Если совпадение из шага 1 находится в файле `.g.dart` или `.freezed.dart`, исправьте генератор (обновите его или измените свой шаблон) и перегенерируйте. Ручная правка вывода продержится только до следующего запуска `build_runner`.
- **Документация говорит 3.47, SDK нет.** Если ревьюер укажет на индекс критических изменений и спросит, почему 3.47.4 всё ещё компилируется, дело в том, что руководство смёржили раньше изменения в коде. Следите за #190076, чтобы узнать реальную дату. Поле "Landed in version" в самом руководстве всё ещё говорит TBD.

## Связанные материалы

- Если вам нужно разом разобрать кучу устареваний во Flutter, [запуск `dart fix` по всему репозиторию](/ru/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) справится со всем, для чего есть data-driven исправление.
- Ещё одно устаревание, требующее ручного переписывания: [замена устаревших `groupValue` и `onChanged` у `Radio` на `RadioGroup`](/ru/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- Более крупная миграция графа зависимостей, которая ждёт каждое приложение на Flutter: [переход на отдельные пакеты `material_ui` и `cupertino_ui`](/ru/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Если разбор enum у вас находится внутри декодирования JSON, [исправление `FormatException: Unexpected character` в Dart](/ru/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) покрывает вторую половину этого пути в коде.

## Источники

- [flutter/flutter#190076: Remove deprecated `describeEnum` from framework](https://github.com/flutter/flutter/pull/190076)
- [flutter/flutter#125016: Deprecate `describeEnum`](https://github.com/flutter/flutter/pull/125016)
- [Критическое изменение Flutter: Remove describeEnum](https://docs.flutter.dev/release/breaking-changes/remove-describeEnum)
- [Критическое изменение Flutter: руководство по миграции для describeEnum и EnumProperty](https://docs.flutter.dev/release/breaking-changes/describe-enum)
- [Справочник API `describeEnum`](https://api.flutter.dev/flutter/foundation/describeEnum.html)
- [Справочник API `EnumProperty`](https://api.flutter.dev/flutter/foundation/EnumProperty-class.html)
- [Язык Dart: перечисляемые типы](https://dart.dev/language/enums)
- [Changelog Dart SDK, 2.15.0](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [flutter_svg на pub.dev](https://pub.dev/packages/flutter_svg)
