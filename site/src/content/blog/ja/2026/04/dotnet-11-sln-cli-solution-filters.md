---
title: ".NET 11 Preview 3 で dotnet sln がついに CLI から solution filter を編集"
description: ".NET 11 Preview 3 は dotnet sln に .slnf の solution filter でプロジェクトを作成、追加、削除、一覧するやり方を教えます。大規模モノレポが Visual Studio を開かずにサブセットをロードできるようになります。"
pubDate: 2026-04-18
tags:
  - ".NET 11"
  - "SDK"
  - "dotnet CLI"
  - "MSBuild"
lang: "ja"
translationOf: "2026/04/dotnet-11-sln-cli-solution-filters"
translatedBy: "claude"
translationDate: 2026-04-24
---

Solution filter (`.slnf`) は Visual Studio 2019 から存在していますが、IDE の外で編集するには JSON を手書きする必要がありました。[.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md) がそれを直します: `dotnet sln` が [dotnet/sdk #51156](https://github.com/dotnet/sdk/pull/51156) 経由で `.slnf` ファイルの作成、編集、内容の一覧表示を直接できるようになりました。大きなリポジトリにとって、これはターミナルから 20 プロジェクトのサブセットを開くことと、JSON を手で突つくシェルスクリプトを保守することの違いです。

## Solution filter の実体

`.slnf` は親の `.sln` への JSON ポインターと、プロジェクトパスのリストです。ツールがフィルターをロードすると、リストにない親ソリューション内のすべてのプロジェクトをアンロードします。これによりビルドグラフ、アナライザー、IntelliSense が気にするサブセットに集中し続けます - 大きなコードベースが IDE のロード時間を正気に保つための主要なレバーです。Preview 3 まで、CLI はフィルターを喜んで `build` できましたが、編集はできませんでした。

## 新しいコマンド

サーフェスは既存の `dotnet sln` の動詞を反映しています。フィルターを作成し、プロジェクトを追加・削除し、現在何が含まれているか一覧できます:

```bash
# Create a filter that points at the current .sln
dotnet new slnf --name MyApp.slnf

# Target a specific parent solution
dotnet new slnf --name MyApp.slnf --solution-file ./MyApp.sln

# Add and remove projects
dotnet sln MyApp.slnf add src/Lib/Lib.csproj
dotnet sln MyApp.slnf add src/Api/Api.csproj src/Web/Web.csproj
dotnet sln MyApp.slnf remove src/Lib/Lib.csproj

# Inspect what the filter currently loads
dotnet sln MyApp.slnf list
```

コマンドは `dotnet sln` が `.sln` ファイル向けに既にサポートしている glob とマルチ引数の形式を受け付けます。Visual Studio が出すものと一致する `.slnf` JSON を書くので、CLI から編集したフィルターは IDE でもきれいに開きます。

## モノレポにとってなぜ重要か

2 つのワークフローがかなり安くなります。1 つ目は CI: パイプラインはリポジトリ全体をチェックアウトし、変更されたパスに関連するフィルターだけをビルドできます。Preview 3 以前、ほとんどのチームはこれを JSON を書くカスタムスクリプトや、`.sln` の隣に手動保守する `.slnf` ファイルで行っていました。今や同じパイプラインがフィルターをその場で再生成できます:

```bash
dotnet new slnf --name ci-api.slnf --solution-file MonoRepo.sln
dotnet sln ci-api.slnf add \
  src/Api/**/*.csproj \
  src/Shared/**/*.csproj \
  test/Api/**/*.csproj

dotnet build ci-api.slnf -c Release
```

2 つ目はローカル開発です。大きなリポジトリはしばしば一握りの「スターター」フィルターを出荷して、新しいエンジニアがモバイルや docs のプロジェクトのロードを待たずに backend を開けるようにします。これらのフィルターを正確に保つには、以前はプロジェクト移動のたびに Visual Studio で個別に開く必要がありました - `.sln` のリネームは `.slnf` を自動更新しなかったからです。新しいコマンドを使えば、更新はワンライナーです:

```bash
dotnet sln backend.slnf remove src/Legacy/OldService.csproj
dotnet sln backend.slnf add src/Services/NewService.csproj
```

## パスについての小さなメモ

`dotnet sln` はプロジェクトパスを呼び出し元ではなくフィルターからの相対で解決します。IDE の読み方と一致します。`.slnf` が `build/filters/` にあり、`src/` のプロジェクトを指しているとき、保存されるパスは `..\..\src\Foo\Foo.csproj` で、`dotnet sln list` も同じように表示します。別のワーキングディレクトリからフィルター編集をスクリプト化するときに覚えておく価値があります。

[`dotnet run -e` によるインライン環境変数](https://github.com/dotnet/sdk/pull/52664) と、以前の [EF Core のシングルステップマイグレーション](https://startdebugging.net/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) と組み合わせて、Preview 3 は「これをやるために Visual Studio を開かないと」のセットを削り続けています。完全なリストは [.NET 11 Preview 3 SDK ノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md) にあります。
