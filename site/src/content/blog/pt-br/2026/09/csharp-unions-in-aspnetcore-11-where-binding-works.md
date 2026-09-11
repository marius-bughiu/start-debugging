---
title: "Unions de C# no ASP.NET Core 11: corpos, SignalR e OpenAPI funcionam, query strings não"
description: "A equipe do ASP.NET Core mapeou por onde os tipos union do C# 15 passam no .NET 11: corpos de minimal APIs e MVC, o JsonHubProtocol do SignalR, Blazor e schemas anyOf do OpenAPI. Binding de rota, query, headers e formulários ainda não é suportado."
pubDate: 2026-09-11
tags:
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "signalr"
lang: "pt-br"
translationOf: "2026/09/csharp-unions-in-aspnetcore-11-where-binding-works"
translatedBy: "claude"
translationDate: 2026-09-11
---

Em 10 de setembro, um dia depois do lançamento do .NET 11 RC 1, a equipe do ASP.NET Core publicou [Use C# unions and closed hierarchies in ASP.NET Core](https://devblogs.microsoft.com/dotnet/unions-and-closed-hierarchies-in-aspnetcore/). É o primeiro mapa completo de onde os tipos `union` do C# 15 realmente funcionam em toda a stack web, e a resposta é simples: tudo que passa pelo System.Text.Json funciona, e todo o resto não.

## Unions como corpo de requisição e tipo de retorno

Como as unions são serializadas como o caso ativo, sem wrapper nem discriminador (o comportamento que chegou no [System.Text.Json do .NET 11 Preview 6](/pt-br/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/)), uma minimal API pode aceitá-las e retorná-las diretamente:

```csharp
public record Cat(string Name, string Coat);
public record Dog(string Name, string Breed);

[JsonUnion(TypeClassifier = typeof(JsonUnionTypeStructuralClassifier))]
public union UnionPet(Cat, Dog);

public union UnionIntString(int, string);

app.MapPost("/pet", ([FromBody] UnionPet pet) => TypedResults.Ok(pet));
app.MapGet("/value", () => new UnionIntString(42));
```

`UnionPet` precisa do classificador estrutural porque os dois casos são objetos JSON: o STJ tem que olhar os nomes das propriedades (`coat` vs `breed`) para escolher um caso antes de desserializar. Essa varredura custa trabalho extra por requisição, e renomear uma propriedade pode mudar silenciosamente qual caso vence, então trate esses nomes de propriedades como parte do seu contrato.

Controllers MVC ganham o mesmo comportamento pelos formatters de entrada e saída do STJ, então um parâmetro de action `[FromBody] UnionBoolString` ou um tipo de retorno union funcionam sem configuração extra.

## O OpenAPI emite anyOf

O gerador de OpenAPI embutido no .NET 11 descreve uma union como `anyOf` com uma entrada por caso:

```json
"UnionIntString": {
  "anyOf": [
    { "type": "integer", "format": "int32" },
    { "type": "string" }
  ]
}
```

Esse é o formato de que os geradores de clientes precisam para contratos como o `maxUnavailable` do Kubernetes, que aceita tanto `2` quanto `"25%"`. Antes das unions, você modelava isso com um `JsonConverter` customizado e um transformador de schema escrito à mão.

## SignalR e Blazor

O `JsonHubProtocol` do SignalR suporta unions como parâmetros de métodos do hub, valores de retorno e itens de stream `IAsyncEnumerable<T>`. Os protocolos de hub MessagePack e Newtonsoft.Json não. O Blazor lida com unions em parâmetros de componentes (em processo, sem serialização), na interop com JS e no estado persistido de componentes via `PersistAsJson` / `TryTakeFromJson`.

## Onde o binding para

Valores de rota, query strings, headers e campos de formulário não passam pelo STJ, então unions não são suportadas ali. O argumento do blog é que um token de texto simples não oferece uma forma confiável de escolher um caso. O `[SupplyParameterFromQuery]` do Blazor fica de fora pelo mesmo motivo. A discussão de design está aberta em [dotnet/aspnetcore#66648](https://github.com/dotnet/aspnetcore/issues/66648).

Até isso chegar, faça o binding da string crua e monte a union você mesmo:

```csharp
app.MapGet("/rollout", (string maxUnavailable) =>
    int.TryParse(maxUnavailable, out var count)
        ? new UnionIntString(count)
        : new UnionIntString(maxUnavailable));
```

Há mais uma armadilha do lado do corpo. `JsonSerializerOptions.Web` permite ler números a partir de strings, então quando `UnionIntString` é um corpo de requisição, o token JSON `"42"` corresponde tanto a `int` quanto a `string`. Retornar essa union não tem problema, mas aceitá-la como entrada exige um classificador customizado. O SignalR não tem esse problema porque o `JsonHubProtocol` não trata um token de texto como um possível número.

## Unions ou hierarquias fechadas

O post também cobre hierarquias de classes `closed` com `[JsonPolymorphic(InferClosedTypePolymorphism = true)]`, que produzem um discriminador `$type` sem listar cada `[JsonDerivedType]`. A orientação é útil: escolha uma union quando o contrato JSON precisa ficar sem discriminador ou os casos são primitivos e tipos que você não controla, e escolha uma hierarquia fechada quando estiver projetando uma API nova cujos casos compartilham um tipo base. Se você já está no .NET 11 RC 1, as duas estão prontas para testar em corpos e respostas. Por enquanto, mantenha-as fora dos seus templates de rota.
