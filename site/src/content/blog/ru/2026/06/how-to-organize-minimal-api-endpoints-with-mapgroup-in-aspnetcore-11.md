---
title: "Как организовать эндпоинты minimal API с помощью MapGroup в ASP.NET Core 11"
description: "Полное руководство по структурированию minimal API в ASP.NET Core 11 с помощью MapGroup: модули эндпоинтов на ресурс как методы расширения, вложенные группы, общие фильтры и аутентификация, префиксы с параметрами маршрута, теги OpenAPI и неожиданные правила порядка фильтров."
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "ru"
translationOf: "2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-07
---

Чтобы minimal API не превратил `Program.cs` в стену из тысячи строк вызовов `app.MapGet(...)`, группируйте связанные эндпоинты с помощью `app.MapGroup("/prefix")`, который возвращает `RouteGroupBuilder`, разделяющий префикс маршрута и любые соглашения (фильтры, аутентификацию, теги OpenAPI), которые вы к нему присоедините. Долговечный паттерн, это один метод расширения на ресурс: `public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)` внутри строит собственную группу, а `Program.cs` сжимается до списка вызовов `app.MapTodos();`. `MapGroup` стабилен начиная с ASP.NET Core 7 и не изменился в .NET 11. Всё ниже нацелено на .NET 11 с `Microsoft.NET.Sdk.Web` и C# 14, но API идентичен в .NET 8, 9 и 10.

## Почему Program.cs загнивает

Minimal API поставляются с соблазнительным демо: всё приложение в одном файле. Это прекрасно для примера и ужасно для настоящего сервиса. К тому моменту, когда у вас есть горстка ресурсов, каждый с пятью глаголами CRUD плюс пара подмаршрутов, `Program.cs`, это несколько сотен строк route handler-ов, перемежающихся с регистрацией DI, подключением middleware и `app.Run()`. Вы прокручиваете мимо настройки аутентификации, чтобы найти `MapPut`, который хотели отредактировать. Три handler-а начинаются с `/api/v1/orders`, и в одном из них опечатка в префиксе, которую никто не замечает до 404 в продакшене.

Решение, это не «вернуться к контроллерам». Контроллеры решают организацию через соглашение (один класс на ресурс, атрибуты для маршрутизации) ценой основанного на рефлексии конвейера MVC. Minimal API решают это с помощью `MapGroup` плюс обычные методы расширения C#, и вы сохраняете лёгкую, дружественную к AOT модель эндпоинтов. Если вы всё ещё выбираете между двумя моделями, компромиссы изложены в [minimal API против контроллеров в ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/). Это руководство предполагает, что вы выбрали minimal API и хотите, чтобы они масштабировались.

## MapGroup возвращает RouteGroupBuilder

`MapGroup`, это метод расширения для `IEndpointRouteBuilder`. Он принимает префикс маршрута и возвращает `RouteGroupBuilder`:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

RouteGroupBuilder todos = app.MapGroup("/todos");

todos.MapGet("/", () => "all todos");        // GET  /todos/
todos.MapGet("/{id:int}", (int id) => $"todo {id}"); // GET  /todos/42
todos.MapPost("/", () => "created");          // POST /todos/

app.Run();
```

Каждый вызов `Map{Verb}` на группе наследует префикс `/todos`, поэтому шаблоны, которые вы пишете на группе, относительные. `RouteGroupBuilder` реализует `IEndpointRouteBuilder`, и именно эта деталь заставляет работать всё остальное: всё, что вы можете вызвать на `app` (включая сам `MapGroup`), вы можете вызвать на группе. Так вложенность достаётся бесплатно.

Префикс комбинируется простой конкатенацией. `app.MapGroup("/api").MapGroup("/v1").MapGet("/todos", ...)` регистрирует `GET /api/v1/todos`. Никакой магии нормализации сверх соединения сегментов нет, поэтому не удваивайте слеши: префикс группы `/todos/` плюс шаблон handler-а `/{id}` даёт `/todos//{id}`, который не совпадёт с тем, что вы ожидаете.

## Один метод расширения на ресурс

Паттерн, который масштабируется, это дать каждому ресурсу собственный статический класс с одним методом `Map`, и пусть этот метод создаёт собственную группу. Тип возврата должен быть `IEndpointRouteBuilder` (или `RouteGroupBuilder`), чтобы вызовы выстраивались в цепочку:

