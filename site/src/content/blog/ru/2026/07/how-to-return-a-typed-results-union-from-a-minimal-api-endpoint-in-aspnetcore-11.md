---
title: "Как вернуть типизированное объединение Results<T1, T2> из эндпоинта minimal API в ASP.NET Core 11"
description: "Объявите тип возврата обработчика как Results<Ok<T>, NotFound> и возвращайте TypedResults.Ok / TypedResults.NotFound: объединение даёт проверку на этапе компиляции того, что обработчик возвращает только то, что объявляет, и само описывает себя для OpenAPI, так что вам никогда не придётся писать .Produces вручную. Рассматриваются асинхронные обработчики, ограничение в шесть типов и тестирование в ASP.NET Core 11."
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "openapi"
lang: "ru"
translationOf: "2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-14
---

Когда эндпоинт minimal API может ответить в нескольких формах, скажем `200 OK` с сущностью или `404 Not Found`, когда её нет, соблазн велик объявить обработчик возвращающим `IResult` и вызывать `Results.Ok(...)` или `Results.NotFound()`. Это компилируется, но отбрасывает те две вещи, которые `IResult` нести не может: компилятор больше не проверяет, что вы возвращаете только те результаты, которые задумали, а OpenAPI понятия не имеет, что `404` вообще возможен, если только вы не напишете `.Produces(404)` вручную у эндпоинта. Решение это тип объединения `Results<TResult1, TResult2, ...>` из `Microsoft.AspNetCore.Http.HttpResults`. Объявите обработчик как `Results<Ok<Todo>, NotFound>`, возвращайте конкретные значения `TypedResults.Ok(todo)` и `TypedResults.NotFound()`, и объединение само описывает себя для OpenAPI, пока компилятор отклоняет любую ветку, которая возвращает то, чего вы не перечислили. Всё нижеследующее ориентировано на .NET 11 с `Microsoft.NET.Sdk.Web` и C# 14; объединение ведёт себя идентично начиная с .NET 7, так что тот же код работает без изменений на .NET 10 GA.

## Почему IResult теряет ваши метаданные OpenAPI

Начните с версии, которую большинство пишет первой. Обработчик возвращает `IResult`, потому что это единственный тип, подходящий обеим веткам:

```csharp
// .NET 11, C# 14 -- Program.cs
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? Results.NotFound()
        : Results.Ok(todo);
});
```

Это работает во время выполнения, и именно поэтому существует `Results`: каждый помощник статического класса `Results` возвращает `IResult`, так что компилятор охотно выводит `IResult` как тип возврата делегата, даже когда ветки производят `200` и `404`. Цена проявляется в вашем документе OpenAPI. Фреймворк исследует объявленный тип возврата, чтобы построить раздел ответов спецификации, и всё, что он видит, это `IResult`, интерфейс, который ничего не говорит о кодах состояния или полезной нагрузке. Swagger UI показывает единственный недокументированный `200` и вообще никакого `404`. Чтобы получить точную спецификацию, вам приходится аннотировать эндпоинт вручную:

```csharp
// .NET 11, C# 14 -- the manual annotation IResult forces on you
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null ? Results.NotFound() : Results.Ok(todo);
})
.Produces<Todo>(StatusCodes.Status200OK)
.Produces(StatusCodes.Status404NotFound);
```

Эти вызовы `.Produces` чистое дублирование. Они повторяют то, что тело обработчика уже решает, и ничто не удерживает их в синхронности. Добавьте ветку `400` через полгода, и спецификация всё ещё будет утверждать, что эндпоинт возвращает только `200` или `404`, потому что метаданные живут в другом месте, нежели код, который их производит. Именно этот дрейф устраняет типизированное объединение.

## Объявите объединение и возвращайте TypedResults

Статический класс `TypedResults` это типизированный двойник `Results`. Там, где `Results.Ok(x)` возвращает `IResult`, `TypedResults.Ok(x)` возвращает конкретный `Ok<T>` из пространства имён `Microsoft.AspNetCore.Http.HttpResults`, а `TypedResults.NotFound()` возвращает `NotFound`. Каждый из этих конкретных типов реализует `IEndpointMetadataProvider`, так что каждый знает, как описать себя для OpenAPI. Тип `Results<TResult1, TResult2>` связывает их в единый объявленный тип возврата. Преобразование эндпоинта выше это три шага:

