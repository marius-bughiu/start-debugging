---
title: "GitHub Copilot Chat の BYOK が VS Code で GA: Anthropic、Ollama、Foundry Local"
description: "GitHub Copilot for VS Code は 2026 年 4 月 22 日に Bring Your Own Key を出荷しました。Anthropic、OpenAI、Gemini、OpenRouter、Azure のアカウントを Chat に接続するか、Ollama または Foundry Local 経由でローカルモデルを指定できます。請求は Copilot のクォータをスキップして直接プロバイダーに行きます。"
pubDate: 2026-04-26
tags:
  - "github-copilot"
  - "vscode"
  - "ai-agents"
  - "ollama"
lang: "ja"
translationOf: "2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local"
translatedBy: "claude"
translationDate: 2026-04-26
---

[GitHub は 2026 年 4 月 22 日に VS Code 向け Copilot Chat の BYOK を GA として出荷しました](https://github.blog/changelog/2026-04-22-bring-your-own-language-model-key-in-vs-code-now-available/)。要点は次のとおりです。Copilot Chat の UI に自分の Anthropic、OpenAI、Gemini、OpenRouter、Azure キーを差し込み、Copilot のクォータを消費する代わりにプロバイダー側で課金するようにできます。ローカルモデルも動作し、Ollama または Foundry Local 経由で利用できます。この機能は Copilot Business および Enterprise で GA となり、Chat、plan agents、custom agents をカバーしますが、インライン補完はカバーしません。

## なぜこれが Copilot の価格計算を変えるのか

このリリースまで、Copilot Chat は Microsoft がホストするモデルプール上で動き、各リクエストはシートの月次割り当てから差し引かれていました。そのため、安価で速いモデルでエージェントの探索的な作業をしたり、組織がすでに契約しているフロンティアモデルを使うのが面倒でした。BYOK によって、組織の既存の Anthropic や Azure OpenAI の請求がコストを吸収し、Copilot シートは本来得意とする領域、つまり code completions のために残ります。code completions は引き続き GitHub ホスト型モデルで動きます。リリースノートより: "BYOK does not apply to code completions" および "usage doesn't consume GitHub Copilot quota allocations."

もう一つの解放はローカルです。これまで、エアギャップ環境の Ollama インスタンスや開発者ノート PC 上の Foundry Local に対して Copilot Chat を動かすのは研究プロジェクトでした。今やこの機能はファーストクラスです。

## プロバイダーの接続

Chat ビューを開き、モデルピッカーをクリックして **Manage Models** を実行します (もしくは Command Palette から `Chat: Manage Language Models` を呼び出します)。VS Code が Language Models エディターを開き、そこでプロバイダーを選び、キーを貼り付け、モデルを選択します。モデルは即座にチャットのピッカーに現れます。

組み込みリストにない OpenAI 互換のエンドポイント (LiteLLM ゲートウェイ、オンプレミスの推論プロキシ、カスタム URL の背後にある Azure OpenAI デプロイメントなど) では、`settings.json` の等価なエントリは次のようになります。

```jsonc
{
  "github.copilot.chat.customOAIModels": {
    "claude-sonnet-4-6-via-litellm": {
      "name": "claude-sonnet-4-6",
      "url": "https://gateway.internal/v1/chat/completions",
      "toolCalling": true,
      "vision": false,
      "thinking": false,
      "maxInputTokens": 200000,
      "maxOutputTokens": 16384
    }
  },
  "inlineChat.defaultModel": "claude-sonnet-4-6-via-litellm"
}
```

キー自体はセキュアストアに保存され、`settings.json` には保存されません。この設定はモデルの形を記述するだけで、ピッカーで有効化すべき機能 (tool calling、vision、extended thinking) を VS Code に伝えます。

Ollama では、プロバイダーを `http://localhost:11434` と `qwen2.5-coder:14b` や `phi-4:14b` のようなタグに向けます。Foundry Local では、`foundry service start` が動いていれば OpenAI 互換のエンドポイントは既定で `http://localhost:5273/v1` になります。

## .NET ショップのツーリングへの意味

すでに Copilot に標準化しているチームへの実用的な追記が 2 点あります。

1. `github.copilot.chat.customOAIModels` 設定は `settings.json` のユーザー単位ですが、通常の VS Code 設定です。リポジトリの `.vscode/settings.json` テンプレートや [Dev Container](https://code.visualstudio.com/docs/devcontainers/containers) イメージに同梱できます。つまり `dotnet new` template でチーム全体の既定モデルを事前に配線できます。
2. 組織管理者は github.com の Copilot policy settings から BYOK を無効化できます。コンプライアンス上、すべてのトラフィックを GitHub ホスト型モデルにとどめる必要があるならこれを利用します。規制対象ワークロードでオフにする必要がある場合、ロールアウトがシートに到達する前に切り替えてください。Business および Enterprise テナントでは既定でポリシーが自動的に有効になります。

GitHub ホスト型課金にチーム全体をコミットせずに [Visual Studio 2026 の Copilot agent skills](/ja/2026/04/visual-studio-2026-copilot-agent-skills/) を試したいと様子見していたなら、これがその解放です。同じエージェントサーフェス、自分の請求、自分のモデルです。
