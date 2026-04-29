---
title: "Cómo usar SearchValues<T> correctamente en .NET 11"
description: "SearchValues<T> supera a IndexOfAny entre 5x y 250x, pero solo si lo usas como espera el runtime. La regla de cachear como static, la trampa de StringComparison, cuándo no vale la pena, y el truco de inversión con IndexOfAnyExcept que nadie documenta."
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "csharp"
  - "searchvalues"
lang: "es"
translationOf: "2026/04/how-to-use-searchvalues-correctly-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-29
---

`SearchValues<T>` vive en `System.Buffers`. Es un conjunto inmutable y precomputado de valores que se usa con los métodos de extensión `IndexOfAny`, `IndexOfAnyExcept`, `ContainsAny`, `LastIndexOfAny` y `LastIndexOfAnyExcept` sobre `ReadOnlySpan<T>`. La regla que el 90% del uso incumple es simple: construye la instancia de `SearchValues<T>` una sola vez, guárdala en un campo `static readonly` y reutilízala. Si la construyes dentro del método caliente, mantienes todo el costo (la selección de la estrategia SIMD, la asignación del bitmap, el autómata Aho-Corasick para la sobrecarga de strings) y pierdes todo el beneficio. La otra regla: no recurras a `SearchValues<T>` para conjuntos de uno o dos valores. `IndexOf` ya está vectorizado para los casos triviales y es más rápido.

Este post apunta a .NET 11 (preview 4) en x64 y ARM64. Las sobrecargas de byte y char de `SearchValues.Create` son estables desde .NET 8. La sobrecarga de string (`SearchValues<string>`) es estable desde .NET 9 y no ha cambiado en .NET 10 ni en .NET 11. El comportamiento descrito a continuación es idéntico en Windows, Linux y macOS, porque las rutas de código SIMD se comparten entre plataformas, y se recurre a código escalar solo cuando AVX2 / AVX-512 / NEON no están disponibles.

## Por qué existe SearchValues

`ReadOnlySpan<char>.IndexOfAny('a', 'b', 'c')` es una llamada única. El runtime no puede saber si la próxima llamada usará el mismo conjunto u otro distinto, así que tiene que elegir una estrategia de búsqueda en el momento, cada vez. Para tres caracteres el JIT incrusta una ruta vectorizada hecha a mano, así que el sobrecosto es pequeño, pero en cuanto el conjunto crece más allá de cuatro o cinco elementos, `IndexOfAny` cae a un bucle genérico con verificación de pertenencia a un hash-set por carácter. Ese bucle está bien para entradas cortas y es un desastre para entradas largas.

`SearchValues<T>` desacopla el paso de planificación del paso de búsqueda. Cuando llamas a `SearchValues.Create(needles)`, el runtime inspecciona los valores buscados una sola vez: ¿son un rango contiguo? ¿un conjunto disperso? ¿comparten prefijos (para la sobrecarga de strings)? Elige una de varias estrategias (bitmap con shuffle de `Vector256`, `IndexOfAnyAsciiSearcher`, `ProbabilisticMap`, `Aho-Corasick`, `Teddy`) y guarda los metadatos dentro de la instancia. Cada llamada posterior contra esa instancia se salta la planificación y despacha directo al kernel elegido. Para un conjunto de 12 elementos típicamente verás una mejora de 5x a 50x sobre la sobrecarga correspondiente de `IndexOfAny`. Para conjuntos de strings con 5 o más elementos verás de 50x a 250x sobre un bucle manual de `Contains`.

La asimetría es el punto: planificar es caro, buscar es barato. Si construyes un `SearchValues<T>` nuevo por llamada, estás pagando el planificador sin amortizarlo.

## La regla de cachear como static

Este es el patrón canónico. Fíjate en el `static readonly`:

```csharp
// .NET 11, C# 14
using System.Buffers;

internal static class CsvScanner
{
    private static readonly SearchValues<char> Delimiters =
        SearchValues.Create(",;\t\r\n\"");

    public static int FindNextDelimiter(ReadOnlySpan<char> input)
    {
        return input.IndexOfAny(Delimiters);
    }
}
```

La versión equivocada, que veo en PRs cada semana:

```csharp
// .NET 11 -- BROKEN, do not ship
public static int FindNextDelimiter(ReadOnlySpan<char> input)
{
    var delims = SearchValues.Create(",;\t\r\n\"");
    return input.IndexOfAny(delims);
}
```

Parece inocente. Asigna en cada llamada, y el planificador corre en cada llamada. Benchmarks que ejecuté en .NET 11 preview 4 con `BenchmarkDotNet`:

