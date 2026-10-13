---
title: "Azure MCP Server 3.0 は未知のパラメーターを拒否し、リソースをセキュアな既定値で作成するようになりました"
description: "Azure MCP Server 3.0.0 が 2026-10-12 にリリースされました。未知のパラメーターを含むツール呼び出しは失敗するようになり、subscription や tenant などのオプションが多くのツールから削除され、新しい Storage アカウントでは Shared Key 認証が無効になり、サーバーはステートレスな MCP 2026-07-28 プロトコルに対応します。"
pubDate: 2026-10-13
tags:
  - "mcp"
  - "azure"
  - "dotnet"
  - "ai-agents"
lang: "ja"
translationOf: "2026/10/azure-mcp-server-3-0-rejects-unknown-parameters-and-goes-secure-by-default"
translatedBy: "claude"
translationDate: 2026-10-13
---

[Azure MCP Server 3.0.0](https://github.com/microsoft/mcp/releases/tag/Azure.Mcp.Server-3.0.0) は、50 回のベータビルドを経て 2026-10-12 にリリースされました。目玉は新しい名前空間の数々 (`azurebackup`, `resiliency`, `sreagent`, `azureterraform`, `advisor`, `iothub`) ですが、今動いている環境を壊しかねないのはもっと地味な部分です。ツールの契約が厳格になり、サーバーが作成するリソースが既定でロックダウンされるようになりました。

## 未知のパラメーターはエラーになります

2.x では、ツールは使わないオプションを黙って無視していました。3.0 では、`subscription`, `resource-group`, `tenant`, `auth-method`, `user`, `sender-name` といった未使用のパラメーターをほぼすべての名前空間 (Key Vault, Storage, SQL, Redis, Service Bus, AKS など) のツールから削除し、それらを渡す呼び出しを拒否します。カスタムのリトライポリシーオプションもなくなり、Azure SDK の既定のリトライが適用されます。

`azmcp` をスクリプトから実行している場合や、モデルに必ず subscription を渡すよう指示するプロンプトやエージェントの指示を保存している場合は注意が必要です。2.x では次のように動いていた呼び出しは、

```bash
azmcp keyvault secret get --subscription 00000000-0000-0000-0000-000000000000 \
  --vault my-vault --secret db-password --retry-max-retries 5
```

3.0 では検証に失敗します。`keyvault secret get` が受け取るのは `--vault` と省略可能な `--secret` だけで、グローバルな `--retry-*` オプションは存在しなくなりました。これらを取り除き、各ツールが実際に受け取る引数は[コマンドリファレンス](https://github.com/microsoft/mcp/blob/release/azure/3.x/servers/Azure.Mcp.Server/docs/azmcp-commands.md)で確認してください。一部の結果ペイロードも名前付きオブジェクト (`{ servers }`, `{ results }`, `{ guidance }`) に正規化されているため、旧形式を読むパーサーは見直しが必要です。

ほかにも押さえておきたい名称変更が 2 つあります。`monitor healthmodels entity get` は `list` と `get` に分かれ、サーバーのコードは `Azure.Mcp.Core.*` から `Microsoft.Mcp.Core.*` に移りました。ロガーのカテゴリは名前空間に従うため、設定にある `Logging:LogLevel:Azure.Mcp.Core` のエントリは何にも一致しなくなります。

## セキュアな既定値によるリソース作成

エージェントがサーバー経由でリソースを作成する際の既定値が変わりました。

- Storage アカウントでは Shared Key 認証が無効になります (HTTPS、TLS 1.2、匿名 Blob アクセスの禁止は引き続き有効です)。
- Event Hubs 名前空間ではローカル認証が無効になります。
- NFS ファイル共有は、既定で `RootSquash` と暗号化された転送になります。
- `compute vm create` と `compute vmss create` では `--image` が必須になり、`Win2019Datacenter` と `Ubuntu2004` のエイリアスは削除されました。

下流のコードがアカウントキーや、そのキーで署名した SAS で接続している場合、新規作成したアカウントに対して 403 が返ります。それが狙いです。Entra ID と `DefaultAzureCredential` を使ってください。

MySQL と PostgreSQL の `database query` ツールは逆方向に変わりました。破壊的な操作として扱われるようになり、SQL の動詞によるステートメントのフィルターは行われなくなり、サインインしているユーザーのデータベース権限に委ねられます。エージェントに参照だけさせたい場合は、サーバーを `--read-only` で実行するか、読み取り専用のデータベースログインを使ってください。

## ステートレスプロトコルと構造化出力

3.0 は MCP `2026-07-28` のステートレスプロトコルに移行し、`2025-11-25` のクライアントとの後方互換性も維持しています。このリビジョンを追っていない場合は、何がなくなるのか (`initialize` ハンドシェイクと `Mcp-Session-Id` がなくなります) を[ステートフルとステートレスの MCP サーバー](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/)で解説していますので、参照してください。

ツールは `outputSchema` と `structuredContent` も返せるようになり、フラグで有効にします。.NET 10 の `dnx` を使う場合、`mcp.json` のエントリは次のようになります。

```json
{
  "mcpServers": {
    "azure-mcp-server": {
      "command": "dnx",
      "args": [
        "Azure.Mcp", "--version", "3.0.0", "--yes", "--",
        "azmcp", "server", "start",
        "--read-only",
        "--structured-output-mode", "compact"
      ],
      "type": "stdio"
    }
  }
}
```

`compact` は `content` に短いテキストを、`structuredContent` に完全な結果を返します。`duplicated` は両方に完全な結果を返します。クライアントがこれらのフィールドを理解できる場合にのみ有効にしてください。

## アップグレードする価値のある細かな修正

stdout に漏れていたログメッセージや例外 (JSON-RPC の出力を壊す可能性がありました) は stderr に出力されるようになり、not-found エラーは 500 ではなく 404 を返し、npm ラッパーはプラットフォーム用パッケージを自動インストールする際に呼び出し元プロジェクトの `package.json` を書き換えなくなりました。スクリプトとプロンプトの整理が終わるまでは、`@latest` ではなく `Azure.Mcp` 3.0.0 または `@azure/mcp@3.0.0` を明示的に固定してください。
