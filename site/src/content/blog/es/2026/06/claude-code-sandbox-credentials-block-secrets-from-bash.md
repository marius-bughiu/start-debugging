---
title: "Claude Code 2.1.187 impide que el sandbox lea tus claves de AWS"
description: "La nueva opción sandbox.credentials en Claude Code v2.1.187 deniega la lectura de archivos de credenciales y elimina variables de entorno secretas antes de ejecutar comandos de Bash en el sandbox. Aquí está por qué la política de lectura predeterminada era un hueco, y cómo cerrarlo."
pubDate: 2026-06-25
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
lang: "es"
translationOf: "2026/06/claude-code-sandbox-credentials-block-secrets-from-bash"
translatedBy: "claude"
translationDate: 2026-06-25
---

El sandbox de Bash de Claude Code siempre tuvo una asimetría que muerde en cuanto lees la letra pequeña: bloquea las escrituras de forma estricta, pero las lecturas están totalmente abiertas. A partir de la v2.1.187, lanzada el 2026-06-24, por fin existe una solución de primera clase. La nueva opción `sandbox.credentials` deniega la lectura de archivos de credenciales específicos y elimina variables de entorno secretas antes de que se ejecute cualquier comando en el sandbox.

## Por qué la política de lectura predeterminada era un hueco

El sandbox restringe las escrituras al directorio de trabajo y al directorio temporal de la sesión, y enruta el tráfico de red a través de un proxy con lista de permitidos. Pero su comportamiento de lectura predeterminado es "acceso de lectura a toda la computadora, excepto a ciertos directorios denegados". Eso incluye explícitamente `~/.aws/credentials` y `~/.ssh/`. Además, los comandos de Bash en el sandbox heredan el entorno del proceso padre, así que un `GITHUB_TOKEN` o `NPM_TOKEN` exportado en tu shell es visible para cada comando que ejecuta Claude.

Esto importa porque el lado de la red no es hermético. El proxy integrado toma su decisión de permitir según el nombre de host que envía el cliente y no inspecciona TLS. Permite un dominio amplio como `github.com` y un comando comprometido o con inyección de prompts tendrá una vía de exfiltración plausible. El acceso de lectura a tus claves más un canal de salida utilizable es exactamente la combinación que no quieres en un agente que corre sin supervisión.

## Cómo funciona sandbox.credentials

El nuevo bloque tiene dos arreglos, `files` y `envVars`. Los archivos listados se deniegan para lectura dentro del sandbox, la misma aplicación que hace `filesystem.denyRead`, y las variables de entorno listadas se eliminan antes de que se ejecute cada comando del sandbox.

```json
{
  "sandbox": {
    "enabled": true,
    "credentials": {
      "files": [
        { "path": "~/.aws/credentials", "mode": "deny" },
        { "path": "~/.ssh", "mode": "deny" }
      ],
      "envVars": [
        { "name": "GITHUB_TOKEN", "mode": "deny" },
        { "name": "NPM_TOKEN", "mode": "deny" }
      ]
    }
  }
}
```

Cada entrada lleva `"mode": "deny"`, que por ahora es el único valor admitido. El campo explícito mantiene el esquema abierto para futuros modos. Las rutas de archivo siguen las mismas reglas de prefijo que el resto de `sandbox.filesystem.*`: `~/` es tu directorio de inicio, `/` es absoluta y una ruta sin prefijo es relativa al proyecto.

## Por qué el bloque dedicado, y no solo denyRead

Ya podías denegar la lectura de credenciales con `filesystem.denyRead`. El sentido del nuevo bloque es que agrupa las denegaciones de archivos con la eliminación de variables de entorno y las combina entre todos los ámbitos de configuración. Las entradas de la configuración de usuario, de proyecto y administrada se combinan, y como `deny` es el único modo, cualquier ámbito puede agregar restricciones pero ninguno puede quitarlas.

Eso lo convierte en una palanca limpia para las implementaciones administradas. Envía desde tu MDM las denegaciones de `~/.aws` y `~/.ssh` más la eliminación de tokens, y los desarrolladores no podrán ampliarlas localmente. Se combina de forma natural con una política restringida: `enabled: true`, `failIfUnavailable: true` y `allowUnsandboxedCommands: false`.

## Dos advertencias que conviene conocer

No hay una lista de denegación integrada. Solo se restringen los archivos y variables que nombres, así que una configuración vacía no protege nada. La opción también afecta únicamente a los comandos de Bash en el sandbox. Para eliminar las credenciales de Anthropic y de los proveedores de nube de todos los subprocesos sin importar el sandbox, configura en su lugar la variable de entorno `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.

Si ejecutas Claude Code en modo auto-allow contra un repositorio en el que no confías del todo, esta es la opción que debes agregar hoy. Todos los detalles están en la [documentación del sandbox](https://code.claude.com/docs/en/sandboxing).
