---
title: "Wave-IDE in 2026: das minimale Roslyn-Plumbing hinter einer WinForms-IDE auf .NET 10"
description: "Wave-IDE zeigt, dass WinForms und Roslyn auf .NET 10 ausreichen, um eine funktionierende C#-IDE zu bauen. Hier ist das minimale Plumbing für inkrementelle Analyse, Autovervollständigung und Diagnostics."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "winforms"
lang: "de"
translationOf: "2026/01/wave-ide-in-2026-the-minimum-roslyn-plumbing-behind-a-winforms-ide-on-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Ein Beitrag auf r/csharp hat "Wave" geteilt, eine WinForms-IDE als persönliches C#-Projekt, mit dem Repo direkt im Thread verlinkt. Es ist eine gute Erinnerung daran, dass Sie auf modernem .NET 9 und .NET 10 weiterhin ernsthaftes Desktop-Tooling mit langweiliger Technologie bauen können: WinForms für die UI, Roslyn für die Sprachdienste und etwas Disziplin rund um inkrementelle Updates.

Quellen: [Reddit-Thread](https://www.reddit.com/r/csharp/comments/1q9g4rx/wave_an_ide_made_in_winforms/) und das verlinkte Repo [fmooij/Wave-IDE](https://github.com/fmooij/Wave-IDE/).

## "IDE" beginnt mit einem Workspace, nicht mit Docking-Panels

Wenn Sie die UI-Lackierung wegnehmen, sind die Kernverantwortlichkeiten:

-   Dateien, Projekte, Referenzen und Konfiguration im Blick behalten.
-   Das geöffnete Dokument bei jedem Tastendruck im Speicher aktualisieren, ohne die Welt neu zu laden.
-   Roslyn nach Diagnostics und Autovervollständigung fragen, ohne den UI-Thread zu blockieren.

Auf .NET 10 mit C# 14 liefert Ihnen Roslyn die Sprach-Engine, aber sie wird Sie nicht retten, wenn Sie die Solution bei jeder Änderung neu öffnen.

## Halten Sie einen einzigen Solution-Snapshot und aktualisieren Sie Dokumente inkrementell

Dieses Skelett lädt die Solution einmal und aktualisiert dann den Text eines `Document`s im Speicher. Von dort aus fragt es Diagnostics und Vervollständigungseinträge ab. Es ist absichtlich minimal, zeigt aber die Form, die Sie für die Editor-Schleife brauchen.

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

Wenn Sie pro geöffnetem Tab die `DocumentId` halten, wird das zum Rückgrat: debouncen Sie Tastendrücke (zum Beispiel 150-250ms), rufen Sie `AnalyzeAsync` auf und rendern Sie dann Diagnostics und Autovervollständigung in Ihrer Editor-UI.

## Die erste Skalierungsfalle ist Stutter, nicht Korrektheit

Die "es funktioniert"-Phase ist einfach. Die "es fühlt sich responsiv an"-Phase ist die, an der die meisten Eigenbau-IDEs hängen bleiben. Zwei Regeln zählen:

-   Immer debouncen und abbrechen. Jeder Analyse-Aufruf muss ein `CancellationToken` akzeptieren, und Sie sollten den vorherigen Request abbrechen, sobald neue Eingabe ankommt.
-   Vermeiden Sie Solution-weite Arbeit in Per-Tastendruck-Pfaden. Autovervollständigung, Klassifizierung und Live-Diagnostics sollten sich auf das aktuelle Dokument und sein Projekt konzentrieren und keine Solution-Reloads auslösen.

Wenn Sie eine IDE auf .NET 10 bauen wollen, ist Roslyn der Hebel. WinForms ist nur die Transportschicht für Pixel und Klicks. Die Qualitätslatte ist, ob Ihre Edit-Schleife unter Druck inkrementell bleibt.
