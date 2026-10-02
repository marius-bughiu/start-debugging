---
title: "Исправление: Undefined name 'awaitNotRequired' в material_ui или cupertino_ui на Flutter 3.44"
description: "material_ui 1.3.0 и cupertino_ui 1.1.0 используют аннотацию, которую Flutter 3.44 не экспортирует. Обе версии отозваны, но lock-файл их сохраняет. Выполните downgrade, затем upgrade, чтобы получить 1.2.0 и 1.0.2."
pubDate: 2026-10-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-44"
  - "dart"
  - "pub"
lang: "ru"
translationOf: "2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44"
translatedBy: "claude"
translationDate: 2026-10-02
---

Ваш `pubspec.lock` закрепляет `material_ui` 1.3.0 и/или `cupertino_ui` 1.1.0, два релиза, которые используют `@awaitNotRequired`, а `package:flutter/foundation.dart` экспортирует эту аннотацию только начиная с Flutter 3.47.0. Обе версии теперь отозваны (retracted) на pub.dev, но pub сохраняет отозванную версию, которую вы уже зафиксировали, и на Flutter 3.44 даже `flutter pub upgrade` не сдвинет вас с неё. Выполните `flutter pub downgrade material_ui cupertino_ui`, а затем `flutter pub upgrade` (в итоге вы получите `material_ui` 1.2.0 и `cupertino_ui` 1.0.2) или обновите Flutter до 3.47. Всё описанное ниже измерено на Flutter 3.44.8 (Dart 3.12.2) и Flutter 3.47.6 (Dart 3.13.5) 2026-10-02.

## Ошибка в контексте

Анализатор молчит, `flutter pub get` проходит успешно, а затем первая же настоящая компиляция падает внутри кеша pub. Это `flutter build web` на 3.44.8; все остальные платформы запускают один и тот же фронтенд Dart над теми же исходниками, поэтому `flutter run` падает на тех же строках:

```text
Target dart2js failed: ProcessException: Process exited abnormally with exit code 1:
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/bottom_sheet.dart:1304:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/carousel.dart:1982:4:
Error: Not a constant expression.
  @awaitNotRequired
   ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/dialog.dart:1672:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
...
/Users/marius/.pub-cache/hosted/pub.dev/cupertino_ui-1.1.0/lib/src/route.dart:1347:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
```

`material_ui` 1.3.0 выдаёт восемь таких ошибок (`showModalBottomSheet`, `CarouselController.animateToItem`, `showDatePicker`, `showDateRangePicker`, `showDialog`, `showAdaptiveDialog`, `showMenu`, `showTimePicker`), а `cupertino_ui` 1.1.0 добавляет ещё две (`showCupertinoModalPopup`, `showCupertinoDialog`). Вариант `Not a constant expression` это та же ошибка: аннотацию на методе экземпляра фронтенд сообщает иначе. Обратите внимание, что `flutter analyze` в вашем проекте ничего не показывает, потому что анализатор не выводит ошибки внутри зависимостей. Их находит только шаг компиляции.

