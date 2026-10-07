---
title: "Исправление: dotnet test переключается на VSTest в Linux CI, хотя проект использует Microsoft.Testing.Platform"
description: "dotnet test выбирает раннер по global.json, который ищется вверх от рабочего каталога. В Linux CI он переключается на VSTest, если файла нет, он назван неверно, ключ написан в неправильном регистре или SDK старше 10."
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "ci-cd"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform"
translatedBy: "claude"
translationDate: 2026-10-07
---

Если `dotnet test` запускает ваши тесты на Microsoft.Testing.Platform (MTP) через VSTest на Linux-агенте сборки, а на вашей машине этого не происходит, значит CLI не увидел выбор раннера. `dotnet test` выбирает между VSTest и MTP до того, как что-либо соберёт: он ищет `global.json`, начиная с **текущего рабочего каталога** и поднимаясь вверх, и читает раздел `"test": { "runner": "Microsoft.Testing.Platform" }` с именами свойств строго в нижнем регистре. В Linux файл должен называться `global.json` в нижнем регистре, задание должно выполняться внутри репозитория, а SDK должен быть версии 10.0 или новее. Исправьте то, что нарушает ваш конвейер, а затем сделайте так, чтобы CI громко падал, если это повторится.

Всё ниже было измерено на macOS arm64 (включая регистрозависимый том APFS, который ведёт себя как файловая система Linux) с .NET 10 SDK 10.0.302, .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) и .NET 9 SDK 9.0.318, с MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) и xunit.v3 3.2.2 (MTP v1 с `xunit.runner.visualstudio` 3.1.5).

## Ошибка в контексте

Как выглядит "откат на VSTest", зависит от версии MTP в ваших тестовых проектах. Проекты на MTP 2.x (MSTest 4.x, MSTest.Sdk 4.x, `xunit.v3.mtp-v2`) отказываются запускаться и роняют задание:

```text
Microsoft.Testing.Platform.MSBuild.targets(355,5): error : Testing with VSTest target is no longer supported by Microsoft.Testing.Platform on .NET 10 SDK and later. If you use dotnet test, you should opt-in to the new dotnet test experience. For more information, see https://aka.ms/dotnet-test-mtp-error [/src/tests/SdkTests/SdkTests.csproj]
```

Если ваш конвейер использует синтаксис выбора тестов, существующий только в MTP, сбой происходит ещё раньше, потому что `dotnet test` в режиме VSTest передаёт неизвестный параметр в MSBuild:

```text
MSBUILD : error MSB1001: Unknown switch.
    Full command line: '/usr/share/dotnet/sdk/10.0.302/MSBuild ... --target:VSTest --nologo -nodereuse:false --solution src/Repo.slnx ...'
Switch: --solution
```

Опаснее всего вариант, который остаётся зелёным. Проект на MTP v1, который по-прежнему ссылается на адаптер VSTest (`xunit.v3` 3.x с `xunit.runner.visualstudio` или MSTest 3.x с `Microsoft.NET.Test.Sdk`), спокойно работает под VSTest:

```text
Test run for /src/tests/XTests/bin/Debug/net10.0/XTests.dll (.NETCoreApp,Version=v10.0)
A total of 1 test files matched the specified pattern.
Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 6 ms - XTests.dll (net10.0)
```

В этом режиме `dotnet test -- --report-trx` тоже возвращает код выхода 0 и вообще не создаёт TRX-файл, потому что всё после `--` трактуется как аргументы RunSettings. В настоящем режиме MTP тот же проект отклоняет `--report-trx` с кодом выхода 5 (расширение не подключено), и это честный ответ. Конвейер, который публикует "все существующие TRX-файлы", с радостью опубликует ничего.

Для сравнения, вот что выводит режим MTP. Если вы не видите `Running tests from` и `Test run summary`, вы не в режиме MTP:

```text
Running tests from /src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64)
/src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64) passed (426ms)
Test run summary: Passed!
```

## Почему dotnet test игнорирует ваш выбор раннера

