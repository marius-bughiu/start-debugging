---
title: "RegexOptions.AnyNewLine が .NET 11 Preview 3 に着陸: \\r? ハックなしの Unicode 対応アンカー"
description: ".NET 11 Preview 3 が RegexOptions.AnyNewLine を追加し、^、$、\\Z、そして . が \\r\\n、NEL、LS、PS を含むあらゆる Unicode newline シーケンスを認識するようになり、\\r\\n は 1 つのアトミックなブレークとして扱われます。"
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "csharp"
lang: "ja"
translationOf: "2026/04/regex-anynewline-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

.NET で multiline regex を書いて、Windows と Unix ファイル両方で安全にいるために `\r?$` に手を伸ばしたことがあるなら、その回避策がついに消えていきます。.NET 11 Preview 3 は `RegexOptions.AnyNewLine` を導入し、Unicode の完全なラインターミネータセットをエンジンに教え、それぞれを手で綴らせません。

このオプションは dotnet/runtime issue [25598](https://github.com/dotnet/runtime/issues/25598) で要求され、2026 年 4 月 14 日の Preview 3 ドロップで出荷されました。詳細は [.NET 11 Preview 3 アナウンス](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) にあります。

## オプションが実際に変えること

`RegexOptions.AnyNewLine` がセットされていると、アンカー `^`、`$`、`\Z`、さらに `Singleline` が有効でないときの `.` が、Unicode TR18 RL1.6 が定義するすべての一般的な newline シーケンスを認識します:

- `\r\n` (CR+LF)
- `\r` (CR)
- `\n` (LF)
- `\u0085` (NEL, Next Line)
- `\u2028` (Line Separator)
- `\u2029` (Paragraph Separator)

決定的に重要なのは、`\r\n` がアトミックなシーケンスとして扱われることです。つまり `^` は `\r` と `\n` の間で発火せず、`.` は `\r` だけを消費して `\n` をぶら下がらせることをしません。その単一の挙動が、regex-heavy パーサーが何年も抱えてきた一群のクロスプラットフォームバグを消去します。

## Before と after

Windows で編集され、次に Linux で編集され、次に古い Mac ツールを通ったミックスファイルから、すべての非空行が欲しいとしましょう。.NET 10 では newline のフレーバーごとに手動で補償します:

```csharp
// .NET 10 style: opt in to every flavor manually
var legacy = new Regex(
    @"^(?<line>.+?)(?:\r?\n|\u2028|\u2029|\u0085|\z)",
    RegexOptions.Multiline);
```

.NET 11 Preview 3 では同じ意図が次のように圧縮されます:

```csharp
using System.Text.RegularExpressions;

var modern = new Regex(
    @"^(?<line>.+)$",
    RegexOptions.Multiline | RegexOptions.AnyNewLine);

string input = "first\r\nsecond\nthird\u2028fourth\u2029fifth\u0085sixth";

foreach (Match m in modern.Matches(input))
{
    Console.WriteLine(m.Groups["line"].Value);
}
```

どの行もクリーンに印字され、手動補償なし、そして Windows 入力でも `\r` がキャプチャされたグループに漏れることはありません。

## 結合を拒否する組み合わせ

2 つの組み合わせは構築時に拒否されます。どちらも `ArgumentOutOfRangeException` を投げます:

```csharp
// Both throw at construction
new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.NonBacktracking);

new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.ECMAScript);
```

`NonBacktracking` エンジンは独自の newline モデルを DFA に焼き付け、`ECMAScript` フレーバーは意図的に ECMA-262 セマンティクスに固定されています。どちらかに静かに Unicode セットを継承させると、呼び出し側が容易に検出できない形でマッチ挙動が変わってしまうので、runtime は予期しないマッチを実行時に生むのではなく、構築時に大きく失敗します。

`RegexOptions.Singleline` は友好的な組み合わせです。`Singleline` と `AnyNewLine` を両方セットすると、`.` は newline を含むすべての文字にマッチし、`^`、`$`、`\Z` は完全な Unicode アンカー挙動を保ちます。

## ログとコンテンツパーサーにとってなぜ重要か

.NET codebase のほとんどの自家製 `\r?\n` shim が存在するのは、デフォルトの regex 挙動が `\n` だけを改行として扱うからです。ログ、CSV、RFC 822 ヘッダー、そしてターミナルから貼り付けられたコンテンツは、`\r\n` や迷子の `\u2028` が現れた瞬間にこれに当たります。すべての防御的 split、すべての「これは Windows ファイルか」チェック、Unicode セパレータがバッファに滑り込んだときのすべての off-by-one が、その税金を払ってきました。

`RegexOptions.AnyNewLine` は小さな API ですが、長年のクロスプラットフォーム regex バグの源を取り除きます。.NET でパーサー、log shipper、text indexer を保守しているなら、Preview 3 はそれらの回避策をついに刈り込み始められるリリースです。
