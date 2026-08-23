---
title: "Claude Code 2.1.238 でプラグインマーケットプレイスが自前の認証ヘッダーを発行できるようになりました"
description: "url マーケットプレイスとカタログエントリに追加された headersHelper は、HTTP ヘッダーを出力するローカルコマンドを実行します。これにより S3 やアーティファクトリポジトリの背後にある社内プラグインカタログを短命トークンで認証できます。スキーマ、同意プロンプト、Claude Code が破棄するヘッダー名を解説します。"
pubDate: 2026-08-23
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
  - "security"
lang: "ja"
translationOf: "2026/08/claude-code-2-1-238-marketplaces-mint-their-own-auth-headers"
translatedBy: "claude"
translationDate: 2026-08-23
---

社内向けの Claude Code プラグインを配布するには、クライアントがすでに認証できる git リポジトリをホストする必要がありました。2026-08-20 に npm へ公開された Claude Code 2.1.238 は、この制約を取り除きます。マーケットプレイスが HTTP ヘッダーを出力するローカルコマンドを実行できるようになり、そのヘッダーはカタログの取得とプラグインのダウンロードに付与されます。スキーマは Windows 版 2.1.239 のビルド (commit `9bf8e95`、ビルド日 2026-08-21) で確認しました。ここで初めて `headersHelper` がマーケットプレイスとカタログのスキーマに現れます。2.1.224 では、このフィールドは MCP サーバー定義にしか存在しませんでした。

## 1 つのコマンド、1 つのヘッダー JSON オブジェクト

このフィールドは、ソースが `url` のマーケットプレイスに、従来からある静的な `headers` マップと並んで置かれます。

```json
{
  "source": {
    "source": "url",
    "url": "https://artifacts.internal/claude/marketplace.json",
    "headersHelper": "/usr/local/bin/mint-artifact-token"
  }
}
```

コマンドは JSON オブジェクトを出力し、その出力は `headers` より優先され、そのマーケットプレイスを更新するたびに再実行されます。実運用で効いてくる点が 2 つあります。1 つは、コマンドが固定のディレクトリ、つまりセッションの作業ディレクトリではなく Claude の設定ホームから実行されることです。そのため `PATH` から解決できるコマンド名か、絶対パスを指定してください。もう 1 つは、そのヘッダーが同一オリジンのアーカイブダウンロードにも継承されることです。これがプラグインソース `archive` と組み合わせたときの利点になります。S3、GitLab、nginx 上の HTTPS 経由の単純な zip で済み、クライアント側に git も npm も要りません。エントリの `sha256` と併用してください。ダウンロードのたびに検証され、不一致ならインストールは拒否されます。

## エントリ単位のヘルパーはマニフェストをインライン化する必要があります

カタログエントリは自身の `headersHelper` を持つことができ、マーケットプレイス側の指定を上書きします。こちらはユーザーが明示的にプラグインをインストールまたは更新したときにのみ実行され、カタログの閲覧時には決して実行されません。そして、無視するとすぐにぶつかるルールが付いてきます。

```text
Plugin "internal-tools" sets headersHelper but is not "strict": false. An entry
with headersHelper must inline its full manifest (strict: false, with
commands/agents/hooks/mcpServers declared in the entry) so users can review what
it ships before the command runs
```

同意は、いかなるコマンドも実行される前に、そのエントリだけを見て判断できる必要があります。インストール時には送信先とコマンドがそのまま表示されます。"runs a local command and sends its output as headers to:" に続けて URL とコマンドラインが出ます。`claude plugin install -y` は表示されたコマンドをプロンプトなしで受け入れ、stdin が TTY でない場合には必須です。

## 偽装が許されないヘッダー

すべてのヘッダー名が通るわけではありません。オペレーターが管理する設定の外で宣言されたものは、`host`、`cookie`、`forwarded`、`connection`、`transfer-encoding`、`content-length`、`via`、クライアント IP 系 (`x-real-ip`、`true-client-ip`、`cf-connecting-ip` など)、そして `x-forwarded-`、`x-original-`、`proxy-` の各プレフィックスを含むブロックリストで濾されます。名前は先に小文字化され、アンダースコアはハイフンに正規化されるため、`X_Real_IP` もすり抜けません。破棄されたヘッダーは取得を失敗させるのではなく、警告としてログに残ります。

管理者は管理設定の `disableCommandPluginSources` または `allowManagedHooksOnly` で仕組み全体を無効化できます。その場合インストールは拒否され、コマンドは一度も実行されません。これは [2.1.128 での .zip アーカイブからのプラグイン読み込み](/ja/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/)と同じ方向性であり、クライアントが到達できる範囲についての前提を減らすものです。リリース項目は [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) にあります。[マーケットプレイスのドキュメント](https://code.claude.com/docs/en/plugin-marketplaces)はまだ追いついていません。
