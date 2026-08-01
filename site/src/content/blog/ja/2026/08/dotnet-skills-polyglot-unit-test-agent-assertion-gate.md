---
title: ".NET の新しいユニットテストエージェントの一番の価値は、テストを書くことではありません"
description: "2026-07-31、Microsoft は dotnet/skills でポリグロットなユニットテストエージェントを公開しました。注目すべきは、エージェントが完了を宣言する前に、アサーションへ擬似ミューテーションを仕掛ける必須のチェックです。"
pubDate: 2026-08-01
tags:
  - "dotnet"
  - "ai-agents"
  - "testing"
  - "github-copilot"
  - "agent-skills"
lang: "ja"
translationOf: "2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate"
translatedBy: "claude"
translationDate: 2026-08-01
---

どのコーディングエージェントでも、ユニットテストは喜んで生成してくれます。問題は生成を拒むことではなく、`Assert.NotNull(result)` しか検証しない緑色のテストが 40 個できあがり、メソッドの中身を削除しても通ってしまうことです。2026-07-31 に Amaury Levé が [From generated code to trusted code with a unit-test agent](https://devblogs.microsoft.com/dotnet/polyglot-unit-testing-agent/) を公開し、[dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-test) の `dotnet-test` プラグインがリリースされました。狙いはまさにこの失敗パターンで、その仕組みはインストールしない場合でも取り入れる価値があります。

## インストールは 2 行

このプラグインは GitHub Copilot CLI のマーケットプレイス経由で配布されます。[modernize-dotnet エージェントが 7 月初旬に移った](/ja/2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin/)のと同じ配布経路です。

```bash
/plugin marketplace add dotnet/skills
/plugin install dotnet-test@dotnet-agent-skills
```

`dotnet/` の下に置かれていますが、エージェント自体はポリグロットです。.NET、Python、TypeScript、JavaScript、Java、Go、Ruby、Rust、Swift、Kotlin、PowerShell、C++ に対応します。対象はユニットテストのみで、テスト対象のコードを隔離し、外部サービスはモックにします。統合テスト、e2e テスト、パフォーマンステストは扱いません。

## 成功を報告する前に走るチェック

内部的には `code-testing-generator` は内部オーケストレーター (`user-invocable: false`) であり、researcher、planner、implementer、builder、tester、fixer、linter というサブエージェントのチェーンに処理を振り分けます。スコープに応じて 3 つの作業パスから 1 つを選びますが、その指針は好ましいほど保守的です。ほとんどのリクエストは Direct パスを取ってパイプラインを丸ごと省略すべきで、Research から Plan、Implement への完全なサイクルは、互いに無関係なソースファイルにまたがるスコープのためだけに残されています。

重要なのは、エージェントが完了してよいと判断される前に何が起きるかです。自明でない追加 (おおよそ 5 個以上のテスト、または列挙された振る舞いのリスト) では、完了前レビューが必須となり、次の 3 つのチェックが走ります。

1. **擬似ミューテーション解析**: `test-gap-analysis` スキルを使い、実装が変わったときにこれらのアサーションが本当に失敗するかを確認します。
2. **アサーションの深さのレビュー**: `assertion-quality` を使い、アサーションが弱い、欠けている、あるいは同語反復になっていないかを確認します。
3. **プロンプトとシナリオの対応付け**: 依頼した振る舞いのそれぞれに、偶然カバーされたものではなく専用のテストがあるかを確認します。

これが、コンパイラーが受け入れるだけのテストと、残す価値のあるテストの違いです。

```csharp
// Fails the assertion-quality check: green even if Apply() returns input unchanged
Assert.NotNull(cart.Apply(coupon));

// Survives pseudo-mutation: pins the actual behavior
var result = cart.Apply(coupon);
Assert.Equal(90.00m, result.Total);
Assert.Single(result.AppliedDiscounts, d => d.Code == "SAVE10");
```

そのうえで初めて、ワークスペース全体のビルドとテストスイート全体の実行を行い、リポジトリ自身のテスト検出が新しいテストを見つけられることを確認します。

## 数字が示すもの

Microsoft の報告では、完了率はエージェントなしの Copilot の 78.9% に対して 92.1% (152 タスク中 140) で、曖昧なプロンプトでは差がさらに開き、66.3% に対して 88.8% でした。タスクの平均所要時間は 359 秒、行カバレッジは 72.4%、ブランチカバレッジは 49.8% です。

ブランチの数字は正直に読むべきです。ブランチの半分は依然として未カバーであり、これはカバレッジ目標に達したときではなくチェックリストが片付いたときに停止するエージェントから予想される水準です。ここでの価値は、あなたがテストを書く作業を置き換えることではありません。ミューテーションとアサーションのチェックが「生成されたテストを残す価値があるとどう判断するか」への明文化された答えになっていることであり、その考え方は今使っているどのエージェントにも持ち込めます。
