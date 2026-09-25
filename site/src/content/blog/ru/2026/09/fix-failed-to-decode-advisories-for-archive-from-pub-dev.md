---
title: "Исправление: Failed to decode advisories for archive from https://pub.dev в flutter pub get"
description: "Предупреждение об advisories в pub get безвредно: pub get завершается с кодом 0. pub.dev исправил некорректный ответ 2026-05-04. Если вы все еще его видите, причина в зеркале или прокси."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "ci"
lang: "ru"
translationOf: "2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev"
translatedBy: "claude"
translationDate: 2026-09-25
---

С вашими пакетами все в порядке. Сообщение выдает проверка security advisories в pub, которая запускается после разрешения зависимостей, и `flutter pub get` все равно завершается с кодом 0. Массовая вспышка (каждый проект, зависящий от `archive`, `http`, `dio`, `shared_preferences_android` и так далее) была вызвана ошибкой на сервере pub.dev. С 2026-05-02 по 2026-05-04 API advisories возвращал `"advisoriesUpdated": null`, и 2026-05-04 pub.dev это исправил. Если вы видите сообщение сегодня, ответ приходит от зеркала пакетов (`PUB_HOSTED_URL`, Artifactory, Nexus, приватный pub-сервер) или от прокси. Исправьте этот сервер или обновитесь до Flutter 3.47.0 / Dart 3.13.0 или новее, где трассировка стека сокращена до однострочного предупреждения. Если из-за этого падает CI, настоящая проблема в шаге, который считает любой вывод в stderr ошибкой.

Я воспроизвел каждый вариант ниже на macOS с Dart 3.12.2 (SDK во Flutter 3.44.x) и Dart 3.13.4 (SDK во Flutter 3.47.5). Оба запускались против локального pub-репозитория из 40 строк, который реализует [hosted repository spec v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md) и позволяет выбирать, что возвращает endpoint advisories.

## Ошибка в контексте

Во Flutter 3.44.x и старше (Dart 3.12.x и старше) `flutter pub get` или `dart pub get` выводит это для одного пакета за другим:

```text
Resolving dependencies...
Downloading packages...
Failed to decode advisories for archive from https://pub.dev.
FormatException: advisoriesUpdated must be a String
package:pub/src/source/hosted.dart 670                        HostedSource._extractAdvisoryDetailsForPackage
package:pub/src/source/hosted.dart 622                        HostedSource._fetchAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 839                        HostedSource._getAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 1120                       HostedSource.getAdvisoriesForPackageVersion
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 425                        SolveReport._reportPackage
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 221                        SolveReport._reportChanges
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 76                         SolveReport.show
===== asynchronous gap ===========================
package:pub/src/entrypoint.dart 642                           Entrypoint.acquireDependencies
...
Failed to decode advisories for http from https://pub.dev.
FormatException: advisoriesUpdated must be a String
...
```

Во Flutter 3.47.0 и новее (Dart 3.13.0 и новее) то же состояние дает одну строку на пакет:

```text
Failed to decode advisories for archive from https://pub.dev: advisoriesUpdated must be a String
```

`archive` обычно оказывается первым именем, которое вы видите. Отчет обходит пакеты в алфавитном порядке, а `archive` является транзитивной зависимостью `image` и множества инструментов сборки, поэтому он появляется рано в большинстве lock-файлов Flutter. Запрос вызывают только пакеты, у которых когда-либо было security advisory, поэтому `http` и `dio` были в каждом отчете, а `path` не было никогда.

## Зачем pub вообще запрашивает advisories

