---
title: "System.Text.Json reflection-basierte Serialisierung deaktivieren"
description: "Erfahren Sie, wie Sie ab .NET 8 die reflection-basierte Serialisierung in System.Text.Json für trimmed und native AOT-Anwendungen über die Eigenschaft JsonSerializerIsReflectionEnabledByDefault deaktivieren."
pubDate: 2023-10-21
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/system-text-json-disable-reflection-based-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 8 können Sie den standardmäßig in `System.Text.Json` enthaltenen reflection-basierten Serializer deaktivieren. Das ist nützlich bei trimmed und native AOT-Anwendungen, bei denen Sie die Reflection-Komponenten nicht in Ihren Build aufnehmen möchten.

Sie aktivieren das, indem Sie in Ihrer `.csproj`-Datei die Eigenschaft `JsonSerializerIsReflectionEnabledByDefault` auf `false` setzen.

```xml
<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
```

Als Nebenwirkung müssen Sie bei Serialisierung und Deserialisierung ein `JsonSerializerOptions` mitgeben. Tun Sie das nicht, gibt es zur Laufzeit eine `NotSupportedException`.

Zusammen mit dieser Option gibt es auf `JsonSerializer` eine neue Eigenschaft `IsReflectionEnabledByDefault`, mit der Entwickler zur Laufzeit prüfen können, ob das Feature an- oder ausgeschaltet ist.
