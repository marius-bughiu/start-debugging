---
title: "Claude Code 2.1.122 で環境変数から Bedrock のサービス階層を選べるようになりました"
description: "Claude Code v2.1.122 は ANTHROPIC_BEDROCK_SERVICE_TIER 環境変数を追加し、X-Amzn-Bedrock-Service-Tier ヘッダーとして送信します。flex に設定すればエージェント呼び出しが 50 パーセント割引になり、priority にすれば応答が高速になります。SDK のコードを触る必要はありません。"
pubDate: 2026-04-30
tags:
  - "claude-code"
  - "ai-agents"
  - "aws-bedrock"
  - "dotnet"
lang: "ja"
translationOf: "2026/04/claude-code-2-1-122-bedrock-service-tier"
translatedBy: "claude"
translationDate: 2026-04-30
---

2026 年 4 月 28 日にリリースされた Claude Code v2.1.122 では、AWS Bedrock 上でこのエージェントを動かしている人なら誰もが静かに待っていた一行のつまみが追加されました。新しい `ANTHROPIC_BEDROCK_SERVICE_TIER` 環境変数で、リクエストごとに Bedrock のサービス階層を選択できます。`default`、`flex`、`priority` のいずれかを設定すると、CLI はその値を `X-Amzn-Bedrock-Service-Tier` ヘッダーとして転送します。SDK のコード変更は不要です。JSON 設定の編集も不要です。環境変数ひとつで済みます。

## 残りを読む前に、これが重要な理由

AWS は 2025 年 11 月、レイテンシとコストを引き換える方法として Bedrock に Priority と Flex のインファレンス階層を導入しました。[Bedrock のサービス階層ページ](https://aws.amazon.com/bedrock/service-tiers/) によると、Flex は "増加したレイテンシ" と引き換えに Standard 価格から 50 パーセント割引、Priority は 75 パーセントの割増で、リクエストをキューの先頭に押し上げます。Claude Code のように、セッション中に長いツール使用ターンの連鎖を発火させるエージェントにとって、計算結果はかなり大きく響きます。default で動いていた長い evergreen タスクは、追加の実時間を許容できるなら Flex で半額になり得ますし、ターミナルを見守るデバッグセッションは Priority のほうがきびきび感じられるはずです。

v2.1.122 までは、Bedrock 上の Claude Code で階層を選ぶ方法は、リクエスト層を自前でラップするか、ヘッダーを差し込めるプロキシを通すしかありませんでした。このリリースに着地した [機能リクエスト](https://github.com/anthropics/claude-code/issues/16329) でそのギャップが埋まりました。

## 実際の使い方

```bash
# Cheap background agents that triage issues overnight
export ANTHROPIC_BEDROCK_SERVICE_TIER=flex
claude --from-pr https://github.acme.internal/acme/api/pull/482

# Interactive debug session, paying for speed
export ANTHROPIC_BEDROCK_SERVICE_TIER=priority
claude
```

CLI は値をそのまま `X-Amzn-Bedrock-Service-Tier` として InvokeModel リクエストに乗せて送ります。これは CloudTrail と CloudWatch がすでに `ServiceTier` と `ResolvedServiceTier` で記録している配管と同じです。プラットフォームチームが階層別の Bedrock 支出ダッシュボードを持っているなら、Claude Code のトラフィックは追加作業なしで正しいバケットに着地します。

## ResolvedServiceTier に注意

ヘッダーは要求であって、保証ではありません。AWS は実際に提供した階層を `ResolvedServiceTier` で返し、モデルの flex プールが飽和していれば Flex リクエストはダウングレードされ得ます。どのモデルが Priority と Flex をサポートするかの完全なリストは [Bedrock の料金ページ](https://aws.amazon.com/bedrock/pricing/) にあり、最新のモデルリリースから数週間遅れるので、`flex` を CI ジョブに焼き込む前に、Claude Code で動かしているモデル ID がそのリストに載っていることを確認してください。階層が未サポートの場合、AWS は透過的にデフォルト階層にフォールバックし、それに応じて課金します。

`ANTHROPIC_BEDROCK_SERVICE_TIER` の行は changelog の中ほどに埋もれていますが、現時点で Bedrock ホスト型 Claude Code のもっとも安いコストのレバーです。完全なノートは [Claude Code v2.1.122 リリースページ](https://github.com/anthropics/claude-code/releases) にあります。