1. **Объявите тип возврата обработчика как объединение.** Перечислите каждый результат, который обработчик может произвести, в любом порядке: `Results<Ok<Todo>, NotFound>`. Для асинхронного обработчика оберните его в `Task<>`: `async Task<Results<Ok<Todo>, NotFound>>`.
2. **Возвращайте помощники `TypedResults`, а не `Results`.** Замените `Results.Ok` на `TypedResults.Ok`, а `Results.NotFound` на `TypedResults.NotFound`. Каждый возвращает свой конкретный тип реализации.
3. **Удалите вызовы `.Produces`.** Теперь объединение несёт метаданные, так что ручные аннотации избыточны и должны уйти, иначе они устареют.

Вот эндпоинт после преобразования:

```csharp
// .NET 11, C# 14 -- Program.cs
using Microsoft.AspNetCore.Http.HttpResults;

app.MapGet("/todos/{id}", async Task<Results<Ok<Todo>, NotFound>> (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()
        : TypedResults.Ok(todo);
});
```

Никакого `.Produces`, и документ OpenAPI теперь перечисляет `200` со схемой `Todo` и `404` без тела, сгенерированные прямо из типа возврата. Официальная документация излагает компромисс прямо: использовать `TypedResults` с объединением многословнее, чем возвращать `IResult`, "but that's the trade-off for having the type information be statically available and thus capable of self-describing to OpenAPI". Если вы запускаете встроенный генератор документов OpenAPI, рассмотренный в [как предоставить OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/), эти метаданные попадают в сгенерированный JSON без дополнительной настройки.

## Как объединение действительно компилируется

Часть, которая делает это эргономичным, а не мучительным, это неявное преобразование. `Results<Ok<Todo>, NotFound>` определяет оператор неявного приведения от каждого из своих обобщённых аргументов к самому объединению. Когда ваш обработчик возвращает `TypedResults.Ok(todo)`, который является `Ok<Todo>`, компилятор неявно преобразует его в объединение. Вы никогда сами не конструируете `Results<...>` и никогда не пишете приведение; вы возвращаете конкретный результат, и преобразование невидимо. Вот почему тернарный оператор в примере работает: обе ветки производят тип, который объединение может поглотить, так что всё выражение типизируется как объединение.

Отсюда же берётся и безопасность на этапе компиляции. Поскольку объединение определяет преобразования только от перечисленных вами типов, возврат чего-либо ещё это ошибка компиляции, а не сюрприз во время выполнения. Добавьте ветку, которая возвращает `TypedResults.BadRequest()`, не добавив `BadRequest` в объединение, и сборка провалится:

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();   // error: BadRequest is not in the union
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

Компилятор сообщает вам, что объявленные результаты и возвращаемые результаты расходятся, так что контракт эндпоинта и его реализация никогда не смогут молча разойтись. Исправьте это, добавив тип, который вы действительно возвращаете:

```csharp
// .NET 11, C# 14 -- compiles, and OpenAPI now shows 200, 404, and 400
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound, BadRequest> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

Обратите внимание, что синхронный обработчик здесь не нуждается в обёртке `Task<>`, но всё же должен объявлять полный тип возврата объединения явно. Компилятор не будет выводить "наилучший общий тип" среди `Ok<Order>`, `NotFound` и `BadRequest` самостоятельно, что как раз и есть причина, по которой эндпоинт, возвращавший `IResult`, компилировался без нареканий, а этот требует, чтобы вы прописали объединение.

## Почему синхронной версии нужен объявленный тип

Стоит понять ту ошибку, с которой вы столкнётесь, если попытаетесь позволить выводу типов сделать работу. Это не компилируется:

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()   // NotFound
        : TypedResults.Ok(todo);    // Ok<Todo>
});
```