```
| Method                     | Mean       | Allocated |
|--------------------------- |-----------:|----------:|
| StaticSearchValues_1KB     |    71.4 ns |       0 B |
| RebuiltSearchValues_1KB    |   312.0 ns |     208 B |
| LoopWithIfChain_1KB        |   846.0 ns |       0 B |
```

La asignación es la mitad más peligrosa. Un `Create` mal puesto en una ruta caliente se convierte en un flujo constante de basura cercana al LOH. En un servicio de 100k requests/seg eso son gigabytes por minuto presionando al GC por un valor que deberías estar reutilizando.

Si no puedes usar `static readonly` porque los valores buscados los proporciona el usuario al inicio, construye la instancia una sola vez durante la inicialización y guárdala en un servicio singleton:

```csharp
// .NET 11, C# 14
public sealed class TokenScanner
{
    private readonly SearchValues<string> _tokens;

    public TokenScanner(IEnumerable<string> tokens)
    {
        _tokens = SearchValues.Create(tokens.ToArray(), StringComparison.Ordinal);
    }

    public bool ContainsAny(ReadOnlySpan<char> input) => input.ContainsAny(_tokens);
}
```

Regístralo como singleton en la inyección de dependencias. No lo registres como transient. Transient te da la misma trampa de reconstrucción por llamada con pasos extra.

## La trampa de StringComparison

`SearchValues<string>` (la sobrecarga multi-string añadida en .NET 9) recibe un argumento `StringComparison`:

```csharp
private static readonly SearchValues<string> Forbidden =
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);
```

Solo se admiten cuatro valores: `Ordinal`, `OrdinalIgnoreCase`, `InvariantCulture` e `InvariantCultureIgnoreCase`. Si pasas `CurrentCulture` o `CurrentCultureIgnoreCase`, el constructor lanza `ArgumentException` al inicio. Esto es correcto: una búsqueda multi-string sensible a la cultura tendría que asignar por llamada para honrar la cultura del hilo actual, lo que anularía la precomputación.

Dos consecuencias:

- Para datos ASCII, usa siempre `Ordinal` u `OrdinalIgnoreCase`. Son de 5x a 10x más rápidos que las variantes invariantes porque el runtime despacha a un kernel Teddy que opera sobre bytes crudos. Las variantes invariantes pagan por el plegado de mayúsculas/minúsculas Unicode incluso en entradas exclusivamente ASCII.
- Si necesitas insensibilidad a mayúsculas/minúsculas correcta por idioma (la I con punto del turco, la sigma griega), `SearchValues<string>` no es tu herramienta. Recurre a `string.Contains(needle, StringComparison.CurrentCultureIgnoreCase)` en un bucle y acepta el costo. La coincidencia de strings sensible al idioma es fundamentalmente no vectorizable.

Las sobrecargas de `char` y `byte` no tienen parámetro `StringComparison`. Coinciden de forma exacta. Si quieres coincidencia ASCII insensible a mayúsculas/minúsculas con `SearchValues<char>`, incluye ambas formas en el conjunto:

```csharp
// case-insensitive ASCII vowels in .NET 11, C# 14
private static readonly SearchValues<char> Vowels =
    SearchValues.Create("aeiouAEIOU");
```

Más barato que llamar primero a `ToLowerInvariant` sobre la entrada.

## Pertenencia al conjunto: SearchValues.Contains no es lo que crees

`SearchValues<T>` expone un método `Contains(T)`:

```csharp
SearchValues<char> set = SearchValues.Create("abc");
bool isInSet = set.Contains('b'); // true
```

Léelo con cuidado: esto comprueba si un único valor está en el conjunto. Es el equivalente de `HashSet<T>.Contains`, no una búsqueda de subcadena. La gente recurre a él esperando la semántica de `string.Contains` y publica código que pregunta "¿está el carácter 'h' en mi conjunto de tokens prohibidos?" en lugar de "¿mi entrada contiene algún token prohibido?". Ese tipo de bug pasa la verificación de tipos y se ejecuta.

Las llamadas correctas para "¿la entrada contiene alguno de estos?":

- `ReadOnlySpan<char>.ContainsAny(SearchValues<char>)` para conjuntos de char.
- `ReadOnlySpan<char>.ContainsAny(SearchValues<string>)` para conjuntos de string.
- `ReadOnlySpan<byte>.ContainsAny(SearchValues<byte>)` para conjuntos de byte.

Usa `SearchValues<T>.Contains(value)` solo cuando realmente tienes un único valor y quieres una búsqueda en el conjunto, por ejemplo dentro de un tokenizador personalizado que decide si el carácter actual es un delimitador.

## El truco de inversión con IndexOfAnyExcept

