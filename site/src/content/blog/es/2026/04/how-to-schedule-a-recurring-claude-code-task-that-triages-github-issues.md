---
title: "Cómo agendar una tarea recurrente de Claude Code que clasifique issues de GitHub"
description: "Tres formas de poner Claude Code en una agenda que clasifique issues de GitHub sin supervisión en 2026: Routines en la nube (la nueva /schedule), claude-code-action v1 con cron + issues.opened, y /loop dentro de una sesión. Incluye un prompt ejecutable de Routine, un YAML completo de GitHub Actions, trampas de jitter e identidad, y cuándo elegir cuál."
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
lang: "es"
translationOf: "2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues"
translatedBy: "claude"
translationDate: 2026-04-29
---

Una pasada de triage agendada sobre un backlog de GitHub es una de las cosas más útiles que le puedes pedir a un agente de codificación, y es también la más fácil de equivocar. A abril de 2026 hay tres primitivas distintas de "agendar una tarea de Claude Code", viven en runtimes diferentes, y tienen modos de fallo muy diferentes. Esta publicación recorre las tres para el mismo trabajo, "cada mañana de día laborable a las 8am, etiqueta y enruta cada issue nuevo en mi repo", usando **Claude Code v2.1.x**, la GitHub Action **`anthropics/claude-code-action@v1`**, y el **research preview de routines** que Anthropic envió el [14 de abril de 2026](https://claude.com/blog/introducing-routines-in-claude-code). El modelo es `claude-sonnet-4-6` para el prompt de triage y `claude-opus-4-7` para la pasada de deduplicación.

Respuesta corta: usa una **Routine en la nube** con un disparador de horario y un disparador `issues.opened` de GitHub si tu cuenta tiene Claude Code on the web habilitado. Usa un workflow de **GitHub Actions schedule + workflow_dispatch + issues.opened** si lo necesitas en Bedrock, Vertex o tus propios runners. Usa **`/loop`** solo para encuestas ad hoc mientras una sesión está abierta, nunca para triage no supervisado.

## Por qué existen las tres opciones, y cuál elegir

Anthropic envía deliberadamente tres schedulers distintos porque las contrapartidas son reales. La [documentación oficial de scheduling](https://code.claude.com/docs/en/scheduled-tasks) las pone en una página:

| Capacidad                   | Routines (nube)          | GitHub Actions          | `/loop` (sesión)          |
| :-------------------------- | :----------------------- | :---------------------- | :------------------------ |
| Dónde corre                 | Infraestructura Anthropic | Runner alojado en GitHub | Tu terminal              |
| Sobrevive a un portátil cerrado | Sí                   | Sí                      | No                        |
| Disparado por `issue.opened` | Sí (nativo)             | Sí (evento de workflow) | No                        |
| Acceso a archivos locales    | No (clon limpio)        | Sí (checkout)           | Sí (cwd actual)           |
| Intervalo mínimo             | 1 hora                  | 5 minutos (rareza de cron) | 1 minuto              |
| Auto-expira                  | No                      | No                      | 7 días                    |
| Prompts de permiso           | Ninguno (autónomo)      | Ninguno (`claude_args`) | Heredados de la sesión    |
| Requisito de plan            | Pro / Max / Team / Ent. | Cualquier plan con API key | CLI local              |

Para "clasificar cada issue nuevo y ejecutar una pasada diaria", la routine en la nube es la primitiva correcta. Tiene un disparador GitHub nativo, así que no tienes que cablear `actions/checkout`, el prompt es editable desde la web sin un PR, y las ejecuciones no consumen ninguno de tus minutos de GitHub Actions. La única razón para evitarla es si tu organización corre Claude por AWS Bedrock o Google Vertex AI, en cuyo caso las routines en la nube aún no están disponibles y se cae a la action.

## La routine de triage, de extremo a extremo

Una routine es "una configuración guardada de Claude Code: un prompt, uno o más repositorios, y un conjunto de connectors, empaquetados una vez y ejecutados automáticamente". Cada ejecución es una sesión autónoma de Claude Code en la nube, sin prompts de permiso, que clona tu repo desde la rama por defecto y escribe cualquier cambio de código a una rama prefijada con `claude/` por defecto.

Crea una desde dentro de cualquier sesión de Claude Code:

```text
# Claude Code 2.1.x
/schedule weekdays at 8am triage new GitHub issues in marius-bughiu/start-debugging
```

`/schedule` te lleva por el mismo formulario que muestra la [interfaz web en claude.ai/code/routines](https://claude.ai/code/routines): nombre, prompt, repositorios, entorno, connectors y disparadores. Todo lo que pones en la CLI es editable en la web, y la misma routine aparece en Desktop, web y CLI inmediatamente. Una restricción importante: `/schedule` solo añade disparadores de **horario**. Para añadir el disparador `issues.opened` de GitHub que hace el triage casi instantáneo, edita la routine en la web tras la creación.

### El prompt

Una routine corre sin humano en el loop, así que el prompt tiene que ser autocontenido. La frase de ejemplo del propio equipo de Anthropic en la [documentación de routines](https://code.claude.com/docs/en/web-scheduled-tasks) es "aplica etiquetas, asigna dueños según el área de código referenciada, y publica un resumen en Slack para que el equipo empiece el día con la cola arreglada". Concretamente:

```markdown
# Routine prompt: daily-issue-triage
# Model: claude-sonnet-4-6
# Repos: marius-bughiu/start-debugging

You are the issue triage bot for this repository. Every run, do the following.

1. List every issue opened or updated since the last successful run of this
   routine, using `gh issue list --search "updated:>=YYYY-MM-DD"` with the
   timestamp of the previous run from the routine's session history. If you
   cannot find a previous run, scope to the last 24 hours.

2. For each issue, classify it as exactly one of: bug, feature, docs,
   question, support, spam. Apply that label with `gh issue edit`.

3. Assess priority as one of: p0, p1, p2, p3. Apply that label too.
   p0 only when the issue describes a production-affecting regression
   with a reproducer.

4. Look up the touched code area. Use `gh search code --repo` and `rg`
   against the cloned working copy to find the most likely owner via
   the `CODEOWNERS` file. Assign that user. If there is no CODEOWNERS
   match, leave it unassigned and apply the `needs-triage` label.

5. Run a duplicate check. Use `gh issue list --search "<title keywords>
   in:title is:open"` to find similar open issues. If you find one with
   high confidence, post a comment on the new issue: "This looks like
   a duplicate of #N. Closing in favor of that thread; please reopen
   if I got it wrong." and then `gh issue close`.

6. Post a single Slack message to #engineering-triage via the connector
   summarizing what you did: counts per label, p0 issues by number, and
   any issue that you could not classify with confidence above 0.7.

Do not push any commits. Do not modify code. The only writes this routine
performs are GitHub label/assign/comment/close calls and one Slack message.
```

Dos detalles no obvios que vale la pena fijar:

- **El truco del "timestamp de la ejecución previa".** Las routines no tienen estado entre ejecuciones. Cada sesión es un clon limpio. Para evitar etiquetar el mismo issue dos veces, el prompt tiene que derivar el corte de algo durable. O bien (a) usa la identidad GitHub de la routine para aplicar una etiqueta `triaged-YYYY-MM-DD` y saltarse cualquier cosa con esa etiqueta, o (b) lee el timestamp del mensaje de resumen de Slack previo vía el connector. Ambas son fiables. Pedirle al modelo "recuerda cuándo corriste la última vez" no lo es.
- **Las reglas del modo autónomo.** Las routines corren sin prompts de permiso. La sesión puede correr comandos de shell, usar cualquier herramienta de cualquier connector incluido, y llamar a `gh`. Trata el prompt como tratarías la política de una cuenta de servicio: deletrea exactamente qué escrituras están permitidas.

### Los disparadores

En el formulario de edición de la routine, adjunta dos disparadores:

1. **Horario, días laborables a las 08:00.** Los horarios están en tu zona local y se convierten a UTC del lado del servidor, así que un horario US-Pacific y un horario CET disparan a la misma hora de pared dondequiera que aterrice la sesión en la nube. Las routines añaden un stagger determinístico de hasta unos minutos por cuenta, así que no pongas el horario en `0 8` si la sincronización exacta importa, ponlo en `:03` o `:07`.
2. **Evento de GitHub, `issues.opened`.** Esto hace que la routine dispare en segundos tras cada nuevo issue, además de la pasada de las 8am. Los dos no son redundantes: el disparador de horario captura todo lo que aterriza mientras la GitHub App está pausada o atrás del cap por hora por cuenta, y el disparador de evento evita que los issues frescos se queden fríos por un día laborable.

Para adjuntar el disparador `issues.opened`, la [Claude GitHub App](https://github.com/apps/claude) tiene que estar instalada en el repositorio. `/web-setup` desde la CLI da acceso solo a clonado y no habilita la entrega de webhooks, así que instalar la app desde la interfaz web es necesario.

### La expresión cron personalizada

Los presets de horario son por hora, diario, días laborables, y semanal. Para cualquier otra cosa, elige el preset más cercano en el formulario, luego baja a la CLI:

```text
/schedule update
```

Camina por los prompts hasta la sección de horario y suministra una expresión cron personalizada de 5 campos. La única regla dura es que el **intervalo mínimo es una hora**; una expresión como `*/15 * * * *` se rechaza al guardar. Si genuinamente necesitas una cadencia más estrecha, eso es señal de que quieres el camino de GitHub Actions o el disparador de evento, no el disparador de horario.

## El fallback de GitHub Actions

Si tu equipo está en Bedrock o Vertex, o simplemente prefieres el rastro de auditoría de un log de Actions, el mismo trabajo corre como un workflow con `claude-code-action@v1`. La action salió a GA el 26 de agosto de 2025 y la superficie v1 está unificada alrededor de dos entradas: un `prompt` y una cadena `claude_args` que pasa cualquier flag directo al CLI de Claude Code. La tabla completa de upgrade desde la superficie beta vive en la [documentación de GitHub Actions](https://code.claude.com/docs/en/github-actions#breaking-changes-reference).

```yaml
# .github/workflows/issue-triage.yml
# claude-code-action v1, claude-sonnet-4-6, schedule + issues.opened + manual
name: Issue triage

on:
  schedule:
    - cron: "3 8 * * 1-5"  # weekdays 08:03 UTC, off the :00 boundary
  issues:
    types: [opened]
  workflow_dispatch:        # manual run from the Actions tab

permissions:
  contents: read
  issues: write
  pull-requests: read
  id-token: write

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            EVENT: ${{ github.event_name }}
            ISSUE: ${{ github.event.issue.number }}

            On a schedule run, list open issues updated in the last 24 hours
            and triage each one. On an `issues.opened` event, triage only
            the single issue ${{ github.event.issue.number }}.

            For each issue:
            1. Classify as bug / feature / docs / question / support / spam.
            2. Assess priority p0 / p1 / p2 / p3.
            3. Apply both labels with `gh issue edit`.
            4. Resolve the touched area via CODEOWNERS and assign the owner,
               or apply `needs-triage` if no match.
            5. Search for duplicates by title keywords. Comment and close
               only if confidence is high.

            Do not edit code. Do not push. Only GitHub label / assign /
            comment / close calls are allowed.
          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 12
            --allowedTools "Bash(gh:*),Read,Grep"
```

Tres cosas que este workflow hace bien y que un cron hecho a mano no. **`workflow_dispatch`** junto a `schedule` pone un botón "Run workflow" en la pestaña Actions para que puedas probar sin esperar a las 8am. **`--allowedTools "Bash(gh:*),Read,Grep"`** usa la misma puerta que el CLI local; sin él, la action tendría también acceso a `Edit` y `Write`. **El minuto `:03`** evita el amplio retraso no determinístico que GitHub Actions añade a los disparadores cron de free-tier durante horas pico. Esto es esencialmente el [ejemplo de issue triage](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md) de la guía de soluciones de la action, con un disparador de horario y una allowlist de herramientas más estrecha.

## Cuándo `/loop` es la primitiva correcta

`/loop` es la tercera opción y es a la que recurrir **menos** para trabajo de triage. La [documentación de scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) deletrea las restricciones:

- Las tareas disparan solo mientras Claude Code está corriendo y ocioso. Cerrar la terminal las detiene.
- Las tareas recurrentes expiran a los 7 días de su creación.
- Una sesión puede tener hasta 50 tareas agendadas a la vez.
- Cron se respeta a granularidad de un minuto, con hasta 10% de jitter limitado a 15 minutos.

El uso correcto de `/loop` es niñear una routine de triage que aún estás afinando, no correr el triage en sí. Dentro de una sesión abierta apuntando al repo:

```text
/loop 30m check the last 5 runs of the daily-issue-triage routine on
claude.ai/code/routines and tell me which ones produced label edits
that look wrong. Skip silently if nothing has changed.
```

Claude convierte `30m` en una expresión cron, agenda el prompt bajo un ID generado de 8 caracteres, y lo redispara entre tus turnos hasta que pulsas `Esc` o pasan siete días. Eso es genuinamente útil para un loop de feedback de "está la routine derivando?" mientras un humano permanece en el teclado. Es la forma equivocada para "correr para siempre, sin supervisión".

## Trampas que vale la pena conocer antes de la primera ejecución

Algunas cosas te morderán en la primera ejecución agendada si no planificas:

**Identidad.** Las routines pertenecen a tu cuenta individual de claude.ai, y cualquier cosa que la routine haga a través de tu identidad GitHub conectada aparece como tú. Para un repo open-source, instala la routine bajo una cuenta bot dedicada, o usa el camino de GitHub Actions con una install separada de bot de [Claude GitHub App](https://github.com/anthropics/claude-code-action).

**Cap diario de ejecuciones.** Las routines tienen un cap diario por plan (Pro 5, Max 15, Team y Enterprise 25). Cada evento `issues.opened` es una ejecución, así que un repo que recibe 30 issues al día se cae antes del almuerzo a menos que actives uso adicional en facturación. La routine solo de horario y el camino de GitHub Actions ambos esquivan esto; el segundo se factura contra tokens de API.

**Seguridad de push de rama.** Una routine solo puede empujar a ramas prefijadas con `claude/` por defecto. El prompt de triage de arriba no empuja nada, pero extenderlo para abrir un PR de fix significa o bien aceptar el prefijo o habilitar **Allow unrestricted branch pushes** por repo. No flipees ese interruptor distraídamente.

**El header beta `experimental-cc-routine-2026-04-01`.** El endpoint `/fire` que respalda el disparador de API se envía bajo ese header hoy. Anthropic mantiene las dos versiones fechadas más recientes funcionando cuando rompen, así que mete el header en una constante y rota en flips de versión, no en cada webhook.

**Stagger y sin catch-up.** Ambos runtimes añaden un offset determinístico (hasta 10% del periodo para routines, mucho más amplio para Actions free-tier durante horas pico), y ninguno reproduce disparos perdidos. La combinación `schedule + issues.opened` maneja la brecha de catch-up mejor que solo schedule porque el disparador de evento cubre la zona muerta.

## Lectura relacionada

- El release completo de Claude Code que abrió `--from-pr` a GitLab y Bitbucket marida bien con las routines en la nube: ver [Claude Code 2.1.119: PRs desde GitLab, Bitbucket y GHE](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/).
- Si quieres que la routine lea de un sistema de negocio `.NET` mientras clasifica, expónlo a través de MCP primero. El paseo está en [Cómo construir un servidor MCP personalizado en C# en .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/).
- Para el equivalente con forma de GitHub Copilot, la versión de agent skills está en [Skills de agente Copilot en Visual Studio 2026](/es/2026/04/visual-studio-2026-copilot-agent-skills/).
- Para devs C# construyendo runners de agente del lado Microsoft en lugar del lado Anthropic, [Microsoft Agent Framework 1.0](/es/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) es la entrada lista para producción.
- Y sobre la economía de bring-your-own-key si prefieres pagar por tokens contra un modelo distinto, ver [GitHub Copilot en VS Code con BYOK Anthropic, Ollama y Foundry Local](/es/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

Las routines aún están en research preview, así que la UI exacta y el header beta `/fire` se moverán. El modelo al que cualquiera de esto apunta, sin embargo, es estable: un prompt autocontenido, acceso a herramientas con scope, disparadores determinísticos, y un rastro de auditoría por ejecución. Esa es la parte que diseñar con cuidado. El runtime es la parte que puedes intercambiar.
