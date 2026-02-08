---
title: "Wave-IDE in 2026: the minimum Roslyn plumbing behind a WinForms IDE on .NET 10"
description: "A post on r/csharp shared “Wave”, a WinForms IDE built as a personal C# project, with the repo linked right in the thread. It’s a good reminder that on modern .NET 9 and .NET 10 you can still build serious desktop tooling with boring tech: WinForms for UI, Roslyn for language services, and some discipline…"
pubDate: 2026-01-10
tags:
  - "net"
  - "net-10"
  - "winforms"
---
A post on r/csharp shared “Wave”, a WinForms IDE built as a personal C# project, with the repo linked right in the thread. It’s a good reminder that on modern .NET 9 and .NET 10 you can still build serious desktop tooling with boring tech: WinForms for UI, Roslyn for language services, and some discipline around incremental updates.

Sources: [Reddit thread](https://www.reddit.com/r/csharp/comments/1q9g4rx/wave_an_ide_made_in_winforms/) and the linked repo [fmooij/Wave-IDE](https://github.com/fmooij/Wave-IDE/).

## “IDE” starts with a workspace, not with docking panels

If you strip away the UI paint, the core responsibilities are:

-   Tracking files, projects, references, and configuration.
-   Updating the open document in memory on every keystroke without reloading the world.
-   Asking Roslyn for diagnostics and completion without blocking the UI thread.

On .NET 10 with C# 14, Roslyn gives you the language engine, but it won’t save you if you re-open the solution on every edit.

## Keep a single solution snapshot, update documents incrementally

This skeleton loads the solution once, then updates a `Document`’s text in memory. From there, it queries diagnostics and completion items. It’s intentionally minimal, but it shows the shape you need for an editor loop.

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

If you keep the `DocumentId` per open tab, this becomes the backbone: debounce keystrokes (for example 150-250ms), call `AnalyzeAsync`, then render diagnostics and completion in your editor UI.

## The first scaling trap is stutter, not correctness

The “it works” phase is easy. The “it feels responsive” phase is where most DIY IDEs stall. Two rules matter:

-   Always debounce and cancel. Every analysis call must accept a `CancellationToken`, and you should cancel the previous request when new input arrives.
-   Avoid full-solution work in per-keystroke paths. Completion, classification, and live diagnostics should focus on the current document and its project, not trigger solution reloads.

If you want to build an IDE on .NET 10, Roslyn is the leverage. WinForms is just the transport layer for pixels and clicks. The quality bar is whether your edit loop stays incremental under pressure.
