---
title: "Polars.NET: LibraryImport に依存する .NET 10 向け Rust DataFrame エンジン"
description: "新しい Polars.NET プロジェクトが 2026 年 2 月 6 日のコミュニティ投稿の後にトレンドになっています。見出しはシンプルです。Rust Polars に支えられた .NET フレンドリーな DataFrame API で、安定した C ABI とオーバーヘッドを低く保つための LibraryImport ベースの interop を備えています。"
pubDate: 2026-02-08
tags:
  - "dotnet"
  - "csharp"
  - "performance"
  - "interop"
lang: "ja"
translationOf: "2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport"
translatedBy: "claude"
translationDate: 2026-04-25
---

2026 年 2 月 6 日のコミュニティ投稿が **Polars.NET** を私のレーダーに乗せました。Rust の **Polars** コアに支えられた .NET 向け DataFrame エンジンで、C# と F# の両方の API を公開しています。売り文句は「DataFrame があります」ではありません。「パフォーマンスがどこから来るかについて正直な DataFrame があります」です。

**.NET 10** と **C# 14** で構築している場合、詳細がすべての物語です。安定した C ABI、プラットフォーム横断の事前ビルドされたネイティブバイナリ、そして `LibraryImport` 経由の現代的な interop です。

## 大量の interop に `LibraryImport` が重要な理由

`DllImport` は動作しますが、ホットパス上の marshaling と割り当てに偶発的にコストを支払うのは簡単です。`LibraryImport` (ソース生成 interop) は .NET が進む方向です。blittable シグネチャと明示的な span に固執すれば、ランタイム marshaling のオーバーヘッドを回避するグルーコードを生成できます。

これが Polars.NET が使用すると主張するパターンです。最小の例はこのようになります。

```csharp
using System;
using System.Runtime.InteropServices;

internal static partial class NativePolars
{
    // Name depends on platform: polars.dll, libpolars.so, libpolars.dylib.
    [LibraryImport("polars", EntryPoint = "pl_version")]
    internal static partial IntPtr Version();
}

static string GetNativeVersion()
{
    var ptr = NativePolars.Version();
    return Marshal.PtrToStringUTF8(ptr) ?? "<unknown>";
}
```

重要な部分は `pl_version` ではありません。形です。境界を薄く保ち、明示的に保ち、interop が無料であるふりをしないことです。

## 事前ビルドされたネイティブバイナリは採用の加速装置

interop ベースのライブラリは、すべてのユーザーにネイティブ依存をコンパイルさせると死にます。Polars.NET は Windows、Linux、macOS 向けに事前ビルドされたネイティブバイナリを明示的に呼び出しています。

評価する際は、次のような NuGet レイアウトを探してください。

- `runtimes/win-x64/native/polars.dll`
- `runtimes/linux-x64/native/libpolars.so`
- `runtimes/osx-arm64/native/libpolars.dylib`

それが「クールなリポジトリ」と「CI と dev マシンで使える依存関係」の違いです。

## 真の問い: メモリモデルを予測可能に保てるか?

DataFrames はメモリの物語です。Rust コア + .NET サーフェスの場合、私が探すのは:

- **明確な所有ルール**: 誰がいつバッファを解放するのか?
- **ゼロコピーパス**: Arrow 交換は良い兆候ですが、それが実在する場所を確認してください。
- **例外の境界**: ネイティブエラーは構造化された .NET 例外になりますか?

これらが堅実なら、Polars.NET はすべてを書き直さずに Rust グレードのベクトル化実行を .NET ワークロードに持ち込む実用的な方法になります。

ソース:

- [Polars.NET リポジトリ](https://github.com/ErrorLSC/Polars.NET)
- [Reddit スレッド](https://www.reddit.com/r/dotnet/comments/1qxpna7/polarsnet_a_dataframe_engine_for_net/)
