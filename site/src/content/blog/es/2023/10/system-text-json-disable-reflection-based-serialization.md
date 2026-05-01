---
title: "System.Text.Json desactivar la serialización basada en reflexión"
description: "Aprende a desactivar la serialización basada en reflexión de System.Text.Json a partir de .NET 8 para aplicaciones trimmed y native AOT usando la propiedad JsonSerializerIsReflectionEnabledByDefault."
pubDate: 2023-10-21
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/system-text-json-disable-reflection-based-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8 puedes desactivar el serializador basado en reflexión que viene por defecto con `System.Text.Json`. Esto puede ser útil en aplicaciones trimmed y native AOT en las que no quieres incluir los componentes de reflexión en tu compilación.

Puedes activar esta opción estableciendo la propiedad `JsonSerializerIsReflectionEnabledByDefault` a `false` en tu archivo `.csproj`.

```xml
<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
```

Como efecto secundario, te verás obligado a proporcionar un `JsonSerializerOptions` al serializar y deserializar. No hacerlo se traducirá en una `NotSupportedException` en tiempo de ejecución.

Junto con esta opción, se introduce una nueva propiedad `IsReflectionEnabledByDefault` en `JsonSerializer`, que permite a los desarrolladores hacer una comprobación en tiempo de ejecución para ver si la característica está activa o no.
