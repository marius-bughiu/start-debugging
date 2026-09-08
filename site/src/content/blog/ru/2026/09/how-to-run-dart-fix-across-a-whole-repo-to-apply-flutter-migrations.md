---
title: "Как запустить dart fix по всему репозиторию, чтобы применить миграции ломающих изменений Flutter"
description: "dart fix принимает один целевой каталог, и этим каталогом может быть корень репозитория: анализатор открывает по контексту на каждый вложенный pubspec.yaml и мигрирует все пакеты за один проход. Здесь полный набор флагов, четыре вещи, которые молча подавляют исправления и заставляют грязный репозиторий сообщать Nothing to fix, почему код возврата бесполезен в CI, и случай, когда трансформация Flutter выдаёт код, который не компилируется."
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "migration"
  - "tooling"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations"
translatedBy: "claude"
translationDate: 2026-09-08
---

`dart fix --apply` принимает единственный целевой каталог, и этим каталогом может быть корень вашего репозитория. Анализатор открывает отдельный контекст анализа для каждого вложенного `pubspec.yaml`, поэтому монорепозиторий с дюжиной пакетов мигрирует одной командой, уважая собственный `analysis_options.yaml` каждого пакета. Причина, по которой прогон по всему репозиторию так часто печатает `Nothing to fix!` на кодовой базе, явно заваленной предупреждениями об устаревании, не в поломанном инструменте: четыре не связанные между собой вещи подавляют исправления, и `dart fix` в каждом из этих случаев завершается с кодом 0. Команды `flutter fix` тоже не существует, несмотря на страницу документации под названием Flutter fix. Всё, что описано ниже, запускалось на Flutter 3.44.8 с Dart 3.12.2; поверхность команды и цитируемые здесь внутренности не изменились в ветке main SDK Dart, которая питает текущую стабильную линию Flutter 3.47.

## Вся поверхность команды это четыре флага

Прежде чем строить вокруг этого инструмента рабочий процесс на весь репозиторий, полезно знать, как мало в нём есть:

```console
$ dart fix --help
Apply automated fixes to Dart source code.

This tool looks for and fixes analysis issues that have associated automated fixes.

To use the tool, run either 'dart fix --dry-run' for a preview of the proposed changes for a project, or 'dart fix --apply' to apply the changes.

Usage: dart fix [arguments]
-h, --help                      Print this usage information.
-n, --dry-run                   Preview the proposed changes but make no changes.
    --apply                     Apply the proposed changes.
    --code=<code1,code2,...>    Apply fixes for one (or more) diagnostic codes.
```

Это всё. В `pkg/dartdev/lib/src/commands/fix.dart` есть два скрытых флага (`--compare-to-golden` для собственных тестов SDK и `--use-aot-snapshot`), и ни один из них вам не пригодится. Нет `--exclude`, нет поддержки шаблонов, нет аргумента с несколькими путями. Ровно одна позиционная цель, файл или каталог, по умолчанию текущий каталог. Если не передать ни `--apply`, ни `--dry-run`, либо передать оба сразу, команда печатает справку и возвращает 0, ничего не сделав.

Вторая вещь, которую стоит проверить пораньше:

```console
$ flutter fix --dry-run
Could not find a command named "fix".
```

