---
title: "Как привязать сложный объект из строки запроса с помощью [AsParameters] в minimal API в ASP.NET Core 11"
description: "Поставьте [AsParameters] на класс или record, чтобы привязать целый фильтр из строки запроса в minimal API в ASP.NET Core 11. Разбираем значения по умолчанию, массивы, перечисления, вложенные объекты, валидацию, OpenAPI и ошибку генератора Native AOT с позиционными record."
pubDate: 2026-09-13
template: how-to
tags:
  - "aspnetcore"
  - "minimal-apis"
  - "dotnet-11"
  - "csharp"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-bind-a-complex-query-string-object-with-asparameters-in-a-minimal-api"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Коротко:** объявите ключи строки запроса как свойства класса (или как параметры конструктора record) и поставьте `[AsParameters]` на параметр обработчика: `app.MapGet("/products", ([AsParameters] ProductFilter filter) => ...)`. ASP.NET Core разворачивает тип в отдельные параметры, поэтому `?search=lamp&page=2&tags=a&tags=b` привязывается к `Search`, `Page` и `Tags` по имени без учёта регистра. Работает это только с плоскими типами: вложенному объекту нужен собственный `TryParse` или `BindAsync`, а необязательное значение должно допускать null или иметь значение по умолчанию в конструкторе, потому что инициализатор свойства вроде `= 1` не делает свойство необязательным.

Всё описанное ниже проверено на .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`, ASP.NET Core `11.0.0-rc.1.26425.128`). `[AsParameters]` появился в .NET 7, и его правила с тех пор не менялись, так что тот же код работает на .NET 8, 9 и 10. Единственное исключение, о котором стоит знать, это ошибка генератора исходного кода в пути Native AOT, и она воспроизводится также на SDK 10.0.302.

## Почему `[FromQuery] ProductFilter` не работает

Тем, кто пришёл из контроллеров MVC, рука сама пишет `[FromQuery] ProductFilter filter`. В minimal API на .NET 11 это даже не компилируется. Анализатор [ASP0020](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020) сообщает об ошибке сборки:

```text
error ASP0020: Parameter 'f' of type ProductFilter should define a bool
TryParse(string, IFormatProvider, out ProductFilter) method, or implement IParsable<ProductFilter>
```

Если подавить анализатор, приложение упадёт уже при запуске, в момент построения конечной точки:

```text
InvalidOperationException: f must have a valid TryParse method to support converting from a string.
No public static bool ProductFilter.TryParse(string, out ProductFilter) method found for f.
```

Если убрать атрибут, всё становится ещё запутаннее. Сложный тип без источника привязки считается телом запроса, а `MapGet` выведенные тела запрещает:

```text
InvalidOperationException: Body was inferred but the method does not allow inferred body parameters.
```

Так задумано. Minimal API не используют рекурсивный механизм привязки моделей из MVC, а `[FromQuery]` означает "один ключ строки запроса, преобразованный через `TryParse`". В [документации по привязке параметров](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) сказано, что `AsParametersAttribute` обеспечивает простую привязку параметров к типам, а не сложную или рекурсивную привязку моделей. На деле он разворачивает тип: фабрика делегатов запроса рассматривает каждый член типа как отдельный параметр обработчика и затем применяет к каждому члену обычные правила (маршрут, строка запроса, заголовок, сервисы, специальные типы). Эта модель объясняет всё поведение, описанное в остальной части статьи.

## Привязка фильтра из строки запроса по шагам

1. Создайте тип с одним членом на каждый ключ строки запроса.
2. Сделайте каждый необязательный член допускающим null или задайте ему значение по умолчанию в параметре конструктора record.
3. Поставьте `[AsParameters]` на параметр обработчика.
4. Переименуйте отдельные члены или смените их источник с помощью `[FromQuery(Name = ...)]`, `[FromRoute]` или `[FromHeader]`.
5. Если нужны проверки диапазонов, добавьте DataAnnotations и вызовите `AddValidation()`.

Вот фильтр, который я использовал:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1), C# 15, <Nullable>enable</Nullable>
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/products", ([AsParameters] ProductFilter f) => f);

app.Run();

enum SortOrder { Asc, Desc }

class ProductFilter
{
    public string? Search { get; set; }
    public int? Page { get; set; }
    public int? PageSize { get; set; }
    public SortOrder? Sort { get; set; }
    public DateOnly? Since { get; set; }
    public string[] Tags { get; set; } = [];
    [FromQuery(Name = "q")] public string? Keyword { get; set; }
}
```

