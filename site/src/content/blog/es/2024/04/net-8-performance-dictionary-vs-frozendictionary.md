---
title: ".NET 8 ToFrozenDictionary: Dictionary vs FrozenDictionary"
description: "Convierte un Dictionary a un FrozenDictionary con `ToFrozenDictionary()` en .NET 8 para lecturas más rápidas. Benchmark, cuándo usarlo y la contrapartida en tiempo de compilación."
pubDate: 2024-04-27
updatedDate: 2025-03-27
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2024/04/net-8-performance-dictionary-vs-frozendictionary"
translatedBy: "claude"
translationDate: 2026-05-01
---
Con .NET 8 se nos presenta un nuevo tipo de diccionario que mejora el rendimiento de las operaciones de lectura. La contrapartida: no se permite hacer ningún cambio en las claves y los valores una vez que se crea la colección. Este tipo es particularmente útil para colecciones que se rellenan en el primer uso y luego se mantienen durante toda la duración de un servicio de larga vida.

Veamos qué significa esto en números. Me interesan dos cosas:

-   el rendimiento de creación del diccionario, ya que el trabajo realizado para optimizar la lectura probablemente tendrá un impacto en esto
-   el rendimiento de lectura para una clave aleatoria de la lista

## Impacto en el rendimiento durante la creación

Para esta prueba, tomamos 10.000 `KeyValuePair<string, string>` ya instanciados y creamos tres tipos diferentes de diccionarios:

-   un diccionario normal: `new Dictionary(source)`
-   un diccionario congelado: `source.ToFrozenDictionary(optimizeForReading: false)`
-   y un diccionario congelado optimizado para lectura: `source.ToFrozenDictionary(optimizeForReading: true)`

Y medimos cuánto tarda cada una de estas operaciones usando BenchmarkDotNet. Estos son los resultados:

```plaintext
|                              Method |       Mean |    Error |   StdDev |
|------------------------------------ |-----------:|---------:|---------:|
|                          Dictionary |   284.2 us |  1.26 us |  1.05 us |
|        FrozenDictionaryNotOptimized |   486.0 us |  4.71 us |  4.41 us |
| FrozenDictionaryOptimizedForReading | 4,583.7 us | 13.98 us | 12.39 us |
```

Ya sin optimización podemos ver que crear el `FrozenDictionary` cuesta aproximadamente el doble que crear el diccionario normal. Pero el verdadero impacto llega al optimizar los datos para lectura. En ese escenario obtenemos un aumento de `16x`. ¿Vale la pena? ¿Qué tan rápida es la lectura?

## Rendimiento de lectura del diccionario congelado

En este primer escenario, donde probamos la recuperación de una sola clave del 'centro' del diccionario, obtenemos los siguientes resultados:

```plaintext
|                              Method |      Mean |     Error |    StdDev |
|------------------------------------ |----------:|----------:|----------:|
|                          Dictionary | 11.609 ns | 0.0170 ns | 0.0142 ns |
|        FrozenDictionaryNotOptimized | 10.203 ns | 0.0218 ns | 0.0193 ns |
| FrozenDictionaryOptimizedForReading |  4.789 ns | 0.0121 ns | 0.0113 ns |
```

En esencia, el `FrozenDictionary` parece ser `2.4x` más rápido que el `Dictionary` normal. ¡Una mejora considerable!

Algo importante a tener en cuenta son las distintas unidades de medida aquí. Para la creación, los tiempos están en microsegundos, y en total perdemos unos 4299 us (microsegundos). Eso, convertido a ns (nanosegundos), son 4 299 000 ns. Esto significa que para obtener un beneficio de rendimiento al usar el `FrozenDictionary` tendríamos que realizar al menos 630 351 operaciones de lectura sobre él. Son muchas lecturas.

Veamos un par de escenarios de prueba más y qué impacto tienen en el rendimiento.

### Escenario 2: diccionario pequeño (100 elementos)

Los múltiplos parecen mantenerse al trabajar con un diccionario más pequeño. En términos de costo-beneficio, parece que empezamos a obtener ganancia un poco antes, tras unas 4800 operaciones de lectura.

```plaintext
|                                     Method |      Mean |     Error |    StdDev |
|------------------------------------------- |----------:|----------:|----------:|
|                          Dictionary_Create |  1.477 us | 0.0033 us | 0.0028 us |
| FrozenDictionaryOptimizedForReading_Create | 31.922 us | 0.1346 us | 0.1259 us |
|                            Dictionary_Read | 10.788 ns | 0.0156 ns | 0.0122 ns |
|   FrozenDictionaryOptimizedForReading_Read |  4.444 ns | 0.0155 ns | 0.0129 ns |
```

