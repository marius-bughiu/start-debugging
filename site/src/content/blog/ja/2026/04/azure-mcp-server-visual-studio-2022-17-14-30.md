---
title: "Azure MCP Server が Visual Studio 2022 17.14.30 に同梱、拡張機能は不要"
description: "Visual Studio 2022 17.14.30 は Azure MCP Server を Azure 開発ワークロードに同梱します。Copilot Chat は何もインストールせずに 45 サービスにまたがる 230 以上の Azure ツールに到達できます。"
pubDate: 2026-04-22
tags:
  - "visual-studio"
  - "azure"
  - "mcp"
  - "github-copilot"
lang: "ja"
translationOf: "2026/04/azure-mcp-server-visual-studio-2022-17-14-30"
translatedBy: "claude"
translationDate: 2026-04-24
---

2026 年 4 月 15 日の [Visual Studio ブログ記事](https://devblogs.microsoft.com/visualstudio/azure-mcp-tools-now-ship-built-into-visual-studio-2022-no-extension-required/) は静かですが重要な変更を埋めていました: Visual Studio 2022 バージョン 17.14.30 から、Azure MCP Server は Azure 開発ワークロードの一部です。マーケットプレース拡張機能も、手動 `mcp.json` も、マシンごとのオンボーディングもありません。ワークロードがインストールされていて、GitHub と Azure の両方にサインインしていれば、Copilot Chat はすでに 45 サービスにまたがる 230 以上の Azure ツールを見ることができます。

## なぜ焼き込むのか

17.14.30 まで、VS 2022 の Copilot Chat の前に Azure MCP Server を出すには、別個のインストール、ユーザーごとの JSON 設定、そして npx が立ち上げたサーバーがトークンを失うたびの再認証ダンスが必要でした。サーバーをワークロードと一緒にバンドルすると、インストール手順がなくなり、認証が IDE の既存の Azure アカウントピッカーに紐付けられるので、Cloud Explorer を動かしている同じログインが MCP ツールを動かします。

これはまた VS 2022 を 2025 年 11 月から Azure MCP 統合を出荷している VS 2026 と同等のレベルに引き上げます。

## 有効化

サーバーはワークロードと一緒に来ますがデフォルトでは無効です。点火するには:

1. Visual Studio 2022 を 17.14.30 以上に更新します (Help, Check for Updates)。
2. Visual Studio Installer を開いて Azure 開発ワークロードがインストールされていることを確認します。
3. Copilot が有効になるよう GitHub アカウントにサインインし、次にタイトルバーのアカウントピッカーから Azure アカウントにサインインします。
4. Copilot Chat を開き、"Select tools" とラベルされたレンチアイコンをクリックし、"Azure MCP Server" をオンに切り替えます。

その後、Copilot が初めて Azure ツールを選んだときにサーバーがオンデマンドで起動します。チャットプロンプトから確認できます:

```text
> #azmcp list resource groups in subscription Production
```

Copilot はバンドルされたサーバー経由でルートし、サインインしたアカウントにスコープされたライブリストを返します。同じレンチダイアログは個別のツールも見せるので、サーバー全体を無効にすることなくうるさいもの (例えばコスト系) を無効にできます。

## 実際に得られるもの

バンドルされたサーバーは [aka.ms/azmcp/docs](https://aka.ms/azmcp/docs) にドキュメント化されたのと同じツールサーフェスを公開し、4 つのバケットにグループ化されています:

- **Learn**: IDE を離れずにサービス形状の質問 ("Azure SQL のどの tier が serverless replica で private link をサポートするか") をします。
- **Design and develop**: 汎用サンプルではなく、サブスクリプション内のリソースに根差した設定スニペットと SDK 呼び出しを取得します。
- **Deploy**: チャットからリソースグループ、Bicep デプロイメント、Container Apps をプロビジョニングします。
- **Troubleshoot**: Application Insights クエリ、App Service ログストリーム、AKS pod ステータスを会話に引き込みます。

「staging の app service が 502 を返している、直近 1 時間の失敗を引っ張って何が変わったか教えて」のようなチャットが、ポータルタブ間のコピペなしでエンドツーエンドで実行されます。

## standalone サーバーがまだ意味を持つとき

バンドルビルドは VS のサービシングケイデンスに従うので、upstream の `Azure.Mcp.Server` リリースから遅れます。先週ランディングしたツールが必要なら、`mcp.json` でバンドルされたものと並べて standalone サーバーを登録すれば、Copilot がツールリストをマージします。それ以外の全員にとって、その設定ファイルを削除するのが正しい動きになりました。
