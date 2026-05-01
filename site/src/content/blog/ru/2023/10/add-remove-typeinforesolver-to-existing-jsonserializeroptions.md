---
title: "Добавление/удаление TypeInfoResolver у существующих JsonSerializerOptions"
description: "Узнайте, как добавлять или удалять экземпляры TypeInfoResolver у существующих JsonSerializerOptions с помощью нового свойства TypeInfoResolverChain в .NET 8."
pubDate: 2023-10-19
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8, в классе `JsonSerializerOptions` появилось новое свойство `TypeInfoResolverChain` в дополнение к уже существующему `TypeInfoResolver`. Благодаря этому свойству не обязательно перечислять все резолверы в одном месте — вы можете добавлять их позже, по мере необходимости.

Рассмотрим пример:

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = JsonTypeInfoResolver.Combine(
        new ResolverA(), 
        new ResolverB()
    );
};

options.TypeInfoResolverChain.Add(new ResolverC());
```

Помимо добавления новых type resolvers к существующему `JsonSerializerOptions`, `TypeInfoResolverChain` позволяет также удалять type info resolvers из настроек сериализатора.

```cs
options.TypeInfoResolverChain.RemoveAt(0);
```

Если вы хотите запретить изменения цепочки type info resolver, это можно сделать [пометив экземпляр `JsonSerializerOptions` как только для чтения](/2023/09/net-8-mark-jsonserializeroptions-as-readonly/). Для этого нужно вызвать метод `MakeReadOnly()` у экземпляра options. После этого любая попытка изменить цепочку type info resolver приведёт к следующему `InvalidOperationException`.

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
   at System.Text.Json.JsonSerializerOptions.OptionsBoundJsonTypeInfoResolverChain.OnCollectionModifying()
   at System.Text.Json.Serialization.ConfigurationList`1.Add(TItem item)
```
