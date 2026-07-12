---
title: "Side chats do Cursor 3.11: ramifique uma pergunta sem descarrilar o agente principal"
description: "O Cursor 3.11 (10 de julho de 2026) adiciona os side chats, threads de agente paralelas e duraveis que voce abre com /side ou /btw e traz de volta para a conversa principal com uma mencao. Alem de busca de transcricoes com Cmd+K e novos hooks de agentes na nuvem."
pubDate: 2026-07-12
tags:
  - "cursor"
  - "ai-agents"
  - "llm"
  - "productivity"
lang: "pt-br"
translationOf: "2026/07/cursor-3-11-side-chats-parallel-agent-threads"
translatedBy: "claude"
translationDate: 2026-07-12
---

O Cursor 3.11 foi lancado em 10 de julho de 2026, e o recurso principal resolve um incomodo especifico: voce esta imerso em uma tarefa do agente, surge um desvio na sua cabeca ("espera, esse repositorio usa `IAsyncEnumerable` em algum lugar?") e perguntar isso descarrila a thread que voce vinha construindo. Os side chats dao a voce um lugar para fazer essa pergunta sem tocar na conversa principal.

## Um side chat e um agente completo, nao um rascunho

O detalhe importante e que um side chat nao e um popup leve. E uma conversa de agente completa e duravel que roda ao lado do seu chat principal. Voce pode dar seguimento, fecha-lo e retoma-lo depois, e ele mantem o proprio contexto o tempo todo. Isso o torna diferente de apagar seu prompt e digitar de novo: o desvio vira a propria thread persistente a qual voce pode voltar.

Voce o abre de tres formas: o comando `/side`, o atalho `/btw` ou o botao de mais no topo do painel de chat.

```text
# In the middle of a refactor, spin off a question without losing your place:
/btw where do we register the JWT bearer handler?

# Or explicitly:
/side compare our current retry policy to Polly's default
```

Os side chats tendem a ler, buscar e responder enquanto seu agente principal mantem o proprio estado intacto. A tarefa principal nao perde o plano porque voce foi atras de uma resposta.

## Trazendo a resposta de volta com uma mencao

O que torna isso mais do que uma segunda aba e o caminho de volta. Depois que um side chat descobriu algo, voce o menciona com @ a partir da thread principal para trazer esse contexto de volta:

```text
# Back in the main chat, fold the side chat's findings into the real work:
@side-chat: retry-policy apply that Polly comparison to OrderService
```

Entao o fluxo e: ramifique, investigue de forma isolada e depois enxerte a conclusao de volta no agente principal sem ter que reexplicar nada. O isolamento mantem o contexto principal limpo enquanto voce explora; a mencao significa que a exploracao nao foi desperdicada.

## O resto do 3.11

Vale conhecer mais duas mudancas. A busca de conversas agora roda sobre um indice local: `Cmd+K` busca entre milhares de transcricoes de agente anteriores, e `Cmd+F` pula entre correspondencias dentro de uma unica conversa. Os seletores de repositorio e de projeto foram refeitos para delimitar por localizacao (This Computer, Cloud, Remote Machines) e para deixar voce criar um projeto ou conectar GitHub/GitLab sem sair do seletor.

Para quem programa o comportamento do agente, o 3.11 tambem adiciona hooks de agentes na nuvem como `beforeSubmitPrompt` e `afterAgentResponse`, que permitem observar e controlar o raciocinio de um agente e o comportamento de seus subagentes:

```json
{
  "hooks": {
    "beforeSubmitPrompt": "./scripts/inject-guardrails.sh",
    "afterAgentResponse": "./scripts/lint-agent-output.sh"
  }
}
```

Se voce ja roda workers em paralelo, os side chats ficam uma camada abaixo: nao sao outro agente fazendo trabalho, mas um lugar para pensar em voz alta sem que o agente principal escute ate voce decidir que ele deve. Para ver como a historia mais pesada de multiplos workers se compara entre ferramentas, leia [Subagentes do Cursor vs subagentes do Claude Code](/2026/07/cursor-subagents-vs-claude-code-subagents/). As notas completas estao no [changelog do Cursor](https://cursor.com/changelog).
