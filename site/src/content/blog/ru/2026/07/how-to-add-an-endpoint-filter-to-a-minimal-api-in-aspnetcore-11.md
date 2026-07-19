---
title: "Как добавить endpoint filter в minimal API в ASP.NET Core 11"
description: "Полное рабочее руководство по endpoint-фильтрам в minimal API ASP.NET Core 11: AddEndpointFilter со встроенным делегатом, классы IEndpointFilter с внедрением зависимостей, GetArgument и список Arguments, короткое замыкание через Results.Problem, порядок FIFO/FILO для нескольких фильтров, фильтры на уровне группы с MapGroup и AddEndpointFilterFactory для фильтров, зависящих от сигнатуры."
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "validation"
lang: "ru"
translationOf: "2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-19
---

Чтобы добавить endpoint filter в minimal API в ASP.NET Core 11, вы вызываете `.AddEndpointFilter()` на конечной точке (или группе маршрутов) и передаёте либо встроенный делегат `async (context, next) => ...`, либо класс, реализующий `IEndpointFilter`. Фильтр выполняется после привязки модели и до вашего обработчика, он видит привязанные аргументы через `context.GetArgument<T>(index)` и либо вызывает `await next(context)`, чтобы продолжить, либо возвращает значение вроде `Results.Problem(...)`, чтобы замкнуть запрос накоротко. Это вся модель целиком. Этот пост проходит её от начала до конца: встроенная форма, форма с классом и внедрением зависимостей, порядок при наложении нескольких фильтров, применение одного фильтра ко всей `MapGroup` и запасной выход в виде фабрики фильтров. Он нацелен на .NET 11 (на момент написания Preview 6, релиз GA в ноябре 2026 года) с `Microsoft.NET.Sdk.Web` и C# 14, но endpoint-фильтры стабильны начиная с ASP.NET Core 7, поэтому каждый пример здесь выполняется без изменений на .NET 8, 9 и 10.

## Что на самом деле оборачивает endpoint filter

Endpoint filter -- это фрагмент кода, который оборачивает вызов одного route-обработчика. В отличие от middleware, которое выполняется для каждого запроса, проходящего через эту точку конвейера, независимо от того, совпал маршрут или нет, фильтр выполняется только тогда, когда выбрана его конечная точка. И в отличие от middleware, фильтр выполняется после маршрутизации и после привязки параметров, поэтому к моменту его выполнения фреймворк уже разобрал значения маршрута, привязал тело запроса и разрешил аргументы обработчика. Этот момент и есть вся причина существования фильтров: вы можете исследовать и даже изменять именно те аргументы, которые ваш обработчик вот-вот получит, а также исследовать или заменять результат, который он произвёл, и всё это не трогая сам обработчик.

Конкретно, фильтр может делать три вещи:

- Выполнять код до обработчика (проверять аргументы, вести журнал, запускать секундомер).
- Замыкать накоротко: возвращать результат вместо вызова обработчика.
- Выполнять код после обработчика, включая исследование или замену его возвращаемого значения.

Это чисто ложится на валидацию, журналирование по конечной точке, формирование запросов и лёгкие сквозные задачи, которые не заслуживают собственного middleware.

## Шаги для добавления endpoint filter

1. Зарегистрируйте свои сервисы и соберите приложение как обычно с помощью `WebApplication.CreateBuilder(args)`.
2. Сопоставьте конечную точку с помощью `MapGet`, `MapPost` или `MapGroup`.
3. Прицепите `.AddEndpointFilter(...)` к возвращённому builder, передав встроенный делегат или тип `IEndpointFilter`.
4. Внутри фильтра прочитайте аргументы через `context.GetArgument<T>(index)` и решите, продолжать ли.
5. Вызовите `await next(context)`, чтобы выполнить обработчик, или верните значение (например `Results.Problem(...)`), чтобы замкнуть накоротко.

Остальная часть статьи разворачивает каждый из этих пунктов в рабочий код.

## Форма со встроенным делегатом

Самый быстрый способ добавить фильтр -- встроенный делегат. Он принимает два параметра: `EndpointFilterInvocationContext` (который предоставляет `HttpContext` и привязанные `Arguments`) и `next`, `EndpointFilterDelegate`, который вы вызываете для продолжения конвейера.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