### Escenario 3: leer claves desde distintas posiciones

En este escenario probamos si el rendimiento se ve afectado de algún modo por la clave que estamos recuperando (su posición dentro de la estructura de datos interna). Y según los resultados, no tiene ningún impacto en el rendimiento de lectura.

```plaintext
|                                     Method |      Mean |     Error |    StdDev |
|------------------------------------------- |----------:|----------:|----------:|
|  FrozenDictionaryOptimizedForReading_First |  4.314 ns | 0.0102 ns | 0.0085 ns |
| FrozenDictionaryOptimizedForReading_Middle |  4.311 ns | 0.0079 ns | 0.0066 ns |
|   FrozenDictionaryOptimizedForReading_Last |  4.314 ns | 0.0180 ns | 0.0159 ns |
```

### Escenario 4: diccionario grande (10 millones de elementos)

En el caso de diccionarios grandes, el rendimiento de lectura permanece casi igual. Vemos un aumento del 18 % en el tiempo de lectura, pese a un aumento de `1000x` en el tamaño del diccionario. Sin embargo, el número objetivo de lecturas necesarias para obtener una ganancia neta de rendimiento sube significativamente, hasta 2 135 735 439, esto es, más de 2 mil millones de lecturas.

```plaintext
|                                     Method |        Mean |     Error |    StdDev |
|------------------------------------------- |------------:|----------:|----------:|
|                          Dictionary_Create |    905.1 ms |   2.56 ms |   2.27 ms |
| FrozenDictionaryOptimizedForReading_Create | 13,886.4 ms | 276.22 ms | 483.77 ms |
|                            Dictionary_Read |   11.203 ns | 0.2601 ns | 0.3472 ns |
|   FrozenDictionaryOptimizedForReading_Read |    5.125 ns | 0.0295 ns | 0.0230 ns |
```

### Escenario 5: clave compleja

Aquí los resultados son muy interesantes. Nuestra clave se ve así:

```cs
public class MyKey
{
    public string K1 { get; set; }

    public string K2 { get; set; }
}
```

Y como podemos ver, en este caso casi no hay mejoras de rendimiento en la lectura comparado con el `Dictionary` normal, mientras que la creación del diccionario es unas 4 veces más lenta.

```plaintext
|                                     Method |     Mean |     Error |    StdDev |
|------------------------------------------- |---------:|----------:|----------:|
|                          Dictionary_Create | 247.7 us |   3.27 us |   3.05 us |
| FrozenDictionaryOptimizedForReading_Create | 991.2 us |   8.75 us |   8.18 us |
|                            Dictionary_Read | 6.344 ns | 0.0602 ns | 0.0533 ns |
|   FrozenDictionaryOptimizedForReading_Read | 6.041 ns | 0.0954 ns | 0.0845 ns |
```

### Escenario 6: usando records

Pero ¿y si usáramos un `record` en lugar de una `class`? Eso debería ofrecer más rendimiento, ¿verdad? Aparentemente no. Es aún más extraño, ya que los tiempos de lectura saltan de `6 ns` a `44 ns`.

```plaintext
|                                     Method |       Mean |    Error |   StdDev |
|------------------------------------------- |-----------:|---------:|---------:|
|                          Dictionary_Create |   654.1 us |  2.29 us |  2.14 us |
| FrozenDictionaryOptimizedForReading_Create | 1,761.4 us |  8.67 us |  8.11 us |
|                            Dictionary_Read |   45.37 ns | 0.088 ns | 0.082 ns |
|   FrozenDictionaryOptimizedForReading_Read |   44.44 ns | 0.120 ns | 0.107 ns |
```

## Conclusiones

Según los escenarios probados, la única mejora que vimos fue al usar claves de tipo `string`. Cualquier otra cosa que probamos hasta ahora dio el mismo rendimiento de lectura que el `Dictionary` normal, con una sobrecarga adicional en la creación.

Incluso cuando uses `string` como clave de tu `FrozenDictionary`, debes considerar cuántas lecturas vas a realizar durante la vida útil de ese diccionario, ya que existe una sobrecarga asociada a su creación. En la prueba con 10 000 elementos, esa sobrecarga fue de unos 4 299 000 ns. El rendimiento de lectura mejoró `2.4x`, pasando de `11.6 ns` a `4.8 ns`, pero esto sigue significando que necesitas aproximadamente 630 351 operaciones de lectura sobre el diccionario para obtener una ganancia neta de rendimiento.
