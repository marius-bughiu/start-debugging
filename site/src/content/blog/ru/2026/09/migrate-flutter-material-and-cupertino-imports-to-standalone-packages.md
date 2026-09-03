---
title: "Перенос импортов Material и Cupertino во Flutter на пакеты material_ui и cupertino_ui"
description: "Полная миграция с package:flutter/material.dart и package:flutter/cupertino.dart на material_ui 1.1.1 и cupertino_ui 1.0.2: что перезаписывает dart fix --code=migrate_design_widgets, почему виджеты сторонних пакетов начинают падать на поиске предка, что на самом деле исправляет MaterialUiCompatibilityBridge и как меняется зависимость от flutter_localizations."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material-design"
  - "cupertino"
lang: "ru"
translationOf: "2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages"
translatedBy: "claude"
translationDate: 2026-09-03
---

Для приложения, у которого вся поверхность Material - это его собственный код, миграция занимает одну команду и один вечер: `flutter pub add material_ui`, затем `dart fix --apply --code=migrate_design_widgets`, затем прогон тестов. API виджетов представляют собой идентичную копию того, что лежало в SDK, поэтому ничего не рендерится иначе и ни один golden не должен сдвинуться. Реальное время съедает граф зависимостей. Каждый пакет, который всё ещё импортирует `package:flutter/material.dart`, тянет в вашу программу вторую, несовместимую по типам копию `Theme`, `Material` и `MaterialLocalizations`, и его виджеты будут падать на поиске предка внутри вашего перенесённого дерева, пока вы не обернёте приложение в `MaterialUiCompatibilityBridge`. Это руководство ориентировано на текущий stable-канал, Flutter 3.47.2 с Dart 3.13.2, плюс [`material_ui`](https://pub.dev/packages/material_ui) 1.1.1 и [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.0.2.

Время здесь имеет значение. Библиотеки внутри SDK уже заморожены, а формальное объявление устаревшими запланировано на stable-выпуск в ноябре 2026 года.

## Почему это не опциональная уборка

- **Копии внутри SDK не получают исправлений.** Flutter закрыл каталоги Material и Cupertino в `flutter/flutter` для любых изменений 2026-04-07. С тех пор каждое исправление ошибок попадало в `flutter/packages`. `material_ui` 1.1.1 уже несёт исправления, которых копия в SDK никогда не получит, включая состояние гонки в `SearchAnchor`, когда устаревший набор асинхронных подсказок заменял более новый, и подписи индикатора значения `Slider`, которые обрезались вместо сокращения многоточием у края экрана.
- **Обновления дизайна перестают ждать поезд SDK.** Material и Cupertino выпускались в квартальном ритме Flutter, поэтому правка токена или новый аргумент `MenuAnchor` ждали следующего stable-срез. Фиксация `material_ui: ^1.1.1` это развязывает: 1.1.0 и 1.1.1 вышли обе между stable 3.47 и сегодняшним днём.
- **Наконец можно выбросить дизайн-систему, которой вы никогда не пользовались.** После удаления копий из SDK приложение только на Cupertino перестанет тащить через tree-shaking темизацию, типографику и метаданные иконок Material, и наоборот.
- **Локализации переезжают вместе с виджетами.** Переведённые строки и делегаты Material и Cupertino теперь живут внутри пакетов, и именно поэтому `flutter_localizations` перестаёт быть тем, что вы указываете сами.
- **Если вы публикуете пакет, вы блокируете других.** Один неперенесённый листовой пакет навязывает мост совместимости всем ниже по графу.

## Что ломается

| Область | Изменение | Серьёзность |
| ------- | --------- | ----------- |
| Импорты | `package:flutter/material.dart` становится `package:material_ui/material_ui.dart`; `package:flutter/cupertino.dart` становится `package:cupertino_ui/cupertino_ui.dart` | высокая, полностью автоматизируется |
| Идентичность типов | `Material` из SDK и `Material` из `material_ui` - разные типы в среде выполнения, поэтому поиск предка не пересекает границу | высокая, нужен мост |
| Делегаты локализации | `GlobalMaterialLocalizations` и `GlobalCupertinoLocalizations` приходят из пакетов, а не из `flutter_localizations` | средняя |
| `pubspec.yaml` | Две новые прямые зависимости; `flutter_localizations` больше не нужен как прямая зависимость | средняя |
| Сгенерированный код | Всё, что пишет `package:flutter/material.dart` в файл `.g.dart` или `.freezed.dart`, нужно перегенерировать после прохода по исходникам | средняя |
| Опубликованные пакеты | Миграция собственного пакета - несовместимое изменение для его потребителей, поэтому требуется поднятие мажорной версии | средняя |
| API виджетов | Никаких. Конструкторы, параметры и рендеринг не изменились | никакой |

Последняя строка - вся причина, по которой эта миграция посильна. `material_ui` 1.0.0 - это копия встроенной библиотеки на момент заморозки в апреле 2026 года, а не редизайн.

## Подготовка

- Flutter 3.44 или новее. `material_ui` поднял нижнюю границу до Flutter 3.44 / Dart 3.12, когда код выехал из `flutter/flutter`, а 3.47.2 - текущая stable. Проверяется через `flutter --version`.
- Чистый `flutter analyze` до начала работы. Нужен сопоставимый прогон после миграции.
- Отдельная ветка. `dart fix --apply` перезаписывает все подходящие файлы одним проходом, и флага отмены нет.
- Инвентаризация зависимостей, которые рендерят виджеты Material или Cupertino. `flutter pub deps --style=compact` вместе с `flutter pub outdated` дают список; всё, что последний раз публиковалось до августа 2026 года, не перенесено.
- Если у вас есть golden-тесты, прогоните их первыми и зафиксируйте базовую линию. Они не должны измениться, и именно это здесь утверждается.

## Шаги миграции

1. **Добавьте пакеты, прежде чем трогать хотя бы один импорт.** Правило `dart fix` перезаписывает строки импортов; `pubspec.yaml` оно не правит. Сделаете в обратном порядке - получите файл, полный неразрешимых импортов.

   ```sh
   # Flutter 3.47.2, Dart 3.13.2
   flutter pub add material_ui
   flutter pub add cupertino_ui
   ```

   Сегодня это разрешается в `material_ui: ^1.1.1` и `cupertino_ui: ^1.0.2`. Если приложение только на Material, `cupertino_ui` всё равно придёт транзитивно, потому что `material_ui` зависит от `cupertino_ui: ^1.0.0` начиная с выпуска 1.0.1, но укажите его явно, если импортируете напрямую. Проверьте через `flutter pub deps --style=compact | grep -E 'material_ui|cupertino_ui'` и убедитесь, что оба разрешаются.

2. **Перезапишите импорты штатным исправлением.** Оба пакета регистрируют одно и то же исправление анализатора, поэтому одна команда обрабатывает Material и Cupertino сразу.

   ```sh
   dart fix --dry-run --code=migrate_design_widgets   # review first
   dart fix --apply  --code=migrate_design_widgets
   ```

   Результат - однострочный diff на файл:

   ```dart
   // Before: Flutter 3.43 and earlier
   import 'package:flutter/material.dart';

   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';
   ```

   Ниже строки импорта не меняется ничего. `MaterialApp`, `Scaffold`, `ThemeData`, `Colors`, `showDialog` и любое другое имя экспортируются под тем же идентификатором. Проверьте, что `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" lib test` ничего не возвращает, затем запустите `flutter analyze`.

3. **Направьте делегаты локализации на пакеты.** Делегаты и переведённые строки переехали в `material_ui` и `cupertino_ui`, а пакеты предоставляют агрегирующий геттер, который избавляет от перечисления трёх делегатов вручную.

   ```dart
   // Before: flutter_localizations, Flutter 3.43
   import 'package:flutter_localizations/flutter_localizations.dart';

   localizationsDelegates: const <LocalizationsDelegate<Object>>[
     GlobalMaterialLocalizations.delegate,
     GlobalCupertinoLocalizations.delegate,
     GlobalWidgetsLocalizations.delegate,
   ],
   ```

   ```dart
   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';

   localizationsDelegates: GlobalMaterialLocalizations.delegates,
   ```

   `GlobalMaterialLocalizations.delegates` уже включает делегаты Cupertino и Widgets. Если вы дополнительно используете `gen-l10n`, ваш сгенерированный `AppLocalizations.delegate` не затрагивается и добавляется в этот список как раньше. Теперь `flutter_localizations` можно убрать из собственных `dependencies`, хотя он останется в `pubspec.lock`: `cupertino_ui` 1.0.2 всё ещё зависит от него, наряду с `collection: ^1.19.1` и `intl: ^0.20.2`. Проверьте запуском с локалью, отличной от английской, и посмотрите на встроенную строку: например, зажмите `TextField` и убедитесь, что пункт вставки переведён.

4. **Постройте мост для зависимостей, которые не перенесены.** Именно этот шаг пропускают, а потом час отлаживают. Оберните на уровне приложения через `MaterialApp.builder`:

   ```dart
   // material_ui 1.1.1
   MaterialApp(
     theme: ThemeData(useMaterial3: true),
     builder: (BuildContext context, Widget? child) {
       return MaterialUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   Сторона Cupertino симметрична:

   ```dart
   // cupertino_ui 1.0.2
   CupertinoApp(
     builder: (BuildContext context, Widget? child) {
       return CupertinoUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   Можно обернуть и более узкое поддерево, если старые виджеты встроены только на одном экране: тогда дополнительные inherited-виджеты не попадут в остальное дерево. Проверьте, зайдя на каждый экран, где размещён виджет из сторонних пакетов. Мост - временные подмостки: удалите его, как только `flutter pub outdated` перестанет показывать что-либо на старых импортах.

5. **Перегенерируйте всё, что написал генератор кода.** `dart fix` видит ваши исходники, а не шаблоны, из которых они получились. Запустите генератор заново после шага 2, чтобы сгенерированные файлы перестали импортировать библиотеку из SDK:

   ```sh
   dart run build_runner build --delete-conflicting-outputs
   ```

   Затем проверьте остатки, до которых `dart fix` не дотягивается: barrel-файлы с `export`, реэкспортирующие Material для потребителей, условные импорты, выбирающие реализацию Material под платформу, и любой ваш собственный шаблон генератора, где путь импорта задан строкой. Проверьте тем же `grep` из шага 2, расширив его на весь репозиторий, а не только на `lib` и `test`.

6. **Если вы публикуете пакет, поднимите мажорную версию.** Перевод опубликованного пакета на `material_ui` меняет то, что должно быть в `pubspec.yaml` у его потребителей. Выпуск этого как минорной версии ломает приложения молча: их дерево виджетов смешивает источники, и никакой ошибки компиляции на это не укажет. Поднимите мажорную версию, отметьте в changelog требуемое ограничение `material_ui` и держите предыдущую мажорную версию в ветке поддержки, если вы обслуживаете старые версии Flutter. Проверьте через `dart pub publish --dry-run`.

## Проверка

- `flutter analyze` выдаёт то же число, что и базовая линия до миграции, без `uri_does_not_exist` и без `deprecated_member_use` на строке импорта.
- `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" .` ничего не находит за пределами `.dart_tool` и `pubspec.lock`.
- `flutter test` проходит, golden-тесты в том числе и без изменений. Сдвинувшийся golden означает, что в одном дереве рендерят две копии библиотеки, а не что Material изменился.
- Приложение запускается на устройстве, и каждый экран со встроенным виджетом из сторонних пакетов рендерится с вашей темой, а не со значениями по умолчанию.
- Локаль, отличная от английской, после шага 3 по-прежнему показывает переведённые встроенные строки.
- `flutter build apk --release --analyze-size` (или эквивалент для iOS) как базовая линия по размеру на будущее, когда копии из SDK будут удалены и tree-shaking действительно сможет выбросить неиспользуемую дизайн-систему.

## План откката

Сегодня полностью обратимо. Изменения - это diff `pubspec.yaml`, одна строка импорта на файл, список делегатов и необязательный виджет-мост, поэтому `git revert` коммита миграции возвращает вас к библиотекам SDK без данных или артефактов сборки, которые пришлось бы разворачивать. Две оговорки: обратного `dart fix` не существует, поэтому ручной откат означает правку каждого импорта руками, и именно поэтому нулевой шаг - это ветка. И после stable-выпуска в ноябре 2026 года откат ставит вас на формально устаревшие API, которые будут удалены, так что относитесь к откату как к способу разблокировать релиз, а не как к решению.

## На чём спотыкаются

**"Could not find an ancestor of type MaterialLocalizations" из кода, который вы не писали.** Это проблема идентичности типов, проявившаяся в среде выполнения. Виджет, скомпилированный против библиотеки из SDK, вызывает `MaterialLocalizations.of(context)`, который обходит дерево в поисках inherited-виджета *своего* типа `MaterialLocalizations`. Ваш `MaterialApp` из `material_ui` вставил другой тип с тем же именем, поиск промахивается, и срабатывает assert. `Theme.of(context)` падает точно так же, с сообщением "Could not find an ancestor of type Theme". Мост из шага 4 существует именно для того, чтобы вставить старые inherited-виджеты рядом с новыми, и тогда оба поиска разрешаются. Это не заплатка на отсутствующий `Scaffold`: если ошибка приходит из вашего собственного перенесённого кода, у вас обычная проблема, описанная в [no Material widget found во Flutter](/ru/2026/08/fix-no-material-widget-found-in-flutter/), и мост не поможет.

**Неразрешимый импорт сразу после запуска исправления.** Вы запустили `dart fix` до `flutter pub add`. Добавьте пакет и запустите `dart fix --apply --code=migrate_design_widgets` снова; правило идемпотентно.

**Не оставляйте оба импорта в одном файле.** `package:flutter/material.dart` и `package:material_ui/material_ui.dart` экспортируют одни и те же идентификаторы, поэтому любой файл с обоими получает ошибки неоднозначного импорта на `Material`, `Theme`, `Colors` и прочем. Префикс для одного из них компилируется, но даёт две дизайн-системы в одном файле, что хуже ошибки. Выбирайте одно на файл.

**Дата заморозки и дата устаревания - не одно и то же.** [Объявление о заморозке кода](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze) говорило, что библиотеки в SDK будут объявлены устаревшими в stable-выпуске *после* 3.44. Это сдвинулось: 3.47 вышел 2026-08-12 без объявления устаревания, а [заметки к выпуску 3.47](https://flutter.dev/blog/whats-new-in-flutter-3-47) теперь относят формальное устаревание к ноябрьской stable. Заморожены с апреля, устареют в ноябре, удалены позже. Планируйте под ноябрь, а не под то, о чём ваш анализатор сегодня молчит.

**Манифесты ресурсов могут измениться, даже если виджеты нет.** `material_ui` 1.1.0 выставил шейдерный ресурс `ink_sparkle` через собственный `pubspec.yaml` и убрал шейдер `stretch_effect`. Если вы проверяете манифест ресурсов или вырезаете неиспользуемые ресурсы на шаге сборки, это реальный diff, который стоит просмотреть.

**Переносите импорты и версии Flutter отдельными коммитами.** Если в том же проходе перескочить версию SDK, у любой визуальной регрессии окажется два кандидата в причины. Сначала внесите обновление SDK, убедитесь, что приложение чистое, и только потом переносите импорты.

## Связанные материалы

- Объявление, продолжением которого является эта миграция, включая значение SwiftPM по умолчанию из того же выпуска, разобрано в [Flutter 3.44 выносит Material и Cupertino из SDK](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Структурно это тот же широкий механический проход, что и [миграция веб-приложения Flutter с dart:html на package:web](/ru/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/), включая часть, где `dart fix` берёт на себя простые 95 %, а граф зависимостей берёт на себя вас.
- Для устаревания, которое `dart fix` заведомо не автоматизирует, сравните с [заменой Radio.groupValue и onChanged на RadioGroup](/ru/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- Если в этом же цикле вы переходите на текущую stable, прочитайте [что Flutter 3.47 изменил в рендеринге на десктопе](/ru/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/), прежде чем списывать визуальную регрессию на смену пакетов.
- Сбои поиска предка - это целое семейство, а не единичный случай. [ScaffoldMessenger.of(context) does not contain a Scaffold](/ru/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/) - тот же метод отладки, применённый к другому inherited-виджету.

## Источники

- [material_ui на pub.dev](https://pub.dev/packages/material_ui), версия 1.1.1, и его [changelog](https://pub.dev/packages/material_ui/changelog)
- [cupertino_ui на pub.dev](https://pub.dev/packages/cupertino_ui), версия 1.0.2
- [Flutter's Material and Cupertino code freeze](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze), блог Flutter
- [What's new in Flutter 3.44](https://flutter.dev/blog/whats-new-in-flutter-3-44), блог Flutter
- [What's new in Flutter 3.47](https://flutter.dev/blog/whats-new-in-flutter-3-47), блог Flutter
- [Issue для отслеживания развязки дизайн-системы](https://github.com/flutter/flutter/issues/172932), flutter/flutter
- [Заметки к выпуску Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0), docs.flutter.dev
