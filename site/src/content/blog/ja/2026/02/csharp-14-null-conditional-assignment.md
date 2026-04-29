---
title: "C# 14 の null 条件代入: ?. と ?[] を左辺で使う"
description: "C# 14 は null 条件演算子を代入の左辺でも動作するように拡張し、プロパティやインデクサーを設定する際の冗長な null チェックを排除します。"
pubDate: 2026-02-08
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "null-safety"
lang: "ja"
translationOf: "2026/02/csharp-14-null-conditional-assignment"
translatedBy: "claude"
translationDate: 2026-04-29
---

C# 14 は小さくとも影響力のある変更をもたらします。null 条件演算子 `?.` と `?[]` が代入の左辺でも使えるようになりました。これにより、プロパティ代入を null チェックでラップする一般的なパターンが不要になります。

## 置き換えられる冗長なパターン

C# 14 以前は、オブジェクトが null でない場合にのみプロパティに代入するには、明示的なチェックが必要でした。

```csharp
if (customer is not null)
{
    customer.LastOrderDate = DateTime.UtcNow;
}

if (settings is not null)
{
    settings["theme"] = "dark";
}
```

深くネストされたオブジェクトでは、これがさらに悪化していました。

```csharp
if (order?.Customer?.Address is not null)
{
    order.Customer.Address.IsVerified = true;
}
```

## C# 14 の null 条件代入

C# 14 では、同じロジックをより簡潔に書くことができます。

```csharp
customer?.LastOrderDate = DateTime.UtcNow;

settings?["theme"] = "dark";

order?.Customer?.Address?.IsVerified = true;
```

代入は左辺が null 以外の参照に評価された場合にのみ実行されます。対象が null の場合、右辺は評価されません。

## 動作の仕組み

式 `P?.A = B` は次と同等です。

```csharp
if (P is not null)
{
    P.A = B;
}
```

ただし重要な違いがあります。`P` は一度しか評価されません。これは `P` がメソッド呼び出しであったり副作用がある場合に重要です。

## 複合代入演算子

null 条件代入は `+=`、`-=`、`*=` などの複合演算子でも動作します。

```csharp
inventory?.StockLevel += restockAmount;

counter?.Value -= 1;

account?.Balance *= interestRate;
```

これらはいずれも左辺を一度評価し、対象が null でない場合にのみ操作を適用します。

## インクリメントとデクリメントは許可されない

ひとつの制限として、`++` と `--` 演算子は null 条件代入では使えません。次のコードはコンパイルできません。

```csharp
// Error: ++ and -- not allowed
counter?.Value++;
```

代わりに複合代入を使用します。

```csharp
counter?.Value += 1;
```

## 実用例: イベントハンドラー

一般的なユースケースは、イベントハンドラーを条件付きで設定することです。

```csharp
public void Initialize(Button? submitButton, Button? cancelButton)
{
    submitButton?.Click += OnSubmit;
    cancelButton?.Click += OnCancel;
}
```

null 条件代入がなければ、ボタンごとに別々の null チェックが必要になります。

## インデクサーとの連鎖

`?[]` 演算子はインデクサー代入でも同じように動作します。

```csharp
Dictionary<string, string>? headers = GetHeaders();

headers?["Authorization"] = $"Bearer {token}";
headers?["Content-Type"] = "application/json";
```

`headers` が null の場合、いずれの代入も実行されず、例外もスローされません。

## 使いどころ

null 条件代入は次のような場面で最も効果的です。
- 更新が必要かもしれないし、不要かもしれないオプショナルなオブジェクトを扱う場合
- null 許容参照型を使用しており、冗長な null チェックを避けたい場合
- 代入が fire-and-forget の操作で、実行されたかどうかを知る必要がない場合

この機能は .NET 10 と C# 14 で利用可能です。プロジェクトファイルで `<LangVersion>14</LangVersion>` を設定して有効にしてください。

完全な仕様については、[Microsoft Learn の Null 条件代入](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/null-conditional-assignment) を参照してください。