Страница документации [Flutter fix](https://docs.flutter.dev/tools/flutter-fix) описывает возможность, а не команду. Вы запускаете `dart fix`, и пока `dart` в вашем `PATH` тот, что поставляется с SDK Flutter (`$FLUTTER_ROOT/bin/dart`), он находит миграционные данные фреймворка автоматически.

## Один прогон в корне репозитория покрывает каждый вложенный пакет

Именно здесь большинство команд ошибается, обычно написав цикл на `find` до того, как проверить, нужен ли он. Возьмём pub workspace с тремя участниками:

```yaml
# pubspec.yaml at the repo root, Dart 3.12.2
name: mono_root
environment:
  sdk: ^3.12.0
workspace:
  - packages/pkg_a
  - packages/pkg_b
  - apps/app
```

Одна команда в корне, один отчёт по всем трём:

```console
$ dart fix --dry-run
Computing fixes in mono (dry run)...

6 proposed fixes in 3 files.

apps/app/lib/main.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_a/lib/a.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_b/lib/b.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix
```

Это не возможность workspace. Два соседних пакета вообще без корневого `pubspec.yaml` обрабатываются точно так же, потому что анализатор находит корни контекстов, обходя дерево каталогов в поисках файлов `pubspec.yaml` и `analysis_options.yaml`. Каждый пакет сохраняет собственную конфигурацию линтов в течение этого единственного прогона, так что пакет, включивший `prefer_final_locals`, получает эти исправления, а его сосед нет.

`dart fix` к тому же итерируется. `FixCommand.maxPasses` равно 4, и весь расчёт повторяется, пока не перестанут появляться правки или пока не будет достигнут этот потолок. Эффект виден на одном операторе: `var b = Box(1);` превращается в `final b = const Box(1);`, для чего `prefer_final_locals` и `prefer_const_constructors` должны сработать в разных проходах по одной и той же строке.

## Почему пакет сообщает "Nothing to fix!", будучи полным устаревших API

Четыре разных механизма дают одинаковый вывод и одинаковый код возврата. Исключайте их в таком порядке.

**Пакет не разрешён.** `dart fix` нужен `.dart_tool/package_config.json`, чтобы понимать, что значит `package:lib_pkg/api.dart`, и без него нет диагностики `deprecated_member_use`, к которой можно привязать исправление. Тот же репозиторий, тот же файл, до и после `pub get`:

```console
$ dart fix --dry-run          # no pub get yet
Computing fixes in app (dry run)...
Nothing to fix!

$ dart pub get && dart fix --dry-run
Computing fixes in app (dry run)...

1 proposed fix in 1 file.

lib/main.dart
  deprecated_member_use - 1 fix
```

В монорепозитории это обычный виновник: CI разрешил приложение, но не шесть листовых пакетов, и миграция молча покрывает лишь часть дерева.

**Файлы исключены из анализа.** Список `exclude`, обычно добавленный годы назад, чтобы держать сгенерированный код вне отчёта линтера, также убирает эти файлы из множества исправлений:

```yaml
# analysis_options.yaml
analyzer:
  exclude:
    - lib/main.dart
```

```console
$ dart fix --dry-run
Nothing to fix!
```

**Диагностика понижена до `ignore`.** Этот случай самый разрушительный, потому что это стандартный ход, когда обновление Flutter заливает CI предупреждениями об устаревании:

```yaml
analyzer:
  errors:
    deprecated_member_use: ignore
```

Заглушив предупреждение, вы отключаете и соответствующую автоматическую миграцию. Если в вашем репозитории есть эта строка, уберите её до запуска `dart fix`, а не после.

**В строке стоит комментарий `// ignore:`.** Тот же эффект, на уровне файла или строки. `// ignore_for_file: deprecated_member_use` в начале большого файла с виджетами заставляет `dart fix` молча пропустить весь файл.

Для исправлений, идущих от линтов, есть пятый случай, который является замыслом, а не ловушкой: исправление существует, только если линт включён. `--code` это не переопределяет.

```console
$ dart fix --dry-run --code=prefer_final_locals   # lint not in analysis_options.yaml
Nothing to fix!
```

Добавьте правило, и та же команда найдёт исправление. Отсюда полезный одноразовый приём: временно включить линт для уборки, выполнить `dart fix --apply --code=<этот линт>`, а потом решить, оставлять ли правило включённым.

Ни один из этих пяти случаев не меняет статус завершения. Каждый прогон выше вернул 0. Единственный вызов, возвращающий ненулевой код, это неизвестный код диагностики:

```console
$ dart fix --apply --code=this_is_not_a_real_code
Computing fixes in app...
Unable to compute fixes: The diagnostic 'this_is_not_a_real_code' is not defined by the analyzer.
$ echo $?
3
```

Это стоит знать, потому что опечатка в CI-скрипте падает громко, а не пропускает миграцию.

## Прогон по всему репозиторию, по порядку

1. **Сначала обновите SDK, затем уберите глушители.** Трансформации устаревания существуют только для API, которые анализатор видит как устаревшие, поэтому `flutter upgrade` идёт первым. Затем поищите `deprecated_member_use: ignore` в каждом `analysis_options.yaml` и `ignore_for_file: deprecated_member_use` в `lib/` и удалите их. Пропустите это, и шаги 3 и 4 отрапортуют о чистом репозитории.

2. **Разрешите каждый пакет.** Внутри pub workspace один `dart pub get` в любом месте разрешает всё целиком (запущенный в пакете-участнике, он печатает `Resolving dependencies in /path/to/root` и пишет `.dart_tool` в корне). Вне workspace каждому пакету с собственным разрешением нужен свой `pub get`.

3. **Запустите один раз в корне и прочитайте отчёт.** `dart fix --dry-run` из корня репозитория, и проверьте, что список файлов упоминает каждый ожидаемый пакет. Пакет, отсутствующий в отчёте, это пакет, провалившийся на шаге 2 или исключённый из анализа, а не чистый.

4. **К циклу по пакетам прибегайте, только если шага 3 не хватило.** Для репозиториев, где пакеты нельзя разрешить из одного места, это покрывает всё и идемпотентно:

   ```bash
   #!/usr/bin/env bash
   # tool/dart_fix_repo.sh - Flutter 3.44.8, Dart 3.12.2
   set -euo pipefail

   find . -name pubspec.yaml \
     -not -path '*/.*' \
     -not -path '*/build/*' \
     -not -path '*/ephemeral/*' \
     -print | while read -r manifest; do
       pkg=$(dirname "$manifest")
       echo "==> $pkg"
       ( cd "$pkg" && dart pub get >/dev/null && dart fix --apply "$@" )
     done

   dart format .
   ```

   Фильтры `-not -path` важны: `build/` и каталоги `ephemeral/` внутри `windows/`, `linux/` и `macos/` содержат сгенерированные файлы `pubspec.yaml`, которые трогать не нужно. Если вы уже используете [Melos](https://melos.invertase.dev/), `melos exec -- "dart pub get && dart fix --apply"` делает то же самое с флагами фильтрации, которые у вас уже настроены.

5. **Отформатируйте, затем проанализируйте, затем прогоните тесты.** Именно в таком порядке, и не пропускайте последнее. Подробности ниже.

## Одна диагностика на коммит

Диф `dart fix --apply` на 400 файлов невозможно ревьюить. `--code` принимает список через запятую, поэтому разбейте прогон на коммиты, которые человек действительно способен прочитать:

```bash
dart fix --apply --code=deprecated_member_use
git commit -am "chore: apply Flutter deprecation migrations via dart fix"

dart fix --apply --code=prefer_const_constructors,prefer_const_literals_to_create_immutables
git commit -am "chore: const cleanup via dart fix"
```

Отчёт сухого прогона печатает точные команды для найденных кодов, что делает такое планирование дешёвым.

## Откуда берутся миграции

Исправления устаревания это данные, а не логика компилятора. Пакет объявляет их в `lib/fix_data.yaml`, и анализатор подхватывает их из любой разрешённой зависимости. Во Flutter 3.44.8 фреймворк поставляет 30 таких файлов в `packages/flutter/lib/fix_data/`, содержащих 381 трансформацию, плюс 8 в `flutter_test`, 2 в `flutter_driver` и 1 в `integration_test`. Виды изменений по частоте в `package:flutter`: 418 `removeParameter`, 228 `addParameter`, 204 `fragment`, 158 `rename`, 90 `renameParameter`, 16 `import`, 12 `addTypeParameter`, 11 `replacedBy`, 1 `changeParameterType`.

Тот же механизм доступен и вашим внутренним пакетам, и это самая полезная вещь во всей статье, если вы поддерживаете общую дизайн-систему. Пометьте старый член устаревшим, а затем опишите переписывание:

```dart
// lib_pkg/lib/api.dart
class Report {
  @Deprecated('Use render() instead. Removed in lib_pkg 3.0.0.')
  String toHtml() => render();
  String render() => '<html/>';
}
```

```yaml
# lib_pkg/lib/fix_data.yaml - Dart 3.12.2
version: 1
transforms:
  - title: "Rename to 'render'"
    date: 2026-09-01
    element:
      uris: ['api.dart']
      method: 'toHtml'
      inClass: 'Report'
    changes:
      - kind: 'rename'
        newName: 'render'
```

Каждый потребитель, запустивший `dart fix --apply` после подъёма версии зависимости, получит `r.toHtml()`, переписанный в `r.render()`. В списке `uris` должен быть путь публичной библиотеки, который импортируют потребители, а не файл в `src/`, где объявлен класс. Именно эта деталь чаще всего оказывается причиной того, что написанный вручную `fix_data.yaml` ничего не делает.

## dart fix это не компилятор, и он выдаст вам код, который не собирается

Поэтому шаг 5 выше заканчивается анализом и тестами, а не коммитом. Минимальный виджет, использующий два устаревших API Flutter:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

class Card1 extends StatelessWidget {
  const Card1({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black.withOpacity(0.5),
      child: ListView(
        cacheExtent: 250.0,
        children: const [Text('hi')],
      ),
    );
  }
}
```

`dart fix --apply` сообщает `deprecated_member_use - 2 fixes` и переписывает оба вызова. Трансформация `withOpacity` верна. Трансформация `cacheExtent` нет:

```dart
color: Colors.black.withValues(alpha: 0.5),
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0), children: const [Text('hi')],
),
```

```console
$ flutter analyze
error - Undefined name 'ScrollCacheExtent'. Try correcting the name to one that is defined,
        or defining the name - lib/main.dart:11:28 - undefined_identifier
