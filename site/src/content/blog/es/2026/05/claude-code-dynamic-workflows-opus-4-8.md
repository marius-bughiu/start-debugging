---
title: "Los Dynamic Workflows de Claude Code reparten un solo prompt entre hasta 1000 subagentes"
description: "Anthropic lanzó Opus 4.8 el 2026-05-28 con Dynamic Workflows, una versión preliminar de investigación en Claude Code que escribe un script de orquestación en JavaScript para ejecutar de decenas a cientos de subagentes en paralelo, con un tope de 1000 por ejecución."
pubDate: 2026-05-31
tags:
  - "claude-code"
  - "ai-agents"
  - "opus-4-8"
lang: "es"
translationOf: "2026/05/claude-code-dynamic-workflows-opus-4-8"
translatedBy: "claude"
translationDate: 2026-05-31
---

Anthropic lanzó Claude Opus 4.8 el 2026-05-28, y el titular para quien vive en una terminal no es la mejora en los benchmarks. Son los Dynamic Workflows: una versión preliminar de investigación dentro de Claude Code que convierte una sola solicitud en lenguaje natural en un script que orquesta de decenas a cientos de subagentes en paralelo, con un tope de 1000 agentes por ejecución. Esta es la diferencia entre pedirle a un agente que avance por una tarea en un bucle y que Claude escriba un programa que descompone la tarea, la reparte y verifica los resultados antes de informar.

## Un workflow es un script, no un bucle de chat

El mecanismo es la parte interesante. Cuando pides algo grande ("audita cada controlador en busca de comprobaciones de autorización faltantes" o "migra esta base de código de 200k líneas fuera de Newtonsoft.Json"), Claude escribe un script de orquestación en JavaScript y un runtime lo ejecuta en segundo plano. No estás cuidando una única ventana de contexto que se llena poco a poco. El script genera subagentes nuevos, cada uno con su propio contexto, y recopila su salida estructurada.

La forma del script generado es aproximadamente esta:

```javascript
export const meta = {
  name: 'audit-authz',
  description: 'Find controllers missing [Authorize] and verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Verify' }],
};

// Fan out: one finder per area, then adversarially verify each hit
const findings = await pipeline(
  AREAS,
  area => agent(`Scan ${area} for actions missing authorization`, {
    phase: 'Scan',
    schema: FINDINGS_SCHEMA,
  }),
  review => parallel(review.findings.map(f => () =>
    agent(`Try to refute: ${f.title}. Is this really unprotected?`, {
      phase: 'Verify',
      schema: VERDICT_SCHEMA,
    }).then(v => ({ ...f, verdict: v }))
  ))
);

return findings.flat().filter(f => f.verdict?.isReal);
```

Los patrones en los que se apoya Anthropic se ven aquí: reparto en paralelo y luego verificación adversarial, donde a agentes separados se les pide refutar cada hallazgo antes de que sobreviva. La salida se valida contra un esquema JSON, de modo que el orquestador recibe datos tipados en lugar de prosa que tiene que parsear.

## Lo que te cuesta, y cuándo se activa

El riesgo obvio es el costo. Una ejecución que legítimamente genera cientos de agentes quema tokens rápido, que es exactamente por lo que existe el tope de 1000 agentes como freno ante una fuga. Claude Code te muestra el script y el plan aproximado antes de que se dispare el primer workflow y te pide confirmación.

Hay dos formas de entrar. Puedes describir el objetivo directamente y dejar que Claude decida que un workflow está justificado, o puedes activar el ajuste de esfuerzo `ultracode` para que recurra a la orquestación automáticamente en tareas sustanciales. Opus 4.8 también incluye un Fast mode más barato (alrededor de 2x la tarifa estándar por aproximadamente 2,5x la velocidad), lo que hace que el patrón de muchos agentes pequeños sea menos doloroso de lo que habría sido en versiones anteriores.

Dynamic Workflows es una versión preliminar de investigación, así que trata la superficie de la API como inestable y vigila tu uso. Pero el modelo de fondo es sólido: deja de iterar un agente contra una transcripción creciente y empieza a escribir programas que coordinan muchos de vida corta. Todos los detalles están en el [anuncio de Opus 4.8](https://www.anthropic.com/news) y en el [changelog de Claude Code](https://code.claude.com/docs/en/changelog).
