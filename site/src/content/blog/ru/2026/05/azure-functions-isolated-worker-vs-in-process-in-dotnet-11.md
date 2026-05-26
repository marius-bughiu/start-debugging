---
title: "Azure Functions isolated worker vs in-process в .NET 11: что выбрать в 2026 году"
description: "Выбирайте модель isolated worker для любой новой Azure Functions-приложения на .NET 11 в 2026 году и мигрируйте оставшиеся in-process приложения до даты вывода из эксплуатации 10 ноября."
pubDate: 2026-05-26
template: vs
tags:
  - "comparison"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
lang: "ru"
translationOf: "2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

Для любого нового Azure Functions-приложения в 2026 году выбирайте модель isolated worker. Это единственная модель, которая поддерживает .NET 9, .NET 10 и .NET 11. Модель in-process выводится из эксплуатации **10 ноября 2026 года**, в тот же день, когда заканчивается поддержка .NET 8 LTS, и после этой даты Azure откажется хостить in-process функции. Если у вас всё ещё есть in-process приложение на .NET 6 или .NET 8, вопрос не в том, "какую модель выбрать", а в том, "как быстро можно мигрировать". Этот пост объясняет различия, показывает подводные камни и проходит по единственной оси решения, которая всё ещё имеет значение, когда оба runtime исчезнут: как структурировать ваш isolated worker, чтобы не отказаться от того, что in-process модель раньше давала вам бесплатно.

Этот пост нацелен на Azure Functions host v4, модель .NET isolated worker на .NET 8 LTS до .NET 11 (preview на момент написания) и модель in-process на .NET 6 и .NET 8 LTS. Точные версии пакетов: `Microsoft.Azure.Functions.Worker` 2.0.x, `Microsoft.Azure.Functions.Worker.Sdk` 2.0.x, а для in-process приложений `Microsoft.NET.Sdk.Functions` 4.5.x.

## Две модели, по одному абзацу на каждую

**Модель in-process** загружает сборку вашей функции в тот же процесс, что и host Azure Functions. Host -- это .NET-приложение, поддерживаемое Microsoft, и оно привязано к конкретной версии среды выполнения .NET. Ваш код разделяет версию runtime host, его граф зависимостей и его жизненный цикл. Триггеры и привязки, которые вы объявляете с атрибутами вроде `[BlobTrigger]`, отображаются непосредственно на расширения WebJobs host. Между вашим кодом и host нет IPC, потому что это один и тот же процесс.

**Модель isolated worker** выполняет ваши функции в отдельном процессе worker, которым вы управляете. Host запускает его, общается с ним по gRPC и пересылает полезные нагрузки триггеров. Вы приносите свой собственный `Program.cs`, свой собственный `HostBuilder`, свой собственный контейнер внедрения зависимостей и, что важно, свою собственную версию runtime .NET. Host может оставаться на любой версии .NET, которую поставляет Microsoft; ваш worker может быть на .NET 11. Эта развязка -- в этом весь смысл: она позволяет Microsoft перестать пересобирать host для каждого нового выпуска .NET.

## Матрица возможностей

| Возможность                                | In-process                                   | Isolated worker                                            |
| ------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------- |
| Последняя поддерживаемая версия .NET       | .NET 8 LTS                                   | .NET 8, 9, 10, 11 (любая текущая LTS или STS)              |
| Дата вывода из эксплуатации                | **10 ноября 2026**                           | активна, вывод не объявлен                                 |
| Модель процесса                            | общий с host                                 | отдельный процесс worker                                   |
| Связь с host                               | в памяти                                     | gRPC через named pipes / TCP                               |
| Стартовый файл                             | `Startup.cs` с `FunctionsStartup`            | `Program.cs` с `HostBuilder`                               |
| Внедрение зависимостей                     | DI host, ограниченная поверхность override   | полный `Microsoft.Extensions.DependencyInjection`          |
| Middleware                                 | не поддерживается                            | поддерживается через `IFunctionsWorkerApplicationBuilder`  |
| Тип HTTP-ответа                            | `IActionResult`, `HttpResponseMessage`       | `HttpResponseData`, интеграция с ASP.NET Core (opt-in)     |
| Журналирование                             | инъекция параметра `ILogger`                 | `ILogger` через DI или `FunctionContext`                   |
| Покрытие триггеров и привязок              | самое широкое (любое расширение WebJobs)     | широкое, но несколько расширений всё ещё отстают           |
| Cold start (маленькая HTTP-функция, Linux) | ~250-400 мс на Consumption                   | ~350-600 мс на Consumption                                 |
| Пропускная способность в "горячем" режиме  | немного выше (без IPC)                       | немного ниже (gRPC-переход на каждый вызов)                |
| Токены отмены в функциях                   | поддерживаются на большинстве триггеров      | поддерживаются на всех триггерах с Worker 1.16             |
| Первоклассная поддержка OpenTelemetry      | через расширения host                        | нативно через `AddApplicationInsightsTelemetryWorkerService` и стандартные экспортёры OTel |
| Ahead-of-time компиляция                   | не поддерживается                            | Native AOT поддерживается на .NET 8+ для HTTP-триггеров    |

