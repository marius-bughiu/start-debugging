---
title: "System.Text.Json – Disable reflection-based serialization"
description: "Learn how to disable reflection-based serialization in System.Text.Json starting with .NET 8 for trimmed and native AOT applications using the JsonSerializerIsReflectionEnabledByDefault property."
pubDate: 2023-10-21
updatedDate: 2023-11-05
tags:
  - "net"
  - "net-8"
---
Starting with .NET 8 you can disable the default reflection-based serializer that comes with `System.Text.Json`. This can be useful in trimmed and native AOT applications where you don’t want to include the reflection components in your build.

You can enable this feature by setting the `JsonSerializerIsReflectionEnabledByDefault` property to `false` in your `.csproj` file.

```xml
<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
```

As a side-effect, you will be required to provide a `JsonSerializerOptions` during serialization and deserialization. Failing to do so will result in a `NotSupportedException` at runtime.

Along with this option, a new `IsReflectionEnabledByDefault` property is introduced on the `JsonSerializer`, allowing developers to do a runtime check to see whether the feature is on or off.
