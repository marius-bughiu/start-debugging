---
title: "Minimal APIs vs контроллеры в ASP.NET Core 11: что выбрать в 2026 году?"
description: "В ASP.NET Core 11 по умолчанию выбирайте minimal APIs. Контроллеры берите только тогда, когда нужны возможности MVC, которые minimal APIs всё ещё не покрывают: маршрутизация по соглашениям для множества действий, фильтры в стиле MVC или Razor-представления."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "minimal-apis"
  - "controllers"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/minimal-apis-vs-controllers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-05-21
---

Если вы начинаете новый HTTP-сервис на ASP.NET Core 11 и выбираете между minimal APIs и контроллерами, выбирайте minimal APIs. Причины 2022 года продолжать использовать контроллеры (нет фильтров, нет валидации, слабый OpenAPI, нет групп маршрутов, нет Native AOT) исчезли. Начиная с .NET 11 у minimal APIs есть фильтры эндпоинтов, группы маршрутов, встроенный документ OpenAPI через `Microsoft.AspNetCore.OpenApi`, валидация параметров через `[Validate]` в `Microsoft.AspNetCore.Http.Validation`, `TypedResults` и полная поддержка Native AOT. Контроллеры остаются правильным инструментом в двух конкретных случаях: вам нужны Razor-представления (MVC или Razor Pages) в том же проекте, либо вы сопровождаете большую существующую кодовую базу с сотнями действий, помеченных `[Route]`, которые сегодня работают.

Все примеры кода в этой статье ориентированы на `<TargetFramework>net11.0</TargetFramework>` с `<LangVersion>14.0</LangVersion>` и используют пакеты ASP.NET Core 11, поставляемые в .NET 11 GA SDK.

## Матрица возможностей

| Возможность                                 | Minimal APIs (ASP.NET Core 11)                       | Controllers (ASP.NET Core 11)                       |
| ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Маршрутизация                               | Endpoint routing, `MapGet`/`MapPost`, группы маршрутов | Endpoint routing, по атрибутам или по соглашениям |
| Фильтры на эндпоинт                         | `IEndpointFilter`, `AddEndpointFilter<T>`            | `IActionFilter`, `IAsyncActionFilter`               |
| Вывод источника при привязке                | Правила привязки по параметрам, `[FromBody]` необязателен | `[FromBody]`, `[FromQuery]`, `[FromForm]` и др. |
| Валидация                                   | `[Validate]` в `Microsoft.AspNetCore.Http.Validation` (ASP.NET Core 11) | `ModelState` с DataAnnotations, `ApiController` |
| Хелперы результатов                         | `TypedResults`, `Results`                            | `IActionResult`, `ActionResult<T>`, `Problem()`     |
| OpenAPI / Swagger                           | `Microsoft.AspNetCore.OpenApi` 11, без лишней обвязки | `Microsoft.AspNetCore.OpenApi` 11 + соглашения     |
| Native AOT                                  | Полная поддержка (`PublishAot=true` работает)        | Ограниченная; `AddControllers` всё ещё выдаёт предупреждения trim |
| Razor-представления / Razor Pages           | Не поддерживается (нет конвейера рендеринга представлений) | Поддерживается (`AddControllersWithViews`, Razor Pages) |
| Antiforgery (`POST` формы с cookie)         | `app.UseAntiforgery()` + `[FromForm]`                | Встроено в MVC по умолчанию через `[ValidateAntiForgeryToken]` |
| Стандартный шаблонный код на эндпоинт       | 1 лямбда + 1 строка `MapX`                           | 1 класс + 1 метод + атрибуты                        |
| Обнаруживаемость в кодовой базе на 200 эндпоинтов | Файлы групп / методы расширения                | Один класс контроллера на ресурс                    |
| Размер бинарника при AOT-публикации         | Самый маленький во фреймворке                        | Больше; полный конвейер MVC                         |
| Пропускная способность (маленький JSON-эндпоинт, в стиле TechEmpower) | ~3-5% выше, чем у контроллеров | Базовая линия                                       |

Числа в последней строке взяты из собственных бенчмарков команды .NET для ASP.NET Core 11. Для большинства приложений эту разницу можно считать "на уровне шума". Причина выбирать minimal APIs не в дельте пропускной способности. Дело в меньшей поверхности и в истории с AOT.

