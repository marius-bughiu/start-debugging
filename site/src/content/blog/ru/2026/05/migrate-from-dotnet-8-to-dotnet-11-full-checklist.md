---
title: "Миграция с .NET 8 на .NET 11: полный чек-лист"
description: "Чек-лист миграции с зафиксированными версиями: с .NET 8 LTS на .NET 11 LTS. Установка SDK, target framework в csproj, breaking changes в ASP.NET Core, EF Core, System.Text.Json и сдвиг разрешения перегрузок в C# 14, с заметками по откату."
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
lang: "ru"
translationOf: "2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist"
translatedBy: "claude"
translationDate: 2026-05-28
---

Пропустить сразу два LTS-цикла - это самое дешёвое обновление .NET, которое большинство команд сделает в этом десятилетии. Стандартная поддержка .NET 8 заканчивается в ноябре 2026, .NET 11 - текущий LTS, а путь между ними проходит через три набора breaking changes (.NET 9, 10, 11) плюс три версии языка C# (C# 13, 14, при том что C# 12 уже поставлен в 8). Для небольшого сервиса обычно хватает выходных сосредоточенной работы. Средний монолит с EF Core, кастомным middleware и парой source generators обычно стоит от трёх до пяти дней. Кодовые базы, которые держат `BinaryFormatter`, опираются на шимы `System.Web.HttpContext` или запускают in-process Azure Functions, стоят больше, и эта боль проявляется первой.

Этот пост использует `net8.0` как источник и `net11.0` как цель. Каждый блок кода явно фиксирует версии, чтобы шаги оставались воспроизводимыми после нескольких patch-релизов.

## Зачем мигрировать сейчас

- Стандартная поддержка .NET 8 заканчивается 2026-11-10. После этой даты ни security-патчей, ни servicing. Продакшн-код на 8 становится audit-уязвимым за три недели до Black Friday.
- .NET 11 бесплатно даёт ощутимые выигрыши runtime: динамический PGO включён по умолчанию, новый tiered JIT обрабатывает `async`-машины состояний без исторического штрафа, а Native AOT теперь поддерживает minimal APIs в ASP.NET Core и большую часть пути чтения EF Core.
- Тип `System.Threading.Lock`, появившийся в .NET 9, убирает целый класс ловушек повторного входа в monitor. Пропустив миграцию, вы оставляете на столе старый паттерн `lock(object)`.
- C# 14 приносит стабильное ключевое слово `field` в свойствах и `partial`-конструкторы. Полезно, но не повод для миграции; относитесь к этому как к бонусу.

## Что ломается

| Область                  | Изменение                                                                          | Серьёзность |
| ------------------------ | ----------------------------------------------------------------------------------- | ----------- |
| `lock(object)`           | Новый тип `System.Threading.Lock` меняет семантику monitor при переходе             | низкая      |
| `BinaryFormatter`        | Полностью удалён в .NET 9. Нет opt-in переключателя                                 | высокая     |
| `System.Text.Json`       | `JsonNumberHandling` по умолчанию для round-trip `JsonObject` изменился в .NET 10  | средняя     |
| Pipeline запросов EF Core | Трансляция primitive-коллекций изменилась в EF Core 10; часть LINQ теперь бросает  | высокая     |
| Middleware ASP.NET Core  | Сигнатуры перегрузок `UseExceptionHandler` сдвинулись в .NET 10                     | низкая      |
| Trim-предупреждения Native AOT | Несколько путей `System.Reflection.Emit` теперь выдают `IL2026`-предупреждения | средняя     |
| Разрешение перегрузок C# 14 | Перегрузки со Span теперь побеждают перегрузки с массивами в неоднозначных случаях | средняя |
| `IWebHostBuilder`        | Уже deprecated в 8, удалён в 11. Переходите на `WebApplication.CreateBuilder`       | высокая     |
| Инструмент `dotnet ef`   | Требуется major-bump (`dotnet tool update --global dotnet-ef --version 11.*`)       | низкая      |
| Azure Functions          | In-process модель удалена; isolated worker обязателен                              | высокая     |

Полный официальный список живёт в [документации breaking changes .NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0). Прочитайте от начала до конца, прежде чем трогать любой `.csproj`.

## Чек-лист перед взлётом

Запустите это перед изменением любого target framework.

