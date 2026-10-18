---
title: "Cómo formatear números con la agrupación de dígitos india lakh/crore en .NET (NumberGroupSizes)"
description: "Usa la cultura en-IN o asigna NumberFormatInfo.NumberGroupSizes a [3, 2] para imprimir 12,34,56,789 en lugar de 123,456,789 en C#. Medido en .NET 10 y .NET 11 RC1: cómo funciona el arreglo, por qué CurrencyGroupSizes es independiente, la trampa del modo de globalización invariante que imprime en silencio la agrupación occidental y un helper para lakh/crore en palabras."
pubDate: 2026-10-18
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "globalization"
  - "formatting"
lang: "es"
translationOf: "2026/10/how-to-format-numbers-with-indian-lakh-crore-digit-grouping-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Respuesta corta:** pasa la cultura `en-IN` (o cualquier otra cultura india como `hi-IN`) a `ToString("N2", culture)` y .NET imprime `12,34,56,789.50` en lugar de `123,456,789.50`, porque esas culturas ya incluyen `NumberFormatInfo.NumberGroupSizes = [3, 2]`. Si necesitas la agrupación sin el resto de la cultura, clona un `NumberFormatInfo`, asigna `NumberGroupSizes = [3, 2]` (y `CurrencyGroupSizes` y `PercentGroupSizes` si usas `C` o `P`) y pásalo como proveedor de formato. El arreglo significa "el primer grupo desde la derecha tiene 3 dígitos, y cada grupo posterior tiene 2", y funciona igual para `int`, `long`, `decimal`, `double`, `BigInteger`, patrones personalizados `#,##0` y `TryFormat`.

Todo lo que sigue se midió en el SDK de .NET 10.0.302 (runtime 10.0.10) y en .NET 11 RC1 (`11.0.100-rc.1.26425.128`) sobre macOS con ICU, C# 14. La salida fue idéntica byte a byte en ambos runtimes, y la API `NumberGroupSizes` no ha cambiado desde .NET Framework 1.1, así que el mismo código funciona en .NET 8 y 9.

## Por qué la agrupación india es distinta de la occidental

La convención occidental agrupa cada tres dígitos: mil, millón, billón. El sistema de numeración indio agrupa los primeros tres dígitos (centenas) y luego cada dos dígitos: mil, lakh (1,00,000), crore (1,00,00,000), y así sucesivamente. Así, ciento veintitrés millones cuatrocientos cincuenta y seis mil setecientos ochenta y nueve se escribe `123,456,789` en EE. UU. y `12,34,56,789` en India (12 crore, 34 lakh, 56 mil, 789).

.NET no fija ninguna de las dos convenciones en el código. Cada `NumberFormatInfo` lleva tres arreglos de enteros que describen cómo dividir la parte entera de un número en grupos:

- `NumberGroupSizes`, usado por el formato `N` y por los patrones personalizados que contienen `,`
- `CurrencyGroupSizes`, usado por el formato `C`
- `PercentGroupSizes`, usado por el formato `P`

El formateador recorre esos arreglos desde el separador decimal hacia la izquierda. Ese es todo el mecanismo, y la razón por la que un único arreglo puede describir ambas convenciones.

## Repro mínimo: el mismo número, dos culturas

```csharp
// .NET 11, C# 14 (also .NET 10.0.10)
using System.Globalization;

var us  = CultureInfo.GetCultureInfo("en-US");
var inr = CultureInfo.GetCultureInfo("en-IN");
decimal amount = 123456789.5m;

Console.WriteLine(string.Join(",", us.NumberFormat.NumberGroupSizes));  // 3
Console.WriteLine(string.Join(",", inr.NumberFormat.NumberGroupSizes)); // 3,2

Console.WriteLine(amount.ToString("N2", us));   // 123,456,789.50
Console.WriteLine(amount.ToString("N2", inr));  // 12,34,56,789.50
Console.WriteLine(amount.ToString("C", inr));   // ₹12,34,56,789.50
Console.WriteLine(12345.678.ToString("P1", inr)); // 12,34,567.8%
```

