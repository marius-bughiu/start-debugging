---
title: ".NET 10 on Ubuntu 26.04: resolute コンテナータグと archive の Native AOT"
description: "Ubuntu 26.04 Resolute Raccoon は .NET 10 を archive に同梱し、-noble を置き換える -resolute コンテナータグを導入し、dotnet-sdk-aot-10.0 経由で Native AOT ツーリングをパッケージします。"
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-10"
  - "ubuntu"
  - "containers"
  - "native-aot"
  - "linux"
lang: "ja"
translationOf: "2026/04/dotnet-10-ubuntu-2604-resolute-container-tags"
translatedBy: "claude"
translationDate: 2026-04-24
---

Ubuntu 26.04 "Resolute Raccoon" が 2026 年 4 月 23 日に一般提供となり、Microsoft .NET チームは同日に併走するブログ記事を公開しました。見出しは、.NET 10 が初日から distro の archive に入り、コンテナータグのネーミングが切り替わり、Native AOT がついに正式な apt パッケージを得たことです。Linux で .NET を運用しているなら、これは今後 2 年間あなたの `FROM` 行の見た目を変えるリリースです。

## Resolute がコンテナータグで noble を置き換え

.NET 10 から、デフォルトのコンテナータグは Debian ではなく Ubuntu イメージを参照します。26.04 がリリースされ、Microsoft は `resolute` タグの下に新しい Ubuntu 26.04 ベースのフレーバーを追加しました。マイグレーションは機械的です:

```dockerfile
# Before
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble

# After
FROM mcr.microsoft.com/dotnet/aspnet:10.0-resolute
```

`noble` イメージはそのまま存在し続け、24.04 ベースの更新を受け取り続けるので、強制的な切り替えはありません。`chiseled` バリアントも足並みを揃えて進みます: `10.0-resolute-chiseled` はフルイメージと並んで発行されます。すでに distroless 風デプロイのために chiseled noble イメージを使っていたなら、アップグレードはタグの入れ替えと rebuild だけです。

## archive から .NET 10 をインストール

26.04 では Microsoft パッケージフィードは必要ありません。Ubuntu の archive が SDK を直接持っています:

```bash
sudo apt update
sudo apt install dotnet-sdk-10.0
```

.NET 10 は LTS なので、archive バージョンは distro の end-of-life まで Ubuntu 経由でセキュリティサービシングを受けます。それはサードパーティの apt ソースをブロックする硬化された環境で重要です。

## ファーストクラスの apt パッケージとしての Native AOT

これは静かですが重要な変更です。26.04 まで、Ubuntu で Native AOT をビルドするには自分で `clang`、`zlib1g-dev`、そして正しい toolchain の部品をインストールする必要がありました。26.04 archive は今や `dotnet-sdk-aot-10.0` を同梱し、SDK の `PublishAot` target が期待する linker の部品を引き込みます。

```bash
sudo apt install -y dotnet-sdk-aot-10.0 clang
dotnet publish -c Release -r linux-x64
```

Microsoft は hello-world アプリで 1.4 MB バイナリと 3 ms の cold start、ミニマルな web サービスで 13 MB の self-contained バイナリを引用しています。サイズと起動の数字は .NET 8 以降 AOT を使ってきた人にはおなじみですが、それらが stock の LTS で単一の `apt install` から落ちてくるのは新しいことです。

## dotnet-backports 経由の .NET 8 と 9

まだ 10 で rebuild する準備ができていないなら、`dotnet-backports` PPA が 26.04 でサポート対象の古いバージョン向けにサポートされたパスです:

```bash
sudo apt install -y software-properties-common
sudo add-apt-repository ppa:dotnet/backports
sudo apt install dotnet-sdk-9.0
```

Microsoft はこれを best-effort サポートと呼んでいるので、長期計画ではなく橋として扱ってください。Ubuntu 26.04 が launch 日に .NET 10 を用意できたのは、2025 年末から Ubuntu 26.04 に対して `dotnet/runtime` CI を回してきたからです。メカニクスを追いたければ、[公式 .NET ブログ記事](https://devblogs.microsoft.com/dotnet/whats-new-for-dotnet-in-ubuntu-2604/) に全ストーリーがあります。