И реальные ответы:

```text
GET /products?search=lamp&page=2&pageSize=10&sort=Desc&since=2026-01-31&tags=a&tags=b&q=kw
200 {"search":"lamp","page":2,"pageSize":10,"sort":1,"since":"2026-01-31","tags":["a","b"],"keyword":"kw"}

GET /products?SEARCH=lamp&PAGE=3
200 {"search":"lamp","page":3,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}

GET /products
200 {"search":null,"page":null,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}
```

Ключ строки запроса совпадает с именем члена и сравнивается без учёта регистра, а `[FromQuery(Name = "q")]` переопределяет его для одного члена. Повторяющиеся ключи заполняют массив. `DateOnly` разбирает строку ISO в формате `yyyy-MM-dd`. Член любого типа со статическим `TryParse` (все примитивы, `Guid`, `DateTimeOffset`, перечисления и ваши собственные типы `IParsable<T>`) привязывается из одного ключа.

## Обязательные и необязательные члены: ловушка инициализатора свойства

Эту ошибку я вижу чаще всего. Выглядит как класс с разумными значениями по умолчанию:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
class RequiredFilter
{
    public int Page { get; set; } = 1;
    public bool InStock { get; set; }
    public string Search { get; set; } = "";
}
```

`GET /required` без строки запроса возвращает `400`:

```text
BadHttpRequestException: Required parameter "int Page" was not provided from query string.
```

Фабрика решает, является ли член необязательным, по тому, допускает ли он null, а для параметров конструктора ещё и по объявленному значению по умолчанию. Инициализатор свойства представляет собой просто код в конструкторе, невидимый для рефлексии, поэтому свойство типа `int`, `bool` или `string`, не допускающее null, остаётся обязательным, что бы вы ему ни присвоили. Сгенерированный документ OpenAPI с этим согласен и помечает все три как `required: true`.

Исправить это можно двумя способами. Сделайте члены допускающими null и применяйте значение по умолчанию в обработчике (`f.Page ?? 1`) или перейдите на позиционный record, где значения по умолчанию в конструкторе учитываются:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
record ProductQuery(string? Search, int Page = 1, int PageSize = 20,
    SortOrder Sort = SortOrder.Asc, string[]? Tags = null);

app.MapGet("/products-record", ([AsParameters] ProductQuery q) => q);
```

```text
GET /products-record         -> {"search":null,"page":1,"pageSize":20,"sort":0,"tags":[]}
GET /products-record?page=4  -> {"search":null,"page":4,"pageSize":20,"sort":0,"tags":[]}
```

Обратите внимание, что `Tags` вернулся как `[]`, а не `null`, несмотря на значение по умолчанию `= null`: массив без подходящих ключей привязывается как пустой массив. `record struct PagingStruct(int Page = 1, int PageSize = 20)` ведёт себя точно так же и вернул `{"page":1,"pageSize":20}`. В документации отмечено, что `struct` может быть производительнее, чем класс `record`, поскольку избавляет от выделения памяти на каждый запрос. Я это не измерял, так что считайте это утверждением документации.

Полезно знать, как фабрика выбирает члены. Логика в [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) такова: если у типа есть единственный открытый конструктор с параметрами, привязываются его параметры (сопоставляемые со свойствами по имени). Иначе используется конструктор без параметров и привязывается каждое **записываемое** свойство. Свойство только для чтения в классе без такого конструктора молча пропускается. Два открытых конструктора с параметрами приводят к ошибке `Only a single public parameterized constructor is allowed for type 'TwoCtors'.`, а абстрактный тип к ошибке `The abstract type 'AbstractFilter' is not supported.`

## Значения маршрута, заголовки и сервисы в одном типе

