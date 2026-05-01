---
title: ".NET 8 cómo usar JsonStringEnumConverter con native AOT"
description: "Aprende a usar el nuevo JsonStringEnumConverter<TEnum> en .NET 8 para una serialización de enums compatible con native AOT en System.Text.Json."
pubDate: 2023-09-17
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot"
translatedBy: "claude"
translationDate: 2026-05-01
---
[JsonStringEnumConverter](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter) no es compatible con native AOT. Para solucionarlo, .NET 8 introduce un nuevo tipo de converter, [JsonStringEnumConverter<TEnum>](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter-1?view=net-8.0), que sí es compatible con native AOT.

Para usar el nuevo tipo, simplemente anota tus tipos así:

```cs
[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]
public enum MyEnum { Foo, Bar }

[JsonSerializable(typeof(MyEnum))]
public partial class MyJsonSerializerContext : JsonSerializerContext { }
```

Ten en cuenta: la deserialización de enums no distingue mayúsculas y minúsculas, mientras que la serialización se puede personalizar con [JsonNamingPolicy](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonnamingpolicy?view=net-8.0).

## ¿Qué pasa si intentas usar JsonStringEnumConverter con NativeAOT?

La primera señal de aviso aparecerá durante la compilación, donde recibirás un warning:

> Using member 'System.Text.Json.Serialization.JsonStringEnumConverter.JsonStringEnumConverter()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. JSON serialization and deserialization might require types that cannot be statically analyzed and might need runtime code generation. Use System.Text.Json source generation for native AOT applications.

Después, al ejecutar el código compilado, obtendrás una excepción en tiempo de ejecución:

> System.Reflection.MissingMetadataException: 'System.Text.Json.Serialization.Converters.EnumConverter<MyEnum>' is missing metadata.
