---
title: "Como 878 PRs do Copilot Coding Agent em dotnet/runtime realmente parecem"
description: "A equipe .NET compartilha dez meses de dados reais sobre rodar o Copilot Coding Agent do GitHub no dotnet/runtime: 878 PRs, uma taxa de merge de 67,9%, e lições claras sobre onde o desenvolvimento assistido por IA ajuda e onde ainda fica aquém."
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "ai"
  - "ai-agents"
  - "github-copilot"
  - "copilot"
  - "github"
lang: "pt-br"
translationOf: "2026/03/copilot-coding-agent-dotnet-runtime-ten-months-data"
translatedBy: "claude"
translationDate: 2026-04-25
---

O Copilot Coding Agent do GitHub está rodando no repositório [dotnet/runtime](https://github.com/dotnet/runtime) desde maio de 2025. O [post de análise profunda](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/) de Stephen Toub cobre dez meses de uso real: 878 PRs enviados, 535 mergeados, uma taxa de merge de 67,9%, e uma taxa de reversão de apenas 0,6%.

## Onde os números ficam interessantes

Nem todos os tamanhos de PR são iguais. Mudanças pequenas e focadas têm sucesso em taxas mais altas:

| Tamanho do PR (linhas alteradas) | Taxa de sucesso |
|---|---|
| 1-10 linhas | 80,0% |
| 11-50 linhas | 76,9% |
| 101-500 linhas | 64,0% |
| 1.001+ linhas | 71,9% |

A queda em 101-500 linhas reflete o limite onde tarefas mecânicas se misturam com arquiteturais. Trabalho de limpeza e remoção encabeça as categorias com 84,7% de sucesso, seguido por adições de testes com 75,6%. Essas são tarefas com critérios de sucesso claros, sem ambiguidade sobre intenção, e raio de impacto limitado.

## Instruções são o jogo inteiro

O primeiro mês da equipe produziu uma taxa de merge de 41,7% sem configuração significativa. Depois de escrever um arquivo de instruções de agente apropriado -- especificando comandos de build, padrões de teste, e limites arquiteturais -- a taxa subiu para 69% em semanas e eventualmente alcançou 72%.

Uma configuração mínima mas efetiva se parece com isto:

```markdown
## Build
Run `./build.sh clr -subset clr.runtime` to build the runtime.
Run `./build.sh -test -subset clr.tests` to run tests.

## Testing Patterns
New public APIs require tests in src/tests/.
Use existing helpers in XUnitHelper rather than writing from scratch.

## Scope Limits
Do not change public API surface without a linked tracking issue.
Native (C++) components require Windows CI -- avoid if not needed.
```

As instruções não precisam ser longas. Elas precisam ser específicas.

## A capacidade de revisão se torna o gargalo

Uma observação reveladora dos dados: um único desenvolvedor poderia enfileirar nove PRs substanciais de um celular enquanto viajava, gerando 5-9 horas de trabalho de revisão para a equipe. A geração de PRs escalou mais rápido que a revisão de PRs. Essa assimetria provocou investimento paralelo em revisão de código assistida por IA para absorver o novo volume. Esse padrão se repetirá em qualquer equipe que adote o agente em escala.

## O que o CCA não substitui

Decisões arquiteturais, raciocínio multiplataforma, e julgamentos sobre forma de API consistentemente exigiram intervenção humana. O código mergeado do CCA se decompõe como 65,7% código de teste versus 49,9% para contribuidores humanos. É mais forte em preencher o trabalho mecânico que humanos rotineiramente despriorizam.

A validação mais ampla cobriu sete repositórios .NET (aspire, roslyn, aspnetcore, efcore, extensions, e outros): 1.885 PRs mergeados de 2.963 enviados, uma taxa de sucesso de 68,6%. O padrão se mantém em escala.

Para equipes pensando em adotar o Copilot Coding Agent: comece com pequenas tarefas de limpeza ou teste, escreva seu arquivo de instruções antes de qualquer outra coisa, e planeje para que a capacidade de revisão se torne a próxima restrição.

A análise completa está em [devblogs.microsoft.com](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/).
