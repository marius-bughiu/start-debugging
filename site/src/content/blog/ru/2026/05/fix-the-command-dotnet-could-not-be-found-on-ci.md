---
title: "Исправление: The command 'dotnet' could not be found в CI"
description: "Раннер CI не может найти dotnet, потому что SDK не установлен на этом шаге, либо установлен, но не в PATH. Используйте actions/setup-dotnet, зафиксируйте global.json и экспортируйте DOTNET_ROOT и ~/.dotnet/tools."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "ci"
  - "github-actions"
  - "azure-pipelines"
lang: "ru"
translationOf: "2026/05/fix-the-command-dotnet-could-not-be-found-on-ci"
translatedBy: "claude"
translationDate: 2026-05-13
---

Исправление: шаг CI запускает `dotnet` в оболочке, где SDK либо не установлен, либо не в `PATH`, либо зафиксирован на версии, которую запрещает ваш `global.json`. В GitHub Actions добавьте шаг `actions/setup-dotnet@v4` перед любым вызовом `dotnet`, закоммитьте `global.json`, соответствующий запрошенному SDK, а в Linux-контейнерах экспортируйте `DOTNET_ROOT` и `$HOME/.dotnet/tools`. Эта ошибка почти никогда не является багом образа раннера.

```text
/bin/bash: line 1: dotnet: command not found
##[error]Process completed with exit code 127.
```

или на раннерах Windows:

```text
dotnet : The term 'dotnet' is not recognized as the name of a cmdlet, function, script file, or operable program.
At line:1 char:1
+ dotnet build
+ ~~~~~~
    + CategoryInfo          : ObjectNotFound: (dotnet:String) [], CommandNotFoundException
```

или в Ubuntu после `dotnet-install.sh`:

```text
Command 'dotnet' not found, but can be installed with:
sudo apt install dotnet-host
```

Это руководство написано для .NET 11 (SDK 11.0.100), `actions/setup-dotnet@v4.0.1`, задачи `UseDotNet@2` Azure DevOps версии 2.213.x и `dotnet-install.sh`, опубликованного по адресу `https://dot.net/v1/dotnet-install.sh` в мае 2026 года. Базовые причины не менялись со времён .NET Core 3.1; менялись только версии actions.

## Почему оболочки CI теряют `dotnet`

Существует четыре первопричины. Их легко перепутать, потому что все они выдают одну и ту же строку `command not found`, поэтому полезно знать, с какой именно вы имеете дело, прежде чем править YAML.

1. **В образе раннера вообще нет SDK.** Образы контейнеров вроде `ubuntu:24.04`, `alpine:3.20` или `mcr.microsoft.com/devcontainers/base:ubuntu` не поставляются с .NET SDK. У раннеров, размещённых в GitHub (`ubuntu-latest`, `windows-latest`), SDK есть, но закешированная версия это та, что попала в образ при сборке, а не та, что нужна вашему репозиторию.
2. **SDK установлен, но не в `PATH` для этого шага.** Каждый шаг GitHub Actions выполняется в свежей оболочке. Добавление строки в `~/.bashrc` из предыдущего шага не переносится. Установка `PATH` через `export` внутри блока `run:` не утекает в следующий блок `run:`.
3. **SDK в `PATH`, но `global.json` фиксирует версию, которая не установлена.** При запуске `dotnet` читает ближайший `global.json` вверх по дереву каталогов и разрешает SDK, удовлетворяющий правилам `version` и `rollForward`. Если совпадений нет, вы получаете `error NETSDK1045` или сбой хоста, который, в зависимости от хоста, выглядит в скрипте-обёртке как „command not found".
4. **SDK установлен скриптом `dotnet-install.sh` в `$HOME/.dotnet`, но `DOTNET_ROOT` и `PATH` так и не были заданы.** Это самый частый сбой на самохостящихся Linux-раннерах и внутри Docker-контейнеров. Скрипт устанавливает чисто, но следующие шаги не экспортируют переменные.

## Минимальная репродукция в CI

Сохраните это как `.github/workflows/build.yml` и запушьте в репозиторий с `.csproj`:

