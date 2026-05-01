---
title: ".NET Aspire のインストール方法 (dotnet workload install aspire)"
description: "`dotnet workload install aspire` で .NET Aspire をインストールします。Windows、macOS、Linux での .NET 8、Aspire ワークロード、Docker のセットアップ手順を解説します。"
pubDate: 2023-11-15
tags:
  - "aspire"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/how-to-install-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET Aspire は、スケーラブルで観測可能な本番品質の分散アプリケーションを作成するために設計された、クラウド指向の包括的なフレームワークです。この記事では、.NET Aspire を始めるための前提条件を確認します。.NET Aspire の概要とその特徴を知りたい場合は、[What is .NET Aspire](/ja/2023/11/what-is-net-aspire/) の記事をご覧ください。

.NET Aspire を使ってアプリケーションを開発するには、主に 3 つのものが必要です。

-   [.NET 8](#install-net-8)
-   [.NET Aspire ワークロード](#install-the-net-aspire-workload)
-   そして [Docker Desktop](#install-docker-desktop)

アプリケーション開発に Visual Studio を使用する予定がある場合は、Visual Studio 2022 Preview バージョン 17.9 以上が必要であることに注意してください。

## Install .NET 8

Visual Studio を使っていて、すでに最新バージョンに更新済みであれば、.NET 8 はすでにインストールされています。最新バージョンでない場合は、Visual Studio バージョン 17.9 以上を使用していることを確認してください。それで問題ありません。

Visual Studio を使用しない場合は、こちらから .NET 8 SDK をダウンロードしてインストールできます: [https://dotnet.microsoft.com/en-us/download/dotnet/8.0](https://dotnet.microsoft.com/en-us/download/dotnet/8.0)

## Install the .NET Aspire workload

.NET Aspire ワークロードは、次の 2 つの方法でインストールできます。

-   dotnet CLI を使用してコマンドラインから
-   または Visual Studio Installer を使用して (Visual Studio の場合は VS 17.9 以上が必要であることに注意)

### Using .NET CLI

.NET Aspire をコマンドラインからインストールするコマンドは非常に簡単です。.NET 8 SDK がインストールされていることを確認したら、ワークロードのインストールコマンドを実行します。

```bash
dotnet workload install aspire
```

### Using the Visual Studio Installer

Visual Studio Installer で、**ASP.NET and web development** ワークロードを選択し、右側のパネルの **Optional** で **.NET Aspire SDK (Preview)** にチェックを入れ、**Modify** をクリックしてインストールプロセスを開始します。

[![](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

## Install Docker Desktop

最新バージョンの Docker Desktop はこちらからダウンロードできます: [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)

デフォルトのオプションでインストーラーを進め、再起動後に準備完了です。

[![](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

なお、Docker Desktop は個人開発者の個人利用、教育、オープンソースコミュニティに限り無料です。それ以外の利用にはライセンス料が発生します。不明な場合は [価格ページ](https://www.docker.com/pricing/) を確認してください。

すべてインストールできたら、いよいよ .NET Aspire での開発を始める準備が整いました!
