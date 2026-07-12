---
title: "Side chats de Cursor 3.11: bifurca una pregunta sin descarrilar el agente principal"
description: "Cursor 3.11 (10 de julio de 2026) agrega los side chats, hilos de agente paralelos y persistentes que abres con /side o /btw y traes de vuelta a la conversacion principal con una mencion. Ademas, busqueda de transcripciones con Cmd+K y nuevos hooks de agentes en la nube."
pubDate: 2026-07-12
tags:
  - "cursor"
  - "ai-agents"
  - "llm"
  - "productivity"
lang: "es"
translationOf: "2026/07/cursor-3-11-side-chats-parallel-agent-threads"
translatedBy: "claude"
translationDate: 2026-07-12
---

Cursor 3.11 se lanzo el 10 de julio de 2026, y su caracteristica principal resuelve una molestia concreta: estas metido de lleno en una tarea del agente, se te ocurre un desvio ("un momento, ¿este repo usa `IAsyncEnumerable` en algun lado?") y preguntarlo descarrila el hilo que venias construyendo. Los side chats te dan un lugar para hacer esa pregunta sin tocar la conversacion principal.

## Un side chat es un agente completo, no un borrador

El detalle importante es que un side chat no es un popup liviano. Es una conversacion de agente completa y persistente que corre junto a tu chat principal. Puedes darle seguimiento, cerrarlo y retomarlo despues, y mantiene su propio contexto todo el tiempo. Eso lo hace distinto de borrar tu prompt y volver a escribir: el desvio se convierte en su propio hilo persistente al que puedes volver.

Lo abres de tres formas: el comando `/side`, el atajo `/btw` o el boton de mas en la parte superior del panel de chat.

```text
# In the middle of a refactor, spin off a question without losing your place:
/btw where do we register the JWT bearer handler?

# Or explicitly:
/side compare our current retry policy to Polly's default
```

Los side chats se inclinan hacia leer, buscar y responder mientras tu agente principal mantiene su propio estado intacto. La tarea principal no pierde su plan porque te fuiste a buscar una respuesta.

## Traer la respuesta de vuelta con una mencion

Lo que hace que esto sea mas que una segunda pestaña es el camino de regreso. Una vez que un side chat resolvio algo, lo mencionas con @ desde el hilo principal para traer ese contexto de vuelta:

```text
# Back in the main chat, fold the side chat's findings into the real work:
@side-chat: retry-policy apply that Polly comparison to OrderService
```

Asi que el flujo es: bifurcas, investigas en aislamiento y luego injertas la conclusion de vuelta en el agente principal sin haber tenido que volver a explicar nada. El aislamiento mantiene limpio el contexto principal mientras exploras; la mencion significa que la exploracion no fue en vano.

## El resto de 3.11

Vale la pena conocer dos cambios mas. La busqueda de conversaciones ahora corre sobre un indice local: `Cmd+K` busca entre miles de transcripciones de agente pasadas, y `Cmd+F` salta entre coincidencias dentro de una sola conversacion. Los selectores de repo y de proyecto se rediseñaron para acotar por ubicacion (This Computer, Cloud, Remote Machines) y para dejarte crear un proyecto o conectar GitHub/GitLab sin salir del selector.

Para quien programe el comportamiento del agente, 3.11 tambien agrega hooks de agentes en la nube como `beforeSubmitPrompt` y `afterAgentResponse`, que te permiten observar y controlar el razonamiento de un agente y el comportamiento de sus subagentes:

```json
{
  "hooks": {
    "beforeSubmitPrompt": "./scripts/inject-guardrails.sh",
    "afterAgentResponse": "./scripts/lint-agent-output.sh"
  }
}
```

Si ya corres workers en paralelo, los side chats se ubican una capa por debajo: no son otro agente haciendo trabajo, sino un lugar para pensar en voz alta sin que el agente principal lo escuche hasta que tu decidas que debe hacerlo. Para ver como se compara la historia mas pesada de multiples workers entre herramientas, lee [Subagentes de Cursor vs subagentes de Claude Code](/2026/07/cursor-subagents-vs-claude-code-subagents/). Las notas completas estan en el [changelog de Cursor](https://cursor.com/changelog).
