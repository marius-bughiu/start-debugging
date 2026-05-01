---
title: "Adicionar/remover TypeInfoResolver em um JsonSerializerOptions existente"
description: "Aprenda a adicionar ou remover instâncias de TypeInfoResolver em um JsonSerializerOptions existente usando a nova propriedade TypeInfoResolverChain do .NET 8."
pubDate: 2023-10-19
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8, a classe `JsonSerializerOptions` ganha uma nova propriedade `TypeInfoResolverChain`, somando-se à `TypeInfoResolver` já existente. Com essa nova propriedade, você não precisa mais informar todos os resolvers no mesmo lugar. Em vez disso, dá para adicioná-los depois, conforme a necessidade.

Vamos a um exemplo:

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

Além de adicionar novos type resolvers a um `JsonSerializerOptions` existente, o `TypeInfoResolverChain` também permite remover type info resolvers das opções do serializador.

```cs
options.TypeInfoResolverChain.RemoveAt(0);
```

Se você quiser impedir alterações na cadeia de type info resolver, pode fazer isso [tornando a instância de `JsonSerializerOptions` somente leitura](/2023/09/net-8-mark-jsonserializeroptions-as-readonly/). Para isso, basta chamar o método `MakeReadOnly()` na instância de options. Em seguida, qualquer tentativa de modificar a cadeia de type info resolver depois disso resultará na `InvalidOperationException` abaixo.

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
   at System.Text.Json.JsonSerializerOptions.OptionsBoundJsonTypeInfoResolverChain.OnCollectionModifying()
   at System.Text.Json.Serialization.ConfigurationList`1.Add(TItem item)
```
