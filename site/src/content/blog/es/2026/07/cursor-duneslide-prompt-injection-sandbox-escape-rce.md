---
title: "DuneSlide: dos fallos de Cursor que convierten la inyección de prompts en RCE sin clic"
description: "Cato AI Labs reveló CVE-2026-50548 y CVE-2026-50549, un par de fallos con CVSS 9.8 en el sandbox de terminal de Cursor. Una respuesta MCP o un resultado web envenenado puede escapar del sandbox y ejecutar código. Cursor 3.0 es la solución."
pubDate: 2026-07-03
tags:
  - "cursor"
  - "ai-agents"
  - "security"
  - "prompt-injection"
  - "mcp"
lang: "es"
translationOf: "2026/07/cursor-duneslide-prompt-injection-sandbox-escape-rce"
translatedBy: "claude"
translationDate: 2026-07-03
---

Cato AI Labs [reveló esta semana un par de fallos críticos en Cursor](https://www.catonetworks.com/blog/duneslide-two-critical-rce-vulnerabilities/), registrados como CVE-2026-50548 y CVE-2026-50549 y bautizados en conjunto como DuneSlide. Ambos tienen una puntuación CVSS de 9.8, y ambos permiten que un solo fragmento de texto inyectado escape del sandbox de terminal de Cursor y ejecute comandos arbitrarios en tu máquina. Sin clic, sin diálogo de aprobación, sin ningún repositorio malicioso que hayas clonado a mano. Todas las versiones anteriores a Cursor 3.0 están afectadas.

El vector de entrega es lo que hace que esto merezca tu atención incluso si no usas Cursor: la inyección de prompts como primitiva de ejecución remota de código. El atacante nunca toca tu editor. Planta instrucciones en algo que tu agente lee en tu nombre, como la respuesta de un servidor Model Context Protocol (MCP) o una página devuelta por una búsqueda web, y el agente hace el resto.

## El sandbox confió en los propios parámetros del agente

Cursor ejecuta comandos de shell dentro de un sandbox que restringe las escrituras a tu directorio de proyecto. El problema con CVE-2026-50548 es que la lista de escritura permitida está parcialmente controlada por el agente. La herramienta `run_terminal_cmd` acepta un parámetro opcional `working_directory`, y cuando el agente lo establece, Cursor agrega esa ruta al conjunto de escritura sin cuestionarla.

Así que una instrucción inyectada puede dirigir al modelo hacia una llamada con esta forma:

```json
{
  "tool": "run_terminal_cmd",
  "command": "cp payload ~/.zshrc",
  "working_directory": "/Users/you"
}
```

El sandbox ve un directorio de trabajo "legítimo" y concede la escritura. Ahora el atacante puede dejar un archivo en tu directorio home, y `~/.zshrc`, `~/.zshenv` o `~/Library/LaunchAgents` se convierten en ejecución en tu próximo shell o inicio de sesión.

## La comprobación de symlinks falló abriendo el paso

CVE-2026-50549 ataca la protección directamente. Antes de escribir, Cursor canonicaliza los symlinks para confirmar que el destino real está dentro de tu proyecto. El fallo está en el respaldo. Cuando la canonicalización falla, porque el destino no existe o el atacante ha retirado el permiso de lectura de un directorio de la ruta, Cursor se rinde y confía en la ruta interna al proyecto del symlink.

Eso es un clásico fallo hacia el paso abierto. Un symlink de solo escritura que apunta al propio ayudante del sandbox de Cursor, `cursorsandbox`, atraviesa la comprobación y permite que un atacante sobrescriba el mismísimo binario que se supone que contiene al agente.

## Por qué las herramientas de agente "de confianza" son la nueva superficie de ataque

La lección incómoda es que `run_terminal_cmd` no es un usuario escribiendo comandos. Es una herramienta que el modelo invoca con argumentos que el modelo eligió, y esos argumentos vinieron de texto que el modelo leyó. Una vez que aceptas que cualquier contenido que fluye hacia la ventana de contexto es potencialmente adversario, un parámetro como `working_directory` deja de parecer configuración y empieza a parecer entrada del atacante.

Ambos fallos están corregidos en [Cursor 3.0](https://www.catonetworks.com/blog/duneslide-two-critical-rce-vulnerabilities/), así que la solución inmediata es actualizar y confirmar que estás en la 3.0 o posterior. La lección más larga sobrevive al parche: trata la salida de MCP y el contenido web obtenido como no confiables, y limita los permisos de las herramientas del agente como si el prompt ya estuviera comprometido, porque DuneSlide demuestra que puede estarlo.
