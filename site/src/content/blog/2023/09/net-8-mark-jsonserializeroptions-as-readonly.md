---
title: ".NET 8 – Mark JsonSerializerOptions as readonly"
description: "Learn how to mark JsonSerializerOptions instances as read-only in .NET 8 using MakeReadOnly, and how to check the IsReadOnly property."
pubDate: 2023-09-11
updatedDate: 2023-11-05
tags:
  - "c-sharp"
  - "net"
  - "net-8"
---
Starting with .NET 8, you can mark `JsonSerializerOptions` instances as read-only, preventing further changes to the instance. To freeze the instance, simply call `MakeReadOnly` on the options instance.

Let’s take an example:

```cs
var options = new JsonSerializerOptions
{
    AllowTrailingCommas = true,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper,
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate,
};

options.MakeReadOnly();
```

Furthermore, you can check if an instance was frozen or not by checking the `IsReadOnly` property.

```cs
options.IsReadOnly
```

Attempting to modify a `JsonSerializerOptions` instance after it was marked as read only will result in an `InvalidOperationException`:

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
```

## [`MakeReadOnly(bool populateMissingResolver)`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly#system-text-json-jsonserializeroptions-makereadonly\(system-boolean\)) overload

When `populateMissingResolver` is passed as `true`, the method will go ahead and add the default reflection resolver to your `JsonSerializerOptions` when missing. Careful when [using this method in trimmed / Native AOT applications as it will root the reflection-related assemblies and include them in your build](/2023/10/system-text-json-disable-reflection-based-serialization/).