Поскольку каждый член проходит через обычные правила привязки, один тип с `[AsParameters]` может собрать весь список аргументов, а не только строку запроса:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
app.MapGet("/tenants/{tenantId:int}/orders", ([AsParameters] OrderRequest r) => new
{
    r.TenantId, r.Region, r.Status, r.Ids, r.UserAgent,
    Logger = r.Logger.GetType().Name,
    Path = r.Http.Request.Path.Value,
    CanCancel = r.Ct.CanBeCanceled
});

enum OrderStatus { Pending, Shipped, Cancelled }

class OrderRequest
{
    [FromRoute(Name = "tenantId")] public int TenantId { get; set; }
    [FromHeader(Name = "X-Region")] public string? Region { get; set; }
    public OrderStatus? Status { get; set; }
    public int[] Ids { get; set; } = [];
    [FromHeader(Name = "User-Agent")] public string? UserAgent { get; set; }
    public ILogger<OrderRequest> Logger { get; set; } = default!;   // from DI
    public HttpContext Http { get; set; } = default!;              // special type
    public CancellationToken Ct { get; set; }                      // RequestAborted
}
```

```text
GET /tenants/42/orders?status=Shipped&ids=1&ids=2   (X-Region: eu-west)
200 {"tenantId":42,"region":"eu-west","status":1,"ids":[1,2],"userAgent":"curl/8.7.1",
     "logger":"Logger`1","path":"/tenants/42/orders","canCancel":true}
```

Именно с этого сценария начинается собственный пример Microsoft: свернуть длинную сигнатуру обработчика (`int id, TodoDb db, ...`) в один тип. Это хорошо сочетается с [группировкой конечных точек через `MapGroup`](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), где префикс маршрута уже несёт значение `{tenantId}`.

## Некорректные значения, чувствительные к регистру перечисления и списки через запятую

Значение, для которого `TryParse` не срабатывает, даёт `400` ещё до запуска обработчика:

```text
GET /products?page=abc    -> 400 Failed to bind parameter "Nullable<int> Page" from "abc".
GET /products?sort=Desc   -> 200
GET /products?sort=desc   -> 400 Failed to bind parameter "Nullable<SortOrder> Sort" from "desc".
```

Результат с перечислением многих удивляет: привязка использует перегрузку `Enum.TryParse` с учётом регистра, поэтому `desc` отклоняется, а `Desc` работает. Если клиенты присылают значения в нижнем регистре, привяжите `string?` и сами вызовите `Enum.TryParse<SortOrder>(value, ignoreCase: true, out var sort)` или оберните перечисление в небольшой тип с собственным `TryParse`.

В среде Development страница исключений для разработчика показывает приведённый выше текст `BadHttpRequestException`. Вне Development клиент получает голый `400`, а причина попадает только в отладочный журнал, так что не полагайтесь на это сообщение как на контракт своего API.

Списки через запятую не разбиваются:

```text
GET /products?tags=a,b              -> 200 "tags":["a,b"]   (one element)
GET /tenants/42/orders?ids=1,2      -> 400 Failed to bind parameter "int[] Ids" from "1,2".
```

Массивы привязываются только из повторяющихся ключей (`?ids=1&ids=2`). Если нужно принимать `ids=1,2`, привяжите `string?` и разбейте строку сами или дайте собственному типу `TryParse`, который её разбивает.

## Вложенным объектам нужен собственный парсер

Вот структура, которую на самом деле хотят привязать:

```csharp
class Money { public decimal Min { get; set; } public decimal Max { get; set; } }
class NestedFilter { public string? Q { get; set; } public Money? Price { get; set; } }
```

`Price` представляет собой сложный тип без источника привязки, поэтому фабрика считает его телом запроса, и для `GET` конечная точка падает при запуске с той же ошибкой `Body was inferred but the method does not allow inferred body parameters.`, что и раньше. Ключи в стиле `?price.min=10`, которые понимает механизм привязки моделей MVC, здесь ничего не значат. `[AsParameters]` на вложенном члене тоже не помогает. Он выбрасывает `NotSupportedException: Nested AsParametersAttribute is not supported and should be used only for handler parameters.`

Есть три варианта, в том порядке, в котором я бы к ним прибегал.

**Развернуть в плоскую структуру.** `decimal? MinPrice` и `decimal? MaxPrice` скучно, зато даёт лучший вывод OpenAPI и не требует кода.

**Разбирать один ключ через `IParsable<T>`.** Член, тип которого имеет статический `TryParse`, привязывается из одного ключа:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1), C# 15
using System.Diagnostics.CodeAnalysis;
using System.Globalization;

record PriceRange(decimal Min, decimal Max) : IParsable<PriceRange>
{
    public static bool TryParse(string? s, IFormatProvider? provider,
        [MaybeNullWhen(false)] out PriceRange result)
    {
        result = null;
        if (s?.Split('-', 2) is not [var lo, var hi]) return false;
        if (!decimal.TryParse(lo, NumberStyles.Number, CultureInfo.InvariantCulture, out var min)) return false;
        if (!decimal.TryParse(hi, NumberStyles.Number, CultureInfo.InvariantCulture, out var max)) return false;
        if (min > max) return false;
        result = new PriceRange(min, max);
        return true;
    }

    public static PriceRange Parse(string s, IFormatProvider? provider) =>
        TryParse(s, provider, out var r) ? r : throw new FormatException($"'{s}' is not a price range.");
}
```

