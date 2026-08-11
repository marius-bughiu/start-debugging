---
title: "Las sesiones en la nube de Claude Code ya pueden ejecutarse en tus propios hosts"
description: "Claude Code 2.1.224 agrega claude self-hosted-runner, una beta pública que ejecuta sesiones en la nube en máquinas que tú aprovisionas. Aquí está la configuración, la regla de un usuario por runner y qué sigue saliendo de tu red."
pubDate: 2026-08-11
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
lang: "es"
translationOf: "2026/08/claude-code-self-hosted-runner-cloud-sessions-on-your-own-hosts"
translatedBy: "claude"
translationDate: 2026-08-11
---

Las sesiones en la nube de Claude Code, esas que inicias desde claude.ai, las apps móvil y de escritorio, una rutina programada o la terminal con `claude --cloud`, siempre se ejecutaron en la infraestructura de Anthropic. Claude Code 2.1.224, publicado el 2026-08-07, cambia eso. Un nuevo subcomando, `claude self-hosted-runner`, convierte un host Linux o macOS en la máquina que realmente ejecuta la sesión. Es una beta pública en los planes Team y Enterprise, y permanece invisible hasta que un Owner o admin activa "Allow self-hosted environments" en la página de administración Cloud environments.

## Entorno, runner, sesión

Tres piezas hacen que esto funcione. Un **entorno** es un destino con nombre creado en la configuración de administración de claude.ai que aparece en el selector de entornos junto a las opciones alojadas por Anthropic. Un **runner** es un proceso de larga duración que implementas dentro de tu red. Una **sesión** es una tarea, tomada de la cola del entorno por un runner, que clona el repositorio y lanza un proceso `claude` hijo para hacer el trabajo.

La configuración funcional más pequeña son tres comandos más el secreto del entorno, que claude.ai muestra exactamente una vez al crearlo y que expira a los 365 días:

```bash
mkdir -p /etc/claude
(umask 077 && cat > /etc/claude/environment-secret)
mkdir -p /srv/claude-work

claude self-hosted-runner \
  --environment-secret-file '/etc/claude/environment-secret' \
  --base-dir '/srv/claude-work'
```

Si omites `--base-dir`, el runner recurre a `/workspace`, que solo funciona si esa ruta ya existe y tiene permisos de escritura. Verifica primero el host con `claude self-hosted-runner --help`: en cualquier versión anterior a 2.1.224 el subcomando no se reconoce y obtienes la salida general de `claude --help`. También hay una ruta guiada, `claude self-hosted-runner setup`, que recorre los pasos de la interfaz de administración y escribe una hoja de referencia en `./runner-setup/CHEAT-SHEET.md`.

## Por qué un runner atiende exactamente a un usuario

Esta es la decisión de diseño que define el tamaño de tu flota. La primera sesión que toma un runner lo bloquea a la cuenta del usuario que la inició, y a partir de ahí solo acepta trabajo de esa cuenta, hasta `--capacity` sesiones concurrentes. La capacidad predeterminada es `1`. Por lo tanto, el tamaño mínimo de tu flota es la cantidad de usuarios que esperas tener activos al mismo tiempo, no la cantidad de sesiones.

Los runners también son desechables por diseño. `--drain-grace-sec` tiene como valor predeterminado `0`, así que un runner termina en cuanto sus sesiones activas finalizan en lugar de seguir consultando la cola, lo que permite que Kubernetes lo reinicie con un disco limpio listo para cualquier cuenta. Así se logra el aislamiento del checkout por usuario sin borrar el estado entre usuarios. El sondeo funciona además como latido: si deja de sondear durante unos 60 segundos, el plano de control vuelve a encolar la sesión en otro lugar. La salud y las métricas de Prometheus quedan en `/healthz` y `/metrics` en `--health-port`, por defecto `8080`.

## Qué sigue yendo a api.anthropic.com

Los checkouts del repositorio, los artefactos de compilación, los secretos y cualquier archivo que escriba una sesión permanecen en tus máquinas. La conversación no: los prompts, las respuestas y los resultados de herramientas van a `api.anthropic.com` para la inferencia, y Anthropic almacena la transcripción para que la sesión pueda reanudarse desde otra superficie. Todas las conexiones son salientes, y Anthropic nunca se conecta hacia dentro de tu red.

Vale la pena revisar tres límites antes de planificar un despliegue. Las organizaciones con Zero Data Retention no pueden usar esto. La inferencia no puede enrutarse a través de Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry ni una pasarela de LLM, porque las sesiones se autentican con un token con alcance de sesión emitido por Anthropic. Y las sesiones de Claude Tag, Claude Security y Code Review todavía no se enrutan a entornos autoalojados.

La misma versión también trajo la [mensajería entre sesiones](/es/2026/08/claude-code-2-1-224-sessions-message-each-other/). Las tablas completas de flags están en la [referencia de entornos autoalojados](https://code.claude.com/docs/en/self-hosted-environments-reference).
