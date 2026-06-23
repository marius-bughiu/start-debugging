---
title: ".NET 11 Preview 5 permite que las file-based apps se referencien entre sí con `#:ref`"
description: ".NET 11 Preview 5 agrega la directiva #:ref para que un script dotnet run pueda referenciar otra file-based app como biblioteca, con referencias transitivas y sin archivo de proyecto."
pubDate: 2026-06-23
tags:
  - "dotnet"
  - "dotnet-11"
lang: "es"
translationOf: "2026/06/dotnet-11-preview-5-file-based-apps-ref-directive"
translatedBy: "claude"
translationDate: 2026-06-23
---
Las file-based apps empezaron como una forma de ejecutar un único archivo `.cs` con `dotnet run` y sin proyecto. En [.NET 10 aprendieron `#:include`](/es/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/), que incorpora archivos adicionales a una sola compilación. [.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) va un paso más allá: la nueva directiva `#:ref` permite que una file-based app referencie otra file-based app como *biblioteca*, y las referencias transitivas están soportadas. No se requiere `.csproj`.

## En qué se diferencia `#:ref` de `#:include`

La distinción es real, no cosmética. `#:include` fusiona otro archivo en la misma unidad de compilación, así que todo termina en un solo ensamblado. `#:ref` trata el destino como una biblioteca separada y lo referencia, igual que haría un `ProjectReference`, salvo que no hay proyecto en ninguno de los dos lados.

Eso significa que `#:ref` te da un límite real. El archivo referenciado se compila por su cuenta, expone sus tipos públicos, y el consumidor enlaza contra él. Obtienes reutilización entre scripts sin copiar y pegar funciones auxiliares ni montar una biblioteca de clases.

## Un ejemplo de dos archivos que puedes ejecutar

Coloca una pequeña biblioteca en `lib.cs`:

```csharp
// lib.cs
namespace MyLib;

public static class Greeter
{
    public static string Greet(string name) => $"Hello, {name}!";
}
```

Referénciala desde `app.cs`:

```csharp
// app.cs
#:ref lib.cs

Console.WriteLine(MyLib.Greeter.Greet("World"));
```

Ejecútalo con un SDK de .NET 11 Preview 5:

```bash
dotnet run app.cs
```

Si `lib.cs` lleva a su vez un `#:ref` a un tercer archivo, esa referencia fluye a través. Las referencias transitivas se resuelven, así que puedes componer un pequeño grafo de scripts de la misma forma en que compondrías un pequeño grafo de proyectos.

## Las directivas ya no están restringidas

La otra novedad en Preview 5 es que las directivas de file-based apps `#:include`, `#:exclude` y `#:project` ya no requieren un feature flag, y las directivas dentro de los archivos incluidos ahora se procesan de forma transitiva. Así que `#:include` puede alcanzar archivos anidados, y `#:project` puede apuntar un script a un `.csproj` real cuando se te queda pequeño el esquema de solo scripts.

Eso te da un gradiente en lugar de un precipicio. Empieza con un archivo. Separa las funciones auxiliares con `#:include`. Promueve una función auxiliar a una biblioteca reutilizable con `#:ref`. Incorpora un proyecto completo con `#:project` cuando la cosa deje de ser un script. Cada paso es una línea de directiva, y ninguno te obliga a dejar de usar `dotnet run`.

## Dónde encaja esto

`#:ref` está dirigido al mismo público que el resto del trabajo en file-based apps: scripts de tooling, ejemplos, reproducciones, y ese tipo de código pegamento que nunca mereció un archivo de solución. El nuevo límite hace que esos scripts sean compartibles sin arrastrar la ceremonia de MSBuild. Es una característica preliminar, así que pruébala en un SDK de .NET 11 Preview 5 y lee las [notas de la versión del SDK](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) para conocer el comportamiento exacto antes de apoyarte en ella.
