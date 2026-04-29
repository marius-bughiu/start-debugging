---
title: "Wave-IDE en 2026: la mínima plomería de Roslyn detrás de un IDE de WinForms en .NET 10"
description: "Wave-IDE muestra que WinForms y Roslyn en .NET 10 alcanzan para construir un IDE de C# funcional. Aquí está la plomería mínima para análisis incremental, autocompletado y diagnósticos."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "winforms"
lang: "es"
translationOf: "2026/01/wave-ide-in-2026-the-minimum-roslyn-plumbing-behind-a-winforms-ide-on-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Un post en r/csharp compartió "Wave", un IDE de WinForms construido como proyecto personal en C#, con el repo enlazado en el mismo hilo. Es un buen recordatorio de que en .NET 9 y .NET 10 modernos todavía puedes construir tooling de escritorio serio con tecnología aburrida: WinForms para la UI, Roslyn para los servicios de lenguaje y algo de disciplina alrededor de las actualizaciones incrementales.

Fuentes: [hilo de Reddit](https://www.reddit.com/r/csharp/comments/1q9g4rx/wave_an_ide_made_in_winforms/) y el repo enlazado [fmooij/Wave-IDE](https://github.com/fmooij/Wave-IDE/).

## "IDE" empieza por un workspace, no por paneles acoplables

Si le quitas la pintura de la UI, las responsabilidades centrales son:

-   Hacer seguimiento de archivos, proyectos, referencias y configuración.
-   Actualizar en memoria el documento abierto en cada pulsación sin recargar el mundo.
-   Pedirle a Roslyn diagnósticos y autocompletado sin bloquear el hilo de UI.

En .NET 10 con C# 14, Roslyn te da el motor del lenguaje, pero no te va a salvar si reabres la solución en cada edición.

## Mantén un único snapshot de solución y actualiza los documentos de forma incremental

Este esqueleto carga la solución una vez y luego actualiza el texto de un `Document` en memoria. A partir de ahí, consulta diagnósticos y elementos de autocompletado. Es intencionalmente mínimo, pero muestra la forma que necesitas para el bucle del editor.

```cs
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;
using Microsoft.CodeAnalysis.Completion;

public sealed class RoslynServices
{
    private readonly MSBuildWorkspace _workspace = MSBuildWorkspace.Create();
    private Solution? _solution;

    public async Task LoadSolutionAsync(string slnPath, CancellationToken ct)
        => _solution = await _workspace.OpenSolutionAsync(slnPath, cancellationToken: ct);

    public async Task<(Diagnostic[] diagnostics, CompletionItem[] items)> AnalyzeAsync(
        DocumentId docId,
        string newText,
        int caretPosition,
        CancellationToken ct)
    {
        if (_solution is null) throw new InvalidOperationException("Solution not loaded.");

        var doc = _solution.GetDocument(docId) ?? throw new InvalidOperationException("Missing document.");
        doc = doc.WithText(SourceText.From(newText));
        _solution = doc.Project.Solution;

        var compilation = await doc.Project.GetCompilationAsync(ct);
        var diags = compilation?
            .GetDiagnostics(ct)
            .Where(d => d.Location.IsInSource)
            .ToArray() ?? Array.Empty<Diagnostic>();

        var completion = CompletionService.GetService(doc);
        var items = completion is null
            ? Array.Empty<CompletionItem>()
            : (await completion.GetCompletionsAsync(doc, caretPosition, cancellationToken: ct))?.Items.ToArray()
              ?? Array.Empty<CompletionItem>();

        return (diags, items);
    }
}
```

Si guardas el `DocumentId` por pestaña abierta, esto se convierte en la columna vertebral: aplica debounce a las pulsaciones (por ejemplo 150-250ms), llama a `AnalyzeAsync` y luego pinta diagnósticos y autocompletado en tu UI de editor.

## La primera trampa al escalar es el stutter, no la corrección

La fase de "funciona" es fácil. La fase de "se siente responsivo" es donde se atascan la mayoría de los IDEs caseros. Dos reglas importan:

-   Siempre debounce y cancela. Cada llamada de análisis debe aceptar un `CancellationToken`, y tienes que cancelar la solicitud anterior cuando llega una entrada nueva.
-   Evita trabajo a nivel de toda la solución en los caminos por pulsación. Autocompletado, clasificación y diagnósticos en vivo deben enfocarse en el documento actual y su proyecto, no disparar recargas de solución.

Si quieres construir un IDE en .NET 10, Roslyn es el apalancamiento. WinForms es solo la capa de transporte para píxeles y clicks. La barra de calidad es si tu bucle de edición sigue siendo incremental bajo presión.
