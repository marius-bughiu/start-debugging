---
title: "Las automatizaciones de Copilot ahora se disparan con comentarios de issues y PR"
description: "El changelog de GitHub del 2026-08-03 agrega un disparador por comentario a las automatizaciones del agente en la nube de Copilot, y reemplaza el workflow issue_comment más el PAT más el envío por REST que los equipos venían armando a mano desde junio."
pubDate: 2026-08-06
tags:
  - "github-copilot"
  - "ai-agents"
  - "automation"
  - "ci-cd"
lang: "es"
translationOf: "2026/08/copilot-automations-now-trigger-on-issue-and-pr-comments"
translatedBy: "claude"
translationDate: 2026-08-06
---

El 2026-08-03 GitHub publicó [Trigger Copilot automations with comments](https://github.blog/changelog/2026-08-03-trigger-copilot-automations-with-comments/). Las automatizaciones del agente en la nube de Copilot ahora pueden dispararse cuando se crea un comentario en un issue o en un pull request, con coincidencia contra el texto de comentario que tú definas. Es una entrada de changelog de una sola línea que elimina una cantidad sorprendente de YAML.

## El conjunto de disparadores anterior estaba pensado en eventos, no en conversaciones

Las automatizaciones llegaron el 2026-06-02 con cuatro disparadores: por horario (cada hora, diario o semanal), cuando se crea un issue, cuando se abre un pull request y cuando se sincroniza un pull request. Cada uno de ellos se activa en el momento en que algo entra en un estado. Ninguno cubre el patrón que los equipos realmente usan, que es una persona leyendo primero el hilo y después diciendo "adelante".

Así que escribías el pegamento tú mismo. La forma era siempre la misma: un workflow de `issue_comment`, una guarda de texto, un token y un `POST` a la [API REST de Agent Tasks](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/).

```yaml
name: copilot-on-comment
on:
  issue_comment:
    types: [created]

jobs:
  dispatch:
    if: startsWith(github.event.comment.body, '/copilot fix')
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch an agent task
        env:
          GH_USER_TOKEN: ${{ secrets.COPILOT_USER_TOKEN }}
        run: |
          curl -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2026-03-10" \
            -H "Authorization: Bearer $GH_USER_TOKEN" \
            https://api.github.com/agents/repos/${{ github.repository }}/tasks \
            -d '{
              "prompt": "Investigate the stack trace in issue #${{ github.event.issue.number }} and open a fix PR.",
              "base_ref": "main",
              "create_pull_request": true
            }'
```

Cada línea de ahí es una superficie de mantenimiento. `secrets.COPILOT_USER_TOKEN` tiene que ser un token de usuario a servidor porque el `GITHUB_TOKEN` integrado no envía tareas al agente, y expira en el calendario de alguien. La guarda es una coincidencia de prefijo en crudo, así que `/copilot fixup` también la dispara. `X-GitHub-Api-Version: 2026-03-10` fija una versión preliminar pública cuya forma de respuesta puede cambiar. Y como la frase disparadora vive en un archivo, cambiarla es un pull request.

## Cómo se ve la configuración en su lugar

Abre la pestaña **Agents** del repositorio, elige **Automations** en la barra lateral y haz clic en **Create new**. Una automatización es un nombre, un prompt, uno o más disparadores, un modelo opcional y un conjunto de herramientas. Con el nuevo disparador indicas qué texto de comentario debe iniciarla, y esa es toda la integración. Sin token, sin archivo de workflow, sin encabezado de versión de API.

La lista de herramientas es donde va el pensamiento real. Es el límite de permisos de la ejecución, no un ajuste de comodidad: decide qué puede tocar el agente una vez que un comentario lo despierta. El botón **Suggest tools** propone un conjunto a partir de tu prompt, pero tómalo como punto de partida y recórtalo a lo que la tarea realmente necesita.

## Restricciones que conviene revisar antes de planificar con esto

Las automatizaciones requieren un repositorio **privado o interno**. No están disponibles en repositorios públicos, así que un proyecto de código abierto no puede usar esto para clasificar issues de paso. Necesitas acceso de escritura para crear una, el plan debe ser Copilot Pro, Pro+, Max, Business o Enterprise, y en Business y Enterprise un administrador debe habilitar primero la política del agente en la nube. **Run now** te permite probar una automatización antes de que un comentario real la dispare.

Vale la pena detenerse en una consecuencia. Antes de esto, enviar una tarea al agente requería un token que un mantenedor aprovisionaba deliberadamente. Ahora cualquiera que pueda comentar en un issue del repositorio puede consumir tiempo de agente. La visibilidad privada o interna acota el radio de impacto, pero mantén la frase disparadora específica y la lista de herramientas acotada.