`hi-IN`, `bn-IN` y `ta-IN` reportan los mismos tamaños `[3, 2]` para los tres arreglos. Además usan dígitos ASCII en la salida: el formateo numérico de .NET nunca sustituye `NativeDigits`, así que obtienes `12,34,56,789`, no dígitos devanagari ni bengalíes, sin importar qué cultura india elijas.

## La solución, paso a paso

Si tu aplicación ya se ejecuta con una cultura india como `CurrentCulture`, has terminado: `$"{amount:N2}"` toma la agrupación automáticamente. Sin embargo, la mayoría de las veces necesitas la agrupación india en un servidor cuya cultura es `en-US` o invariante, o la necesitas para una sola columna de un reporte. Este es el procedimiento que funciona en todos los casos.

1. Decide si quieres la cultura india completa o solo su agrupación de dígitos. `en-IN` también trae el símbolo de moneda `₹`, fechas de estilo `dd-MM-yyyy` y nombres de meses en inglés de India. Si solo quieres las comas, construye un `NumberFormatInfo` personalizado.
2. Parte de una copia modificable. `CultureInfo.GetCultureInfo(...)` y `CultureInfo.InvariantCulture` devuelven instancias de solo lectura, y asignar a sus propiedades de `NumberFormat` lanza `InvalidOperationException: Instance is read-only.` Llama a `Clone()` sobre el `NumberFormatInfo`, o crea una cultura con `new CultureInfo("en-US")`, que sí es modificable.
3. Asigna los tamaños de grupo. Establece `NumberGroupSizes = [3, 2]` para `N` y los patrones personalizados. Establece también `CurrencyGroupSizes` y `PercentGroupSizes` si formateas con `C` o `P`; son arreglos independientes.
4. Congélalo con `NumberFormatInfo.ReadOnly(nfi)` y guárdalo en un campo `static readonly` para que todos los llamadores compartan un único proveedor inmutable.
5. Pásalo como `IFormatProvider` a `ToString`, `TryFormat`, `string.Format` o `string.Create`, o establécelo como `CurrentCulture` si todo el hilo debe usarlo.

En código:

```csharp
// .NET 11, C# 14
using System.Globalization;

public static class IndianNumberFormat
{
    public static readonly NumberFormatInfo Grouping = Create();

    private static NumberFormatInfo Create()
    {
        var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
        nfi.NumberGroupSizes   = [3, 2];
        nfi.CurrencyGroupSizes = [3, 2];
        nfi.PercentGroupSizes  = [3, 2];
        nfi.CurrencySymbol     = "₹"; // invariant default is the generic ¤
        return NumberFormatInfo.ReadOnly(nfi);
    }
}

decimal amount = 123456789.5m;
Console.WriteLine(amount.ToString("N2", IndianNumberFormat.Grouping)); // 12,34,56,789.50
Console.WriteLine(amount.ToString("C",  IndianNumberFormat.Grouping)); // ₹12,34,56,789.50
```

Si olvidas el paso 3 para la moneda, obtienes una migración a medias que confunde. Con solo `NumberGroupSizes` modificado, `amount.ToString("C", nfi)` seguía imprimiendo `¤123,456,789.50` en mi prueba, porque el formato `C` lee `CurrencyGroupSizes`, que seguía siendo `[3]`.

Para cambiar la agrupación en toda una solicitud o hilo sin tocar el idioma del resto, modifica una cultura editable:

```csharp
// .NET 11, C# 14
using System.Globalization;

var culture = new CultureInfo("en-US");          // writable, unlike GetCultureInfo
culture.NumberFormat.NumberGroupSizes = [3, 2];
CultureInfo.CurrentCulture = culture;

Console.WriteLine($"{123456789:N0}");            // 12,34,56,789
Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0:N0}", 123456789)); // 123,456,789
```

La segunda línea es un recordatorio de que un proveedor explícito siempre gana sobre `CurrentCulture`.

## Cómo se interpreta el arreglo NumberGroupSizes

