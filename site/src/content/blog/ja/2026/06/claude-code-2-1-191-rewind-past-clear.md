---
title: "Claude Code 2.1.191 で /rewind が /clear より前まで戻れるようになりました"
description: "Claude Code v2.1.191（2026年6月24日）は /rewind を拡張し、/clear を実行する前のconversationとコードの状態を復元できるようにします。これまで永遠に失われていたコンテキストを取り戻せます。"
pubDate: 2026-06-26
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "ja"
translationOf: "2026/06/claude-code-2-1-191-rewind-past-clear"
translatedBy: "claude"
translationDate: 2026-06-26
---

Claude Code v2.1.191 は 2026年6月24日にリリースされ、目玉となる変更は説明としては小さいものの実用上は大きなものです。`/rewind` が `/clear` より前まで戻れるようになりました。クリーンな状態にするために消し去ったコンテキストは、もう失われたわけではなく、rewind ひとつ分の距離にあります。

## これまで /clear が失わせていたもの

`/clear` はconversationをリセットします。現在のスレッドが肥大化したとき、モデルが行き詰まりに固執しているとき、あるいはタスクを切り替えて新しいウィンドウが欲しいときには正しい一手です。その代償は、履歴の下に硬い床を引いてしまうことでした。`/clear` より前のものはすべてアクセス不能になります。Claude Code は進行に合わせてすでにセッションのチェックポイントを作成していたにもかかわらず、です。

その床を取り除くのが 2.1.191 です。`/rewind` を支えるセッションチェックポイントが `/clear` を生き延びるようになったため、rewind のセレクターはリセット前の地点を提示できます。

## /rewind の仕組み

`/rewind` は、Claude Code がセッションの各ステップで記録するチェックポイントを通じてあなたを後戻りさせます。`/rewind` コマンド、または `Esc` を 2 回押して開きます。

```text
Esc Esc          # open the rewind picker
/rewind          # same thing, typed
```

チェックポイントを選ぶと、何を復元するかを決められます。conversation、ディスク上のコード、またはその両方です。この区別が重要です。作業ツリーに触れずに質問を問い直すために conversation だけを 3 ステップ前の地点に戻すこともできますし、そこへ至った議論を残したままファイルだけを既知の良好な状態に復元することもできます。

このリリース以前は、利用可能なチェックポイントのリストは直近の `/clear` で止まっていました。今ではその先まで続きます。典型的な復元は次のようになります。

```text
# A long debugging thread, then a reset
/clear
# ...new work, then you realize you need the earlier repro
Esc Esc
# the picker now lists checkpoints from before the /clear
# select one, restore conversation + code, keep going
```

## これが /clear の使い方をどう変えるか

人々が `/clear` の実行をためらった正直な理由は、損失回避でした。クリアするとはその切断に踏み切ることを意味したため、念のために古く高価なコンテキストを抱え続けていました。リセットを取り消し可能にすることで、これが逆転します。`/clear` は各ウィンドウを引き締まった状態に保つための安価で日常的な手段になります。間違った切断は永続的ではなく復元できるからです。

これは最近のリリースの「チェックポイントを第一に」という方向性とも噛み合います。あなたのセッションは、保持するか破棄するかのどちらかしかない単一の線形なトランスクリプトではなく、行き来できる復元ポイントの連なりなのです。

## リリースの残りの部分

2.1.191 はまた、ストリーミング応答中にスクロール位置が飛ぶ問題を修正し、バックグラウンドエージェントの復活に関するバグを修正し、ポリシーによって無効化されたときに表示される `/voice` のメッセージを改善します。すぐ次のビルドである 2.1.193 は、Bash と PowerShell を自動モードの分類器を通してルーティングする `autoMode.classifyAllShell` を追加し、自動モードの拒否理由をトランスクリプトと `/permissions` に表示します。

完全なリリースノートは [Claude Code の changelog](https://code.claude.com/docs/en/changelog) にあります。