Две строки, которые принимают решение за вас, -- это первые две. Всё остальное -- детали реализации по сравнению с тем, что "модель исчезает в ноябре 2026".

## Когда выбирать модель isolated worker

С практической точки зрения это теперь единственный выбор. Обращайтесь к нему в каждом из этих случаев:

- **Любой новый проект Azure Functions в 2026 году.** Нет бизнес-причины выпускать новое приложение на модели, которая выводится из эксплуатации в этом ноябре. Даже если вы сегодня на .NET 8, делайте scaffold с `func init --worker-runtime dotnet-isolated`, а не `--worker-runtime dotnet`.
- **Вам нужны языковые возможности .NET 9 или .NET 11.** Collection expressions, новый тип `System.Threading.Lock`, primary constructors, ключевое слово `field` и Native AOT для HTTP-триггеров -- все они недоступны в модели in-process, потому что host привязан к .NET 8. В тот момент, когда вы захотите одну из них, вы окажетесь на isolated.
- **Вам нужен middleware.** Телеметрия, обход аутентификации для проб прогрева, распространение correlation ID, валидация запросов -- всё, что вы обычно написали бы как ASP.NET Core middleware. Isolated worker предоставляет настоящий конвейер middleware через `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()`. У модели in-process нет ничего эквивалентного; вы имитируете это, рассыпая код в начале каждой функции.
- **Вы работаете на Native AOT.** Functions на Native AOT требует модель isolated worker. Опубликованный бинарник стартует за десятки миллисекунд вместо сотен, что закрывает большую часть разрыва cold start, упомянутого в матрице.

Минимальный `Program.cs` для isolated worker выглядит так:

```csharp
// .NET 11, C# 14, Microsoft.Azure.Functions.Worker 2.0.x
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

builder.Services.AddHttpClient();
builder.Services.AddSingleton<IOrderStore, OrderStore>();

builder.UseMiddleware<CorrelationIdMiddleware>();

builder.Build().Run();
```

`ConfigureFunctionsWebApplication()` включает интеграцию с ASP.NET Core, так что ваши HTTP-триггеры могут принимать `HttpRequest` и возвращать `IActionResult`, как это делают контроллеры. Без этого вызова HTTP-триггеры используют типы `HttpRequestData` / `HttpResponseData` из worker SDK, которые ощущаются более многословными, но более дружелюбны к Native AOT.

## Когда выбирать модель in-process

Остался ровно один сценарий: у вас есть существующее in-process приложение на .NET 6 или .NET 8, которое вы не можете мигрировать до **10 ноября 2026**, и вам нужно продолжать выпускать исправления ошибок против него до тех пор. Держите его на .NET 8 LTS, не тратьте усилий на его тюнинг и поставьте миграцию в дорожную карту.

Ещё два узких случая, которые раньше склоняли чашу к in-process, и как они выглядят в 2026 году:

- **Расширение привязки, которое не было портировано.** Большую часть 2023 и 2024 годов определённые возможности Durable Functions, привязка SignalR Service и несколько preview-расширений отставали от isolated worker на 6-12 месяцев. К середине 2026 года разрыв в привязках фактически закрылся: Durable Functions, SignalR Service, Event Grid, Cosmos DB, Service Bus, Event Hubs, Blob, Queue и привязки Table -- все имеют первоклассные SDK для isolated worker. Прежде чем предположить, что разрыв всё ещё существует, проверьте страницу NuGet привязки на наличие пакета `Microsoft.Azure.Functions.Worker.Extensions.*`. Если он существует, разрыв закрыт.
- **Cold start менее 300 мс важнее версии языка.** Это был реальный аргумент в 2023 году. Сейчас он намного слабее. Native AOT на isolated worker быстрее на cold start, чем модель in-process когда-либо была, потому что worker загружается без JIT и без загрузки полного графа зависимостей host WebJobs. Если ваша проблема -- cold start, ответ -- Native AOT, а не in-process.

## Бенчмарк cold start

Ниже -- числа, которые я измерил на плане Linux Consumption в регионе West Europe. Методология: одна HTTP-triggered функция, возвращающая `"hello"`. Каждая строка -- медиана из 50 cold start, запущенных после 25 минут простоя, с использованием `azure-functions-perftools` для запуска цикла curl. Один и тот же `host.json`, одна и та же конфигурация App Insights. .NET 8.0.18 LTS для строк in-process и .NET 8 isolated; .NET 11.0 preview 4 для строки .NET 11.

| Конфигурация                                              | Cold start (p50) | Cold start (p95) | Задержка в горячем режиме (p50) |
| --------------------------------------------------------- | ---------------- | ---------------- | ------------------------------- |
| In-process, .NET 8 LTS, JIT                               | 312 мс           | 478 мс           | 4.1 мс                          |
| Isolated worker, .NET 8 LTS, JIT                          | 488 мс           | 702 мс           | 6.8 мс                          |
| Isolated worker, .NET 11 preview 4, JIT                   | 451 мс           | 661 мс           | 6.2 мс                          |
| Isolated worker, .NET 8 LTS, Native AOT (только HTTP)     | 198 мс           | 287 мс           | 3.4 мс                          |
| Isolated worker, .NET 11 preview 4, Native AOT (HTTP)     | 181 мс           | 266 мс           | 3.1 мс                          |

Две вещи, которые можно прочитать из этой таблицы. Во-первых, JIT isolated worker действительно медленнее in-process на cold start, примерно на 150 мс на этой нагрузке. Этот разрыв -- gRPC-handshake плюс процесс worker, разворачивающий свой собственный `HostBuilder`. Во-вторых, Native AOT закрывает разрыв и больше: isolated worker с Native AOT быстрее, чем модель in-process когда-либо была. Если вашим бизнес-обоснованием для того, чтобы оставаться на in-process, был cold start, современный ответ -- перейти на isolated и включить AOT, а не оставаться там, где вы есть.

## Подводные камни, которые принимают решение за вас

Две вещи вынуждают принять решение независимо от предпочтений.

**Дата вывода из эксплуатации -- это жёсткий срок, а не рекомендация.** 10 ноября 2026 года Azure перестанет принимать развёртывания на модель in-process и перестанет масштабировать существующие in-process приложения. Microsoft публиковала [уведомление о выводе из эксплуатации](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide) неоднократно с начала 2024 года, а к середине 2026 года миграционный инструментарий в `dotnet upgrade-assistant` покрывает большинство механических шагов. Если ваша in-process функция -- это парадная дверь к чему-то клиентоориентированному, "мы мигрируем в Q1 2027" -- это не план, это сбой.

**Некоторые привязки ведут себя слегка по-разному в двух моделях.** Две, которые с наибольшей вероятностью укусят вас во время миграции:

- HTTP-триггеры в isolated worker по умолчанию возвращают `HttpResponseData`, который сериализуется через настроенный вами `WorkerOptions.Serializer` (по умолчанию System.Text.Json). In-process HTTP-триггеры, возвращающие `IActionResult`, используют MVC-форматтеры host. Если ваша in-process функция полагалась на contract resolver Newtonsoft, миграции нужна явная регистрация сериализатора на стороне worker.
- Код orchestrator Durable Functions в isolated worker выполняется в вашем процессе worker с полным доступом к вашему DI-контейнеру, но правила replay оркестрации всё ещё применяются. Код, который вызывал instance-scoped сервис внутри orchestrator и случайно работал на in-process (потому что DI host более снисходителен), может вызвать взаимную блокировку или недетерминированный replay на isolated. Исправление -- стандартное правило Durable: вызывайте только activity-функции из orchestrator, не внедряйте сервисы.

