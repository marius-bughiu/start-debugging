---
title: ".NET 8 como usar JsonStringEnumConverter com native AOT"
description: "Aprenda a usar o novo JsonStringEnumConverter<TEnum> no .NET 8 para serializar enums no System.Text.Json de forma compatível com native AOT."
pubDate: 2023-09-17
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot"
translatedBy: "claude"
translationDate: 2026-05-01
---
O [JsonStringEnumConverter](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter) não é compatível com native AOT. Para resolver isso, o .NET 8 traz um novo tipo de converter, [JsonStringEnumConverter<TEnum>](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter-1?view=net-8.0), que é compatível com native AOT.

Para usar o novo tipo, basta anotar seus tipos da seguinte forma:

```cs
[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]
public enum MyEnum { Foo, Bar }

[JsonSerializable(typeof(MyEnum))]
public partial class MyJsonSerializerContext : JsonSerializerContext { }
```

Lembre-se: a desserialização de enums é case insensitive, enquanto a serialização pode ser customizada via [JsonNamingPolicy](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonnamingpolicy?view=net-8.0).

## O que acontece se você tentar usar JsonStringEnumConverter com NativeAOT?

O primeiro sinal aparece durante a compilação, com um aviso:

> Using member 'System.Text.Json.Serialization.JsonStringEnumConverter.JsonStringEnumConverter()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. JSON serialization and deserialization might require types that cannot be statically analyzed and might need runtime code generation. Use System.Text.Json source generation for native AOT applications.

Em seguida, ao executar o código compilado, você recebe uma exceção em tempo de execução:

> System.Reflection.MissingMetadataException: 'System.Text.Json.Serialization.Converters.EnumConverter<MyEnum>' is missing metadata.