1. Установите .NET 11 SDK на каждую dev-машину и CI-runner. Проверьте через `dotnet --list-sdks` и убедитесь, что `11.0.x` появляется. SDK устанавливается рядом, поэтому .NET 8 продолжает работать.
2. Зафиксируйте SDK в `global.json`, чтобы CI не катился вперёд молча:
   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```
3. Зафиксируйте baseline: запустите `dotnet test` на .NET 8 и сохраните результаты. Чистый зелёный до старта нужен, чтобы первый красный после апгрейда был однозначным.
4. Снимок продакшн-runtime: сделайте дамп `dotnet --info` с живого хоста. Если что-то линкуется против runtime старше 8.0.0 (старая self-contained публикация, сторонний плагин), найдите это сейчас.
5. Инвентаризируйте NuGet-пакеты через `dotnet list package --outdated --include-transitive`. Всё, что пинит `Microsoft.*` к `8.0.x`, потребует major-bump; всё, что пинится к `7.*` или старше - красный флаг.
6. Заведите ветку для миграции. Один PR на один логический шаг отзывается легче, чем один гигантский green-light PR.

## Шаги миграции

1. **Поднимите target framework.** Откройте каждый `.csproj` и измените значение `TargetFramework` (или `TargetFrameworks`). Проверьте через `dotnet build` и относитесь к первой волне compile-ошибок как к настоящему объёму миграции.

   ```xml
   <!-- src/MyApi.csproj, .NET 11 -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
   </Project>
   ```

   Проверка: `dotnet build` завершается с 0 хотя бы для leaf-проектов или падает с ошибками, которые вы узнаёте.

2. **Обновите все `Microsoft.*` NuGet-пакеты до линии 11.x.** Делайте это одним пакетом через `dotnet add package` по проекту, не правя `Directory.Packages.props` вслепую. Runtime, ASP.NET Core, EF Core и `Microsoft.Extensions.*` версионируются в lockstep с SDK.

   ```bash
   # .NET 11
   dotnet add package Microsoft.AspNetCore.OpenApi --version 11.0.0
   dotnet add package Microsoft.EntityFrameworkCore.SqlServer --version 11.0.0
   dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
   ```

   Проверка: `dotnet restore` успешен, а `dotnet list package` не показывает `8.0.x` под namespace `Microsoft.*`.

3. **Уберите использование `BinaryFormatter`.** Если кодовая база что-то сериализует через `BinaryFormatter`, заменяйте сейчас. `System.Text.Json`, MessagePack или `protobuf-net` - обычные замены, в зависимости от того, нужен ли JSON wire-формат или бинарный. В .NET 9 и старше нет флага совместимости; тип ушёл.

   Проверка: `grep -r "BinaryFormatter" src/` ничего не возвращает. Если нужно читать унаследованные `BinaryFormatter`-блобы из хранилища, напишите одноразовый .NET 8 миграционный инструмент для конвертации, прежде чем гасить .NET 8 окружение.

4. **Замените `IWebHostBuilder` на `WebApplication.CreateBuilder`.** Старый шим generic-host был deprecated в .NET 6 и удалён в .NET 11. Любой `Program.cs`, который ещё вызывает `Host.CreateDefaultBuilder().ConfigureWebHostDefaults(...)`, не скомпилируется.

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.MapOpenApi();
   app.MapControllers();
   app.Run();
   ```

   Проверка: приложение стартует под `dotnet run`, а endpoint `/openapi/v1.json` отвечает HTTP 200.

5. **Проаудируйте `System.Text.Json` на предмет поведенческих изменений.** Обработка по умолчанию round-trip чисел в `JsonObject` изменилась в .NET 10 так, что целые больше не теряют точность при ре-сериализации, а полиморфный десериализатор по умолчанию строже относится к неизвестным дискриминаторам. Если поддерживаете публичный API-контракт, прогоните contract-тесты и внимательно прочитайте падения. Часто контракт не менялся, но прежде молчаливое несоответствие теперь бросает. Сопутствующий пост о [фиксе "JSON value could not be converted to System.DateTime"](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) покрывает самый частый случай отказа конвертации.

   Проверка: `dotnet test` завершается чисто для любого проекта, который тренирует сериализацию против fixture-JSON.

6. **Мигрируйте запросы EF Core, использующие primitive-коллекции.** EF Core 10 переписал трансляцию `List<int>.Contains(x)` так, что параметризованные коллекции дают один SQL-параметр вместо разворачивания в `IN`-предложение. Это починило раздувание plan-cache, но сломало небольшой набор запросов, которые комбинировали `Contains` с другими выражениями, выполняемыми на сервере. Прогоните все EF Core integration-тесты заново и проинспектируйте любой запрос, который теперь бросает `InvalidOperationException: The LINQ expression ... could not be translated`. Аварийный выход - материализовать коллекцию через `.ToList()` до join.

   Проверка: каждый integration-тест, тренирующий сырой LINQ над `DbSet<T>`, проходит; проверьте выборочно сгенерированный SQL через `LogTo(Console.WriteLine, LogLevel.Information)` на репрезентативном запросе.

7. **Внедряйте `System.Threading.Lock` выборочно, не пакетной заменой.** Замена `private readonly object _gate = new();` на `private readonly System.Threading.Lock _gate = new();` корректна в большинстве случаев, но меняет, наблюдаемо ли повторное вхождение из того же потока. Сначала пройдитесь по путям кода. Более глубокое сравнение компромиссов - в [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/ru/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/).

   Проверка: код-ревью явно покрывает каждое место `lock(...)`, которое было изменено; никаких функциональных изменений в тестовом наборе.