```yaml
# .github/workflows/build.yml -- .NET 11, GitHub Actions May 2026
name: build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    container: ubuntu:24.04   # no SDK is preinstalled here
    steps:
      - uses: actions/checkout@v4
      - run: dotnet --info     # fails: dotnet: command not found
```

Ключ `container:` подменяет ОС раннера голым образом Ubuntu. У раннера по умолчанию `ubuntu-latest` SDK есть, поэтому удаление `container:` заставляет сниппет работать. Большинство команд сталкиваются с этим, когда переносят задание в контейнер ради воспроизводимости и забывают взять `setup-dotnet` с собой.

## Исправление 1: установите SDK в том же задании и затем используйте

Каноничное исправление в GitHub Actions: `actions/setup-dotnet`. Поместите его перед любым шагом, который вызывает `dotnet`. Action скачивает SDK в кеш раннера, ставит его в начало `PATH` для каждого последующего шага и экспортирует `DOTNET_ROOT` для инструментов, которым нужен каталог установки SDK напрямую.

```yaml
# .github/workflows/build.yml -- setup-dotnet@v4
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "11.0.x"
      - run: dotnet --info
      - run: dotnet build -c Release
```

Две детали, которые кусаются:

- **`dotnet-version` принимает шаблон**, но `global.json` всё равно стоит закоммитить, чтобы локальные сборки и CI совпадали. Без него разработчик с SDK 11.0.5 локально и CI на 11.0.7 могут получить разные `obj/project.assets.json` и удивить друг друга.
- **`global-json-file:` перекрывает `dotnet-version`** в `setup-dotnet@v4`. Если передать оба, побеждает JSON. Это фича, не баг, но я видел, как люди добавляют `dotnet-version: "8.0.x"` в workflow с `global.json`, указывающим на 11, и удивляются, почему всё равно ставится .NET 11.

В Azure DevOps аналог называется `UseDotNet@2`:

```yaml
# azure-pipelines.yml -- Azure DevOps, UseDotNet@2
steps:
  - task: UseDotNet@2
    inputs:
      packageType: sdk
      version: "11.0.x"
  - script: dotnet build -c Release
```

В GitLab CI или Buildkite самый чистый путь это базовый образ с уже запечённым SDK (`mcr.microsoft.com/dotnet/sdk:11.0`). Избегайте запуска `dotnet-install.sh` в самом задании, если без этого можно обойтись: работать будет, но каждая задача платит стоимость загрузки.

## Исправление 2: закоммитьте `global.json`, соответствующий CI

Когда CI выполняет `dotnet build`, он использует SDK, выигравший разрешение `global.json`, а не последний установленный. Типичный сбой выглядит так:

```text
A compatible .NET SDK was not found.
Requested SDK version: 11.0.200
global.json file: /home/runner/work/myrepo/myrepo/global.json
Installed SDKs:
  8.0.412 [/usr/share/dotnet/sdk]
  11.0.100 [/usr/share/dotnet/sdk]
```

У раннера 11.0.100; `global.json` просит 11.0.200. Скрипт-обёртка выходит с ненулевым кодом, и в зависимости от хоста вы увидите „command not found", распространившееся из `if` в Bash, проглотившего реальную ошибку.

Держите `global.json` честным:

```json
{
  "sdk": {
    "version": "11.0.100",
    "rollForward": "latestFeature"
  }
}
```

`rollForward: latestFeature` даёт разработчику с 11.0.103 работать без необходимости менять файл на каждый патч-релиз. `latestMajor` слишком вольный для CI; `disable` слишком строгий для локалки. Совмещайте `version` с тем, что установит `dotnet-version` из `actions/setup-dotnet`.

## Исправление 3: когда приходится использовать `dotnet-install.sh`

Внутри урезанного контейнера или на самохостящемся раннере, где `setup-dotnet` использовать нельзя, ставьте через официальный скрипт и затем явно экспортируйте переменные в каждом следующем шаге.