`?price=10-50` привязывается к `{"min":10,"max":50}`, а `?price=50-10` возвращает `400 Failed to bind parameter "PriceRange Price" from "50-10".`

**Читать ключи с точками через `BindAsync`.** Если формат передачи жёстко задан как `budget.min=5&budget.max=99`, реализуйте `BindAsync(HttpContext, ParameterInfo)`. Внутри типа с `[AsParameters]` `parameter.Name` содержит имя свойства, так что префикс достаётся бесплатно:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
using System.Globalization;
using System.Reflection;

record DottedRange(decimal? Min, decimal? Max)
{
    public static ValueTask<DottedRange?> BindAsync(HttpContext context, ParameterInfo parameter)
    {
        var q = context.Request.Query;
        decimal? Read(string key) => decimal.TryParse(q[$"{parameter.Name}.{key}"],
            NumberStyles.Number, CultureInfo.InvariantCulture, out var v) ? v : null;
        var (min, max) = (Read("min"), Read("max"));
        return ValueTask.FromResult(min is null && max is null ? null : new DottedRange(min, max));
    }
}

class RangeFilter
{
    public PriceRange? Price { get; set; }
    public DottedRange? Budget { get; set; }
    public string? Q { get; set; }
}
```

```text
GET /by-range?price=10-50&budget.min=5&budget.max=99&q=chair
200 {"price":{"min":10,"max":50},"budget":{"min":5,"max":99},"q":"chair"}
```

Цена `BindAsync` в документации API: встроенный генератор OpenAPI указал для этой конечной точки `Price` (как строку) и `Q`, а `Budget` полностью пропустил. Если его нужно задокументировать, добавьте его с помощью [преобразователя операций](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

Ещё одно ограничение: сам параметр с `[AsParameters]` не может допускать null. `[AsParameters] ProductFilter? f` падает с ошибкой `The nullable type 'ProductFilter' is not supported, mark the parameter as non-nullable.`

## Валидация и вывод OpenAPI

Встроенная валидация minimal API понимает члены `[AsParameters]`, включая параметры конструктора record. При зарегистрированном `builder.Services.AddValidation()` (та же настройка, что и при [валидации тел запросов](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)):

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
using System.ComponentModel.DataAnnotations;

record ValidatedPaging([Range(1, 1000)] int Page = 1, [Range(1, 100)] int PageSize = 20);

app.MapGet("/validated", ([AsParameters] ValidatedPaging p) => p);
```

```text
GET /validated?pageSize=500
400 {"title":"One or more validation errors occurred.","status":400,
     "errors":{"PageSize":["The field PageSize must be between 1 and 100."]}}
```

