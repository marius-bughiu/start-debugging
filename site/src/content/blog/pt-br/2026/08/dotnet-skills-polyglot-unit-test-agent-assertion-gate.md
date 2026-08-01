---
title: "A melhor ideia do novo agente de testes unitários do .NET não é escrever testes"
description: "Em 2026-07-31 a Microsoft publicou um agente poliglota de testes unitários no dotnet/skills. O interessante é a verificação obrigatória que aplica pseudo-mutação nas suas asserções antes de permitir que o agente diga que terminou."
pubDate: 2026-08-01
tags:
  - "dotnet"
  - "ai-agents"
  - "testing"
  - "github-copilot"
  - "agent-skills"
lang: "pt-br"
translationOf: "2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate"
translatedBy: "claude"
translationDate: 2026-08-01
---

Qualquer agente de código gera testes unitários sem reclamar. O problema não é ele se recusar, é você acabar com 40 testes verdes que apenas fazem `Assert.NotNull(result)` e continuariam passando se você apagasse o corpo do método. Em 2026-07-31 Amaury Levé publicou [From generated code to trusted code with a unit-test agent](https://devblogs.microsoft.com/dotnet/polyglot-unit-testing-agent/), lançando o plugin `dotnet-test` no [dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-test). Ele mira exatamente nesse problema, e vale a pena roubar o mecanismo mesmo que você nunca o instale.

## Instalar são duas linhas

O plugin usa o marketplace do GitHub Copilot CLI, o mesmo caminho de distribuição para o qual [o agente modernize-dotnet migrou no início de julho](/pt-br/2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin/):

```bash
/plugin marketplace add dotnet/skills
/plugin install dotnet-test@dotnet-agent-skills
```

Apesar de viver em `dotnet/`, o agente é poliglota: .NET, Python, TypeScript, JavaScript, Java, Go, Ruby, Rust, Swift, Kotlin, PowerShell e C++. Ele se limita a testes unitários, isolando o código sob teste e criando mocks para serviços externos. Nada de testes de integração, e2e ou de desempenho.

## A verificação que roda antes de reportar sucesso

Por dentro, `code-testing-generator` é um orquestrador interno (`user-invocable: false`) que distribui o trabalho para uma cadeia de subagentes: researcher, planner, implementer, builder, tester, fixer e linter. Ele escolhe um de três caminhos conforme o escopo, e a orientação é agradavelmente conservadora: a maioria das solicitações deveria seguir o caminho Direct e pular o pipeline inteiro, reservando os ciclos completos de Research para Plan para Implement quando o escopo cobre arquivos-fonte sem relação entre si.

O que importa é o que acontece antes de o agente poder encerrar. Para qualquer adição não trivial (cerca de cinco testes ou mais, ou uma lista enumerada de comportamentos), uma revisão prévia é obrigatória e executa três checagens:

1. **Análise de pseudo-mutação** via o skill `test-gap-analysis`: essas asserções realmente falhariam se a implementação mudasse?
2. **Revisão de profundidade das asserções** via `assertion-quality`: as asserções são fracas, ausentes ou tautológicas?
3. **Mapeamento entre prompt e cenários**: cada comportamento que você pediu tem um teste dedicado, e não apenas incidental?

Essa é a diferença entre um teste que o compilador aceita e um teste que merece existir:

```csharp
// Fails the assertion-quality check: green even if Apply() returns input unchanged
Assert.NotNull(cart.Apply(coupon));

// Survives pseudo-mutation: pins the actual behavior
var result = cart.Apply(coupon);
Assert.Equal(90.00m, result.Total);
Assert.Single(result.AppliedDiscounts, d => d.Code == "SAVE10");
```

Só depois disso ele compila o workspace inteiro, roda a suíte completa e verifica se a descoberta de testes do próprio repositório encontra os novos.

## O que os números dizem

A Microsoft relata uma taxa de conclusão de 92.1% (140 de 152 tarefas) contra 78.9% do Copilot sem o agente, com a diferença aumentando em prompts vagos: 88.8% contra 66.3%. O tempo médio por tarefa foi de 359 segundos, produzindo 72.4% de cobertura de linhas e 49.8% de branches.

Leia o número de branches com honestidade. Metade dos seus branches continua sem cobertura, o que é mais ou menos o que se espera de um agente que para quando o checklist dele fecha, e não quando uma meta de cobertura é atingida. O valor aqui não é substituir você escrevendo testes. É que a verificação de mutação e asserções é uma resposta codificada para "como eu sei se vale a pena manter este teste gerado", e você pode levar essa ideia para qualquer agente que já use.