string ColorName(string color) => $"Color specified: {color}";

app.MapGet("/color/{color}", ColorName)
    .AddEndpointFilter(async (context, next) =>
    {
        var color = context.GetArgument<string>(0);

        if (color == "Red")
        {
            // Short-circuit: the handler never runs.
            return Results.Problem("Red is not allowed.");
        }

        // Continue to the next filter, or the handler if this is the last one.
        return await next(context);
    });

app.Run();
```

`context.GetArgument<string>(0)` извлекает первый аргумент, переданный в `ColorName`, то есть `color`. Индекс позиционный: он соответствует порядку, в котором параметры появляются в объявлении обработчика, а не порядку сегментов шаблона маршрута. Если вы предпочитаете не считать позиции, `context.Arguments` -- это `IList<object?>`, по которому можно проходить в цикле, а `GetArguments()` возвращает тот же список.

Тип возврата фильтра -- `ValueTask<object?>`. Возврат `Results.Problem(...)` (или любого `IResult`) замыкает накоротко, и этот результат записывается в ответ. Возврат `await next(context)` выполняет обработчик и передаёт его результат вверх по цепочке. Поскольку возвращаемое значение течёт обратно через каждый фильтр, вы также можете преобразовать его на выходе.

## Форма с классом IEndpointFilter, с внедрением зависимостей

Встроенные делегаты идеальны для разовой логики, но фильтр, который вы хотите переиспользовать между конечными точками, принадлежит классу. Реализуйте `IEndpointFilter`, у которого один метод:

```csharp
// .NET 11, C# 14
public class ValidationFilter<T> : IEndpointFilter where T : class
{
    private readonly ILogger<ValidationFilter<T>> _logger;

    public ValidationFilter(ILogger<ValidationFilter<T>> logger)
    {
        _logger = logger;
    }

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var model = context.Arguments.OfType<T>().FirstOrDefault();

        if (model is null)
        {
            return Results.Problem($"No {typeof(T).Name} argument found.");
        }

        var errors = Validate(model);
        if (errors.Count > 0)
        {
            _logger.LogWarning("Validation failed for {Type}", typeof(T).Name);
            return Results.ValidationProblem(errors);
        }

