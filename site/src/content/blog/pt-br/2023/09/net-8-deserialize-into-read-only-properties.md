---
title: ".NET 8 desserializando em propriedades somente leitura"
description: "Aprenda a desserializar JSON em propriedades somente leitura, sem setter, no .NET 8 usando JsonObjectCreationHandling ou JsonSerializerOptions."
pubDate: 2023-09-03
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/net-8-deserialize-into-read-only-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8 dá para desserializar em propriedades que não têm o acessador `set`. Você pode ativar esse comportamento com `JsonSerializerOptions` ou por tipo, com o atributo `JsonObjectCreationHandling`.

## Usando o atributo JsonObjectCreationHandling

Você pode anotar o seu tipo com o atributo `System.Text.Json.Serialization.JsonObjectCreationHandling`, passando a opção como parâmetro.

```cs
[JsonObjectCreationHandling(JsonObjectCreationHandling.Populate)]
public class Foo
{
     public int Bar { get; }
}
```

## Usando JsonSerializerOptions

Defina a propriedade `JsonSerializerOptions.PreferredObjectCreationHandling` como `Populate` e passe esse `options` para o método `Deserialize`.

```cs
new JsonSerializerOptions 
{ 
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate
};
```