Напрямую зависеть от `material_ui` не обязательно, чтобы столкнуться с этим. Например, `shimmer` 4.0.0 зависит от `material_ui: ^1.0.1`, поэтому `flutter pub add shimmer` на Flutter 3.44 в период между 2026-09-15 и отзывом транзитивно подтягивал 1.3.0. Именно так с этим столкнулся автор отчёта [flutter/flutter#192839](https://github.com/flutter/flutter/issues/192839).

## Почему Flutter 3.44 не видит аннотацию, которая есть в его собственном пакете meta

`awaitNotRequired` не новая. Она живёт в `package:meta` начиная с 1.17.0, а Flutter 3.44.8 закрепляет `meta` 1.18.0, где она уже есть. Константа лежит прямо в вашем кеше pub. Не хватает 3.44 именно реэкспорта.

`material_ui` и `cupertino_ui` никогда не импортируют `package:meta`. Их библиотечные файлы импортируют `package:flutter/foundation.dart` и полагаются на то, что он реэкспортирует из `meta`. На Flutter 3.44 этот список закрыт:

```dart
// packages/flutter/lib/foundation.dart, Flutter 3.44.8
export 'package:meta/meta.dart'
    show
        factory,
        immutable,
        internal,
        // ignore: experimental_member_use
        mustBeConst,
        mustCallSuper,
        nonVirtual,
        optionalTypeArgs,
        protected,
        required,
        visibleForOverriding,
        visibleForTesting;
```

[flutter/flutter#181513](https://github.com/flutter/flutter/pull/181513) ("Add @awaitNotRequired annotation to flutter sdk") добавил `awaitNotRequired` в этот список `show` 2026-04-25. Он не попал в ветку 3.44 и вышел во Flutter 3.47.0 2026-08-12. В любом релизе 3.44.x (с 3.44.0 по 3.44.9) этот идентификатор просто не находится в области видимости для кода, который импортирует только `foundation.dart`.

Пакеты же разрабатываются против канала main Flutter. [flutter/packages#12622](https://github.com/flutter/packages/pull/12622) и [#12817](https://github.com/flutter/packages/pull/12817) добавили аннотации, а `material_ui` 1.3.0 и `cupertino_ui` 1.1.0 вышли 2026-09-15 с аннотациями, но с тем же `environment`, что и раньше:

```yaml
# material_ui 1.3.0 pubspec.yaml
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
```

Pub доверяет этому ограничению, поэтому на Flutter 3.44 он выбрал 1.3.0 как самую новую совместимую версию. Исправление в upstream было двойным: `material_ui` 1.4.0 и `cupertino_ui` 1.1.1 (обе 2026-09-21/22) подняли нижнюю границу до `flutter: ">=3.47.0"` и `sdk: ^3.13.0`, а 1.3.0 и 1.1.0 были отозваны. Issue закрыли 2026-09-21.

## Минимальный пример воспроизведения

Отозванные версии всё ещё можно принудительно закрепить через `dependency_overrides`, и это самый простой способ намеренно воспроизвести сбой сборки:

```yaml
# pubspec.yaml, Flutter 3.44.8 / Dart 3.12.2
name: repro
publish_to: 'none'
environment:
  sdk: ^3.12.0
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
dependency_overrides:
  material_ui: 1.3.0
  cupertino_ui: 1.1.0
```

```dart
// lib/main.dart, Flutter 3.44.8, material_ui 1.3.0
import 'package:material_ui/material_ui.dart';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('hi')))),
);
```

`flutter pub get` проходит успешно, `flutter analyze` не сообщает об ошибках, а `flutter build web` падает с выводом выше. Без override команда `flutter pub add material_ui:1.3.0` теперь прямо отказывает с сообщением `Because repro depends on material_ui 1.3.0 which doesn't match any versions, version solving failed.`, поскольку решатель скрывает отозванные версии, если они не закреплены и не зафиксированы в lock-файле.

## Почему отзыв не исправил ваш проект

Если вы запускали `pub get`, пока 1.3.0 была доступна, ваш `pubspec.lock` содержит `version: "1.3.0"`, а отзыв lock-файлы не затрагивает. [Документация pub](https://dart.dev/tools/pub/publishing#retract) прямо говорит, что зафиксированная отозванная версия продолжает работать. Быстрее всего подтвердить, что вы в этом состоянии, поможет `flutter pub outdated`:

```text
Package Name              Current             Upgradable          Resolvable          Latest

direct dependencies:
material_ui               *1.3.0 (retracted)  *1.3.0 (retracted)  *1.3.0 (retracted)  1.5.0

transitive dependencies:
cupertino_ui              *1.1.0 (retracted)  *1.1.0 (retracted)  *1.1.0 (retracted)  1.1.1
...
material_ui
    Version 1.3.0 is retracted. See https://dart.dev/go/package-retraction
cupertino_ui
    Version 1.1.0 is retracted. See https://dart.dev/go/package-retraction
```

Посмотрите на столбцы Upgradable и Resolvable: сам pub сообщает, что не сдвинет вас. Та же документация pub рекомендует `dart pub upgrade <package>`, чтобы уйти с отозванной версии, а на Flutter 3.44 это ничего не делает:

```text
$ flutter pub upgrade material_ui cupertino_ui
  cupertino_ui 1.1.0 (retracted, 1.1.1 available)
  material_ui 1.3.0 (retracted, 1.5.0 available)
No dependencies changed.
```

Причина кроется в решателе. В `lib/src/solver/version_solver.dart` функция `_getAllowedRetracted` возвращает `_lockFile.packages[package]?.version` независимо от того, был ли пакет разблокирован для обновления. Поэтому во время `upgrade` зафиксированная отозванная версия остаётся допустимым кандидатом. Каждый более новый релиз (1.4.0, 1.5.0, 1.1.1) требует Flutter 3.47, так что самая высокая версия, которую решатель может выбрать на 3.44, это та самая отозванная, что у вас уже есть. Совет из документации работает только тогда, когда существует более новый *совместимый* релиз, а на 3.44 такого нет.

## Исправление 1: остаться на Flutter 3.44 и вернуться к material_ui 1.2.0

Нужно, чтобы lock-файл перестал упоминать 1.3.0 и 1.1.0. Самый чистый способ: выполнить downgrade, а затем upgrade, чтобы отозванная версия исчезла из lock-файла до запуска upgrade:

```bash
# Flutter 3.44.8: escape the retracted versions
flutter pub downgrade material_ui cupertino_ui
flutter pub upgrade
```

Первая команда переводит оба пакета на самые низкие версии, которые разрешают ваши ограничения (`material_ui` 1.0.0 и `cupertino_ui` 0.0.2 при `^1.0.0`), что заодно удаляет отозванные записи из `pubspec.lock`. Вторая поднимает их обратно до самых новых неотозванных версий, которые принимает 3.44:

```text
> cupertino_ui 1.0.2 (was 0.0.2) (1.1.1 available)
> material_ui 1.2.0 (was 1.0.0) (1.5.0 available)
```

После этого `flutter build web` на 3.44.8 проходит успешно. Ручное удаление записей `material_ui` и `cupertino_ui` из `pubspec.lock` и запуск `flutter pub get` даёт тот же результат (1.2.0 и 1.0.2), как и удаление всего lock-файла, хотя это заново разрешает и всё остальное в вашем графе зависимостей. Не пропускайте `cupertino_ui`: обычно это транзитивная зависимость, и если назвать только `material_ui`, версия 1.1.0 останется зафиксированной и по-прежнему сломанной.

Закоммитьте новый `pubspec.lock`. Если ваш CI запускает `flutter pub get --enforce-lockfile`, он устанавливает ровно то, что указано в закоммиченном lock-файле, поэтому сборка продолжит падать там, пока новый lock-файл не попадёт в репозиторий.

## Исправление 2: перейти на Flutter 3.47, этого сейчас ожидают пакеты

`material_ui` 1.4.0 и новее требуют Flutter 3.47, и новые исправления появляются только там. Если вы можете обновиться, это долгосрочный ответ:

```bash
# Flutter 3.47.6 / Dart 3.13.5
flutter upgrade
flutter pub upgrade
```

На 3.47.6 upgrade работает так, как описывает документация pub, потому что теперь существуют более новые совместимые версии:

```text
> cupertino_ui 1.1.1 (was 1.1.0)
> material_ui 1.5.0 (was 1.3.0)
```

Строго говоря, обновлять пакеты даже не обязательно: отозванная 1.3.0 прекрасно компилируется на Flutter 3.47.6, потому что `foundation.dart` теперь реэкспортирует аннотацию. Тем не менее я рекомендую запустить `flutter pub upgrade`, чтобы lock-файл перестал указывать на отозванный релиз, о чём `flutter pub outdated` иначе будет предупреждать постоянно.


Переход на 3.47 это более масштабное изменение, чем обновление пакетов. Он приносит Dart 3.13 (который, среди прочего, [запрещает `final` у обычных параметров](/ru/2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters/)) и делает Impeller рендерером по умолчанию на десктопе, поэтому относитесь к нему как к плановому обновлению, а не как к срочному исправлению.

## Исправление 3: задать ограничение в pubspec.yaml, чтобы это не повторилось на 3.44

Если вы остаётесь на 3.44 на некоторое время, явно ограничьте пакеты. Это документирует решение и не даёт `pub upgrade` коллеги уйти не туда, если выйдет ещё один релиз с неверным `environment`:

```yaml
# pubspec.yaml, Flutter 3.44.x
dependencies:
  material_ui: ">=1.0.0 <1.3.0"
  cupertino_ui: ">=1.0.0 <1.1.0"
```

Добавьте `cupertino_ui`, даже если вы его не импортируете. Когда я ограничил только `material_ui` и запустил `flutter pub get` на сломанном lock-файле, pub перевёл `material_ui` на 1.2.0, но оставил транзитивный `cupertino_ui` на отозванной 1.1.0, потому что ничто не вынуждало его меняться. С обоими ограничениями тот же `flutter pub get` перевёл их на 1.2.0 и 1.0.2.

## То, что выглядит исправлением, но им не является

- **Повышение `meta`.** `meta` 1.18.0 уже объявляет `awaitNotRequired`, а фреймворк Flutter 3.44 закрепляет `meta` ровно на 1.18.0 в собственном `pubspec.yaml`, так что повысить версию всё равно не получится. Проблема в списке `show` в `foundation.dart`, а не в версии `meta`.
- **Объявление собственной `awaitNotRequired`.** Разрешение имён происходит внутри библиотек `material_ui`. Константа верхнего уровня в вашем приложении не входит в их область видимости.
- **`flutter clean` или очистка кеша pub.** Плохая версия выбирается вашим lock-файлом, а не устаревшим результатом сборки, поэтому при следующем `pub get` она скачается снова.
- **Закрепление `material_ui: 1.3.0` в `dependencies`.** Отозванную версию таким способом выбрать невозможно вообще. Принудительно закрепить её может только `dependency_overrides`, а это лишь воспроизводит ошибку.

Если вы встретите `Undefined name` для другого идентификатора Flutter после миграции на отдельные пакеты, причина обычно та же, только в другом направлении: код скомпилирован против более нового фреймворка, чем установленный. `flutter --version` и блок `environment` пакета, указанного в пути ошибки, быстро покажут, какая сторона впереди.

## Связанные материалы

- Предыстория того, почему Material и Cupertino вынесли из SDK, изложена в [Flutter 3.44: Material и Cupertino в отдельных пакетах](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- О полной миграции импортов, включая `dart fix --code=migrate_design_widgets` и мосты совместимости, читайте в [миграции на пакеты material_ui и cupertino_ui](/ru/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Ещё одно несоответствие типов между двумя мирами Material описано в [ошибке google_fonts TextTheme с material_ui](/ru/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/).
- Когда pub вообще отказывается разрешать зависимости, а не разрешает их во что-то сломанное, начните с [исправления "version solving failed" в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/).
- Перед переходом на 3.47 прочитайте о том, как [Impeller становится рендерером по умолчанию на десктопе во Flutter 3.47](/ru/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).

## Источники

- [flutter/flutter#192839: material_ui 1.3.0 & cupertino_ui 1.1.0 on Flutter 3.44 Error: Undefined name 'awaitNotRequired'](https://github.com/flutter/flutter/issues/192839)
- [flutter/flutter#181513: Add @awaitNotRequired annotation to flutter sdk](https://github.com/flutter/flutter/pull/181513)
- [flutter/packages#12622: Add awaitNotRequired annotation to material_ui](https://github.com/flutter/packages/pull/12622) и неслитый revert [#12942](https://github.com/flutter/packages/pull/12942)
- [material_ui changelog](https://pub.dev/packages/material_ui/changelog) и [cupertino_ui changelog](https://pub.dev/packages/cupertino_ui/changelog)
- [Retract a package version](https://dart.dev/tools/pub/publishing#retract), документация Dart
- [`version_solver.dart` в dart-lang/pub](https://github.com/dart-lang/pub/blob/master/lib/src/solver/version_solver.dart)
- [Документация API `awaitNotRequired` в package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html)