## Как обычно идёт миграция

Типичная миграция малого-среднего размера с in-process на isolated worker в одной function app на .NET 8 занимает один сфокусированный день плюс окно релиза. Механические шаги:

1. Поменяйте ссылку на SDK в `.csproj` с `Microsoft.NET.Sdk.Functions` на `Microsoft.Azure.Functions.Worker.Sdk` и добавьте `Microsoft.Azure.Functions.Worker`.
2. Удалите `Startup.cs` и `FunctionsStartup`. Замените их на `Program.cs`, использующий `FunctionsApplication.CreateBuilder(args)`.
3. Поменяйте каждую ссылку на расширение привязки с `Microsoft.Azure.WebJobs.Extensions.*` на `Microsoft.Azure.Functions.Worker.Extensions.*`.
4. Перепишите сигнатуры функций: параметры `ILogger log` перемещаются в конструкторное внедрение или в `FunctionContext.GetLogger<T>()`. `[FunctionName]` становится `[Function]`. `HttpRequest` / `IActionResult` либо остаются (если вы вызываете `ConfigureFunctionsWebApplication()`), либо меняются на `HttpRequestData` / `HttpResponseData`.
5. Установите `FUNCTIONS_WORKER_RUNTIME` в `dotnet-isolated` в конфигурации вашей function app и обновите стек runtime развёрточного слота в портале или в Bicep.
6. Прогоните тестовый набор, затем разверните в staging-слот и проведите 24-часовой soak перед переключением.

`dotnet upgrade-assistant` автоматизирует шаги с 1 по 4 для большинства приложений. Места, где он не может помочь, -- это пользовательский код, эквивалентный middleware (который вы обычно хотите преобразовать в настоящий middleware), и любой доступ к host WebJobs на основе рефлексии, который больше не применяется.

## Опинионатированная рекомендация, переформулированная

Используйте модель isolated worker для каждого Azure Functions-приложения в 2026 году. Если вы начинаете с нуля, делайте scaffold на .NET 11 isolated и включайте Native AOT для HTTP-триггеров, если cold start важен. Если у вас есть in-process приложение, запланируйте его миграцию так, чтобы она приземлилась до октября 2026 года, чтобы иметь месяц запаса до даты вывода из эксплуатации, и используйте этот месяц для прогрева новой модели под реальным трафиком. Аргумент "in-process быстрее" больше не верен, как только вы добавляете AOT в сравнение, а "у in-process больше привязок" не было верно с второй половины 2024 года.

## Связанное

- [Как сократить время cold start для .NET 11 AWS Lambda](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) объясняет те же компромиссы cold start на Lambda; большинство советов по AOT переносится напрямую.
- [Как использовать Native AOT с minimal APIs ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) проходит через настройки publish и предупреждения trim, с которыми вы столкнётесь при включении AOT для isolated worker.
- [Native AOT vs ReadyToRun vs обычный JIT](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) содержит числа бенчмарков за приведённым выше утверждением о cold start.
- [Polly vs resilience handlers в .NET 11](/ru/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) охватывает паттерн retry, который вы почти наверняка захотите вокруг вызовов `HttpClient`, которые теперь использует ваш isolated worker.
- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) чисто отображается на подход middleware в isolated worker, как только вы вызываете `ConfigureFunctionsWebApplication()`.

## Источники

- Microsoft Learn, [Руководство по запуску C# Azure Functions в изолированном процессе worker](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide).
- Microsoft Learn, [Различия между моделью in-process и моделью isolated worker](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences).
- Команда Azure Functions, [объявление о выводе модели in-process из эксплуатации](https://techcommunity.microsoft.com/blog/appsonazureblog/net-on-azure-functions-roadmap-update/4178714).
- `Microsoft.Azure.Functions.Worker` на NuGet, [release notes для 2.0.x](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker).
- Azure SDK blog, [поддержка Native AOT для HTTP-триггеров Azure Functions](https://devblogs.microsoft.com/azure-sdk/).
