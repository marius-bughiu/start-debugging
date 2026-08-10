---
title: "Claude Code 2.1.224 でセッション同士がメッセージを送れるようになりました"
description: "セッション間メッセージングが 2026-08-07 に登場しました。ListAgents と SendMessage がセッション間でプレーンテキストを運び、crossSessionInbound が実際に届くものを決めます。"
pubDate: 2026-08-10
tags:
  - "claude-code"
  - "ai-agents"
  - "developer-tools"
lang: "ja"
translationOf: "2026/08/claude-code-2-1-224-sessions-message-each-other"
translatedBy: "claude"
translationDate: 2026-08-10
---

ターミナルが 2 つ、リポジトリは同じ。マイグレーションを実行している側が、もう一方がまだクエリを書いている列の名前を変更したところです。先週まで、その修正役はあなた自身で、ウィンドウ間をコピー＆ペーストして回っていました。2026-08-07 に公開された Claude Code 2.1.224 は、このループを閉じます。同じマシン上のセッションが、別のセッションへメッセージを手渡せるようになりました。

## ListAgents が見つけ、SendMessage が届ける

作業を担うツールは 2 つで、どちらもあなたが呼び出すことはありません。`ListAgents` はセッションが到達できるエージェントを列挙し、`SendMessage` はそのうちの 1 つを名前で指定します。あなたは意図を伝えるだけです。

```text
Tell the session working on the payments API that the tenant_id column landed
```

メッセージ本文は Claude 自身が書きます。一覧を自分で確認するには `/list-agents` を実行します（`/peers` というエイリアスもあります）。セッションは `--name` や `/rename` で付けた名前に応答し、名前を付けていない場合は Claude Code が作業ディレクトリから `myapp-3f` のような名前を導出します。

同一マシン内の配送はセッションごとの Unix ソケットを通り、Anthropic のサーバーを経由しません。`/status` はそのパスを `Peer address` の行に表示し、フックや Bash コマンドには `CLAUDE_CODE_MESSAGING_SOCKET` として渡されます。スクリプトが自分を起動したセッションへ書き戻すのは、この経路です。

要件は狭めです。v2.1.224 以降であること、macOS または Linux であること（WSL 2 は対象、ネイティブの Windows は対象外）、そして Amazon Bedrock、Google Cloud's Agent Platform、Microsoft Foundry では利用できません。

## このチャネルが運ばないもの

メッセージはプレーンテキストです。会話履歴でもファイルでも権限でもありません。到着時、Claude Code は受信側セッションに対して、そのテキストはあなたではなく別のエージェントから来たものだと伝えます。この位置づけには実効性があります。メッセージは保留中の権限プロンプトに答えられず、受信側を説得して `CLAUDE.md` や権限ルールを書き換えさせることもできず、本文中の `/compact` はコマンドではなく無効なテキストとして届きます。

受信の扱いは `crossSessionInbound` という設定で決まり、値は `accept`、`hold`、`refuse` の 3 つです。何も設定していない場合、Claude Code は 2 つのセッションの権限モードのクラスを比較して、メッセージごとに判断します。`bypassPermissions` のセッションは、確認を求めるセッションから送られたものを保留し、確認を求めるセッションは、確認を省くセッションから送られたものを保留します。保留されたメッセージは承認ダイアログを開き、5 分で期限切れになります（`dialogExpiry` で調整可能）。

このデフォルトこそ、ヘッドレスのワーカーが黙り込む理由です。`claude -p` のセッションは受信ソケットをバインドし一覧にも現れますが、承認ダイアログを描画できないため、保留されたメッセージは保留のままになります。`--settings` の値で明示的に accept を与えてください。

```json
{
  "crossSessionInbound": "accept"
}
```

無効化はその鏡像で、管理者は管理対象の設定から強制できます。

```json
{
  "permissions": {
    "deny": ["SendMessage", "ListAgents"]
  },
  "crossSessionInbound": "refuse"
}
```

`SendMessage` を拒否すると、サブエージェントやエージェントチームのメンバーへのメッセージングも一緒に失われます。同じツールが両方を担っているからです。[2.1.219 が再び開いた 3 階層のネスト](/ja/2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep/)に頼っているなら、この拒否ルールの代償は見た目より大きくなります。

## マシンをまたぐ話は、その翌日に

2026-08-08 に公開された 2.1.225 は、到達範囲を広げます。[changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) によれば、`SendMessage` は他のマシン上にある Remote Control のセッションと、名前を指定して会話を開始できるようになり、`ListAgents` はそれらを `name [ref]` として表示します。それ以前、マシンをまたぐ通信は返信のみで、[ドキュメント](https://code.claude.com/docs/en/cross-session-messaging)は今もそのように説明しています。

これらのメッセージは Remote Control の接続を通って Anthropic のサーバーを経由するので、そのためのスイッチがあります。`isolatePeerMachines` を `true` にすると、通常の権限プロンプトを省く `bypassPermissions` モードであっても、何かがマシンの外へ出る前にあなたの明示的な承認が必要になります。どの設定スコープからの `true` でも有効です。

暴走したやり取りを抑えるのは行儀の良さではなく転送層です。繰り返しは送信者ごとにレート制限され、短い時間枠内の同一メッセージは破棄され、未読のセッションに積まれる受理済みメッセージは最大 50 件までです。
