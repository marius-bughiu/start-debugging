---
title: "Исправление: pubspec.lock изменяется после flutter upgrade или при переключении версий Flutter"
description: "Flutter SDK закрепляет версии meta, vector_math, test_api и matcher, поэтому каждая смена SDK заново разрешает ваш lock-файл, а flutter upgrade запускает pub upgrade для проекта, в котором вы находитесь. Закрепите одну версию Flutter на репозиторий и требуйте неизменность lock-файла в CI."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "dart"
  - "pub"
lang: "ru"
translationOf: "2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions"
translatedBy: "claude"
translationDate: 2026-10-13
---

Ваш `pubspec.lock` меняется потому, что сам Flutter SDK является зависимостью со своими закреплёнными версиями. `flutter` и `flutter_test` требуют точные версии пакетов вроде `meta`, `vector_math`, `test_api` и `matcher`, поэтому другой SDK заставляет pub заново их разрешать, а `flutter run` или `flutter build` после смены SDK сам запускает `pub get`. Вдобавок `flutter upgrade` запускает `pub upgrade` для того проекта, в каталоге которого вы находитесь. Решение: закрепите одну версию Flutter на репозиторий (FVM плюс ограничение `environment: flutter:`), коммитьте изменение lock-файла при обновлении SDK отдельно и запускайте `flutter pub get --enforce-lockfile` в CI. Всё ниже измерено на Flutter 3.44.8 (Dart 3.12.2) и Flutter 3.47.7 (Dart 3.13.5) 2026-10-13.

## Симптом в контексте

Вы не трогали `pubspec.yaml`. Вы выполнили `flutter upgrade`, переключили канал, или коллега с другой версией Flutter запушил изменения, и теперь `git status` показывает следующее:

```text
 M pubspec.lock
```

Дифф затрагивает только транзитивные пакеты, которые вы сами никогда не добавляли:

```diff
   meta:
     dependency: transitive
     description:
       name: meta
-      sha256: "1741988757a65eb6b36abe716829688cf01910bbf91c34354ff7ec1c3de2b349"
+      sha256: "307249ce4ff29d58a18e97f6345f539382eb9c9c29ecda628900f31de0443dd9"
       url: "https://pub.dev"
     source: hosted
-    version: "1.18.0"
+    version: "1.19.0"
```

Вернитесь на старый SDK и запустите что-нибудь, что вызывает `pub get`, и дифф развернётся в обратную сторону. В команде со смешанными версиями Flutter lock-файл прыгает туда-сюда в каждом pull request.

## Почему это происходит

Есть три отдельных механизма, и большинство команд сталкивается со всеми тремя.

**1. Flutter SDK закрепляет собственные зависимости.** `packages/flutter/pubspec.yaml` и `packages/flutter_test/pubspec.yaml` в SDK перечисляют точные версии. Ваше приложение зависит от обоих через `sdk: flutter`, поэтому их закрепления становятся ограничениями для вашего разрешения зависимостей. Когда SDK меняется, меняются и закрепления, версии в вашем lock-файле перестают им удовлетворять, и pub приходится выбирать новые. Вот соответствующие строки из двух протестированных мной SDK:

| Пакет | Flutter 3.44.8 | Flutter 3.47.7 |
| --- | --- | --- |
| `meta` | `1.18.0` | `^1.18.3` |
| `vector_math` | `2.2.0` | `^2.4.0` |
| `test_api` | `0.7.11` | `0.7.12` |
| `matcher` | `0.12.19` | `0.12.20` |
| `material_color_utilities` | `0.13.0` | `0.13.0` |
| `collection` | `1.19.1` | `^1.19.1` |

