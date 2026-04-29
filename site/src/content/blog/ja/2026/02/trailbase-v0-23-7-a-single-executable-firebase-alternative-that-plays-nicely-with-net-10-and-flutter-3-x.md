---
title: "TrailBase v0.23.7: .NET 10 と Flutter にうまく合う、単一バイナリの Firebase 代替"
description: "TrailBase は Rust、SQLite、Wasmtime 上に構築されたオープンソースの単一実行ファイルバックエンドです。バージョン 0.23.7 では UI 修正とエラー処理の改善が提供されます。"
pubDate: 2026-02-07
tags:
  - "dotnet"
  - "flutter"
  - "sqlite"
lang: "ja"
translationOf: "2026/02/trailbase-v0-23-7-a-single-executable-firebase-alternative-that-plays-nicely-with-net-10-and-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
TrailBase は **2026 年 2 月 6 日** に **v0.23.7** をリリースしました。リリースノートのほとんどは UI のクリーンアップと堅牢性の修正ですが、注目を集めている本当の理由はプロダクトの方向性です。TrailBase は **Rust、SQLite、Wasmtime** 上に構築された、認証と管理 UI を備えたオープンな **単一実行ファイル** のバックエンドを目指しています。

**Flutter 3.x** でモバイルまたはデスクトップアプリを構築し、**.NET 10** と **C# 14** でサービスやツールを提供している場合、この「単一バイナリ」という切り口は注目に値します。話題性の問題ではありません。可動部分を減らすという話です。

## なぜ単一実行ファイルのバックエンドが実プロジェクトで重要なのか

多くのチームは API を構築できます。しかし、複数サービスのスタックを次のすべてで一貫させられるチームは多くありません。

-   開発者のマシン
-   CI エージェント
-   一時的なプレビュー環境
-   小規模な本番デプロイ

ローカルの depot ディレクトリを持つ単一バイナリは、良い意味で退屈です。マシンがやることが少ないので「私のマシンでは動く」を再現可能にしてくれます。

## Windows で数分で動かす

TrailBase は Windows のインストールスクリプトとシンプルな `run` コマンドをドキュメント化しています。これは評価する最速の方法です。

```powershell
# Install (Windows)
iwr https://trailbase.io/install.ps1 | iex

# Start the server (defaults to localhost:4000)
trail run

# Admin UI
# http://localhost:4000/_/admin/
```

初回起動時、TrailBase は `./traildepot` フォルダーをブートストラップし、管理者ユーザーを作成し、認証情報をターミナルに表示します。

認証 UI コンポーネントが必要な場合、README には次のようにあります。

```powershell
trail components add trailbase/auth_ui

# Auth endpoints include:
# http://localhost:4000/_/auth/login
```

## .NET 10 (C# 14) での小さな動作確認

完全なクライアントライブラリを組み込まなくても、「起動しているか」を CI やローカルスクリプトで実行できる決定的なチェックに変えるのは有用です。

```cs
using System.Net;

using var http = new HttpClient
{
    BaseAddress = new Uri("http://localhost:4000")
};

var resp = await http.GetAsync("/_/admin/");
Console.WriteLine($"{(int)resp.StatusCode} {resp.StatusCode}");

if (resp.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.Found))
{
    throw new Exception("TrailBase admin endpoint did not respond as expected.");
}
```

意図的に退屈にしてあります。失敗は明白であってほしいからです。

## v0.23.7 で何が変わったか

v0.23.7 のノートはこれらを強調しています。

-   アカウント UI のクリーンアップ
-   初回アクセス時の管理 UI における不正なセルアクセスの修正
-   TypeScript クライアントと管理 UI のエラー処理の改善
-   依存関係の更新

プロジェクトを評価しているなら、こうした「メンテナンスリリース」は通常ポジティブなサインです。ツールを日常的に使い始めると摩擦が減ります。

ソース:

-   [GitHub の Release v0.23.7](https://github.com/trailbaseio/trailbase/releases/tag/v0.23.7)
-   [TrailBase リポジトリ (インストール + 実行 + エンドポイント)](https://github.com/trailbaseio/trailbase)