Las reglas, verificadas contra el runtime y no aceptadas a ciegas:

- El elemento 0 es el tamaño del grupo más cercano al separador decimal. El elemento 1 es el siguiente grupo hacia la izquierda, y así sucesivamente.
- El **último elemento se repite** para todos los grupos restantes. Por eso `[3, 2]` sigue produciendo grupos de dos indefinidamente.
- Si el último elemento es `0`, los dígitos restantes **no se agrupan** en absoluto.
- Cada elemento debe estar entre 1 y 9, excepto el último, que puede ser 0. Cualquier otra cosa lanza `ArgumentException` con el mensaje "Every element in the value array should be between one and nine, except for the last element, which can be zero."

Esto es lo que hacen distintos arreglos con `1234567890`:

```csharp
// .NET 11, C# 14
using System.Globalization;

var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
long n = 1234567890;

nfi.NumberGroupSizes = [3];       Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,890
nfi.NumberGroupSizes = [3, 2];    Console.WriteLine(n.ToString("N0", nfi)); // 1,23,45,67,890
nfi.NumberGroupSizes = [3, 0];    Console.WriteLine(n.ToString("N0", nfi)); // 1234567,890
nfi.NumberGroupSizes = [3, 2, 0]; Console.WriteLine(n.ToString("N0", nfi)); // 12345,67,890
nfi.NumberGroupSizes = [4];       Console.WriteLine(n.ToString("N0", nfi)); // 12,3456,7890
nfi.NumberGroupSizes = [1, 2, 3]; Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,89,0
nfi.NumberGroupSizes = [0];       Console.WriteLine(n.ToString("N0", nfi)); // 1234567890
nfi.NumberGroupSizes = [];        Console.WriteLine(n.ToString("N0", nfi)); // 1234567890

nfi.NumberGroupSizes = [3, 0, 2]; // ArgumentException: 0 is only allowed last
nfi.NumberGroupSizes = [10];      // ArgumentException: max is 9
```

`[4]` es la forma que quieres para la agrupación de diez mil (wan/man) de Asia Oriental si un diseño la requiere; ninguna cultura integrada de .NET la usa por defecto. `[3, 0]` es útil cuando una especificación dice "separar solo los miles".

El getter devuelve una copia del arreglo. Escribir `nfi.NumberGroupSizes[0] = 9` compila y se ejecuta, pero no cambia nada: en mi prueba la salida siguió siendo `12,34,56,789.50`. Asigna siempre un arreglo nuevo.

## Qué formatos respetan la agrupación y cuáles no

Ejecuté todas las rutas comunes contra `en-IN`:

| Llamada | Salida |
|---|---|
| `1234567890123L.ToString("N0", inr)` | `12,34,56,78,90,123` |
| `amount.ToString("#,##0.00", inr)` | `12,34,56,789.50` |
| `BigInteger.Parse("123456789012345").ToString("N0", inr)` | `12,34,56,78,90,12,345` |
| `12345678f.ToString("N0", inr)` | `1,23,45,678` |
| `int.MinValue.ToString("N0", inr)` | `-2,14,74,83,648` |
| `123456789.TryFormat(span, out _, "N0", inr)` | `12,34,56,789` |
| `1234567.ToString("D", inr)` / `"G"` / `"F2"` | `1234567` / `1234567` / `1234567.89` |

Así, `N`, `C`, `P` y los patrones personalizados con `,` siguen los arreglos, incluso en la ruta `TryFormat` sin asignaciones. `D`, `G`, `F`, `E` y el `ToString()` sin parámetros nunca agrupan, en ninguna cultura.

Un detalle del formato personalizado que confunde a muchos: la posición de la coma en un patrón personalizado no importa. `123456789.ToString("#,##,##0", enUS)` imprime `123,456,789`, no `12,34,56,789`. Una coma entre marcadores de posición de dígitos solo activa la agrupación; los tamaños siempre vienen de `NumberGroupSizes`. No puedes obtener la agrupación india escribiendo el patrón "correcto". Tienes que cambiar el proveedor. Una coma inmediatamente antes del separador decimal (o al final) es una función completamente distinta: divide entre 1 000 por cada coma, así que `"0,,"` convierte `123456789` en `123`.

