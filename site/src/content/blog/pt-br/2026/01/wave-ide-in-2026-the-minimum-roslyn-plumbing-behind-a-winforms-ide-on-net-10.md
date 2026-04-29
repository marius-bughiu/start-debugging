---
title: "Wave-IDE em 2026: o encanamento mínimo de Roslyn por trás de uma IDE WinForms no .NET 10"
description: "Wave-IDE mostra que WinForms e Roslyn no .NET 10 já bastam para construir uma IDE C# funcional. Aqui está o encanamento mínimo para análise incremental, autocompletar e diagnósticos."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "winforms"
lang: "pt-br"
translationOf: "2026/01/wave-ide-in-2026-the-minimum-roslyn-plumbing-behind-a-winforms-ide-on-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Um post no r/csharp compartilhou "Wave", uma IDE em WinForms construída como projeto pessoal de C#, com o repo linkado direto na thread. É um bom lembrete de que em um .NET 9 e .NET 10 modernos ainda dá para construir tooling de desktop sério com tecnologia "chata": WinForms para UI, Roslyn para os serviços de linguagem e um pouco de disciplina em torno de atualizações incrementais.

Fontes: [thread no Reddit](https://www.reddit.com/r/csharp/comments/1q9g4rx/wave_an_ide_made_in_winforms/) e o repo linkado [fmooij/Wave-IDE](https://github.com/fmooij/Wave-IDE/).

## "IDE" começa por um workspace, não por painéis dockáveis

Se você tira a pintura da UI, as responsabilidades centrais são:

-   Acompanhar arquivos, projetos, referências e configuração.
-   Atualizar o documento aberto em memória a cada tecla pressionada sem recarregar o mundo.
-   Pedir ao Roslyn diagnósticos e autocompletar sem travar a thread de UI.

No .NET 10 com C# 14, o Roslyn te dá o motor da linguagem, mas ele não vai te salvar se você reabrir a solution a cada edição.

## Mantenha um único snapshot da solution e atualize documentos de forma incremental

Esse esqueleto carrega a solution uma vez e depois atualiza o texto de um `Document` em memória. A partir daí, consulta diagnósticos e itens de autocompletar. É intencionalmente mínimo, mas mostra o formato necessário para o loop do editor.

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

Se você guarda o `DocumentId` por aba aberta, isso vira a espinha dorsal: faça debounce das teclas (por exemplo 150-250ms), chame `AnalyzeAsync` e depois renderize diagnósticos e autocompletar na UI do seu editor.

## A primeira armadilha de escala é o stutter, não a corretude

A fase do "funciona" é fácil. A fase do "parece responsivo" é onde a maioria das IDEs caseiras empaca. Duas regras importam:

-   Sempre faça debounce e cancele. Toda chamada de análise precisa aceitar um `CancellationToken`, e você deve cancelar a requisição anterior quando entrar uma nova.
-   Evite trabalho de solution inteira nos caminhos por tecla. Autocompletar, classificação e diagnósticos em tempo real devem focar no documento atual e no seu projeto, não disparar recargas da solution.

Se você quer construir uma IDE no .NET 10, Roslyn é a alavanca. WinForms é só a camada de transporte para pixels e cliques. O nível de qualidade está em o seu loop de edição continuar incremental sob pressão.
