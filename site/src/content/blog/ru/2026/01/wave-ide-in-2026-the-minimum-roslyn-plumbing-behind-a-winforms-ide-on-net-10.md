---
title: "Wave-IDE в 2026: минимальная обвязка Roslyn под IDE на WinForms на .NET 10"
description: "Wave-IDE показывает, что WinForms и Roslyn на .NET 10 - это уже достаточно, чтобы построить рабочий C#-IDE. Вот минимальная обвязка для инкрементального анализа, автодополнения и диагностики."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "winforms"
lang: "ru"
translationOf: "2026/01/wave-ide-in-2026-the-minimum-roslyn-plumbing-behind-a-winforms-ide-on-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Пост на r/csharp поделился "Wave" - IDE на WinForms, собранным как личный C#-проект, со ссылкой на репозиторий прямо в треде. Это хорошее напоминание о том, что на современном .NET 9 и .NET 10 всё ещё можно строить серьёзные десктопные инструменты на скучных технологиях: WinForms для UI, Roslyn для языковых сервисов и немного дисциплины вокруг инкрементальных обновлений.

Источники: [тред на Reddit](https://www.reddit.com/r/csharp/comments/1q9g4rx/wave_an_ide_made_in_winforms/) и связанный репозиторий [fmooij/Wave-IDE](https://github.com/fmooij/Wave-IDE/).

## "IDE" начинается с workspace, а не с docking-панелей

Если убрать "макияж" UI, то ключевые обязанности такие:

-   Отслеживать файлы, проекты, ссылки и конфигурацию.
-   Обновлять открытый документ в памяти на каждое нажатие, не перезагружая весь мир.
-   Запрашивать у Roslyn диагностику и автодополнение, не блокируя UI-поток.

На .NET 10 с C# 14 Roslyn даёт вам языковой движок, но он не спасёт, если вы заново открываете solution на каждое редактирование.

## Держите единственный snapshot solution и обновляйте документы инкрементально

Этот скелет загружает solution один раз, а затем обновляет текст `Document` в памяти. Оттуда он запрашивает диагностику и элементы автодополнения. Сделано намеренно минимально, но показывает форму, нужную для цикла редактора.

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

Если вы храните `DocumentId` для каждой открытой вкладки, это становится позвоночником: применяйте debounce к нажатиям (например 150-250 мс), вызывайте `AnalyzeAsync`, а затем отрисовывайте диагностику и автодополнение в UI редактора.

## Первая ловушка масштабирования - это статтер, а не корректность

Фаза "оно работает" - простая. Фаза "оно ощущается отзывчивым" - то место, где буксует большинство самодельных IDE. Важны два правила:

-   Всегда делайте debounce и отменяйте. Каждый вызов анализа должен принимать `CancellationToken`, и при поступлении нового ввода нужно отменить предыдущий запрос.
-   Избегайте работы по всей solution в путях "на каждое нажатие". Автодополнение, классификация и живая диагностика должны сосредотачиваться на текущем документе и его проекте, а не запускать перезагрузку solution.

Если вы хотите построить IDE на .NET 10, рычаг - это Roslyn. WinForms - всего лишь транспортный слой для пикселей и кликов. Планка качества в том, остаётся ли ваш цикл редактирования инкрементальным под нагрузкой.
