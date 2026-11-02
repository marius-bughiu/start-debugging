---
title: "Desempenho no .NET 8: UnsafeAccessor versus reflexão"
description: "Benchmark reproduzível .NET 8 comparando UnsafeAccessor, reflexão, reflexão em cache, delegados em cache e chamadas diretas com trabalho observável."
pubDate: 2023-11-01
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/11/net-8-performance-unsafeaccessor-vs-reflection"
translatedBy: "claude"
translationDate: 2026-05-01
---
Um `UnsafeAccessor` vincula-se a um membro conhecido sem busca por reflexão ou `MethodInfo.Invoke`. Uma comparação útil precisa manter o trabalho de destino observável e explicar o que cada caminho faz.

**Correção — 2 de novembro de 2026:** o repositório antigo está indisponível. O exemplo foi restaurado com verificação funcional, diagnóstico de alocações, delegados em cache e métodos de destino equivalentes sem inlining. Os tempos anteriores próximos de zero não demonstram overhead zero universal e não são mais apresentados como medições reproduzíveis.

## Baixar e executar

[Baixe o código do benchmark](/examples/unsafe-accessor-benchmarks.zip). Ele tem como alvo .NET 8 e fixa BenchmarkDotNet 0.15.8.

```sh
dotnet run -c Release -- --verify
dotnet run -c Release -- --job Dry --filter '*'
dotnet run -c Release -- --filter '*'
```

O primeiro comando verifica que os cinco caminhos retornam `59` para a entrada `42`. O segundo é uma verificação de execução com uma iteração. Use o último para medições normais e preserve os arquivos gerados de ambiente e relatórios antes de interpretar os tempos.

## O que é comparado

1. **Chamada direta:** invoca um método público.
2. **Unsafe accessor:** vincula-se a um método privado com a mesma operação.
3. **Busca e invocação por reflexão:** encontra e invoca o método em cada operação.
4. **Reflexão em cache:** reutiliza `MethodInfo`, mas ainda fornece um array de objetos como argumentos.
5. **Delegado em cache:** reutiliza um delegado de instância aberto para o método privado.

Os dois métodos de destino retornam a entrada mais um campo de instância e usam `MethodImplOptions.NoInlining`. Cada benchmark retorna o resultado. A entrada é um parâmetro do BenchmarkDotNet, evitando reduzir a demonstração a um método inline que retorna uma constante.

`MemoryDiagnoser` informa alocações, incluindo array de argumentos e boxing nos casos de reflexão. Os caminhos fazem trabalhos diferentes; a diferença de tempo não corresponde apenas à verificação de acesso.

## Verificação e interpretação

O projeto restaurado foi executado com .NET 8.0.33 em macOS arm64. A verificação funcional e os cinco jobs Dry do BenchmarkDotNet passaram. Os tempos Dry não são publicados como tabela de desempenho: validam o mecanismo de medição, não uma estimativa estável em nanossegundos.

Inlining, versão do runtime, arquitetura, trabalho de destino, cache e alocações afetam os resultados. Um valor minúsculo pode indicar que o JIT eliminou o trabalho ou que a medição ficou abaixo da resolução útil. Não prova que toda operação de accessor seja gratuita.

O accessor também precisa da assinatura na compilação. Reflexão continua útil quando tipo ou membro são descobertos em execução. Veja os [exemplos de acesso](/pt-br/2023/10/unsafe-accessor/) e a [referência da Microsoft](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) para essa distinção.
