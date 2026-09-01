---
title: "VS Code 1.135 が /rubber-duck を搭載、あえて別のモデルを使います"
description: "VS Code 1.135 の実験的な /rubber-duck コマンドは、エージェントのプラン、コード、テストを別ファミリーのモデルにレビューさせます。GPT-5.4 が Claude を批評するという、ファミリーをまたぐ選択そのものが要点です。"
pubDate: 2026-09-01
tags:
  - "ai-agents"
  - "github-copilot"
  - "llm"
  - "claude-code"
lang: "ja"
translationOf: "2026/09/vscode-1-135-rubber-duck-cross-model-review"
translatedBy: "claude"
translationDate: 2026-09-01
---

VS Code 1.135 は 2026-08-26 にリリースされ、GitHub は 2026-08-31 の changelog "GitHub Copilot in VS Code, August 2026 releases" にこれをまとめました。セッションのレイアウト関連の変更に埋もれていますが、このリリースで最も興味深いのは、別ファミリーのモデルからエージェントの作業についてセカンドオピニオンを得る実験的な `/rubber-duck` コマンドです。

## 自己レビューでは、モデルがすでに見落としたものは見つかりません

モデル自身に出力を点検させるのはほぼコストゼロなので、ほとんどのエージェント harness がそうしています。同時にそれは弱い手でもあります。プランを生成したのと同じ重みがレビューも生成するため、盲点は相関します。コードを書くときに同時書き込みのケースを考えなかったモデルは、コードをレビューするときにもそれを考えません。

Rubber Duck は逆に賭けます。オーケストレーターはモデルピッカーで選んだ Claude ファミリーの任意のモデルで、レビュアーは GPT-5.4 です。相補的なモデルを選ぶ戦略は偶然ではなく明示的なものです。レビュアーは主モデルとは別のファミリーから選ばれるため、Claude のセッションには GPT の批評役が付き、GPT のセッションにはその逆が付きます。GitHub はこれが実験であることを率直に認めており、「オーケストレーターと Rubber Duck の双方について他のモデルファミリーを検討している」と述べています。

## 読み取り専用の批評役と、仕分けされた出力

Rubber Duck は編集できません。プラン、diff、テストを読み、実質的な問題、つまりロジックの誤り、設計上の欠陥、セキュリティホール、不足しているテストカバレッジを探します。返ってくる内容は、そのまま羅列されるのではなく仕分けされています。

```text
> /rubber-duck

Blocking
  - RefreshTokenAsync writes the new token before the old one is revoked.
    A crash between the two leaves both valid.

Non-blocking
  - The retry loop has no jitter. Three clients failing together will
    stay in lockstep.

Suggestions
  - No test covers an expired token with a valid signature.
```

ブロッキング、非ブロッキング、提案という三分割は、自前のレビュー用サブエージェントを作るなら真似する価値のある部分です。順位のない 12 件の指摘は流し読みされますが、3 件のブロッキング項目は読まれます。

## 自動で、しかし控えめに発火します

手動で呼び出すこともできますが、Copilot は効果が最も高い 4 つの場面でも自動的に呼び出します。プランを作成した後、複雑な実装の後、テストを書いた後で実行する前、そしてエージェントがループに陥ったときです。最後のトリガーが最も元を取ります。ループしているエージェントは、主モデルが自分の出力について打つ手をなくしたという最も明確なサインだからです。

内部的には Copilot に元からある task tool を経由して動き、他のサブエージェントと同じ仕組みを使います。つまり無料ではありません。自動呼び出しのたびに、主エージェントのトークンに加えて、premium 消費に対する完全なモデルターンが 1 回発生します。VS Code 1.135 ではチャット応答のフッターにモデル別のトークン集計も追加されており、アヒルのコストはそこで確認できます。

## 有効化の方法

VS Code では、`/rubber-duck` は Copilot の agent host セッション内で機能します。これは harness を Agent Host Protocol 上の専用プロセスで実行するモードです。agent host セッションをまだ有効にしていない場合、それは [VS Code 1.128 で複数チャットの Claude agent-host セッションを実現した](/ja/2026/07/vscode-1-128-multi-chat-claude-agent-host-sessions/)のと同じ機能群です。GitHub Copilot CLI では `/experimental` スラッシュコマンドで解放します。

利用条件があります。メインセッションが Claude か GPT のモデルで動いていること、そして適切な相補モデルが利用可能であることです。どちらかが満たされない場合、コマンドはそもそも表示されません。

詳細は [VS Code 1.135 のリリースノート](https://code.visualstudio.com/updates/v1_135) と、[セカンドオピニオンのためにモデルファミリーを組み合わせる](https://github.blog/ai-and-ml/github-copilot/github-copilot-cli-combines-model-families-for-a-second-opinion/)という GitHub の記事にあります。
