---
title: "Claude Code 2.1.128 は .zip アーカイブからプラグインを読み込み、未プッシュのコミットを失わなくなりました"
description: "Claude Code v2.1.128 (2026 年 5 月 4 日) は --plugin-dir で .zip アーカイブをサポートし、EnterWorktree がローカル HEAD からブランチを作成するようにし、CLI が自身の OTLP エンドポイントを Bash サブプロセスに漏らさないようにします。"
pubDate: 2026-05-05
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "ja"
translationOf: "2026/05/claude-code-2-1-128-plugin-zip-worktree-fix"
translatedBy: "claude"
translationDate: 2026-05-05
---

Claude Code v2.1.128 は 2026 年 5 月 4 日にリリースされ、多くの人が気付かないまま遭遇していたワークフローの問題を静かに修正する 3 つの変更が入りました。プラグインを `.zip` から直接読み込めるようになり、`EnterWorktree` がついに `origin/<default>` ではなくローカルの `HEAD` からブランチを作成するようになり、サブプロセスが CLI 自身の `OTEL_*` 環境変数を継承しなくなりました。どれも派手ではありませんが、いずれも「あれ、なんで今そうなったんだ?」という一連のサポートスレッドを取り除きます。

## `--plugin-dir` が zip 化されたプラグインアーカイブを受け付けるようになりました

v2.1.128 までは、`--plugin-dir` はディレクトリしか受け付けませんでした。社内プラグインを同僚と共有したり、バージョンを固定したりしたい場合は、マーケットプレイスにプッシュするか、展開済みのツリーをリポジトリにコミットするか、起動前に展開するラッパーのスクリプトを書くかでした。どれもプラグインが 1 つか 2 つを超えると現実的ではありません。

新しい挙動は期待どおりです。

```bash
# Old: had to point at an unpacked directory
claude --plugin-dir ./plugins/my-team-tooling

# New in v2.1.128: zip works directly
claude --plugin-dir ./plugins/my-team-tooling-1.4.0.zip

# Mix and match in the same launch
claude \
  --plugin-dir ./plugins/local-dev \
  --plugin-dir ./dist/release-bundle.zip
```

このリリースには対になる修正もあります。`/plugin` Components パネルは以前、`--plugin-dir` で読み込まれたプラグインに対して "Marketplace 'inline' not found" を表示していました。v2.1.128 でそれは止まります。さらに、headless モードの `init.plugin_errors` JSON は、既存の依存関係降格エラーに加えて `--plugin-dir` の読み込み失敗 (壊れた zip、欠落したマニフェスト) も報告するようになり、CI スクリプトは壊れたプラグインセットを静かに送り出す代わりに大きな音を立てて失敗できるようになりました。

## `EnterWorktree` はもう未プッシュのコミットを失いません

これは挙動変更の体裁をまとった本物のバグ修正です。`EnterWorktree` は、Claude Code が agent タスク用に隔離された worktree を立ち上げるためのツールです。このリリース以前は、新しいブランチは `origin/<default-branch>` から作成されていました。妥当に聞こえますが、その意味を理解すると別の話になります。`main` にローカルにあってまだプッシュしていないコミットは、agent が見る worktree に入っていなかったのです。

v2.1.128 では、`EnterWorktree` はローカルの `HEAD` からブランチを作成します。ドキュメントが既に主張していたとおりの動きです。具体的には次のとおりです。

```bash
# You're on main with a local-only commit
git log --oneline -2
# a1b2c3d feat: WIP rate limiter (NOT pushed)
# 9876543 chore: bump deps (origin/main)

# Agent calls EnterWorktree
# v2.1.126 and earlier: branch starts at 9876543, your WIP commit is GONE
# v2.1.128: branch starts at a1b2c3d, the agent sees your WIP
```

長時間動作する agent タスクが 5 分前に行った変更を静かにスキップしたことがあるなら、おそらくこれが原因です。

## OTEL 環境変数がサブプロセスに漏れなくなりました

Claude Code 自身は OpenTelemetry でインストルメントされており、環境から `OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME` などを読み取ります。v2.1.128 までは、これらの変数は CLI が起動する各サブプロセスに継承されていました。Bash ツールの呼び出し、hooks、MCP サーバー、LSP プロセスです。Bash ツール経由で OTel インストルメント済みの .NET アプリを実行すると、そのアプリは喜んで自分のトレースを CLI のコレクターに送っていました。

v2.1.128 の修正は、exec の前に環境から `OTEL_*` を取り除きます。アプリは設定された OTLP エンドポイントを使うようになり、エディターがたまたま報告している先ではなくなります。子プロセスに本当に CLI のコレクターを共有させたい場合は、実行スクリプトで明示的に変数を設定してください。

その他の注目点をいくつか。引数なしの `/color` はランダムなセッション色を選ぶようになり、`/mcp` はサーバーごとのツール数を表示し、ツール 0 で接続したサーバーには印を付け、並列の shell ツール呼び出しは読み取り専用コマンド (`grep`、`git diff`) が失敗しても兄弟の呼び出しを取り消さなくなり、サブ agent の進捗サマリーがついにプロンプトキャッシュにヒットして、忙しいマルチエージェント実行で `cache_creation` コストがおよそ 3 倍下がります。Vim モードにも小さいが正しい修正が入りました。NORMAL モードで `Space` がカーソルを右に動かすようになり、本物の vi の挙動に揃いました。

これは、[v2.1.126 の project purge リリース](/ja/2026/05/claude-code-2-1-126-project-purge/)が始めたトレンドの継続です。ユーザーの手から鈍器を取り上げる、小さく的を絞った CLI の変更です。完全なノートは [v2.1.128 のリリースページ](https://github.com/anthropics/claude-code/releases/tag/v2.1.128) にあります。