```

`ScrollCacheExtent` объявлен в `packages/flutter/lib/src/rendering/viewport.dart` и экспортируется только из `package:flutter/rendering.dart`. Ни `material.dart`, ни `widgets.dart` его не реэкспортируют, а трансформация в `fix_widgets.yaml` использует `addParameter` без сопутствующего изменения `import`. Переписывание семантически правильное, и файл больше не компилируется. Добавление `import 'package:flutter/rendering.dart';` это чинит, и `flutter analyze` становится зелёным.

Такой режим отказа обобщается. `dart fix` правит диапазоны токенов, описанные в YAML; он не проверяет типы результата и понятия не имеет, находится ли только что записанный символ в области видимости. Изменения поведения здесь хуже ошибок компиляции, потому что их ничто не ловит, и по той же причине [разделение пакетов Material и Cupertino](/ru/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) и [переход с Radio на RadioGroup](/ru/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/) требуют прогона тестов после автоматического прохода, а не только анализа.

Одно утешение: файл с синтаксической ошибкой не отравляет прогон. `dart fix` всё равно вычисляет и применяет исправления во всех остальных файлах того же пакета.

## Всегда следом запускайте dart format

Инструмент применяет правки, но не переформатирует результат. Обратите внимание, где выше оказался `children`. `dart format .` возвращает всё на место:

```dart
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0),
  children: const [Text('hi')],
),
```

Кладите шаг форматирования в тот же коммит, что и исправление, иначе это сделает редактор следующего человека и история blame станет хуже.

## Как поставить заслон в CI

Поскольку код возврата всегда 0, проверка в CI должна смотреть на рабочее дерево. Примените исправления и дайте решать git:

```yaml
# .github/workflows/analyze.yml
- run: dart pub get
- run: dart fix --apply
- run: git diff --exit-code
```

Проверено локально: если в ветку закоммичено неприменённое исправление, `git diff --exit-code` возвращает 1 и задача падает; если чинить нечего, возвращается 0. Сочетайте это с матрицей, если вы [собираете под несколько версий Flutter](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), так как доступные трансформации различаются по SDK, и исправление, ожидающее применения на 3.47, может не существовать на 3.44.

Рабочий процесс, который действительно выдерживает многолетнюю кодовую базу, скучен: обновить SDK, удалить глушители, разрешить всё, сделать сухой прогон в корне, применять по одному коду диагностики за раз, отформатировать, проанализировать, протестировать, закоммитить. 392 трансформации фреймворка наберут за вас большую часть текста. То, чего они не могут, это та часть, где вы читаете диф.

## Похожие материалы

- [Перенос импортов Material и Cupertino во Flutter на пакеты material_ui и cupertino_ui](/ru/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Миграция веб-приложения на Flutter с dart:html на package:web и dart:js_interop](/ru/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/)
- [Как заменить устаревшие groupValue и onChanged у Radio во Flutter на RadioGroup](/ru/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/)
- [Миграция приложения Flutter 2 на Flutter 3.x: чек-лист по null safety](/ru/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
- [Как нацелиться на несколько версий Flutter из одного CI-пайплайна](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## Источники

- [dart fix](https://dart.dev/tools/dart-fix), документация инструментов Dart
- [Flutter fix](https://docs.flutter.dev/tools/flutter-fix), документация инструментов Flutter
- [Breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes), документация релизов Flutter
- [`pkg/dartdev/lib/src/commands/fix.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/lib/src/commands/fix.dart), Dart SDK
- [`pkg/dartdev/doc/dart-fix.md`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/doc/dart-fix.md), Dart SDK
- [Data driven fixes](https://dart.dev/go/data-driven-fixes), спецификация Dart для `fix_data.yaml`
- [Pub workspaces](https://dart.dev/tools/pub/workspaces), документация Dart по управлению пакетами
- [Customizing static analysis](https://dart.dev/tools/analysis), документация анализатора Dart
