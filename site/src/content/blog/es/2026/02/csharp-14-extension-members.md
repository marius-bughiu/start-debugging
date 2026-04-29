---
title: "Miembros de extensión en C# 14: propiedades, operadores y miembros estáticos de extensión"
description: "C# 14 introduce miembros de extensión, lo que te permite agregar propiedades, operadores y miembros estáticos de extensión a tipos existentes usando la nueva palabra clave extension."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
lang: "es"
translationOf: "2026/02/csharp-14-extension-members"
translatedBy: "claude"
translationDate: 2026-04-29
---

C# 14 se lanza con .NET 10 y trae la evolución más solicitada para los métodos de extensión desde su introducción en C# 3.0. Ahora puedes definir propiedades de extensión, operadores de extensión y miembros estáticos de extensión usando la nueva palabra clave `extension`.

## De métodos de extensión a bloques de extensión

Antes, agregar funcionalidad a un tipo que no posees significaba crear una clase estática con métodos estáticos y un modificador `this`. Ese patrón funcionaba para métodos pero dejaba fuera de alcance las propiedades y los operadores.

C# 14 introduce **bloques de extensión**, una sintaxis dedicada que agrupa miembros de extensión relacionados:

```csharp
public static class StringExtensions
{
    extension(string s)
    {
        public bool IsNullOrEmpty => string.IsNullOrEmpty(s);

        public int WordCount => s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

El bloque `extension(string s)` declara que todos los miembros dentro extienden `string`. Ahora puedes acceder a estos como propiedades:

```csharp
string title = "Hello World";
Console.WriteLine(title.IsNullOrEmpty);  // False
Console.WriteLine(title.WordCount);       // 2
```

## Operadores de extensión

Los operadores antes eran imposibles de agregar a tipos que no controlas. C# 14 cambia eso:

```csharp
public static class PointExtensions
{
    extension(Point p)
    {
        public static Point operator +(Point a, Point b)
            => new Point(a.X + b.X, a.Y + b.Y);

        public static Point operator -(Point a, Point b)
            => new Point(a.X - b.X, a.Y - b.Y);
    }
}
```

Ahora las instancias de `Point` pueden usar `+` y `-` aunque el tipo original no las definiera.

## Miembros estáticos de extensión

Los bloques de extensión también admiten miembros estáticos que aparecen como miembros estáticos del tipo extendido:

```csharp
public static class GuidExtensions
{
    extension(Guid)
    {
        public static Guid Empty2 => Guid.Empty;

        public static Guid CreateDeterministic(string input)
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(input));
            return new Guid(hash.AsSpan(0, 16));
        }
    }
}
```

Llámalo como si fuera un miembro estático de `Guid`:

```csharp
var id = Guid.CreateDeterministic("user@example.com");
```

## Lo que aún no se admite

C# 14 se centra en métodos, propiedades y operadores. Los campos, eventos, indexadores, tipos anidados y constructores no se admiten en bloques de extensión. Estos pueden llegar en futuras versiones de C#.

## Cuándo usar miembros de extensión

Las propiedades de extensión brillan cuando tienes valores calculados que se sienten como propiedades naturales de un tipo. El ejemplo `string.WordCount` se lee mejor que `string.GetWordCount()`. Los operadores de extensión funcionan bien para tipos matemáticos o de dominio donde los operadores tienen sentido semántico.

La característica está disponible ahora en .NET 10. Actualiza tu proyecto a `<LangVersion>14</LangVersion>` o `<LangVersion>latest</LangVersion>` para empezar a usar los bloques de extensión.

Para la documentación completa, consulta [Miembros de extensión en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members).