Начиная с Dart 3.4 ([dart-lang/pub#4062](https://github.com/dart-lang/pub/pull/4062)), `pub get`, `pub upgrade` и `pub add` сообщают об известных security advisories для разрешенных версий. Данные берутся из [osv.dev](https://osv.dev), и pub.dev реэкспортирует их через два поля своего API:

1. Список версий, `GET /api/packages/<name>`, содержит необязательную временную метку `advisoriesUpdated`. Если она присутствует, клиент считает, что сервер поддерживает endpoint advisories для этого пакета.
2. Endpoint advisories, `GET /api/packages/<name>/advisories`, возвращает `{"advisories": [...], "advisoriesUpdated": "<date-time>"}`.

Клиент кеширует второй ответ в `$PUB_CACHE/hosted/<host>/.cache/<name>-advisories.json` и по временной метке решает, устарел ли этот кеш. В `_extractAdvisoryDetailsForPackage` в [`hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart) парсер строго проверяет временную метку:

```dart
// dart-lang/pub, lib/src/source/hosted.dart (Dart 3.12 and 3.13)
final advisoriesUpdated = body['advisoriesUpdated'];
if (advisoriesUpdated is! String) {
  throw const FormatException('advisoriesUpdated must be a String');
}
```

Этот `FormatException` перехватывается в `_fetchAdvisories`, записывается в журнал как предупреждение, и метод возвращает `null`, что означает "для этого пакета нет данных об advisories". К этому моменту разрешение зависимостей уже завершено, и ничего в `pubspec.lock` от этого не зависит. Теряется только отчет об advisories для этого пакета.

## Что сломалось на pub.dev в мае 2026 года

[Post mortem](https://github.com/dart-lang/pub-dev/issues/9372) команды pub.dev описывает последовательность событий. 2026-04-23 более легкий Docker-образ `FROM scratch` лишился `unzip`, и задание, которое скачивает экспорт osv.dev, перестало работать. 2026-05-01 его заменили реализацией unzip на Dart, в которой не хватало вызова `init()`. Эта реализация извлекала ноль файлов, поэтому следующая синхронизация 2026-05-02 "не нашла" advisories и удалила их все из хранилища данных.

Endpoint advisories вычислял `advisoriesUpdated` по самому новому сохраненному advisory, а их не осталось, поэтому он возвращал `null`. Список версий при этом по-прежнему содержал старую временную метку из сущности пакета. В итоге каждый клиент видел "у этого пакета есть advisories", запрашивал их и спотыкался на:

```json
{"advisories": [], "advisoriesUpdated": null}
```

[dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368) ("Fix advisoriesUpdated") выкатили 2026-05-04. Advisories загрузили заново, и issue закрыли 2026-05-05. Сегодня пакет без advisories возвращает эпоху Unix вместо `null`:

```bash
# pub.dev, checked 2026-09-25
curl -s https://pub.dev/api/packages/path/advisories
# {"advisories":[],"advisoriesUpdated":"1970-01-01T00:00:00.000"}
```

На стороне клиента [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817) ("Quiet warning instead of stack trace when failing to parse advisories") заменил трассировку стека однострочным сообщением. Я проверил `pub_rev`, зафиксированный в файле `DEPS` Dart SDK для каждого тега релиза. Изменения нет в версиях с 3.12.0 по 3.12.2, и оно есть в каждом релизе 3.13.x. В терминах Flutter версии с 3.44.0 по 3.44.9 все еще выводят полную трассировку, а 3.47.0 является первым стабильным релизом, который этого не делает.

## Минимальное воспроизведение с локальным pub-сервером

Чтобы это увидеть, не нужно ждать, пока pub.dev сломается. Крошечный сервер на Node, следующий спецификации репозитория, с переключателем для ответа advisories воспроизводит каждый вариант. Вот ключевая часть:

```js
// Node 24, server.mjs: minimal pub repository (spec v2)
if (req.url === '/api/packages/fakepkg') {
  res.writeHead(200, { 'content-type': 'application/vnd.pub.v2+json' });
  return res.end(JSON.stringify({
    name: 'fakepkg',
    advisoriesUpdated: '2026-04-20T10:00:00.000Z', // tells pub to fetch advisories
    latest: { version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec },
    versions: [{ version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec }],
  }));
}
if (req.url === '/api/packages/fakepkg/advisories') {
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ advisories: [], advisoriesUpdated: null }));
}
```

Приложение направляет на него одну зависимость:

```yaml
# pubspec.yaml, Dart 3.12.2 / 3.13.4
name: app
publish_to: none
environment:
  sdk: ^3.0.0
dependencies:
  fakepkg:
    hosted: http://localhost:8123
    version: ^1.0.0
```

Запуск на обоих SDK, каждый раз со свежим `PUB_CACHE`:

```bash
# Dart 3.12.2
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# out.txt: Resolving dependencies... Downloading packages... + fakepkg 1.0.0  Changed 1 dependency!
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123.
#          FormatException: advisoriesUpdated must be a String
#          package:pub/src/source/hosted.dart 648  HostedSource._extractAdvisoryDetailsForPackage
#          ... (full async stack trace)

