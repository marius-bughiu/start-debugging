---
title: "Claude Code 2.1.251 cierra cuatro maneras de esquivar la comprobación de permisos"
description: "Un symlink intercambiado después de la comprobación, reglas deny que dejaban de aplicarse a través de una ruta de búsqueda con symlink, un comando de marketplace apuntando fuera de su plugin y un script de workflow leído antes de la aprobación. Cuatro correcciones en una versión, todas el mismo fallo."
pubDate: 2026-08-29
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
  - "devops"
lang: "es"
translationOf: "2026/08/claude-code-2-1-251-four-ways-around-the-permission-check"
translatedBy: "claude"
translationDate: 2026-08-29
---

Claude Code 2.1.251 salió el 28 de agosto de 2026 con un changelog lo bastante largo como para enterrar lo interesante. Cuatro de sus correcciones comparten la misma forma: algo llegó a un archivo que la comprobación de permisos no había aprobado. Leídas juntas dejan de parecer cuatro fallos y empiezan a parecer una sola clase.

## La comprobación pasó, y luego cambió la ruta

La corrección principal es una carrera de manual entre el momento de la comprobación y el momento del uso. Según el changelog, las herramientas de archivo "seguían un symlink intercambiado dentro del directorio de trabajo después de la comprobación de permisos" y podían "leer o escribir fuera de la ubicación aprobada". Apruebas una edición de `src/config.ts`, la ruta se resuelve, la comprobación dice que sí — y entre ese sí y la escritura, la entrada se convierte en un symlink que apunta a otro sitio.

Lo que conviene interiorizar es quién puede hacer ese intercambio. Un script `postinstall`, un file watcher, un servidor de desarrollo, un runner de tests o el propio comando Bash anterior del agente se ejecutan mientras la sesión está abierta. El directorio de trabajo no es un lugar tranquilo, y nunca fue un lugar de confianza.

Grep y Glob tenían la versión de lectura del mismo agujero: las reglas deny de `Read(...)` no se aplicaban a archivos alcanzados a través de una ruta de búsqueda con symlink. Una regla deny sobre `secrets/**` se respetaba en una lectura directa y dejaba de respetarse en silencio cuando el mismo archivo se encontraba a través de un symlink que apuntaba dentro.

## Dos rutas que venían de la configuración, no de ti

Las otras dos entraron por archivos que viajan con el repositorio. Los comandos de plugin declarados en una entrada de marketplace podían apuntar fuera del directorio del plugin; esas rutas ahora se rechazan con un error explícito de path traversal. Y la herramienta Workflow leía un `scriptPath` fuera de lo que la sesión tenía permitido leer *antes* de que se ejecutara la comprobación de permisos — y luego citaba el contenido en su mensaje de error, lo que convierte una lectura bloqueada en una lectura exitosa.

## La misma versión sigue apretando la configuración

Media docena de cambios más en 2.1.251 apuntan en la misma dirección, todos tratando un repositorio clonado como entrada no confiable:

- La configuración de proyecto ya no puede activar el trazado beta detallado ni el registro de cuerpos de API en crudo. Eso eran tus cuerpos de petición.
- `ANTHROPIC_CUSTOM_HEADERS` desde configuración gestionada o de proyecto ahora necesita aprobación cuando define una cabecera de credencial, de organización/tenant, de enrutado o de comportamiento de API, como `Authorization` o `Host`.
- El `env` de `.claude/settings.json` a nivel de proyecto ya no define `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR` ni `TMPDIR`/`TMP`/`TEMP`: defínelos en tu shell o en la configuración de usuario o gestionada.
- Las comprobaciones de permisos de Bash dejaron de aprobar automáticamente asignaciones de una expresión aritmética a una variable entera de shell (`OPTIND=1/0`, `RANDOM=2+2`), que colaban como inofensivas.
- La configuración gestionada por servidor que termina el TLS del sandbox, enruta su tráfico por un proxy, inyecta credenciales o debilita el aislamiento del sandbox ahora requiere aprobación antes de aplicarse.

Ninguna de estas es un exploit dramático por sí sola. Juntas cierran la distancia entre "el sistema de permisos dijo que no" y "el archivo siguió sin leerse".

## Actualizar

`claude update`, o reinstalar desde npm. Dos notas de la misma semana: 2.1.250 salió el mismo día y son solo correcciones de errores, y 2.1.248 (27 de agosto) añadió `--restricted` — equivalentemente `CLAUDE_CODE_RESTRICTED=1` — que elimina las herramientas que ejecutan comandos o código, quita `WebFetch` salvo que lo nombres en `--tools`, mantiene las herramientas de archivo dentro del directorio de trabajo, rechaza `bypassPermissions` e ignora por completo los archivos de configuración de usuario, proyecto y locales. Ese flag y las correcciones de esta semana son el mismo argumento desde dos direcciones: la configuración y las rutas que te entrega un repositorio son entrada, no configuración.

La corrección del marketplace llega en particular una semana después de que 2.1.238 diera alcance real a los catálogos, [permitiendo que un marketplace de plugins emita sus propias cabeceras de autenticación](/es/2026/08/claude-code-2-1-238-marketplaces-mint-their-own-auth-headers/): cuanto más puede hacer una entrada de marketplace, más tiene que aguantar el límite de directorio a su alrededor.
