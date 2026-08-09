---
title: "MCP の許可リストが Copilot のエンタープライズ管理設定に登場"
description: "2026年8月6日の GitHub changelog により、copilot/managed-settings.json に allowedMcpServers と deniedMcpServers が追加されました。URL と argv によるマッチャー、拒否優先の判定、そして名前ベースのレジストリには無かった fail closed の既定動作について解説します。"
pubDate: 2026-08-09
tags:
  - "github-copilot"
  - "mcp"
  - "ai-agents"
  - "security"
lang: "ja"
translationOf: "2026/08/copilot-mcp-allowlists-enterprise-managed-settings"
translatedBy: "claude"
translationDate: 2026-08-09
---

2026-08-06 に GitHub が [MCP allowlists in enterprise managed settings](https://github.blog/changelog/2026-08-06-mcp-allowlists-in-enterprise-managed-settings/) をリリースしました。`allowedMcpServers` と `deniedMcpServers` という 2 つのキーが、Copilot クライアントの起動を許可する Model Context Protocol サーバーを決めるようになります。一般提供であり、GitHub Copilot アプリ、Copilot CLI、VS Code に適用されます。

これは MCP のサポートが広く行き渡って以来ずっと開いたままだった穴をふさぐものです。従来のエンタープライズ側の答えは、今もパブリックプレビューである[カスタム MCP レジストリ](https://docs.github.com/en/copilot/concepts/mcp-management)で、サーバーを名前か ID で識別していました。名前はユーザーが付けるラベルなので、ブロックされたサーバーを使いたい開発者は手元で名前を変えるだけで済みます。GitHub 自身のドキュメントもその帰結をはっきり書いています。ユーザーは設定ファイルを編集することで制限を回避できる、というものです。

## マッチャーがすべて

このファイルはエンタープライズの `.github-private` リポジトリの `copilot/managed-settings.json` に、既定ブランチ上で置かれます。各エントリはちょうど 1 つのマッチャーでサーバーを識別します。

```json
{
  "allowedMcpServers": [
    { "serverUrl": "https://api.githubcopilot.com/*" },
    { "serverCommand": ["npx", "@playwright/mcp@latest"] },
    { "serverCommand": ["cmd", "/c", "uvx", "markitdown-mcp"] }
  ],
  "deniedMcpServers": [
    { "serverUrl": "https://learn.microsoft.com/*" }
  ]
}
```

注意したいのは、`serverCommand` がシェル文字列ではなく argv 配列であり、完全一致で照合される点です。`serverUrl` は `*` のワイルドカードに対応し、比較前に URL が正規化されるため、エンコードや末尾スラッシュの小細工で判定を変えることはできません。`serverName` も依然として存在しますが、あくまでフォールバックです。リモートサーバーでは一致は `serverUrl` エントリから来る必要があり、`serverName` が効くのは `serverUrl` エントリがひとつも無い場合だけです。stdio サーバーと `serverCommand` の関係も同じです。これは利便性のための仕組みであって、セキュリティ境界ではありません。

## 既定値は fail closed

チームがつまずくのは、空と未設定の違いです。

- `allowedMcpServers` が未設定なら、既定以外のすべてのサーバーが許可されます。
- `allowedMcpServers: []` はそれらをすべてブロックします。これが全面拒否のスイッチです。
- `deniedMcpServers` が未設定または空なら、何もブロックしません。
- 拒否が常に勝ちます。両方のリストに一致するサーバーはブロックされます。
- 組み込みの GitHub MCP サーバーのようなファーストパーティのサーバーは、どちらのリストからも除外されます。

さらに、不正な形式または検証できない設定は、許可されるのではなくブロックされます。ポリシーが複数のレイヤーから来る場合、サーバーはすべてのレイヤーを通過しなければなりません。これはレジストリとは逆の失敗モードであり、移行すべき本当の理由です。

独自のリストが必要なチームは、エンタープライズレベルでマッチャーオブジェクトを `overridable` の下にまとめ、各チームのファイルでは通常の構文を使います。両者が衝突した場合はプラットフォーム側の決定が優先されます。

## 送信制御の代わりではなく、組み合わせて使う

許可リストが制御するのは、どのサーバープロセスが起動し、どの MCP エンドポイントと通信するかです。ツールが起動した後にどこへ接続するかについては何も言いません。そちらは別の制御面であり、[コーディングエージェントのネットワーク送信を絞り込む方法](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/)で扱っています。レイヤーは 2 つ、失敗モードも 2 つです。

マッチャーの完全な構文は [Enterprise managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-managed-settings-reference) にあります。
