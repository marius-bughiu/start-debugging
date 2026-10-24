---
title: "Что такое линт depend_on_referenced_packages в Dart и почему он срабатывает на транзитивные импорты"
description: "depend_on_referenced_packages срабатывает, когда файл импортирует или экспортирует пакет, которого нет в вашем собственном pubspec.yaml, даже если он подтягивается через другую зависимость. Что именно проверяет это правило на Dart 3.12.2 и Flutter 3.44.8, почему транзитивные импорты это настоящая ошибка и как исправить каждый вариант."
pubDate: 2026-10-24
tags:
  - "dart"
  - "flutter"
  - "lints"
  - "pub"
  - "pubspec"
lang: "ru"
translationOf: "2026/10/what-is-the-depend-on-referenced-packages-lint-in-dart"
translatedBy: "claude"
translationDate: 2026-10-24
---

**Краткий ответ:** `depend_on_referenced_packages` сообщает о любом `import` или `export` вида `package:foo/...`, если `foo` не указан в собственном `pubspec.yaml` импортирующего пакета. Правило не учитывает, что `foo` прекрасно разрешается, потому что его подтягивает одна из ваших зависимостей: транзитивный пакет вы берёте взаймы, с версией, которую не контролируете, и с наличием, которое ничем не гарантировано. Исправление: объявите пакет сами (`dart pub add foo` или `flutter pub add foo`), в `dependencies`, если импорт находится в `lib/`, `bin/`, `hook/build.dart` или `hook/link.dart`, и в `dev_dependencies` только если он находится в другом месте, например в `test/` или `tool/`. Всё ниже проверено на Dart 3.12.2 и Flutter 3.44.8 с `lints` 6.1.0 и `flutter_lints` 6.0.0.

