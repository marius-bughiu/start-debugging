---
title: "Миграция с VSTest на Microsoft.Testing.Platform в SDK .NET 11"
description: "Пошаговая миграция с VSTest на Microsoft.Testing.Platform 2.3.3: подключение через OutputType Exe, переключение runner в global.json, логгеры, ставшие репортерами, замена .runsettings на testconfig.json и коды выхода, которые делают зелёную задачу CI красной."
pubDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "vstest"
  - "microsoft-testing-platform"
  - "testing"
  - "dotnet-11"
  - "dotnet"
  - "ci-cd"
lang: "ru"
translationOf: "2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-02
---

Перевод решения с VSTest на Microsoft.Testing.Platform (MTP) занимает полдня на файлы проектов и целый день на CI. Со стороны проекта это три строки на каждый тестовый проект: `<OutputType>Exe</OutputType>`, одно свойство для включения вашего тестового фреймворка и `global.json`, в котором задано `"runner": "Microsoft.Testing.Platform"`. Время съедает всё остальное: каждый флаг `--logger`, `--collect` и `--blame` в вашем конвейере отображается на другую опцию, которая существует только при добавлении соответствующего пакета NuGet, файл `.runsettings` теряет почти весь смысл, а тестовый проект, выполнивший ноль тестов, теперь роняет сборку с кодом выхода 8 вместо того, чтобы пройти. Это руководство написано для SDK .NET 11 (Preview 7, август 2026), Microsoft.Testing.Platform 2.3.3, MSTest 4.3.3, NUnit3TestAdapter 6.3.0 и xunit.v3 4.0.0.

## Почему переходить стоит сейчас

