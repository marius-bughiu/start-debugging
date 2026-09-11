---
title: "Юнионы C# в ASP.NET Core 11: тела запросов, SignalR и OpenAPI работают, query string нет"
description: "Команда ASP.NET Core описала, где типы union из C# 15 работают в .NET 11: тела запросов в minimal API и MVC, JsonHubProtocol в SignalR, Blazor и схемы anyOf в OpenAPI. Привязка из маршрута, query, заголовков и форм пока не поддерживается."
pubDate: 2026-09-11
tags:
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "signalr"
lang: "ru"
translationOf: "2026/09/csharp-unions-in-aspnetcore-11-where-binding-works"
translatedBy: "claude"
translationDate: 2026-09-11
---

10 сентября, через день после выхода .NET 11 RC 1, команда ASP.NET Core опубликовала [Use C# unions and closed hierarchies in ASP.NET Core](https://devblogs.microsoft.com/dotnet/unions-and-closed-hierarchies-in-aspnetcore/). Это первая полная карта того, где типы `union` из C# 15 действительно работают во всём веб-стеке, и ответ простой: всё, что проходит через System.Text.Json, работает, а всё остальное нет.

## Юнионы как тело запроса и возвращаемый тип

Поскольку юнионы сериализуются как их активный вариант, без обёртки и дискриминатора (это поведение появилось в [System.Text.Json в .NET 11 Preview 6](/ru/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/)), minimal API может принимать и возвращать их напрямую:

```csharp
public record Cat(string Name, string Coat);
public record Dog(string Name, string Breed);

[JsonUnion(TypeClassifier = typeof(JsonUnionTypeStructuralClassifier))]
public union UnionPet(Cat, Dog);

public union UnionIntString(int, string);

app.MapPost("/pet", ([FromBody] UnionPet pet) => TypedResults.Ok(pet));
app.MapGet("/value", () => new UnionIntString(42));
```

`UnionPet` нужен структурный классификатор, потому что оба варианта являются JSON-объектами: STJ должен посмотреть на имена свойств (`coat` или `breed`), чтобы выбрать вариант до десериализации. Такое сканирование добавляет работу на каждый запрос, а переименование свойства может незаметно изменить, какой вариант будет выбран, поэтому считайте эти имена свойств частью своего контракта.

Контроллеры MVC получают то же поведение через входные и выходные форматтеры STJ, так что параметр действия `[FromBody] UnionBoolString` или возвращаемый тип-юнион работают без дополнительной настройки.

## OpenAPI генерирует anyOf

Встроенный генератор OpenAPI в .NET 11 описывает юнион как `anyOf` с одной записью на каждый вариант:

```json
"UnionIntString": {
  "anyOf": [
    { "type": "integer", "format": "int32" },
    { "type": "string" }
  ]
}
```

Именно такая форма нужна генераторам клиентов для контрактов вроде `maxUnavailable` из Kubernetes, который принимает и `2`, и `"25%"`. До появления юнионов это моделировали собственным `JsonConverter` и написанным вручную трансформером схемы.

## SignalR и Blazor

`JsonHubProtocol` в SignalR поддерживает юнионы как параметры методов хаба, возвращаемые значения и элементы потока `IAsyncEnumerable<T>`. Протоколы хаба MessagePack и Newtonsoft.Json их не поддерживают. Blazor работает с юнионами в параметрах компонентов (внутри процесса, без сериализации), в JS interop и в сохраняемом состоянии компонентов через `PersistAsJson` / `TryTakeFromJson`.

## Где привязка заканчивается

Значения маршрута, query string, заголовки и поля форм не проходят через STJ, поэтому юнионы там не поддерживаются. Объяснение в блоге такое: простой строковый токен не даёт надёжного способа выбрать вариант. `[SupplyParameterFromQuery]` в Blazor исключён по той же причине. Обсуждение дизайна открыто в [dotnet/aspnetcore#66648](https://github.com/dotnet/aspnetcore/issues/66648).

Пока это не реализовано, привязывайте исходную строку и собирайте юнион сами:

```csharp
app.MapGet("/rollout", (string maxUnavailable) =>
    int.TryParse(maxUnavailable, out var count)
        ? new UnionIntString(count)
        : new UnionIntString(maxUnavailable));
```

На стороне тела запроса есть ещё одна ловушка. `JsonSerializerOptions.Web` разрешает читать числа из строк, поэтому когда `UnionIntString` является телом запроса, JSON-токен `"42"` подходит и под `int`, и под `string`. Возвращать такой юнион можно без проблем, но для приёма его на вход нужен собственный классификатор. У SignalR этой проблемы нет, потому что `JsonHubProtocol` не считает строковый токен возможным числом.

## Юнионы или закрытые иерархии

В статье также разобраны иерархии классов `closed` с `[JsonPolymorphic(InferClosedTypePolymorphism = true)]`, которые создают дискриминатор `$type` без перечисления каждого `[JsonDerivedType]`. Рекомендация полезная: выбирайте юнион, когда JSON-контракт должен обходиться без дискриминатора или варианты представляют собой примитивы и типы, которые вам не принадлежат, и выбирайте закрытую иерархию, когда проектируете новый API, варианты которого имеют общий базовый тип. Если вы уже на .NET 11 RC 1, оба подхода готовы к использованию в телах запросов и ответах. Шаблоны маршрутов пока лучше оставить без юнионов.
