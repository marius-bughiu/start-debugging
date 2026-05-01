---
title: "System.Text.Json リフレクションベースのシリアライズを無効化する"
description: ".NET 8 以降、JsonSerializerIsReflectionEnabledByDefault プロパティを使って、trimmed および native AOT アプリで System.Text.Json のリフレクションベースのシリアライズを無効化する方法を解説します。"
pubDate: 2023-10-21
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/system-text-json-disable-reflection-based-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 から、`System.Text.Json` に標準で含まれているリフレクションベースのシリアライザーを無効化できるようになりました。これは、リフレクション関連のコンポーネントをビルドに含めたくない trimmed や native AOT アプリで便利です。

この機能を有効にするには、`.csproj` ファイルで `JsonSerializerIsReflectionEnabledByDefault` プロパティを `false` に設定します。

```xml
<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
```

副作用として、シリアライズ時とデシリアライズ時に `JsonSerializerOptions` を渡すことが必須になります。指定しないと、実行時に `NotSupportedException` が発生します。

このオプションと合わせて、`JsonSerializer` に新しい `IsReflectionEnabledByDefault` プロパティが追加されており、開発者は実行時にこの機能のオン・オフを確認できます。
