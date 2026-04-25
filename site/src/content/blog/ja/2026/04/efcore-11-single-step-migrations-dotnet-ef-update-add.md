---
title: "EF Core 11 で 1 つのコマンドでマイグレーションを作成して適用できる"
description: "dotnet ef database update コマンドが、マイグレーションを 1 つのステップでスキャフォールドして適用するための --add を受け入れるようになりました。仕組み、コンテナと .NET Aspire にとって重要な理由、注意点を紹介します。"
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add"
translatedBy: "claude"
translationDate: 2026-04-25
---

プロトタイピングセッション中に `dotnet ef migrations add` と `dotnet ef database update` を何十回も切り替えたことがあるなら、EF Core 11 Preview 2 にはささやかな生活の質の勝利があります。`database update` での `--add` フラグです。

## 2 つではなく 1 つのコマンド

新しいワークフローは 2 ステップのダンスを 1 回の呼び出しに圧縮します。

```bash
dotnet ef database update InitialCreate --add
```

このコマンドは `InitialCreate` という名前のマイグレーションをスキャフォールドし、実行時に Roslyn でコンパイルし、データベースに適用します。マイグレーションファイルは依然としてディスクに着地するので、他のどのマイグレーションとも同様にソース管理に入ります。

出力ディレクトリや名前空間をカスタマイズする必要がある場合、`migrations add` と同じオプションが引き継がれます。

```bash
dotnet ef database update AddProducts --add \
  --output-dir Migrations/Products \
  --namespace MyApp.Migrations
```

PowerShell ユーザーは `Update-Database` で同等の `-Add` スイッチを得られます。

```powershell
Update-Database -Migration InitialCreate -Add
```

## ランタイムコンパイルが重要な理由

本当の見返りはローカル開発でのキー入力をいくつか節約することではありません。再コンパイルが選択肢にない環境でマイグレーションワークフローを可能にすることです。

.NET Aspire オーケストレーションやコンテナ化された CI パイプラインを考えてみてください。コンパイル済みプロジェクトはすでにイメージに焼き付けられています。`--add` がなければ、マイグレーションをスキャフォールドし、プロジェクトを再ビルドし、それから適用するためだけに、別のビルドステップが必要になります。Roslyn のランタイムコンパイルにより、`database update` コマンドはその場でライフサイクル全体を処理します。

## オフラインでのマイグレーション削除

EF Core 11 は `migrations remove` に `--offline` フラグも追加します。データベースに到達できない場合や、マイグレーションが決して適用されなかったことを確実に知っている場合、接続チェックを完全にスキップできます。

```bash
dotnet ef migrations remove --offline
```

`--offline` と `--force` は相互排他的であることに注意してください。`--force` は、マイグレーションを元に戻す前にそれが適用されたかどうかを検証するためにライブ接続を必要とします。

両方のコマンドが `--connection` パラメータも受け付けるようになったので、`DbContext` 設定に触れることなく特定のデータベースをターゲットにできます。

```bash
dotnet ef migrations remove --connection "Server=staging;Database=App;..."
```

## いつ手を伸ばすか

プロトタイピングと内側のループの開発では、`--add` は摩擦を取り除きます。コンテナベースのデプロイメントパイプラインでは、ビルドステージ全体を取り除きます。ランタイムコンパイルされたマイグレーションは通常のビルド警告をバイパスすることに留意してください。したがって、生成されたファイルは `main` に到達する前にレビューに値するアーティファクトとして扱ってください。

完全な詳細は [EF Core 11 の What's New ドキュメント](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) にあります。
