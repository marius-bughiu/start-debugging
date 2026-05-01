---
title: ".NET 8 обработка лишних членов при десериализации JSON"
description: "Узнайте, как в .NET 8 заставить десериализацию бросать исключение для несопоставленных JSON-свойств с помощью JsonUnmappedMemberHandling."
pubDate: 2023-09-02
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/net-8-handle-missing-members-during-json-deserialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
По умолчанию, если в десериализуемом JSON-пейлоаде есть дополнительные свойства, они просто игнорируются. А что если нужно, чтобы десериализация падала и бросала исключение, когда в JSON есть лишние свойства? С .NET 8 это возможно.

Включить это поведение в сериализаторе `System.Text.Json` можно несколькими способами.

## 1\. Через атрибут JsonUnmappedMemberHandling

Пометьте свой тип атрибутом `[System.Text.Json.Serialization.JsonUnmappedMemberHandlingAttribute]`, передав нужную опцию параметром.

```cs
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public class Foo
{
     public int Bar { get; set; }
}
```

## 2\. Через JsonSerializerOptions

Установите свойство `JsonSerializerOptions.UnmappedMemberHandling` в `Disallow` и передайте options в метод `Deserialize`.

```cs
new JsonSerializerOptions 
{ 
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow 
};
```

## Бросается исключение

Будьте готовы его поймать. С `JsonUnmappedMemberHandling`, выставленным в `Disallow`, при десериализации JSON-пейлоада с дополнительными членами будет брошено следующее исключение.

> **System.Text.Json.JsonException**: 'The JSON property '<property name>' could not be mapped to any .NET member contained in type '<namespace>+<type name>'.'
