---
title: ".NET 8 nicht-öffentliche Member in die JSON-Serialisierung einbeziehen"
description: "Erfahren Sie, wie Sie in .NET 8 mit dem Attribut JsonInclude private, protected und internal Properties in die JSON-Serialisierung aufnehmen."
pubDate: 2023-09-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/net-8-include-non-public-members-in-json-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 8 lassen sich beim Einsatz von `System.Text.Json` auch nicht-öffentliche Properties in die Serialisierung einbeziehen. Dazu versehen Sie die nicht-öffentliche Property einfach mit dem Attribut [JsonIncludeAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonincludeattribute?view=net-8.0).

```cs
[System.AttributeUsage(System.AttributeTargets.Field | System.AttributeTargets.Property, AllowMultiple=false)]
public sealed class JsonIncludeAttribute : System.Text.Json.Serialization.JsonAttribute
```

Das Attribut funktioniert mit jedem nicht-öffentlichen Modifier, also `private`, `protected` oder `internal`. Sehen wir uns ein Beispiel an:

```cs
string json = JsonSerializer.Serialize(new MyClass(1, 2, 3));

Console.WriteLine(json);

public class MyClass
{
    public MyClass(int privateProperty, int protectedProperty, int internalProperty)
    {
        PrivateProperty = privateProperty;
        ProtectedProperty = protectedProperty;
        InternalProperty = internalProperty;
    }

    [JsonInclude]
    private int PrivateProperty { get; }

    [JsonInclude]
    protected int ProtectedProperty { get; }

    [JsonInclude]
    internal int InternalProperty { get; }
}
```

Wie zu erwarten, ergibt das die folgende Ausgabe:

```json
{"PrivateProperty":1,"ProtectedProperty":2,"InternalProperty":3}
```