`Microsoft.AspNetCore.OpenApi` 11.0.0-rc.1 превращает тот же тип в параметры строки запроса с `minimum`, `maximum` и `default`. В .NET 10 именно эта комбинация (атрибут валидации на параметре первичного конструктора record с `[AsParameters]`) приводила к тому, что генерация документа выбрасывала `InvalidCastException`. Это была [dotnet/aspnetcore#65348](https://github.com/dotnet/aspnetcore/issues/65348), исправленная для .NET 11 в [PR #67284](https://github.com/dotnet/aspnetcore/pull/67284). Если вы всё ещё на .NET 10, поставьте атрибуты на класс со свойствами. Здесь же видна и описанная выше ловушка с массивами, только с другой стороны. Не допускающий null `string[] Tags { get; set; } = []` документируется как `required: true`, хотя среда выполнения спокойно привязывает отсутствующий ключ как пустой массив, поэтому сгенерированные клиенты будут настаивать на его отправке. Объявляйте необязательные массивы как `string[]?`, и документ пометит их необязательными.

## Native AOT: позиционные record со ссылочными типами, допускающими null, не компилируются

С `<PublishAot>true</PublishAot>` сборка включает [Request Delegate Generator](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/aot/request-delegate-generator/rdg), который заменяет фабрику времени выполнения сгенерированным кодом (этот стек описан в статье [Native AOT с minimal API](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)). Большинство перечисленных выше ошибок запуска там превращаются в предупреждения сборки: `RDG009` для вложенного `[AsParameters]`, `RDG010` для параметра, допускающего null, `RDG005` для абстрактного типа и `RDG008` для нескольких конструкторов. Это улучшение.

Но в нём есть и ошибка. Эта конечная точка:

```csharp
// .NET 11 RC 1 and SDK 10.0.302, <PublishAot>true</PublishAot> or <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
app.MapGet("/a", ([AsParameters] F f) => f.Page?.ToString() ?? "none");

record F(string? Q, int? Page);
```

не собирается, выдавая четыре копии:

```text
GeneratedRouteBuilderExtensions.g.cs: error CS8639: The typeof operator cannot be used on a nullable reference type
```

Генератор находит конструктор record, генерируя `typeof(F).GetConstructor(new[] { typeof(string?), typeof(int?) })`, а `typeof(string?)` не является допустимым C#. С `int?` проблем нет, потому что это `Nullable<int>`. Я собрал шесть вариантов одной и той же конечной точки с включённым генератором:

| Тип с `[AsParameters]` | Собирается? |
| --- | --- |
| `record F(string? Q, int? Page)` | Нет, CS8639 |
| `record F(string[]? Tags, int? Page)` | Нет, CS8639 |
| `record F(string Q = "", int? Page = null)` | Да |
| `record struct F(string? Q, int? Page)` | Да |
| `record F { public string? Q { get; init; } ... }` | Да |
| Тот же позиционный record, генератор выключен (обычная JIT-сборка) | Да |

Итак, триггер: позиционный класс `record`, у конструктора которого есть параметр ссылочного типа, допускающего null. Обычная JIT-сборка работает, поэтому проблема обычно всплывает только тогда, когда кто-то включает `PublishAot` (по документации, тримминг тоже включает генератор). Пока это не исправлено, в проектах с AOT используйте для типов с `[AsParameters]` класс с устанавливаемыми свойствами, record со свойствами `init` или позиционный `record struct`. На момент написания я не нашёл в dotnet/aspnetcore issue, отслеживающего эту ошибку.

## Похожие материалы

- [Minimal API и контроллеры в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), в том числе где механизм привязки моделей MVC всё ещё выигрывает.
- [Объединения C# в ASP.NET Core 11](/ru/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/), ещё один случай, когда строка запроса оказывается единственным источником привязки, который не работает как надо.
- [Keyset-пагинация (по курсору) в EF Core 11](/ru/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/), естественный потребитель построенного здесь фильтра постраничного вывода.
- [Почему словарь с `[FromForm]` в minimal API всегда равен null](/ru/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/), родственная проблеме вложенных объектов история из мира привязки форм.

## Источники

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) (раздел о `[AsParameters]` и список приоритетов источников привязки).
- Microsoft Learn, [справочник API `AsParametersAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.asparametersattribute).
- Microsoft Learn, [ASP0020: Complex types referenced by route parameters must be parsable](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020).
- Microsoft Learn, [диагностики Request Delegate Generator RDG009](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG009) и [RDG010](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG010).
- dotnet/aspnetcore на `v11.0.0-rc.1.26425.128`: [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) (разворачивание членов, проверка на null) и [`RequestDelegateFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (проверка вложенного `[AsParameters]`).
