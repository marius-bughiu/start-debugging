---
title: "Cursor 3.9 はエージェントの設定をポータブルなプラグインにまとめます"
description: "Cursor 3.9 はプラグインシステムと統合された Customize ページを導入し、skills、ルール、MCP サーバー、コマンド、hooks が 1 つのバージョン管理された単位としてまとめて移動できるようにします。"
pubDate: 2026-06-24
tags:
  - "cursor"
  - "ai-agents"
  - "mcp"
lang: "ja"
translationOf: "2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks"
translatedBy: "claude"
translationDate: 2026-06-24
---

Cursor 3.9 は 2026 年 6 月 22 日にリリースされましたが、目玉はモデルの入れ替えでも apply の高速化でもありません。配管にあたる部分です。本物のプラグイン形式に加えて、プラグイン、skills、MCP、サブエージェント、ルール、コマンド、hooks を 1 つの画面に集約する単一の Customize ページが導入され、ユーザー、チーム、または workspace の単位で管理できます。

チーム向けに Cursor のエージェントをセットアップしたことがあれば、これがなぜ重要か分かるはずです。エージェントをコードベースで役立たせる部品は、これまで別々の場所に存在していました。ルールは `.mdc` ファイルに、MCP サーバーは独自の設定に、コマンドは別の場所に、hooks は後付けで取り付けられていました。同僚を加えるには、そのすべてを手作業で複製する必要がありました。プラグインは、その一式を 1 つのバージョン管理された共有可能なアーティファクトに変えます。

## プラグインとは実際に何か

プラグインとは、`.cursor-plugin/plugin.json` にマニフェストを持つディレクトリです。それ以外はすべて慣例です。

```
my-stack/
├── .cursor-plugin/
│   └── plugin.json     # manifest
├── skills/             # subdirs with SKILL.md
├── rules/              # .mdc rule files
├── commands/           # slash commands
├── hooks/hooks.json
└── mcp.json            # MCP server definitions
```

マニフェストが必須とするのは `name`（小文字の kebab-case）だけです。各コンポーネントのパスは任意で、省略すると Cursor は上記の既定フォルダーを自動的に検出します。

```json
{
  "name": "enterprise-plugin",
  "version": "1.2.0",
  "description": "Security scanning and compliance checks",
  "author": { "name": "ACME DevTools", "email": "devtools@acme.com" },
  "keywords": ["enterprise", "security", "compliance"],
  "rules": "rules/",
  "skills": "skills/",
  "commands": "commands/",
  "hooks": "hooks/hooks.json",
  "mcpServers": "mcp.json"
}
```

MCP サーバーは Cursor や Claude Desktop ですでに使われているのと同じ形式を用いるため、既存の設定はそのまま組み込めます。

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_CONNECTION_STRING": "${POSTGRES_URL}" }
    }
  }
}
```

hooks もこのパッケージに入ります。プラグインは、編集のたびにフォーマットを実行させたり、危険なシェル呼び出しをゲートしたりできます。誰もローカル設定を編集する必要はありません。

```json
{
  "hooks": {
    "afterFileEdit": [{ "command": "./scripts/format-code.sh" }],
    "beforeShellExecution": [
      { "command": "./scripts/validate-shell.sh", "matcher": "rm|curl|wget" }
    ]
  }
}
```

## 配布こそが本当の機能

Customize ページには、チームで最もよく使われているプラグイン、skills、MCP のリーダーボードが表示され、そのいずれもワンクリックでインストールできます。チームマーケットプレイスは、GitHub だけでなく GitLab、BitBucket、Azure DevOps からもプラグインリポジトリをインポートできるようになり、社内レジストリがベンダーの選択を強いることはなくなりました。プラグインは事前構築された canvases も持てます。これは同僚が開いて再利用できる共有セットアップテンプレートで、Hex と Atlassian の canvases が最初の例です。

このパターンは、Claude Code とより広いエージェントツールが向かう先を反映しています。再利用の単位は単一のルールファイルではなくなり、チームがエージェントにどう振る舞ってほしいかをコード化したポータブルなパッケージになります。MCP ブロックや `.mdc` ルールをマシン間でコピー＆ペーストしてきたなら、それらをプラグインに固定して、もうやめましょう。

すべてのフィールド一覧は[プラグインリファレンス](https://cursor.com/docs/reference/plugins)と [3.9 の changelog](https://cursor.com/changelog) を参照してください。
