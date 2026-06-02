---
title: ".NET 11 は double を hex にビット単位で往復変換できます"
description: ".NET 11 Preview 4 では double、float、Half が X 指定子でフォーマットでき、NumberStyles.HexFloat でパースできるようになり、C の printf(\"%a\") と同じ IEEE-754 の hex テキストを生成します。"
pubDate: 2026-06-02
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
lang: "ja"
translationOf: "2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat"
translatedBy: "claude"
translationDate: 2026-06-02
---

[.NET 11 Preview 4 のライブラリ ノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md)には、必要になる日まではニッチに聞こえる機能が含まれていました。`double`、`float`、`Half` を IEEE-754 の16進数形式で書き出し、また読み戻せるようになったのです。これは C や C++ が `printf("%a", ...)` で出力するのと同じ表記で、値のすべてのビットをテキストに直接さらします。

## X 指定子は以前 double で例外をスローしていました

これまで書式文字列 `"X"` は整数専用でした。浮動小数点値に対して呼び出すと、`FormatException` が返ってきました。

```csharp
double value = Math.PI;
string hex = value.ToString("X"); // .NET 10: throws FormatException
```

.NET 11 からは、同じ呼び出しが float の hex 表現を返します。

```csharp
using System.Globalization;

double value = Math.PI;

string hex = value.ToString("X"); // "0X1.921FB54442D18P+1"
double round = double.Parse(hex, NumberStyles.HexFloat);

Console.WriteLine(round == value); // True, exact round-trip
```

新しいフラグ `NumberStyles.HexFloat` が、`Parse` と `TryParse` にその形式を読み戻すよう指示します。先頭の `0X1.` は仮数部で、`P+1` は2進指数なので、見ているのは10進近似ではなく、ビット配置そのものです。

## 10進の往復変換はすでに機能していたのに、なぜ必要なのか

ここは正確に述べる価値があります。.NET Core 3.0 以降、最短の往復可能なフォーマッターは `double.Parse(value.ToString())` がまったく同じ `double` を返すことを保証しています。つまり hex は10進往復変換の正しさのバグを修正するものではありません。

hex がもたらすのは透明性と相互運用性です。`double` の10進テキストは値によって形が変わり、どのビットが立っているかについては不透明です。hex 形式は正規です。異なる `double` はそれぞれ単一の hex 文字列に対応し、その文字列はプラットフォームや言語をまたいでバイト単位で比較できます。参照ファイルを使ったテストで期待値を固定している場合、末尾の小数点1桁の1文字のずれは実際に頭痛の種になります。hex は比較を正確かつ明白にします。

## どこで役立つか

最も明確な利点は言語間の相互運用性です。`%a` で float をログ出力するネイティブ ライブラリや、C++ コードベースと共有する数値テスト スイートは、.NET がいまや直接取り込める hex を生成します。

```csharp
// From a C++ component that printed with %a
string fromNative = "0X1.5BF0A8B145769P+1"; // ~2.718281828...
double e = double.Parse(fromNative, NumberStyles.HexFloat);
```

`Half` と `float` も同じ扱いを受けるため、ML パイプラインや GPU バッファーから出てくる半精度の値も、10進テキストを経由する損失のあるホップなしで往復できます。[Preview 4 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) を入手し、`net11.0` をターゲットにすれば、次にテスト フィクスチャやデバッグ ダンプ用に float をシリアライズする必要があるとき、`BitConverter.DoubleToInt64Bits` で手作業の小細工をする代わりに `"X"` を使えます。