Правило существует с Dart 2.14 и входит в набор **core** в [`package:lints`](https://pub.dev/packages/lints), а значит, его включают и `lints/recommended.yaml`, и `flutter_lints`. Обычно с ним сталкиваются впервые, когда в новом приложении Flutter набирают `import 'package:collection/collection.dart';` и получают голубое подчёркивание на строке, которая прекрасно компилируется и работает.

## Почему работающий импорт всё равно помечается

Когда вы запускаете `flutter pub get`, pub разрешает весь граф зависимостей и записывает каждый пакет из него в `.dart_tool/package_config.json`. Компилятор и анализатор разрешают URI `package:` через этот файл, а в нём есть и ваши транзитивные зависимости. Поэтому `package:http_parser` разрешается в проекте, который зависит только от `http`: `http` зависит от `http_parser`, так что он есть в конфигурации пакетов.

Сегодня импорт работает случайно. Позже его могут сломать три вещи, и ни одна из них не видна в вашем диффе:

1. **Посредник убирает зависимость.** Если `http` 2.0 перестанет зависеть от `http_parser`, ваш следующий `pub upgrade` уберёт его из графа, и сборка упадёт с `Target of URI doesn't exist`. В вашем `pubspec.yaml` ничего не менялось.
2. **Версию выбирали не вы.** Ваш код написан под ту версию `http_parser`, которую случайно допустило ограничение `http`. Мажорное обновление транзитивного пакета, которое `http` допускает, становится для вас ломающим изменением, и ни одно ваше ограничение этому не помешает.
3. **Ваши потребители его не получат.** Если вы публикуете пакет, пользователи разрешают собственный граф. Dev-зависимости никогда не бывают транзитивными, поэтому всё, что ваш код в `lib/` импортирует из dev-зависимости, у них просто не существует.

Линт превращает эти три скрытых сбоя в одну видимую информационную диагностику на месте импорта. [Официальная страница правила](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) резюмирует его как "Depend on referenced packages", а логика такая: явная зависимость это единственный способ одновременно гарантировать наличие пакета и наложить на него собственное ограничение версии.

## Что на самом деле проверяет правило

Реализация короткая, и её стоит прочитать: [`pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) в Dart SDK. Для каждой библиотеки строится список разрешённых имён пакетов:

- собственное `name` пакета (так что самоимпорты `package:my_app/...` всегда допустимы),
- каждый ключ в `dependencies`,
- каждый ключ в `dev_dependencies`, **но только если файл не находится в публичном месте**.

Файл считается публичным, если он лежит в `lib/` или `bin/`, либо это ровно `hook/build.dart` или `hook/link.dart` (хуки сборки native assets, добавленные после [dart-lang/sdk#54334](https://github.com/dart-lang/sdk/issues/54334)). Затем правило обходит каждую директиву `import` и `export`, берёт первый сегмент пути после `package:` и сообщает о нём, если имени нет в списке разрешённых.

Из этого кода напрямую следует несколько вещей:

- `dependency_overrides` не учитываются. Пакет, который есть только там, всё равно "не является зависимостью".
- Директивы `export` проверяются точно так же, как импорты.
- Проверяется только основной URI директивы, но не URI внутри условных конструкций `if (dart.library.io) ...`.
- Единственное жёстко заданное исключение это `flutter_gen`, старый синтетический пакет локализации (см. [dart-lang/linter#3308](https://github.com/dart-lang/linter/issues/3308)).
- Наследования от корневого пакета или рабочей области нет. Каждый пакет проверяется по своему собственному pubspec.

## Пример, который вызывает все варианты

Вот небольшой чистый Dart-пакет, который зависит только от `http` и держит `meta` как dev-зависимость:

```yaml
# pubspec.yaml -- Dart 3.12.2
name: repro
version: 1.0.0

environment:
  sdk: ^3.12.0

dependencies:
  http: ^1.6.0

dev_dependencies:
  lints: ^6.1.0
  meta: ^1.18.0

dependency_overrides:
  path: ^1.9.1
```

```yaml
# analysis_options.yaml
include: package:lints/recommended.yaml
```

```dart
// lib/repro.dart -- Dart 3.12.2
import 'package:http/http.dart' as http;          // declared: OK
import 'package:http_parser/http_parser.dart';   // transitive via http: LINT
import 'package:meta/meta.dart';                 // dev_dependency in lib/: LINT
import 'package:repro/src/helpers.dart';         // self package: OK
export 'package:async/async.dart' show Result;   // transitive export: LINT

@immutable
class Probe {
  const Probe();

  Future<MediaType> contentType(Uri uri) async {
    final response = await http.head(uri);
    return MediaType.parse(response.headers['content-type'] ?? 'text/plain');
  }
}

final helper = helperValue;
```

Добавьте тот же `import 'package:meta/meta.dart';` в `bin/repro.dart`, `hook/build.dart`, `tool/gen.dart` и `test/repro_test.dart`, импортируйте `package:http_parser` ещё и из теста и импортируйте `package:path` (только в override) из `lib/src/over.dart`. `dart analyze` сообщает:

```text
info - bin/repro.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - hook/build.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:3:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:5:8 - The imported package 'async' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/src/over.dart:1:8 - The imported package 'path' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - test/repro_test.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

Обратите внимание, чего здесь нет: `tool/gen.dart` и импорт `meta` в `test/` чисты, потому что dev-зависимости разрешены вне публичных мест. Обратите внимание и на то, что сообщение одинаково, отсутствует ли пакет вообще или просто лежит не в том разделе. "Isn't a dependency" может означать "это dev-зависимость, а файл публичный".

## Та же проблема во Flutter

В приложении Flutter транзитивные пакеты, которые вы скорее всего импортируете случайно, это те, от которых зависит сам SDK: `collection`, `meta`, `vector_math`, `characters`, `material_color_utilities`. Они всегда есть в графе, потому что нужны `flutter`. Новое приложение, созданное через `flutter create --empty`, с таким файлом:

```dart
// lib/probe.dart -- Flutter 3.44.8
import 'package:collection/collection.dart';
import 'package:meta/meta.dart';
import 'package:vector_math/vector_math_64.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
```

получает четыре информационных сообщения `depend_on_referenced_packages`. Для `flutter_localizations` вдобавок выдаётся жёсткая ошибка `uri_does_not_exist`, потому что это отдельный пакет SDK, которого нет в графе, пока вы его не запросите. Линт из двух диагностик более дружелюбный, но суть проблемы одна и та же.

## Как исправить, по случаям

1. **Транзитивный пакет, импортируемый из `lib/`.** Объявите его как обычную зависимость. Пусть ограничение выберет pub, а не вы наугад:

   ```bash
   # Flutter 3.44.8
   flutter pub add collection meta vector_math
   ```

   ```yaml
   dependencies:
     collection: ^1.19.1
     flutter:
       sdk: flutter
     meta: ^1.18.0
     vector_math: ^2.2.0
   ```

2. **Пакет SDK, например `flutter_localizations`.** Ему нужна форма `sdk: flutter`, которую `pub add` принимает в виде JSON-дескриптора:

   ```bash
   flutter pub add 'flutter_localizations:{"sdk":"flutter"}'
   ```

3. **Dev-зависимость, импортируемая из `lib/`, `bin/` или хука сборки.** Либо переместите её в `dependencies` (`dart pub add meta` перенесёт её за вас), либо вынесите импортирующий код из публичного каталога. Для пакетов, содержащих только аннотации, вроде `meta`, правильный выбор это перенос в `dependencies`: иначе опубликованный пакет с `@immutable` в `lib/` не скомпилируется у потребителей.

4. **Пакет, который существует только в `dependency_overrides`.** Переопределение меняет версию того, что уже есть в графе, но не объявляет зависимость. Добавьте ещё и обычную запись, а переопределение оставьте, если оно всё ещё нужно.

5. **Пакет, экспортируемый из вашей библиотеки.** Исправление то же, что и для импорта. Если вы реэкспортируете `Result` из `package:async`, ваш публичный API теперь зависит от версии `async`, и именно поэтому вам нужно собственное ограничение на неё.

Для этого правила нет `dart fix`: на примере `dart fix --dry-run` сообщает "Nothing to fix!". Быстрое исправление в IDE добавляет пакет в `pubspec.yaml`, а `pub add` делает то же самое из терминала.

## Подводные камни и граничные случаи

### SDK Flutter фиксирует ваше ограничение

Пакеты вроде `meta` и `collection` закреплены `flutter` и `flutter_test` на точных версиях. Если вы напишете ограничение выше закреплённой версии, разрешение завершится ошибкой:

```text
Note: meta is pinned to version 1.18.0 by flutter_test from the flutter SDK.

Because every version of flutter_test from sdk depends on meta 1.18.0 and fapp depends on meta ^1.19.0, flutter_test from sdk is forbidden.
So, because fapp depends on flutter_test from sdk, version solving failed.
```

Поэтому `flutter pub add` лучше, чем ввод ограничения вручную: он выбирает версию, удовлетворяющую закреплению. Если вы уже получили эту ошибку, разбор в статье [исправление "version solving failed" в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/) объясняет, как читать вывод решателя. Ожидайте, что `pubspec.lock` будет меняться, когда вы позже смените версии Flutter, поскольку закрепления движутся вместе с SDK; почему так происходит, объясняет [этот разбор pubspec.lock](/ru/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).

### Рабочие области pub не наследуют зависимости

В рабочей области pub из Dart 3.6+ все участники используют одно разрешение и один `package_config.json`, поэтому участник может импортировать всё, от чего зависит любой другой участник. Линт этого не позволяет. Корневой `pubspec.yaml` с `http` в `dependencies` и участник `pkgs/app` с `resolution: workspace` и без зависимостей всё равно даёт:

```text
info - pkgs/app/lib/app.dart:1:8 - The imported package 'http' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

В монорепозитории это именно то поведение, которое нужно. Общее разрешение упрощает случайное заимствование между пакетами, а линт не даёт пакету незаметно полагаться на список зависимостей соседа. Если сервер анализа тормозит в большой рабочей области, это отдельная проблема, см. [ускорение сервера анализа Dart в большом монорепозитории Flutter](/ru/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

### Условные импорты проскальзывают

Правило проверяет только основной URI директивы. Этот код проходит линт, хотя `path` не объявлен:

```dart
// lib/src/cond.dart -- Dart 3.12.2
import 'package:repro/src/helpers.dart'
    if (dart.library.io) 'package:path/path.dart';
```

`dart pub publish --dry-run` на Dart 3.12.2 его тоже не пометил. Считайте условные по платформе импорты тем, что нужно проверять вручную при ревью.

### `dart pub publish` применяет то же правило как ошибку

Для публикуемых пакетов собственный валидатор pub запускает более строгую версию этой проверки. На примере `dart pub publish --dry-run` превратил находки в lib, bin и hook в жёсткие ошибки:

```text
* line 3, column 1 of lib/repro.dart: meta is in the `dev_dependencies` section of `pubspec.yaml`. Packages used in lib/ must be declared in the `dependencies` section.
* line 2, column 1 of lib/repro.dart: This package does not have http_parser in the `dependencies` section of `pubspec.yaml`.
```

Находка в `test/` возвращается только как предупреждение. Так что игнорирование линта в публикуемом пакете просто переносит сбой на день релиза.

### `flutter_gen` исключён, но уходит

Исключение для `flutter_gen` существует потому, что `flutter gen-l10n` раньше генерировал синтетический пакет, который не мог появиться ни в одном pubspec. Flutter объявил этот синтетический пакет устаревшим (см. [уведомление о ломающем изменении](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)); сгенерированные локализации теперь лежат в вашем собственном дереве исходников и импортируются через имя вашего пакета, а это линт уже разрешает.

### Не заглушайте его "только для одного dev-пакета"

Частая просьба: внести dev-пакет с аннотациями в белый список в `analysis_options.yaml`. [dart-lang/sdk#60026](https://github.com/dart-lang/sdk/issues/60026) просил именно этого и был закрыт без такой возможности. Ответ мейнтейнера: пакет, импортируемый из `lib/`, это настоящая зависимость, а если очень нужно, есть комментарии `// ignore:`. Если без этого никак, ограничьте подавление строкой, а не всем проектом:

```dart
// ignore: depend_on_referenced_packages
import 'package:meta/meta.dart';
```

Глобальное отключение правила (`depend_on_referenced_packages: false` в `linter: rules:`) также отключает единственное раннее предупреждение, которое вы получаете до того, как упадёт pub или сборка потребителя. Настройку линтов в целом проще понимать, когда знаешь, где именно смотрит каждое правило; [сравнение unawaited_futures и discarded_futures](/ru/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/) хороший пример двух правил, область действия которых уже, чем подсказывают их названия.

## Что почитать дальше

- [Fix: Version solving failed in pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Fix: pubspec.lock shows as modified after flutter upgrade or switching Flutter versions](/ru/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/)
- [unawaited_futures vs discarded_futures in Dart](/ru/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)
- [How to run dart fix across a whole repo to apply Flutter breaking-change migrations](/ru/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [How to speed up a slow Dart analysis server in VS Code for a large Flutter monorepo](/ru/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## Источники

- [Страница правила depend_on_referenced_packages](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) и [страница диагностики](https://dart.dev/tools/diagnostics/depend_on_referenced_packages)
- [Реализация правила в dart-lang/sdk](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) и [его тесты](https://github.com/dart-lang/sdk/blob/main/pkg/linter/test/rules/depend_on_referenced_packages_test.dart)
- [Набор правил core в package:lints](https://pub.dev/packages/lints)
- [dart-lang/sdk#60026: исключение для dev-зависимостей](https://github.com/dart-lang/sdk/issues/60026)
- [dart-lang/linter#3308: исключение для flutter_gen](https://github.com/dart-lang/linter/issues/3308)
- [Закрепление версии SDK](https://dart.dev/go/sdk-version-pinning)
- [Ломающее изменение Flutter: flutter generate l10n source](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)
