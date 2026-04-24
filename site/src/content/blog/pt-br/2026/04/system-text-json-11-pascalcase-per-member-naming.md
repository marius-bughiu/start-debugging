---
title: "System.Text.Json no .NET 11 Preview 3 adiciona PascalCase e políticas de naming por membro"
description: ".NET 11 Preview 3 fecha a história de políticas de naming no System.Text.Json: JsonNamingPolicy.PascalCase, um atributo [JsonNamingPolicy] em nível de membro, e um default [JsonIgnore] em nível de tipo para DTOs mais limpos."
pubDate: 2026-04-18
tags:
  - "dotnet-11"
  - "system-text-json"
  - "csharp"
  - "serialization"
lang: "pt-br"
translationOf: "2026/04/system-text-json-11-pascalcase-per-member-naming"
translatedBy: "claude"
translationDate: 2026-04-24
---

O [.NET 8 introduziu](https://startdebugging.net/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/) o primeiro lote de políticas de naming embutidas para `System.Text.Json`: camel, snake e kebab em ambos os casings. O Preview 3 do .NET 11 fecha a última lacuna óbvia e adiciona mais dois botões que tornam `JsonConverter`s artesanais desnecessários para a maioria dos formatos de DTO. O trabalho saiu via [dotnet/runtime #124644](https://github.com/dotnet/runtime/pull/124644), [#124645](https://github.com/dotnet/runtime/pull/124645) e [#124646](https://github.com/dotnet/runtime/pull/124646).

## PascalCase entra para as políticas embutidas

`JsonNamingPolicy.PascalCase` é novo no Preview 3 e fica ao lado dos já existentes `CamelCase`, `SnakeCaseLower`, `SnakeCaseUpper`, `KebabCaseLower` e `KebabCaseUpper`. É a política que você quer quando o lado .NET já usa propriedades PascalCase e o contrato JSON também é PascalCase, comum para APIs de Azure Management, gateways antigos de SOAP para REST e alguns formatos do Microsoft Graph:

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

Antes do Preview 3 você deixava o default (sem política) ou escrevia uma subclasse custom de `JsonNamingPolicy` de uma linha. Agora ela combina com os outros presets e faz round-trip limpo com o enum `JsonKnownNamingPolicy` existente.

## Sobrescrevendo o naming num único membro

A mudança mais interessante é que `[JsonNamingPolicy]` agora é um atributo em nível de membro. Antes a política vivia em `JsonSerializerOptions` e se aplicava ao grafo inteiro, então uma exceção PascalCase num contrato que no mais era camelCase significava ou um override `[JsonPropertyName]` em cada propriedade esquisita ou uma política totalmente custom. No .NET 11 Preview 3 você consegue misturar políticas dentro do mesmo tipo:

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

Com `PropertyNamingPolicy = JsonNamingPolicy.CamelCase`, `Url` serializa para `url`, `RetryStrategy` para `retry-strategy` e `MaxAttempts` para `max_attempts`. Isso tira muito barulho de `[JsonPropertyName]` por propriedade quando um sistema externo único é inconsistente.

## Defaults de [JsonIgnore] em nível de tipo

A mudança companheira é que `[JsonIgnore(Condition = ...)]` agora é legal no próprio tipo, não só em propriedades ([dotnet/runtime #124646](https://github.com/dotnet/runtime/pull/124646)). Coloque na classe e a condição vira o default para cada propriedade dentro do tipo:

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

Cada propriedade nullable em `PatchRequest` agora some do payload quando é null, que é exatamente o que um formato de requisição JSON Merge Patch quer. O override de `IsActive` volta a entrar porque um `false` explícito é significativo ali. O mesmo padrão antes exigia `JsonIgnoreCondition.WhenWritingNull` em cada propriedade individualmente ou `DefaultIgnoreCondition` nas opções do serializer, o que depois forçava todo outro DTO pela mesma regra.

## Por que a superfície pequena importa

Controle em nível de atributo é o que permite aos times substituir converters custom pelo `System.Text.Json` de prateleira. PascalCase remove a última razão para "escreva sua própria política", naming por membro apaga uma classe de boilerplate de `[JsonPropertyName]`, e `[JsonIgnore]` em nível de tipo deixa DTOs de PATCH e de eventos configurarem o default num lugar só. As três mudanças também funcionam com o source generator, então apps Native AOT as recebem sem configuração extra. As [notas de libraries do Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/libraries.md) rastreiam o resto das atualizações de `System.Text.Json` saindo este mês.
