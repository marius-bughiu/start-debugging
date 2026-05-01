---
title: ".NET 8 native AOT で JsonStringEnumConverter を使う方法"
description: ".NET 8 で追加された JsonStringEnumConverter<TEnum> を使って、System.Text.Json で native AOT 対応の enum シリアライズを行う方法を解説します。"
pubDate: 2023-09-17
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot"
translatedBy: "claude"
translationDate: 2026-05-01
---
[JsonStringEnumConverter](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter) は native AOT に対応していません。これを解決するため、.NET 8 では native AOT に対応した新しいコンバーター型 [JsonStringEnumConverter<TEnum>](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter-1?view=net-8.0) が導入されました。

新しい型を使うには、次のように型に注釈を付けるだけです。

```cs
[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]
public enum MyEnum { Foo, Bar }

[JsonSerializable(typeof(MyEnum))]
public partial class MyJsonSerializerContext : JsonSerializerContext { }
```

注意点として、enum のデシリアライズは大文字・小文字を区別しません。一方、シリアライズは [JsonNamingPolicy](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonnamingpolicy?view=net-8.0) でカスタマイズできます。

## JsonStringEnumConverter と NativeAOT を組み合わせるとどうなるか?

最初の警告サインはコンパイル時に表示されます。次のような警告が出ます。

> Using member 'System.Text.Json.Serialization.JsonStringEnumConverter.JsonStringEnumConverter()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. JSON serialization and deserialization might require types that cannot be statically analyzed and might need runtime code generation. Use System.Text.Json source generation for native AOT applications.

そして、コンパイル済みのコードを実行すると、次のランタイム例外が発生します。

> System.Reflection.MissingMetadataException: 'System.Text.Json.Serialization.Converters.EnumConverter<MyEnum>' is missing metadata.
