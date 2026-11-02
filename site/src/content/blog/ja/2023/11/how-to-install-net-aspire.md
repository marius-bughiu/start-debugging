---
title: "C# AppHost 用の Aspire CLI をインストールする"
description: "C# AppHost 用の Aspire CLI をインストールして確認します。dotnet workload install aspire が .NET 8 プレビュー当時の手順である理由も説明します。"
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/how-to-install-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Aspire 13.x の **C# AppHost** には .NET 10 SDK と Aspire CLI をインストールします。ターミナルで 10.x SDK が表示されることを確認し、CLI を .NET グローバルツールとしてインストールして、シェルから起動できるか確認します。

```sh
dotnet --list-sdks
dotnet tool install --global Aspire.Cli
aspire --version
```

最後のコマンドで `aspire` が見つからなければ、ターミナルを開き直し、.NET グローバルツールのディレクトリが `PATH` に含まれているか確認します。Windows のパッケージマネージャーや Homebrew などを使う場合は、[CLI のインストールガイド](https://aspire.dev/get-started/install-cli/)から方法を一つ選んでください。

AppHost から Redis やデータベースのコンテナを起動する場合は、コンテナランタイムも起動しておきます。Docker Desktop や Podman が使えます。[Aspire の前提条件](https://aspire.dev/get-started/prerequisites/)にはランタイムの設定と、C# AppHost に必要な SDK と各サービスのターゲットフレームワークの違いが説明されています。

## 以前の手順で Aspire ワークロードをインストールする理由

**2026年11月2日訂正:** `dotnet workload install aspire` は [2023 年 11 月の .NET 8 プレビュー](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/)で使われたコマンドです。[Aspire 9 でテンプレートが NuGet パッケージに移り](https://aspire.dev/whats-new/aspire-9/)、ワークロードが不要になりました。以下のコマンドと画像は当時の手順を記録したものです。

```sh
dotnet workload install aspire
```

当時の Visual Studio Installer では Web 開発ワークロードのオプションに **.NET Aspire SDK (Preview)** がありました。2 枚目は当時の Windows 用 Docker Desktop インストーラーです。

[![ASP.NET and web development を選択し、Optional の .NET Aspire SDK (Preview) にチェックを入れた Visual Studio Installer。](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

[![Use WSL 2 instead of Hyper-V と Add shortcut to desktop にチェックが入った Docker Desktop インストーラー。](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

`aspire --version` が動作したら、[Aspire のスターターアプリを作成](/ja/2023/11/getting-started-with-net-aspire/)できます。AppHost の役割は [Aspire がサービスを接続する仕組み](/ja/2023/11/what-is-net-aspire/)で解説しています。
