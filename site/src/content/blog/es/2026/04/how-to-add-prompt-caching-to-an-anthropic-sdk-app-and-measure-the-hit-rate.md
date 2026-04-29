---
title: "Cómo agregar prompt caching a una app del Anthropic SDK y medir la tasa de aciertos"
description: "Agrega prompt caching a una app Python o TypeScript con el Anthropic SDK, coloca los breakpoints de cache_control en los lugares correctos y lee cache_read_input_tokens y cache_creation_input_tokens para calcular una tasa de aciertos real. Con cálculos de precio para Claude Sonnet 4.6 y Opus 4.7."
pubDate: 2026-04-29
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "prompt-caching"
  - "claude-code"
lang: "es"
translationOf: "2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate"
translatedBy: "claude"
translationDate: 2026-04-29
---

Si tu app del Anthropic SDK envía el mismo system prompt largo o el mismo catálogo de herramientas en cada turno, estás pagando precio completo de input por tokens que el modelo ya vio hace treinta segundos. El prompt caching reduce esos tokens repetidos al **10 por ciento del precio base de input** a cambio de un pequeño recargo único de escritura. En un loop de agente multi-turno con un system prompt de 10k tokens, eso representa una reducción de costo de input de 5x a 10x, y unos 85ms menos de latencia para el prefijo cacheado. La trampa: tienes que colocar los breakpoints de cache_control en los lugares correctos y verificar la tasa de aciertos con el objeto usage del SDK, porque un breakpoint mal ubicado se degrada silenciosamente a una llamada a precio completo.

Esta guía recorre cómo agregar caching a una app Python o TypeScript con el Anthropic SDK en la API actual (Claude Opus 4.7, Sonnet 4.6, Haiku 4.5), y luego cómo medir la tasa real de aciertos con un pequeño wrapper. El código se verificó contra `anthropic` 0.42 (Python) y `@anthropic-ai/sdk` 0.30 (Node), ambos publicados a principios de 2026.

## Por qué el caching no es opcional para loops de agente

Un agente de coding que itera sobre un repositorio típicamente envía:

1. Un system prompt de 5k a 30k tokens (las instrucciones del agente, descripciones de herramientas, convenciones de archivos).
2. Un historial de mensajes en crecimiento (la solicitud del usuario más llamadas a herramientas previas y resultados de herramientas).
3. Un nuevo turno del usuario o resultado de herramienta que dispara la siguiente respuesta.

Sin caching, cada turno vuelve a codificar el prefijo completo. En Claude Sonnet 4.6 a $3/MTok de input, un prefijo de 8k tokens cuesta $0.024 por turno. Una sesión de 50 turnos son $1.20 solo en prefijo refacturado, sin contar el trabajo real. Con caching el mismo prefijo cuesta $0.0024 por turno cacheado después de la primera escritura. La misma respuesta, el diez por ciento de la factura.

El mecanismo está descrito en la [documentación oficial de prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching). Marcas un bloque de contenido con `cache_control: {"type": "ephemeral"}` y la API trata todo lo que está **antes y dentro** de ese bloque como una clave de caché. En la siguiente solicitud, si el prefijo coincide byte por byte, el modelo lee desde la caché en lugar de volver a codificar.

Lo que "byte por byte" realmente significa es la fuente de cada hilo del foro de Anthropic con el título "por qué no está cacheando". Llegaremos a eso.

## Versiones, IDs de modelo y la trampa del mínimo de tokens

El caching solo se activa cuando el prefijo cacheado supera un mínimo por modelo:

- **Claude Opus 4.7 (`claude-opus-4-7`)**: 4.096 tokens mínimo.
- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)**: 2.048 tokens mínimo.
- **Claude Haiku 4.5 (`claude-haiku-4-5`)**: 4.096 tokens mínimo.
- **Sonnet 4.5, Opus 4.1, Sonnet 3.7 anteriores**: 1.024 tokens mínimo.

Si tu prefijo está por debajo del umbral, la solicitud aún tiene éxito, pero `cache_creation_input_tokens` regresa como 0 y silenciosamente estás pagando precio completo de input. Esta es la razón más común por la que los desarrolladores reportan que "el caching no hace nada". Siempre verifica primero el umbral de tu modelo objetivo.

