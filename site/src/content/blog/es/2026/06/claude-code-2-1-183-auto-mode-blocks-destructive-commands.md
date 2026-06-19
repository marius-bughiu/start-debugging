---
title: "Claude Code 2.1.183 impide que el modo automatico ejecute comandos destructivos de Git e IaC"
description: "Claude Code v2.1.183 (2026-06-19) bloquea git reset --hard, git clean -fd y terraform/pulumi/cdk destroy en modo automatico salvo que tu los pidas, cerrando el hueco agentico donde un mal turno destruye trabajo sin confirmar."
pubDate: 2026-06-19
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "es"
translationOf: "2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands"
translatedBy: "claude"
translationDate: 2026-06-19
---

Claude Code v2.1.183 salio el 2026-06-19, y el cambio principal es una proteccion que deberia haber existido el mismo dia que el modo automatico: el agente ya no puede ejecutar por iniciativa propia un puñado de comandos irreversibles. Si tu no pediste explicitamente un `git reset --hard`, el modelo no tiene permiso para decidir que necesita uno a mitad de la tarea.

## El modo de fallo que esto cierra

El modo automatico (antes la variante "hazlo y ya" estilo YOLO) deja que el agente ejecute comandos de shell sin un aviso de aprobacion por cada comando. Eso es justo lo que quieres para un ciclo de `dotnet build`, `dotnet test` y ediciones. Es justo lo que no quieres cuando el modelo, intentando "volver a un estado limpio" tras una refactorizacion confusa, recurre a `git reset --hard` y borra una hora de trabajo sin confirmar, o ejecuta `terraform destroy` contra el stack equivocado.

La nueva version traza una linea: los comandos destructivos y dificiles de deshacer quedan bloqueados en modo automatico salvo que la solicitud que los disparo haya nombrado esa accion de forma explicita. El conjunto bloqueado en 2.1.183:

```bash
# Blocked in auto mode unless you asked for them
git reset --hard
git checkout -- .
git clean -fd
git stash drop

# Blocked for commits the agent did not make this session
git commit --amend

# Blocked unless a specific stack is named
terraform destroy
pulumi destroy
cdk destroy
```

La distincion es la intencion, no una prohibicion total. Si tu prompt dice "restablece el arbol de trabajo con `git reset --hard`", el agente lo ejecuta. Si concluye por su cuenta que un reset es la jugada, se detiene y te avisa en su lugar. Lo mismo con la infraestructura: `terraform destroy` apuntando a un stack especifico que nombraste esta permitido; un `destroy` sin mas, no.

## Por que amend recibe un trato especial

La regla de `git commit --amend` es la sutil. Enmendar un commit que el propio agente hizo antes en la sesion esta bien, es el comportamiento normal de iterar sobre el propio trabajo. Enmendar un commit que no creo reescribe un historial que no le pertenece, lo que puede pisar en silencio el commit de un compañero o tu trabajo previo a la sesion. El clasificador ahora comprueba la autoria dentro de la sesion antes de permitirlo.

Esto encaja de forma natural con el trabajo de seguridad anterior: [el `--safe-mode` de v2.1.169](/es/2026/06/claude-code-2-1-169-safe-mode-and-cd/) te da una base limpia contra la que depurar, y ahora el propio modo automatico se niega a ser lo que pierde tus datos. Si de verdad necesitas que el agente ejecute uno de estos sin que se lo pidas, lo que toca es decirlo en el prompt, o salir del modo automatico para ese paso y aprobarlo a mano.

## El resto de la version

2.1.183 tambien añade avisos de obsolescencia cuando pides un modelo que ha sido reemplazado (mostrados en stderr en modo print y en el frontmatter del agente), un nuevo ajuste `attribution.sessionUrl` para mantener los enlaces de sesion de claude.ai fuera de tus commits y PRs, y `/config --help` para listar las claves abreviadas. Las correcciones de errores cubren WebSearch devolviendo vacio en subagentes, la corrupcion de la TUI a pantalla completa en Windows Terminal, y turnos que terminan en silencio cuando solo se produjo un bloque de pensamiento.

Las notas completas estan en el [changelog de v2.1.183](https://code.claude.com/docs/en/changelog).
