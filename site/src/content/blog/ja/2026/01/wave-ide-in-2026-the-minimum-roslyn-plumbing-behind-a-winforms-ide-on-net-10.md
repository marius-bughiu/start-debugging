---
title: "2026 年の Wave-IDE: .NET 10 の WinForms IDE を支える Roslyn の最小配管"
description: ".NET 10 上の WinForms と Roslyn だけで、動く C# IDE を作れることを Wave-IDE が示しています。インクリメンタル解析、補完、診断のための最小限の配管をまとめます。"
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "winforms"
lang: "ja"
translationOf: "2026/01/wave-ide-in-2026-the-minimum-roslyn-plumbing-behind-a-winforms-ide-on-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
r/csharp の投稿で、個人の C# プロジェクトとして作られた WinForms 製の IDE "Wave" がリポジトリ付きで共有されました。これは、現代の .NET 9 や .NET 10 では、地味な技術スタックでも本格的なデスクトップツールをまだ作れることのよい思い出させとなります: UI は WinForms、言語サービスは Roslyn、そしてインクリメンタル更新まわりの少しの規律です。

ソース: [Reddit のスレッド](https://www.reddit.com/r/csharp/comments/1q9g4rx/wave_an_ide_made_in_winforms/) と、リンクされたリポジトリ [fmooij/Wave-IDE](https://github.com/fmooij/Wave-IDE/)。

## "IDE" はドッキングパネルではなくワークスペースから始まります

UI の上塗りを剥がせば、中心となる責務はこうです。

-   ファイル、プロジェクト、参照、設定を追跡する。
-   キー入力ごとに、世界全体を再ロードせず、開いているドキュメントをメモリ内で更新する。
-   UI スレッドをブロックせずに、Roslyn に診断と補完を問い合わせる。

C# 14 を載せた .NET 10 では、Roslyn が言語エンジンを提供してくれます。とはいえ、編集のたびにソリューションを開き直していたら、それでは救われません。

## ソリューションのスナップショットは 1 つに保ち、ドキュメントはインクリメンタルに更新する

このスケルトンは、ソリューションを一度だけ読み込み、その後 `Document` のテキストをメモリ内で更新します。そこから診断や補完項目を問い合わせます。意図的に最小限ですが、エディタループに必要な形を示しています。

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

タブごとに `DocumentId` を保持しておけば、これがバックボーンになります。キー入力をデバウンスし (たとえば 150-250 ミリ秒)、`AnalyzeAsync` を呼び出し、エディタ UI に診断と補完を描画します。

## 最初のスケーリングの罠は正しさではなく、引っかかりです

"動く" フェーズは簡単です。"レスポンシブに感じる" フェーズで、自作 IDE のほとんどが立ち止まります。重要なルールは 2 つです。

-   常にデバウンスとキャンセルを行ってください。あらゆる解析呼び出しは `CancellationToken` を受け取り、新しい入力が来たら前のリクエストはキャンセルすべきです。
-   キー入力ごとのパスでソリューション全体に及ぶ作業を避けてください。補完、分類、ライブ診断は、現在のドキュメントとそのプロジェクトに集中させ、ソリューションの再読み込みを引き起こさないようにします。

.NET 10 で IDE を作りたいなら、レバレッジは Roslyn にあります。WinForms はピクセルとクリックのための転送層に過ぎません。品質の基準は、編集ループが負荷下でもインクリメンタルなままでいられるかどうかです。
