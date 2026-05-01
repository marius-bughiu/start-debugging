---
title: "エラー対処: 'Point' には事前定義されたサイズがないため、sizeof は unsafe コンテキストでしか使えない"
description: "unsafe コンテキスト外で sizeof を Point に対して使えない C# のエラーを解決します。unsafe コードを有効化する方法と、Marshal.SizeOf を使う方法の2つを紹介します。"
pubDate: 2023-11-09
tags:
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/how-to-fix-point-does-not-have-a-predefined-size-therefore-sizeof-can-only-be-used-in-an-unsafe-context"
translatedBy: "claude"
translationDate: 2026-05-01
---
このエラーが発生するのは、C# では `sizeof` がコンパイル時にサイズが決まっている型にしか使えず、`Point` 構造体は unsafe コンテキストでない限りそうした型には含まれないからです。

解決方法は2つあります。

## `unsafe` コードを使う

これを使えば、任意のサイズの型に対して `sizeof` 演算子を使えます。そのためには、メソッドに `unsafe` キーワードを付け、プロジェクトのビルド設定で unsafe コードを有効化する必要があります。

メソッドのシグネチャは基本的に次のように変わります。

```cs
public static unsafe void YourMethod()
{
    // ... your unsafe code
    // IntPtr sizeOfPoint = (IntPtr)sizeof(Point);
}
```

unsafe コードを許可するには、プロジェクトのプロパティを開いて `Build` タブに移動し、「Allow unsafe code」オプションをオンにします。これでコンパイルエラーは解消されるはずです。

## `Marshal.SizeOf` を使う

`Marshal.SizeOf` は安全で、unsafe コンテキストを必要としません。`SizeOf` メソッドはオブジェクトのアンマネージドサイズをバイト単位で返します。

やることは、`sizeof(Point)` を `Marshal.SizeOf(typeof(Point))` に置き換えるだけです。次のとおりです。

```cs
IntPtr sizeOfPoint = (IntPtr)Marshal.SizeOf(typeof(Point));
```

`Marshal.SizeOf` は `System.Runtime.InteropServices` 名前空間に含まれるため、ファイル先頭に対応する using ディレクティブがあることを確認してください。

```cs
using System.Runtime.InteropServices;
```

注意点として、`Marshal.SizeOf` は unsafe な `sizeof` と比べてごくわずかにパフォーマンス上のオーバーヘッドがあります。自分の用途に合った解決策を選ぶ際には、その点も考慮するとよいでしょう。