`TypedResults.Ok` и `TypedResults.NotFound` возвращают разные конкретные типы, и компилятор отказывается выводить общий тип для условного выражения, так что у лямбды нет выводимого типа возврата. Версия с `Results` того же кода компилировалась только потому, что каждый помощник `Results` уже типизирован как `IResult`, давая тернарному оператору очевидный общий тип. С `TypedResults` вы платите за более богатую информацию о типах, объявляя тип возврата сами, будь то `Results<Ok<Todo>, NotFound>` для синхронного обработчика или `Task<Results<Ok<Todo>, NotFound>>` для асинхронного. Это объявление не шаблонный код, который можно пропустить; это то, что фреймворк читает, чтобы построить вашу спецификацию OpenAPI.

## Выигрыш в тестировании

Поскольку обработчик теперь возвращает конкретный тип вместо `IResult`, модульные тесты могут проверять точный результат без поднятия HTTP-сервера и без приведения. Извлеките обработчик в именованный статический метод, чтобы тест мог вызвать его напрямую:

```csharp
// .NET 11, C# 14 -- TodoEndpoints.cs
public static async Task<Results<Ok<Todo>, NotFound>> GetTodo(int id, TodoDb db)
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()
        : TypedResults.Ok(todo);
}
```

Тест затем проверяет конкретный тип и обращается напрямую к его типизированному `Value`, без рефлексии над `IResult` и без HTTP-обхода:

```csharp
// .NET 11, C# 14 -- xUnit
[Fact]
public async Task GetTodo_ReturnsOk_WhenFound()
{
    await using var db = new MockDb().CreateDbContext();
    db.Todos.Add(new Todo { Id = 1, Title = "Write the union post" });
    await db.SaveChangesAsync();

    var result = await TodoEndpoints.GetTodo(1, db);

    var ok = Assert.IsType<Ok<Todo>>(result.Result);
    Assert.Equal(1, ok.Value!.Id);
}
```

Объединение предоставляет фактический результат через своё свойство `Result`, а `Ok<Todo>` предоставляет полезную нагрузку через строго типизированное `Value`. Это и есть преимущество "improve unit testing", которое документация перечисляет для `TypedResults`: с `Results` вам пришлось бы сначала преобразовать `IResult` обратно в конкретный тип, прежде чем что-либо о нём утверждать. Здесь тип уже конкретный, так что проверка это одна строка. Если ваш обработчик достаточно мал, чтобы поместиться прямо в `MapGet`, извлечение его в статический метод исключительно ради тестируемости это разумный рефакторинг; сравнение [minimal API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) разбирает, когда такая структура оправдывается.

## Потолок в шесть типов и как оставаться под ним

