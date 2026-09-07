---
title: "Claude Code ahora nombra la causa probable de un fallo de caché de prompt"
description: "Claude Code 2.1.260 agrega un diagnóstico de causa probable a la línea Prompt cache (main) de /usage y al objeto prompt_cache de la status line. En lugar de solo contar los fallos, te dice si cambió el conjunto de herramientas, si cambió el system prompt o si expiró el TTL."
pubDate: 2026-09-07
tags:
  - "claude-code"
  - "ai-agents"
  - "prompt-caching"
  - "token-cost"
lang: "es"
translationOf: "2026/09/claude-code-now-names-the-likely-cause-of-a-prompt-cache-miss"
translatedBy: "claude"
translationDate: 2026-09-07
---

Claude Code 2.1.260 trae un diagnóstico que cierra un hueco viejo en la depuración de costos: cuando falla la caché de prompt, ahora te dice por qué. La versión 2.1.251 ya había agregado una línea `Prompt cache (main)` al bloque Session de `/usage`, pero esa línea solo contaba los fallos. Saber que pagaste tres relecturas completas de una conversación de 300k tokens no te dice qué dejar de hacer. A partir de 2.1.260, la línea nombra una causa probable, por ejemplo `likely cause: tool definitions changed`.

## Por qué un fallo es caro e invisible

Claude Code reenvía la conversación completa en cada turno, así que el almacenamiento en caché es lo que mantiene asequible una sesión larga. La API hace coincidir el prefijo de la solicitud, y la coincidencia es exacta: un cambio en cualquier punto del prefijo recalcula todo lo que viene después. No hay caché por archivo ni por segmento. Por eso la [documentación de prompt caching](https://code.claude.com/docs/en/prompt-caching) enumera un conjunto concreto de acciones que invalidan la caché, incluyendo cambiar de modelo, conectar o desconectar un servidor MCP cuando la búsqueda de herramientas no difiere sus herramientas, denegar una herramienta completa con una regla deny simple como `Bash`, y actualizar el propio Claude Code.

El problema es que la mayoría de estas acciones son invisibles. Un servidor MCP stdio cuyo proceso termina en silencio, o una sesión HTTP que expira, cambia tus definiciones de herramientas a mitad de sesión sin ningún mensaje en el transcript. Ves un turno lento y una factura.

Claude Code cuenta una solicitud como fallo cuando reprocesó más del 5% y al menos 2 000 tokens de lo que podría haber leído desde la caché, sin que una compactación o una limpieza de resultados de herramientas explique la diferencia. Las reconstrucciones provocadas por compactación se cuentan aparte como expected rebuilds, lo que mantiene honesto el conteo de fallos.

## Leer la causa desde una status line

La parte interesante para quien programa su status line es que el diagnóstico es estructurado, no solo prosa. El objeto `prompt_cache` incorporó `last_miss_cause` y `miss_causes` en 2.1.260. El array `causes` contiene nombres como `tools_changed`, `system_prompt_changed`, `ttl_expired_5m` o `likely_server_side`, y dos de ellos traen conteos: `tools_changed` viene con `tools_added` y `tools_removed`, y `system_prompt_changed` viene con `system_char_delta`.

```bash
#!/bin/bash
input=$(cat)
cause=$(echo "$input" | jq -r '.prompt_cache.last_miss_cause.causes[0] // empty')
ratio=$(echo "$input" | jq -r '.prompt_cache.hit_ratio // 0')
printf "cache %.0f%%" "$(echo "$ratio * 100" | bc -l)"
[ -n "$cause" ] && printf " | last miss: %s" "$cause"
```

`last_miss_cause` es `null` hasta el primer fallo de la sesión, y también cada vez que Claude Code no logra identificar una causa, así que protege la lectura. `miss_causes` es el agregado: una sesión que muestra `tools_changed` cinco veces tiene un servidor MCP inestable, no un caso aislado.

Los conteos vienen de los campos de tokens de caché en la respuesta de la API, así que todo esto funciona en Bedrock, en Google Cloud's Agent Platform y a través de un gateway. Cubre solo la conversación principal, no los subagentes, y `/clear` lo reinicia.

La misma versión también agregó un panel `/diff` que se abre junto a la conversación en modo pantalla completa y sigue los cambios sin confirmar mientras Claude edita. Si vas siguiendo el tren de versiones, [2.1.261 agregó /skill-doctor](/es/2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context/) al día siguiente. Las notas completas están en el [release v2.1.260](https://github.com/anthropics/claude-code/releases/tag/v2.1.260), y la referencia de campos está en la [documentación de la status line](https://code.claude.com/docs/en/statusline#prompt-cache-fields).
