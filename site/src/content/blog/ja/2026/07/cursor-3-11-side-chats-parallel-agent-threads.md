---
title: "Cursor 3.11 の Side Chats: メインのエージェントを脱線させずに質問を枝分かれさせる"
description: "Cursor 3.11（2026年7月10日）は side chats を追加しました。/side や /btw で開く永続的な並列エージェントスレッドで、メンションでメインの会話に引き戻せます。さらに Cmd+K によるトランスクリプト検索と、新しいクラウドエージェント用のフックも加わりました。"
pubDate: 2026-07-12
tags:
  - "cursor"
  - "ai-agents"
  - "llm"
  - "productivity"
lang: "ja"
translationOf: "2026/07/cursor-3-11-side-chats-parallel-agent-threads"
translatedBy: "claude"
translationDate: 2026-07-12
---

Cursor 3.11 は 2026年7月10日にリリースされ、その目玉機能は具体的な悩みを解決します。エージェントのタスクに深く入り込んでいるときに、ふと寄り道が思い浮かび（「待って、このリポジトリはそもそもどこかで `IAsyncEnumerable` を使っているのか?」）、それを質問すると、組み立ててきたスレッドが脱線してしまいます。side chats は、メインの会話に触れることなくその質問をする場所を与えてくれます。

## side chat は下書きではなく、完全なエージェントです

重要な点は、side chat が軽量なポップアップではないということです。これはメインのチャットと並んで動く、永続的で完全なエージェントの会話です。フォローアップしたり、閉じたり、あとで見直したりでき、その間ずっと独自のコンテキストを保ちます。これはプロンプトを消して打ち直すのとは異なり、寄り道がそれ自体の永続的なスレッドになり、あとで戻ってこられます。

開き方は3通りあります。`/side` コマンド、`/btw` ショートカット、またはチャットパネル上部のプラスボタンです。

```text
# In the middle of a refactor, spin off a question without losing your place:
/btw where do we register the JWT bearer handler?

# Or explicitly:
/side compare our current retry policy to Polly's default
```

side chats は、メインのエージェントが自分の状態をそのまま保っている間、読む・検索する・答えることに寄っています。答えを探しに行ったからといって、メインのタスクがその計画を失うことはありません。

## メンションで答えを引き戻す

これを2つ目のタブ以上のものにしているのは、戻り道です。side chat が何かを解明したら、メインのスレッドから @ でメンションして、そのコンテキストを引き戻します。

```text
# Back in the main chat, fold the side chat's findings into the real work:
@side-chat: retry-policy apply that Polly comparison to OrderService
```

つまりワークフローはこうです。枝分かれし、隔離した状態で調査し、そして何も説明し直すことなく、その結論をメインのエージェントに接ぎ木します。隔離は探索の間もメインのコンテキストをきれいに保ち、メンションは探索が無駄にならなかったことを意味します。

## 3.11 の残りの変更点

知っておく価値のある変更があと2つあります。会話の検索がローカルインデックス上で動くようになりました。`Cmd+K` は過去の何千ものエージェントのトランスクリプトを検索し、`Cmd+F` は1つの会話の中で一致箇所へ移動します。リポジトリとプロジェクトのピッカーは、場所（This Computer、Cloud、Remote Machines）で絞り込めるように、そしてピッカーを離れずにプロジェクトを作成したり GitHub/GitLab を接続したりできるように作り直されました。

エージェントの挙動をスクリプト化する人向けに、3.11 は `beforeSubmitPrompt` や `afterAgentResponse` といったクラウドエージェント用のフックも追加します。これらはエージェントの推論とそのサブエージェントの挙動を観察し、制御できるようにします。

```json
{
  "hooks": {
    "beforeSubmitPrompt": "./scripts/inject-guardrails.sh",
    "afterAgentResponse": "./scripts/lint-agent-output.sh"
  }
}
```

すでに並列の workers を動かしているなら、side chats はその1つ下の層に位置します。作業をこなす別のエージェントではなく、あなたがそうすべきだと決めるまでメインのエージェントに聞かれることなく声に出して考えられる場所です。より重量級のマルチワーカーの話がツール間でどう比較されるかは、[Cursor のサブエージェント vs Claude Code のサブエージェント](/2026/07/cursor-subagents-vs-claude-code-subagents/) をご覧ください。詳細は [Cursor の changelog](https://cursor.com/changelog) にあります。
