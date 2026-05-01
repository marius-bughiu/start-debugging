---
title: "Cuánto tarda un PC en contar hasta un billón"
description: "Benchmarking de cuánto tarda un PC en contar hasta un billón y más allá, con resultados actualizados de 2023."
pubDate: 2013-10-13
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2013/10/counting-up-to-one-trillion"
translatedBy: "claude"
translationDate: 2026-05-01
---
Esta es una pregunta que surgió en una conversación con un colega sobre una empresa con un valor de más de 20 trillion dollars; y simplemente no podíamos imaginar cómo se vería esa cantidad de dinero en efectivo. Solo para hacernos una idea, calculamos cuántos billetes de cien dólares harían falta para rodear la Tierra una vez. La respuesta, creo, fue alrededor de 240.000.000, lo que equivale a unos 24 billion US dollars. Eso es muchísimo dinero. ¿Cuánto tardaría una persona en contar tanto dinero? Bueno, nadie lo puede decir con certeza, pero estamos hablando de decenas de miles de años.

Dicho esto, sí podemos hacernos una idea bastante buena de cuánto tardaría un computador en contar hasta un trillion. Solo iterar, sin ninguna otra acción intermedia. Para eso escribí una pequeña pieza de código que mide cuánto tarda en contar hasta un billion y luego hace algunas cuentas simples para estimar cuánto tardaría en contar hasta valores distintos, mostrando los resultados de forma amigable.

Los resultados son interesantes. Y la respuesta es: depende de tu máquina. Incluso en la misma máquina obtendrás resultados diferentes según la carga. Pero veamos los míos un momento:

**Resultados actualizados a octubre de 2023**: esta vez en un i9-11900k refrigerado por líquido.

```plaintext
9 minutes, 38 seconds         for 1 trillion (12 zeros)
6 days, 16 hours              for 1 quadrillion (15 zeros)
18 years, 130 days            for 1 quintillion (18 zeros)
18356 years, 60 days          for 1 sextillion (21 zeros)
```

Es bastante interesante comparar estos resultados con los de hace 10 años, cuando creé este post originalmente. El tiempo bajó de varias horas a menos de 10 minutos. Por supuesto, en cierto modo estamos comparando peras con manzanas, ya que el benchmark original se ejecutó en una CPU de portátil económica, mientras que los números actualizados provienen de una CPU de escritorio desbloqueada con refrigeración líquida. Pero aun así, da curiosidad ver cómo evoluciona con el tiempo.

> Los resultados originales de 2013, ejecutados en un portátil, son los siguientes:
> 
> -   one billion (9 zeros) se alcanza rápido: 15 segundos
> -   pero llegar a one trillion (12 zeros) muestra una diferencia asombrosa: 4 horas y 10 minutos. Básicamente 1000 veces más.
> -   las diferencias se vuelven aún más impresionantes a medida que subimos a quadrillions (15 zeros), que llevarían 173 días, y luego a quintillions (18 zeros), que llevarían 475 años
> -   el último para el que hice las cuentas es one sextillion (21 zeros) y prepárate: a mi portátil le llevaría exactamente 475473 años, 292 días, 6 horas, 43 minutos y 52 segundos iterar hasta ese valor.

Como dije, estos valores dependen mucho de la máquina. Así que pruébalo tú mismo y, si quieres, comparte los resultados. Código abajo:

```cs
using System.Diagnostics;

var sw = new Stopwatch();
sw.Start();

// 10 billion iterations (10 zeros)
for (long i = 1; i <= 10000000000; i++) ;

sw.Stop();

Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100)} for 1 trillion (12 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000)} for 1 quadrillion (15 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000000)} for 1 quintillion (18 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000000000)} for 1 sextillion (21 zeros)");

Console.ReadKey();

string FormatString(long elapsed, long multiplier)
{
    var span = new TimeSpan(elapsed * multiplier).Duration();

    return string.Format("{0}{1}{2}{3}{4}",
        span.Days > 364 ? $"{span.Days / 365} years, " : "",
        span.Days > 0        ? $"{span.Days % 365} days, "  : "",
        span.Hours > 0       ? $"{span.Hours} hours, "      : "",
        span.Minutes > 0     ? $"{span.Minutes} minutes, "  : "",
        span.Seconds > 0     ? $"{span.Seconds} seconds"    : "");
}
```

## ¿Y qué pasa con iterar todos los GUIDs?

Luego, en el verdadero espíritu de un ingeniero, cambié a otro tema, totalmente relacionado (para mí): la unicidad de los GUIDs. Ya me había preguntado en su momento qué tan único es realmente un GUID. Y obtuve una especie de respuesta entonces, pero ahora creo que es aún más clara.

Para empezar, los GUIDs se representan habitualmente como 32 dígitos hexadecimales, así que podemos tomar el número hexadecimal más alto de 32 dígitos (`ffffffffffffffffffffffffffffffff`) y convertirlo a decimal para obtener: 340,282,366,920,938,463,463,374,607,431,768,211,455. Eso son 39 dígitos, y en español redondeado: 340 undecillions.

Así que, si mis cuentas son correctas, tomamos el tiempo del sextillion (18365 años), lo multiplicamos por 1.000.000.000.000.000 (los 15 dígitos extra entre undecillion y sextillion) y luego por 340, ya que estamos hablando de 340 undecillions.

Eso son aproximadamente 6,244,100,000,000,000,000,000 años, es decir, 6,244,100,000,000 millones de milenios. Eso es lo que tardaría mi computador en iterar por todos los valores posibles de un GUID. ¿Qué tan único es eso entonces?
