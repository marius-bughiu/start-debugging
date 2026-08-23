---
title: "Claude Code 2.1.238 deja que un marketplace de plugins genere sus propios encabezados de autenticación"
description: "Un campo headersHelper en los marketplaces url y en las entradas del catálogo ejecuta un comando local que imprime encabezados HTTP, así que un catálogo interno de plugins detrás de S3 o de un repositorio de artefactos puede autenticarse con un token de corta duración. Este es el esquema, el mensaje de consentimiento y los nombres de encabezado que Claude Code descarta."
pubDate: 2026-08-23
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
  - "security"
lang: "es"
translationOf: "2026/08/claude-code-2-1-238-marketplaces-mint-their-own-auth-headers"
translatedBy: "claude"
translationDate: 2026-08-23
---

Distribuir plugins internos de Claude Code obligaba a hospedar un repositorio git contra el que el cliente ya pudiera autenticarse. Claude Code 2.1.238, publicado en npm el 2026-08-20, elimina esa restricción: un marketplace ahora puede ejecutar un comando local que imprime encabezados HTTP, y esos encabezados viajan con la descarga del catálogo y con la de los plugins. Verifiqué el esquema contra la compilación de Windows 2.1.239 (commit `9bf8e95`, compilada el 2026-08-21), donde `headersHelper` aparece por primera vez en los esquemas de marketplace y de catálogo. En 2.1.224 el campo solo existía en las definiciones de servidores MCP.

## Un comando, un objeto JSON de encabezados

El campo vive en un marketplace con origen `url`, junto al mapa estático `headers` que ya existía:

```json
{
  "source": {
    "source": "url",
    "url": "https://artifacts.internal/claude/marketplace.json",
    "headersHelper": "/usr/local/bin/mint-artifact-token"
  }
}
```

El comando imprime un objeto JSON, su salida tiene prioridad sobre `headers` y se vuelve a ejecutar en cada actualización de ese marketplace. Dos detalles muerden en la práctica. Se ejecuta desde un directorio fijo, el directorio de configuración de Claude y no el directorio de trabajo de la sesión, así que usa un comando resoluble en `PATH` o una ruta absoluta. Y sus encabezados se heredan en las descargas de archivos del mismo origen, que es lo que vuelve útil este mecanismo con el origen de plugin `archive`: un simple zip por HTTPS en S3, GitLab o nginx, sin git ni npm en el cliente. Combínalo con `sha256` en la entrada, que se verifica en cada descarga y rechaza la instalación si no coincide.

## Los helpers por entrada deben incluir su manifiesto

Una entrada del catálogo puede llevar su propio `headersHelper`, que tiene prioridad sobre el del marketplace. Ese solo se ejecuta cuando el usuario instala o actualiza explícitamente el plugin, nunca al navegar el catálogo, y viene con una regla contra la que chocarás de inmediato si la ignoras:

```text
Plugin "internal-tools" sets headersHelper but is not "strict": false. An entry
with headersHelper must inline its full manifest (strict: false, with
commands/agents/hooks/mcpServers declared in the entry) so users can review what
it ships before the command runs
```

El consentimiento tiene que quedar informado desde la entrada misma, antes de que se ejecute cualquier comando. Al instalar verás el destino y el comando literal: "runs a local command and sends its output as headers to:", seguido de la URL y de la línea de comando. `claude plugin install -y` acepta ese comando mostrado sin preguntar, y es obligatorio cuando stdin no es una TTY.

## Encabezados que no puedes falsificar

No todos los nombres de encabezado sobreviven. Cualquiera declarado fuera de la configuración administrada por el operador se filtra contra una lista de bloqueo que cubre `host`, `cookie`, `forwarded`, `connection`, `transfer-encoding`, `content-length`, `via`, la familia de IP del cliente (`x-real-ip`, `true-client-ip`, `cf-connecting-ip` y compañeros) y los prefijos `x-forwarded-`, `x-original-` y `proxy-`. Los nombres primero se pasan a minúsculas y los guiones bajos se normalizan a guiones, así que `X_Real_IP` no se cuela. Un encabezado descartado registra una advertencia en vez de hacer fallar la descarga.

Los administradores pueden apagar todo el mecanismo con `disableCommandPluginSources` o `allowManagedHooksOnly` en la configuración administrada, y en ese caso la instalación se rechaza y el comando nunca se ejecuta. Es la misma trayectoria que [cargar plugins desde archivos .zip en 2.1.128](/es/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/): menos suposiciones sobre lo que tu cliente puede alcanzar. El [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) tiene la entrada de la versión; la [documentación de marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) todavía no se ha puesto al día.
