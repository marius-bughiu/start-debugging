---
title: "Claude Code 2.1.119 toma PRs desde GitLab, Bitbucket y GitHub Enterprise"
description: "Claude Code v2.1.119 expande --from-pr más allá de github.com. La CLI ahora acepta URLs de merge requests de GitLab, pull requests de Bitbucket y PRs de GitHub Enterprise, y un nuevo ajuste prUrlTemplate apunta el badge del pie al host de revisión correcto."
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "gitlab"
  - "bitbucket"
lang: "es"
translationOf: "2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket"
translatedBy: "claude"
translationDate: 2026-04-27
---

La última versión de Claude Code, v2.1.119, trae un cambio pequeño pero atrasado para los equipos que no usan GitHub: `--from-pr` ahora acepta URLs de merge requests de GitLab, URLs de pull requests de Bitbucket y URLs de PRs de GitHub Enterprise, y un nuevo ajuste `prUrlTemplate` apunta el badge del pie de página a una URL de revisión de código personalizada en lugar de github.com. Hasta esta versión, el flujo de revisión de PR asumía que cada host de revisión de código era github.com, lo que volvía la funcionalidad incómoda para cualquier equipo en GitLab o Bitbucket Cloud.

## Qué hace --from-pr y por qué importa el host

`--from-pr` es la opción para "lanzar una sesión contra este pull request": pegas la URL del PR, Claude Code hace checkout de la rama head y prepara la sesión con el diff y el hilo de revisión. Ha sido la forma más limpia de iniciar una sesión de agente apuntada a una revisión de código específica desde que apareció, pero el parser de URL estaba atado a `github.com/owner/repo/pull/<n>`. Cualquier URL no perteneciente a GitHub se escapaba del parser y la sesión perdía el contexto de revisión.

v2.1.119 generaliza el manejo de URLs. Las formas que el changelog menciona explícitamente son URLs de merge request de GitLab, URLs de pull request de Bitbucket y URLs de PR de GitHub Enterprise:

```bash
claude --from-pr https://github.com/acme/api/pull/482
claude --from-pr https://gitlab.com/acme/api/-/merge_requests/482
claude --from-pr https://bitbucket.org/acme/api/pull-requests/482
claude --from-pr https://github.acme.internal/acme/api/pull/482
```

La misma opción, el mismo flujo, cuatro hosts de revisión distintos.

## prUrlTemplate reemplaza el enlace del pie a github.com

Incluso con `--from-pr` funcionando, quedaba un punto de fricción: el badge del pie que muestra el PR activo estaba fijado a github.com, porque la URL estaba codificada a fuego en la CLI. v2.1.119 añade un ajuste `prUrlTemplate` que en su lugar apunta ese badge a una URL de revisión de código personalizada. La misma versión también indica que los enlaces cortos `owner/repo#N` en la salida del agente ahora usan el host del remote de git en lugar de apuntar siempre a github.com, así que la reescritura es consistente en toda la superficie.

`prUrlTemplate` vive en `~/.claude/settings.json` como el resto de la configuración de Claude Code. La nueva versión además persiste los ajustes de `/config` (tema, modo de editor, verboso y similares) en el mismo archivo con precedencia de override project/local/policy, así que una organización puede distribuir `prUrlTemplate` a través de `~/.claude/settings.policy.json` y evitar que cada desarrollador lo configure a mano.

## Por qué importa para tiendas .NET en GitLab

La mayoría de los equipos .NET que migraron de Azure DevOps en los últimos años aterrizaron en GitHub o GitLab autoalojado, a menudo con una larga cola de repositorios internos que se replican a una instancia de GitHub Enterprise para interoperar con OSS. Hasta ahora, apuntar Claude Code a uno de esos repositorios no-GitHub significaba:

1. Hacer ida y vuelta del PR a través de un clon temporal de un mirror en github.com, o
2. Hacer la revisión pegando el diff a mano en la conversación.

Con v2.1.119 más un `prUrlTemplate` integrado en el archivo de policy de la organización, el mismo flujo `claude --from-pr <url>` funciona para todo el conjunto. La versión anterior v2.1.113 que migró la [CLI a un binario nativo](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) significa que tampoco hay un runtime de Node.js que instalar en los agentes de build que ejecutan trabajos de revisión automatizada de PR, lo que vuelve este despliegue más fácil de vender en flotas de CI estrictamente gestionadas.

Si distribuyes un `~/.claude/settings.policy.json` para tu equipo, esta es la semana para añadir la línea `prUrlTemplate`. Las notas completas de la versión v2.1.119 están en el [changelog de Claude Code](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