```yaml
# self-hosted runner or restrictive container -- .NET 11
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Install .NET 11 SDK
        run: |
          curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
          chmod +x dotnet-install.sh
          ./dotnet-install.sh --channel 11.0 --install-dir "$HOME/.dotnet"
          echo "$HOME/.dotnet" >> "$GITHUB_PATH"
          echo "$HOME/.dotnet/tools" >> "$GITHUB_PATH"
          echo "DOTNET_ROOT=$HOME/.dotnet" >> "$GITHUB_ENV"
      - run: dotnet --info
      - run: dotnet tool restore && dotnet build -c Release
```

Две строки `echo` пишут в специальные файлы, которые GitHub Actions читает между шагами: `GITHUB_PATH` добавляет запись в начало `PATH` для каждого следующего шага задания, а `GITHUB_ENV` экспортирует переменную окружения тем же способом. `export PATH=...` внутри того же блока `run:` не сработает для следующего шага, и это ловушка, в которую попадают, дословно перенося shell-скрипт.

`DOTNET_ROOT` важен, даже если `PATH` настроен. Хост (бинарник `dotnet`) использует `DOTNET_ROOT`, чтобы найти каталоги `shared/Microsoft.NETCore.App` и `sdk/`. Если поправить только `PATH`, можно получить рабочий `dotnet --info`, но падающий `dotnet build` с ошибкой хоста об отсутствующей среде выполнения. По данным Microsoft Learn, `DOTNET_ROOT` читается хостом на Linux и macOS, а на Windows читается при установке вне стандартного места.

Добавьте также каталог `tools`. Без `$HOME/.dotnet/tools` в `PATH` любой вызов `dotnet tool install --global` завершится успехом, но инструмент будет недоступен, что породит связанную ошибку: `dotnet-ef: command not found`.

## Исправление 4: готовый образ с SDK, без шага установки

Для CI на Docker самый малозатратный путь это стартовать из образа, в котором SDK уже есть:

```yaml
# .gitlab-ci.yml -- pinned SDK image, no install step
build:
  image: mcr.microsoft.com/dotnet/sdk:11.0
  script:
    - dotnet --info
    - dotnet build -c Release
```

Повторите этот подход в Buildkite, CircleCI, Jenkins-агентах в Docker и любой платформе, чья примитива CI это „контейнер плюс скрипт". Гибкость (один образ, один SDK) меняется на гарантию, что `dotnet` в `PATH` с первой команды.

## Похожие варианты и двойники

Поисковые запросы, приходящие на эту страницу, иногда ищут чуть другую ошибку. Стоит развести их сразу, чтобы не гнаться за неверным исправлением.

- **`dotnet-ef: command not found`**. Глобальный инструмент установлен, но `$HOME/.dotnet/tools` нет в `PATH`. Добавьте, как показано выше, или используйте локальный манифест `dotnet-tools.json` и вызывайте `dotnet tool restore && dotnet ef`.
- **`Could not execute because the specified command or file was not found`**. `dotnet` в `PATH`, но подкоманда (`dotnet foo`) не является встроенной и не установлена как инструмент. Другая ошибка, другая первопричина.
- **`error NETSDK1045: The current .NET SDK does not support targeting .NET 11.0`**. SDK в `PATH`, но слишком старый для `TargetFramework` проекта. Повысьте `dotnet-version` у `setup-dotnet` (или `global.json`), не ставьте второй SDK рядом с первым в надежде, что многоцелевое разрешение всё разрулит.
- **`/usr/bin/env: 'dotnet': No such file or directory`**. Та же первопричина, что и у „command not found", другая оболочка. Исправление идентично.
- **`A fatal error occurred. The required library libhostfxr.so could not be found`**. `dotnet` в `PATH`, но `DOTNET_ROOT` указывает на пустой каталог, либо SDK установлен частично. Перезапустите `dotnet-install.sh` и убедитесь, что `DOTNET_ROOT` совпадает с реальным каталогом установки.

## Что похоже на исправления, но ими не является

