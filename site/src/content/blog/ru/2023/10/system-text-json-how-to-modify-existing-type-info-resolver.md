---
title: "System.Text.Json Как изменить существующий type info resolver"
description: "Используйте новый метод-расширение WithAddedModifier в .NET 8, чтобы легко изменять любой контракт сериализации IJsonTypeInfoResolver, не создавая resolver с нуля."
pubDate: 2023-10-25
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/system-text-json-how-to-modify-existing-type-info-resolver"
translatedBy: "claude"
translationDate: 2026-05-01
---
Бывают ситуации, когда создание совершенно нового `IJsonTypeInfoResolver` выглядит избыточным: дефолтный (или любой другой уже определённый) type info resolver вполне справится с задачей с одной-двумя небольшими правками.

До сих пор для дефолтного резолвера можно было играть со свойством `DefaultJsonTypeInfoResolver.Modifiers`, но для type info resolver, написанных самим разработчиком или приходящих из пакетов, ничего готового не было.

Именно для таких случаев, начиная с .NET 8, у нас появился новый метод-расширение, который позволяет легко вносить изменения в произвольные контракты сериализации `IJsonTypeInfoResolver`. Этот метод-расширение, разумеется, можно комбинировать и с дефолтным type info resolver.

```cs
public static IJsonTypeInfoResolver WithAddedModifier(
    this IJsonTypeInfoResolver resolver, 
    Action<JsonTypeInfo> modifier)
```

Это создаст за вас экземпляр `JsonTypeInfoResolverWithAddedModifiers` (реализующий `IJsonTypeInfoResolver`), который умеет применять ваши модификации схемы.

Посмотрим на простой пример использования с произвольным `MyTypeInfoResolver`:

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new MyTypeInfoResolver()
        .WithAddedModifier(typeInfo =>
        {
            foreach (JsonPropertyInfo prop in typeInfo.Properties)
                prop.Name = prop.Name.ToLower();
        })
};
```
