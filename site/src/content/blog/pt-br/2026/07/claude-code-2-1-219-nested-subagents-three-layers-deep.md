---
title: "Claude Code 2.1.219 reabre os subagentes aninhados, com três camadas"
description: "A versão 2.1.219 eleva a profundidade padrão de criação de subagentes de 1 para 3, adiciona a chave de configuração workflowSizeGuideline e traz uma lista de domínios permitidos que falha fechada."
pubDate: 2026-07-26
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
lang: "pt-br"
translationOf: "2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep"
translatedBy: "claude"
translationDate: 2026-07-26
---

As últimas duas semanas de versões do Claude Code foram um cabo de guerra sobre quanta corda uma frota de agentes recebe. A versão 2.1.213 tirou o aninhamento por completo. A versão 2.1.219, que chegou em 2026-07-24, devolve o recurso com um número junto: subagentes agora podem criar seus próprios subagentes até a profundidade 3 por padrão, contra 1 antes.

## O padrão virou duas vezes em duas semanas

A linha do [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) é direta: "subagentes agora podem criar subagentes aninhados até a profundidade 3 por padrão (antes 1); defina CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 para desativar o aninhamento".

Vale acompanhar o histórico, porque o comportamento mudou três vezes. Da v2.1.172 até a v2.1.216, subagentes aninhavam até cinco camadas e o limite não era configurável. Depois a 2.1.213 [colocou limites rígidos nas frotas de subagentes descontroladas](/pt-br/2026/07/claude-code-2-1-213-caps-runaway-subagent-fleets/) e baixou o padrão para profundidade 1, ou seja, um subagente não podia delegar nada: você pedia para ele levantar ajudantes e ele fazia o trabalho sozinho. A 2.1.219 fica em 3.

O botão é o mesmo, só o padrão dele mudou. Para voltar à delegação plana, de uma camada só, fixe o valor no `settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1"
  }
}
```

A profundidade 3 é um número deliberado, não um número redondo. É exatamente o que um fan-out de revisão precisa: sua conversa principal cria um revisor, o revisor cria um verificador por achado, e cada verificador ainda pode delegar uma consulta pontual. Na profundidade 1 esse formato colapsava em um único subagente fazendo tudo em sequência dentro de uma janela de contexto.

## Uma diretriz de tamanho como contrapeso

Reabrir o aninhamento sem um freio só recriaria o problema que a 2.1.213 resolveu, então a mesma versão adiciona um. Fluxos de trabalho dinâmicos agora usam por padrão uma diretriz de tamanho média, mirando menos de 15 agentes, e essa diretriz não é mais apenas um botão do `/config`. Existe uma chave de configuração para ela:

```json
{
  "workflowSizeGuideline": "medium"
}
```

Defina em qualquer arquivo de configuração e a linha do `/config` se esconde. A linha de status do fluxo em execução agora também mostra o tamanho atual, então você vê sob qual diretriz um fluxo está operando enquanto ele roda. Note que isso é consultivo: molda quantos agentes o modelo tenta criar, não é um teto rígido. Os tetos de verdade continuam sendo os limites de concorrência e de subagentes por sessão.

## Listas de domínios permitidos que falham fechadas

A outra mudança que vale configurar hoje é `sandbox.network.strictAllowlist`. Por padrão, o sandbox pergunta na primeira vez que um comando precisa de um domínio que você não liberou. Implantações gerenciadas já conseguiam bloquear em vez de perguntar, via `allowManagedDomainsOnly`. Agora qualquer arquivo de configuração pode falhar fechado:

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "strictAllowlist": true,
      "allowedDomains": ["github.com", "*.npmjs.org"]
    }
  }
}
```

Para execuções sem supervisão, é essa a configuração que você quer. Um prompt que ninguém responde é um travamento, e com o aninhamento de volta há mais processos que podem esbarrar em um.

Também na 2.1.219: Claude Opus 5 (`claude-opus-5`) é o modelo Opus padrão, com 1M de contexto e modo rápido a $10/$50 por Mtok, e o Opus 4.7 saiu de vez do modo rápido.
