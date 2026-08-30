---
title: "PreModelSwitch: Claude Code がモデル切り替えを拒否できるようになりました"
description: "Claude Code 2.1.251 で PreModelSwitch と PostModelSwitch のフックイベントが追加されました。matcher は切り替え先モデルの正規名で発火し、終了コード 2 で切り替えをキャンセルできます。"
pubDate: 2026-08-30
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
lang: "ja"
translationOf: "2026/08/claude-code-premodelswitch-hook-gates-model-changes"
translatedBy: "claude"
translationDate: 2026-08-30
---

今週より前に Claude Code が出荷したフックイベントは、いずれもモデルが行う何かを見張るものでした。`PreToolUse` は Bash コマンドが実行される前にそれを見て、`PermissionRequest` はあなたが答える前にリクエストを見て、`PreCompact` は要約される前にトランスクリプトを見ます。2026-08-28 にリリースされたバージョン 2.1.251 で、モデル自体を見張る最初のペアが追加されました。`PreModelSwitch` と `PostModelSwitch` は、セッションがどの重みで応答するかを変えたときに発火します。

## モデルの切り替えにゲートが必要な理由

セッションのモデルは好みではなく、入力です。リファクタリングの途中で Opus を Haiku に替えれば、同じトランスクリプトに対して別の推論器が次のツール呼び出しを組み立てます。チームがこれを気にする理由は三つに分かれます。コスト (`/model` を上位に切り替えると残りのターンの請求が跳ね上がる可能性があります)、再現性 (「Claude が X をした」というバグ報告は、セッション途中でモデルが変わっていたら検証できません)、そしてポリシー (特定のモデルにしかコードを送れない組織があります) です。

2.1.251 より前は、これらを強制できる継ぎ目がまったくありませんでした。今はあります。

## 切り替えをブロックする

`settings.json` にフックを登録します。ここでの matcher はツール名ではなく、セッションが切り替える*先*のモデルの正規名に一致します。

```json
{
  "hooks": {
    "PreModelSwitch": [
      {
        "matcher": "claude-opus-5",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-model-switch.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

matcher は正規表現なので、単一の ID ではなくファミリー全体を捕まえたい場合は `claude-opus-4-6|claude-opus-5` でも `.*opus.*` でも動きます。

フックは stdin からイベントを読み取ります。`PreModelSwitch` と `PostModelSwitch` は通常のツール向けフィールドの代わりに `from_model` と `to_model` を受け取り、あわせて `session_id`、`prompt_id`、`transcript_path`、`cwd` も渡されます。

```bash
#!/usr/bin/env bash
to_model=$(jq -r '.to_model')

if [ -n "$OPUS_BUDGET_EXHAUSTED" ]; then
  cat <<JSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreModelSwitch",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Opus budget for this repo is spent. Staying on $to_model is blocked until the cycle resets."
  }
}
JSON
fi
exit 0
```

終了コード 2 で抜けても切り替えはブロックされます。JSON を出力したくない場合の一行版です。知っておくべき鋭い落とし穴が一つあります。`timeout` でキャンセルされた `PreModelSwitch` フックも切り替えをブロックします。このイベントは、ライフサイクルの大半とは違ってフェイルクローズドです。

## PostModelSwitch は頼んでいなくても発火します

`PostModelSwitch` は監査側の半分で、自分の `/model` 呼び出しより広い範囲をカバーします。ドキュメントによれば "after the session's model changes, including changes Claude Code makes on its own, such as restoring the model when you resume a session" に実行されます。まさにこれが「どのモデルがこれを書いたのか」を後から答えにくくするケースなので、ここで `from_model`、`to_model`、`session_id` をログファイルに追記しておくのは、今週追加できる中で最も安価な可観測性です。

同じリリースでは、effort が xhigh または max のときに Opus 5 のリクエストが "effort is not supported when thinking is disabled" で失敗する問題も修正され、[権限チェックを迂回する四つの経路](/ja/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/)も塞がれました。詳細は [フックのリファレンス](https://code.claude.com/docs/en/hooks) にあります。
