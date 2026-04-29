---
title: "Docker 上の .NET の SBOM: ひとつのツールにすべてを見せようとするのはやめる"
description: "CycloneDX、Syft、Dependency-Track を使って、.NET の Docker イメージにおける NuGet 依存関係とコンテナ OS パッケージを追跡する方法。そして、ひとつの SBOM では足りない理由 --。"
pubDate: 2026-01-10
tags:
  - "docker"
  - "dotnet"
lang: "ja"
translationOf: "2026/01/sbom-for-net-in-docker-stop-trying-to-force-one-tool-to-see-everything"
translatedBy: "claude"
translationDate: 2026-04-30
---
ある DevOps スレッドで、最近よく見かける質問が出ていました。「Docker イメージとして配布される .NET アプリで、NuGet 依存関係とコンテナの OS パッケージの両方を、どうやって追跡すればいいのか?」と。投稿者はすでに正しい方向に近づいていました。.NET プロジェクトのグラフには CycloneDX、イメージには Syft、それから Dependency-Track に取り込む、という流れです。

ソース: [Reddit のスレッド](https://www.reddit.com/r/devops/comments/1q8erp9/sbom_generation_for_a_net_app_in_a_container/)。

## ひとつの SBOM は、しばしば誤った着地点になる

コンテナイメージには、少なくとも 2 つの依存関係の宇宙があります。

-   アプリケーションの依存関係: ビルド時に解決される NuGet パッケージ (あなたの `*.deps.json` の世界)。
-   イメージの依存関係: OS パッケージとベースイメージのレイヤー (あなたの `apt`、`apk`、libc、OpenSSL の世界)。

.NET 9 と .NET 10 では、どちらの側もうっかり見えなくなることがあります。

-   イメージスキャナーは、プロジェクトのグラフを読んでいないため NuGet のバージョンを見逃すことがあります。
-   アプリケーション側の SBOM ツールは、レイヤーをスキャンしていないため、ベースイメージの OS パッケージを見ません。

だからこそ、「ひとつのツールにすべてをやらせる」は、たいてい盲点に行き着きます。

## SBOM を 2 つ作り、出自を保つ

実用的なパイプラインは次のとおりです。

-   **SBOM A** (アプリケーションレベル): ビルド時にソリューションまたはプロジェクトから生成。
    -   ツール: [cyclonedx-dotnet](https://github.com/CycloneDX/cyclonedx-dotnet)
-   **SBOM B** (イメージレベル): ビルド済みイメージから生成。
    -   ツール: [Syft](https://github.com/anchore/syft)
-   **取り込みと監視**: 両方を [Dependency-Track](https://dependencytrack.org/) にアップロード。

肝心なのは出自です。「この CVE は、ベースイメージ側の話なのか、それとも NuGet グラフ側の話なのか?」を当て推量せずに答えられる必要があります。

## CI ジョブにそのまま貼れる最小コマンド

```bash
# App SBOM (NuGet focused)
dotnet tool install --global CycloneDX
dotnet CycloneDX .\MyApp.sln -o .\sbom --json

# Image SBOM (OS packages and what the image reveals)
docker build -t myapp:ci .
syft myapp:ci -o cyclonedx-json=.\sbom\container.cdx.json
```

アプリケーションの SBOM を、実際に配布されるものと一致させたい場合は、コンテナイメージを生み出したのと同じコミットから生成し、両方の成果物を一緒に保管してください。

## BOM はマージすべき?

「これらの BOM を 1 つにマージすべきか?」が主な疑問なら、私のデフォルトの答えはこうです。デフォルトではマージしない。

-   別々に保ち、アラートが対応可能なものであり続けるようにします。
-   単一のコンプライアンスレポートが必要なら、レポート層でマージしてください。SBOM 自体で出自を潰してはいけません。

Dependency-Track ではこれが、よく `myapp` と `myapp-image` という 2 つのプロジェクトになります。これは余分な複雑さではありません。よりすっきりしたモデルです。

## なぜ Syft が "NuGet を取りこぼす" のか、そしてどうするか

Syft はイメージとファイルシステムが得意です。見えるものから識別できるものを報告します。NuGet の権威ある依存関係が欲しいなら、CycloneDX のツールでプロジェクトグラフから生成してください。

公開出力に対するスキャン (たとえば `syft dir:publish/`) を試すこともできますが、あくまで補助として扱ってください。「どのパッケージを、どのバージョンで参照したのか?」という問いは、レイヤースキャンではなくビルドグラフに属します。

コンテナで .NET 10 のサービスを構築しているなら、SBOM 2 本というのが正直な答えです。カバレッジは良くなり、責任分担はより明確になり、スプリントを浪費する誤検知も減ります。
