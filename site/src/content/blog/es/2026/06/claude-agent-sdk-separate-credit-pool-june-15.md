---
title: "El Claude Agent SDK y claude -p tendrán su propio pool de créditos el 15 de junio"
description: "Anthropic separará el uso programático de Claude de tu suscripción el 2026-06-15. Esto es lo que cuenta como programático, el crédito por plan y cómo evitar que tus agentes de CI se detengan en silencio."
pubDate: 2026-06-05
tags:
  - "claude-code"
  - "ai-agents"
  - "anthropic"
lang: "es"
translationOf: "2026/06/claude-agent-sdk-separate-credit-pool-june-15"
translatedBy: "claude"
translationDate: 2026-06-05
---

Si ejecutas Claude en un pipeline, marca el 2026-06-15 en tu calendario. A partir de ese día, Anthropic saca todo el uso programático de Claude de los límites de tu suscripción y lo pasa a un pool de créditos mensual independiente y finito, facturado a los precios de lista de la API. El chat interactivo y la terminal interactiva quedan exactamente como están. El cambio solo afecta a las cargas de trabajo que no puedes vigilar en tiempo real, que son justamente las más propensas a fallar en silencio.

## Qué cuenta como "programático"

La separación tiene que ver con cómo se invoca a Claude, no con qué modelo llamas. Lo siguiente consume del nuevo pool de créditos en lugar de los límites de uso de tu plan:

- El Claude Agent SDK en cualquier proyecto con scripts o personal.
- `claude -p`, el modo headless no interactivo de Claude Code.
- Claude Code ejecutándose dentro de GitHub Actions.
- Aplicaciones de terceros que se autentican a través del Agent SDK.

El chat web, de escritorio y móvil, más la sesión de terminal interactiva que controlas a mano, siguen en tu suscripción. También Claude Cowork. Si hay una persona escribiendo, nada cambia.

## El crédito por plan

Cada plan recibe un crédito mensual fijo, dimensionado aproximadamente a su nivel:

| Plan | Crédito mensual |
| --- | --- |
| Pro | $20 |
| Max 5x | $100 |
| Max 20x | $200 |
| Team Standard (por asiento) | $20 |
| Team Premium (por asiento) | $100 |
| Enterprise Premium (por asiento) | $200 |

Una vez agotado ese crédito, las solicitudes se facturan a los precios de lista de la API o se rechazan, según un interruptor de "usage credits" en la configuración de tu cuenta. Un bucle de agente nocturno que cabía cómodamente en una suscripción Max 20x ahora puede agotarse a mitad de mes, y un trabajo de CI que antes "simplemente funcionaba" puede empezar a devolver errores en cuanto el pool se vacíe.

## Haz que la automatización sea predecible: dale su propia clave

La solución más limpia es dejar de hacer que la automatización tome prestada tu suscripción. Apunta las cargas headless a una clave de API dedicada, para que el gasto sea medido, atribuible y aislado de tu asiento interactivo. En GitHub Actions eso es un cambio de una línea:

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Claude Code headless
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude -p "Triage the newest issue and label it" \
            --allowedTools "Bash(gh:*)"
```

Con `ANTHROPIC_API_KEY` definida, `claude -p` y el Agent SDK se autentican contra la cuenta de API en lugar de tu crédito de suscripción, así que el pool del 15 de junio nunca entra en juego para ese trabajo. Pagas precios de lista en cualquier caso, pero ahora la factura vive donde puedes presupuestarla.

## Antes de la fecha límite

Vale la pena hacer tres cosas esta semana. Reclama el crédito único del correo que envió Anthropic (es una acción manual en la configuración de la cuenta). Audita cuánto cuesta realmente tu uso programático a precios de API, para saber si el crédito cubre una semana o un mes. Luego avisa a quien administra tu CI que la asignación mensual ahora es finita, y decide por cada pipeline si el excedente debe facturarse o fallar de forma estricta.

Para los términos oficiales, lee las [notas de la versión de Claude](https://support.claude.com/en/articles/12138966-release-notes) y el [newsroom de Anthropic](https://www.anthropic.com/news).
