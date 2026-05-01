---
title: "C# 11 の raw 文字列リテラル (三重引用符構文)"
description: "C# 11 の raw 文字列リテラル (三重引用符構文 `\"\"\"`) を使い、エスケープシーケンスなしで空白、改行、引用符を埋め込みます。ルールと例を紹介します。"
pubDate: 2023-03-15
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/03/c-raw-string-literals"
translatedBy: "claude"
translationDate: 2026-05-01
---
raw 文字列リテラルは、エスケープシーケンスを使わずに、空白、改行、埋め込まれた引用符などの特殊文字を文字列に含められる新しい形式です。

仕組みは次のとおりです。

-   raw 文字列リテラルは 3 つ以上のダブルクォート (**"""**) 文字で始まります。リテラルを囲むダブルクォートの数はユーザーが決められます。
-   先頭で使用したダブルクォートと同じ数のダブルクォートで終わります
-   複数行の raw 文字列リテラルでは、開始シーケンスと終了シーケンスをそれぞれ別の行に配置する必要があります。開始引用符の直後と終了引用符の直前の改行は、最終的な内容には含まれません。
-   閉じるダブルクォートの左側にある空白はすべて、文字列リテラルから (すべての行から) 削除されます (この点は後ほど詳しく説明します)
-   各行は、終了シーケンスと同じ量、もしくはそれ以上の空白で始まる必要があります
-   複数行の raw リテラルでは、開始シーケンスと同じ行で、その後ろに続く空白は無視されます

簡単な例です。

```cs
string rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
    """;
```

出力は次のようになります。

```plaintext
Lorem ipsum "dolor" sit amet,
    consectetur adipiscing elit.
```

## 終了シーケンス前の空白

終了ダブルクォートの前の空白が、raw 文字列式から削除される空白の量を決めます。先ほどの例では **"""** シーケンスの前に 4 つの空白があったので、式の各行から 4 つの空白が削除されました。終了シーケンスの前に 2 つの空白しかなければ、raw 文字列の各行から 2 つの空白だけが削除されます。

### 例: 終了シーケンスの前に空白がない場合

先ほどの例で、終了シーケンスの前に空白を一切指定しなければ、結果の文字列はインデントをそのままの形で保持します。

**式:**

```cs
string rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
""";
```

**出力:**

```plaintext
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
```

## 開始 / 終了シーケンスで 3 つを超えるダブルクォートを使う

raw 文字列の中身に 3 つのダブルクォートのシーケンスがあるときに役立ちます。次の例では raw 文字列リテラルの開始と終了に 5 つのダブルクォートを使い、本文には 3 つや 4 つのダブルクォートのシーケンスを含められます。

```cs
string rawString = """""
    3 double-quotes: """
    4 double-quotes: """"
    """"";
```

**出力:**

```plaintext
3 double-quotes: """
4 double-quotes: """"
```

## 関連するエラー

> CS8997: Unterminated raw string literal.

```cs
string rawString = """Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit. 
    """;
```

> CS9000: Raw string literal delimiter must be on its own line.

```cs
var rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.""";
```

> CS8999: Line does not start with the same whitespace as the closing line of the raw string literal.

```cs
var rawString = """
    Lorem ipsum "dolor" sit amet,
consectetur adipiscing elit.
    """;
```
