---
title: "Claude Code 2.1.259 が managedMcpServers を追加: MDM なしで MCP サーバーを配布する"
description: "これまで全開発者に同じ MCP サーバーを配る唯一の方法は、システムパスに置く managed-mcp.json でした。このファイルは MCP を排他的に制御してしまいます。Claude Code 2.1.259 は HTTP と SSE サーバー向けの managedMcpServers 設定を追加し、同時に allowedMcpServers の適用範囲を狭めました。"
pubDate: 2026-09-03
tags:
  - "claude-code"
  - "mcp"
  - "ai-agents"
  - "security"
lang: "ja"
translationOf: "2026/09/claude-code-2-1-259-managed-mcp-servers-without-mdm"
translatedBy: "claude"
translationDate: 2026-09-03
---

Claude Code 2.1.259 が 2026-09-02 にリリースされ、管理者が数か月にわたって回避策で凌いできた問題を解決する 1 行の変更履歴が含まれていました。組織がすべてのユーザーに HTTP および SSE の MCP サーバーを提供できる、`managedMcpServers` という管理設定です。同じリリースで `allowedMcpServers` も変更され、ユーザー自身が追加したサーバーだけを対象とするようになりました。この 2 行は合わせて MCP のガバナンスを組み替えるものであり、2 つ目は現在いくつかのチームが頼っている安全網を取り除きます。

## 「全員に Sentry を配る」用途に managed-mcp.json が不向きだった理由

2.1.259 より前には仕組みが 2 つありましたが、どちらも配布には向いていませんでした。許可リストはフィルタリングであってデプロイではありません。[managed MCP のドキュメント](https://code.claude.com/docs/en/managed-mcp)は、`allowedMcpServers` と `deniedMcpServers` は「レジストリではない」こと、そしてどちらのリストが適用されるにも、まずユーザー、プラグイン、または `managed-mcp.json` によってサーバーが追加されている必要があることを明示しています。

残るのは `managed-mcp.json` です。こちらは実際にサーバーを配布できますが、2 つの重い条件が付きます。システムパスに置く独立したファイルなので、Jamf、Intune、Group Policy など、そのマシンで管理者権限を持つ手段が必要です。

```json
{
  "mcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

これをデプロイすると、Claude Code はこのファイルが定義したものだけを読み込みます。プラグイン由来のサーバーは読み込まれなくなります。`--mcp-config` で渡したサーバーは拒否されます。`allowAllClaudeAiMcps` を併せて設定しない限り、claude.ai のコネクタも抑制されます。これは配布もできてしまうロックダウンの仕組みであって、配布のための仕組みではありません。さらに[サーバー管理設定のドキュメント](https://code.claude.com/docs/en/server-managed-settings)によれば、このファイルは「サーバー管理設定では配布できない」ため、MDM を持たない組織には手段がまったくありませんでした。

`managedMcpServers` は独立したファイルではなく設定キーです。つまり、claude.ai の管理コンソールを含む通常の管理設定チャネルに乗ります。

```json
{
  "managedMcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

HTTP と SSE に限定した点が設計として興味深いところです。stdio のエントリであれば、サーバーからネットワーク越しに配られた argv 配列を各開発マシンで実行することになります。キーをリモートトランスポートに限定することで、設定のペイロードがリモートコード実行に変わることを防いでいます。

## 許可リストは安全網ではなくなった

変更履歴の 2 行目は、見た目以上に重要です。現在のドキュメントにはまだ、`allowedMcpServers` と `deniedMcpServers` は「管理対象サーバーにも適用されるため、通過しない管理対象サーバーは読み込まれない」と書かれています。2.1.259 では、許可リストはユーザーが追加したサーバーだけを対象とします。管理者が配ったサーバーはすでに管理者の判断なので、管理者自身の許可リストで再チェックするのは冗長でした。とはいえ、読み込まれるものすべてに対する二重チェックとして厳密な `serverUrl` の許可リストを書いていたのであれば、それはもう管理対象のセットをカバーしません。拒否リストは変更されておらず、引き続きすべてのスコープからマージされます。残すべきレバーはこちらです。

設定リファレンスはまだ新しいキーに追いついていないため、全社的に展開する前に 1 台で `claude mcp list` を実行してエントリの形を確認してください。フィルタリング側をこれから整えるのであれば、[チームが実行できる MCP サーバーを一元的に制御する方法](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/)で、最初の展開でつまずきがちなマッチャーの優先順位を扱っています。

詳細は [Claude Code の変更履歴](https://code.claude.com/docs/en/changelog)を参照してください。
