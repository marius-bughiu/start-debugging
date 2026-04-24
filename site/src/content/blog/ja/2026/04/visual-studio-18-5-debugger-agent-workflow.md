---
title: "Visual Studio 18.5 の Debugger Agent が Copilot を生きたバグ狩りパートナーに変える"
description: "Visual Studio 18.5 GA は Copilot Chat でガイド付き Debugger Agent ワークフローを出荷し、仮説を立て、ブレークポイントを設定し、repro に同行し、ランタイム状態に対して検証し、fix を提案します。"
pubDate: 2026-04-21
tags:
  - "visual-studio"
  - "debugging"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
lang: "ja"
translationOf: "2026/04/visual-studio-18-5-debugger-agent-workflow"
translatedBy: "claude"
translationDate: 2026-04-24
---

Visual Studio チームは 2026 年 4 月 15 日の Visual Studio 18.5 GA で [新しい Debugger Agent ワークフロー](https://devblogs.microsoft.com/visualstudio/stop-hunting-bugs-meet-the-new-visual-studio-debugger-agent/) を出荷しました。過去 1 年間 Copilot に「なぜこれが null なのか」と聞いて、実際の call stack と矛盾する自信満々の推測を返されてきたなら、このリリースがその訂正です。Agent はもはやソースファイルを読むチャットボットではありません。対話的なデバッグセッションを操縦し、自分のブレークポイントを設定し、生きたランタイム状態に対して推論します。

## 静的解析だけでは足りなかった

以前のイテレーションの [Debug with Copilot](https://devblogs.microsoft.com/visualstudio/visual-studio-2026-debugging-with-copilot/) は例外アシスタンスや「このスタックフレームを説明して」スタイルのプロンプトには便利でしたが、コードの凍結されたスナップショット上で動作していました。実際の不具合が 2 つの非同期 continuation 間の race や 15 回目のクリック後にしか存在しない状態に宿っていると、`MyService.cs` の静的な読み取りではそれを見ることが単にできませんでした。VS 18.5 は agent を実際の repro に参加させることでそのギャップを埋めます。

## 4 フェーズのループ

solution を開いたら、Copilot Chat を Debugger モードに切り替えてバグの説明を渡します。ワークフローは順番に 4 つのフェーズを歩きます:

1. **仮説と準備。** Agent は説明とコードを分析して root cause 理論を提案します。それから怪しいパスに「intelligent breakpoints」を設定し、プロジェクトを起動する提案をします。起動が特殊な場合は手動で起動して agent をアタッチさせることもできます。
2. **アクティブな再現。** Agent はあなたが repro をクリックで進む間、回線上にとどまります。各ブレークポイント ヒット時にランタイム状態を観察していて、ファイルを読み直しているのではありません。
3. **リアルタイムの検証。** 各停止で locals と call stack を評価して仮説を確認または除外します。間違った推測は弁護されるのではなく、証拠に基づいて破棄されます。
4. **最終的な fix。** Agent が原因を見つけたと確信したら、コード変更を提案します。承認すると編集を適用し、バグが消えたことを検証するためにセッションを再実行します。

18.5 GA ドロップでのサポート対象シナリオは "exceptions, logic inconsistencies, and state corruption" です。パフォーマンス回帰と並行性のみのバグはまだそのリストにありません。

## セッションはどう見えるか

古典的な null-ref のミニマルなウォークスルーはこんな風に見えます:

```text
You: The app throws NullReferenceException when saving a new invoice
     with no line items. Repro: open /invoices/new, click Save.

Agent: Hypothesis - Invoice.Total() dereferences LineItems before the
       collection is initialised for empty invoices.
       Setting breakpoints at InvoiceService.cs:42 and Invoice.cs:18.
       Launching IIS Express on https://localhost:7080 ...
```

repro を走らせます。`Invoice.cs:18` のブレークポイントがヒットし、agent はスタックフレームから `this.LineItems` を読み、空リストではなく `null` を見て、あなたにステップを要求することなく仮説を確認します。そして提案します:

```csharp
public decimal Total() =>
    (LineItems ?? []).Sum(li => li.Quantity * li.UnitPrice);
```

承認すると、シナリオを再実行して例外が消えたことを確認します。

## なぜそれが重要か

ここでの興味深いシフトは、agent がランタイムの真実に根差していることです。まだ上書きしたり、ブレークポイントを無視したり、手動でデバッグしたりできます - セキュリティに敏感なものや不慣れなコードにとってはそれが正しいデフォルトです。しかし「repro と stack trace があって state を二分探索する必要がある」というロングテールに対して、バグ報告から検証済み fix までのループが劇的に短くなります。デバッグ時間のより多くが、自分でブレークポイントを置くよりも agent の証拠をレビューすることに費やされると期待してください。

機能は今日 VS 18.5 GA にあります。まだ 17.x か以前の 18.x preview にいるなら、古いチャットスタイルの Debug with Copilot があなたの持つものです。ガイド付きワークフローは 18.5 を要求します。
