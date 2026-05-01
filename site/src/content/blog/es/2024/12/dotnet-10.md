---
title: "Qué hay de nuevo en .NET 10"
description: "Qué hay de nuevo en .NET 10: versión LTS con 3 años de soporte, nuevas optimizaciones del JIT, devirtualización de arrays, mejoras en la asignación de pila y más."
pubDate: 2024-12-01
updatedDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2024/12/dotnet-10"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 10 se publicará en noviembre de 2025. .NET 10 es una versión Long Term Support (LTS), que recibirá soporte gratuito y parches durante 3 años desde la fecha de lanzamiento, hasta noviembre de 2028.

.NET 10 se publicará junto con C# 14. Consulta [qué hay de nuevo en C# 14](/2024/12/csharp-14/).

Hay varias características y mejoras nuevas en el runtime de .NET 10:

-   [Devirtualización de métodos de interfaz de array y des-abstracción de la enumeración de arrays](/es/2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction/)
-   Inlining de métodos devirtualizados tardíamente
-   Devirtualización basada en observaciones del inlining
-   [Asignación en la pila de arrays de tipos por valor](/es/2025/04/net-10-stack-allocation-of-arrays-of-value-types/)
-   Mejor disposición del código para evitar instrucciones de salto y mejorar la probabilidad de compartir una línea de caché de instrucciones
-   [SearchValues añadió soporte para strings](/es/2026/01/net-10-performance-searchvalues/)

## Fin del soporte

.NET 10 es una versión Long Term Support (LTS) y dejará de tener soporte en noviembre de 2028.
