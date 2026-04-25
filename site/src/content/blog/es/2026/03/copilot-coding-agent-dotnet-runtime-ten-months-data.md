---
title: "Cómo se ven realmente 878 PRs de Copilot Coding Agent en dotnet/runtime"
description: "El equipo .NET comparte diez meses de datos reales sobre correr Copilot Coding Agent de GitHub en dotnet/runtime: 878 PRs, una tasa de merge del 67.9%, y lecciones claras sobre dónde ayuda el desarrollo asistido por IA y dónde aún se queda corto."
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "ai"
  - "ai-agents"
  - "github-copilot"
  - "copilot"
  - "github"
lang: "es"
translationOf: "2026/03/copilot-coding-agent-dotnet-runtime-ten-months-data"
translatedBy: "claude"
translationDate: 2026-04-25
---

Copilot Coding Agent de GitHub ha estado corriendo en el repositorio [dotnet/runtime](https://github.com/dotnet/runtime) desde mayo de 2025. El [post de análisis profundo](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/) de Stephen Toub cubre diez meses de uso real: 878 PRs enviados, 535 mergeados, una tasa de merge del 67.9%, y una tasa de reversión de apenas 0.6%.

## Dónde se ponen interesantes los números

No todos los tamaños de PR son iguales. Cambios pequeños y enfocados tienen éxito a tasas más altas:

| Tamaño del PR (líneas cambiadas) | Tasa de éxito |
|---|---|
| 1-10 líneas | 80.0% |
| 11-50 líneas | 76.9% |
| 101-500 líneas | 64.0% |
| 1.001+ líneas | 71.9% |

El bajón en 101-500 líneas refleja el límite donde las tareas mecánicas se desdibujan en arquitectónicas. El trabajo de limpieza y remoción encabeza las categorías con 84.7% de éxito, seguido de adiciones de pruebas con 75.6%. Estas son tareas con criterios de éxito claros, sin ambigüedad sobre la intención, y radio de impacto limitado.

## Las instrucciones son todo el juego

El primer mes del equipo produjo una tasa de merge del 41.7% sin configuración significativa. Después de escribir un archivo de instrucciones de agente apropiado -- especificando comandos de build, patrones de prueba, y límites arquitectónicos -- la tasa subió a 69% en semanas y eventualmente alcanzó 72%.

Una configuración mínima pero efectiva se ve así:

```markdown
## Build
Run `./build.sh clr -subset clr.runtime` to build the runtime.
Run `./build.sh -test -subset clr.tests` to run tests.

## Testing Patterns
New public APIs require tests in src/tests/.
Use existing helpers in XUnitHelper rather than writing from scratch.

## Scope Limits
Do not change public API surface without a linked tracking issue.
Native (C++) components require Windows CI -- avoid if not needed.
```

Las instrucciones no necesitan ser largas. Necesitan ser específicas.

## La capacidad de revisión se vuelve el cuello de botella

Una observación reveladora de los datos: un solo desarrollador podría poner en cola nueve PRs sustanciales desde un teléfono mientras viajaba, generando 5-9 horas de trabajo de revisión para el equipo. La generación de PRs escaló más rápido que la revisión de PRs. Esa asimetría incitó inversión paralela en revisión de código asistida por IA para absorber el nuevo volumen. Este patrón se repetirá en cualquier equipo que adopte el agente a escala.

## Lo que CCA no reemplaza

Las decisiones arquitectónicas, el razonamiento multiplataforma, y los juicios sobre la forma de la API consistentemente requirieron intervención humana. El código mergeado de CCA se desglosa como 65.7% código de prueba versus 49.9% para contribuyentes humanos. Es más fuerte llenando el trabajo mecánico que los humanos rutinariamente despriorizan.

La validación más amplia cubrió siete repositorios .NET (aspire, roslyn, aspnetcore, efcore, extensions, y otros): 1.885 PRs mergeados de 2.963 enviados, una tasa de éxito del 68.6%. El patrón se mantiene a escala.

Para equipos pensando en adoptar Copilot Coding Agent: comienza con tareas pequeñas de limpieza o prueba, escribe tu archivo de instrucciones antes que cualquier otra cosa, y planifica para que la capacidad de revisión se vuelva la próxima restricción.

El análisis completo está en [devblogs.microsoft.com](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/).
