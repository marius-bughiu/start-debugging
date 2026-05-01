---
title: ".NET 8 JsonSerializerOptions を readonly としてマークする"
description: ".NET 8 で MakeReadOnly を使って JsonSerializerOptions のインスタンスを読み取り専用にする方法と、IsReadOnly プロパティでそれを確認する方法を解説します。"
pubDate: 2023-09-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/net-8-mark-jsonserializeroptions-as-readonly"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 から、`JsonSerializerOptions` のインスタンスを読み取り専用としてマークし、それ以降の変更を防げるようになりました。インスタンスをフリーズするには、options インスタンスに対して `MakeReadOnly` を呼び出すだけです。

例を見てみましょう。

```cs
var options = new JsonSerializerOptions
{
    AllowTrailingCommas = true,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper,
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate,
};

options.MakeReadOnly();
```

さらに、インスタンスがフリーズされているかどうかは `IsReadOnly` プロパティで確認できます。

```cs
options.IsReadOnly
```

読み取り専用としてマークしたあとに `JsonSerializerOptions` インスタンスを変更しようとすると、`InvalidOperationException` が発生します。

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
```

## [`MakeReadOnly(bool populateMissingResolver)`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly#system-text-json-jsonserializeroptions-makereadonly\(system-boolean\)) のオーバーロード

`populateMissingResolver` に `true` を渡すと、このメソッドは必要に応じて `JsonSerializerOptions` にデフォルトのリフレクションベースの resolver を追加します。[trimmed / Native AOT アプリケーションでこのメソッドを使う](/2023/10/system-text-json-disable-reflection-based-serialization/) と、リフレクション関連のアセンブリがビルドに取り込まれてしまうので注意してください。
