---
title: ".NET 8 – Deserialize into read-only properties"
description: "Learn how to deserialize JSON into read-only properties without a setter in .NET 8 using JsonObjectCreationHandling or JsonSerializerOptions."
pubDate: 2023-09-03
updatedDate: 2023-11-05
tags:
  - "net"
  - "net-8"
---
Starting with .NET 8 you can deserialize into properties which do not have a `set` accessor. You can opt-in for this behavior using `JsonSerializerOptions`, or on a per-type basis using the `JsonObjectCreationHandling` attribute.

## Using JsonObjectCreationHandling attribute

You can annotate your type with the `System.Text.Json.Serialization.JsonObjectCreationHandling` attribute, passing your option as a parameter.

```cs
[JsonObjectCreationHandling(JsonObjectCreationHandling.Populate)]
public class Foo
{
     public int Bar { get; }
}
```

## Using JsonSerializerOptions

You can set the `JsonSerializerOptions.PreferredObjectCreationHandling` property to `Populate` and pass it along to the `Deserialize` method.

```cs
new JsonSerializerOptions 
{ 
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate
};
```
