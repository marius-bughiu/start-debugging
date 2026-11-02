---
title: ".NET 8 JsonSerializerOptions を readonly としてマークする"
description: "MakeReadOnly で JsonSerializerOptions を固定し、TypeInfoResolver 未設定のエラーを解消して変更可能なコピーを作る .NET 8 サンプルです。"
pubDate: 2023-09-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/net-8-mark-jsonserializeroptions-as-readonly"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 以降では `JsonSerializerOptions.MakeReadOnly()` でオプションを固定できます。先に `TypeInfoResolver` を設定してください。新しいオプションインスタンスにはリゾルバーがないため、そのまま引数なしのメソッドを呼ぶと `InvalidOperationException` が発生します。

> **訂正 — 2026 年 11 月 2 日:** 旧サンプルにはリゾルバーがなく、`MakeReadOnly()` で失敗していました。以下では生成済みのメタデータを使用し、既定のリフレクションを無効にした状態でも動作します。

## 設定済みのオプションを固定する

次の完全な `Program.cs` は、ソース生成リゾルバーを設定し、固定済みのオプションでシリアライズして、後からの変更が拒否されることと、独立して設定できるコピーを確認します。

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper
};
options.MakeReadOnly();
Console.WriteLine(options.IsReadOnly);
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), options));

try
{
    options.WriteIndented = true;
}
catch (InvalidOperationException)
{
    Console.WriteLine("Mutation rejected");
}

var copy = new JsonSerializerOptions(options);
Console.WriteLine(copy.IsReadOnly);
copy.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), copy));

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

出力は次のとおりです。

```text
True
{"ID":42,"NAME":"Ada"}
Mutation rejected
False
{"id":42,"name":"Ada"}
```

固定後は `IsReadOnly` が `true` になります。`MakeReadOnly()` は繰り返し呼び出してもかまいません。固定後に設定を変更すると `InvalidOperationException` が発生します。シリアライズまたは逆シリアライズで使用しても、オプションは読み取り専用になります。

コピーコンストラクターはリゾルバーを含む設定を引き継ぎますが、新しいインスタンスは変更可能です。最初に使用する前にコピーを設定してください。コピーもシリアライズで使用すると固定されます。

## リゾルバーがないと MakeReadOnly が失敗する理由

`new JsonSerializerOptions().MakeReadOnly()` はリゾルバーを自動で選択しません。上のように明示的に設定するか、リフレクションによるシリアライズを意図し、それが有効な場合に `MakeReadOnly(populateMissingResolver: true)` を使います。

このオーバーロードは、未設定のリゾルバーを既定のリフレクションリゾルバーで補います。既定のリフレクションが無効なら、この不足を補えず `InvalidOperationException` を投げます。トリミングや Native AOT を使用するアプリで、生成メタデータの代わりにはなりません。[既定のリフレクションの無効化とコンテキストの設定](/ja/2023/10/system-text-json-disable-reflection-based-serialization/)と [MakeReadOnly の API 契約](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly?view=net-8.0)を参照してください。

## 検証済みのサンプルを実行する

[System.Text.Json オプションの完全なプロジェクトをダウンロード](/examples/system-text-json-options.zip)し、展開して次を実行します。

```sh
dotnet run -c Release
```

追加の依存関係がない .NET 8 プロジェクトで、リゾルバー未設定、固定の繰り返し、変更の拒否、生成メタデータでのシリアライズ、コピーの挙動を検証します。`populateMissingResolver` は既定のリフレクションを無効にした場合と有効にした場合を分けて確認しています。実際の .NET 8.0.33 と .NET 10.0.10 ランタイムで全項目が成功しました。コマンドと結果はアーカイブの検証記録にあります。
