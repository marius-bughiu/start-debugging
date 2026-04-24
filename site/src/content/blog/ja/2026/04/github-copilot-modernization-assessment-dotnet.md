---
title: "GitHub Copilot Modernization: アセスメントレポートが実際の製品"
description: "GitHub Copilot Modernization は、レガシー .NET アプリを移行するための Assess、Plan、Execute のループとして売り込まれています。アセスメントフェーズこそ価値の居場所です: インベントリレポート、分類されたブロッカー、コードのように diff できるファイルレベルの修正ガイダンス。"
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/04/github-copilot-modernization-assessment-dotnet"
translatedBy: "claude"
translationDate: 2026-04-24
---

Microsoft の 4 月 7 日のポスト ["Your Migration's Source of Truth: The Modernization Assessment"](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) は [GitHub Copilot Modernization](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) を、レガシー .NET Framework と Java ワークロードを前に引き出すための "Assess、Plan、Execute" ループとして説明します。ポストから 1 つだけ覚えておくなら、こうしてください: アセスメントはピカピカのダッシュボードではなく、`.github/modernize/assessment/` に書かれるレポートで、コードと並んでコミットするものです。

## なぜレポートをリポジトリに置くのか

マイグレーションは、計画が誰も更新しない Word ドキュメントに住んでいると死にます。アセスメントをリポジトリに書くことで、すべての変更が pull request 経由でレビュー可能になり、ブランチ履歴が「ブロッカーのリスト」が時間とともにどう縮んだかを示します。アセスメントが CI で再生成されて diff できることも意味するので、誰かが deprecated な API を再導入したときに気づけます。

レポート自体は所見を 3 つのバケットに分けます:

1. Mandatory: マイグレーションがコンパイルまたは実行する前に解決しなければならないブロッカー。
2. Potential: 通常コード更新を必要とする挙動変更、例えば .NET Framework と .NET 10 の間で削除された API。
3. Optional: `System.Text.Json` や `HttpClientFactory` への切り替えのようなエルゴノミクス向上。

各所見はファイルと行範囲に紐付いているので、レビュアーはレポートを開き、コードへクリック スルーし、ツールを再実行せずに修正を理解できます。

## アセスメントの実行

VS Code 拡張からアセスメントをキックオフできますが、興味深いサーフェスは CI に収まるので CLI です:

```bash
# Run a recommended assessment against a single repo
modernize assess --path ./src/LegacyApi --target dotnet10

# Multi-repo batch mode for a portfolio
modernize assess --multi-repo ./repos --target dotnet10 --coverage deep
```

`--target` フラグはシナリオプリセットが住む場所です: `dotnet10` は .NET Framework から .NET 10 へのアップグレードパスをトリガーし、`java-openjdk21` は Java 等価をカバーします。`--coverage` フラグはランタイムと深さをトレードし、deep coverage は実際に推移的 NuGet 参照を検査するものです。

## アセスメントをコードのように扱う

レポートは Markdown と JSON ファイルのセットなので、lint できます。アセスメントが新しい Mandatory issue を獲得したときに CI を失敗させる小さなスクリプトを示します:

```csharp
using System.Text.Json;

var report = JsonSerializer.Deserialize<AssessmentReport>(
    File.ReadAllText(".github/modernize/assessment/summary.json"));

var mandatory = report.Issues.Count(i => i.Severity == "Mandatory");
Console.WriteLine($"Mandatory issues: {mandatory}");

if (mandatory > report.Baseline.Mandatory)
{
    Console.Error.WriteLine("New Mandatory blockers introduced since baseline.");
    Environment.Exit(1);
}

record AssessmentReport(Baseline Baseline, Issue[] Issues);
record Baseline(int Mandatory);
record Issue(string Severity, string File, int Line, string Rule);
```

それは一度きりのアセスメントをラチェットに変えます: ブロッカーが解決されたら、静かに戻ってくることはできません。

## ASP.NET Core 2.3 の横でどう収まるか

同じ 4 月 7 日のポスト群には [ASP.NET Core 2.3 end of support 通知](https://devblogs.microsoft.com/dotnet/aspnet-core-2-3-end-of-support/) も含まれており、2027 年 4 月 13 日をハードな日付として設定しています。Copilot Modernization は、まだ .NET Framework に乗った ASP.NET Core 2.3 パッケージを持つ shop への Microsoft の答えです: アセスメントを実行し、コミットし、時計が切れる前に Mandatory リストを消化していきます。

このツールは魔法ではありません。`HttpContext` 拡張を書き直したり、App Service と AKS のどちらでコンテナ化するか決めたりしてくれません。それがすることは、作業のリポジトリネイティブで diff できるインベントリを与えることで、これは多くの長寿命 .NET コードベースが何年ぶりに持った最初の正直な会話です。