```csharp
// .NET 11, C# 14 -- Endpoints/TodoEndpoints.cs
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/todos")
            .WithTags("Todos");

        group.MapGet("/", GetAll);
        group.MapGet("/{id:int}", GetById).WithName("GetTodoById");
        group.MapPost("/", Create);
        group.MapPut("/{id:int}", Update);
        group.MapDelete("/{id:int}", Delete);

        return routes;
    }

    private static async Task<Ok<List<Todo>>> GetAll(TodoDb db) =>
        TypedResults.Ok(await db.Todos.ToListAsync());

    private static async Task<Results<Ok<Todo>, NotFound>> GetById(int id, TodoDb db) =>
        await db.Todos.FindAsync(id) is { } todo
            ? TypedResults.Ok(todo)
            : TypedResults.NotFound();

    private static async Task<Created<Todo>> Create(Todo todo, TodoDb db)
    {
        db.Todos.Add(todo);
        await db.SaveChangesAsync();
        return TypedResults.Created($"/todos/{todo.Id}", todo);
    }

    private static async Task<Results<NoContent, NotFound>> Update(int id, Todo input, TodoDb db)
    {
        var todo = await db.Todos.FindAsync(id);
        if (todo is null) return TypedResults.NotFound();
        todo.Title = input.Title;
        todo.Done = input.Done;
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, NotFound>> Delete(int id, TodoDb db)
    {
        var rows = await db.Todos.Where(t => t.Id == id).ExecuteDeleteAsync();
        return rows > 0 ? TypedResults.NoContent() : TypedResults.NotFound();
    }
}
```

Теперь `Program.cs`, это оглавление:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<TodoDb>(o => o.UseSqlServer(/* ... */));
builder.Services.AddOpenApi();

var app = builder.Build();

app.MapTodos();
app.MapOrders();
app.MapCustomers();

app.MapOpenApi();
app.Run();
```

Две вещи делают эту идиому приятной. Во-первых, handler-ы, это именованные методы `private static` вместо лямбд, поэтому у каждого есть реальное имя в трассировках стека, и его тривиально тестировать изолированно. Во-вторых, возврат `IEndpointRouteBuilder` из `MapTodos` позволяет продолжать цепочку, если хотите (`app.MapTodos().MapOrders();`), хотя один вызов на строку читается лучше.

Замечание о типе возврата: если единственная задача метода, построить группу, и вы хотите, чтобы *вызывающий* присоединял к этой группе дополнительные соглашения, возвращайте `RouteGroupBuilder`. Если метод регистрирует эндпоинты, и вызывающий не должен трогать группу после, возвращайте `IEndpointRouteBuilder`. Смешение этих двух, самый частый источник путаницы «почему мой `.RequireAuthorization()` не компилируется».

## Общие фильтры, аутентификация и метаданные одним вызовом

Выигрыш от группы в том, что соглашение, применённое к группе, применяется к каждому эндпоинту под ней. Именно здесь `MapGroup` оправдывает себя по сравнению с копированием `.RequireAuthorization()` на двадцать handler-ов:

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin")
    .RequireAuthorization("AdminPolicy")   // every endpoint requires the policy
    .WithTags("Admin")                     // one OpenAPI tag for the whole group
    .AddEndpointFilter<AuditFilter>();     // runs for every endpoint in the group

admin.MapGet("/users", ListUsers);
admin.MapDelete("/users/{id:int}", DeleteUser);
```

`RequireAuthorization`, `WithTags`, `WithMetadata`, `RequireRateLimiting`, `AddEndpointFilter` и `AddEndpointFilterFactory`, все это методы `IEndpointConventionBuilder`, а `RouteGroupBuilder` реализует этот интерфейс, поэтому все они стекают на участников. Если вам нужно ограничение частоты на эндпоинт, секционированное по маршруту внутри группы, [руководство по ограничению частоты на эндпоинт](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) описывает, как `RequireRateLimiting` сочетается с политикой группы.

Одна тонкость, которую стоит усвоить: `AddEndpointFilter` на группе, это **не** middleware. Он не выполняется один раз на запрос к префиксу. Он применяется к конвейеру фильтров каждого эндпоинта по отдельности, во время сборки. Практическая разница в том, что фильтр выполняется только тогда, когда эндпоинт в группе действительно совпадает. Запрос к `/admin/nonexistent`, дающий 404, никогда не вызывает `AuditFilter`, тогда как middleware на сегменте пути `/admin` вызвал бы. Если вам нужен настоящий middleware, ограниченный путём, используйте `app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/admin"), ...)`.

