---
title: ".NET モダナイゼーションエージェントが Visual Studio だけでなく Copilot CLI でも動くようになりました"
description: "GitHub Copilot の modernize-dotnet エージェントが 2026-07-09 に移植可能なプラグインとしてリリースされました。VS Code、Copilot CLI、そして GitHub で動作し、評価・計画・実行というフローの成果物がレビュー用にリポジトリへコミットされます。"
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
lang: "ja"
translationOf: "2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin"
translatedBy: "claude"
translationDate: 2026-07-10
---

昨年のほとんどの期間、GitHub Copilot の .NET モダナイゼーションツールには居場所が 1 つしかありませんでした。Visual Studio です。チームが VS Code で作業していたり、コマンドラインで作業していたり、すべてを pull request でレビューしていたりする場合、「レガシーアプリをアップグレードする」という体験は、あなたが作業していない場所にありました。2026-07-09、Microsoft は [`modernize-dotnet` エージェントを移植可能なプラグインとしてリリースしました](https://devblogs.microsoft.com/dotnet/modernize-dotnet-anywhere-with-ghcp/)。これは Visual Studio、VS Code、GitHub Copilot CLI、そして GitHub 自体という 4 つの面で動作します。

## なぜここで「どこでも」が本当に重要なのか

モダナイゼーションは 1 ステップのコマンドではありません。評価し、計画し、その後あなたが見守る長い一連のコード変換です。それを単一の IDE に押し込めると、アップグレードを進める人は、しばしば数日がかりの作業のために、慣れた環境の外へコンテキストを切り替えなければなりませんでした。同じエージェントを CLI に移すことで、ターミナル中心の開発者はビルドとテストのループの隣でそれを実行でき、GitHub に載せることで、アップグレードは 1 人のローカルセッションではなく、レビュー可能で共同作業的な作業単位として行えるようになります。

ワークフローはどこでも同じであり、それが要点です。エージェントは評価・計画・実行というモデルに従い、リポジトリに 3 つの成果物を書き込みます。

1. コード変更の前にスコープとブロッカーを明らかにする**評価**。
2. 作業を順序付ける**アップグレード計画**。
3. 実際の変換を適用する**アップグレードタスク**。

これらの成果物はリポジトリにコミットされるため、チームは実行がコードの 1 行に触れる前に、PR をレビューするのと同じ方法で計画をレビューします。

## Copilot CLI から実行する

CLI 経路ではエージェントをプラグインとしてインストールし、その後自然言語で操作します。コマンドは短いです。

```bash
# Add the plugin marketplace and install the agent
/plugin marketplace add dotnet/modernize-dotnet
/plugin install modernize-dotnet@modernize-dotnet-plugins

# Select the agent, then describe the job
/agent modernize-dotnet
upgrade my solution to a new version of .NET
```

そこからエージェントは評価を生成し、計画を提案し、各ステップで人間が承認する形でタスクを適用します。アップグレードの地味な部分を引き受けます。target framework の引き上げ、依存関係の更新、そして `TargetFramework` の変更が残すコンパイルエラーの修正です。

## 現在カバーしている範囲

サポートされるワークロードには ASP.NET Core、Blazor、Azure Functions、WPF、クラスライブラリ、コンソールアプリケーション、そして .NET Framework からモダンな .NET への移行が含まれます。Web Forms はまだ範囲に入っていません。以前 Visual Studio 専用版を試して、チームのワークフローに組み込みにくいと感じたなら、これは機能ではなく配信モデルを修正するリリースです。

エージェントは [dotnet/modernize-dotnet](https://github.com/microsoft/github-copilot-appmod) でオープンに開発されており、4 つの面への展開はすでに利用可能です。興味深い変化は、Copilot が .NET コードをアップグレードできることではなく、アップグレードが単一のエディタ内のブラックボックスではなく、あなたがレビューするリポジトリの成果物になったことです。