- **Это общее направление развития.** У MSTest собственный runner MTP появился с версии 3.2.0, у NUnit с NUnit3TestAdapter 5.0.0, а xUnit v3 изначально построен на MTP. VSTest находится в режиме поддержки: самым заметным изменением этого года стало [удаление зависимости от Newtonsoft.Json](/ru/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/).
- **Тестовые модули по умолчанию выполняются параллельно.** VSTest выстраивает сборки последовательно, если с ним не бороться. MTP запускает до `Environment.ProcessorCount` тестовых модулей одновременно, ограничение задаётся через `--max-parallel-test-modules`.
- **Никакого внешнего runner.** Тестовый проект сам является исполняемым файлом. `./MyApp.Tests` запускает набор тестов без `vstest.console.exe`, без `dotnet test` и без прохода обнаружения адаптеров. Это важно для образов контейнеров и для локального воспроизведения падения в CI.
- **Политики уровня запуска, которые раньше приходилось писать самому.** `--timeout`, `--maximum-failed-tests`, `--minimum-expected-tests` и `--ignore-exit-code` встроены в платформу, и последние три существуют именно потому, что они нужны в CI.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| Форма проекта | Тестовые проекты должны задавать `<OutputType>Exe</OutputType>` | высокая |
| Согласованность решения | При включённом в `global.json` MTP **каждый** тестовый проект обязан использовать MTP. Смешанное решение это ошибка, а не предупреждение | высокая |
| `--logger` | Переименовано в "репортеры". `--logger trx` становится `--report-trx` и требует `Microsoft.Testing.Extensions.TrxReport` | высокая |
| `--collect "Code Coverage"` | Становится `--coverage`, требует `Microsoft.Testing.Extensions.CodeCoverage`, а `IncludeTestAssembly` теперь по умолчанию `false` | высокая |
| `--blame-crash` / `--blame-hang` | Становятся `--crashdump` / `--hangdump` из отдельных пакетов. У `--blame-crash-collect-always` эквивалента нет | средняя |
| Выполнено ноль тестов | VSTest возвращает 0. MTP возвращает код выхода 8 | высокая |
| `.runsettings` | Поддерживается только через мосты VSTest у MSTest и NUnit. Сама платформа читает `testconfig.json` | средняя |
| `dotnet test MyTests.csproj` | Позиционные пути к проекту исчезли. Используйте `--project`, `--solution` или `--test-modules` | средняя |
| Фильтры xUnit | `--filter` не реализован. Используйте `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, `--filter-query` | высокая (только xUnit) |
| `RunConfiguration.TargetPlatform=x86` | Становится `--arch x86` | низкая |
| Кодировка консоли | MTP всегда устанавливает UTF-8. Режим изоляции VSTest по умолчанию этого не делал | низкая |

Сроки работ определяют две строки: согласованность решения и `--logger`. Об остальном инструментарий сообщит сам.

## Подготовительный список

- **SDK .NET 10 или новее.** Выбор runner появился в SDK .NET 10. На .NET 9 и раньше вы привязаны к мосту `TestingPlatformDotnetTestSupport` и к обязательному разделителю `--`.
- **MTP 1.7 или новее** в каждом тестовом проекте. Интеграция MTP с `dotnet test` поддерживается только начиная с 1.7; текущая стабильная версия 2.3.3.
- **Сначала проведите инвентаризацию конвейера.** Поищите в CI через grep: `dotnet test`, `vstest.console`, `--logger`, `--collect`, `--blame`, `--settings` и `--filter`. Этот grep и есть ваш реальный список задач.
- **Найдите каждый `.runsettings`.** Выполните `find . -name "*.runsettings"` и прочитайте каждый файл. Всё, что находится под `DataCollectionRunSettings`, становится опцией CLI или исчезает.
- **Знайте свои фреймворки.** Решению, где есть и MSTest, и xUnit, потребуется маршрутизация аргументов по проектам (см. шаг 6). Выясните это сейчас, а не когда CI упадёт с кодом выхода 5.
- **Сначала переведите один проект целиком**, включая реальный запуск CI, и только потом трогайте остальные.

## Шаги миграции

1. **Зафиксируйте SDK и выберите runner в `global.json`.**

   Выбор runner это решение уровня репозитория, а не отдельного проекта.

   ```json
   // global.json - .NET 11 SDK
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     },
     "test": {
       "runner": "Microsoft.Testing.Platform"
     }
   }
   ```

   `VSTest` это второе допустимое значение, и оно остаётся значением по умолчанию, когда раздел `test` отсутствует. В SDK .NET 11 это можно переопределить на уровне оболочки переменной окружения `DOTNET_TEST_RUNNER`, и это самый быстрый способ сравнить два варианта задачи CI, не трогая версионируемый файл.

   Проверка: `dotnet test --help` теперь перечисляет `--project`, `--solution` и `--test-modules`. Если там по-прежнему `--logger` и `--collect`, переключение runner не сработало.

2. **Сделайте каждый тестовый проект исполняемым.**

   Это универсальное подключение, независимо от фреймворка. Поместите его в `Directory.Build.props` рядом с тестовыми проектами, а не повторяйте в каждом.

   ```xml
   <!-- tests/Directory.Build.props - .NET 11 SDK, MTP 2.3.3 -->
   <Project>
     <PropertyGroup>
       <OutputType>Exe</OutputType>
     </PropertyGroup>
   </Project>
   ```

   Писать `Main` не нужно. `Microsoft.Testing.Platform.MSBuild`, который каждый совместимый с MTP фреймворк подтягивает транзитивно, генерирует `TestingPlatformEntryPoint` за вас.

   Проверка: `dotnet build` создаёт исполняемый файл `MyApp.Tests` (или `.exe`) в выходной папке, и его прямой запуск выполняет набор тестов.

3. **Включите runner своего тестового фреймворка.**

   У каждого фреймворка своё свойство, и минимальные версии различаются.

   ```xml
   <!-- tests/Directory.Build.props - pick the one that matches your framework -->
   <PropertyGroup>
     <!-- MSTest 3.2.0+, current 4.3.3 -->
     <EnableMSTestRunner>true</EnableMSTestRunner>

     <!-- NUnit3TestAdapter 5.0.0+, current 6.3.0 -->
     <EnableNUnitRunner>true</EnableNUnitRunner>

     <!-- xunit.v3 1.0.1+, current 4.0.0 -->
     <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
   </PropertyGroup>
   ```

   Проекты MSTest могут вовсе обойтись без этого свойства, переключив SDK проекта на `MSTest.Sdk`, где MTP включён по умолчанию. xunit.v3 4.0.0 разрешается в вариант пакета для MTP v2; линейка 3.x по умолчанию использовала MTP v1, от которого 4.0.0 отказалась. Если вы всё ещё на xUnit v2, официального пути к MTP нет, поэтому сначала выполните [миграцию с v2 на v3](/ru/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).

   Проверка: запустите исполняемый файл тестов с `--help`. Вы должны увидеть опции платформы (`--filter-uid`, `--timeout`, `--list-tests`) плюс всё, что регистрирует ваш фреймворк.

4. **Удалите переходные свойства эпохи .NET 9.**

   Многие статьи в блогах и даже части страницы MSTest на MS Learn всё ещё их показывают. В SDK .NET 10 или .NET 11 с выбором runner через `global.json` они устарели и должны быть удалены:

   ```xml
   <!-- delete these from every test project and Directory.Build.props -->
   <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   <TestingPlatformShowTestsFailure>true</TestingPlatformShowTestsFailure>
   ```

   Разделитель `--`, который они требовали, тоже становится необязательным, хотя в CI его стоит сохранить по причине, описанной в шаге 6.

   Проверка: `dotnet test` по-прежнему выполняется, а вывод консоли показывает терминальный репортер MTP, а не VSTest.

5. **Верните логгеры и коллекторы в виде пакетов расширений.**

   Ядро MTP не содержит ни одного из них. Если конвейер передаёт опцию, пакет которой отсутствует, запуск падает с **кодом выхода 5**, потому что опция не распознана.

   ```xml
   <!-- tests/Directory.Build.props - MTP 2.3.3 extensions -->
   <ItemGroup>
     <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CodeCoverage" Version="18.10.0" />
     <PackageReference Include="Microsoft.Testing.Extensions.HangDump" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CrashDump" Version="2.3.3" />
   </ItemGroup>
   ```

   Расширение покрытия кода версионируется независимо от платформы: оно следует нумерации тестовой платформы Visual Studio, поэтому текущий выпуск 18.10.0, тогда как остальные находятся на 2.3.3. Документированная таблица совместимости сопоставляет линейку 18.1.x с MTP 2.0.x, 18.0.x с 1.8.x и 17.14.x с 1.6.2, а рекомендация состоит в том, чтобы держать обе стороны на последних версиях. Если вы используете Central Package Management, им место в `Directory.Packages.props`, и это ещё один аргумент за то, чтобы [перевести решение на Directory.Packages.props](/ru/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) до начала работ.

   Проверка: `dotnet test --help` перечисляет `--report-trx`, `--coverage`, `--hangdump` и `--crashdump`.

6. **Переведите командную строку CI.**

   Здесь и находится основной объём работы. Соответствие:

   ```bash
   # before - VSTest, .NET 9 SDK
   dotnet test MyApp.sln \
     --logger "trx;LogFileName=results.trx" \
     --collect "Code Coverage" \
     --blame-hang-timeout 5m \
     --results-directory ./artifacts/tests \
     --filter "TestCategory=Integration"
   ```

   ```bash
   # after - MTP 2.3.3, .NET 11 SDK
   dotnet test --solution MyApp.sln \
     --results-directory ./artifacts/tests \
     -- --report-trx --report-trx-filename results.trx \
        --coverage --coverage-output-format cobertura \
        --hangdump --hangdump-timeout 5m \
        --filter "TestCategory=Integration"
   ```

   Обратите внимание на три вещи. Позиционный `MyApp.sln` превратился в `--solution`, потому что `dotnet test` в режиме MTP больше не принимает голый путь. Разделитель `--` формально необязателен начиная с SDK .NET 10, но `dotnet test` передаёт нераспознанные токены тестовому приложению, и распознанная опция SDK, оказавшаяся между именем нераспознанной опции и её значением, меняет привязку оставшихся токенов. Поместите аргументы тестового приложения после `--`, и неоднозначность исчезнет. Наконец, `--results-directory` понимают и SDK, и платформа, поэтому он может стоять с любой стороны.

   Для решения, в котором смешаны фреймворки или наборы расширений, маршрутизируйте аргументы по проектам, а не глобально:

   ```xml
   <!-- only the projects that reference HangDump get the option -->
   <PropertyGroup Condition="'$(MSBuildProjectName)' == 'MyApp.Integration.Tests'">
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --hangdump --hangdump-timeout 5m
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   Проверка: запуск создаёт `results.trx` и файл Cobertura в `./artifacts/tests`, а код выхода равен 0.