## Вложенные группы и параметры маршрута в префиксе

Поскольку группа сама является `IEndpointRouteBuilder`, вы вкладываете её, вызывая `MapGroup` на группе. Префиксы могут содержать параметры маршрута и ограничения, и handler на любой глубине может привязать параметры, объявленные в любом предковом префиксе:

```csharp
// .NET 11, C# 14
var orgs = app.MapGroup("/orgs/{orgId:int}");
var projects = orgs.MapGroup("/projects/{projectId:int}");

projects.MapGet("/issues", (int orgId, int projectId) =>
    $"issues for org {orgId}, project {projectId}");
// matches GET /orgs/7/projects/3/issues
```

Handler привязывает и `orgId`, и `projectId`, хотя каждый объявлен на уровень выше. Это чистый способ моделировать иерархические ресурсы: каждый уровень URL, это группа, а конечные handler-ы остаются короткими, потому что общие значения маршрута захватываются структурой, а не повторяются в каждом шаблоне.

Префикс также может быть пустым. `app.MapGroup("")` не добавляет сегмент пути, и это приём для присоединения соглашения или фильтра к полосе эндпоинтов без изменения их URL:

```csharp
// .NET 11, C# 14
var versioned = app.MapGroup("").WithOpenApi();
var v1 = versioned.MapGroup("/v1");
var v2 = versioned.MapGroup("/v2");
```

## Правило порядка фильтров, на котором спотыкаются

Когда фильтры живут на вложенных группах, порядок их выполнения определяется вложенностью групп, **самый внешний первым**, а не порядком, в котором вы написали вызовы `AddEndpointFilter`. Это самое контринтуитивное поведение групп маршрутов, оно задокументировано, но его легко упустить.

```csharp
// .NET 11, C# 14
var outer = app.MapGroup("/outer");
var inner = outer.MapGroup("/inner");

inner.AddEndpointFilter((ctx, next) =>
{
    app.Logger.LogInformation("inner group filter");
    return next(ctx);
});

outer.AddEndpointFilter((ctx, next) =>   // added second, runs first
{
    app.Logger.LogInformation("outer group filter");
    return next(ctx);
});

inner.MapGet("/", () => "Hi!").AddEndpointFilter((ctx, next) =>
{
    app.Logger.LogInformation("endpoint filter");
    return next(ctx);
});
```

Запрос к `/outer/inner/` записывает в журнал, по порядку:

```text
outer group filter
inner group filter
endpoint filter
```

Внешний фильтр выполняется раньше внутреннего, хотя был добавлен вторым, потому что фильтры применяются от самой внешней группы внутрь, а собственные фильтры эндпоинта, последними. Относительный порядок вызовов `AddEndpointFilter` важен только тогда, когда они присоединены к *одному и тому же* builder-у. Между разными группами побеждает вложенность. Если у вас есть фильтр в стиле аутентификации, который должен выполняться до фильтра логирования, поместите аутентификацию на внешнюю группу, а не просто выше в файле.

## Версионирование minimal API с помощью групп

Частая причина прибегнуть к вложенным группам, это версионирование API по сегменту URL. Каждая версия, это группа, и каждый модуль ресурса монтируется под тем builder-ом версии, который ему передан:

```csharp
// .NET 11, C# 14
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes, int version)
    {
        var group = routes.MapGroup($"/todos").WithTags($"Todos v{version}");
        group.MapGet("/", GetAll);
        // v2-only endpoint
        if (version >= 2) group.MapGet("/search", Search);
        return routes;
    }
}

// Program.cs
var v1 = app.MapGroup("/api/v1");
var v2 = app.MapGroup("/api/v2");

v1.MapTodos(version: 1);
v2.MapTodos(version: 2);
```

Для всего, что выходит за рамки ручного версионирования по URL (версионирование по media-type или заголовку, заголовки устаревания, version sets), пакет `Asp.Versioning` интегрируется с `MapGroup` через `HasApiVersion` на группе, но для частого случая «префиксы пути v1 и v2» простой вложенности выше достаточно, и она не приносит никакой дополнительной зависимости.

