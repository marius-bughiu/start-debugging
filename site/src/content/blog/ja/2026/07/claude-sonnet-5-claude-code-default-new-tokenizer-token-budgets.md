---
title: "Claude Sonnet 5 が Claude Code の新しいデフォルトに: トークン予算を数え直しましょう"
description: "Claude Sonnet 5 (claude-sonnet-5) は 2026-06-30 に登場し、Claude Code の 'sonnet' エイリアスの実体になりました。新しいトークナイザーは同じテキストに対して約 30% 多くのトークンを出力するため、Sonnet 4.6 向けに調整したコスト見積もりや max_tokens の上限は数え直しが必要です。"
pubDate: 2026-07-08
tags:
  - "claude-code"
  - "ai-agents"
  - "llm"
lang: "ja"
translationOf: "2026/07/claude-sonnet-5-claude-code-default-new-tokenizer-token-budgets"
translatedBy: "claude"
translationDate: 2026-07-08
---

Claude Sonnet 5 (`claude-sonnet-5`) は 2026-06-30 に登場しました。これは自分でオプトインする必要のあるプレビューではありません。Anthropic API では `sonnet` エイリアスがこのモデルに解決されるようになり、Claude Code では Pro、Team Standard、Enterprise のサブスクリプション席に対するアカウントのデフォルトになっています。つまり、多くの人がすでに設定を 1 行も変えずにこれを使っているということです。注意点は、"ドロップイン アップグレード" が "同じトークンの計算" を意味するわけではないことです。コストを見積もったり `max_tokens` を手作業でサイズ調整したりしている場合、Sonnet 4.6 向けに調整した数値はもう正しくありません。

## トークナイザーが気づかないうちに変わりました

Sonnet 5 は新しいトークナイザーを搭載しています。同じ入力テキストが Sonnet 4.6 よりも約 30% 多くのトークンを生成します。トークンあたりの価格は変わらず、入力/出力で 100 万トークンあたり $3/$15 です (2026-08-31 まで有効な $2/$10 の導入価格つき)。しかし同一のテキストに対してトークンが 30% 増えるということは、価格表が変わっていなくても、同等のリクエストのコストが上がるということです。

トークンで測る 3 つの値が変わります。

- **リクエストあたりのコスト。** Sonnet 4.6 のトークン数から導いた見積もりは、いまや低すぎます。
- **`max_tokens` の予算。** 期待するレスポンスに近い値でサイズ調整した出力上限は、同じレスポンスがより多くのトークンを消費するため、Sonnet 5 では切り詰められる可能性があります。
- **テキスト換算でのコンテキスト容量。** ウィンドウは 1M トークンですが、各トークンが平均してカバーするテキストは少なくなるため、同じウィンドウに収まる文章量は減ります。

外挿してはいけません。予算を信頼する前に、トークンカウントのエンドポイントを使ってモデルに対して数え直してください。

```bash
curl https://api.anthropic.com/v1/messages/count_tokens \
  --header "x-api-key: $ANTHROPIC_API_KEY" \
  --header "anthropic-version: 2023-06-01" \
  --header "content-type: application/json" \
  --data '{
    "model": "claude-sonnet-5",
    "messages": [{ "role": "user", "content": "Summarize this build log." }]
  }'
```

同じ payload を `claude-sonnet-4-6` に対して実行し、`input_tokens` を比較してください。その差分があなたの予算補正です。

## いまや 400 を返す 3 つの API の挙動

Sonnet 5 を直接呼び出す場合、Sonnet 4.6 で動いていた 3 つのリクエストが `400` を返すようになります。

- **サンプリングパラメーター。** `temperature`、`top_p`、`top_k` を非デフォルト値に設定すると拒否されます。これらを削除し、代わりにシステム prompt で制御してください。
- **手動の拡張思考。** `thinking: {"type": "enabled", "budget_tokens": N}` は廃止されました。デフォルトで有効な適応的思考を使ってください。
- **アシスタントのプレフィル。** 引き続きサポートされておらず、Sonnet 4.6 から変わりません。

## Claude Code の中でどういう意味を持つか

Sonnet 5 には Claude Code v2.1.197 以降が必要です。`sonnet` がまだ 4.6 に解決される場合は `claude update` を実行してください。Anthropic API では常にネイティブの 1M コンテキストウィンドウで動作し、`[1m]` サフィックスも利用クレジットも不要で、セッションは約 967K トークンで自動コンパクトされます。コスト管理のために 200K のハードな上限が必要なら、`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` を設定してください。そしてチームがいつバージョンを切り替えるかを正確に制御したいなら、エイリアスに任せるのではなく完全な ID を固定してください。

```json
{
  "model": "claude-sonnet-5"
}
```

移行そのものは、本当にモデル ID を 1 行入れ替えるだけです。作業はその周りの予算にあります。詳細は [Sonnet 5 のリリースノート](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5) にあります。
