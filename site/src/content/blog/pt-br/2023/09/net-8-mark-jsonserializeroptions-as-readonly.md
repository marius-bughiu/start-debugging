---
title: ".NET 8 marcando JsonSerializerOptions como readonly"
description: "Congele JsonSerializerOptions com MakeReadOnly, corrija o TypeInfoResolver ausente e crie uma cópia mutável em um exemplo executável .NET 8."
pubDate: 2023-09-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/net-8-mark-jsonserializeroptions-as-readonly"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8, `JsonSerializerOptions.MakeReadOnly()` congela uma instância de opções. Configure seu `TypeInfoResolver` antes: um novo objeto de opções não tem resolver, e chamar imediatamente o método sem parâmetros lança `InvalidOperationException`.

> **Correção — 2 de novembro de 2026:** O exemplo anterior omitia o resolver e falhava em `MakeReadOnly()`. O exemplo abaixo usa metadados gerados e funciona também com os padrões de reflexão desativados.

## Congelar opções configuradas

Este `Program.cs` completo usa um resolver gerado, serializa com opções congeladas, rejeita uma alteração posterior e cria uma cópia que pode ser configurada de forma independente:

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper
};
options.MakeReadOnly();
Console.WriteLine(options.IsReadOnly);
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), options));

try
{
    options.WriteIndented = true;
}
catch (InvalidOperationException)
{
    Console.WriteLine("Mutation rejected");
}

var copy = new JsonSerializerOptions(options);
Console.WriteLine(copy.IsReadOnly);
copy.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), copy));

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

Saída:

```text
True
{"ID":42,"NAME":"Ada"}
Mutation rejected
False
{"id":42,"name":"Ada"}
```

`IsReadOnly` passa a ser `true` após o congelamento. Repetir `MakeReadOnly()` é permitido. Alterar uma configuração depois disso lança `InvalidOperationException`. A serialização ou desserialização também torna a instância de opções somente leitura.

O construtor de cópia preserva as configurações de origem, incluindo o resolver, mas cria uma instância mutável. Configure a cópia antes do primeiro uso; serializar com ela também a congela.

## Por que MakeReadOnly falha sem resolver?

`new JsonSerializerOptions().MakeReadOnly()` não escolhe um resolver automaticamente. Forneça um explicitamente, como acima, ou use `MakeReadOnly(populateMissingResolver: true)` quando a serialização por reflexão for desejada e estiver ativada.

Essa sobrecarga preenche um resolver ausente com o padrão baseado em reflexão. Com os padrões de reflexão desativados, ela não consegue preencher essa lacuna e lança `InvalidOperationException`. Não substitui metadados gerados em aplicações trimmed ou Native AOT. Veja [como desativar os padrões de reflexão e configurar um contexto](/pt-br/2023/10/system-text-json-disable-reflection-based-serialization/) e o [contrato da API MakeReadOnly](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly?view=net-8.0).

## Executar o exemplo verificado

[Baixe o projeto completo de opções do System.Text.Json](/examples/system-text-json-options.zip), extraia-o e execute:

```sh
dotnet run -c Release
```

O projeto .NET 8 sem dependências adicionais verifica resolvers ausentes, congelamento repetido, alterações rejeitadas, serialização gerada e comportamento de cópias. Também exercita `populateMissingResolver` separadamente com os padrões de reflexão desativados e ativados. Todas as verificações passaram nos runtimes reais .NET 8.0.33 e .NET 10.0.10; comandos e resultados estão no registro de verificação do arquivo.
