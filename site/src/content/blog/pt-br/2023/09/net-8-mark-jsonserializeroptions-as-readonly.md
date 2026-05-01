---
title: ".NET 8 marcando JsonSerializerOptions como readonly"
description: "Aprenda a marcar instâncias de JsonSerializerOptions como somente leitura no .NET 8 usando MakeReadOnly e a verificar a propriedade IsReadOnly."
pubDate: 2023-09-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/net-8-mark-jsonserializeroptions-as-readonly"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8, você pode marcar instâncias de `JsonSerializerOptions` como somente leitura, impedindo alterações posteriores na instância. Para congelar a instância, basta chamar `MakeReadOnly` na instância de options.

Vamos a um exemplo:

```cs
var options = new JsonSerializerOptions
{
    AllowTrailingCommas = true,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper,
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate,
};

options.MakeReadOnly();
```

Você também pode verificar se uma instância já foi congelada consultando a propriedade `IsReadOnly`.

```cs
options.IsReadOnly
```

Tentar modificar uma instância de `JsonSerializerOptions` depois de marcá-la como somente leitura resulta em uma `InvalidOperationException`:

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
```

## Sobrecarga [`MakeReadOnly(bool populateMissingResolver)`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly#system-text-json-jsonserializeroptions-makereadonly\(system-boolean\))

Quando `populateMissingResolver` é passado como `true`, o método adiciona o resolver padrão baseado em reflexão ao seu `JsonSerializerOptions` caso esteja faltando. Cuidado ao [usar esse método em aplicações trimmed / Native AOT, pois ele vai puxar os assemblies relacionados a reflexão e incluí-los na sua build](/2023/10/system-text-json-disable-reflection-based-serialization/).
