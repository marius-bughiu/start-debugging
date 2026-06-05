---
title: "Миграция Azure Functions с модели in-process на изолированный worker (.NET 8 / .NET 11)"
description: "Пошаговый чек-лист для перевода .NET-приложения Azure Functions с модели in-process на изолированный worker до прекращения поддержки 10 ноября 2026 года, с диффами csproj, переписыванием сигнатур и развёртыванием через обмен слотами."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
lang: "ru"
translationOf: "2026/06/migrate-from-in-process-azure-functions-to-isolated-worker"
translatedBy: "claude"
translationDate: 2026-06-05
---

Типичное in-process-приложение Azure Functions на .NET 8 переходит на изолированный worker примерно за один сосредоточенный день изменений кода плюс поэтапное окно релиза. То, что ломается, является механическим и предсказуемым: ссылка на SDK в вашем `.csproj`, ваш `Startup.cs`, каждый атрибут `[FunctionName]`, каждый пакет `Microsoft.Azure.WebJobs.Extensions.*` и любая функция, которая принимала параметр `ILogger`. Ничто из этого не сложно, но всё обязательно, потому что поддержка модели in-process прекращается **10 ноября 2026 года**, и после этой даты Azure перестаёт предоставлять in-process-приложениям обновления безопасности и функций. Это руководство представляет собой полный чек-лист: что менять, точный дифф для каждого изменения, как проверять каждый шаг и как развернуть смену среды выполнения через слот staging, чтобы продакшен никогда не увидел сломанное промежуточное состояние.

Это нацелено на хост Azure Functions v4 и описывает миграцию `dotnet`-приложения (in-process) на .NET 6 или .NET 8 LTS на модель изолированного worker `dotnet-isolated` на .NET 8 LTS (рекомендуемый быстрый путь) или .NET 11. Указанные версии пакетов являются последними стабильными по состоянию на июнь 2026 года: `Microsoft.Azure.Functions.Worker` 2.0.x, `Microsoft.Azure.Functions.Worker.Sdk` 2.0.x и семейство `Microsoft.Azure.Functions.Worker.Extensions.*`. Если ваше приложение всё ещё на хосте v1, v2 или v3, сначала выполните [обновление хоста с версии 3.x на 4.x](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-version-3-version-4); это руководство встраивает переход на изолированный worker в тот же проход.

Если вы всё ещё решаете, мигрировать ли вообще, сначала прочитайте [изолированный worker против in-process в .NET 11](/ru/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/). Этот пост исходит из того, что вы уже решили и хотите механический рецепт.

## Почему эта миграция не опциональна