# Dart 3.13.4
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123: advisoriesUpdated must be a String
```

Три вещи, которые воспроизведение делает наглядными:

- **Код выхода равен 0 на обеих версиях.** Пакет скачивается, и `pubspec.lock` записывается.
- **Все уходит в stderr.** stdout чистый.
- **Некорректный ответ никогда не кешируется.** После запуска `$PUB_CACHE/hosted/localhost%588123/.cache/` содержит `fakepkg-versions.json`, но не `fakepkg-advisories.json`. Запись в кеш происходит после успешного разбора, поэтому pub запрашивает заново при каждом запуске, включая `pub get`, где ничего не изменилось. Удаление кеша pub не помогает, потому что проблема никогда не была в кеше. Это совпадает с сообщениями в issue pub-dev от людей, которые выполнили `flutter pub cache clean` и все равно получали ошибку.

## Исправление в порядке вероятности

### 1. Выясните, откуда приходит ответ

Запустите get в подробном режиме и найдите запрос advisories:

```bash
# Flutter 3.47.5 / Dart 3.13.4
dart pub get --verbose 2>&1 | grep -A3 "Fetching security advisories"
# IO  : Fetching security advisories from https://pub.dev/api/packages/archive/advisories.
# IO  : HTTP GET https://pub.dev/api/packages/archive/advisories
```

Затем запросите этот же URL самостоятельно:

```bash
curl -s https://pub.dev/api/packages/archive/advisories | head -c 300
```

Если хост `pub.dev` и в теле ответа `advisoriesUpdated` является строкой, серверная сторона в порядке. Любое оставшееся сообщение исходит от чего-то между вами и pub.dev, обычно от прокси с инспекцией TLS, который переписывает ответы. Если хост не pub.dev, проверьте `echo $PUB_HOSTED_URL` и все URL `hosted:` в `pubspec.yaml`. Виновник именно этот сервер.

### 2. Не позволяйте CI считать предупреждение ошибкой

pub завершается с кодом 0, так что если пайплайн покраснел из-за этого сообщения, какой-то шаг падает на выводе в stderr. Обычные подозреваемые: script-задачи Azure Pipelines с `failOnStderr: true` и скрипты Windows PowerShell 5.1, которые выполняют `flutter pub get 2>&1` при `$ErrorActionPreference = 'Stop'`. PowerShell 5.1 превращает каждую перенаправленную строку stderr в `ErrorRecord`, и при `Stop` первая же из них завершает скрипт. Ориентируйтесь на код выхода:

```yaml
# Azure Pipelines, Flutter 3.47.5
- script: flutter pub get
  displayName: Restore packages
  failOnStderr: false   # pub prints advisory warnings to stderr and still exits 0
