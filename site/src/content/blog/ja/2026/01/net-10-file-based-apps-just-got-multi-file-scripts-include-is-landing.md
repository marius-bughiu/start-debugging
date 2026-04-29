---
title: ".NET 10 のファイルベースアプリが複数ファイルのスクリプトに対応: `#:include` が登場"
description: ".NET 10 はファイルベースアプリに #:include のサポートを追加し、dotnet run のスクリプトが完全なプロジェクトを作らずに複数の .cs ファイルにまたがれるようにします。"
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing"
translatedBy: "claude"
translationDate: 2026-04-30
---
.NET 10 の "ファイルベースアプリ" の話は、回を追うごとに実用的になってきています。新しい SDK のプルリクエストが `#:include` のサポートを追加し、`dotnet run foo.cs` がもう "1 ファイルか、さもなくば何もしない" ではなくなりました。

これは SDK 上で "File-based apps: add support for `#:include`" として追跡されており、明らかなスクリプティングのユースケースを解決することを目的としています。つまり、完全なプロジェクトを作らずに、メインスクリプトとヘルパーにコードを分割することです。

## なぜ `dotnet run file.cs` で複数ファイルが重要なのか

つらさはシンプルです。スクリプトが 1 ファイルを超えて成長すると、選択肢は次のどちらかになります。

-   ヘルパーを同じファイルにコピー&ペーストする (すぐに読めなくなります)、または
-   諦めて完全なプロジェクトを作る ("素早いスクリプト" のワークフローを台無しにします)。

望ましい振る舞いは SDK の issue にはっきり書かれています。`dotnet run file.cs` が、隣接する `util.cs` のコードを余計な手順なしに使えるべきだ、ということです。

## `#:include` で何が変わるか

`#:include` を使えば、メインのファイルが他の `.cs` ファイルを取り込めるようになり、実行時にコンパイラーがひとつのコンパイル単位として認識します。"スクリプトのような感覚" と "本物のコード構成" の間にあった、足りなかった橋渡しです。

これは C# の言語機能ではありません。ファイルベースアプリのための .NET SDK の機能です。これが重要なのは、言語のバージョンを待たずに、.NET 10 のプレビューの中で素早く進化できるからです。

## 実際に動かせる、ごく小さな複数ファイルスクリプト

ディレクトリ:

```bash
app\
  file.cs
  util.cs
```

`file.cs`:

```cs
#:include "util.cs"

Console.WriteLine(Util.GetMessage());
```

`util.cs`:

```cs
static class Util
{
    public static string GetMessage() => ".NET 10 file-based apps can include files now.";
}
```

.NET 10 プレビューの SDK で実行します:

```bash
dotnet run app/file.cs
```

## 注意したい現実的な詳細が 2 つ

### キャッシュが変更を隠すことがある

ファイルベースアプリは、内側ループの実行を速く保つためにキャッシュに頼っています。古い出力が出ているように感じたら、`--no-cache` を付けて再実行し、リビルドを強制してください。

### `.cs` 以外の項目が "高速パス" を複雑にすることがある

Web SDK の要素 (たとえば `.razor` や `.cshtml`) を含むファイルベースアプリを作っている場合、`.cs` 以外のデフォルト項目が変更されたときのキャッシュ無効化に関する未解決の issue があります。ファイルベースアプリを本物のアプリプロジェクトの代替として扱う前に、これを念頭に置いてください。

正確なロールアウトを追いたい場合は、ここから始めるのが良いでしょう。

-   PR: [https://github.com/dotnet/sdk/pull/52347](https://github.com/dotnet/sdk/pull/52347)
-   複数ファイルシナリオの issue: [https://github.com/dotnet/sdk/issues/48174](https://github.com/dotnet/sdk/issues/48174)
