---
title: "Playwright .NET 1.64 agrega Locator.Within(), y es el encadenamiento de Locator leído al revés"
description: "Microsoft.Playwright 1.64 agrega Locator.Within() para que puedas escribir 'este botón, dentro de ese diálogo'. Una prueba rápida muestra que construye exactamente el mismo locator que parent.Locator(child), incluida la resolución de Nth() por cada padre."
pubDate: 2026-10-23
tags:
  - "dotnet"
  - "playwright"
  - "testing"
  - "csharp"
lang: "es"
translationOf: "2026/10/playwright-dotnet-1-64-locator-within-is-locator-chaining-read-backwards"
translatedBy: "claude"
translationDate: 2026-10-23
---

[Microsoft.Playwright 1.64.0](https://github.com/microsoft/playwright-dotnet/releases/tag/v1.64.0) llegó a NuGet el 2026-10-21, seguido de 1.64.1 un día después con una actualización del Node.js 24.22.1 incluido. La versión trae Chromium 156, Firefox 157 y WebKit 27.2, pruebas de WebMCP y screencasts en VP9, pero la API que la mayoría de las suites de pruebas tocará primero es [`Locator.Within()`](https://playwright.dev/dotnet/docs/api/class-locator#locator-within).

## Primero el hijo, después el padre

`Within(ILocator)` devuelve un locator que encuentra los elementos del locator actual dentro de cada elemento que coincide con el argumento. Lo importante es el orden de lectura. Cuando ya tienes dos locators, ahora puedes decir "este botón, dentro de ese diálogo" en lugar de construir la cadena de afuera hacia adentro:

```csharp
var save = page.GetByRole(AriaRole.Button, new() { Name = "Save" });
var dialog = page.GetByTestId("settings-dialog");

// 1.64+
await save.Within(dialog).ClickAsync();

// Before 1.64
await dialog.Locator(save).ClickAsync();
```

Los locators relativos como `Nth()` y `First` se resuelven por separado dentro de cada padre, y eso es lo que hace funcionar las consultas por columna:

```csharp
var thirdColumn = page.GetByRole(AriaRole.Cell).Nth(2)
    .Within(page.GetByRole(AriaRole.Row));

await Expect(thirdColumn).ToHaveTextAsync(new[] { "Apple", "Banana", "Cherry" });
```

## En qué se compila

Ejecuté ambas formas contra Chromium 156 con `Microsoft.Playwright` 1.64.1 en el .NET SDK 10.0.302, usando una tabla de tres filas y una página con dos botones "Save" (uno en un diálogo y otro en un formulario). Los resultados:

| Locator | Coincidencias |
| --- | --- |
| `cells.Nth(2)` | `Apple` |
| `cells.Nth(2).Within(rows)` | `Apple, Banana, Cherry` |
| `rows.Locator(cells.Nth(2))` | `Apple, Banana, Cherry` |
| `rows.Locator("td").Nth(2)` | `Apple` |
| `save` | `Save, Save` |
| `save.Within(dialog)` | `Save` |

`ToString()` lo deja claro: `cells.Nth(2).Within(rows)` imprime `GetByRole(AriaRole.Row).Locator(GetByRole(AriaRole.Cell).Nth(2))`, carácter por carácter igual que la cadena anterior. `Within()` no es un nuevo motor de coincidencias. Es la sobrecarga existente `Locator(ILocator)` con los argumentos invertidos, y los mensajes de error y las entradas del trace viewer mostrarán la forma encadenada.

Eso tiene dos consecuencias prácticas:

- **No hay cambio de comportamiento que migrar.** Si tu suite ya usa `parent.Locator(childLocator)`, la semántica de `Nth()` por padre ya estaba ahí. Pasar a `Within()` es solo cuestión de legibilidad, sobre todo en page objects que exponen locators hijos y dejan que quien los llama elija el ámbito.
- **La trampa real sigue siendo dónde va `Nth()`.** `rows.Locator("td").Nth(2)` aplica `Nth(2)` al resultado aplanado y te da una sola celda. Pon `Nth()` en el locator interno (o usa `Within()`, que te empuja a hacerlo) cuando quieras una coincidencia por padre.

## El breaking change de la misma versión

La 1.64 también cambia la visibilidad: los elementos dentro de un iframe que a su vez no es visible, por ejemplo con `visibility: hidden`, ahora se consideran ocultos para las acciones, `IsVisibleAsync()` y `ToBeVisibleAsync()`. Si una prueba hacía clic a través de un frame oculto por accidente, ahora agotará el tiempo esperando la visibilidad. Vale más la pena revisar eso antes de actualizar que `Within()`.

Actualiza con:

```bash
dotnet add package Microsoft.Playwright --version 1.64.1
pwsh bin/Debug/net10.0/playwright.ps1 install
```

Ten en cuenta que el paso de instalación elimina las builds de navegadores de versiones anteriores de Playwright que considera sin uso, así que otro proyecto en una versión anterior puede necesitar ejecutar su propia instalación de nuevo. Si dependes de Playwright para pruebas de UI dirigidas por agentes, la disciplina de selectores de [pruebas E2E que se autorreparan cuando un agente de código renombra selectores](/2026/09/self-healing-e2e-tests-when-a-coding-agent-renames-selectors/) combina bien con locators acotados como estos.