Flutter 3.47 это первый стабильный релиз с [PR #185268, "Unpin sdk package dependencies"](https://github.com/flutter/flutter/pull/185268), который закрыл давнюю проблему [#158050, "Stop pinning dependencies"](https://github.com/flutter/flutter/issues/158050). Большинство закреплений превратились в диапазоны с кареткой. `test_api` и `matcher` остаются точными, потому что SDK импортирует их библиотеки из `src/`, а `material_color_utilities` по-прежнему закреплён (оба случая объясняются в описании PR). Так что даже на 3.47 и новее каждый релиз Flutter, повышающий `test_api` или `matcher`, переписывает эти записи в lock-файле.

**2. Flutter запускает `pub get` у вас за спиной после смены SDK.** `flutter run`, `flutter build`, `flutter test` и другие команды вызывают `pub get` перед тем, как делать что-либо ещё. Инструмент Flutter пропускает его, только если `.dart_tool/version` совпадает с текущей версией фреймворка, а `pubspec.yaml` старше и `pubspec.lock`, и `.dart_tool/package_config.json`. Проверка находится в `packages/flutter_tools/lib/src/dart/pub.dart`. Поэтому первый `flutter run` после переключения SDK всегда заново разрешает зависимости, и lock-файл меняется, хотя вы ни разу не набирали `pub`.

**3. `flutter upgrade` запускает `pub upgrade` для вашего проекта.** Именно этот пункт большинство упускает. После обновления SDK `UpgradeCommand.updatePackages` ищет `pubspec.yaml` в текущем каталоге или любом родительском, и если находит, вызывает `pub.get(..., upgrade: true)` для этого проекта. Это `pub upgrade`, а не `pub get`, поэтому он переводит *каждую* зависимость на новейшую версию, которую допускают ваши ограничения, включая пакеты, не имеющие отношения к SDK. Код делает так как минимум со времён Flutter 3.0.0.

## Минимальное воспроизведение

Создайте проект на старом SDK, закоммитьте его, затем разрешите зависимости новым. Я держал оба SDK рядом: Flutter 3.44.8 из Homebrew и стабильный zip 3.47.7, распакованный во временную папку.

```bash
# Flutter 3.44.8 (Dart 3.12.2) creates and locks the project
flutter create -e --platforms=android app
cd app
flutter pub add http shared_preferences intl
git init -q && git add -A && git commit -qm base

# Same project, Flutter 3.47.7 (Dart 3.13.5)
~/sdks/flutter-3.47.7/bin/flutter pub get
git diff --stat
```

Вывод на 3.47.7:

```text
Resolving dependencies...
Downloading packages...
  clock 1.1.2 (1.1.3 available)
> matcher 0.12.20 (was 0.12.19)
  material_color_utilities 0.13.0 (0.13.1 available)
> meta 1.19.0 (was 1.18.0)
  stack_trace 1.12.1 (1.12.2 available)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Changed 4 dependencies!
Upgrading analysis_options.yaml to exclude build and platform directories.
 analysis_options.yaml |  4 ++++
 pubspec.lock          | 16 ++++++++--------
 2 files changed, 12 insertions(+), 8 deletions(-)
```

Сдвинулись четыре пакета, и все они являются закреплениями SDK или бывшими закреплениями. `http`, `shared_preferences` и `intl` остались ровно там же, где были: обычный `pub get` сохраняет все залоченные версии, какие может. Обратите внимание на дополнительное изменение файла. Flutter 3.47 поставляется с `AnalysisOptionsMigration`, которая при первом запуске `pub get` в вашем проекте добавляет в `analysis_options.yaml` исключения `build/**` и по одному `<platform>/**` на каждую папку платформы. Это однократная правка, и её следует закоммитить вместе с lock-файлом.

Теперь вернёмся на 3.44.8:

```text
< matcher 0.12.19 (was 0.12.20) (0.12.20 available)
< meta 1.18.0 (was 1.19.0) (1.19.0 available)
< test_api 0.7.11 (was 0.7.12) (0.7.15 available)
< vector_math 2.2.0 (was 2.4.3) (2.4.3 available)
Changed 4 dependencies!
```

Это и есть пинг-понг. Ни один из SDK не принимает lock-файл другого, так что побеждает тот, кто запускал последним.

Для сравнения, `pub upgrade` на 3.47.7 из того же lock-файла для 3.44 (именно это за вас делает `flutter upgrade`) изменил шесть пакетов вместо четырёх, потому что дополнительно перевёл `clock` и `stack_trace` на последние версии. В реальном приложении с несколькими десятками зависимостей это число обычно намного больше.

## Исправление подробно

Цель не в том, чтобы lock-файл никогда не менялся. Он должен меняться при смене SDK, потому что старое разрешение уже недействительно. Цель в том, чтобы он менялся один раз, намеренно, в коммите, который можно проверить.

### 1. Коммитьте `pubspec.lock` для приложений и только для них

В [документации Dart по `pub get`](https://dart.dev/tools/pub/cmd/pub-get) сказано, что пакеты-приложения должны хранить lock-файл в репозитории, чтобы каждый разработчик и каждое развёртывание использовали одни и те же версии, а переиспользуемые пакеты не должны. Если вы видите шум в репозитории *пакета*, проще всего перестать коммитить там lock-файл. Всё остальное ниже предполагает приложение.

### 2. Закрепите одну версию Flutter на репозиторий

Пинг-понг возникает только тогда, когда разные люди запускают разные SDK на одном lock-файле. Сделайте версию частью репозитория.

С [FVM](https://fvm.app/) команда `fvm use` записывает версию в `.fvmrc` в корне проекта, и все запускают `fvm flutter ...` с ней:

```bash
# FVM 3.x, Flutter 3.47.7
fvm install 3.47.7
fvm use 3.47.7
git add .fvmrc
```

Затем подкрепите это ограничением Flutter в `pubspec.yaml`, которое pub применяет для всех, с FVM или без:

```yaml
# pubspec.yaml, Flutter 3.47.7 / Dart 3.13.5
environment:
  sdk: ^3.13.5
  flutter: ">=3.47.0 <3.48.0"
```

Pub проверяет обе границы. При диапазоне `<3.45.0` Flutter 3.47.7 вообще отказался разрешать зависимости:

```text
The current Flutter SDK version is 3.47.7.

Because app2 requires Flutter SDK version >=3.0.0 <3.45.0, version solving failed.
Failed to update packages.
```

Такая ошибка гораздо лучше молча переписанного lock-файла: коллега с неверным SDK узнаёт об этом сразу, а не на код-ревью. Ожидайте, что блок `sdks:` в конце `pubspec.lock` повторит ваше ограничение (`flutter: ">=3.47.0 <3.48.0"`), потому что pub записывает туда пересечение всех ограничений SDK в графе. Эта строка меняется при каждой правке ограничения, и это нормально.

Если вы хотите, чтобы CI следовал тому же файлу, [настройка CI для нескольких версий](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) читает версию из `.fvmrc`.

### 3. Обновляйте Flutter отдельным изменением, вне каталога проекта

Поскольку `flutter upgrade` запускает `pub upgrade` для проекта, который находит от вашего рабочего каталога, обновление из репозитория смешивает в одном диффе два очень разных изменения: повторное разрешение из-за SDK и полное обновление зависимостей. Разделите их:

```bash
# Flutter 3.44.8 -> 3.47.7
cd ~                # no pubspec.yaml here or in any parent directory
flutter upgrade     # upgrades only the SDK

cd ~/src/my_app
flutter pub get     # re-resolves only what the new SDK forces
git add pubspec.lock analysis_options.yaml
git commit -m "Flutter 3.47.7: re-resolve SDK-pinned packages"
```

Если вы используете FVM, получаете тот же эффект бесплатно: `fvm install` и `fvm use` никогда не вызывают `pub upgrade` для вашего приложения. Когда вам действительно нужны более новые пакеты, запустите `flutter pub upgrade` осознанно во втором коммите, чтобы регрессия при bisect указывала либо на "новый SDK", либо на "новые пакеты", но не на оба сразу. Это то же разделение, которое я рекомендую для [поломки с `awaitNotRequired`](/ru/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/), где отозванный пакет и несовпадение SDK выглядели как одна проблема.

### 4. Требуйте неизменность lock-файла в CI

`--enforce-lockfile` заставляет `pub get` завершаться ошибкой вместо переписывания lock-файла, если закоммиченное разрешение недействительно для текущего SDK. Документация рекомендует его для CI и боевых развёртываний. Вот lock-файл для 3.44 под Flutter 3.47.7:

```text
> matcher 0.12.20 (was 0.12.19)
> meta 1.19.0 (was 1.18.0)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Would change 4 dependencies.
Unable to satisfy `pubspec.yaml` using `pubspec.lock`.

To update `pubspec.lock` run `flutter pub get` without
`--enforce-lockfile`.
Failed to update packages.
```

Команда завершается с кодом 65 и оставляет `pubspec.lock` нетронутым. Поставьте её перед каждой сборкой:

```yaml
# GitHub Actions, subosito/flutter-action v2, Flutter 3.47.7
- uses: subosito/flutter-action@v2
  with:
    flutter-version-file: .fvmrc
- run: flutter pub get --enforce-lockfile
- run: flutter build apk --release
```

Теперь CI-раннер с неверным SDK или lock-файл, который кто-то забыл закоммитить после обновления SDK, дают красную сборку с понятным сообщением, а не зелёную сборку на версиях, которые никто не проверял. `--enforce-lockfile` также завершается ошибкой, если хеш содержимого размещённого пакета больше не совпадает с `sha256`, записанным в lock-файле, что заодно служит неплохой проверкой цепочки поставок.

### 5. Не боритесь с диффом через `--no-pub`

`flutter run --no-pub` пропускает неявный `pub get` и действительно не даёт lock-файлу меняться. Но это означает, что вы запускаете новый SDK с `package_config.json`, разрешённым для старого. Это работает, пока не перестаёт, обычно ошибкой компиляции внутри `flutter_test` или аннотации `meta`, которую ожидает новый фреймворк. Используйте `--no-pub` для быстрых экспериментов, но никогда как решение.

## Подводные камни и похожие случаи

**Новые проекты на 3.47+ начинают с нижних границ.** Начиная с [PR #175352](https://github.com/flutter/flutter/pull/175352), `flutter create` записывает `pubspec.lock`, в котором зависимости SDK зафиксированы на нижнем краю их новых диапазонов. Свежий проект на 3.47.7 фиксирует `meta` 1.18.3 и `vector_math` 2.4.0; первый `flutter pub upgrade` переводит их на 1.19.0 и 2.4.3. Этот дифф ожидаем, и когда его принять, решаете вы.

**Патч-релизы редко двигают закрепления.** Pubspec `flutter_test` идентичен в 3.47.0, 3.47.6 и 3.47.7, поэтому патч-обновление в пределах одной минорной версии обычно оставляет lock-файл в покое. Минорные релизы (3.44 на 3.47) почти всегда его меняют. Планируйте дифф, когда пересекаете минорную версию.

**Кавычки вокруг `sha256` это не шум.** В диффах выше одни хеши в кавычках, другие нет. Pub берёт в кавычки любой хеш, начинающийся с цифры, чтобы YAML не прочитал его как число. Если строка с хешем изменилась, это потому, что изменилась версия, а не форматирование.

**Монорепозитории с pub workspace.** В рабочих областях Dart есть один `pubspec.lock` в корне workspace, а `flutter upgrade` из любой папки-участника поднимается вверх и тоже находит `pubspec.yaml`. Правила те же, но масштаб последствий больше. Если после повторного разрешения ваш редактор тормозит, смотрите [ускорение сервера анализа Dart в большом монорепозитории](/ru/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

**"version solving failed" вместо диффа.** Если пакет, от которого вы зависите, закрепляет тот же пакет, что и SDK, смена SDK вообще проваливает разрешение зависимостей, вместо того чтобы тихо переписать lock-файл. Это другая проблема с собственным разбором: [исправление "version solving failed" в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

**Артефакты движка это отдельное закрепление.** Закрепляя версию фреймворка, вы закрепляете и движок, что важно для воспроизводимых релизных сборок. Предыстория изложена в [посте о версии движка Flutter 3.38.6](/ru/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).

## Связанные материалы

- [Как исправить "version solving failed" в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Как ориентироваться на несколько версий Flutter в одном CI-конвейере](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Исправление: Undefined name 'awaitNotRequired' из material_ui или cupertino_ui на Flutter 3.44](/ru/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Flutter 3.38.6 и обновление версии движка: воспроизводимые сборки проще, если её закрепить](/ru/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/)
- [Как ускорить медленный сервер анализа Dart в VS Code для большого монорепозитория Flutter](/ru/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## Источники

- [dart.dev: `dart pub get`](https://dart.dev/tools/pub/cmd/pub-get), о залоченных версиях, `--enforce-lockfile` и коммите lock-файла.
- [flutter/flutter#158050: Stop pinning dependencies](https://github.com/flutter/flutter/issues/158050) и [дизайн-документ](https://flutter.dev/go/unpin-flutter-sdk-dependencies).
- [flutter/flutter#184821: Unpin sdk package dependencies](https://github.com/flutter/flutter/pull/184821) и его повторное применение [#185268](https://github.com/flutter/flutter/pull/185268).
- [flutter/flutter#175352: Have `flutter create` create a pubspec.lock](https://github.com/flutter/flutter/pull/175352).
- Исходный код инструмента Flutter на [теге 3.47.7](https://github.com/flutter/flutter/tree/3.47.7/packages/flutter_tools/lib/src): `commands/upgrade.dart` (`updatePackages`), `dart/pub.dart` (проверка пропуска pub get), `migrations/analysis_options_migration.dart`.
