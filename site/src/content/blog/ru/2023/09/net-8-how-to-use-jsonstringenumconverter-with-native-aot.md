---
title: ".NET 8 как использовать JsonStringEnumConverter с native AOT"
description: "Узнайте, как использовать новый JsonStringEnumConverter<TEnum> в .NET 8 для совместимой с native AOT сериализации перечислений в System.Text.Json."
pubDate: 2023-09-17
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot"
translatedBy: "claude"
translationDate: 2026-05-01
---
[JsonStringEnumConverter](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter) несовместим с native AOT. Чтобы это исправить, в .NET 8 появился новый тип конвертера — [JsonStringEnumConverter<TEnum>](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter-1?view=net-8.0), совместимый с native AOT.

Чтобы использовать новый тип, просто пометьте свои типы так:

```cs
[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]
public enum MyEnum { Foo, Bar }

[JsonSerializable(typeof(MyEnum))]
public partial class MyJsonSerializerContext : JsonSerializerContext { }
```

Имейте в виду: десериализация enum нечувствительна к регистру, а сериализацию можно настроить через [JsonNamingPolicy](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonnamingpolicy?view=net-8.0).

## Что произойдёт, если попробовать использовать JsonStringEnumConverter и NativeAOT?

Первый сигнал — на этапе компиляции, где вы получите предупреждение:

> Using member 'System.Text.Json.Serialization.JsonStringEnumConverter.JsonStringEnumConverter()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. JSON serialization and deserialization might require types that cannot be statically analyzed and might need runtime code generation. Use System.Text.Json source generation for native AOT applications.

А при запуске уже скомпилированного кода — исключение времени выполнения:

> System.Reflection.MissingMetadataException: 'System.Text.Json.Serialization.Converters.EnumConverter<MyEnum>' is missing metadata.