```

```powershell
# Windows PowerShell 5.1, Flutter 3.47.5
$ErrorActionPreference = 'Continue'
flutter pub get
if ($LASTEXITCODE -ne 0) { throw "flutter pub get failed ($LASTEXITCODE)" }
```

Обертки, которые ищут в журнале `Exception` или `Error`, сталкиваются с той же проблемой. Настоящая ошибка разрешения зависимостей, например [`version solving failed`](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/), устанавливает ненулевой код выхода, так что кода выхода достаточно.

### 3. Обновитесь до Flutter 3.47.0 или новее

Это не убирает предупреждение, но однострочная форма выглядит в журналах гораздо менее тревожно и не хоронит важный для вас вывод. Если ваш CI фиксирует Flutter для каждой ветки, подход из статьи [о нацеливании на несколько версий Flutter из одного CI-пайплайна](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) позволяет перевести задание по умолчанию на 3.47.x, не трогая остальные.

### 4. Исправьте зеркало или приватный pub-сервер

Спецификация дает зеркалу два допустимых варианта, и оно должно выбрать один:

- Точно проксировать `/api/packages/<name>/advisories`, где `advisoriesUpdated` всегда строка.
- Или удалять `advisoriesUpdated` из отдаваемого списка версий. Спецификация делает поле необязательным, и когда его нет, клиент вообще не обращается к endpoint advisories. Вы теряете отчет об advisories, но pub перестает спрашивать.

Удаленные репозитории в Artifactory и похожих продуктах кешируют метаданные upstream. Один пользователь Artifactory в issue pub-dev столкнулся с другим сбоем: собственный парсер прокси выбрасывал `NullPointerException` на поле со значением `null`. Если ваш прокси закешировал ответ из майского окна 2026 года, очистка кеша метаданных этого удаленного репозитория (в Artifactory это называется "zap cache") заставит его получить исправленный ответ. Сделать это должен тот, кто управляет прокси. Ничто на стороне клиента это не изменит.

### 5. Пропускайте проверку там, где она действительно не важна

`dart pub get --offline` / `flutter pub get --offline` никогда не запрашивает advisories. В офлайн-режиме код возвращается раньше. Это работает, только когда каждый пакет уже есть в локальном кеше pub, поэтому подходит для герметичных агентов сборки с заранее прогретым кешем, но не как общее исправление. Не используйте это, чтобы скрыть сломанное зеркало на машинах разработчиков, потому что вы теряете и отчет о безопасности, ради которого проверка существует.

## Похожие варианты

**`Failed to decode advisories for X from ...: Unexpected character (at character 1)`**, за которым следует строка HTML. Запрос advisories получил HTML-страницу, обычно captive portal, страницу входа прокси или страницу ошибки, возвращающую HTTP 200. Я воспроизвел это, возвращая `<html>proxy login</html>`. Код выхода по-прежнему 0, и исправлять нужно сетевой путь, а не pub.

**`Warning: Unable to fetch advisories for "X" from "https://my-mirror/"`**. Endpoint advisories вернул статус, отличный от 2xx, с хоста, который не является pub.dev. Это предупреждение, код выхода 0. Такое поведение появилось в [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275) в 2024 году. До этого зеркало без этого endpoint роняло `pub get`.

**`Failed to fetch advisories for "X" from "https://pub.dev"`**. Та же ситуация, но хост pub.dev. pub считает этот случай фатальным (`fail(...)`) и завершается с ненулевым кодом, поскольку pub.dev должен всегда обслуживать этот endpoint. Если вы видите именно это, значит, действительно произошел сбой pub.dev или что-то блокирует этот путь. Проверьте [трекер issues pub.dev](https://github.com/dart-lang/pub-dev/issues), прежде чем что-либо менять локально.

**`FormatException: advisories must be a list`** или **`advisory must be a map`**. Тот же путь в коде, другое некорректное поле. Самописный pub-сервер возвращает данные неверной формы. Сравните его ответ с разделом спецификации о формате OSV.

## Связанные материалы

- [Исправление: version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/) описывает ошибку pub, которая действительно останавливает сборку, и как читать ее вывод.
- [Как нацелиться на несколько версий Flutter из одного CI-пайплайна](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), полезно при переводе CI на SDK 3.47.x.
- [Фиксация версии движка Flutter для воспроизводимых сборок](/ru/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/), поскольку точное знание того, какой SDK запускают ваши агенты, позволяет отличить вывод 3.44 от вывода 3.47.
- [Исправление: Unexpected failure parsing device information from adb output](/ru/2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter/) описывает еще одно громкое сообщение инструментов Flutter, где правильный ход заключается в конкретной версии SDK.
- [Что еще вошло в хотфикс Flutter 3.47.1](/ru/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/).

## Источники

- [dart-lang/pub-dev#9372](https://github.com/dart-lang/pub-dev/issues/9372), исходный отчет и post mortem, а также дубликаты [dart-lang/sdk#63308](https://github.com/dart-lang/sdk/issues/63308) и [flutter/flutter#185943](https://github.com/flutter/flutter/issues/185943).
- [dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368), исправление на сервере.
- [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817), более тихое предупреждение на клиенте, и [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275), корректная обработка отсутствующего endpoint advisories.
- [`lib/src/source/hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart) в dart-lang/pub (`_fetchAdvisories`, `_extractAdvisoryDetailsForPackage`, `_getAdvisories`).
- [Hosted Pub Repository Specification v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md), разделы об `advisoriesUpdated` и "List security advisories for a package".
- [Dart SDK `DEPS`](https://github.com/dart-lang/sdk/blob/3.13.0/DEPS) (`pub_rev`) на тегах 3.12.x и 3.13.x, а также [манифест релизов Flutter](https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json) для соответствия версий Flutter и Dart.
- [Troubleshooting pub](https://dart.dev/tools/pub/troubleshoot) на dart.dev.