8. **Перезапустите trim- и AOT-анализаторы.** Если проект ставит `<PublishAot>true</PublishAot>` или `<TrimMode>full</TrimMode>`, .NET 11 выдаёт новые предупреждения вокруг путей `System.Reflection.Emit`, которые были тихими под .NET 8. Фикс обычно - добавить аннотации `[DynamicallyAccessedMembers]` или зарегистрировать JSON source generator. [Сравнение Native AOT vs ReadyToRun vs JIT](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) описывает, когда каждая модель окупает свою цену.

   Проверка: `dotnet publish -c Release` выдаёт ноль предупреждений `IL2026` или `IL3050` на leaf-проекте; получившийся native-бинарь стартует локально.

9. **Скорректируйте сюрпризы разрешения перегрузок C# 14.** C# 14 изменил правила разрешения так, что перегрузки, принимающие `ReadOnlySpan<T>`, предпочтительнее принимающих `T[]`, когда обе применимы. Большинство кода не задето. Ломаются обычно моки, fluent-assertion библиотеки и кастомные extension-методы, написанные в предположении, что выиграет перегрузка с массивом. Компилятор выдаёт чёткий диагноз; фикс обычно - cast. [C# 14 breaking change разрешения перегрузок со span](/ru/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) проводит через диагноз и паттерн каста.

   Проверка: `dotnet build` без предупреждений при `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`.

10. **Обновите образы CI-runner.** Поднимите `dotnet-version` в `actions/setup-dotnet` GitHub Actions до `11.0.x`, обновите любой Dockerfile base image до `mcr.microsoft.com/dotnet/sdk:11.0` и `mcr.microsoft.com/dotnet/aspnet:11.0`, и снимите пины на образ SDK .NET 8. Self-hosted runner-ы требуют ручной установки SDK, прежде чем CI пройдёт.

    Проверка: прогон pipeline на feature-ветке зелёный от и до, включая шаг publish.

## Проверка (smoke-чек-лист)

После шагов выше приложение должно пройти каждую строку этого списка прежде, чем PR миграции замержат:

- `dotnet --list-sdks` показывает 11.0.x как версию, которую реально использует сборка (`dotnet --version` из корня репозитория печатает `11.0.x`).
- `dotnet restore && dotnet build -c Release` завершается с 0 и нулём предупреждений.
- `dotnet test -c Release` зелёный, а количество тестов совпадает с .NET 8 baseline.
- `dotnet publish -c Release` производит артефакт, который стартует локально и обслуживает `/health`.
- Один репрезентативный путь чтения и один репрезентативный путь записи тренируются против staging-окружения; latency p50/p95 в пределах 10 процентов от .NET 8 baseline.
- Логи не показывают first-chance ссылок на `BinaryFormatter`, `IWebHostBuilder` или `IL2026`.

Если что-то из этого падает, остановитесь. Не мержите частично мигрированную кодовую базу.

## Откат

Эта миграция обратима до первого продакшн-деплоя, который примет запись под .NET 11. До этого момента откатите `global.json`, `TargetFramework` и NuGet-bump-ы одним коммитом. После первой продакшн-записи под .NET 11 откат технически возможен, но редко стоит того: изменения схемы, которые могли произойти под транслятором EF Core 11, JSON-выходы, сериализованные под новыми дефолтами, и любое внедрение `System.Threading.Lock` требуют отдельного рассуждения. Планируйте чинить вперёд.

## Ловушки, которые поймали мы

- **NuGet-пакет, нацеленный только на `net8.0`, не обязательно сломан на net11.0**, но молча подгрузит фасад .NET Standard 2.0, если пакет его экспонирует. Это иногда тянет назад старые `System.*` зависимости. После bump-а `dotnet list package --include-transitive` не опциональна.
- **Версии `Microsoft.Data.SqlClient` важны.** EF Core 11 хочет `Microsoft.Data.SqlClient` 7.x или новее. Старый транзитивный пин скомпилируется, а затем упадёт в runtime на согласовании TLS 1.3 с более новыми SQL Server.
- **Source generator-ы, построенные на Roslyn 4.6, выдают предупреждения на Roslyn, который идёт с .NET 11.** Большинство решается поднятием ссылки `Microsoft.CodeAnalysis.CSharp` в генераторе. Если выпускаете собственный генератор, делайте это отдельным PR.
- **In-process Azure Functions ушли.** Если один function-проект ещё использует in-process модель на .NET 8, .NET 11 его не запустит. Сначала переходите на isolated-worker модель, потом bumpайте.
- **Семантика отмены `HttpClient` на .NET 11** корректно бросает `TaskCanceledException`, чей `CancellationToken` совпадает с переданным token-ом, тогда как раньше некоторые пути бросали с `CancellationToken.None`. Catch-блоки, которые pattern-match на token, потребуют небольшой правки; обоснование - в обсуждении [async void vs async Task в C#](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Связанное

- [ConfigureAwait(false) vs значение по умолчанию в .NET 11](/ru/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Native AOT vs ReadyToRun vs JIT в .NET 11](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [EF Core 11 vs Dapper для массовых вставок: реальный benchmark](/ru/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/ru/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)
- [Minimal APIs vs контроллеры в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Источники

- [Breaking changes .NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [График релизов и политика поддержки .NET](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)
- [Breaking changes EF Core 10 и 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [Языковая референс C# 14](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
- [API-референс `System.Threading.Lock`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock)
