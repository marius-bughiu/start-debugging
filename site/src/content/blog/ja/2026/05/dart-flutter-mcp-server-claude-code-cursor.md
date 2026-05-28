---
title: "Dart と Flutter の MCP サーバー: 実行中の Flutter アプリを Claude Code に渡すコマンド一発"
description: "Dart 3.12 には公式の MCP ブリッジである dart mcp-server が同梱されています。Claude Code、Cursor、Codex CLI に一度登録するだけで、エージェントは DTD URI をコピーすることなく、ホットリロード、pub.dev 検索、ライブのウィジェット内省を扱えるようになります。"
pubDate: 2026-05-28
tags:
  - "dart"
  - "flutter"
  - "mcp"
  - "claude-code"
  - "ai-agents"
lang: "ja"
translationOf: "2026/05/dart-flutter-mcp-server-claude-code-cursor"
translatedBy: "claude"
translationDate: 2026-05-28
---

Google I/O 2026 (5 月 19 日と 20 日) で、Dart チームは Dart 3.12 を発表しました。同時に、より地味でありながら日々の作業に効く公式の `dart mcp-server` も登場しました。Dart 3.9 以降の SDK に同梱されており、MCP 対応の任意のコーディングエージェント (Claude Code、Cursor、Gemini CLI、Codex CLI、VS Code 上の GitHub Copilot) から、Dart Tooling Daemon の URI を毎回コピー＆ペーストすることなく、実行中の Flutter アプリを操作できるようになります。[公式ドキュメント](https://docs.flutter.dev/ai/mcp-server) ではステータスはまだ "experimental" ですが、インストール手順はクライアント間で安定しており、今すぐ接続しておく価値があります。

これが取り除く摩擦は本物です。これまでエージェントに「ウィジェットツリーのこの赤いテキストを直して」と頼むには、アプリを実行し、DevTools を開き、DTD 接続 URI をコピーし、ツールのプロンプトに貼り付け、エージェントが次のターンで失わないことを祈る必要がありました。今では MCP サーバーが DTD を自動で発見し、エージェントはただ `hot_reload` を呼び出すだけです。

## サーバーが実際に公開するもの

Dart と Flutter の MCP サーバーのドキュメントによると、ツールは 4 つのバケットに分かれます。

- **プロジェクト**: analysis server を介したエラーの解析と修正、シンボルの解決、パッケージドキュメントの取得、pub.dev の検索、`pubspec.yaml` の編集、`dart format` でのフォーマット。
- **テスト**: tests の実行、失敗の解析、スタックトレースをエージェントのコンテキストへ取り込み。
- **ランタイム**: DTD 経由で実行中のアプリに接続し、ウィジェット一覧の取得、状態のインスペクション、レンダリングツリーのスクリーンショット取得。
- **ホットリロード**: エージェントの編集後に自動でトリガーされ、手動操作は不要です。

すべてのツールは Dart を理解した結果を返します。`analyze_files` はコンパイラ出力に対する正規表現ではなく、analysis server と同じ診断を返します。`pub_search` は Web サイトと同じスコアリングで pub.dev に問い合わせます。`get_runtime_errors` は実行中のアプリからライブの例外を取得し、例外を投げたウィジェットの情報も含めます。

## Claude Code に接続する

Flutter プロジェクトのルートから、コマンドは 1 つだけです。

```bash
claude mcp add --transport stdio dart -- dart mcp-server
```

これで、現在の Claude Code ワークスペースに `dart` が stdio MCP サーバーとして登録されます。サーバーはワークスペースルートからアクティブな DTD を発見するので、別のターミナルで `flutter run` が動いている限り、`hot_reload` と `take_screenshot` は自動的に利用可能になります。

Cursor では、以下を `.cursor/mcp.json` に追加します。

```json
{
  "mcpServers": {
    "dart": {
      "command": "dart",
      "args": ["mcp-server"]
    }
  }
}
```

Codex CLI では、SDK の一部のシェルで roots 検出にギャップが残っているので、fallback フラグを渡します。

```bash
codex mcp add dart -- dart mcp-server --force-roots-fallback
```

VS Code の Copilot ユーザーは何も必要ありません。設定で `dart.mcpServer: true` (Dart Code v3.116 以降) にすれば、拡張機能が同じバイナリを自動で接続します。

## 知っておくべき落とし穴

MCP サーバーは Dart SDK ごとに動作します。複数の Flutter チャネルをインストールしていて、プロジェクトが `stable` なのにエージェントが `master` を拾った場合、ツール呼び出し自体は成功しますが、別の analysis server と会話することになり、問題なくコンパイルできるコードに対して「シンボルが見つかりません」という紛らわしい応答が返ってきます。複数チャネル環境ではバイナリを明示的に固定してください。

```bash
claude mcp add --transport stdio dart -- /path/to/flutter/bin/dart mcp-server
```

もう 1 つの落とし穴: サーバーはワークスペースルートが 1 つであることを前提とします。melos モノレポを開いてエージェントをパッケージ間で動かしても、ホットリロードは `flutter run` で起動したアプリだけを対象にします。サーバーに推測させずクライアントが通知した roots を使わせるには `--force-roots-fallback` を渡してください。

リリース全体の changelog は、以前の記事 [Dart 3.12 のプライベート名前付きパラメーターと初期化フォーマル](/ja/2026/05/dart-3-12-private-named-parameters-initializing-formals/) を参照してください。MCP サーバーは今回のリリースで最も静かなピースですが、おそらく日々のループを最も大きく変える要素です。
