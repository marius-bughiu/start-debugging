---
title: ".NET 11 convierte un double a hex y lo recupera bit a bit"
description: "El Preview 4 de .NET 11 enseña a double, float y Half a formatear con el especificador X y a parsear con NumberStyles.HexFloat, produciendo el mismo texto hex IEEE-754 que printf(\"%a\") de C."
pubDate: 2026-06-02
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
lang: "es"
translationOf: "2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat"
translatedBy: "claude"
translationDate: 2026-06-02
---

Las [notas de las bibliotecas de .NET 11 Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md) incluyeron una funcionalidad que suena de nicho hasta el día en que la necesitas: `double`, `float` y `Half` ahora se pueden escribir y volver a leer en forma hexadecimal IEEE-754. Es la misma notación que C y C++ emiten con `printf("%a", ...)`, y expone cada bit del valor directamente en el texto.

## El especificador X antes lanzaba excepción en un double

Hasta ahora la cadena de formato `"X"` era solo para enteros. Llámala sobre un valor de punto flotante y obtenías una `FormatException`:

```csharp
double value = Math.PI;
string hex = value.ToString("X"); // .NET 10: throws FormatException
```

A partir de .NET 11, esa misma llamada devuelve la representación hex del float:

```csharp
using System.Globalization;

double value = Math.PI;

string hex = value.ToString("X"); // "0X1.921FB54442D18P+1"
double round = double.Parse(hex, NumberStyles.HexFloat);

Console.WriteLine(round == value); // True, exact round-trip
```

El nuevo flag `NumberStyles.HexFloat` es lo que le indica a `Parse` y `TryParse` que lean de vuelta esa forma. El `0X1.` inicial es la mantisa, y `P+1` es el exponente binario, así que lo que estás viendo es la disposición literal de los bits, no una aproximación decimal de ella.

## La ida y vuelta decimal ya funcionaba, entonces ¿para qué molestarse?

Vale la pena ser preciso aquí. Desde .NET Core 3.0 el formateador de ida y vuelta más corto garantiza que `double.Parse(value.ToString())` devuelve exactamente el mismo `double`. Así que el hex no corrige un error de corrección en la ida y vuelta decimal.

Lo que el hex te aporta es transparencia e interoperabilidad. El texto decimal de un `double` cambia de forma según el valor y es opaco respecto a qué bits están activos. La forma hex es canónica: cada `double` distinto se mapea a una sola cadena hex, y esa cadena es comparable byte a byte entre plataformas y lenguajes. Si estás fijando valores esperados en una prueba con archivo de referencia, una desviación de un carácter en el último decimal es un verdadero dolor de cabeza. El hex hace que la comparación sea exacta y evidente.

## Dónde vale la pena

La ventaja más clara es la interoperabilidad entre lenguajes. Una biblioteca nativa que registra floats con `%a`, o un conjunto de pruebas numéricas compartido con una base de código C++, produce hex que .NET ahora puede consumir directamente:

```csharp
// From a C++ component that printed with %a
string fromNative = "0X1.5BF0A8B145769P+1"; // ~2.718281828...
double e = double.Parse(fromNative, NumberStyles.HexFloat);
```

`Half` y `float` reciben el mismo tratamiento, así que los valores de media precisión que salen de un pipeline de ML o de un búfer de GPU hacen la ida y vuelta sin un salto con pérdida a través de texto decimal. Descarga el [SDK del Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), apunta a `net11.0`, y la próxima vez que necesites serializar un float para un fixture de prueba o un volcado de depuración, usa `"X"` en lugar de hacer a mano un baile con `BitConverter.DoubleToInt64Bits`.
