---
title: ".NET 8 JsonSerializerOptions als readonly markieren"
description: "Erfahren Sie, wie Sie in .NET 8 mit MakeReadOnly JsonSerializerOptions-Instanzen schreibgeschützt machen und über IsReadOnly prüfen, ob sie es sind."
pubDate: 2023-09-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/net-8-mark-jsonserializeroptions-as-readonly"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 8 können Sie `JsonSerializerOptions`-Instanzen als schreibgeschützt markieren und so weitere Änderungen verhindern. Um eine Instanz einzufrieren, rufen Sie einfach `MakeReadOnly` auf der Options-Instanz auf.

Hier ein Beispiel:

```cs
var options = new JsonSerializerOptions
{
    AllowTrailingCommas = true,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper,
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate,
};

options.MakeReadOnly();
```

Ob eine Instanz bereits eingefroren wurde, prüfen Sie über die Eigenschaft `IsReadOnly`.

```cs
options.IsReadOnly
```

Wer versucht, eine `JsonSerializerOptions`-Instanz nach dem Markieren als readonly noch zu verändern, erhält eine `InvalidOperationException`:

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
```

## Überladung [`MakeReadOnly(bool populateMissingResolver)`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly#system-text-json-jsonserializeroptions-makereadonly\(system-boolean\))

Wenn `populateMissingResolver` als `true` übergeben wird, ergänzt die Methode bei Bedarf den standardmäßigen reflection-basierten Resolver in Ihren `JsonSerializerOptions`. Vorsicht beim [Einsatz dieser Methode in trimmed / Native AOT-Anwendungen: Sie zieht die reflection-bezogenen Assemblies in Ihren Build](/2023/10/system-text-json-disable-reflection-based-serialization/).
