---
title: "Desempenho de GetGenericTypeDefinition no .NET 8: benchmark reproduzível"
description: "Reproduza chamadas repetidas a GetGenericTypeDefinition com BenchmarkDotNet e compare runtimes .NET escolhidos sem presumir ganho fixo."
pubDate: 2023-11-05
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/11/net-8-performance-10x-faster-getgenerictypedefinition"
translatedBy: "claude"
translationDate: 2026-05-01
---
A Microsoft documentou melhorias no tratamento de informações de tipos genéricos no .NET 8, incluindo cache do resultado de `GetGenericTypeDefinition` no objeto `Type`. É uma otimização específica do runtime, não um multiplicador fixo para toda carga de reflexão.

**Correção — 2 de novembro de 2026:** o antigo título «10x» e a tabela sem atribuição foram removidos porque os artefatos da execução e o repositório originais não estão disponíveis. A URL histórica foi preservada, e um benchmark executável agora é mantido com este site.

## Restaurar o benchmark

[Baixe o projeto fonte](/examples/generic-type-definition-benchmarks.zip). Ele é compilado para .NET 7 e .NET 8 e fixa BenchmarkDotNet 0.13.12. O trabalho central é:

```cs
public class GenericTypeBenchmarks
{
    private readonly Type _type = typeof(List<int>);

    [Benchmark]
    public Type GetGenericTypeDefinition() => _type.GetGenericTypeDefinition();
}
```

O projeto completo inclui imports e runner. Execute a verificação funcional e as medições normais:

```sh
dotnet run -c Release -f net8.0 -- --verify
dotnet run -c Release -f net8.0 -- --filter '*'
```

A verificação funcional confirma que o resultado é `typeof(List<>)`. Um job Dry verifica a execução rapidamente, mas seu tempo não é uma medida confiável de desempenho.

## Comparar .NET 7 e .NET 8

Instale ambos os runtimes e selecione-os explicitamente:

```sh
dotnet run -c Release -f net8.0 -- --runtimes net7.0 net8.0 --filter '*'
```

A comparação histórica requer esses runtimes reais; executar uma aplicação direcionada ao .NET 8 em um runtime mais recente não reproduz medições do .NET 8. Preserve os detalhes do ambiente e os relatórios gerados com qualquer resultado publicado.

Este benchmark mede chamadas repetidas em um `Type` conhecido. Não mede carregamento de tipos, descoberta sem cache ou uma aplicação inteira. A [análise de desempenho do .NET 8 da Microsoft](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/) explica a otimização e apresenta suas próprias medições, separadas da verificação deste projeto.

Para outra carga de reflexão, veja a [comparação de UnsafeAccessor](/pt-br/2023/11/net-8-performance-unsafeaccessor-vs-reflection/).