## Группировка в документе OpenAPI

`WithTags` на группе, это то, что создаёт сворачиваемые разделы в Swagger UI или Scalar. Пометьте группу один раз, и каждый эндпоинт попадёт под этот тег:

```csharp
// .NET 11, C# 14
var todos = app.MapGroup("/todos").WithTags("Todos");
```

Без тега встроенный генератор OpenAPI откатывается к использованию первого сегмента маршрута в качестве тега, что обычно работает, но стоит задать его явно, чтобы рефакторинг префикса не переименовал молча разделы вашего API. Если вы также раскрываете потоки аутентификации в спецификации, группа, правильное место для присоединения требования безопасности, чтобы оно отображалось при каждой операции, см. [добавление потоков аутентификации OpenAPI в Swagger UI в .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) для подключения `WithOpenApi` и схем безопасности.

## Подводные камни, которые стоит знать до рефакторинга

Несколько острых углов, на которые легко наткнуться, когда вы впервые перестраиваете плоский файл в группы:

- **`MapGroup` нужно вызывать на builder-е, а не после `app.Run()`.** Как и вся регистрация эндпоинтов, это должно происходить до того, как приложение начнёт обрабатывать запросы. Добавление группы изнутри request handler-а ничего не делает.
- **Префикс группы, это не ограничение на весь путь.** `MapGroup("/api")` не мешает другим вызовам `MapGet("/api/...")` верхнего уровня в другом месте совпадать. Группа управляет только теми эндпоинтами, которые вы регистрируете *через неё*.
- **`RequireAuthorization()` на группе аддитивен, а не переопределяет.** Если внутренняя группа или эндпоинт тоже вызывают `RequireAuthorization` с другой политикой, применяются обе политики (запрос должен удовлетворять всем). Семантики «внутренняя побеждает» нет.
- **`AddEndpointFilterFactory` выполняется один раз во время сборки, на эндпоинт, а не на запрос.** Фабрика инспектирует `MethodInfo` и возвращает фактический делегат на запрос. Размещение дорогой логики на запрос в теле фабрики (а не в возвращаемом делегате) означает, что она никогда не выполнится во время запроса. Это тот же паттерн фабрики, который документация использует, чтобы переключить `DbContext` в режим приватного запроса для группы эндпоинтов.
- **Native AOT прекрасно работает со всем этим.** Группы, модули на методах расширения и фильтры, всё это часть дружественной к AOT поверхности minimal API; ничто из этого не вынуждает откат к рефлексии. Если вы публикуете с триммингом или AOT, см. [использование Native AOT с minimal API ASP.NET Core](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) для деталей генератора request delegate, которые позволяют сгруппированным handler-ам чисто генерироваться из исходников.

Ментальная модель, которую стоит унести: `RouteGroupBuilder`, это просто `IEndpointRouteBuilder` с запомненным префиксом и запомненным набором соглашений. Каждый организационный приём, модули, вложенность, версионирование, общая аутентификация, следует из этого единственного факта. Начните с извлечения одного метода расширения `MapXxx` на ресурс, сократите `Program.cs` до списка вызовов и прибегайте к вложенным группам только тогда, когда иерархия URL действительно вкладывается.

## Связанное

- [Minimal API против контроллеров в ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), если вы всё ещё выбираете между двумя моделями эндпоинтов.
- [Добавление глобального фильтра исключений в ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) для перехвата исключений на каждом сгруппированном эндпоинте в одном месте.
- [Добавление ограничения частоты на эндпоинт в ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) для сочетания `RequireRateLimiting` с политикой группы.
- [Добавление потоков аутентификации OpenAPI в Swagger UI в .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) для присоединения схем безопасности к тегу группы.
- [Использование Native AOT с minimal API ASP.NET Core](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) для публикации сгруппированных эндпоинтов с триммингом и AOT.

## Источники

- Microsoft Learn, [Route handlers in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0) (группы маршрутов, вложенность, порядок фильтров).
- Microsoft Learn, [Filters in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0) (`AddEndpointFilter`, `AddEndpointFilterFactory`).
- Microsoft Learn, [Organizing ASP.NET Core Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/organizing-apis?view=aspnetcore-10.0).
- Справочник API, [EndpointRouteBuilderExtensions.MapGroup](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.endpointroutebuilderextensions.mapgroup).
