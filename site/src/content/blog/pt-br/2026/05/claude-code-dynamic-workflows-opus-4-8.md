---
title: "Os Dynamic Workflows do Claude Code distribuem um único prompt entre até 1000 subagentes"
description: "A Anthropic lançou o Opus 4.8 em 2026-05-28 com os Dynamic Workflows, uma versão prévia de pesquisa no Claude Code que escreve um script de orquestração em JavaScript para rodar de dezenas a centenas de subagentes em paralelo, com limite de 1000 por execução."
pubDate: 2026-05-31
tags:
  - "claude-code"
  - "ai-agents"
  - "opus-4-8"
lang: "pt-br"
translationOf: "2026/05/claude-code-dynamic-workflows-opus-4-8"
translatedBy: "claude"
translationDate: 2026-05-31
---

A Anthropic lançou o Claude Opus 4.8 em 2026-05-28, e a manchete para quem vive em um terminal não é o salto nos benchmarks. São os Dynamic Workflows: uma versão prévia de pesquisa dentro do Claude Code que transforma uma única solicitação em linguagem natural em um script que orquestra de dezenas a centenas de subagentes em paralelo, com limite de 1000 agentes por execução. Essa é a diferença entre pedir a um agente que avance por uma tarefa em um loop e fazer com que o Claude escreva um programa que decompõe a tarefa, distribui o trabalho e verifica os resultados antes de reportar.

## Um workflow é um script, não um loop de chat

O mecanismo é a parte interessante. Quando você pede algo grande ("audite cada controller em busca de verificações de autorização ausentes" ou "migre esta base de código de 200k linhas para fora do Newtonsoft.Json"), o Claude escreve um script de orquestração em JavaScript e um runtime o executa em segundo plano. Você não fica cuidando de uma única janela de contexto que vai enchendo aos poucos. O script gera subagentes novos, cada um com seu próprio contexto, e coleta a saída estruturada deles.

O formato do script gerado é aproximadamente este:

```javascript
export const meta = {
  name: 'audit-authz',
  description: 'Find controllers missing [Authorize] and verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Verify' }],
};

// Fan out: one finder per area, then adversarially verify each hit
const findings = await pipeline(
  AREAS,
  area => agent(`Scan ${area} for actions missing authorization`, {
    phase: 'Scan',
    schema: FINDINGS_SCHEMA,
  }),
  review => parallel(review.findings.map(f => () =>
    agent(`Try to refute: ${f.title}. Is this really unprotected?`, {
      phase: 'Verify',
      schema: VERDICT_SCHEMA,
    }).then(v => ({ ...f, verdict: v }))
  ))
);

return findings.flat().filter(f => f.verdict?.isReal);
```

Os padrões em que a Anthropic se apoia aparecem aqui: distribuição em paralelo e depois verificação adversarial, em que agentes separados são instruídos a refutar cada achado antes que ele sobreviva. A saída é validada contra um schema JSON, de modo que o orquestrador recebe dados tipados em vez de prosa que ele teria de parsear.

## Quanto custa para você, e quando é acionado

O risco óbvio é o custo. Uma execução que legitimamente gera centenas de agentes queima tokens rápido, que é exatamente o motivo pelo qual o limite de 1000 agentes existe como freio contra disparada. O Claude Code mostra o script e o plano aproximado antes do primeiro workflow disparar e pede a sua confirmação.

Há duas formas de entrar. Você pode descrever o objetivo diretamente e deixar o Claude decidir que um workflow se justifica, ou pode ligar o ajuste de esforço `ultracode` para que ele recorra à orquestração automaticamente em tarefas substanciais. O Opus 4.8 também traz um Fast mode mais barato (cerca de 2x a tarifa padrão por aproximadamente 2,5x a velocidade), o que torna o padrão de muitos agentes pequenos menos penoso do que teria sido em versões anteriores.

Dynamic Workflows é uma versão prévia de pesquisa, então trate a superfície da API como instável e fique de olho no seu uso. Mas o modelo por trás é sólido: pare de iterar um agente contra uma transcrição que só cresce e comece a escrever programas que coordenam muitos agentes de vida curta. Todos os detalhes estão no [anúncio do Opus 4.8](https://www.anthropic.com/news) e no [changelog do Claude Code](https://code.claude.com/docs/en/changelog).
