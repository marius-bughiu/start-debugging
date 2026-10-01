---
title: "Исправление: dotnet test завершается с кодом 5 и \"Zero tests ran\" на Microsoft.Testing.Platform"
description: "Код выхода 5 означает, что MTP отклонил параметр командной строки, а не то, что тесты отсутствуют. Запустите исполняемый файл тестов напрямую, чтобы увидеть настоящую ошибку, затем добавьте пакет расширения или направьте параметр только в нужные проекты."
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform"
translatedBy: "claude"
translationDate: 2026-10-01
---

Если `dotnet test` выводит `Zero tests ran`, а за ним `Exit code: 5`, ваши тесты даже не были обнаружены: тестовое приложение отказалось принять один из переданных аргументов. В Microsoft.Testing.Platform (MTP) код выхода 5 означает "недопустимые аргументы командной строки", а `dotnet test` отбрасывает объяснение. Запустите собранный исполняемый файл тестов с теми же аргументами (`./bin/Debug/net10.0/MyTests --logger trx`), чтобы увидеть настоящее сообщение. Затем либо подключите пакет расширения, который предоставляет этот параметр, либо замените флаг времён VSTest его эквивалентом в MTP, либо направьте параметр только в те проекты, которые его понимают, через `TestingPlatformCommandLineArguments`.

Все приведённые ниже результаты получены на .NET 10 SDK 10.0.302 и .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) на macOS arm64 с MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1), MSTest.Sdk 4.3.3 (MTP 2.3.3) и xunit.v3.mtp-v2 4.0.1, при этом `global.json` переключает `dotnet test` в режим MTP.

## Ошибка в контексте

Это весь вывод команды `dotnet test --project MsTests --logger trx` на SDK 10.0.302 для проекта MSTest с двумя вполне рабочими тестами:

```text
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0) Zero tests ran
Exit code: 5

Test run summary: Zero tests ran
  error: 1

  total: 0
  failed: 0
  succeeded: 0
  skipped: 0
  duration: 82ms
Test run completed with non-success exit code: 5 (see: https://aka.ms/testingplatform/exitcodes)
```

Обратите внимание на то, чего не хватает: целевая платформа выводится как `(net10.0)` вместо `(net10.0|arm64)`, а строки `Running tests from ...` нет. Тестовый хост так и не дошёл до обнаружения тестов. Параметры `--output Detailed`, `-v detailed` и `--diagnostic` причину не возвращают, а файл `.diag`, который пишет `--diagnostic`, содержит только исходную командную строку.

В .NET 11 RC 1 SDK итоговая строка меняется на `Test run summary: Failed!`, а новый раздел `Handshake failures:` перечисляет модуль, но причина по-прежнему не выводится.

В решении с несколькими тестовыми проектами это легче понять неверно, потому что один проект падает, а другой проходит:

```text
XTests/bin/Debug/net10.0/XTests.dll (net10.0) Zero tests ran
Exit code: 5
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0|arm64) passed (848ms)
Test run summary: Failed!
  error: 1
  total: 2
```

## Почему MTP возвращает код выхода 5 и сообщает, что ни один тест не запускался

