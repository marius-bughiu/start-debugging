---
title: "System.Text.Json в .NET 11 Preview 3 добавляет PascalCase и политики именования на уровне члена"
description: ".NET 11 Preview 3 завершает историю с политиками именования в System.Text.Json: JsonNamingPolicy.PascalCase, атрибут [JsonNamingPolicy] на уровне члена и дефолт [JsonIgnore] на уровне типа для более чистых DTO."
pubDate: 2026-04-18
tags:
  - "dotnet-11"
  - "system-text-json"
  - "csharp"
  - "serialization"
lang: "ru"
translationOf: "2026/04/system-text-json-11-pascalcase-per-member-naming"
translatedBy: "claude"
translationDate: 2026-04-24
---

[.NET 8 ввёл](https://startdebugging.net/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/) первую партию встроенных политик именования для `System.Text.Json`: camel, snake и kebab в обоих регистрах. Preview 3 в .NET 11 закрывает последний очевидный пробел и добавляет ещё две ручки, благодаря которым самописные `JsonConverter` становятся не нужны для большинства форм DTO. Работа вышла в [dotnet/runtime #124644](https://github.com/dotnet/runtime/pull/124644), [#124645](https://github.com/dotnet/runtime/pull/124645) и [#124646](https://github.com/dotnet/runtime/pull/124646).

## PascalCase присоединяется к встроенным политикам

`JsonNamingPolicy.PascalCase` - новинка Preview 3 и встаёт рядом с уже существующими `CamelCase`, `SnakeCaseLower`, `SnakeCaseUpper`, `KebabCaseLower` и `KebabCaseUpper`. Это политика, которую вы хотите, когда сторона .NET уже использует PascalCase-свойства, и JSON-контракт тоже PascalCase, что обычно для Azure Management API, старых SOAP-to-REST шлюзов и некоторых форм Microsoft Graph:

```csharp
using System.Text.Json;

var options = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.PascalCase
};

var json = JsonSerializer.Serialize(
    new { firstName = "Ada", age = 37 },
    options);
// {"FirstName":"Ada","Age":37}
```

До Preview 3 вы либо оставляли дефолт (без политики), либо писали однострочный кастомный сабкласс `JsonNamingPolicy`. Теперь он в одной линейке с другими пресетами и чисто делает round-trip с имеющимся перечислением `JsonKnownNamingPolicy`.

## Переопределение именования на одном члене

Более интересное изменение - `[JsonNamingPolicy]` теперь атрибут уровня члена. Раньше политика жила на `JsonSerializerOptions` и применялась ко всему графу, поэтому одно исключение PascalCase в контракте, в остальном camelCase, означало либо `[JsonPropertyName]` на каждом «неудобном» свойстве, либо полностью кастомную политику. В .NET 11 Preview 3 политики можно смешивать внутри одного типа:

```csharp
using System.Text.Json.Serialization;

public sealed class Webhook
{
    public string Url { get; set; } = "";

    [JsonNamingPolicy(JsonKnownNamingPolicy.KebabCaseLower)]
    public string RetryStrategy { get; set; } = "exponential";

    [JsonNamingPolicy(JsonKnownNamingPolicy.SnakeCaseLower)]
    public int MaxAttempts { get; set; } = 5;
}
```

При `PropertyNamingPolicy = JsonNamingPolicy.CamelCase` `Url` сериализуется в `url`, `RetryStrategy` в `retry-strategy`, а `MaxAttempts` в `max_attempts`. Это убирает много шума от `[JsonPropertyName]` по свойствам, когда одна внешняя система непоследовательна.

## Дефолты [JsonIgnore] на уровне типа

Сопутствующее изменение - `[JsonIgnore(Condition = ...)]` теперь допустим на самом типе, а не только на свойствах ([dotnet/runtime #124646](https://github.com/dotnet/runtime/pull/124646)). Поставьте его на класс - и условие становится дефолтом для каждого свойства внутри типа:

```csharp
using System.Text.Json.Serialization;

[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
public sealed class PatchRequest
{
    public string? Name { get; set; }
    public string? Email { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public bool? IsActive { get; set; }
}
```

Каждое nullable-свойство в `PatchRequest` теперь выпадает из payload, когда оно null, - это именно то, что нужно форме запроса JSON Merge Patch. Переопределение `IsActive` снова включает его, потому что явный `false` там несёт смысл. Тот же паттерн раньше требовал `JsonIgnoreCondition.WhenWritingNull` на каждом свойстве отдельно или `DefaultIgnoreCondition` в опциях сериализатора, что затем гнало все остальные DTO через то же правило.

## Почему маленькая поверхность имеет значение

Управление на уровне атрибутов - это то, что позволяет командам заменять кастомные converters стоковым `System.Text.Json`. PascalCase убирает последнюю причину «напиши свою политику», именование на уровне члена удаляет класс шаблонности `[JsonPropertyName]`, а `[JsonIgnore]` на уровне типа позволяет DTO для PATCH и событий настроить свой дефолт в одном месте. Все три изменения также работают с source generator, поэтому Native AOT-приложения получают их без дополнительной настройки. [Заметки по библиотекам Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/libraries.md) отслеживают остальные обновления `System.Text.Json`, выходящие в этом месяце.