El SDK Python `anthropic` ganó soporte nativo de `cache_control` en la 0.40 y reforzó el typing del desglose de usage en la 0.42. El SDK Node lo tiene desde `@anthropic-ai/sdk` 0.27. Ya no se requiere ningún beta header ni para el TTL de 5 minutos ni para el de 1 hora: solo establece `ttl` dentro de `cache_control`.

## Un ejemplo mínimo en Python con cache_control

El patrón siguiente cachea un system prompt largo. Es el caso de uso más simple y común.

```python
# Python 3.11, anthropic 0.42
import anthropic

client = anthropic.Anthropic()

LONG_SYSTEM_PROMPT = open("prompts/system.md").read()  # ~8k tokens

def ask(user_message: str) -> anthropic.types.Message:
    return client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": LONG_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )

first = ask("List the public methods on OrderService.")
second = ask("Now list the private ones.")

print(first.usage)
print(second.usage)
```

El parámetro `system` debe ser un **array de bloques de contenido** cuando le adjuntas `cache_control`. Pasar un string plano (la forma de conveniencia) no permite caching: el SDK no tiene dónde colocar el flag de caché. Esto le pasa a todos la primera vez.

La primera llamada escribe el prefijo a la caché. La segunda llamada lo lee. Los objetos usage lo hacen visible:

```
# first.usage
{ "cache_creation_input_tokens": 8137, "cache_read_input_tokens": 0,  "input_tokens": 18,  "output_tokens": 124 }
# second.usage
{ "cache_creation_input_tokens": 0,    "cache_read_input_tokens": 8137, "input_tokens": 22, "output_tokens": 156 }
```

Los campos que te importan:

- `cache_creation_input_tokens`: tokens escritos a la caché en esta solicitud, facturados a 1.25x base para el TTL de 5 minutos o 2.0x para el TTL de 1 hora.
- `cache_read_input_tokens`: tokens leídos desde la caché, facturados a 0.10x base.
- `input_tokens`: tokens **después del último cache breakpoint** que no fueron elegibles para caché. Esta es la cola del mensaje que sigues cambiando.

## El mismo ejemplo en TypeScript

El SDK Node tiene la misma forma. Nota que las entradas del array `system` usan literales de objeto plano, no wrappers de clase.

```typescript
// Node 22, @anthropic-ai/sdk 0.30
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const client = new Anthropic();
const SYSTEM = readFileSync("prompts/system.md", "utf8");

async function ask(userMessage: string) {
  return client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });
}

const first = await ask("List the public methods on OrderService.");
const second = await ask("Now list the private ones.");
console.log(first.usage);
console.log(second.usage);
```

El mismo desglose de usage, los mismos precios. Sin gimnasia de headers.

## Dónde colocar los cache breakpoints en un loop de agente

Un agente de coding no solo tiene un system prompt largo. Tiene un historial de mensajes largo **y en crecimiento**, además de un catálogo de herramientas estático. El óptimo suelen ser tres o cuatro breakpoints organizados de más estable a más volátil.

Tienes hasta **4 cache breakpoints explícitos** por solicitud. La API cachea todo lo que está antes y dentro de cada bloque marcado, así que cada breakpoint crea un prefijo en capas.

```python
# Python 3.11, anthropic 0.42
client.messages.create(
    model="claude-opus-4-7",
    max_tokens=2048,
    tools=[
        # ... tool schemas ...
        {
            "name": "search_repo",
            "description": "...",
            "input_schema": {"type": "object", "properties": {...}},
            "cache_control": {"type": "ephemeral"},  # breakpoint 1: tools
        },
    ],
    system=[
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},  # breakpoint 2: system
        }
    ],
    messages=[
        # All prior turns...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": stable_repo_summary,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 3: repo state
                }
            ],
        },
        # ... older messages ...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": current_user_turn,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 4: most recent stable point
                }
            ],
        },
    ],
)
```

La regla es "estable por fuera, volátil por dentro". Si tu catálogo de herramientas cambia cuando un feature flag se activa, ese cambio invalida cada otra capa que esté detrás. Si tu system prompt incrusta la fecha de hoy, cada escritura de caché expira a medianoche UTC. Saca cualquier cosa dinámica de los bloques cacheados.

## Medir la tasa de aciertos

El dashboard del proveedor está bien para una factura mensual. No está bien para ajustar un agente en tiempo real. Envuelve el SDK y agrega los campos de usage tú mismo.

