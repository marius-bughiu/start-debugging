---
title: ".NET 8 пометить JsonSerializerOptions как readonly"
description: "Узнайте, как в .NET 8 пометить экземпляры JsonSerializerOptions как только для чтения с помощью MakeReadOnly и как проверить свойство IsReadOnly."
pubDate: 2023-09-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/net-8-mark-jsonserializeroptions-as-readonly"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8 экземпляры `JsonSerializerOptions` можно пометить как только для чтения, запретив дальнейшие изменения. Чтобы заморозить экземпляр, достаточно вызвать `MakeReadOnly` у экземпляра options.

Рассмотрим пример:

```cs
var options = new JsonSerializerOptions
{
    AllowTrailingCommas = true,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper,
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate,
};

options.MakeReadOnly();
```

Проверить, заморожен ли экземпляр, можно через свойство `IsReadOnly`.

```cs
options.IsReadOnly
```

Попытка изменить экземпляр `JsonSerializerOptions` после того, как он был помечен как только для чтения, приводит к `InvalidOperationException`:

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
```

## Перегрузка [`MakeReadOnly(bool populateMissingResolver)`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly#system-text-json-jsonserializeroptions-makereadonly\(system-boolean\))

Если в `populateMissingResolver` передать `true`, метод при необходимости добавит к вашему `JsonSerializerOptions` стандартный резолвер на основе рефлексии. Будьте осторожны при [использовании этого метода в trimmed / Native AOT-приложениях: он притянет связанные с рефлексией сборки и включит их в вашу сборку](/2023/10/system-text-json-disable-reflection-based-serialization/).
