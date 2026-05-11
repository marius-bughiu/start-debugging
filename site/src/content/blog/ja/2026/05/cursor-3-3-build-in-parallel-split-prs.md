---
title: "Cursor 3.3 が Build in Parallel、Split PRs、統合された PR レビューを追加"
description: "Cursor 3.3 (2026 年 5 月 7 日) は、計画の独立したステップを同時に進める非同期サブエージェント、1 つのチャットを複数の pull request に分割するクイックアクション、レビュー・コミット・変更を 1 か所にまとめた新しい PR ワークフローを提供します。"
pubDate: 2026-05-11
tags:
  - "cursor"
  - "ai-agents"
  - "pull-requests"
  - "subagents"
lang: "ja"
translationOf: "2026/05/cursor-3-3-build-in-parallel-split-prs"
translatedBy: "claude"
translationDate: 2026-05-11
---

2026 年 5 月 7 日、Cursor は [バージョン 3.3](https://cursor.com/changelog/05-07-26) をリリースしました。これは、[TypeScript SDK プレビュー](/ja/2026/05/cursor-typescript-sdk-programmatic-coding-agents/) がすでに示唆していたのと同じ変化を一段と進めるリリースです。エージェントはもはや 1 つのチャットに結びついた単一の作業スレッドではありません。目玉機能である "Build in Parallel"、"Split PRs"、そして再設計された PR レビュー面は、エディターを、1 人が複数の同時実行を監督するマルチエージェント IDE に近づけます。

## Build in Parallel は計画を非同期サブエージェントに変える

計画は以前から Cursor のループの一部でした。あなたが計画を書き、エージェントがステップをたどります。3.3 では、新しい "Build in Parallel" アクションがその計画を受け取り、独立したステップを見つけ出して、それぞれを同時に処理する非同期サブエージェントを起動します。計画が順序を含んでいる場合、Cursor は依存するステップを引き続き順番どおりに保つので、グラフを手動でマークする必要はありません。

CLI 風の使い方が好みなら、同じ機構をチャットから動かす `/multitask` コマンドがあります。

```text
/multitask
- Wire the Stripe webhook handler
- Add a Polly retry policy around the OpenAI client
- Rewrite the README install section
```

各項目は専用のサブエージェント コンテキストで動きます。サブエージェントは同じバッファーではなくスナップショットを通じてワークスペースを共有するため、同じファイルに対する 2 つの同時編集がぶつかることがなくなりました。Explore サブエージェントはモデル セレクター (`model: opus`、`model: parent`、`disabled`) も受け取るようになり、安価な "関連コードを探す" ホップを、書き手より小さいモデルで実行できます。

## Split PRs は 1 つのチャットを複数に切り分ける

エージェントを 1 時間走らせ続けたことがある人なら、その痛みを知っています。止めた頃には diff は無関係な 4 つの変更を含み、それを 1 つの PR としてレビューするのは絶望的です。新しいクイックアクション "Split into PRs" はチャットのトランスクリプトを解析し、論理的な関心ごとにコミットをグループ化して、グループごとに 1 つの PR を開きます。Cursor は実際の依存関係を検出しない限り PR を独立に保ち、依存があれば "depends on" メモでリンクします。

分割の前には安全用のスナップショットが作成され、Cursor は push の前に承認を求めます。

## PR Review は 3 つのタブを 1 つのワークフローにまとめる

3 つ目の柱は、エディター内で再設計された PR ビューです。3 つのタブが、これまでの GitHub とエージェント パネルの分断を置き換えます。

- **Reviews**: インラインのレビュー スレッドと PR のトップ レベル コメント、返信や受諾のためのクイック アクション。
- **Commits**: PR にフォーカスしたコミット一覧で、エージェントの履歴を 1 ステップずつ追えます。
- **Changes**: ファイル ツリーとピッカー、PR が 40 ファイルに触れたときに効いてくる部分です。

これら 3 つの機能を合わせると、[Cursor の TypeScript SDK](/ja/2026/05/cursor-typescript-sdk-programmatic-coding-agents/) が指していた方向とまったく同じ姿が浮かび上がります。作業の単位はもはや "1 つのプロンプト、1 つの diff" ではなく、"1 つの計画、多くのサブエージェント、多くの PR" です。