`IndexOfAnyExcept(SearchValues<T>)` devuelve el índice del primer elemento que **no** está en el conjunto. Esta es la forma de encontrar el inicio del contenido significativo en una cadena después de espacios en blanco iniciales, relleno o ruido, en una sola pasada SIMD:

```csharp
// .NET 11, C# 14
private static readonly SearchValues<char> WhitespaceAndQuotes =
    SearchValues.Create(" \t\r\n\"'");

public static ReadOnlySpan<char> TrimStart(ReadOnlySpan<char> input)
{
    int firstReal = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    return firstReal < 0 ? ReadOnlySpan<char>.Empty : input[firstReal..];
}
```

Esto le gana a `string.TrimStart(' ', '\t', '\r', '\n', '"', '\'')` en entradas con largas secuencias iniciales porque `TrimStart` cae a un bucle por carácter para conjuntos por encima de cuatro. Para el caso típico de "quitar 64 espacios de indentación", espera una mejora de 4x a 8x.

`LastIndexOfAnyExcept` es el equivalente del lado derecho. Juntos te dan un `Trim` vectorizado:

```csharp
public static ReadOnlySpan<char> TrimBoth(ReadOnlySpan<char> input)
{
    int start = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    if (start < 0) return ReadOnlySpan<char>.Empty;

    int end = input.LastIndexOfAnyExcept(WhitespaceAndQuotes);
    return input[start..(end + 1)];
}
```

Dos rebanadas, dos escaneos SIMD, cero asignaciones. La sobrecarga ingenua `string.Trim(charsToTrim)` asigna un arreglo temporal internamente en .NET 11 incluso cuando la entrada no necesita recortarse.

## Cuándo usar byte en lugar de char

Para parseo de protocolos (HTTP, JSON, CSV ASCII, líneas de log), la entrada suele ser `ReadOnlySpan<byte>`, no `ReadOnlySpan<char>`. Construir `SearchValues<byte>` a partir de los valores de byte ASCII es notablemente más rápido que decodificar primero a UTF-16:

```csharp
// .NET 11, C# 14 -- HTTP header value sanitiser
private static readonly SearchValues<byte> InvalidHeaderBytes =
    SearchValues.Create([(byte)'\0', (byte)'\r', (byte)'\n', (byte)'\t']);

public static bool IsValidHeaderValue(ReadOnlySpan<byte> value)
{
    return value.IndexOfAny(InvalidHeaderBytes) < 0;
}
```

La ruta de byte tira de 32 bytes por ciclo AVX2 vs 16 chars; en hardware capaz de AVX-512 tira de 64 bytes vs 32 chars. Para datos ASCII duplicas tu rendimiento al saltarte el desvío UTF-16.

El compilador no te avisa si por accidente usas codepoints `char` por encima de 127 de una forma que rompe. Pero el planificador de SearchValues sí emite una ruta lenta deliberada cuando el conjunto de char abarca más allá del rango BMP-ASCII con propiedades bidi mixtas. Si tu benchmark dice "esto se puso más lento de lo que esperaba", revisa si pusiste un carácter no ASCII en un conjunto que se suponía solo ASCII.

## Cuándo NO usar SearchValues

Una lista corta de casos donde la respuesta correcta es "no te molestes":

- **Un solo valor buscado**. `span.IndexOf('x')` ya está vectorizado. `SearchValues.Create("x")` añade sobrecosto.
- **Dos o tres chars buscados, llamados rara vez**. `span.IndexOfAny('a', 'b', 'c')` está bien. El punto de equilibrio está en torno a cuatro valores para char y en torno a dos para string.
- **Entradas más cortas que 16 elementos**. Los kernels SIMD tienen costo de inicialización. Para un span de 8 caracteres, gana la comparación escalar.
- **Valores buscados que cambian en cada llamada**. El punto entero de `SearchValues` es la amortización. Si el conjunto es entrada del usuario por llamada, quédate con las sobrecargas de `IndexOfAny` o `Regex` con `RegexOptions.Compiled`.
- **Necesitas captura de grupos o referencias inversas**. `SearchValues` solo hace coincidencia literal. No es un reemplazo de regex, solo un `Contains` más rápido.

## Inicialización estática sin asignaciones