        return await next(context);
    }

    private static Dictionary<string, string[]> Validate(T model) => new();
}
```

Зарегистрируйте его с помощью обобщённой перегрузки:

```csharp
// .NET 11, C# 14
app.MapPost("/products", (Product product) => Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilter<ValidationFilter<Product>>();
```

Две вещи о том, как конструируется этот класс, имеют значение. Первое: зависимости конструктора фильтра (`ILogger<T>` выше) разрешаются из контейнера внедрения зависимостей, поэтому вы можете внедрять логгеры, options или любой зарегистрированный сервис. Второе, и это застаёт людей врасплох: сам тип фильтра не разрешается как сервис. Вы не регистрируете `ValidationFilter<Product>` в `builder.Services`. Фреймворк активирует его за вас и удовлетворяет его конструктор из внедрения зависимостей, но он не является singleton- или scoped-сервисом, управляемым контейнером. Если вы попробуете `builder.Services.AddScoped<ValidationFilter<Product>>()`, ожидая, что `AddEndpointFilter<T>()` возьмёт его из контейнера, эта регистрация просто игнорируется.

Использование `Results.ValidationProblem` здесь производит тело problem-details по RFC 9457 со словарём ошибок в стиле `422`. Если вы хотите управлять этой формой централизованно, а не в каждом фильтре, именно для этого предназначена [настройка IProblemDetailsService](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Когда вы накладываете фильтры, порядок FIFO на входе и FILO на выходе

Вы можете прикрепить к конечной точке больше одного фильтра, и порядок -- самая запутанная часть этой возможности, пока вы не увидите её один раз. Правило: код до `next` выполняется в порядке регистрации фильтров (первым вошёл, первым вышел); код после `next` выполняется в обратном порядке (первым вошёл, последним вышел). Он вкладывается как стек.

```csharp
// .NET 11, C# 14
app.MapGet("/demo", () =>
    {
        app.Logger.LogInformation("        Handler");
        return "done";
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("Before A");
        var result = await next(context);
        app.Logger.LogInformation("After A");
        return result;
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("    Before B");
        var result = await next(context);
        app.Logger.LogInformation("    After B");
        return result;
    });
```

Это выводит в журнал:

```dotnetcli
Before A
    Before B
        Handler
    After B
After A
```

Итак, первый добавленный вами фильтр -- самая внешняя обёртка. Если вы хотите, чтобы шлюз в стиле аутентификации выполнялся до фильтра журналирования, добавьте шлюз первым. Если фильтр замыкает накоротко, возвращая значение без вызова `next`, каждый зарегистрированный после него фильтр пропускается, а те, что были до него, всё равно выполняют свой код после `next`, потому что их `await next(context)` возвращает результат короткого замыкания. Именно поэтому ранний фильтр валидации может безопасно отклонить запрос: всё, что ниже по потоку, включая обработчик, никогда не выполняется.

## Изменение аргументов до того, как их увидит обработчик

Поскольку фильтр выполняется после привязки, он может изменять аргументы на месте, и обработчик получает изменённые значения. Список `Arguments` изменяем. Это по-настоящему полезно для нормализации: обрезать строки, привести код к верхнему регистру, ограничить размер страницы.

```csharp
// .NET 11, C# 14
app.MapGet("/search", (string q, int pageSize) => new { q, pageSize })
    .AddEndpointFilter(async (context, next) =>
    {
        // Normalize the query and clamp the page size before the handler runs.
        if (context.Arguments[0] is string q)
        {
            context.Arguments[0] = q.Trim();
        }
        if (context.Arguments[1] is int size)
        {
            context.Arguments[1] = Math.Clamp(size, 1, 100);
        }

        return await next(context);
    });
```

Держите в уме предостережение: изменение по позиционному индексу привязывает фильтр к порядку параметров обработчика. Обобщённому переиспользуемому фильтру лучше сопоставлять по типу (`context.Arguments.OfType<T>()`) или читать напрямую из `HttpContext`, что и делает основанный на классе `ValidationFilter<T>` выше независимым от конечной точки.

## Применить один фильтр ко всей группе маршрутов

Повторять `.AddEndpointFilter<...>()` на каждой конечной точке -- это шум. Поскольку `MapGroup` возвращает `RouteGroupBuilder`, который переносит соглашения на своих потомков, фильтр, добавленный к группе, выполняется для каждой конечной точки внутри неё. Это компонуется с модулями конечных точек по ресурсам из [организации конечных точек minimal API с помощью MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/):

```csharp
// .NET 11, C# 14
var products = app.MapGroup("/products")
    .AddEndpointFilter<ValidationFilter<Product>>();

products.MapPost("/", (Product p) => Results.Created($"/products/{p.Id}", p));
products.MapPut("/{id:int}", (int id, Product p) => Results.NoContent());
```

Фильтры группы и фильтры конечной точки комбинируются, и порядок следует тому же правилу вложенности, при котором фильтры группы находятся снаружи. Фильтр на группе оборачивает фильтр, добавленный к отдельной конечной точке внутри неё. Вы также можете вкладывать группы, и каждый уровень добавляет ещё один слой.

Если вы хотите, чтобы фильтр применялся ко всему приложению, а не к именованной группе, добавьте его к группе, покрывающей корень: `app.MapGroup("").AddEndpointFilter(...)`. Отдельной регистрации «глобального фильтра» нет, но корневая группа -- это идиоматический эквивалент, и она удерживает фильтры в пределах маршрутизируемых конечных точек, вместо того чтобы превращать их в middleware.

## Форма фабрики для фильтров, зависящих от сигнатуры

`AddEndpointFilterFactory` -- это продвинутая дверь. Вместо экземпляра фильтра вы предоставляете фабрику, которая выполняется один раз на конечную точку при запуске, получает `EndpointFilterFactoryContext` с `MethodInfo` обработчика и возвращает сам делегат фильтра. Это позволяет исследовать сигнатуру обработчика и построить специализированный фильтр или кешировать результаты рефлексии, чтобы они вычислялись один раз, а не на каждый запрос.

```csharp
// .NET 11, C# 14 -- only attach the validation logic when the handler takes a Product first
app.MapPost("/products", (Product product) =>
        Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilterFactory((factoryContext, next) =>
    {
        var parameters = factoryContext.MethodInfo.GetParameters();
        var isProductFirst = parameters.Length >= 1
            && parameters[0].ParameterType == typeof(Product);

        if (!isProductFirst)
        {
            // Pass-through: no per-request cost for endpoints that do not match.
            return context => next(context);
        }

        return async context =>
        {
            var product = context.GetArgument<Product>(0);
            if (string.IsNullOrWhiteSpace(product.Name))
            {
                return Results.Problem("Name is required.");
            }
            return await next(context);
        };
    });
```

Выигрыш здесь в том, что исследование `MethodInfo` происходит один раз во время сборки, а не на каждый запрос, и конечные точки, чья сигнатура не совпадает, не платят ничего, кроме сквозного делегата. Обращайтесь к фабрике только тогда, когда обычный фильтр не может выразить то, что вам нужно; для распространённого случая «проверить и продолжить» форма с классом проще и читается лучше.

## Фильтры -- это не middleware и не action filters

Два сравнения проясняют большую часть оставшейся путаницы. Против middleware: endpoint filter выполняется только для своей конечной точки и только после привязки, поэтому он может видеть типизированные аргументы; middleware выполняется для целой ветви конвейера и видит только сырой `HttpContext`. Если вашей логике нужна привязанная модель, ей нужен фильтр. Если ей нужно выполняться до маршрутизации или через множество несвязанных конечных точек, ей нужно middleware. Против action-фильтров MVC (`IActionFilter`, `IAsyncActionFilter`): endpoint-фильтры -- это эквивалент для minimal API, но это другой тип в другом namespace. Вы не можете переиспользовать action-фильтр MVC на конечной точке minimal API. Единственный мост, который предоставляет Microsoft, заключается в том, что `AddEndpointFilter` также работает на `ControllerActionEndpointConventionBuilder` контроллера, поэтому один делегат endpoint-фильтра можно разделить между конечными точками minimal API и действиями контроллера, если вы маршрутизируете и то, и другое.

Ещё одно практическое замечание: поскольку фильтр может замкнуть накоротко с помощью `IResult`, он естественно сочетается с типизированными результатами. Если ваш обработчик возвращает [типизированное объединение Results](/ru/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/), фильтр, возвращающий `Results.Problem`, всё равно чисто встраивается, поскольку тип возврата фильтра -- `object?`, и любой `IResult` записывается в ответ. А для по-настоящему тяжёлой валидации взвесьте фильтр против [встроенной валидации запросов](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), которую ASP.NET Core 11 может выполнять из data annotations вообще без фильтра.

## Форма, которую стоит запомнить

Добавление endpoint filter сводится к `.AddEndpointFilter(...)` на конечной точке или `MapGroup`, встроенному делегату для разовых случаев или классу `IEndpointFilter` для переиспользования, `context.GetArgument<T>(index)` (или `context.Arguments`) для чтения привязанных значений и `await next(context)` для продолжения против возврата `IResult` для короткого замыкания. Помните, что зависимости конструктора приходят из внедрения зависимостей, но сам тип фильтра не является зарегистрированным сервисом, что наложенные фильтры вкладываются FIFO на входе и FILO на выходе, что фильтры группы оборачивают фильтры конечной точки, и что `AddEndpointFilterFactory` существует для редкого случая, когда вам нужно исследовать сигнатуру обработчика. Это вся поверхность целиком, и каждая строка выше выполняется на .NET 8 вплоть до .NET 11 без изменений.

## Связанное

- [Как организовать конечные точки minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Как валидировать тела запросов в minimal API без контроллеров в ASP.NET Core 11](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)
- [Как настроить ответы об ошибках валидации minimal API с помощью IProblemDetailsService в ASP.NET Core 11](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [Как вернуть типизированное объединение Results из конечной точки minimal API в ASP.NET Core 11](/ru/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [Minimal API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Источники

- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters)
- [IEndpointFilter interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.iendpointfilter)
- [EndpointFilterInvocationContext (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterinvocationcontext)
- [RouteHandlerBuilderExtensions.AddEndpointFilter (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterextensions)