```python
# Python 3.11, anthropic 0.42
from dataclasses import dataclass, field
import anthropic

@dataclass
class CacheStats:
    requests: int = 0
    base_input: int = 0          # uncached
    cache_writes_5m: int = 0
    cache_writes_1h: int = 0
    cache_reads: int = 0
    output: int = 0

    def record(self, usage):
        self.requests += 1
        self.base_input += usage.input_tokens
        self.cache_reads += usage.cache_read_input_tokens or 0
        creation = getattr(usage, "cache_creation", None)
        if creation:
            self.cache_writes_5m += creation.ephemeral_5m_input_tokens or 0
            self.cache_writes_1h += creation.ephemeral_1h_input_tokens or 0
        else:
            self.cache_writes_5m += usage.cache_creation_input_tokens or 0
        self.output += usage.output_tokens

    @property
    def hit_rate(self) -> float:
        cacheable = self.cache_reads + self.cache_writes_5m + self.cache_writes_1h
        return self.cache_reads / cacheable if cacheable else 0.0

    def cost_usd(self, base_input_per_mtok: float, output_per_mtok: float) -> float:
        # Sonnet 4.6: base_input=3.00, output=15.00
        # Opus 4.7:   base_input=15.00, output=75.00
        write_5m = self.cache_writes_5m * base_input_per_mtok * 1.25
        write_1h = self.cache_writes_1h * base_input_per_mtok * 2.0
        reads    = self.cache_reads     * base_input_per_mtok * 0.10
        base     = self.base_input      * base_input_per_mtok
        out      = self.output          * output_per_mtok
        return (write_5m + write_1h + reads + base + out) / 1_000_000

stats = CacheStats()

def cached_call(client, **kwargs):
    response = client.messages.create(**kwargs)
    stats.record(response.usage)
    return response
```

Ejecuta el agente de extremo a extremo y luego imprime la tasa de aciertos.

```python
print(f"requests:    {stats.requests}")
print(f"hit rate:    {stats.hit_rate:.1%}")
print(f"cache reads: {stats.cache_reads:,}")
print(f"5m writes:   {stats.cache_writes_5m:,}")
print(f"1h writes:   {stats.cache_writes_1h:,}")
print(f"uncached in: {stats.base_input:,}")
print(f"USD:         ${stats.cost_usd(3.00, 15.00):.4f}")  # Sonnet 4.6 prices
```

Un agente saludable de coding de 50 turnos en Sonnet 4.6 con un system prompt de 8k típicamente aterriza en:

- 95-98% de tasa de aciertos en el bloque del system prompt.
- 70-90% de tasa de aciertos en el bloque de mensajes según qué tan agresivamente vuelvas a hacer prompts.
- 1.5x a 4x menos gasto total que el mismo agente sin caching.

Si ves la tasa de aciertos pegada en 0%, casi siempre la culpa es de tres cosas: prefijo por debajo del umbral mínimo de tokens, un valor no determinista (timestamp, ID aleatorio, orden de dict) incrustado en el texto cacheado, o mensajes reordenados entre turnos.

## El TTL de 1 hora: cuándo se paga solo

El TTL por defecto es de 5 minutos. Para un agente estilo chat eso está bien: cada turno refresca la caché, y el pequeño recargo de escritura se amortiza sobre muchas lecturas.

El TTL de 1 hora cuesta **2x base de input** para escribir pero dura doce veces más. Las cuentas: si esperas al menos una lectura cada cinco minutos durante una hora, la caché de 5 minutos funciona. Si tu tráfico es a ráfagas (alguien ejecuta el agente cada 20 minutos), la caché de 5 minutos expira entre turnos y sigues pagando el costo de escritura una y otra vez. El TTL de 1 hora se paga solo en el momento en que ocurren dos lecturas de caché durante un periodo de inactividad de una hora.

```python
# Python 3.11, anthropic 0.42 -- mixing TTLs
system=[
    {
        "type": "text",
        "text": STABLE_INSTRUCTIONS,             # the bedrock part
        "cache_control": {"type": "ephemeral", "ttl": "1h"},
    },
    {
        "type": "text",
        "text": SESSION_SCOPED_CONTEXT,          # changes per user session
        "cache_control": {"type": "ephemeral", "ttl": "5m"},
    },
],
```

Al mezclar TTLs, las entradas con TTL más largo deben aparecer **antes** que las de TTL más corto. Si las inviertes, la API rechaza la solicitud.

No se requiere beta header. Los antiguos `anthropic-beta: prompt-caching-2024-07-31` y el posterior `extended-cache-ttl-2025-04-11` están retirados, aunque el SDK aún los acepta como no-ops por compatibilidad hacia atrás.

