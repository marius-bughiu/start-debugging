---
title: "System.Text.Json リフレクションベースのシリアライズを無効化する"
description: "System.Text.Json の既定のリフレクションを無効にし、InvalidOperationException の原因と生成コンテキストによるシリアライズを実行可能な .NET 8 サンプルで確認します。"
pubDate: 2023-10-21
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/system-text-json-disable-reflection-based-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 以降では、`JsonSerializerIsReflectionEnabledByDefault` を `false` に設定すると、`System.Text.Json` の既定のリフレクションへのフォールバックを無効にできます。その場合、ソース生成コンテキストからシリアライズ用のメタデータを渡します。

> **訂正 — 2026 年 11 月 2 日:** 旧版では例外の種類を誤記し、オプションを渡すだけで十分であるかのように説明していました。既定のリフレクションを無効にした状態で通常のシリアライズを行うと `InvalidOperationException` が発生します。空のオプションでは解決しません。

## 既定のリフレクションを無効にする

`.csproj` に次のプロパティを追加します。

```xml
<PropertyGroup>
  <JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

この設定では、`JsonSerializer.Serialize(widget)` と `JsonSerializer.Serialize(widget, new JsonSerializerOptions())` はどちらも失敗します。オプションを作成しても、型のメタデータは用意されません。`JsonSerializer.IsReflectionEnabledByDefault` でスイッチの実効値を確認できます。

このスイッチが制御するのはシリアライザーの既定のリフレクション処理であり、アプリ全体のリフレクションではありません。.NET 8 以降は、明示的に設定を上書きしない限り `PublishTrimmed` も既定のリフレクションを無効にします。[Microsoft のトリミング互換性に関する説明](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed)を参照してください。

## 生成したメタデータでシリアライズと逆シリアライズを行う

上のプロパティを設定した .NET 8 コンソールプロジェクトで、次の完全な `Program.cs` を使用します。

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault);
var widget = new Widget(42, "Ada");
string json = JsonSerializer.Serialize(widget, DemoJsonContext.Default.Widget);
Widget restored = JsonSerializer.Deserialize(json, DemoJsonContext.Default.Widget)!;
Console.WriteLine(json);
Console.WriteLine($"Round trip: {restored.Id} {restored.Name}");

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

出力は次のとおりです。

```text
False
{"Id":42,"Name":"Ada"}
Round trip: 42 Ada
```

`[JsonSerializable]` で `Widget` を登録し、コンテキストから生成済みの `JsonTypeInfo<Widget>` を直接渡しています。このオーバーロードでは別のオプションインスタンスは不要です。

API が `JsonSerializerOptions` を受け取る場合は、リゾルバーを明示的に設定します。

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default
};
string json = JsonSerializer.Serialize(widget, options);
```

必要なコレクション型も含め、実際にシリアライズするルート型を登録してください。モデルに列挙型がある場合は [Native AOT での JsonStringEnumConverter](/ja/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/)も参照できます。設定済みのオプションを固定して再利用する方法は [MakeReadOnly とリゾルバーの要件](/ja/2023/09/net-8-mark-jsonserializeroptions-as-readonly/)で説明しています。

## 検証済みのサンプルを実行する

[System.Text.Json オプションの完全なプロジェクトをダウンロード](/examples/system-text-json-options.zip)し、展開して次を実行します。

```sh
dotnet run -c Release
```

追加の依存関係がないこの .NET 8 プロジェクトは、失敗する既定の呼び出し、生成メタデータでの往復処理、オプションのリゾルバー経由の処理を確認します。読み取り専用オプションの検証も含まれます。実際の .NET 8.0.33 と .NET 10.0.10 ランタイムで全項目を実行しました。個別のコマンドはアーカイブに記録しています。同じプロジェクトを .NET 8 Native AOT として macOS arm64 向けに発行し、実行する検証も行いました。意図的な失敗の検証とリフレクションに関係するオーバーロードでは解析警告が発生するため、検証記録に明記しています。

対応する型やアプリへの組み込みについては [Microsoft のソース生成ガイド](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)を参照してください。
