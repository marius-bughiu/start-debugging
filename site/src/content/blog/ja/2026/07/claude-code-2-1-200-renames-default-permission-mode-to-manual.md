---
title: "Claude Code 2.1.200 は default 権限モードを Manual に改名します"
description: "Claude Code v2.1.200（2026 年 7 月 3 日）は、CLI、VS Code、JetBrains 全体で 'default' 権限モードを 'Manual' に改名し、AskUserQuestion ダイアログの自動継続を停止します。設定値は 'default' のままで、'manual' はエイリアスとして受け付けられます。"
pubDate: 2026-07-04
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "ja"
translationOf: "2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual"
translatedBy: "claude"
translationDate: 2026-07-04
---

Claude Code v2.1.200 は 2026 年 7 月 3 日にリリースされ、エージェントを対話的に実行する人なら誰にでも関わる 2 つのことを行います。これまで「default」と呼んでいた権限モードを「Manual」に改名し、`AskUserQuestion` ダイアログが自動で先に進まないように変更します。どちらも大きな機能ではありませんが、両方とも手に染みついた操作感を変えるものであり、2 つ目については小さな落とし穴をふさぐものです。

## なぜ「default」は不適切な名前だったのか

すべてのアクションを確認し、何かを実行する前に尋ねる権限モードは、これまで「default」というラベルが付けられていました。その名前はリスト内でどこに位置するかを示すだけで、それが何をするのかは示していませんでした。新しいユーザーは「default」と読んで、各ツール呼び出しを承認プロンプトでゲートするモードではなく、受動的な設定だと思い込んでいました。

2.1.200 は、人が読むあらゆる場所でこれを「Manual」に付け替えます。CLI のピッカー、`claude --help`、そして VS Code と JetBrains の拡張機能です。ポイントは、名前が動作を表すようになったこと、つまりあなたが各ステップを手動で承認するということです。

重要な点として、設定値は変わっていません。フック、SDK、そして既存の `settings.json` は引き続き `default` を使うため、何も壊れません。

```jsonc
// Both of these mean the same mode
{ "permissions": { "defaultMode": "default" } }
{ "permissions": { "defaultMode": "manual" } }
```

```bash
# manual is accepted as an alias wherever you type the value
claude --permission-mode manual
claude --permission-mode default   # still valid
```

Claude Code をスクリプト化する場合や、コミットした設定をチームで共有する場合は、`default` のままにしてください。これは安定した正規の値です。`manual` を使うのは、手で入力していて、ラベルを UI が現在表示している内容に合わせたいときだけにしましょう。

## AskUserQuestion が自動継続を停止します

2 つ目の変更は、コードレビューで指摘する価値のあるものです。`AskUserQuestion` ツールは、エージェントがタスクの途中で選択式の決定を提示する仕組みですが、以前はアイドル期間の後に自動継続し、あなたが席を外した場合はハイライトされた選択肢を選んでいました。これは、あなたが読んでいない作業の分岐に黙ってコミットしてしまうまでは便利です。

2.1.200 では、これらのダイアログはデフォルトで自動継続しなくなりました。エージェントはあなたを待ちます。もし本当に以前の席を外しても進む動作が欲しい場合は、頼んだかどうかに関わらず勝手に得るのではなく、`/config` を通じて明示的にアイドルタイムアウトをオプトインします。これは、[2.1.183 が auto モードで破壊的な git および IaC コマンドをブロックした](/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/)背景にある「ユーザーの代わりに取り返しのつかないことを決定しない」という同じ考え方です。

## リリースの残りの部分

2.1.200 は、バックグラウンドエージェントの信頼性に重点を置いています。スリープ／ウェイク後にバックグラウンドセッションが黙って停止する問題、再利用された PID がエージェントを二度と起動できないようにブロックしていた古い `daemon.lock` の問題、そしてレート制限で打ち切られたサブエージェントがきれいに失敗するのではなく空の結果を返す問題を修正します。また、`.claude.json` の `disabledMcpServers` または `enabledMcpServers` が配列以外の値に設定されている場合の起動時クラッシュの修正、加えて一連のスクリーンリーダーの改善と tmux 3.4 以降のレンダリングのちらつきの修正もあります。

チームで共有する設定を保持している場合、要点は小さいながらも現実的です。権限モードは変わっておらず、その表示名だけが変わったこと、そして対話的なダイアログがあなた抜きで進むことに少し慎重になったということです。詳細は [v2.1.200 changelog](https://code.claude.com/docs/en/changelog) にあります。