7. **Замените `.runsettings` на `testconfig.json`.**

   MSTest и NUnit продолжают учитывать `--settings config.runsettings` через свои мосты VSTest, так что этот шаг можно отложить. xUnit v3 так не умеет, а сама платформа runsettings не читает никогда. Замена:

   ```json
   // testconfig.json at the repo root - MTP 2.3.3
   {
     "platformOptions": {
       "resultDirectory": "./artifacts/tests",
       "exitProcessOnUnhandledException": false
     },
     "environmentVariables": {
       "DOTNET_ENVIRONMENT": "Testing"
     },
     "mstest": {
       "parallelism": { "enabled": true, "workers": 4, "scope": "method" },
       "timeout": { "test": 30000 }
     }
   }
   ```

   Соответствие не один к одному. `RunConfiguration/ResultsDirectory` становится `platformOptions.resultDirectory`. У `RunConfiguration/MaxCpuCount` эквивалента нет, потому что параллелизм на уровне процессов теперь задаётся через `--max-parallel-test-modules`. `LoggerRunSettings/Loggers` и всё, что находится под `DataCollectionRunSettings`, превращается в опции CLI из шага 5. `TestRunParameters` становится `--test-parameter key=value`. Начиная с MTP 2.3.0 сами опции CLI тоже можно помещать в `testconfig.json`, включая опции расширений, и именно так `--coverage-output-format cobertura` не попадает в каждый файл конвейера; раздел `environmentVariables` также доступен с 2.3.0.

   Направьте все проекты на один общий файл через `Directory.Build.props`:

   ```xml
   <PropertyGroup>
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --config-file $(MSBuildThisFileDirectory)testconfig.json
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   Проверка: удалите ссылку на `.runsettings` из CI и убедитесь, что результаты по-прежнему попадают в настроенный каталог.

8. **Замените саму задачу CI.**

   В Azure DevOps замените задачу `VSTest@2` на `DotNetCoreCLI@2`. Это обычный вызов `dotnet test`, поэтому правила шага 6 применяются дословно:

   ```yml
   # azure-pipelines.yml - .NET 11 SDK, MTP 2.3.3
   - task: DotNetCoreCLI@2
     inputs:
       command: 'test'
       arguments: '--solution MyApp.sln -- --report-trx --results-directory $(Agent.TempDirectory)'
   ```

   В GitHub Actions пакет `Microsoft.Testing.Extensions.GitHubActionsReport` вместе с `--report-gh` помещает падения прямо в diff pull request, и это [та самая история с отчётами, которая стала стабильной в MTP 2.3](/ru/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/). Обратите внимание на почти совпадение: сторонний пакет `GitHubActionsTestLogger` использует `--report-github`, отличающийся от официальной опции на один символ.

   Проверка: намеренно падающий тест даёт красную задачу, где падение видно в сводке запуска, а не только в сыром журнале.

## Проверьте миграцию

Пройдите этот список на одном проекте, прежде чем распространять изменение на всё решение:

- `dotnet build` выдаёт исполняемый файл на каждый тестовый проект, и его прямой запуск (`./MyApp.Tests`) сообщает то же количество тестов, что и `dotnet test`.
- `dotnet test --help` перечисляет каждую опцию, которую передаёт ваш конвейер. Если какой-то нет, значит нет её пакета.
- Количество тестов совпадает с показателем VSTest до миграции. Падение обычно означает, что выражение фильтра перестало совпадать, а не что тесты пропали.
- Файл TRX и отчёт о покрытии существуют по тем путям, которые читают ваши последующие шаги.
- Test Explorer в Visual Studio по-прежнему обнаруживает и запускает тесты. Поддержка MTP требует Visual Studio 17.14 или новее; VS Code нужен C# Dev Kit.
- `echo $?` после успешного запуска даёт 0, а после намеренно падающего 2.

## Откат

Эта миграция откатывается одним коммитом до тех пор, пока `Microsoft.NET.Test.Sdk` и пакет адаптера VSTest вашего фреймворка остаются в ссылках. Удалите раздел `test` из `global.json`, и runner вернётся к VSTest; `OutputType=Exe` и свойства подключения под VSTest не действуют. Именно поэтому не стоит удалять `xunit.runner.visualstudio` и `Microsoft.NET.Test.Sdk` в том же pull request. Проведите очистку через неделю, когда CI и IDE каждого разработчика поработают на MTP.

## Подводные камни, о которых стоит знать заранее

**Код выхода 8 делает зелёную задачу красной.** Проект, выполнивший ноль тестов, завершается с 8 под MTP и с 0 под VSTest. Это бьёт по решениям с проектом-заглушкой или с фильтром, который ни с чем не совпадает. Либо исправьте фильтр, либо явно откажитесь от такого поведения:

```xml
<PropertyGroup>
  <TestingPlatformCommandLineArguments>
    $(TestingPlatformCommandLineArguments) --ignore-exit-code 8
  </TestingPlatformCommandLineArguments>
