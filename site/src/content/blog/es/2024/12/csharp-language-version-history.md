---
title: "Historial de versiones del lenguaje C#"
description: "La evolución de C# lo ha transformado en un lenguaje moderno y de alto rendimiento. Esta guía recorre cada hito importante. Los primeros años (C# 1.0 - 1.2). C# se lanzó en 2002 como lenguaje principal para .NET Framework. Se sentía como Java pero con un enfoque en el desarrollo en Windows. La versión 1.2 llegó poco después con pequeñas..."
pubDate: 2024-12-01
updatedDate: 2026-02-08
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2024/12/csharp-language-version-history"
translatedBy: "claude"
translationDate: 2026-05-01
---
La evolución de C# lo ha transformado en un lenguaje moderno y de alto rendimiento. Esta guía recorre cada hito importante.

## Los primeros años (C# 1.0 – 1.2)

C# se lanzó en 2002 como lenguaje principal para .NET Framework. Se sentía como Java pero con un enfoque en el desarrollo en Windows. La versión 1.2 llegó poco después con pequeñas mejoras como el soporte de `IDisposable` en bucles foreach.

El lenguaje tenía los siguientes objetivos:

> -   Está pensado para ser un lenguaje de programación simple, moderno, de propósito general y orientado a objetos.
> -   Debe incluir comprobación fuerte de tipos, comprobación de límites de arrays, detección de intentos de usar variables no inicializadas, portabilidad del código fuente y recolección automática de basura.
> -   Está pensado para usarse en el desarrollo de componentes de software que puedan aprovechar entornos distribuidos.
> -   Como la portabilidad del programador es muy importante, especialmente para aquellos ya familiarizados con C y C++, C# es el más adecuado.
> -   Proporcionar soporte para internacionalización, ya que era muy importante.
> -   Está pensado para ser adecuado para escribir aplicaciones tanto para sistemas con host como embebidos.
> 
> [Fuente: Objetivos de diseño de C#](https://feeldotneteasy.blogspot.com/2011/01/c-design-goals.html)

## Grandes cambios de productividad (C# 2.0 – 5.0)

Estas versiones introdujeron las características que más usamos hoy.

-   **C# 2.0:** Genéricos, métodos anónimos y tipos anulables cambiaron cómo manejamos los datos.
-   **C# 3.0:** LINQ, expresiones lambda y métodos de extensión hicieron mucho más fácil consultar datos.
-   **C# 4.0:** Esta versión añadió la palabra clave `dynamic` y los parámetros opcionales.
-   **C# 5.0:** Las palabras clave `async` y `await` revolucionaron la programación asíncrona.

## La era del compilador moderno (C# 6.0 – 9.0)

Con el compilador Roslyn, las actualizaciones se volvieron más rápidas y frecuentes.

-   **C# 6.0 y 7.0:** Estas versiones se enfocaron en "azúcar sintáctico" como miembros con cuerpo de expresión y tuplas.
-   **C# 8.0:** Los tipos de referencia anulables ayudaron a los desarrolladores a evitar excepciones comunes de null-pointer.
-   **C# 9.0:** Los records y las declaraciones de nivel superior simplificaron el modelado de datos y redujeron el código repetitivo.

## Avances recientes (C# 10.0 – 13.0)

El lenguaje ahora evoluciona anualmente junto con .NET.

-   **C# 10 y 11:** Las directivas using globales y los literales de string crudos mejoraron la productividad del desarrollador.
-   **C# 12 y 13:** Los constructores primarios para clases y las mejoras en ref struct mantuvieron al lenguaje competitivo.

## ¿Qué hay de nuevo en C# 14?

Lanzado con .NET 10, C# 14 introduce varias mejoras de calidad de vida.

### La palabra clave field

Ya no necesitas declarar manualmente los campos de respaldo para las propiedades. La palabra clave `field` te permite acceder al campo generado por el compilador directamente dentro de los accesores.

```csharp
public string Name { 
    get => field; 
    set => field = value ?? "Unknown"; 
}
```

### Miembros de extensión

C# 14 amplía los métodos de extensión. Ahora puedes definir propiedades de extensión, miembros estáticos e incluso operadores dentro de un nuevo bloque `extension`.

### Otras características clave

-   **Asignación condicional sobre null:** Usa `?.=` para asignar valores solo si el destino no es null.
-   **Conversiones implícitas a Span:** Los arrays y los strings ahora se convierten a spans de forma más natural.
-   **Modificadores de lambda:** Puedes usar `ref`, `in` y `out` en parámetros de lambda sin tipos explícitos.
-   **Constructores parciales:** Los generadores de código fuente ahora pueden definir las firmas de los constructores en clases parciales.
