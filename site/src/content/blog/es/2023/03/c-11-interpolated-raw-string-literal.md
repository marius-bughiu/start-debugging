---
title: "C# 11 - Literales raw string interpolados"
description: "Aprende a usar literales raw string interpolados en C# 11, incluyendo el escape de llaves, varios caracteres $ y operadores condicionales."
pubDate: 2023-03-17
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/03/c-11-interpolated-raw-string-literal"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 11 introduce en el lenguaje el concepto de [literales raw string](/2023/03/c-raw-string-literals/) y, con ello, llega también un conjunto de nuevas funcionalidades para la interpolación de cadenas.

En primer lugar, puedes seguir usando la sintaxis de interpolación tal como la conoces, en combinación con los literales raw string, así:

```cs
var x = 5, y = 4;
var interpolatedRaw = $"""The sum of "{x}" and "{y}" is "{ x + y }".""";
```

La salida será:

```plaintext
The sum of "5" and "4" is "9".
```

## Escapar llaves { y }

Puedes escapar las llaves duplicándolas. Si tomamos el ejemplo anterior y duplicamos las llaves:

```cs
var interpolatedRaw= $"""The sum of "{{x}}" and "{{y}}" is "{{ x + y }}".""";
```

La salida será:

```plaintext
The sum of "{x}" and "{y}" is "{ x + y }".
```

Como puedes ver, las llaves ya no cumplen un papel de interpolación, y cada par de llaves dobles termina como una única llave en la salida.

## Varios caracteres $ en literales raw string interpolados

Puedes usar varios caracteres **$** en un literal raw string interpolado de forma similar a la secuencia **"""**. El número de caracteres $ que usas al inicio de la cadena determina la cantidad de { y } que necesitas para la interpolación.

Por ejemplo, las dos cadenas siguientes producirán exactamente el mismo resultado que nuestro ejemplo inicial:

```cs
var interpolatedRaw2 = $$"""The sum of "{{x}}" and "{{y}}" is "{{ x + y }}".""";
var interpolatedRaw3 = $$$"""The sum of "{{{x}}}" and "{{{y}}}" is "{{{ x + y }}}".""";
```

## Operador condicional en cadena interpolada

Los dos puntos (:) tienen un significado especial en las cadenas interpoladas y, por ello, las expresiones condicionales necesitan un par adicional de paréntesis ( ) para funcionar. Por ejemplo:

```cs
var conditionalInterpolated = $"I am {x} year{(x == 1 ? "" : "s")} old.";
```

## Errores

> Error CS9006 The interpolated raw string literal does not start with enough '$' characters to allow this many consecutive opening braces as content.

Este error del compilador ocurre cuando la cadena contiene una secuencia de caracteres llave que es igual o mayor al doble de la longitud de la secuencia de caracteres $ que se encuentra al inicio de la cadena.