</PropertyGroup>
```

`--ignore-exit-code` принимает список через точку с запятой (`--ignore-exit-code 2;8`), а `TESTINGPLATFORM_EXITCODE_IGNORE` делает то же самое через окружение. Отдельно MTP 2.3.0 изменил случай, когда пропущены все тесты: запуск, в котором каждый тест пропущен, теперь по умолчанию считается успешным, а `--zero-tests-policy strict` возвращает поведение до 2.3.0.

**Смешанное решение это ошибка, а не предупреждение.** Как только `global.json` выбирает MTP, `dotnet test` ожидает, что каждый тестовый проект в графе является проектом MTP. Один отставший на VSTest роняет весь запуск. Сначала переводите листовые проекты, а `global.json` переключайте последним.

**Код выхода 5 означает отсутствующий пакет, а не опечатку.** Если половина проектов ссылается на `Microsoft.Testing.Extensions.HangDump`, а половина нет, `--hangdump` для одних допустима, а для других неизвестна, и запуск падает с 5. Используйте условные `TestingPlatformCommandLineArguments` по проектам из шага 6.

**xUnit игнорирует `--filter`.** MSTest и NUnit сохраняют под MTP синтаксис выражений VSTest (`FullyQualifiedName~UnitTest1|TestCategory=CategoryA`). xUnit v3 не реализует его вообще: нужны `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait` или `--filter-query` плюс их отрицательные варианты. Фильтр CI, который молча ни с чем не совпадает, затем срабатывает кодом выхода 8, и именно так это проявляется на практике. Тот же класс проблем с молчаливыми фильтрами стоит понимать, если вы заодно сравниваете [xUnit v3 с NUnit и MSTest](/ru/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).

**Цифры покрытия сдвинутся.** `IncludeTestAssembly` по умолчанию равен `false` в `Microsoft.Testing.Extensions.CodeCoverage`, а в VSTest был `true`. Ваш общий процент покрытия изменится на коммите миграции по причинам, не связанным с вашим кодом. Предупредите того, кто следит за порогом покрытия, до отправки изменений.

**Сгенерированная точка входа даёт две странные ошибки компиляции.** `Microsoft.Testing.Platform.MSBuild` помещает `TestingPlatformEntryPoint` и `SelfRegisteredExtensions` внутрь `$(RootNamespace)`, который по умолчанию равен имени проекта. Проект с именем `Contoso.Serialization.Tests`, который заодно ссылается на пакет `Contoso.Serialization`, может выдать `CS0118: 'Serialization' is a namespace but is used like a type`; задайте `<RootNamespace>Contoso.SerializationTests</RootNamespace>` или очистите его через `<RootNamespace />`. Отдельно нетестовый проект, ссылающийся на тестовый, упирается в `CS8892`, потому что сгенерированная точка входа конфликтует с его `Main`; задайте `<IsTestingPlatformApplication>false</IsTestingPlatformApplication>` в ссылающемся проекте или `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>` в тестовом.

**У странностей Test Explorer есть собственный переключатель.** Если обнаружение тестов ведёт себя некорректно в IDE, `<DisableTestingPlatformServerCapability>true</DisableTestingPlatformServerCapability>` отключает серверный режим MTP, и IDE возвращается к адаптеру VSTest. Это обходной путь, а не решение, и это другая проблема, нежели [зависание Test Explorer при проходящем `dotnet test`](/ru/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).

SDK .NET 11 делает момент удачным: `--timeout` и `--maximum-failed-tests` на уровне запуска, `--no-dependencies`, `--use-current-runtime`, шаблоны исключения с префиксом `!` для `--test-modules`, поддержка `Microsoft.Build.Traversal` и живое отображение выполняющихся тестов в интерактивных терминалах. Ничего из этого на пути VSTest нет.

## Связанные материалы

- [Миграция тестового проекта с xUnit v2 на xUnit v3](/ru/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/)
- [Microsoft.Testing.Platform 2.3 и аннотации GitHub Actions](/ru/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [xUnit v3 против NUnit и MSTest в 2026 году](/ru/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [VSTest отказывается от Newtonsoft.Json в .NET 11 Preview 4](/ru/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/)
- [Перевод решения .NET на Central Package Management](/ru/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## Источники

- [Руководство по миграции с VSTest на Microsoft.Testing.Platform (MTP)](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform) на MS Learn
- [Команда dotnet test с Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test-mtp), справочник CLI в режиме MTP
- [Справочник опций CLI Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-cli-options), включая таблицу опций расширений по сценариям
- [Устранение неполадок Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-troubleshooting) с полной таблицей кодов выхода
- [Параметры конфигурации Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-config) про `testconfig.json` и соответствие runsettings
- [Покрытие кода в Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-code-coverage) про опции расширения и таблицу совместимости версий
- [Enhance your CLI testing workflow with the new dotnet test](https://devblogs.microsoft.com/dotnet/dotnet-test-with-mtp/) в блоге .NET
- [Что нового в SDK и инструментах .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk) про улучшения тестирования в Preview 7
- [Поддержка Microsoft Testing Platform в xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)