## Когда minimal APIs - правильный выбор

Используйте minimal APIs по умолчанию для любого нового HTTP-сервиса на ASP.NET Core 11. Конкретные случаи, где они блистают:

- **JSON-через-HTTP сервисы и BFF.** Типичный файл сервиса - это `Program.cs` плюс несколько расширений `MapXxxEndpoints(this RouteGroupBuilder group)`. Нет `[ApiController]`, нет `[HttpGet("...")]`, нет внедрения через конструктор. Зависимости на каждый обработчик приходят как параметры, которые среда выполнения по умолчанию разрешает из DI в ASP.NET Core 11.
- **Микросервисы и serverless-функции на .NET 11.** Native AOT-публикация даёт самодостаточный бинарник в диапазоне 8-15 МБ с холодным стартом менее 100 мс. Контроллеры под AOT всё ещё поддерживаются частично, но `AddControllers` выдаёт предупреждения trim, которые команде так и не удалось полностью подавить.
- **MCP-серверы и эндпоинты для ИИ-агентов.** Когда вы предоставляете LLM через HTTP горсть операций, форма "одна строка на эндпоинт" у minimal APIs совпадает с концептуальной формой списка инструментов. Поставляемый шаблон `dotnet new mcpserver`, появившийся в [.NET 11 Preview 4](/ru/2026/05/dotnet-11-preview-4-mcpserver-template-bundled/), по той же причине использует регистрацию в стиле minimal APIs.
- **JSON-эндпоинты рядом с gRPC.** Когда у вас уже есть gRPC-сервисы на `Grpc.AspNetCore` и нужна небольшая JSON-поверхность для браузеров или вебхуков, minimal APIs сохраняют HTTP-слой тонким.

Маленький, но реалистичный эндпоинт:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.AddOpenApi();
builder.Services.AddScoped<IInvoiceStore, SqlInvoiceStore>();

var app = builder.Build();
app.MapOpenApi();

var invoices = app.MapGroup("/invoices")
    .WithTags("Invoices")
    .RequireAuthorization();

invoices.MapGet("/{id:int}", async (
    int id,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var invoice = await store.FindAsync(id, ct);
    return invoice is null
        ? Results.NotFound()
        : TypedResults.Ok(invoice);
});

invoices.MapPost("/", async Task<Results<Created<Invoice>, ValidationProblem>> (
    [Validate] CreateInvoice request,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var created = await store.CreateAsync(request, ct);
    return TypedResults.Created($"/invoices/{created.Id}", created);
});

app.Run();
```

`CreateSlimBuilder` подключает минимальный набор сервисов, что и делает Native AOT жизнеспособным. `MapGroup` плюс `RequireAuthorization` - это история о группах маршрутов и общих политиках, которой не было до .NET 7. `[Validate]` - атрибут ASP.NET Core 11, активирующий `Microsoft.AspNetCore.Http.Validation`, валидатор на основе генератора исходного кода, который заменяет конвейер DataAnnotations, ранее доступный только в контроллерах. Возвращаемый тип `Results<TOk, TErr>` - это то, что делает документ OpenAPI точным без какой-либо дополнительной аннотации `Produces`.

## Когда контроллеры - правильный выбор

Беритесь за контроллеры, когда верно одно из следующих утверждений:

- **Вам нужны Razor-представления или Razor Pages в том же приложении.** Серверный рендеринг HTML по-прежнему территория контроллеров. `AddControllersWithViews` и `AddRazorPages` подключаются к конвейеру представлений MVC. Minimal APIs - нет, и в .NET 11 не будут. Если половина ваших эндпоинтов - MVC-представления, а половина - JSON, вы прекрасно можете запустить и то и другое в одном `WebApplication`, но JSON-половина всё равно может быть minimal APIs, а представления остаются на контроллерах.
- **Вы сопровождаете большую MVC-кодовую базу.** Приложение на 300 контроллеров с пронизывающими `[Authorize]`, `[ApiVersion]`, `[ProducesResponseType]` и собственными реализациями `IAsyncActionFilter` - не кандидат на миграцию. ROI переписывания отрицательный. Оставьте на контроллерах, обновите проект до `net11.0` и добавляйте новые эндпоинты как minimal APIs рядом, если команда так предпочитает.
- **Вы зависите от соглашений или фильтров MVC, которые не можете воспроизвести.** У некоторых элементов MVC нет эквивалента в minimal APIs: `IModelBinder` для пользовательской привязки, `IActionConstraint` для ветвлений маршрутизации, соглашения `ApplicationModel` в `IApplicationModelConvention`. Если на этом построена инфраструктура, путь миграции - реальная работа.
- **Вам нужен контракт `[ApiController]`.** Автоматический 400 при невалидном `ModelState`, вывод `[FromBody]` и `ProblemDetails` повсюду - приятные значения по умолчанию. Minimal APIs в ASP.NET Core 11 дают те же значения, если подключить `[Validate]` и `app.UseStatusCodePages()`, но `[ApiController]` делает это одним атрибутом.

Сопоставимый контроллер для эндпоинтов счетов:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("invoices")]
[Authorize]
public class InvoicesController(IInvoiceStore store) : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<Invoice>> Get(int id, CancellationToken ct)
    {
        var invoice = await store.FindAsync(id, ct);
        return invoice is null ? NotFound() : Ok(invoice);
    }

    [HttpPost]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<Invoice>> Create(
        CreateInvoice request,
        CancellationToken ct)
    {
        var created = await store.CreateAsync(request, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }
}
```