## Problemas frecuentes

### El modo de globalización invariante imprime en silencio la agrupación occidental

Este es el que llega a producción. Muchas imágenes de contenedor y aplicaciones Native AOT establecen `<InvariantGlobalization>true</InvariantGlobalization>` (o `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`) para eliminar la dependencia de ICU. En ese modo, `CultureInfo.GetCultureInfo("en-IN")` lanza `CultureNotFoundException: Only the invariant culture is supported in globalization-invariant mode.` Eso al menos es ruidoso.

La versión silenciosa ocurre cuando alguien además establece `PredefinedCulturesOnly` en `false` (`DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=0`) para hacer desaparecer esa excepción. Entonces `new CultureInfo("en-IN")` tiene éxito, pero la cultura lleva datos invariantes. Medí `sizes=3`, `123,456,789` desde `N0` y `¤` como símbolo de moneda, sin excepción ni advertencia. Tus usuarios indios reciben comas estadounidenses.

Si construyes tú mismo el `NumberFormatInfo` a partir de `InvariantCulture`, como en la clase `IndianNumberFormat` de arriba, la agrupación funciona también en modo invariante, porque nada depende de los datos de ICU. Esa es la opción más robusta para contenedores. Si necesitas la cultura `en-IN` completa, mantén ICU en la imagen; la [solución de ICU en contenedores](/es/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) recorre los paquetes, y la [comparación de implementación en contenedores](/es/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/) cubre qué tipos de imagen activan el modo invariante.

### La precisión por defecto de "N" no es portable

En esta Mac, ICU reportó `NumberDecimalDigits = 3` para `en-IN`, `hi-IN`, `en-US` y `en-GB` por igual, así que `amount.ToString("N", inr)` imprimió `12,34,56,789.500` con tres decimales, mientras que `CurrencyDecimalDigits` se mantuvo en 2. En modo invariante la misma llamada imprimió dos decimales. Los datos de cultura provienen del ICU del sistema operativo (o NLS en configuraciones antiguas de Windows), así que el valor por defecto puede diferir entre tu laptop y tu servidor. Pasa siempre una precisión explícita: `N0`, `N2`, nunca `N` a secas, para todo lo que un usuario o una prueba compare.

### El análisis ignora las posiciones de los grupos

`decimal.Parse("1,23,45,678.90", NumberStyles.Number, enUS)` devuelve `12345678.90`, y también `decimal.Parse("12,345,678", NumberStyles.Number, inr)`. Con `NumberStyles.AllowThousands`, .NET acepta separadores de grupo en cualquier lugar de la parte entera y no los valida contra `NumberGroupSizes`. Eso es cómodo para aceptar ambos estilos de entrada, pero significa que el análisis no es un validador. Si debes rechazar `12,345,678` en un campo con formato indio, comprueba la forma con una expresión regular como `^\d{1,2}(,\d{2})*,\d{3}$|^\d{1,3}$` antes de analizar.

### Un separador distinto

Las guías de estilo indias a veces piden un espacio fino en lugar de una coma. Establece `NumberGroupSeparator` (y `CurrencyGroupSeparator` para `C`) en el mismo `NumberFormatInfo` clonado; probé `"\u202F"` (espacio estrecho sin salto) y obtuve `12 34 56 789` con los tamaños sin cambios. Usa un espacio sin salto para que el número nunca se parta entre líneas.

## Imprimir "12.35 lakh" y "2.5 crore"

`NumberGroupSizes` controla los separadores, no las palabras. .NET no tiene un formateador compacto integrado que produzca "lakh" o "crore" (el concepto `CompactDecimalFormat` existe en ICU pero no está expuesto mediante `ToString`). Un pequeño helper cubre la necesidad común de interfaz:

```csharp
// .NET 11, C# 14
using System.Globalization;

static string ToLakhCrore(decimal value, int decimals = 2)
{
    var inr = CultureInfo.GetCultureInfo("en-IN");
    const decimal Lakh = 1_00_000m, Crore = 1_00_00_000m;
    decimal abs = Math.Abs(value);
    string sign = value < 0 ? "-" : "";
    string fmt = "#,##0." + new string('#', decimals);

    // Round in the target unit first, then promote if rounding crossed the boundary.
    decimal inLakh = Math.Round(abs / Lakh, decimals, MidpointRounding.AwayFromZero);
    if (abs >= Crore || inLakh >= 100m)
        return sign + Math.Round(abs / Crore, decimals, MidpointRounding.AwayFromZero).ToString(fmt, inr) + " crore";
    if (abs >= Lakh || inLakh >= 1m)
        return sign + inLakh.ToString(fmt, inr) + " lakh";
    return sign + abs.ToString(fmt, inr);
}

Console.WriteLine(ToLakhCrore(45_000m));         // 45,000
Console.WriteLine(ToLakhCrore(1_25_000m));       // 1.25 lakh
Console.WriteLine(ToLakhCrore(12_34_567m));      // 12.35 lakh
Console.WriteLine(ToLakhCrore(99_99_999m));      // 1 crore
Console.WriteLine(ToLakhCrore(2_50_00_000m));    // 2.5 crore
Console.WriteLine(ToLakhCrore(1234_56_78_901m)); // 1,234.57 crore
Console.WriteLine(ToLakhCrore(-3_50_000m));      // -3.5 lakh
```

El paso "redondear primero, luego promover" importa. Una versión ingenua que comprueba `abs >= Crore` antes de redondear imprime `100 lakh` para `99,99,999`, algo que ningún lector indio escribiría. Fíjate en los separadores de dígitos de los literales de C# (`1_00_000m`): el compilador acepta `_` en cualquier lugar entre dígitos, así que puedes reflejar la agrupación india en el código fuente para mayor legibilidad.

Si el helper se ejecuta en un contenedor con globalización invariante, cambia `CultureInfo.GetCultureInfo("en-IN")` por el proveedor `IndianNumberFormat.Grouping` de antes, por las razones del problema descrito arriba.

## Notas de rendimiento

Los tamaños de grupo se leen una vez por llamada de formato desde arreglos que ya están en el `NumberFormatInfo`, así que `[3, 2]` cuesta lo mismo que `[3]`. El error costoso es crear un `CultureInfo` nuevo o clonar un `NumberFormatInfo` en cada llamada. Guarda el proveedor en un campo `static readonly`, como se mostró arriba, y usa `TryFormat` sobre un búfer en la pila cuando formatees en un bucle crítico; la [comparación de StringBuilder frente a interpolación](/es/2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11/) muestra cuánto ahorra la ruta sin asignaciones cuando construyes cadenas más grandes a partir de muchos números.

## Relacionado

- [Fix: Couldn't find a valid ICU package installed on the system in a .NET container](/es/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) si `en-IN` lanza una excepción en Docker.
- [Framework-dependent vs self-contained vs Native AOT for a .NET 11 container image](/es/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/) para saber dónde se activa la globalización invariante.
- [How to use Native AOT with ASP.NET Core minimal APIs](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/), que usa el modo invariante por defecto.
- [.NET 11 can round-trip a double as hex, bit for bit](/es/2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat/) para otro rincón del formateo numérico y `NumberStyles`.

## Fuentes

- [NumberFormatInfo.NumberGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.numbergroupsizes) en Microsoft Learn.
- [NumberFormatInfo.CurrencyGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.currencygroupsizes) en Microsoft Learn.
- [Standard numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/standard-numeric-format-strings) y [custom numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/custom-numeric-format-strings), incluidos el separador de grupo y el especificador de escala numérica.
- [Globalization and ICU in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu).
- [Culture creation and case mapping in globalization-invariant mode](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode), el cambio de .NET 6 que introdujo `PredefinedCulturesOnly`.