Las sobrecargas de `Create` aceptan `ReadOnlySpan<T>`. Puedes pasar un literal de string (el compilador de C# convierte literales de string a `ReadOnlySpan<char>` mediante `RuntimeHelpers.CreateSpan` desde .NET 7), un arreglo o una expresión de colección. Las tres producen la misma instancia de `SearchValues<T>`; el compilador no genera arreglos intermedios para la forma con literal de string.

```csharp
// .NET 11, C# 14 -- all three are equivalent in cost at runtime
private static readonly SearchValues<char> A = SearchValues.Create("abc");
private static readonly SearchValues<char> B = SearchValues.Create(['a', 'b', 'c']);
private static readonly SearchValues<char> C = SearchValues.Create(new[] { 'a', 'b', 'c' });
```

Para la sobrecarga de string, la entrada debe ser un arreglo (`string[]`) o una expresión de colección que apunte a uno:

```csharp
private static readonly SearchValues<string> Tokens =
    SearchValues.Create(["select", "insert", "update"], StringComparison.OrdinalIgnoreCase);
```

El constructor copia los valores buscados a su estado interno, por lo que el arreglo de origen no se retiene. Mutar el arreglo después de la construcción no afecta a la instancia de `SearchValues<string>`. Esto es lo opuesto a `Regex` con patrones cacheados, donde la cadena de origen sí se retiene.

## Patrón amigable con generadores de código fuente

Si tienes una clase `partial` y un generador de código (propio o `System.Text.RegularExpressions.GeneratedRegex`), generar un campo `static readonly SearchValues<char>` como parte de la salida generada es un patrón limpio. Seguro frente a trim, seguro frente a AOT, sin reflexión, sin asignaciones por llamada en el heap.

```csharp
// .NET 11, C# 14 -- hand-rolled equivalent of what a generator would emit
internal static partial class IdentifierScanner
{
    private static readonly SearchValues<char> NonIdentifierChars =
        SearchValues.Create(GetNonIdentifierAscii());

    private static ReadOnlySpan<char> GetNonIdentifierAscii()
    {
        // Build a 96-element set of non-[A-Za-z0-9_] ASCII chars at type init.
        Span<char> buffer = stackalloc char[96];
        int i = 0;
        for (int c = ' '; c <= '~'; c++)
        {
            if (!(char.IsAsciiLetterOrDigit((char)c) || c == '_'))
                buffer[i++] = (char)c;
        }
        return buffer[..i].ToArray();
    }
}
```

El `stackalloc` se ejecuta una sola vez porque `static readonly` lo inicializa exactamente una vez el inicializador de tipos del runtime. El `.ToArray()` es la única asignación en la vida del tipo. Después de eso, cada búsqueda está libre de asignaciones.

## Native AOT y avisos de trim

`SearchValues<T>` es totalmente compatible con Native AOT. No hay reflexión por dentro, no hay generación de código dinámica en runtime. Tu binario publicado con AOT contiene los mismos kernels SIMD que la versión JIT, seleccionados en tiempo de compilación AOT según la ISA de destino que hayas especificado (`-r linux-x64` por defecto incluye x64 base con rutas SSE2 + AVX2; `-p:TargetIsa=AVX-512` extiende a AVX-512). Sin avisos de trim, sin anotaciones `[DynamicallyAccessedMembers]` necesarias.

Si publicas para `linux-arm64`, los kernels NEON se eligen automáticamente. El mismo código fuente compila para ambos destinos sin código condicional.

## Lectura relacionada

- [Span<T> vs ReadOnlySpan<T> y cuándo cada uno se gana su lugar](/2026/01/net-10-performance-searchvalues/) cubre una instantánea anterior de `SearchValues` de la era de .NET 10; vuelve a verla por el contexto SIMD.
- [Channels en lugar de BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) es el transporte adecuado cuando escaneas entradas en un worker.
- [Cómo leer un CSV grande en .NET 11 sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) usa `SearchValues<char>` para escaneo de delimitadores en el parser.
- [Cómo detectar cuándo un archivo termina de escribirse en .NET](/es/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) encaja naturalmente con el escáner CSV de arriba al consumir archivos de bandeja de entrada.

## Fuentes

- [Referencia de `SearchValues<T>`, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues-1) -- la superficie de API canónica, incluyendo las sobrecargas de byte / char / string de `Create`.
- [`SearchValues.Create(ReadOnlySpan<string>, StringComparison)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues.create) -- documenta los cuatro valores de `StringComparison` admitidos y la `ArgumentException` lanzada para los demás.
- [.NET runtime PR 90395 -- `SearchValues<T>` inicial](https://github.com/dotnet/runtime/pull/90395) -- la introducción de las sobrecargas de byte y char en .NET 8 con la tabla de estrategias SIMD.
- [.NET runtime PR 96570 -- `SearchValues<string>`](https://github.com/dotnet/runtime/pull/96570) -- la incorporación en .NET 9 de los kernels Aho-Corasick / Teddy multi-string.
- [Boosting string search performance in .NET 8.0 with SearchValues, endjin](https://endjin.com/blog/2024/01/dotnet-8-searchvalues-string-search-performance-boost) -- el benchmark externo más limpio para la ruta de char.
