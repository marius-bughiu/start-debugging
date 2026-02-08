---
title: ".NET 8 – How to use JsonStringEnumConverter with native AOT"
description: "Learn how to use the new JsonStringEnumConverter<TEnum> in .NET 8 for native AOT-compatible enum serialization with System.Text.Json."
pubDate: 2023-09-17
updatedDate: 2023-11-05
tags:
  - "c-sharp"
  - "net"
  - "net-8"
---
[JsonStringEnumConverter](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter) is not compatible with native AOT. To fix that, .NET 8 introduces a new converter type [JsonStringEnumConverter<TEnum>](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenumconverter-1?view=net-8.0) that is compatible with native AOT.

To use the new type, simply annotate your types as follows:

```cs
[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]
public enum MyEnum { Foo, Bar }

[JsonSerializable(typeof(MyEnum))]
public partial class MyJsonSerializerContext : JsonSerializerContext { }
```

Keep in mind: enum deserialization is case insensitive, while serialization can be customized via [JsonNamingPolicy](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonnamingpolicy?view=net-8.0).

## What happens if you try to use JsonStringEnumConverter and NativeAOT?

The first warning sign you will see is during compilation, where you will get a warning that:

> Using member ‘System.Text.Json.Serialization.JsonStringEnumConverter.JsonStringEnumConverter()’ which has ‘RequiresDynamicCodeAttribute’ can break functionality when AOT compiling. JSON serialization and deserialization might require types that cannot be statically analyzed and might need runtime code generation. Use System.Text.Json source generation for native AOT applications.

Then, when running the compiled code, you will get a runtime exception:

> System.Reflection.MissingMetadataException: ‘System.Text.Json.Serialization.Converters.EnumConverter<MyEnum>’ is missing metadata.