- **Поддержка модели in-process прекращается 10 ноября 2026 года.** Это тот же день, когда .NET 8 LTS выходит из поддержки. После этой даты in-process-приложения продолжают работать, но не получают патчей безопасности и обновлений функций от Microsoft, и вы не можете развернуть новое in-process-приложение. Microsoft публикует [уведомление о прекращении поддержки](https://aka.ms/azure-functions-retirements/in-process-model) с начала 2024 года.
- **Изолированный worker открывает .NET 9, 10 и 11.** Хост in-process зафиксирован на .NET 8 и никогда не идёт дальше. В тот момент, когда вам нужны первичные конструкторы, ключевое слово `field`, тип `System.Threading.Lock`, выражения коллекций или Native AOT, вам нужен изолированный worker, где вы приносите собственную среду выполнения.
- **Вы получаете настоящий конвейер middleware и полное внедрение зависимостей.** Изолированный worker предоставляет `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()` и стандартный контейнер `Microsoft.Extensions.DependencyInjection` без ограничений на поверхность переопределения. Идентификаторы корреляции, обходы аутентификации для проб прогрева и валидация запросов становятся middleware вместо кода, скопированного в начало каждой функции.
- **Холодный старт может оказаться ниже, а не выше.** Изолированный worker с обычным JIT примерно на 150 мс медленнее на холодном старте, чем in-process, но Native AOT на изолированном worker стартует быстрее, чем in-process когда-либо стартовал. Если холодный старт был причиной, по которой вы остались на in-process, современный ответ - изолированный плюс AOT.

## Что ломается

| Область                    | Изменение                                                                                                | Серьёзность |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| Ссылка на SDK              | `Microsoft.NET.Sdk.Functions` удалён; заменить на `Microsoft.Azure.Functions.Worker` + `.Worker.Sdk`     | высокая  |
| Тип вывода                 | в `.csproj` нужен `<OutputType>Exe</OutputType>`; worker теперь настоящий консольный процесс              | высокая  |
| Startup                    | `FunctionsStartup` / `Startup.cs` заменён на `Program.cs` с `HostBuilder`                                 | высокая  |
| Атрибут функции            | `[FunctionName("X")]` становится `[Function("X")]`                                                       | высокая  |
| Пакеты привязок            | каждый `Microsoft.Azure.WebJobs.Extensions.*` меняется на `Microsoft.Azure.Functions.Worker.Extensions.*` | высокая  |
| Параметр `ILogger`         | внедряемый через метод `ILogger log` становится внедряемым через конструктор `ILogger<T>`                 | средняя  |
| Тип возврата HTTP          | `IActionResult` продолжает работать только если вы включаете интеграцию с ASP.NET Core; иначе `HttpResponseData` | средняя  |
| Привязки входа / выхода    | входные привязки получают суффикс `Input`, выходные - суффикс `Output`, выходы покидают список параметров | средняя  |
| `IBinder` / `IAsyncCollector<T>` | `IBinder` удалён; `IAsyncCollector<T>` становится возвратом `T[]` или внедрённым клиентом            | средняя  |
| `FUNCTIONS_WORKER_RUNTIME` | значение меняется с `dotnet` на `dotnet-isolated` локально и в настройках приложения в Azure              | высокая  |
| Фильтрация логов           | host.json больше не фильтрует логи вашего кода; фильтрация переходит в `Program.cs`                       | низкая   |

## Чек-лист подготовки

Прежде чем тронуть строку кода:

- Подтвердите, что приложение на **хосте v4**. Запустите `func --version` (Core Tools 4.x) и проверьте настройку версии среды выполнения Functions в портале. Если вы на v3 или раньше, сначала обновите хост.
- Установите **SDK .NET 8** (или SDK .NET 11, если вы целитесь на него) и **Azure Functions Core Tools v4** локально, чтобы запускать `func start` против мигрированного проекта.
- Проведите инвентаризацию ваших **пакетов триггеров и привязок**. Сделайте grep по `.csproj` на `Microsoft.Azure.WebJobs.Extensions` и запишите каждый; вам понадобится соответствующая замена `Microsoft.Azure.Functions.Worker.Extensions.*`.
- Проведите инвентаризацию функций, которые принимают **параметр метода `ILogger`**, и тех, которые используют **`IBinder` или `IAsyncCollector<T>`**. Они требуют ручных правок, которые инструменты обновления не могут полностью автоматизировать.
- Убедитесь, что у вас есть доступный **слот развёртывания staging**, или что вы можете его создать. Смена среды выполнения не должна происходить на месте в продакшене.
- Возьмите обычную страховочную сеть: чистую ветку, зелёную сборку и проходящий набор тестов на in-process-версии, чтобы иметь известную-хорошую базовую линию для сравнения.
- Опционально, но рекомендуется: установите **.NET Upgrade Assistant** (`dotnet tool install -g upgrade-assistant`). Он автоматизирует изменения `.csproj`, `Program.cs`, атрибутов и многих сигнатур; затем вы вручную исправляете привязки, которые он не смог вывести.

## Шаги миграции

Каждый шаг ниже - это отдельное изменение со строкой проверки. Выполняйте их по порядку; проект не соберётся чисто, пока не сделан последний, что ожидаемо.

1. **Преобразуйте SDK и пакеты `.csproj`.** Удалите ссылку на `Microsoft.NET.Sdk.Functions`, добавьте пакеты worker и добавьте `<OutputType>Exe</OutputType>`. До и после:

   ```xml
   <!-- BEFORE: in-process, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.NET.Sdk.Functions" Version="4.5.0" />
     </ItemGroup>
   </Project>
   ```

   ```xml
   <!-- AFTER: isolated worker, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
       <OutputType>Exe</OutputType>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
     </PropertyGroup>
     <ItemGroup>
       <FrameworkReference Include="Microsoft.AspNetCore.App" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Sdk" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Extensions.Http.AspNetCore" Version="2.0.0" />
       <PackageReference Include="Microsoft.ApplicationInsights.WorkerService" Version="2.23.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.ApplicationInsights" Version="2.0.0" />
     </ItemGroup>
   </Project>
   ```

   Чтобы вместо этого нацелиться на .NET 11, установите `<TargetFramework>net11.0</TargetFramework>`. `FrameworkReference` на `Microsoft.AspNetCore.App` - это то, что позволяет HTTP-триггерам продолжать возвращать `IActionResult`; сохраните его, даже если у вас нет HTTP-триггеров, потому что он улучшает запуск worker. **Проверка:** `dotnet restore` завершается успешно и подтягивает пакеты worker. Сборка всё ещё будет падать на коде, и это нормально.

2. **Замените каждый пакет расширения привязки.** Для каждого `Microsoft.Azure.WebJobs.Extensions.*`, который вы инвентаризировали, перейдите на эквивалент worker. Распространённые:

   ```text
   Microsoft.Azure.WebJobs.Extensions.Storage.Blobs
     -> Microsoft.Azure.Functions.Worker.Extensions.Storage.Blobs
   Microsoft.Azure.WebJobs.Extensions.ServiceBus
     -> Microsoft.Azure.Functions.Worker.Extensions.ServiceBus
   Microsoft.Azure.WebJobs.Extensions.CosmosDB
     -> Microsoft.Azure.Functions.Worker.Extensions.CosmosDB
   Microsoft.Azure.WebJobs.Extensions.EventHubs
     -> Microsoft.Azure.Functions.Worker.Extensions.EventHubs
   Microsoft.Azure.WebJobs.Extensions.DurableTask
     -> Microsoft.Azure.Functions.Worker.Extensions.DurableTask
   ```

   Триггер таймера требует явного добавления `Microsoft.Azure.Functions.Worker.Extensions.Timer`. Полностью удалите `Microsoft.Azure.Functions.Extensions`; изолированный worker предоставляет запуск DI нативно. **Проверка:** не остаётся ни одной ссылки на какой-либо пакет `Microsoft.Azure.WebJobs.*`. `dotnet list package | Select-String WebJobs` (PowerShell) не должен ничего выводить.

3. **Добавьте `Program.cs` и удалите `Startup.cs`.** Изолированный worker - это консольное приложение, и ему нужна точка входа. Перенесите всё из вашего `FunctionsStartup.Configure` в `ConfigureServices`:

   ```csharp
   // Program.cs -- .NET 8 / .NET 11, Microsoft.Azure.Functions.Worker 2.0.x
   using Microsoft.Azure.Functions.Worker;
   using Microsoft.Extensions.DependencyInjection;
   using Microsoft.Extensions.Hosting;

   var builder = FunctionsApplication.CreateBuilder(args);

   // ConfigureFunctionsWebApplication() opts into ASP.NET Core integration so HTTP
   // triggers can keep using HttpRequest / IActionResult. Use
   // ConfigureFunctionsWorkerDefaults() instead if you have no HTTP triggers.
   builder.ConfigureFunctionsWebApplication();

   builder.Services
       .AddApplicationInsightsTelemetryWorkerService()
       .ConfigureFunctionsApplicationInsights();

   // Everything that used to be in Startup.Configure goes here:
   builder.Services.AddHttpClient();
   builder.Services.AddSingleton<IOrderStore, OrderStore>();

   builder.Build().Run();
   ```

   Затем удалите класс, который нёс атрибут `[assembly: FunctionsStartup(typeof(Startup))]`. **Проверка:** файл компилируется изолированно, и нигде не остаётся атрибута `FunctionsStartup` (`Select-String FunctionsStartup -Path **/*.cs`).

4. **Переименуйте атрибуты функций.** `[FunctionName("X")]` становится `[Function("X")]`. Сигнатура идентична, так что это безопасная замена строк по всему проекту. **Проверка:** `Select-String "FunctionName" -Path **/*.cs` ничего не возвращает.

5. **Перенесите `ILogger` из параметра в конструктор.** In-process позволял принимать параметр `ILogger log` в методе функции. Изолированный worker использует внедрение через конструктор. Преобразуйте каждый затронутый класс функции в первичный конструктор:

   ```csharp
   // BEFORE (in-process)
   public static class HttpTriggerCSharp
   {
       [FunctionName("HttpTriggerCSharp")]
       public static IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req,
           ILogger log)
       {
           log.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   ```csharp
   // AFTER (isolated worker, .NET 8 / .NET 11, C# 12+ primary constructor)
   public class HttpTriggerCSharp(ILogger<HttpTriggerCSharp> logger)
   {
       [Function("HttpTriggerCSharp")]
       public IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req)
       {
           logger.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   Обратите внимание, что функция больше не `static`, класс больше не `static`, и `ILogger` покинул сигнатуру метода. **Проверка:** класс функции компилируется, и ни один метод функции больше не имеет параметра `ILogger`.

6. **Исправьте usings и имена атрибутов триггеров и привязок.** Удалите `using Microsoft.Azure.WebJobs;`, добавьте `using Microsoft.Azure.Functions.Worker;`. Триггеры обычно сохраняют своё имя (`QueueTrigger` остаётся `QueueTrigger`), входные привязки получают суффикс `Input` (`CosmosDB` становится `CosmosDBInput`), а выходные привязки получают суффикс `Output` (`Queue` становится `QueueOutput`, `Blob` становится `BlobOutput`). Выходные привязки также покидают список параметров: один выход идёт на тип возврата, а несколько выходов - на свойства небольшого класса результата. Замените `IAsyncCollector<T>` на возврат `T[]` и удалите любой параметр `IBinder` в пользу внедрённого клиента. **Проверка:** `dotnet build` теперь завершается успешно с нулём ошибок.

7. **Обновите `local.settings.json`.** Измените значение среды выполнения worker:

   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "FUNCTIONS_WORKER_RUNTIME": "dotnet-isolated"
     }
   }
   ```

   Изменений в `host.json` не требуется. **Проверка:** `func start` запускает приложение локально, и ваши функции появляются в баннере запуска со своими маршрутами.

## Проверка

После того как сборка стала зелёной, запустите этот дымовой тест, прежде чем приближаться к Azure:

- `dotnet build` возвращает ноль ошибок и ноль ссылок на `Microsoft.Azure.WebJobs.*`.
- `func start` запускается и перечисляет каждую функцию с правильным триггером и маршрутом.
- Обратитесь к каждому HTTP-триггеру локально (`curl` или ваш тестовый клиент) и подтвердите тот же код состояния и тело, которое возвращала in-process-версия.
- Запустите каждый не-HTTP-триггер: положите blob, поставьте сообщение в очередь, дайте таймеру сработать. Подтвердите, что функция выполняется и записывает свои выходы.
- `dotnet test` проходит. Обратите особое внимание на тесты, которые проверяли вывод логов или поведение сериализатора, поскольку оба могут сместиться (см. подводные камни).
- Сравните захваченную трассировку Application Insights до и после. Подтвердите, что ваши категории логов всё ещё появляются на ожидаемых уровнях; если они исчезли, в вашем `Program.cs` отсутствует фильтрация логов.

## Развёртывание в Azure и откат

Сторона Azure - это два изменения, которые должны произойти вместе: установить `FUNCTIONS_WORKER_RUNTIME` в `dotnet-isolated` и развернуть изолированную полезную нагрузку. Если приземляется только одно, приложение оказывается в состоянии ошибки, потому что развёрнутый код не соответствует настроенной среде выполнения. Никогда не делайте это на месте в продакшене. Вместо этого:

1. Создайте или повторно используйте **слот развёртывания staging**.
2. На слоте staging установите настройку приложения `FUNCTIONS_WORKER_RUNTIME` в `dotnet-isolated`. **Не** помечайте её как настройку слота. Если вы также изменили версию .NET, обновите конфигурацию стека на слоте тоже.
3. Опубликуйте мигрированный проект в слот staging. Вы увидите временные ошибки в логах слота во время промежуточного состояния; дождитесь, пока они прекратятся.
4. Проведите дымовой тест слота staging против реальных зависимостей Azure. Подтвердите, что ошибки прекратились и поведение соответствует продакшену.
5. **Поменяйте местами** (swap) слот staging в продакшен. Swap происходит как одно атомарное обновление, поэтому продакшен никогда не видит сломанное промежуточное состояние.
6. Подтвердите, что продакшен здоров.

**Откат:** это полностью обратимо, пока вы сохраняете in-process-сборку. Чтобы откатиться, поменяйте слоты обратно: предыдущая продакшен-нагрузка (всё ещё in-process) возвращается в продакшен-слот одной операцией. Поскольку swap атомарен, откат - это тот же шаг в один клик, что и развёртывание. Сохраняйте in-process-ветку и её последний хороший артефакт, пока новая модель не отработает под реальным трафиком хотя бы несколько дней. Миграция становится односторонней только в тот момент, когда вы удаляете этот in-process-артефакт, так что не удаляйте его в первый день.

## Подводные камни, на которые мы наткнулись

**Логи молча исчезают из Application Insights.** В модели in-process `host.json` управлял фильтрацией логов для всего, включая ваш код. В изолированном worker `host.json` фильтрует только среду выполнения хоста Functions; логи вашего приложения фильтруются конфигурацией логирования в `Program.cs`. Если вы мигрируете и ваши логи `Information` исчезают, добавьте явную фильтрацию в `Program.cs` вместо того, чтобы ожидать, что `host.json` их покроет.

**HTTP-ответы меняют форму, если вы полагались на Newtonsoft.** In-process HTTP-триггеры, возвращавшие `IActionResult`, сериализовались через MVC-форматтеры хоста, которые многие приложения настроили с резолвером контрактов Newtonsoft. Изолированный worker по умолчанию использует `System.Text.Json`. Если ваш JSON внезапно использует другой регистр или теряет пользовательский конвертер, зарегистрируйте свой сериализатор на worker. Если вы взвешиваете, сохранять ли Newtonsoft вообще, прочитайте [System.Text.Json против Newtonsoft.Json в 2026](/ru/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

**Оркестраторы Durable Functions, которые внедряли сервисы, начинают недетерминированно воспроизводиться.** DI хоста in-process был достаточно снисходителен, что вызов сервиса с областью экземпляра внутри оркестратора иногда работал случайно. На изолированном worker тот же код может привести к взаимной блокировке или недетерминированно воспроизводиться. Исправление - это стандартное правило Durable, которое модель in-process позволяла нарушать: оркестраторы вызывают только функции активности, а побочные эффекты живут в активностях, а не во внедрённых сервисах.

**Приложение становится красным в Azure во время деплоя, и это нормально.** В первый раз, когда вы пушите изолированную нагрузку в слот, чей `FUNCTIONS_WORKER_RUNTIME` всё ещё `dotnet` (или наоборот), слот сообщает о состоянии ошибки. Это то промежуточное несоответствие, о котором предупреждает документация. Именно поэтому развёртывание идёт через слот staging, и оно проясняется, как только и настройка, и нагрузка совпадают.

**Выходные привязки в списке параметров не скомпилируются.** Самая распространённая ошибка сборки после смены пакетов - это выходная привязка, всё ещё сидящая как параметр `out` или `IAsyncCollector<T>`. Перенесите её на тип возврата (один выход) или класс результата (несколько выходов). Ошибка компилятора указывает на параметр, но исправление структурное, а не приведение типа.

## Связанное

- [Azure Functions изолированный worker против in-process в .NET 11](/ru/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/) - это ориентированный-на-решение спутник этого чек-листа, с полной матрицей функций и бенчмарком холодного старта.
- [Миграция с .NET 8 на .NET 11: полный чек-лист](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) - это естественный следующий шаг, как только вы на изолированном worker и хотите двигать среду выполнения вперёд.
- [Как использовать Native AOT с минимальными API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) охватывает настройки публикации и предупреждения trim, с которыми вы столкнётесь, когда включите AOT для мигрированного worker.
- [Native AOT против ReadyToRun против чистого JIT](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) содержит цифры за утверждением «изолированный плюс AOT обгоняет in-process на холодном старте».
- [Как сократить время холодного старта для .NET 11 AWS Lambda](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) делится большей частью советов по холодному старту с AOT, если вы также запускаете функции вне Azure.

## Источники

- Microsoft Learn, [Миграция C#-приложений с модели in-process на модель изолированного worker](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-dotnet-to-isolated-model).
- Microsoft Learn, [Различия между моделью in-process и моделью изолированного worker](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences).
- Microsoft Learn, [Руководство по запуску C#-Azure-Functions в изолированном worker-процессе](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide).
- Azure updates, [Поддержка модели in-process заканчивается 10 ноября 2026 года](https://aka.ms/azure-functions-retirements/in-process-model).
- Microsoft Learn, [Миграция Durable Functions с in-process на модель изолированного worker](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-migrate).
- `Microsoft.Azure.Functions.Worker` на [NuGet](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker).
