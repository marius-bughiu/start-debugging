---
title: "El Debugger Agent de Visual Studio 18.5 convierte a Copilot en un compañero vivo de caza de bugs"
description: "Visual Studio 18.5 GA incluye un workflow guiado de Debugger Agent en Copilot Chat que forma una hipótesis, pone breakpoints, acompaña un repro, valida contra estado en runtime y propone un fix."
pubDate: 2026-04-21
tags:
  - "visual-studio"
  - "debugging"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
lang: "es"
translationOf: "2026/04/visual-studio-18-5-debugger-agent-workflow"
translatedBy: "claude"
translationDate: 2026-04-24
---

El equipo de Visual Studio lanzó [un nuevo workflow de Debugger Agent](https://devblogs.microsoft.com/visualstudio/stop-hunting-bugs-meet-the-new-visual-studio-debugger-agent/) en Visual Studio 18.5 GA el 15 de abril de 2026. Si has pasado el último año preguntándole a Copilot "por qué esto es null" y recibiendo un adivina confiado que contradecía el call stack real, esta release es la corrección. El agente ya no es un chatbot que lee tus archivos fuente. Conduce una sesión de debug interactiva, pone sus propios breakpoints, y razona contra estado en runtime vivo.

## El análisis estático no era suficiente

Iteraciones anteriores de [Debug with Copilot](https://devblogs.microsoft.com/visualstudio/visual-studio-2026-debugging-with-copilot/) eran útiles para asistencia de excepciones y prompts estilo "explica este stack frame", pero operaban sobre un snapshot congelado de tu código. Cuando la falla real vivía en una race entre dos continuations async, o en estado que solo existía después del decimoquinto clic, una lectura estática de `MyService.cs` simplemente no podía verlo. VS 18.5 cierra esa brecha al dejar que el agente participe en el repro real.

## El loop de cuatro fases

Una vez tu solución está abierta, cambias Copilot Chat al modo Debugger y le das una descripción del bug. El workflow luego camina por cuatro fases en orden:

1. **Hipótesis y preparación.** El agente analiza la descripción más el código y propone una teoría de causa raíz. Luego pone "intelligent breakpoints" en las rutas sospechosas y se ofrece a lanzar el proyecto por ti. Si tu arranque es inusual, puedes lanzarlo manualmente y dejar que se adjunte.
2. **Reproducción activa.** El agente se queda en línea mientras clicas a través del repro. Está observando estado en runtime cada vez que un breakpoint golpea, no releyendo el archivo.
3. **Validación en tiempo real.** En cada parada, evalúa locals y el call stack para confirmar o eliminar su hipótesis. Las adivinadas erróneas se descartan por evidencia en lugar de ser defendidas.
4. **El fix final.** Cuando el agente está seguro de haber encontrado la causa, propone un cambio de código. Si apruebas, aplica la edición y reejecuta la sesión para verificar que el bug se fue.

Los escenarios soportados en el drop de 18.5 GA son "exceptions, logic inconsistencies, and state corruption." Regresiones de performance y bugs solo-concurrency aún no están en esa lista.

## Cómo se ve una sesión

Un walkthrough mínimo para un clásico null-ref se ve así:

```text
You: The app throws NullReferenceException when saving a new invoice
     with no line items. Repro: open /invoices/new, click Save.

Agent: Hypothesis - Invoice.Total() dereferences LineItems before the
       collection is initialised for empty invoices.
       Setting breakpoints at InvoiceService.cs:42 and Invoice.cs:18.
       Launching IIS Express on https://localhost:7080 ...
```

Corres el repro. El breakpoint en `Invoice.cs:18` golpea, el agente lee `this.LineItems` del stack frame, ve `null` en lugar de una lista vacía, y confirma la hipótesis sin pedirte que pases por ninguna línea. Luego ofrece:

```csharp
public decimal Total() =>
    (LineItems ?? []).Sum(li => li.Quantity * li.UnitPrice);
```

Apruebas, y reejecuta el escenario para confirmar que la excepción se fue.

## Por qué importa

El shift interesante aquí es que el agente está anclado a la verdad del runtime. Todavía puedes sobrescribirlo, ignorar sus breakpoints, y debuggear manualmente, que es el default correcto para cualquier cosa sensible a seguridad o en código no familiar. Pero para la long tail de "tengo un repro y un stack trace y necesito bisectar el estado", el loop del reporte de bug al fix verificado se acorta dramáticamente. Espera que más de tu tiempo de debugging sea gastado revisando la evidencia del agente en lugar de poner breakpoints tú mismo.

La feature está en VS 18.5 GA hoy. Si aún estás en 17.x o en un preview 18.x anterior, el estilo chat viejo de Debug with Copilot es lo que tienes. El workflow guiado requiere 18.5.