Тестовый проект MTP это обычное консольное исполняемое приложение. `dotnet test` в режиме MTP собирает каждый тестовый проект, запускает исполняемый файл, передаёт ему все аргументы, которые не потребил сам, и общается с процессом через именованный канал. Тестовое приложение проверяет свою командную строку раньше всего остального. Если какой-либо параметр неизвестен или у известного параметра недопустимое значение, оно завершается с кодом 5 и не обнаруживает ни одного теста. В [таблице кодов выхода MTP](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting#exit-codes) код 5 определён как "аргументы командной строки, переданные тестовому приложению, были недопустимы".

Затем `dotnet test` сообщает о модуле так же, как о любом модуле без результатов: `Zero tests ran`. Формально текст верен, но вводит в заблуждение, потому что отправляет вас искать пропущенные атрибуты `[TestMethod]` или сломанный фильтр.

Параметры становятся неизвестными по четырём причинам, в порядке частоты в реальных конвейерах:

1. **Флаг VSTest пережил миграцию.** `--logger trx`, `--collect "XPlat Code Coverage"`, `--blame-hang-timeout 5m` и `--blame-crash` относятся к VSTest. В MTP нет ни `--logger`, ни `--collect`.
2. **Отсутствует пакет расширения.** Ядро MTP не содержит ни средств отчётов, ни покрытия, ни дампов, ни повторных запусков. `--report-trx` существует только при подключённом `Microsoft.Testing.Extensions.TrxReport`, `--coverage` требует `Microsoft.Testing.Extensions.CodeCoverage` и так далее.
3. **Разные фреймворки в одном решении.** MSTest.Sdk по умолчанию включает TRX и покрытие кода. Обычный проект xUnit v3 этого не делает. Одна и та же командная строка `dotnet test --solution` допустима для одного проекта и недопустима для другого.
4. **Неверное значение допустимого параметра.** `--settings` указывает на файл, которого нет на агенте, или `--timeout 30` без суффикса единицы измерения.

Код выхода 8 это другая ошибка, дающая тот же текст `Zero tests ran`. В этом случае аргументы были в порядке и тестовое приложение выполнило обнаружение, но ничего не подошло. Различить их можно по строке `Exit code:` и по наличию строки `Running tests from ...`.

## Минимальное воспроизведение

`global.json` включает для `dotnet test` режим MTP (обязательно в .NET 10 SDK и новее; без него вы остаётесь на мосту VSTest):

```json
// .NET 10 SDK 10.0.302
{
  "sdk": { "version": "10.0.302" },
  "test": { "runner": "Microsoft.Testing.Platform" }
}
```

Проект MSTest с MSTest SDK:

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MsTests/Tests.cs, .NET 10, MSTest 4.4.1
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace MsTests;

[TestClass]
public class CalculatorTests
{
    [TestMethod]
    public void Adds() => Assert.AreEqual(4, 2 + 2);

    [TestMethod, TestCategory("Slow")]
    public void Multiplies() => Assert.AreEqual(6, 2 * 3);
}
```

И рядом проект xUnit v3:

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  </ItemGroup>
</Project>
```

Вот что вернула каждая команда на SDK 10.0.302:

| Команда | Код выхода | Что сказала сводка |
| --- | --- | --- |
| `dotnet test --project MsTests` | 0 | Успешно, 2 теста |
| `dotnet test --project MsTests --logger trx` | 5 | Zero tests ran |
| `dotnet test --project MsTests --collect "XPlat Code Coverage"` | 5 | Zero tests ran |
| `dotnet test --project MsTests --blame-hang-timeout 5m` | 5 | Zero tests ran |
| `dotnet test --project MsTests --report-trx` | 0 | Успешно, TRX записан |
| `dotnet test --solution All.sln --report-trx` | 5 | MSTest прошёл, xUnit "Zero tests ran" |
| `dotnet test --solution All.sln --coverage` | 5 | MSTest прошёл, xUnit "Zero tests ran" |
| `dotnet test --solution All.sln --settings x.runsettings` (файла нет) | 5 | оба "Zero tests ran" |
| `dotnet test --project MsTests --filter "TestCategory=DoesNotExist"` | 8 | Zero tests ran (настоящий) |
| `dotnet test --project MsTests --minimum-expected-tests 5` | 9 | Нарушение политики минимального числа ожидаемых тестов |

## Исправление подробно

### 1. Получите настоящее сообщение об ошибке от тестового приложения

Запустите собранный исполняемый файл сами с теми же аргументами, что передаёт CI. В Windows это `MsTests.exe`, в Linux и macOS у него нет расширения:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
./MsTests/bin/Debug/net10.0/MsTests --logger trx
```

```text
Unknown option '--logger'
Option '--logger' uses VSTest syntax, which is not supported by Microsoft.Testing.Platform.
Use '--report-trx' instead.
Run '--help' to see the options registered by this test application. If the option belongs to an extension, ensure its package is referenced and the extension is registered.
Command line: --logger trx
```

`dotnet run --project MsTests --no-build -- --logger trx` выводит то же самое и тоже возвращает 5. Подсказка "uses VSTest syntax ... Use '--report-trx' instead" появилась в MTP 2.4. MTP 2.3.3 (MSTest.Sdk 4.3.3) выводит только `Unknown option '--logger'` и справку, чего всё равно достаточно.

Далее спросите у приложения, какие параметры у него действительно есть. `--help` перечисляет параметры платформы и отдельно "Extension options", добавленные подключёнными пакетами. `--info` выводит версию платформы и каждое зарегистрированное расширение с его версией:

```bash
# .NET 10 SDK 10.0.302
./XTests/bin/Debug/net10.0/XTests --help
./XTests/bin/Debug/net10.0/XTests --info
```

Если передаваемого вами параметра нет в этом списке, он завершится с кодом выхода 5. Эта единственная проверка решает большинство подобных обращений.

### 2. Замените флаги VSTest их эквивалентами в MTP

| Аргумент VSTest | Аргумент MTP | Пакет, который его предоставляет |
| --- | --- | --- |
| `--logger trx` | `--report-trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--logger trx;LogFileName=x.trx` | `--report-trx --report-trx-filename x.trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--collect "Code Coverage"` | `--coverage` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--collect "XPlat Code Coverage"` | `--coverage --coverage-output-format cobertura` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--blame-hang-timeout 5m` | `--hangdump --hangdump-timeout 5m` | `Microsoft.Testing.Extensions.HangDump` |
| `--blame-crash` | `--crashdump` | `Microsoft.Testing.Extensions.CrashDump` |
| `--results-directory` | `--results-directory` | встроен |

На момент написания актуальные версии: 2.4.1 для TrxReport, HangDump и CrashDump и 18.11.2 для CodeCoverage. Полное соответствие приведено в [справочнике параметров CLI MTP](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options). `--filter` сохраняет синтаксис выражений VSTest для MSTest и NUnit, поэтому обычно его менять не нужно.

### 3. Подключите расширение в каждом проекте, который получает параметр

В воспроизведении общий для решения `--report-trx` падал только потому, что в проекте xUnit не было средства отчётов. Его добавление исправило запуск:

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<ItemGroup>
  <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.4.1" />
</ItemGroup>
```

```text
MsTests.dll (net10.0|arm64) passed (837ms)
XTests.dll (net10.0|arm64) passed (922ms)
Test run summary: Passed!
  total: 4
```

Если все тестовые проекты должны создавать TRX и покрытие, вынесите ссылки в `Directory.Build.props` с условием `IsTestProject`, чтобы новые проекты подхватывали их автоматически. В проектах MSTest.Sdk они уже есть, поэтому добавьте условие `'$(UsingMSTestSdk)' != 'true'`, если хотите избежать дублирования ссылок.

### 4. Направляйте параметры в проекты через TestingPlatformCommandLineArguments

Иногда расширение нужно не везде. Покрытие интеграционного тестового проекта часто только шум, а дампы полезны лишь для проекта, который зависает. Вместо передачи параметра в командной строке `dotnet test` поместите его в проект, который его понимает:

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <TestingPlatformCommandLineArguments>$(TestingPlatformCommandLineArguments) --coverage --coverage-output-format cobertura</TestingPlatformCommandLineArguments>
  </PropertyGroup>
</Project>
```

После этого обычный `dotnet test --solution All.sln` вернул код выхода 0, проект xUnit выполнился без покрытия, а проект MSTest записал `.cobertura.xml` в `TestResults`. Microsoft описывает тот же подход для [решений со смешанными тестовыми фреймворками или расширениями](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions). Держите `$(TestingPlatformCommandLineArguments)` в начале, чтобы значения из `Directory.Build.props` не перезаписывались.

### 5. Проверяйте значения, а не только имена

Если параметр есть в `--help`, а код выхода всё равно 5, неверно значение. В воспроизведении `--settings x.runsettings` с отсутствующим файлом уронил оба проекта с кодом выхода 5. Пути разрешаются относительно рабочего каталога тестового процесса, который в CI не всегда совпадает с корнем репозитория. Значениям времени в MTP нужны единицы: `--timeout 30m` работает, просто число нет.

## Код выхода 8: когда ноль тестов запущен по-настоящему

Если код выхода 8, аргументы были приняты, а фильтр или проект просто не дали ни одного теста. По умолчанию MTP считает это ошибкой, в отличие от VSTest, который возвращал 0. Есть три рычага:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1

# Accept an empty run for this invocation (returns 0)
dotnet test --project MsTests --filter "TestCategory=Nightly" --ignore-exit-code 8

# Or demand a floor: fewer than 50 tests returns exit code 9
dotnet test --solution All.sln --minimum-expected-tests 50
```

`--ignore-exit-code` также читается из переменной окружения `TESTINGPLATFORM_EXITCODE_IGNORE`, что удобно, когда один и тот же фильтр используется во многих конвейерах. Применяйте его осторожно: фильтр, который молча ничего не находит, это именно та ошибка, для обнаружения которой создан код выхода 8.

Версия SDK важна для запусков с несколькими проектами. На SDK 10.0.302 запуск решения, в котором один проект подошёл под фильтр, а другой ничего не нашёл, вернул 8 для всего запуска. В .NET 11 RC 1 SDK та же команда вернула 0 с `Test run summary: Passed!`, при этом рядом с пустым модулем по-прежнему печатался `Exit code: 8`. Это новый [вердикт о нуле тестов для всего запуска](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp) в .NET 11 SDK. Если ваш CI краснеет на .NET 10 и зеленеет на .NET 11 с тем же фильтром, причина в этом. Код выхода 5 не изменился: оба SDK завершают весь запуск ошибкой, если какой-либо модуль отклоняет свои аргументы.

## Подводные камни и похожие случаи

- **`error: 1` в сводке это модуль, а не тест.** Он считает модули, завершившиеся аварийно. `failed: 0` остаётся нулём, потому что ни один тест не выполнялся.
- **`dotnet test -- --some-option` не помогает.** В режиме MTP аргументы передаются в любом случае, поэтому двойной дефис не скрывает их от тестового приложения.
- **Фильтр MTP, ничего не нашедший, возвращает 8, а не 5.** Если вы видите `Running tests from ...` перед `Zero tests ran`, аргументы были в порядке. Проверьте синтаксис фильтра для вашего фреймворка.
- **`--zero-tests-policy strict` не изменил мой запуск, где все тесты пропущены.** В документации сказано, что strict считает пропущенные тесты не запущенными. На MTP 2.4.1 проект, единственный тест которого имел `[Ignore]`, всё равно вернул 0 при strict, поэтому не полагайтесь на него как на единственную защиту. `--minimum-expected-tests` явный и надёжный.
- **"No test projects were found" это другая проблема.** Она приходит из оценки проекта (обычно `--no-restore` на этапе контейнера без папки `obj`), а не от тестового приложения. Её разбирает страница устранения неполадок MTP.
- **Test Explorer может показывать собственную версию этой проблемы.** Если CLI зелёный, а Visual Studio зависает на xUnit v3, это несовпадение средств запуска, а не проблема с аргументами.

## См. также

- Пошаговая [миграция с VSTest на Microsoft.Testing.Platform](/ru/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) охватывает остальные изменения в CI, включая переход с `.runsettings` на `testconfig.json`.
- Если Visual Studio зависает, а CLI проходит, см. [Test Explorer зависает на xUnit v3, пока dotnet test проходит](/ru/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).
- Выбор фреймворка для нового решения с сравнением поддержки MTP: [xUnit v3 против NUnit и MSTest в 2026 году](/ru/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).
- Сначала перенесите старый проект xUnit на MTP: [миграция тестового проекта с xUnit v2 на xUnit v3](/ru/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).
- Аннотации сбоев прямо в pull request: [аннотации GitHub Actions в Microsoft.Testing.Platform 2.3](/ru/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/).

## Источники

- [Microsoft.Testing.Platform troubleshooting: exit codes and unrecognized extension options](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting)
- [Microsoft.Testing.Platform CLI options reference](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options)
- [Testing with dotnet test: solutions with mixed test frameworks or extensions](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions)
- [dotnet test in MTP mode, including whole-run minimums](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [microsoft/testfx repository (MSTest and Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)