Два эндпоинта, в два раза больше шаблонного кода, никакого функционального выигрыша. Это и есть тот паттерн, который делает minimal APIs выбором по умолчанию в 2026 году: в новом коде вы пишете меньше, выражая то же самое.

## Бенчмарк

Разрыв в производительности между двумя стилями в ASP.NET Core 11 небольшой, но устойчивый на маленьких JSON-эндпоинтах. Официальные бенчмарки команды .NET (https://github.com/aspnet/Benchmarks, результаты ASP.NET Core 11 GA, опубликованные в ноябре 2025) показывают:

| Сценарий                                | Minimal APIs (RPS) | Controllers (RPS) | Дельта |
| --------------------------------------- | ------------------ | ----------------- | ------ |
| `GET /json` (один объект, 200 байт)     | 1 160 000          | 1 120 000         | +3,6%  |
| `POST /json` (echo, тело 1 КБ)          | 590 000            | 565 000           | +4,4%  |
| `GET /plaintext` (TechEmpower)          | 7 250 000          | 7 250 000         | 0%     |
| Холодный старт (AOT, `dotnet publish -aot`) | 70 мс          | 280 мс            | -75%   |

Методология, кратко из опубликованных прогонов: ASP.NET Core 11 GA, Linux x64, машины Citrine, `wrk` нагружает Kestrel 256 одновременными соединениями, 30-секундные прогоны, усреднённые по пяти выборкам. Строка холодного старта публикуется из той же лаборатории с помощью `time` на AOT-бинарнике при первом запуске. `plaintext` одинаков, потому что стоимость конвейера запроса определяется парсингом Kestrel, а не формой эндпоинта.

Честное прочтение этих чисел: если вы упираетесь в CPU на горячем JSON-эндпоинте, переходом с контроллеров на minimal APIs можно выиграть 3-5%. Реальные приложения проводят время в EF Core или в исходящих HTTP-запросах, а не в диспетчере эндпоинтов. Строка холодного старта, однако, реальна: если вы разворачиваетесь в AWS Lambda или Azure Functions, дельта AOT - это разница между сервисом, который прогревается менее чем за секунду, и тем, который не прогревается. Сопутствующий разбор о [сокращении холодного старта Lambda на .NET 11](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) проводит по AOT-публикации, которая и даёт эти числа.

## Подводный камень, который выбирает за вас

Три ограничения решают вопрос без участия предпочтений:

- **Razor-представления в проекте.** Если приложение отдаёт Razor или Razor Pages, для этих частей остаётесь на контроллерах. Minimal APIs не умеют возвращать отрендеренное представление. Можно разделить: JSON-эндпоинты на minimal APIs, HTML на MVC, всё зарегистрировано в одном `WebApplication`.
- **`PublishAot=true`.** Если нужно публиковать AOT (Lambda, Functions isolated, маленькие контейнеры, IoT), minimal APIs - путь наименьшего сопротивления. Конвейер контроллеров под AOT в .NET 11 всё ещё выдаёт предупреждения, и официальное руководство команды рекомендует minimal APIs для AOT-сценариев.
- **Существующая база контроллеров больше нескольких классов.** Стоимость миграции - в сквозных фильтрах и соглашениях, а не в сигнатурах эндпоинтов. Если у вас значимая инфраструктура `IActionFilter`, `IApplicationModelConvention` или собственного `IModelBinder`, миграция - это переписывание, а не рефакторинг. Сохраняйте то, что работает.

## Чего minimal APIs всё ещё не делают

Кое-что, что контроллеры умеют, а minimal APIs в ASP.NET Core 11 всё ещё не повторяют:

- **`IModelBinder` для сложной привязки из нескольких источников.** Привязка в minimal APIs в основном выводится по источнику (маршрут, query, тело) и работает по параметрам. Если вам нужно объединить заголовки, claims и тело в один составной тип со своей логикой, вы пишете статический метод `BindAsync` на этом типе, что нормально, но не так заметно, как model binder.
- **`IActionConstraint` для ветвлений маршрутизации.** Полезно для маршрутизации по согласованию контента, когда один маршрут отображается в несколько действий в зависимости от заголовков `Accept`. Фильтры эндпоинтов могут приблизиться, но слой маршрутизации менее выразителен.
- **`[Consumes]` из MVC для согласования контента между несколькими действиями на одном маршруте.** В minimal APIs можно это сделать, направив всё в один эндпоинт и разделив внутри, но декларативная форма MVC компактнее.

Если что-то из этих трёх пунктов несущее в вашем дизайне, баланс затрат и выгод снова склоняется к контроллерам. Для 95% новых сервисов ASP.NET Core 11 - нет.

## Выбор, ещё раз

По умолчанию используйте minimal APIs в ASP.NET Core 11. Это способ построить JSON-HTTP-сервис в .NET 11 с меньшим количеством шаблонного кода, готовый к AOT и чистый по OpenAPI. Исторические причины предпочитать контроллеры (фильтры, валидация, группы маршрутов, OpenAPI, соглашения) закрывались одна за другой в .NET 7, 8, 10 и 11. Остаётся небольшой набор возможностей MVC (Razor-представления, model binders, action constraints), которыми всё ещё владеют контроллеры. Если ваш проект в них нуждается, используйте контроллеры для тех частей, где они нужны, и minimal APIs для всего остального. Оба стиля прекрасно сосуществуют в одном `WebApplication`.

## Похожее

- [Как использовать Native AOT с minimal APIs в ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) - про AOT-публикацию, от которой зависят числа бенчмарка выше.
- [Как добавить rate limiting на каждый эндпоинт в ASP.NET Core 11](/ru/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) - про одну из сквозных задач, которые фильтры эндпоинтов теперь решают аккуратно.
- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) - minimal API-эквивалент фильтра исключений MVC.
- [Как добавить потоки аутентификации OpenAPI в Swagger UI на .NET 11](/ru/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) - чтобы задокументировать поток `RequireAuthorization()`, показанный выше.
- [Нативная трассировка OpenTelemetry в ASP.NET Core 11](/ru/2026/04/aspnetcore-11-native-opentelemetry-tracing/) - часть про наблюдаемость, которая стыкуется с любым из стилей.

## Источники

- Документация ASP.NET Core 11, "Minimal APIs overview": https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/overview
- `Microsoft.AspNetCore.Http.Validation` (пакет `[Validate]`, поставляемый с ASP.NET Core 11): https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/validation
- Документация по OpenAPI в ASP.NET Core 11: https://learn.microsoft.com/aspnet/core/fundamentals/openapi/overview
- Native AOT для ASP.NET Core: https://learn.microsoft.com/aspnet/core/fundamentals/native-aot
- Репозиторий aspnet/Benchmarks (источник таблицы пропускной способности): https://github.com/aspnet/Benchmarks
- Справка по MVC controllers: https://learn.microsoft.com/aspnet/core/mvc/controllers/actions