Выбор раннера появился в .NET 10 SDK и живёт в одном месте: разделе `test` файла `global.json`. В .NET 11 SDK (начиная с Preview 6) его может переопределить переменная окружения `DOTNET_TEST_RUNNER`. Если ни то, ни другое не выбирает MTP, `dotnet test` остаётся в режиме VSTest, вызывает цель MSBuild `VSTest` и позволяет вашему MTP-проекту реагировать так, как реагирует его версия. Ничто в `.csproj` не может изменить это решение, потому что его принимает CLI до того, как MSBuild вычислит какой-либо проект.

Причины, которые мне удалось воспроизвести, примерно в порядке того, как часто они встречаются в реальных конвейерах:

1. **Задание выполняется из каталога вне репозитория**, поэтому поиск вверх никогда не доходит до `global.json`. Передача пути к решению не помогает: поиск начинается с рабочего каталога, а не с проекта.
2. **Файл называется `Global.json`** (или `GLOBAL.JSON`). Файловые системы Windows и macOS по умолчанию нечувствительны к регистру, поэтому локально всё работает. Linux так не работает.
3. **`global.json` лежит не там, откуда запускается CI**: он находится в `src/`, а задание выполняется из корня репозитория, либо контекст сборки Docker копирует проекты, но не этот файл.
4. **Неверный регистр имени свойства.** `"Test"` или `"Runner"` молча игнорируются. Значение нечувствительно к регистру, а ключи чувствительны.
5. **В образе CI установлен SDK старше 10.0.** .NET 9 SDK не знает о существовании раздела `test`.
6. **Задана переменная `DOTNET_TEST_RUNNER=VSTest`** на уровне конвейера или агента при .NET 11 SDK. Она приоритетнее `global.json`.

## Минимальный пример воспроизведения

Два тестовых проекта, одно решение и `global.json` в корне репозитория:

```json
// global.json - .NET 10 SDK 10.0.302
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

```xml
<!-- tests/SdkTests/SdkTests.csproj - MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

Из корня репозитория `dotnet test` запускает оба проекта в режиме MTP. Теперь воспроизведём поведение CI:

```bash
# .NET 10 SDK 10.0.302
cd /tmp/elsewhere
dotnet test /src/repo/Repo.slnx        # VSTest mode: "Testing with VSTest target is no longer supported"

cd /src/repo
mv global.json Global.json
dotnet test                             # macOS/Windows: MTP mode. Linux: VSTest mode
```

Вторую половину я запускал на регистрозависимом образе диска APFS (`hdiutil create -fs "Case-sensitive APFS"`), чтобы получить семантику Linux без контейнера: `global.json` проходил, `Global.json` падал с ошибкой VSTest, а тот же `Global.json` на обычном нечувствительном к регистру томе проходил. Это классическое расхождение "у меня работает".

## Исправление подробно

### 1. Докажите, в каком режиме находится агент

Добавьте диагностический шаг перед шагом тестов. Первые строки `dotnet test --help` показывают, какую команду выбрал CLI:

```bash
# .NET 10 SDK 10.0.302 - put this right before the test step
pwd
ls -la global.json || echo "no global.json in $(pwd)"
dotnet --version
dotnet test --help | sed -n 2p
```

В режиме MTP вторая строка гласит `.NET Test Command for Microsoft.Testing.Platform (opted-in via 'global.json' file)`. В режиме VSTest она гласит `.NET Test Command for VSTest. To use Microsoft.Testing.Platform, opt-in to the Microsoft.Testing.Platform-based command via global.json.` Одна небольшая странность: в .NET 11 RC 1 SDK текст MTP по-прежнему говорит "via 'global.json' file", даже если выбор сделала переменная окружения.

### 2. Переименуйте файл в нижний регистр в git

В файловой системе, нечувствительной к регистру, простое переименование в то же имя с другим регистром подхватывается ненадёжно. Пусть это сделает git:

```bash
# any git version
git mv Global.json global.json.tmp
git mv global.json.tmp global.json
git commit -m "Rename global.json to lowercase for Linux agents"
```

То же относится к `Directory.Build.props` и подобным файлам, но они разрешаются MSBuild, и неверный регистр там даёт другие симптомы.

### 3. Запускайте шаг тестов изнутри репозитория

