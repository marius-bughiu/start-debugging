---
title: "Как организовать конечные точки Minimal API с MapGroup"
description: "Модули ресурсов и MapGroup для Minimal API: вложенные маршруты, метаданные, фильтры, аутентификация и тестирование."
pubDate: 2026-06-07
updatedDate: 2026-11-02
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

`MapGroup` объединяет общий префикс маршрута и соглашения конечных точек. API доступна с ASP.NET Core 7. Метод расширения на ресурс позволяет вынести регистрацию из `Program.cs`, не вводя контроллеры.

**Исправление — 2 ноября 2026 года:** прежний текст неверно описывал соединение слешей как простую конкатенацию и приписывал группам всю API `WebApplication`. Новый пример использует SDK 10.0.302; выполнение на .NET 11 не заявляется.

## Полный модуль ресурса

```csharp
// Program.cs in a Microsoft.NET.Sdk.Web project targeting net10.0.
using System.Collections.Concurrent;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Routing;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<TodoStore>();
var app = builder.Build();

app.MapGroup("/api").MapTodos();
app.Run();

public static class TodoEndpoints
{
    public static RouteGroupBuilder MapTodos(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/todos/").WithTags("Todos");
        group.MapGet("/{id:int}", GetTodo).WithName("GetTodo");
        group.MapPut("/{id:int}", PutTodo);
        return group;
    }

    private static Results<Ok<Todo>, NotFound> GetTodo(int id, TodoStore store) =>
        store.Items.TryGetValue(id, out var todo)
            ? TypedResults.Ok(todo)
            : TypedResults.NotFound();

    private static NoContent PutTodo(int id, Todo todo, TodoStore store)
    {
        store.Items[id] = todo;
        return TypedResults.NoContent();
    }
}

public sealed class TodoStore
{
    public ConcurrentDictionary<int, Todo> Items { get; } = new(
        new[] { new KeyValuePair<int, Todo>(1, new Todo("Write docs", false)) });
}

public record Todo(string Title, bool IsComplete);
```

Приложение предоставляет `GET /api/todos/1` и `PUT /api/todos/{id}`. Память используется для демонстрации и не сохраняется после перезапуска. Композиция маршрутов SDK 10 соединяет `/todos/` и `/{id:int}`, не создавая `/todos//{id:int}`. Единый стиль полезен, но простая конкатенация строк не описывает поведение маршрутизации.

Класс можно перенести в другой файл того же проекта. Само расположение файла не определяет работу генератора делегатов запросов. Закрытые обработчики нельзя непосредственно вызвать из отдельной тестовой сборки: проверяйте через HTTP либо выделяйте бизнес-логику в тестируемые сервисы.

## Возможности группы

`RouteGroupBuilder` реализует `IEndpointRouteBuilder` и `IEndpointConventionBuilder`. Он поддерживает вложенные маршруты, `WithTags`, `RequireAuthorization` и фильтры, но не всю API `WebApplication`. Middleware `Use...` и жизненный цикл хоста принадлежат приложению.

Явные теги организуют OpenAPI, но не генерируют и не публикуют документ. Настройте соответствующие версии средства отдельно. Имена конечных точек должны быть уникальны во всём приложении.

Вложенные префиксы соединяются; параметры внешнего маршрута доступны внутреннему обработчику. Внешние фильтры оборачивают внутренние и фильтры конечных точек. Код до `await next(context)` выполняется к обработчику, после — в обратном порядке. Порядок регистрации в одной группе также важен.

## Настройка политик

`RequireAuthorization("policy")` добавляет метаданные, но не создаёт политику, обработчик аутентификации и учётные данные. Настройте сервисы и нужное middleware. Префикс `/v1` сам по себе тоже не реализует полную политику версионирования API.

Для проверки запросов см. [встроенную валидацию и FluentValidation](/ru/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/). Native AOT зависит и от обработчиков, сериализации и зависимостей; изучите [руководство по AOT](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).

## Источники

- [ASP.NET Core route handlers and route groups](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0#route-groups)
- [Endpoint filters](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0)
- [RoutePatternFactory.Combine source, .NET 10](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Http/Routing/src/Patterns/RoutePatternFactory.cs)
- [Minimal API security](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security?view=aspnetcore-10.0)
