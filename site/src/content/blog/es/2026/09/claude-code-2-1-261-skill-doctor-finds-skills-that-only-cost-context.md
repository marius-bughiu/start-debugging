---
title: "Claude Code 2.1.261 agrega /skill-doctor: encuentra las skills que solo te cuestan contexto"
description: "El cuerpo de una skill se carga bajo demanda, pero su nombre y su descripción viven en un listado que siempre está en el prompt, limitado al 1% de la ventana de contexto. Claude Code 2.1.261 agrega /skill-doctor para decirte qué skills cargadas nunca se usan y cuánto cuesta cada una, para que las podes antes de que el presupuesto empiece a desalojar las que sí usas."
pubDate: 2026-09-05
tags:
  - "claude-code"
  - "agent-skills"
  - "ai-agents"
  - "context-window"
lang: "es"
translationOf: "2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context"
translatedBy: "claude"
translationDate: 2026-09-05
---

Claude Code 2.1.261 se publicó el 4 de septiembre con un comando pequeño que responde una pregunta que casi nadie con un directorio `~/.claude/skills` lleno ha podido responder: `/skill-doctor` muestra qué skills cargadas quedan sin usar y cuánto cuestan en contexto, para que las podas. El comando todavía no aparece en la [referencia de comandos](https://code.claude.com/docs/en/commands), pero el mecanismo sobre el que informa sí está documentado, y vale la pena entenderlo antes de leer la salida.

## Una skill que nunca invocas no es gratis

El modelo mental habitual es que las skills son baratas porque se cargan de forma perezosa. Eso es verdad a medias. El cuerpo de un `SKILL.md` solo entra en la conversación cuando se invoca la skill. El nombre y la descripción no: Claude Code carga en el contexto un listado con el nombre y la descripción de cada skill para que el modelo sepa qué hay disponible.

Ese listado tiene un presupuesto fijo. Según la [documentación de skills](https://code.claude.com/docs/en/skills), "scales at 1% of the model's context window", y el texto combinado de cada entrada se limita a 1 536 caracteres pase lo que pase. Cuando el listado desborda el presupuesto, Claude Code empieza a descartar descripciones, comenzando por las skills que menos invocas.

Así que una skill sin usar cuesta más que sus propios tokens. Compite por un presupuesto compartido con las skills de las que dependes, y una descripción recortada pierde justo las palabras clave que el modelo necesita para reconocer tu solicitud. El resultado es una skill que deja de activarse en silencio, sin ningún error que lo explique. `/doctor` ya estimaba el costo total del listado y sus principales contribuyentes; 2.1.261 separa en su propio informe la vista por skill de usadas frente a no usadas.

## Convertir el informe en configuración

Una vez que sabes qué entradas sobran, `skillOverrides` en `.claude/settings.json` cambia la visibilidad sin tocar el `SKILL.md` de un repositorio compartido:

```json
{
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "user-invocable-only",
    "old-migration-helper": "off"
  }
}
```

`"name-only"` mantiene la skill en el listado pero elimina su descripción, liberando presupuesto. `"user-invocable-only"` la oculta al modelo y deja `/deploy` disponible para escribirlo tú. `"off"` la oculta para ambos. Para una skill propia, el equivalente en el frontmatter es `disable-model-invocation: true`, que quita la descripción del contexto por completo. Ten en cuenta que las skills de plugins ignoran `skillOverrides`; esas se gestionan con `/plugin`.

Si el informe dice que todas las skills se ganan su lugar, sube el techo en lugar de recortar: `skillListingBudgetFraction` toma una fracción (`0.02` para el 2%), `SLASH_COMMAND_TOOL_CHAR_BUDGET` toma una cantidad fija de caracteres y `skillListingMaxDescChars` mueve el límite de 1 536 caracteres por entrada. Después confírmalo con la fila Skills de `/context`, que desde la v2.1.196 informa el tamaño del listado ya aplicado el presupuesto, no el texto completo.

La misma versión agrega otros dos controles de contexto que conviene conocer: `bashOutputMaxChars` y `taskOutputMaxChars` suben cuánta salida de comandos y de tareas en segundo plano recibe Claude en línea antes de que se vuelque a un archivo, hasta 128K caracteres, y `--append-subagent-system-prompt-file` lee el prompt de sistema de un subagente desde un archivo cuando es demasiado grande para la línea de comandos. Si vas atrasado con el tren de versiones, [2.1.259 agregó managedMcpServers](/es/2026/09/claude-code-2-1-259-managed-mcp-servers-without-mdm/) dos días antes.

Todos los detalles en el [changelog de Claude Code](https://code.claude.com/docs/en/changelog).
