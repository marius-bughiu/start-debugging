---
title: "Claude Code 2.1.213 impõe limites rígidos a frotas de subagentes descontroladas"
description: "A versão 2.1.213 limita subagentes concorrentes e impede por padrão os aninhados, sobre os limites por sessão da 2.1.212. Estes são os novos padrões e variáveis de ambiente."
pubDate: 2026-07-22
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
lang: "pt-br"
translationOf: "2026/07/claude-code-2-1-213-caps-runaway-subagent-fleets"
translatedBy: "claude"
translationDate: 2026-07-22
---

Se você já viu um fluxo de trabalho do Claude Code se expandir, gerar subagentes que geram seus próprios subagentes e consumir em silêncio o seu orçamento enquanto você ia pegar um café, as duas últimas versões são para você. O Claude Code 2.1.213, lançado esta semana, adiciona um limite de concorrência aos subagentes e impede que eles se aninhem por padrão. Ele se apoia diretamente nos tetos por sessão que chegaram na 2.1.212. Juntos, eles transformam o "torça para o laço terminar" em um conjunto de limites explícitos e ajustáveis.

## O que a 2.1.213 muda

Dois comportamentos mudaram, e ambos são grades de segurança em torno do trabalho com agentes em paralelo.

Primeiro, agora há um teto de quantos subagentes rodam ao mesmo tempo. O padrão é 20. Se um fluxo de trabalho tentar iniciar mais, os excedentes vão para a fila em vez de dispararem todos de uma vez. Você sobrescreve isso com uma variável de ambiente:

```bash
export CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=8
```

Segundo, e mais importante, os subagentes não geram mais subagentes aninhados por padrão. Antes da 2.1.213, um subagente podia delegar a outro subagente, que podia delegar de novo, e a profundidade era praticamente ilimitada. Era assim que um único prompt de nível superior podia inflar para dezenas de sessões concorrentes. Agora a profundidade de geração é limitada, e você opta por um aninhamento mais profundo de forma explícita:

```bash
# Allow subagents to spawn one more level down
export CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2
```

O registro de mudanças da 2.1.213 também corrige uma falha relacionada: `--max-budget-usd` não estava parando os subagentes em segundo plano. Então, se você dependia de um teto em dólares para interromper um trabalho descontrolado, agora ele interrompe também os que estão em segundo plano.

## Os tetos por sessão da 2.1.212

Os limites da 2.1.213 se apoiam sobre dois tetos por sessão da 2.1.212, algumas builds depois da [versão 2.1.208](/pt-br/2026/07/claude-code-2-1-208-vim-insert-mode-remaps-jj-to-escape/). Uma única sessão agora tem um orçamento rígido tanto para gerações de subagentes quanto para buscas na web, cada um com padrão de 200:

```bash
export CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION=50
export CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION=100
```

A 2.1.212 também tirou do caminho crítico as chamadas de ferramentas MCP de longa duração. Qualquer chamada MCP que rode por mais de dois minutos agora vai para segundo plano automaticamente, de modo que uma ferramenta lenta não bloqueia mais o turno. Você pode ajustar o limiar ou desativar o comportamento:

```bash
# Background MCP calls after 90 seconds instead of 120
export CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=90000
```

## Por que isso importa

Frotas de agentes são baratas de iniciar e caras de rodar. O modo de falha nunca foi um único subagente, era a recursão: um orquestrador gerando trabalhadores, trabalhadores gerando ajudantes, e nenhum número limitando o total. Padrões de 20 concorrentes, sem aninhamento e 200 gerações por sessão significam que um prompt que se comporta mal agora bate em uma parede em vez de em uma fatura. Se você está criando fluxos de trabalho com expansão em leque, leia os padrões e então aumente os dois ou três que o seu trabalho real de fato precisa, em vez de remover todos os limites.

Todos os detalhes estão no [registro de mudanças do Claude Code](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
