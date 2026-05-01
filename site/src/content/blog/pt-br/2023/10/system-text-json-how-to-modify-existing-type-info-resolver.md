---
title: "System.Text.Json como modificar um type info resolver existente"
description: "Use o novo método de extensão WithAddedModifier no .NET 8 para modificar facilmente qualquer contrato de serialização IJsonTypeInfoResolver sem criar um resolver novo do zero."
pubDate: 2023-10-25
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/system-text-json-how-to-modify-existing-type-info-resolver"
translatedBy: "claude"
translationDate: 2026-05-01
---
Existem situações em que criar um `IJsonTypeInfoResolver` totalmente novo parece exagero, sendo que o resolver padrão (ou qualquer outro já definido) daria conta do recado com apenas uma ou duas pequenas alterações.

Até agora, dava para mexer na propriedade `DefaultJsonTypeInfoResolver.Modifiers` no caso do type info resolver padrão, mas não havia nada nativo para resolvers definidos pelo desenvolvedor ou vindos de pacotes.

Para esses casos em particular, a partir do .NET 8, ganhamos um novo método de extensão que permite introduzir modificações de forma fácil em contratos de serialização `IJsonTypeInfoResolver` arbitrários. O método de extensão também pode ser combinado com o type info resolver padrão, claro.

```cs
public static IJsonTypeInfoResolver WithAddedModifier(
    this IJsonTypeInfoResolver resolver, 
    Action<JsonTypeInfo> modifier)
```

Isso cria para você uma instância de `JsonTypeInfoResolverWithAddedModifiers` (um `IJsonTypeInfoResolver`) capaz de aplicar suas modificações no esquema.

Vamos a um exemplo simples, supondo um `MyTypeInfoResolver` qualquer:

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
