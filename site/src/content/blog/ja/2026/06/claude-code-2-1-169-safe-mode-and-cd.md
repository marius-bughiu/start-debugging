---
title: "Claude Code 2.1.169 が --safe-mode とプロンプトキャッシュを温かく保つ /cd を追加"
description: "Claude Code v2.1.169 (2026年6月8日) は、すべてのカスタマイズを無効にしてクリーンにトラブルシューティングできる --safe-mode フラグと、実行の途中でプロンプトキャッシュを壊さずにセッションを新しいディレクトリへ移す /cd コマンドを追加します。"
pubDate: 2026-06-09
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "ja"
translationOf: "2026/06/claude-code-2-1-169-safe-mode-and-cd"
translatedBy: "claude"
translationDate: 2026-06-09
---

Claude Code v2.1.169 は 2026年6月8日にリリースされ、長いエージェントセッションで最も煩わしい 2 つの瞬間を狙った 2 つの変更を含んでいます。「自分の設定が原因かツールが原因か」というデバッグの堂々巡りと、別のディレクトリで作業する必要があるたびに支払うプロンプトキャッシュのリセットです。どちらも小さなフラグです。どちらも実際のコストを取り除きます。

## `--safe-mode` は二分探索のためのクリーンな基準を与えます

Claude Code がおかしな挙動を始めたとき、hook が本来発火すべきでないのに発火する、MCP サーバーが起動時にハングする、skill がスラッシュコマンドを乗っ取る、こうしたときの難しい問いは、不具合が CLI にあるのか、それとも自分のカスタマイズのスタックにあるのか、ということです。これまでは、その答えを出すには `CLAUDE.md` を手動でどかし、`settings.json` の hooks をコメントアウトし、プラグインを 1 つずつ無効にする必要がありました。

v2.1.169 はそれらすべてを 1 つのフラグにまとめます。

```bash
# Start with CLAUDE.md, plugins, skills, hooks, and MCP servers all disabled
claude --safe-mode

# Same thing via env var, handy in CI or a wrapper script
CLAUDE_CODE_SAFE_MODE=1 claude
```

セーフモードで問題が消えるなら、それはあなたの側の問題であり、再び戻るまでカスタマイズをグループごとに有効化していけます。問題が残るなら、それは CLI の問題であり、報告するためのクリーンな再現手順が手に入ります。これはエージェント CLI における、Windows をセーフモードで起動する、あるいはエディターを `--disable-extensions` で起動するのと同等のものです。修正ではありませんが、判定までの最速の道です。

## `/cd` はキャッシュをリセットせずにセッションを移します

もう 1 つの変更はより微妙で、長い実行で実際のコストを節約します。Claude Code は会話の先頭部分を Anthropic のプロンプトキャッシュでキャッシュしており、これは短い TTL を持ち、後続のターンを速く安価に保つものです。作業ディレクトリの変更は、これまで終了して再起動することを意味し、そのキャッシュを捨てていました。次のターンはコンテキスト全体をキャッシュなしで読み直し、遅くなり、安価なキャッシュ読み取り料金ではなく完全な `cache_creation` 料金で課金されました。

新しい `/cd` コマンドは、アクティブなセッションをその場で新しいディレクトリへ移します。

```text
# Working in the API project, now need to touch the shared library
/cd ../shared-lib

# Absolute paths work too
/cd C:\S\start-debugging\site
```

セッションは履歴と温かいキャッシュを保持するため、`/cd` の直後のターンも依然としてキャッシュヒットになります。backend のツリーと frontend のツリーを行き来するマルチリポジトリのタスクでは、これは 1 つのキャッシュされたコンテキストに対して支払うか、ディレクトリを切り替えるたびに支払い直すかの違いになります。

## 知っておく価値のある 3 つ目のつまみ

同じリリースは `disableBundledSkills` (および `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`) を追加します。これは Claude Code 同梱の skills、workflows、組み込みのスラッシュコマンドをモデルから隠します。自分なりに方針の定まったセットを持っていて、同梱のものが邪魔になっているなら、それがオフスイッチです。

これは [v2.1.128 のプラグインと worktree の修正](/ja/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/) が始めたパターンを引き継ぐものです。日々のループから一群の小さな引っかかりを取り除く、地味な CLI の変更です。詳細は [v2.1.169 のリリースページ](https://github.com/anthropics/claude-code/releases/tag/v2.1.169) にあります。
