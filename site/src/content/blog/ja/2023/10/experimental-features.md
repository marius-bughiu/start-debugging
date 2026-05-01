---
title: "C# 機能を experimental としてマークする方法"
description: "C# 12 から、新しい ExperimentalAttribute を使って型、メソッド、プロパティ、アセンブリを experimental としてマークできるようになりました。diagnosticId、pragma タグ、UrlFormat と組み合わせた使い方を紹介します。"
pubDate: 2023-10-29
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/experimental-features"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 12 から、型、メソッド、プロパティ、アセンブリを experimental な機能としてマークできる新しい `ExperimentalAttribute` が追加されました。これを使うと、利用箇所でコンパイラーの警告が出るようになり、その警告は `#pragma` タグで無効化できます。

`Experimental` 属性は、コンストラクターで `diagnosticId` パラメーターを受け取ることが必須です。この diagnostic ID は、experimental な機能が利用されるたびに生成されるコンパイラーのエラーメッセージの一部になります。注意: 同じ diagnostic-id を複数の属性で使い回しても問題ありません。

**重要:** `diagnosticId` にハイフン (`-`) などの特殊文字を使わないでください。`#pragma` の構文が壊れ、ユーザーが警告を無効化できなくなる可能性があります。たとえば diagnostic id に `BAR-001` を使うと、警告を抑制できないだけでなく、pragma タグ側でコンパイラーの警告が発生します。

> CS1696 Single-line comment or end-of-line expected.

[![](/wp-content/uploads/2023/10/image-3.png)](/wp-content/uploads/2023/10/image-3.png)

属性内に `UrlFormat` を指定して、experimental な機能に関するドキュメントへ開発者を誘導することもできます。`https://acme.com/warnings/BAR001` のような絶対 URL を指定する方法と、`https://acme.com/warnings/{0}` のような汎用的な文字列フォーマットの URL を指定してフレームワークに任せる方法があります。

いくつかの例を見ていきましょう。

## メソッドを experimental としてマークする

```cs
using System.Diagnostics.CodeAnalysis;

[Experimental("BAR001")]
void Foo() { }
```

メソッドに `Experimental` 属性を付け、`diagnosticId` を指定するだけです。`Foo()` の呼び出しに対して、次のようなコンパイラー警告が出ます。

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.

この警告は pragma タグで回避できます。

```cs
#pragma warning disable BAR001
Foo();
#pragma warning restore BAR001
```

## ドキュメントへのリンクを指定する

上で触れたとおり、属性の `UrlFormat` プロパティを使ってドキュメントへのリンクを指定できます。これは完全に任意です。

```cs
[Experimental("BAR001", UrlFormat = "https://acme.com/warnings/{0}")]
void Foo() { }
```

こうしておくと、Visual Studio でエラーコードをクリックしたときに、指定したドキュメントページに飛べるようになります。さらに、URL が診断エラーメッセージにも出力されます。

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed. (https://acme.com/warnings/BAR001)

## その他の使い方

この属性は、思いつくほとんどの場所に付けられます。アセンブリ、モジュール、クラス、構造体、enum、プロパティ、フィールド、イベントなど、何でも対応しています。利用可能な場所の完全な一覧は、定義そのものから確認できます。

```cs
[AttributeUsage(AttributeTargets.Assembly |
                AttributeTargets.Module |
                AttributeTargets.Class |
                AttributeTargets.Struct |
                AttributeTargets.Enum |
                AttributeTargets.Constructor |
                AttributeTargets.Method |
                AttributeTargets.Property |
                AttributeTargets.Field |
                AttributeTargets.Event |
                AttributeTargets.Interface |
                AttributeTargets.Delegate, Inherited = false)]
public sealed class ExperimentalAttribute : Attribute { ... }
```