- **Запуск `apt install dotnet-host`** в CI. Это ставит только хост, не SDK, и тянет подписанный Microsoft `.deb`, который может отставать от канала SDK на недели. Используйте `setup-dotnet` или `dotnet-install.sh`.
- **Добавление `dotnet` в `PATH` через `~/.bashrc`** внутри шага `run:`. Шаги CI выполняются в неинтерактивных оболочках; `~/.bashrc` не подгружается. Используйте `GITHUB_PATH` (GitHub Actions), `task.prependpath` (Azure DevOps) или префикс `PATH=...` на шаг.
- **`sudo` на размещённом раннере.** Размещённые раннеры уже работают под пользователем с беспарольным `sudo`, но SDK ставится в `/usr/share/dotnet`, а обёртка в `/usr/bin/dotnet` уже на месте. Если вы тянетесь к `sudo`, чтобы что-то заработало, скорее всего, не хватает `setup-dotnet`, а не привилегий.
- **Фиксация `actions/setup-dotnet` на старшем мажоре** потому что „v4 нам всё сломала". v4 поменяла каталоги кеша и стала строже парсить `global.json`. Поломка почти всегда это `global.json`, указывающий на недоступный SDK. Чините JSON; не закрепляйтесь на v3 навсегда.

## Проверка исправления в CI

Прежде чем идти дальше, выполните два диагностических шага. Они дешёвые и избавляют от погони за призраками в выводе `dotnet build`.

```yaml
- run: which dotnet || command -v dotnet || true
- run: dotnet --info
```

`which dotnet` (или `where dotnet` в Windows) подтверждает, какой бинарник разрешает оболочка. `dotnet --info` печатает среду выполнения, список SDK и разрешённый `global.json`. Если `--info` проходит, а `build` падает с „command not found", сбой внутри скрипта-обёртки, проглатывающего ошибки, а не в `dotnet`. Это момент читать обёртку, а не переустанавливать.

Когда вывод `--info` показывает запрошенный SDK, указывает `Base Path:` на ожидаемый каталог и перечисляет `global.json file: <ваш путь>`, вы закончили. Всё остальное это реальная неверная конфигурация, которую стоит исправить.

## Связанное

- Для более широкой картины запуска инструментов в параллельных дорожках CI см. [как нацеливать несколько версий Flutter из одного пайплайна CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), где тот же трюк с `GITHUB_PATH` используется для подмены SDK по заданию матрицы.
- Если сборка падает после нахождения SDK, посмотрите [почему опубликованное приложение не может загрузить сборки](/ru/2026/05/fix-could-not-load-file-or-assembly-in-published-app/), там разбор trim и runtime-pack.
- Для конкретных ошибок копирования на этапе сборки [исправление MSB3027 с retry-count](/ru/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) покрывает случаи антивируса и блокировки файлов.
- Для инструмента EF Core, который разрешается, но не цепляется к хосту, см. [исправление dotnet ef migrations add, когда не удаётся создать DbContext](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).
- Для интеграционных тестов на основе контейнеров, когда нужна настоящая база данных в том же задании, [интеграционные тесты против настоящего SQL Server с Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) проходят рабочий пайплайн.

## Источники

- [README `actions/setup-dotnet`](https://github.com/actions/setup-dotnet), документация `v4.0.x` по `dotnet-version`, `global-json-file` и `cache`.
- [Установка .NET в Linux без пакетного менеджера](https://learn.microsoft.com/en-us/dotnet/core/install/linux-scripted-manual), Microsoft Learn, охватывает `dotnet-install.sh`, `DOTNET_ROOT` и `PATH`.
- [Переменные окружения, используемые .NET SDK и CLI](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-environment-variables), Microsoft Learn, о `DOTNET_ROOT`.
- [Обзор `global.json`](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json), Microsoft Learn, о правилах `rollForward`.
- [Команды workflow для GitHub Actions](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-system-path), GitHub Docs, о `GITHUB_PATH` и `GITHUB_ENV`.
- [Issue 5267 `dotnet/core`](https://github.com/dotnet/core/issues/5267), долгоживущий апстрим-тред по теме „command 'dotnet' not found, but can be installed with".