## Cinco trampas que arruinan la tasa de aciertos

**1. Incrustar contenido no determinista.** Un `datetime.now()` en tu system prompt invalida la caché cada segundo. Ofensores comunes: timestamps, IDs de solicitud, datos de muestra aleatorios inyectados por diversidad, serialización JSON que no fija el orden de las claves. Si los bytes cambian, la caché falla.

**2. Reordenar herramientas o mensajes.** La API hashea los bytes en orden. Ordenar tu array de herramientas distinto entre llamadas produce un hash distinto. Mantén un orden determinista, idealmente el orden de tu archivo de configuración.

**3. Olvidar cambiar system de string a array.** `system="..."` (un string plano) no acepta `cache_control`. Tienes que usar `system=[{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}]`. El SDK no te avisa cuando le pasas un string con expectativas de caching.

**4. Cruzar la ventana de lookback de 20 bloques.** Un breakpoint solo puede ver 20 bloques de contenido antes de él. En un loop largo de tool-use con muchos bloques tool_result, tu breakpoint cerca de la cabeza de la conversación eventualmente sale de rango. Agrega un segundo breakpoint más cerca del turno actual antes de que eso pase.

**5. Pegarle a la misma caché desde organizaciones o workspaces distintos.** Las cachés están aisladas por organización, y desde febrero de 2026 también por workspace en la API de Anthropic y en Azure. Si corres dev en un workspace y prod en otro, no comparten prefijos cacheados.

Para una mirada más profunda a lo que envuelve al Anthropic SDK del lado de .NET, ve [Microsoft Agent Framework 1.0 para agentes de IA en C#](/es/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) y [El soporte BYOK de GitHub Copilot para el provider de Anthropic en VS Code](/es/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

## Qué hace el "caching automático" y por qué no es suficiente

Las versiones recientes del SDK agregaron un parámetro `cache_control` de nivel superior en `messages.create`. Establecerlo le dice a la API que aplique caching automáticamente con base en heurísticas. Funciona, pero elige un breakpoint y no puedes controlar cuál. Para un solo system prompt largo está bien. Para un loop de agente con catálogos de herramientas, resúmenes e historial de mensajes querrás breakpoints explícitos. El modo automático se trata mejor como prueba de humo: actívalo una vez para confirmar que el caching funciona en tu setup, luego pasa a bloques `cache_control` explícitos.

Si también estás construyendo MCP servers que exponen herramientas al mismo agente, los principios de layout son los mismos. Ve [Cómo construir un MCP server personalizado en C# en .NET 11](/es/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), [Cómo construir un MCP server en TypeScript que envuelve un CLI](/es/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) y [Cómo construir un MCP server personalizado en Python con el SDK oficial](/es/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) para el lado del servidor. La guía de colocación de breakpoints aquí aplica al cliente que los llama.

## Una vista de hoja de cálculo de cuándo el caching se paga solo

Para una verificación rápida, toma el tamaño del prefijo en tokens (`P`), el número de lecturas esperadas por escritura (`R`) y el multiplicador de TTL de la caché (`m`, donde `m=1.25` para 5m y `m=2.0` para 1h). El conteo de lecturas de break-even para un solo prefijo cacheado contra la línea base sin caché es:

```
R_breakeven = (m - 1) / (1 - 0.1)
            = (m - 1) / 0.9
```

Eso son **0.28 lecturas** para el TTL de 5 minutos y **1.11 lecturas** para el TTL de 1 hora. En otras palabras, la caché de 5 minutos se paga sola después de una sola lectura en cualquier escenario realista, y la caché de 1 hora se paga sola después de la segunda lectura. Esencialmente no hay escenario de loop de agente donde el caching sea la elección incorrecta; la única pregunta es qué TTL elegir.

Para más sobre patrones de loop de agente que se benefician del caching, ve [Cómo escribir un CLAUDE.md que realmente cambia el comportamiento del modelo](/es/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) y [Cómo programar una tarea recurrente de Claude Code que tría issues de GitHub](/es/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/).

## Enlaces de referencia

- [Documentación de prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [Anthropic Python SDK en PyPI](https://pypi.org/project/anthropic/)
- [Anthropic TypeScript SDK en npm](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [Precios de la API de Anthropic](https://docs.claude.com/en/docs/about-claude/pricing)