`Results<>` определён с двумя и до шести обобщённых параметров, так что один эндпоинт может объявить не более шести различных типов результата. На практике этого с избытком: эндпоинт, возвращающий `Ok`, `Created`, `NotFound`, `BadRequest`, `Conflict` и `ValidationProblem`, уже на пределе и, вероятно, делает слишком много. Расширение потолка запрашивалось (отслеживается как [dotnet/aspnetcore#61706](https://github.com/dotnet/aspnetcore/issues/61706)), но пока шесть это стена.

Если вы действительно упрётесь в него, у вас есть два разумных выхода. Первый свести связанные сбои к одному типу проблемы: вместо перечисления `BadRequest`, `Conflict` и `UnprocessableEntity` по отдельности возвращайте `ProblemHttpResult` через `TypedResults.Problem(...)` и кодируйте различие в полезной нагрузке RFC 9457, которая имеет ту же форму, что уже выдаёт встроенная валидация, рассмотренная в [как настроить ответы об ошибках валидации minimal API](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/). Второй вернуться к `IResult` для этого одного эндпоинта и добавить аннотации `.Produces` вручную, приняв ручные метаданные как цену за более чем шесть веток. Не прибегайте ни к одному из них, пока действительно не превысили шесть; большинство эндпоинтов комфортно живут с двумя или тремя.

## Подводные камни, о которые спотыкаются

- **`Ok` и `Ok<T>` это разные типы.** `TypedResults.Ok()` без аргумента возвращает `Ok` (`200` без тела); `TypedResults.Ok(value)` возвращает `Ok<T>`. Если ваше объединение перечисляет `Ok<Todo>`, а ветка вызывает беспараметрический `TypedResults.Ok()`, оно не скомпилируется, потому что `Ok` это не `Ok<Todo>`. Перечисляйте точный вариант, который производит каждая ветка.
- **Тип возврата объединения должен быть прописан полностью.** Нет ни сокращения, ни вывода. `async Task<Results<Ok<Todo>, NotFound>>` многословен, и это намеренно: фреймворк читает именно это объявление, чтобы построить спецификацию, так что сокращать его не вариант.
- **Возвращённый обработчиком `Problem` всё равно обходит `CustomizeProblemDetails`.** Помещение `ProblemHttpResult` в объединение документирует ответ, но `ProblemDetails`, который вы конструируете и возвращаете из обработчика, сериализуется напрямую и не проходит через `IProblemDetailsService`. Если вы полагаетесь на глобальный колбэк `CustomizeProblemDetails`, чтобы проставить `traceId`, он для них не сработает; этот механизм расписан в [посте о настройке IProblemDetailsService](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).
- **Порядок в списке обобщённых типов не важен, но это ваша документация.** `Results<Ok<Todo>, NotFound>` и `Results<NotFound, Ok<Todo>>` ведут себя идентично. Выберите последовательный порядок (успех первым это общепринятое соглашение), чтобы читатель мог окинуть контракт эндпоинта одним взглядом.
- **Не относящиеся к статусу метаданные вы всё равно добавляете явно.** Объединение покрывает типы ответов и коды состояния. Такие вещи, как `.WithName`, `.WithTags`, `.RequireAuthorization` или пользовательский `Produces` для нестандартного типа содержимого, это отдельные заботы, и они по-прежнему идут на билдер эндпоинта, ровно как и у любого другого эндпоинта, включая настройку JWT в [как настроить аутентификацию JWT bearer в minimal API](/ru/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

Ментальная модель, которую стоит держать: `IResult` это аварийный выход, который возвращает что угодно и не документирует ничего, тогда как `Results<T1, TN>` это объявленный контракт, который компилятор навязывает, а OpenAPI читает. Прибегайте к объединению всякий раз, когда у эндпоинта более одного возможного ответа, возвращайте соответствующий помощник `TypedResults` из каждой ветки и позвольте системе типов держать ваш обработчик, ваши тесты и вашу спецификацию в согласии. Когда у эндпоинта действительно единственная форма ответа, пропустите объединение и объявите этот один конкретный тип напрямую, например `Task<Ok<Todo[]>>`; объединение оправдывает свою многословность, только когда есть более одной ветки для документирования.

## Related

- [Как настроить ответы об ошибках валидации minimal API с помощью IProblemDetailsService в ASP.NET Core 11](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) для формирования `ProblemHttpResult`, который вы помещаете в объединение.
- [Как предоставить OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) о встроенном генераторе, который читает эти метаданные.
- [Как валидировать тела запросов в minimal API без контроллеров в ASP.NET Core 11](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) о результате `ValidationProblem`, который часто присоединяется к объединению.
- [Как организовать эндпоинты minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) о группировке типизированных эндпоинтов и применении общих метаданных.
- [Minimal API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) о том, как соглашения о типе возврата различаются между двумя моделями.

## Sources

- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0) (`TypedResults` против `Results`, объединение `Results<TResult1, TResultN>`, операторы неявного приведения, проверка на этапе компиляции, требование асинхронного `Task<>` и пример модульного теста).
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults) (`Ok<T>`, `NotFound`, `BadRequest`, `Results<TResult1, TResult2>` вплоть до перегрузки с шестью параметрами).
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672) (изначальный дизайн объединения `Results<>`).
- dotnet/aspnetcore, [Extend Results in TypedResults to support more than 6 types (issue #61706)](https://github.com/dotnet/aspnetcore/issues/61706) (потолок в шесть типов и запрос на его повышение).
