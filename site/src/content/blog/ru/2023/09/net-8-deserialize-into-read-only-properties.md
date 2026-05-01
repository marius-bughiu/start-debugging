---
title: ".NET 8 десериализация в свойства только для чтения"
description: "Узнайте, как в .NET 8 десериализовать JSON в свойства только для чтения без сеттера с помощью JsonObjectCreationHandling или JsonSerializerOptions."
pubDate: 2023-09-03
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/net-8-deserialize-into-read-only-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8 можно десериализовать в свойства, у которых нет аксессора `set`. Это поведение можно включить через `JsonSerializerOptions` или для конкретного типа с помощью атрибута `JsonObjectCreationHandling`.

## Через атрибут JsonObjectCreationHandling

Пометьте свой тип атрибутом `System.Text.Json.Serialization.JsonObjectCreationHandling`, передав нужную опцию параметром.

```cs
[JsonObjectCreationHandling(JsonObjectCreationHandling.Populate)]
public class Foo
{
     public int Bar { get; }
}
```

## Через JsonSerializerOptions

Установите свойство `JsonSerializerOptions.PreferredObjectCreationHandling` в `Populate` и передайте options в метод `Deserialize`.

```cs
new JsonSerializerOptions 
{ 
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate
};
```
