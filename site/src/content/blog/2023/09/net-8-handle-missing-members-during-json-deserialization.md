---
title: ".NET 8 – Handle missing members during JSON deserialization"
description: "Learn how to throw exceptions for unmapped JSON properties during deserialization in .NET 8 using JsonUnmappedMemberHandling."
pubDate: 2023-09-02
updatedDate: 2023-11-05
tags:
  - "net"
  - "net-8"
---
By default, if you have additional properties in a JSON payload you are trying to deserialize, they are simply ignored. But what if you wanted the deserialization to fail and throw an exception when there are extra properties in the JSON? That is possible starting with .NET 8.

There are several ways in which you can opt in for this behavior when using the `System.Text.Json` serializer.

## 1\. Using the JsonUnmappedMemberHandling attribute

You can annotate your type with the `[System.Text.Json.Serialization.JsonUnmappedMemberHandlingAttribute]`, passing your option as a parameter.

```cs
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public class Foo
{
     public int Bar { get; set; }
}
```

## 2\. Using JsonSerializerOptions

You can set the `JsonSerializerOptions.UnmappedMemberHandling` property to `Disallow` and pass it along to the `Deserialize` method.

```cs
new JsonSerializerOptions 
{ 
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow 
};
```

## An exception is thrown

Be ready to catch it. With `JsonUnmappedMemberHandling` set to `Disallow`, the following exception will be thrown when deserializing a JSON payload with additional members.

> **System.Text.Json.JsonException**: ‘The JSON property ‘<property name>’ could not be mapped to any .NET member contained in type ‘<namespace>+<type name>’.’
