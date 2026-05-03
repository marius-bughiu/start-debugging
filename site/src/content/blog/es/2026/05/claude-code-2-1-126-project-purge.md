---
title: "Claude Code 2.1.126 agrega `claude project purge` para borrar todo el estado de un repositorio"
description: "Claude Code v2.1.126 incluye claude project purge, un nuevo subcomando de la CLI que elimina cada transcripción, tarea, entrada del historial de archivos y bloque de configuración asociado a una ruta de proyecto en una sola operación. Incluye --dry-run, --yes, --interactive y --all."
pubDate: 2026-05-03
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "es"
translationOf: "2026/05/claude-code-2-1-126-project-purge"
translatedBy: "claude"
translationDate: 2026-05-03
---

La versión Claude Code v2.1.126 del 1 de mayo de 2026 agregó un comando pequeño con una historia de limpieza desproporcionada: `claude project purge [path]`. Ejecútalo contra un repositorio y la CLI elimina cada transcripción, tarea, entrada del historial de archivos y bloque de configuración de `~/.claude/projects/...` asociado a esa ruta de proyecto en una sola operación. Se acabó el escarbar a mano dentro de `~/.claude/projects/` para reiniciar un proyecto que ha acumulado un año de historial de sesiones.

## Por qué un comando dedicado en lugar de `rm -rf`

El estado por proyecto de Claude Code vive en varios lugares a la vez. Hay un directorio del proyecto en `~/.claude/projects/<encoded-path>/` que contiene transcripciones JSONL, la lista de tareas guardada y snapshots del historial de archivos. También hay entradas en el `~/.claude/settings.json` global y en la configuración por proyecto que apuntan a ese directorio mediante una ruta absoluta. Eliminar solo la carpeta del proyecto deja referencias colgando; eliminar solo las entradas de configuración deja megabytes de transcripciones huérfanas.

Hasta v2.1.126, la respuesta oficial era una limpieza manual cuidadosa. El nuevo subcomando recorre el mismo mapa interno que usa el resto de la CLI, así que transcripciones, tareas, historial de archivos y entradas de configuración desaparecen en una pasada consistente. Si lo ejecutas contra el directorio en el que ya estás situado, puedes omitir la ruta:

```bash
# Nuke everything Claude Code knows about the current repo
claude project purge

# Or target an absolute path from elsewhere
claude project purge /home/marius/work/legacy-monolith
```

## Las opciones que hacen que esto sea seguro de scriptear

La parte interesante es la superficie de flags. La versión incluye cuatro:

```bash
# Show what would be deleted without touching anything
claude project purge --dry-run

# Skip the confirmation prompt (CI-friendly)
claude project purge -y
claude project purge --yes

# Walk projects one at a time and choose
claude project purge --interactive

# Purge every project Claude Code has ever recorded
claude project purge --all
```

`--dry-run` imprime los IDs de proyecto, los conteos de transcripciones y los totales de bytes en disco que eliminaría. `--all` es el martillo pesado, útil tras una migración de portátil donde la mayoría de las rutas registradas ya no existen en disco. `-i` es el modo intermedio para clasificar una lista larga.

## Dónde encaja esto en el panorama de v2.1.126

`project purge` es uno de varios cambios en la gestión de estado de esta versión. La misma compilación también permite que `--dangerously-skip-permissions` escriba en rutas previamente protegidas como `.claude/`, `.git/`, `.vscode/` y archivos de configuración del shell, lo que se alinea con el modelo de purge: Claude Code se está inclinando hacia darte herramientas más contundentes para arrasar con su propia huella, asumiendo que tú sabes lo que haces. La anterior [variable de entorno de Bedrock service tier en Claude Code 2.1.122](/es/2026/04/claude-code-2-1-122-bedrock-service-tier/) fue una versión similar del estilo "una perilla, sin cambios en el SDK"; v2.1.126 continúa ese patrón.

Si ejecutas Claude Code bajo un `~/.claude` administrado (una política de configuración fijada por la organización), `--all` solo purgará los proyectos cuyo estado vive bajo tu perfil de usuario. El propio archivo de política administrada queda intacto.

Las notas completas están en la [página de la versión Claude Code v2.1.126](https://github.com/anthropics/claude-code/releases/tag/v2.1.126).
