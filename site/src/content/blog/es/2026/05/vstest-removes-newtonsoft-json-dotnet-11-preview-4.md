---
title: "VSTest abandona Newtonsoft.Json en .NET 11 Preview 4 y qué se rompe si lo usabas de forma transitiva"
description: ".NET 11 Preview 4 y Visual Studio 18.8 traen un VSTest que ya no propaga Newtonsoft.Json a tus proyectos de pruebas. Las compilaciones que dependían silenciosamente de la copia transitiva se romperán con un solo PackageReference de arreglo."
pubDate: 2026-05-01
tags:
  - "dotnet-11"
  - "vstest"
  - "newtonsoft-json"
  - "system-text-json"
  - "testing"
lang: "es"
translationOf: "2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-01
---

El equipo de .NET [anunció el 29 de abril](https://devblogs.microsoft.com/dotnet/vs-test-is-removing-its-newtonsoft-json-dependency/) que VSTest, el motor detrás de `dotnet test` y del Test Explorer de Visual Studio, finalmente corta su dependencia con `Newtonsoft.Json`. El cambio aterriza en .NET 11 Preview 4 (planeado para el 12 de mayo de 2026) y Visual Studio 18.8 Insiders 1 (planeado para el 9 de junio de 2026). En .NET, VSTest cambia su serializador interno a `System.Text.Json`. En .NET Framework, donde `System.Text.Json` es una carga útil demasiado pesada, usa una pequeña biblioteca llamada JSONite. El trabajo se rastrea en [microsoft/vstest#15540](https://github.com/microsoft/vstest/pull/15540) y el cambio rompedor del SDK en [dotnet/docs#53174](https://github.com/dotnet/docs/issues/53174).

## La mayoría de los proyectos no necesitan hacer nada

Si tu proyecto de pruebas ya declara `Newtonsoft.Json` con un `PackageReference` normal, nada cambia. El paquete sigue funcionando, y cualquier código que use `JObject`, `JToken` o el estático `JsonConvert` sigue compilando. El único tipo público que VSTest exponía, `Newtonsoft.Json.Linq.JToken`, vivía en un solo punto del protocolo de comunicación de VSTest, y la propia evaluación del equipo es que esencialmente ningún consumidor del mundo real depende de esa superficie.

## Dónde se rompe en realidad

El modo de fallo interesante es el proyecto que nunca pidió `Newtonsoft.Json` y lo recibió igual, porque VSTest arrastraba el ensamblado consigo. Una vez que Preview 4 corte el flujo transitivo, esa copia desaparece en tiempo de ejecución y verás una `FileNotFoundException` para `Newtonsoft.Json` durante la ejecución de las pruebas. El arreglo es una línea en el `.csproj`:

```xml
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
</ItemGroup>
```

El segundo sabor son los proyectos que excluyeron explícitamente el runtime asset de un `Newtonsoft.Json` transitivo, normalmente para mantener pequeñas las cargas útiles de implementación:

```xml
<PackageReference Include="Newtonsoft.Json" Version="13.0.3">
  <ExcludeAssets>runtime</ExcludeAssets>
</PackageReference>
```

Eso solía funcionar porque el propio VSTest enviaba la DLL del runtime. Después de Preview 4 deja de funcionar por la misma razón: ya nadie trae el binario consigo. Quita el elemento `ExcludeAssets` o mueve el paquete a un proyecto que sí envíe su runtime.

## Por qué molestarse

Cargar `Newtonsoft.Json` dentro de la plataforma de pruebas era una vieja verruga de compatibilidad. Anclaba un major 13.x dentro de cada sesión de pruebas, sacaba a relucir ocasionales dramas de binding redirects en .NET Framework, y forzaba a los equipos que prohibían intencionalmente `Newtonsoft.Json` de su app a tolerarlo de todos modos bajo las pruebas. Usar `System.Text.Json` en .NET reduce la huella del host de pruebas y alinea la ejecución de pruebas con el resto del SDK moderno ([relacionado: System.Text.Json en .NET 11 Preview 3](/es/2026/04/system-text-json-11-pascalcase-per-member-naming/)). Para .NET Framework, JSONite mantiene el mismo protocolo sobre un parser dedicado y diminuto en lugar de una biblioteca compartida que ha mordido a equipos antes.

Si quieres saber pronto si estás en el grupo roto, apunta tu CI al paquete preliminar [Microsoft.TestPlatform 1.0.0-alpha-stj-26213-07](https://www.nuget.org/packages/Microsoft.TestPlatform/1.0.0-alpha-stj-26213-07) y ejecuta tu suite de pruebas existente. Una compilación verde ahora significa una compilación verde el 12 de mayo.
