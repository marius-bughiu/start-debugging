---
title: "O que há de novo no .NET 10"
description: "O que há de novo no .NET 10: versão LTS com 3 anos de suporte, novas otimizações do JIT, desvirtualização de arrays, melhorias na alocação na pilha e mais."
pubDate: 2024-12-01
updatedDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2024/12/dotnet-10"
translatedBy: "claude"
translationDate: 2026-05-01
---
O .NET 10 será lançado em novembro de 2025. O .NET 10 é uma versão Long Term Support (LTS), que receberá suporte gratuito e correções por 3 anos a partir da data de lançamento, até novembro de 2028.

O .NET 10 será lançado junto com o C# 14. Veja [o que há de novo no C# 14](/2024/12/csharp-14/).

Há vários novos recursos e melhorias no runtime do .NET 10:

-   [Desvirtualização de métodos de interface de array e desabstração da enumeração de arrays](/pt-br/2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction/)
-   Inlining de métodos desvirtualizados tardiamente
-   Desvirtualização baseada em observações do inlining
-   [Alocação na pilha de arrays de tipos por valor](/pt-br/2025/04/net-10-stack-allocation-of-arrays-of-value-types/)
-   Layout de código aprimorado para evitar instruções de salto e melhorar a probabilidade de compartilhar uma linha de cache de instruções
-   [SearchValues adicionou suporte a strings](/pt-br/2026/01/net-10-performance-searchvalues/)

## Fim do suporte

O .NET 10 é uma versão Long Term Support (LTS) e terá fim de suporte em novembro de 2028.
