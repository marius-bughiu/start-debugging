---
title: "Claude Code がプロンプトキャッシュミスの推定原因を表示するようになりました"
description: "Claude Code 2.1.260 では、/usage の Prompt cache (main) 行とステータスラインの prompt_cache オブジェクトに推定原因の診断が追加されました。ミスの回数を数えるだけでなく、ツールセットが変わったのか、システムプロンプトが変わったのか、TTL が切れたのかを示します。"
pubDate: 2026-09-07
tags:
  - "claude-code"
  - "ai-agents"
  - "prompt-caching"
  - "token-cost"
lang: "ja"
translationOf: "2026/09/claude-code-now-names-the-likely-cause-of-a-prompt-cache-miss"
translatedBy: "claude"
translationDate: 2026-09-07
---

Claude Code 2.1.260 では、コストのデバッグにおける長年の空白を埋める診断機能が追加されました。プロンプトキャッシュがミスしたとき、その理由を教えてくれます。バージョン 2.1.251 の時点で `/usage` の Session ブロックに `Prompt cache (main)` 行は追加されていましたが、その行はミスの回数を数えるだけでした。300k トークンの会話を 3 回まるごと再処理した分を支払ったと分かっても、何をやめればよいのかは分かりません。2.1.260 以降、この行は推定原因も示します。たとえば `likely cause: tool definitions changed` のように表示されます。

## ミスが高コストで、しかも見えない理由

Claude Code はターンごとに会話全体を再送するため、長いセッションのコストを抑えているのはキャッシュです。API はリクエストのプレフィックスで照合し、その照合は完全一致です。プレフィックスのどこか一箇所でも変わると、それ以降がすべて再計算されます。ファイル単位やセグメント単位のキャッシュはありません。だからこそ [prompt caching のドキュメント](https://code.claude.com/docs/en/prompt-caching) は、キャッシュを無効化する具体的な操作を列挙しています。モデルの切り替え、ツール検索がツールを遅延読み込みしていない状態での MCP サーバーの接続や切断、`Bash` のような素のツール名による deny ルールでのツール全体の拒否、そして Claude Code 自体のアップグレードなどです。

問題は、その多くが目に見えないことです。stdio の MCP サーバーのプロセスが静かに終了したり、HTTP セッションが期限切れになったりすると、トランスクリプトに何のメッセージも出ないままセッション途中でツール定義が変わります。見えるのは遅い 1 ターンと請求額だけです。

Claude Code は、キャッシュから読めたはずの内容のうち 5% を超え、かつ 2,000 トークン以上を再処理し、その差分をコンパクションやツール結果のクリアで説明できない場合に、そのリクエストをミスとして数えます。コンパクションによる再構築は expected rebuilds として別に数えられるため、ミスの件数は正確に保たれます。

## ステータスラインから原因を読む

ステータスラインをスクリプトで書いている人にとって興味深いのは、この診断が単なる文章ではなく構造化データである点です。2.1.260 で `prompt_cache` オブジェクトに `last_miss_cause` と `miss_causes` が追加されました。`causes` 配列には `tools_changed`、`system_prompt_changed`、`ttl_expired_5m`、`likely_server_side` といった名前が入り、そのうち 2 つはカウントを伴います。`tools_changed` には `tools_added` と `tools_removed` が、`system_prompt_changed` には `system_char_delta` が付きます。

```bash
#!/bin/bash
input=$(cat)
cause=$(echo "$input" | jq -r '.prompt_cache.last_miss_cause.causes[0] // empty')
ratio=$(echo "$input" | jq -r '.prompt_cache.hit_ratio // 0')
printf "cache %.0f%%" "$(echo "$ratio * 100" | bc -l)"
[ -n "$cause" ] && printf " | last miss: %s" "$cause"
```

`last_miss_cause` はセッション最初のミスが起きるまで `null` であり、Claude Code が原因を特定できなかった場合も `null` になるため、読み取りはガードしてください。`miss_causes` は集計値です。`tools_changed` が 5 回出ているセッションは、単発の事故ではなく MCP サーバーが不安定だということです。

これらのカウントは API レスポンスのキャッシュトークンのフィールドから計算されるため、Bedrock でも Google Cloud's Agent Platform でも、ゲートウェイ経由でも動作します。対象はメインの会話だけでサブエージェントは含まれず、`/clear` でリセットされます。

同じリリースでは、フルスクリーンモードで会話の横に開き、Claude の編集に合わせて未コミットの変更を追跡する `/diff` パネルも追加されました。リリースの流れを追っているなら、その翌日の [2.1.261 で /skill-doctor が追加されています](/ja/2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context/)。詳細は [v2.1.260 のリリース](https://github.com/anthropics/claude-code/releases/tag/v2.1.260)、フィールドのリファレンスは [ステータスラインのドキュメント](https://code.claude.com/docs/en/statusline#prompt-cache-fields) にあります。