Поиск идёт вверх от рабочего каталога, поэтому заданию достаточно находиться в папке с `global.json` или ниже неё. В GitHub Actions рабочий каталог по умолчанию - это checkout, так что обычный виновник - явный `working-directory` или `cd` в папку артефактов:

```yaml
# GitHub Actions, actions/setup-dotnet@v6, .NET 10 SDK
- uses: actions/setup-dotnet@v6
  with:
    global-json-file: global.json
- name: Test
  run: dotnet test --solution Repo.slnx
  # no working-directory pointing at a folder outside the repo
```

`global-json-file` синхронизирует SDK, который устанавливает `setup-dotnet`, с файлом, что заодно покрывает причину 5. Он читает версию SDK из `sdk.version`, поэтому сочетайте его с фиксацией версии из шага 5. Без фиксации `setup-dotnet`, согласно документации, использует последний SDK из уже установленных на раннере. Если ваш `global.json` лежит в `src/`, либо перенесите его в корень (рекомендуется, так как `dotnet build` и IDE разрешают его так же), либо запускайте шаг с `working-directory: src`.

Для сборок Docker копируйте `global.json` в тот же каталог, из которого запускаете `dotnet test`, и проверьте `.dockerignore`:

```dockerfile
# mcr.microsoft.com/dotnet/sdk:10.0
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS test
WORKDIR /src
COPY global.json ./
COPY Repo.slnx ./
COPY tests/ tests/
RUN dotnet test --solution Repo.slnx
```

### 4. Пишите раздел точно

Всё это проверено на SDK 10.0.302:

| Содержимое `global.json` | Результат |
|---|---|
| `"test": { "runner": "Microsoft.Testing.Platform" }` | MTP |
| `"test": { "runner": "microsoft.testing.platform" }` | MTP (значение нечувствительно к регистру) |
| `"Test": { "runner": ... }` или `"test": { "Runner": ... }` | VSTest, молча |
| `"sdk": { "version": "10.0.302", "test": { ... } }` (вложенно) | VSTest, молча |
| `"test": { "runner": "MTP" }` | Сбой CLI: `Test runner 'MTP' is not supported.` |
| `// comments` в файле | MTP (комментарии разрешены) |
| завершающая запятая | Сбой CLI: `JsonException ... trailing comma` |

Громкие сбои заметить легко. Два молчаливых случая - причина сохранять точный регистр из документации и держать `test` на верхнем уровне, рядом с `sdk`, а не внутри него.

### 5. Используйте SDK, который понимает выбор раннера

На SDK 9.0.318 с точно таким же `global.json` команда `dotnet test` полностью игнорировала раздел `test` и запускала проект `xunit.v3` 3.2.2 через VSTest (`VSTest version 17.14.1`). Проект MSTest.Sdk 4.4.1 на `net9.0` тоже остался зелёным, но через старый мост MSBuild (`Run tests: '...' [net9.0|arm64]`), потому что мост по-прежнему поддерживается в SDK 9 и ранее. В обоих случаях вы теряете поведение режима MTP без какого-либо предупреждения.

Это бьёт по конвейерам, которые используют образы `mcr.microsoft.com/dotnet/sdk:9.0` или `setup-dotnet` с `dotnet-version: 9.0.x` для проекта, нацеленного на `net8.0` или `net9.0`. Менять целевую платформу проектов не нужно; нужен лишь SDK 10.0 для их запуска. Зафиксируйте его в том же файле:

```json
// global.json - SDK pin plus runner selection, .NET 10 SDK
{
  "sdk": {
    "version": "10.0.302",
    "rollForward": "latestFeature"
  },
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

При зафиксированном `sdk.version` агент без подходящего SDK падает на старте с ошибкой "compatible .NET SDK was not found", а не молча использует более старый.

### 6. Проверьте DOTNET_TEST_RUNNER на агентах с .NET 11

На .NET 11 RC 1 SDK я подтвердил документированный приоритет: `DOTNET_TEST_RUNNER=VSTest` переопределяет корректный `global.json` и даёт ту же ошибку "Testing with VSTest target is no longer supported", а пустое или нераспознанное значение (`DOTNET_TEST_RUNNER=MTP`) игнорируется, и побеждает `global.json`. Переменная работает и в обратную сторону, что делает её удобным временным исправлением, когда вы не можете изменить репозиторий:

```bash
# .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) and later; ignored by the .NET 10 SDK
export DOTNET_TEST_RUNNER=Microsoft.Testing.Platform
dotnet test --solution Repo.slnx
```

На SDK 10.0.302 переменная не действует ни в одном из направлений, поэтому не полагайтесь на неё, пока агент не перейдёт на .NET 11.

### 7. Заставьте откат ронять сборку

Две дешёвые защиты превращают молчаливый вариант в красную сборку:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
dotnet test --solution Repo.slnx --minimum-expected-tests 1
```

`--solution` (или `--project`) существует только в режиме MTP, поэтому в режиме VSTest команда умирает с `MSB1001: Unknown switch`, а не запускает тесты неправильным способом. `--minimum-expected-tests` - это параметр MTP, который завершает запуск с кодом выхода 9, если выполнено меньше тестов, чем ожидалось. Никогда не передавайте параметры MTP после `--` в CI: именно этот синтаксис режим VSTest проглатывает без возражений.

Если вы ещё мигрируете, уберите также `TestingPlatformDotnetTestSupport` из своих проектов, как только переключение через `global.json` заработает. Он важен только в режиме VSTest, и если оставить его, проект на MTP v1 будет продолжать "работать" через мост, когда выбор раннера потеряется.

## Подводные камни и похожие случаи

- **`.csproj` не может включить режим за вас.** `TestingPlatformDotnetTestSupport`, `EnableMSTestRunner` и `UseMicrosoftTestingPlatformRunner` определяют, как проект ведёт себя в каждом режиме. Они не выбирают сам режим.
- **Смешанное решение - это другая ошибка.** Когда режим MTP включён, проект, поддерживающий только VSTest, роняет запуск. Это обратная проблема, она разобрана в [руководстве по миграции с VSTest на Microsoft.Testing.Platform](/ru/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/).
- **`Zero tests ran` с кодом выхода 5 означает, что вы в режиме MTP.** Тестовое приложение отклонило параметр, см. [dotnet test с кодом выхода 5 на Microsoft.Testing.Platform](/ru/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/).
- **Задачи Azure DevOps `VSTest@2` и `VSTest@3` всегда используют vstest.console.** Никакие изменения `global.json` этого не меняют. Вместо них используйте шаг-скрипт, который вызывает `dotnet test` из корня репозитория.
- **IDE делают собственный выбор.** Когда Test Explorer читает проект иначе, чем CLI, это отдельный класс ошибок, например [зависание Test Explorer на xUnit v3, пока dotnet test проходит](/ru/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).

## Связанные материалы

- Полная [миграция с VSTest на Microsoft.Testing.Platform в .NET 11](/ru/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/), включая переход от `--logger` к `--report-trx` и от `.runsettings` к `testconfig.json`.
- Когда режим MTP активен, но проект отказывается принимать свои аргументы: [исправление dotnet test с кодом выхода 5 и "Zero tests ran"](/ru/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/).
- Как получить аннотации сбоев MTP в диффе pull request, когда CI работает в правильном режиме: [аннотации GitHub Actions в Microsoft.Testing.Platform 2.3](/ru/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/).
- Перенос проекта `xunit.v3` 3.x с MTP v1 и адаптера VSTest: [миграция тестового проекта с xUnit v2 на xUnit v3](/ru/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).

## Источники

- [Команда dotnet test: выбор раннера тестов](https://learn.microsoft.com/dotnet/core/tools/dotnet-test#choose-a-test-runner)
- [Тестирование с dotnet test: режим VSTest и режим MTP](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test)
- [Обзор global.json, включая способ поиска файла](https://learn.microsoft.com/dotnet/core/tools/global-json)
- [dotnet test с Microsoft.Testing.Platform](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [actions/setup-dotnet: параметр global-json-file](https://github.com/actions/setup-dotnet)
- [Репозиторий microsoft/testfx (MSTest и Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)
