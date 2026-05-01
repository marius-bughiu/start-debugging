---
title: "C# 11 - 補間付きの raw 文字列リテラル"
description: "C# 11 で補間付きの raw 文字列リテラルを使う方法を、波かっこのエスケープ、複数の $ 文字、条件演算子を含めて学びます。"
pubDate: 2023-03-17
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/03/c-11-interpolated-raw-string-literal"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 11 は [raw 文字列リテラル](/2023/03/c-raw-string-literals/) という概念を言語に導入し、それに伴って文字列補間に関する新機能も追加されています。

まず、これまでどおり補間構文を、raw 文字列リテラルと組み合わせて使えます。

```cs
var x = 5, y = 4;
var interpolatedRaw = $"""The sum of "{x}" and "{y}" is "{ x + y }".""";
```

出力は次のとおりです。

```plaintext
The sum of "5" and "4" is "9".
```

## 波かっこ { と } のエスケープ

波かっこは、それを 2 つ重ねることでエスケープできます。先ほどの例で波かっこを 2 つにしてみると、次のようになります。

```cs
var interpolatedRaw= $"""The sum of "{{x}}" and "{{y}}" is "{{ x + y }}".""";
```

出力は次のとおりです。

```plaintext
The sum of "{x}" and "{y}" is "{ x + y }".
```

ご覧のとおり、波かっこは補間の役割を持たなくなり、二重の波かっこはそれぞれ出力では単一の波かっことして現れます。

## 補間付き raw 文字列リテラルでの複数の $ 文字

補間付き raw 文字列リテラルでは、**"""** の連続と同様に、複数の **$** 文字を使用できます。文字列の先頭で使用する $ の個数によって、文字列補間に必要な { と } の個数が決まります。

例えば、以下の 2 つの文字列はどちらも、最初の例とまったく同じ結果を出力します。

```cs
var interpolatedRaw2 = $$"""The sum of "{{x}}" and "{{y}}" is "{{ x + y }}".""";
var interpolatedRaw3 = $$$"""The sum of "{{{x}}}" and "{{{y}}}" is "{{{ x + y }}}".""";
```

## 補間文字列内の条件演算子

コロン (:) は補間文字列内で特別な意味を持つため、条件式が動作するには追加の丸かっこ ( ) が必要です。例えば次のようになります。

```cs
var conditionalInterpolated = $"I am {x} year{(x == 1 ? "" : "s")} old.";
```

## エラー

> Error CS9006 The interpolated raw string literal does not start with enough '$' characters to allow this many consecutive opening braces as content.

このコンパイラーエラーは、文字列内に、先頭にある $ の個数の 2 倍以上の長さの連続した波かっこ列が含まれているときに発生します。
