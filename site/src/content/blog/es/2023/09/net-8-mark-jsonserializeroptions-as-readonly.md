---
title: ".NET 8 marcar JsonSerializerOptions como readonly"
description: "Aprende a marcar instancias de JsonSerializerOptions como de solo lectura en .NET 8 usando MakeReadOnly y a comprobar la propiedad IsReadOnly."
pubDate: 2023-09-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/net-8-mark-jsonserializeroptions-as-readonly"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8 puedes marcar instancias de `JsonSerializerOptions` como de solo lectura, impidiendo cambios posteriores en la instancia. Para congelar la instancia, basta con llamar a `MakeReadOnly` sobre la instancia de opciones.

Veamos un ejemplo:

```cs
var options = new JsonSerializerOptions
{
    AllowTrailingCommas = true,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper,
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate,
};

options.MakeReadOnly();
```

Además, puedes comprobar si una instancia fue congelada o no consultando la propiedad `IsReadOnly`.

```cs
options.IsReadOnly
```

Intentar modificar una instancia de `JsonSerializerOptions` después de marcarla como readonly resultará en una `InvalidOperationException`:

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
```

## Sobrecarga [`MakeReadOnly(bool populateMissingResolver)`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly#system-text-json-jsonserializeroptions-makereadonly\(system-boolean\))

Cuando se pasa `populateMissingResolver` como `true`, el método añadirá el resolver por defecto basado en reflexión a tus `JsonSerializerOptions` si falta. Cuidado al [usar este método en aplicaciones trimmed / Native AOT, ya que arrastrará los ensamblados relacionados con la reflexión y los incluirá en tu build](/2023/10/system-text-json-disable-reflection-based-serialization/).
