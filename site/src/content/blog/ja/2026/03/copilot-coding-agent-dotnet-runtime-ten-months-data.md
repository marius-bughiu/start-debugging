---
title: "dotnet/runtime での 878 件の Copilot Coding Agent PR は実際にはどう見えるか"
description: ".NET チームが GitHub の Copilot Coding Agent を dotnet/runtime で運用した 10 か月分のリアルなデータを共有: 878 件の PR、マージ率 67.9%、AI 支援の開発がどこで助け、どこで依然として不足しているかについての明確な教訓。"
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "ai"
  - "ai-agents"
  - "github-copilot"
  - "copilot"
  - "github"
lang: "ja"
translationOf: "2026/03/copilot-coding-agent-dotnet-runtime-ten-months-data"
translatedBy: "claude"
translationDate: 2026-04-25
---

GitHub の Copilot Coding Agent は 2025 年 5 月から [dotnet/runtime](https://github.com/dotnet/runtime) リポジトリで動作しています。Stephen Toub の [詳細分析記事](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/) は 10 か月分の実使用をカバーします。提出された 878 件の PR、マージされた 535 件、マージ率 67.9%、リバート率はわずか 0.6% です。

## 数字が興味深くなるところ

すべての PR サイズが同じというわけではありません。小さく焦点を絞った変更ほど高い率で成功します。

| PR サイズ (変更行数) | 成功率 |
|---|---|
| 1-10 行 | 80.0% |
| 11-50 行 | 76.9% |
| 101-500 行 | 64.0% |
| 1,001+ 行 | 71.9% |

101-500 行での落ち込みは、機械的なタスクがアーキテクチャ上のものに変わる境界を反映しています。クリーンアップと削除の作業がカテゴリーをトップで 84.7% の成功率、続いてテスト追加が 75.6% です。これらは成功基準が明確で、意図に曖昧さがなく、影響半径が限定されたタスクです。

## 指示がゲームのすべて

チームの最初の月は、有意な構成なしで 41.7% のマージ率を生みました。適切なエージェント指示ファイルを書いた後 -- ビルドコマンド、テストパターン、アーキテクチャ境界を指定 -- 数週間で率は 69% に上昇し、最終的に 72% に達しました。

最小限だが効果的なセットアップはこのように見えます。

```markdown
## Build
Run `./build.sh clr -subset clr.runtime` to build the runtime.
Run `./build.sh -test -subset clr.tests` to run tests.

## Testing Patterns
New public APIs require tests in src/tests/.
Use existing helpers in XUnitHelper rather than writing from scratch.

## Scope Limits
Do not change public API surface without a linked tracking issue.
Native (C++) components require Windows CI -- avoid if not needed.
```

指示は長くある必要はありません。具体的である必要があります。

## レビューキャパシティがボトルネックになる

データからの示唆深い観察: 1 人の開発者が旅行中に電話から 9 件の実質的な PR をキューに入れ、チームに 5-9 時間のレビュー作業を生成できました。PR 生成は PR レビューより速くスケールしました。その非対称性は、新しい量を吸収するために AI 支援のコードレビューへの並行投資を促しました。このパターンは、エージェントを規模で採用するどのチームでも繰り返されるでしょう。

## CCA が置き換えないもの

アーキテクチャの決定、クロスプラットフォームの推論、API 形状についての判断は、一貫して人間の介入を必要としました。CCA のマージされたコードは、人間のコントリビューターの 49.9% に対してテストコード 65.7% に分解されます。人間が日常的に優先順位を下げる機械的な作業を埋めるのに最も強力です。

より広範な検証は 7 つの .NET リポジトリ (aspire、roslyn、aspnetcore、efcore、extensions など) をカバーしました。提出された 2,963 件のうち 1,885 件のマージ済み PR、成功率 68.6%。パターンは規模でも保たれます。

Copilot Coding Agent の採用を考えているチームへ: 小さなクリーンアップやテストタスクから始め、何よりもまず指示ファイルを書き、レビューキャパシティが次の制約になるよう計画してください。

完全な分析は [devblogs.microsoft.com](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/) にあります。
