---
title: "System.Text.Json aprende a serializar os tipos union de C# no .NET 11 Preview 6"
description: "Como o System.Text.Json no .NET 11 Preview 6 serializa os novos tipos union de C# escrevendo o caso ativo, e as APIs JsonUnionAttribute e de classificador de tipos que resolvem os casos ambíguos."
pubDate: 2026-07-21
tags:
  - "csharp"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "pt-br"
translationOf: "2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-21
---

Os tipos union de C# têm sido o recurso de destaque das versões prévias do .NET 11, mas até agora paravam na fronteira do compilador. A partir do [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) (9 de julho de 2026), o `System.Text.Json` os entende nativamente: você pode serializar e desserializar uma union sem escrever um `JsonConverter` personalizado. Na Preview 6, duas outras peças se encaixaram, então tudo isso finalmente funciona sem código repetitivo: os tipos de suporte `System.Runtime.CompilerServices.UnionAttribute` e `IUnion` agora vêm no framework, de modo que uma union compila em um projeto `net11.0` sem mais nada.

## Escrever o caso ativo, não um invólucro

Uma union declara que um valor é exatamente um de um conjunto fixo de tipos de caso. A forma abreviada gera um struct que contém o caso que estiver ativo no momento:

```csharp
public union Pet(Cat, Dog, Bird);

public record Cat(string Name);
public record Dog(string Name);
public record Bird(string Name);
```

O `System.Text.Json` reconhece isso por meio de um novo tipo de contrato, `JsonTypeInfoKind.Union`. Quando você serializa uma union, o serializador lê o caso ativo e escreve o valor *dele* diretamente, sem nenhum invólucro ao redor:

```csharp
Pet pet = new Dog("Rex");
string json = JsonSerializer.Serialize(pet);
// {"Name":"Rex"}
```

Para uma union de primitivos, isso significa que uma union de `int` e `string` faz o ciclo de ida e volta de forma limpa, porque os tokens JSON são estruturalmente distintos:

```csharp
Pet-like union of (int, string):
"hello"   // the string case
42        // the int case
```

Tanto o serializador baseado em reflexão quanto o gerador de código-fonte oferecem suporte a isso, então você não é forçado a abandonar o caminho compatível com AOT para usá-lo.

## A lacuna do discriminador, e como fechá-la

Escrever o valor cru é elegante, mas repare no que acontece com `Pet`: tanto `Dog("Rex")` quanto `Cat("Rex")` são serializados para `{"Name":"Rex"}`. No caminho de volta, o serializador não consegue saber qual caso era. Esse é o clássico problema das uniões marcadas, e a Preview 6 entrega as ferramentas para resolvê-lo em vez de adivinhar.

Três novas APIs controlam como os casos são descobertos e nomeados: `JsonUnionAttribute`, `JsonUnionCaseInfo` e o par de classificadores de tipos `JsonTypeClassifier` e `JsonSerializerOptions.TypeClassifiers`. Juntas, elas permitem anexar um discriminador de tipo ao JSON emitido para que os casos ambíguos com formato de objeto sejam desserializados de volta para o tipo de caso correto. Os casos estruturalmente distintos (como `int` versus `string`) não precisam de nada disso; a cerimônia só entra em cena quando as cargas colidiriam.

Se você acompanhou a [cobertura dos tipos union desde a Preview 2](/pt-br/2026/04/csharp-15-union-types-dotnet-11-preview-2/), esta é a peça que os torna utilizáveis através de uma fronteira HTTP. As unions sempre iam viver ou morrer conforme o suporte à serialização, e a Preview 6 é onde elas deixam de ser uma curiosidade do compilador e começam a ser algo que você pode colocar na rede.

Todos os detalhes estão nas [notas de versão das bibliotecas da Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/libraries.md).
