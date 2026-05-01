---
title: ".NET 8 JsonStringEnumConverter mit native AOT verwenden"
description: "Erfahren Sie, wie Sie den neuen JsonStringEnumConverter<TEnum> in .NET 8 für eine native AOT-kompatible Enum-Serialisierung mit System.Text.Json einsetzen."
pubDate: 2023-09-17
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot"
translatedBy: "claude"
translationDate: 2026-05-01
---
[JsonStringEnumConverter](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter) ist mit native AOT nicht kompatibel. Um das zu beheben, führt .NET 8 einen neuen Konvertertyp ein: [JsonStringEnumConverter<TEnum>](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter-1?view=net-8.0), der mit native AOT funktioniert.

Um den neuen Typ zu nutzen, annotieren Sie Ihre Typen einfach so:

```cs
[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]
public enum MyEnum { Foo, Bar }

[JsonSerializable(typeof(MyEnum))]
public partial class MyJsonSerializerContext : JsonSerializerContext { }
```

Beachten Sie: Die Deserialisierung von Enums ist case-insensitiv, die Serialisierung lässt sich über [JsonNamingPolicy](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonnamingpolicy?view=net-8.0) anpassen.

## Was passiert, wenn Sie JsonStringEnumConverter mit NativeAOT verwenden?

Das erste Warnzeichen sehen Sie bereits beim Kompilieren, in Form folgender Warnung:

> Using member 'System.Text.Json.Serialization.JsonStringEnumConverter.JsonStringEnumConverter()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. JSON serialization and deserialization might require types that cannot be statically analyzed and might need runtime code generation. Use System.Text.Json source generation for native AOT applications.

Beim Ausführen des kompilierten Codes erhalten Sie dann eine Laufzeit-Exception:

> System.Reflection.MissingMetadataException: 'System.Text.Json.Serialization.Converters.EnumConverter<MyEnum>' is missing metadata.
