---
title: "Cómo reemplazar new Regex(...) por el generador de código fuente [GeneratedRegex] en .NET 11"
description: "Una guía completa para convertir new Regex(pattern, RegexOptions.Compiled) en [GeneratedRegex] en .NET 11: la reescritura mecánica, métodos parciales frente a propiedades parciales, números medidos de arranque y throughput, los diagnósticos SYSLIB1040-1045 y los dos patrones donde el generador recae silenciosamente en un Regex en caché."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "source-generators"
  - "performance"
  - "native-aot"
lang: "es"
translationOf: "2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Si tu patrón es una constante en tiempo de compilación, borra `new Regex(pattern, RegexOptions.Compiled)` y pon `[GeneratedRegex(pattern)]` sobre un método parcial o una propiedad parcial que devuelva `Regex`. El generador de código fuente emite un tipo derivado de `Regex` en tiempo de compilación, así que no pagas ningún costo de análisis, optimización ni reflection-emit en runtime, el código es apto para trimming y compatible con Native AOT, y puedes entrar al motor de coincidencia con el depurador. En mis mediciones sobre .NET 10.0.201, el motor generado fue marginalmente más rápido que `RegexOptions.Compiled` en estado estable (35 ns frente a 37 ns por `IsMatch`) y llegó a su primera coincidencia en aproximadamente la mitad del tiempo (5.8 ms frente a 12.2 ms en un proceso frío).

Todo lo que sigue apunta a .NET 11 (Preview 6 al momento de escribir, SDK `11.0.100-preview.6`) con C# 14, pero el atributo y el generador son estables desde .NET 7, y los números de este artículo se midieron sobre el SDK .NET 10.0.201 porque es el SDK más reciente del que tengo un runtime completo. Nada de la superficie de la API cambió entre ambos.

## La conversión, de principio a fin

1. Confirma que el patrón es una constante en tiempo de compilación. Si se construye a partir de entrada del usuario o de configuración, detente aquí: el generador no puede ayudarte.
2. Marca el tipo contenedor como `partial`, junto con cada tipo dentro del cual está anidado.
3. Reemplaza el campo `static readonly Regex` por un método `static partial Regex` (o una propiedad `static partial Regex` de solo lectura en .NET 9 y posteriores).
4. Mueve el patrón, las opciones y cualquier tiempo de espera a un atributo `[GeneratedRegex]` sobre ese miembro.
5. Quita `RegexOptions.Compiled` de las opciones. El generador lo ignora.
6. Reescribe los puntos de llamada de `s_myRegex.IsMatch(text)` a `MyRegex().IsMatch(text)`.
7. Abre el archivo generado y revisa el comentario XML de la clase emitida. Si dice "Caches a `Regex` instance", el generador se rindió y no obtuviste nada.

El paso 7 es el que todo el mundo se salta, y es el que decide si el ejercicio completo valió la pena.

## Por qué el intérprete y RegexOptions.Compiled te cuestan algo

Cuando escribes `new Regex("somepattern")`, el patrón se analiza para formar un árbol, el árbol se optimiza y el resultado se escribe como opcodes para el intérprete de expresiones regulares. Cada coincidencia recorre luego esos opcodes. Funciona en todas partes y es barato de construir, pero cada despacho de opcode es una bifurcación que la CPU tiene que predecir.

`RegexOptions.Compiled` paga una factura de construcción mucho mayor para eliminar ese despacho. Hace todo lo que hace el intérprete y luego pasa el árbol de nodos resultante por un compilador basado en `System.Reflection.Emit` que escribe IL en un puñado de objetos `DynamicMethod`. Ese IL todavía tiene que compilarse con JIT en el primer uso. Como lo plantea [la documentación de Microsoft](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators), `RegexOptions.Compiled` "representa un compromiso fundamental entre las sobrecargas del primer uso y las sobrecargas de cada uso posterior". Peor aún, depende de la generación de código en runtime, así que en plataformas que prohíben el código generado dinámicamente, y bajo Native AOT, `Compiled` se convierte silenciosamente en una operación nula y vuelves al intérprete sin ninguna advertencia.

El generador de código fuente elimina el compromiso en lugar de negociar dentro de él. Ocurre el mismo trabajo de análisis y optimización, pero ocurre en la máquina de compilación, y lo que aterriza en tu ensamblado es C# ordinario que el compilador convierte en IL ordinario.

## La reescritura

Esta es la forma que tiene casi cualquier base de código:

```csharp
// .NET 11, C# 14 - the pattern you are replacing
private static readonly Regex s_email = new(
    @"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$",
    RegexOptions.Compiled);

public static bool IsEmail(string s) => s_email.IsMatch(s);
```

Y el equivalente con generación de código fuente:

```csharp
// .NET 11, C# 14
internal static partial class EmailRules
{
    [GeneratedRegex(@"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$")]
    private static partial Regex Email();

    public static bool IsEmail(string s) => Email().IsMatch(s);
}
```

Tres cosas a notar. La clase pasó a ser `partial`. `RegexOptions.Compiled` desapareció, porque el generador lo ignora y su presencia solo confunde al siguiente lector. Y el método no tiene cuerpo: tú lo declaras, el generador lo implementa.

No necesitas cachear nada por tu cuenta. La implementación generada devuelve un singleton `static readonly`, lo que puedes comprobar tú mismo en el código fuente emitido.

### Propiedades parciales, si una llamada a método se lee mal

Desde .NET 9 y C# 13, `[GeneratedRegex]` también se aplica a propiedades parciales de solo lectura, lo que se lee mejor cuando la expresión regular es conceptualmente un valor y no una operación:

```csharp
// .NET 11, C# 14 - requires C# 13 or later for partial properties
internal static partial class PhoneRules
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

La propiedad debe ser de solo lectura. Dale un setter y el generador la rechaza. No hay diferencia de comportamiento entre las dos formas; elige una y sé consistente.

### Opciones, cultura y tiempos de espera

El atributo tiene cinco sobrecargas de constructor, que van agregando opciones, un nombre de cultura y un tiempo de espera de coincidencia en milisegundos:

```csharp
// .NET 11, C# 14
[GeneratedRegex(
    pattern: "abc|def",
    options: RegexOptions.IgnoreCase | RegexOptions.Multiline,
    cultureName: "en-US",
    matchTimeoutMilliseconds: 1000)]
private static partial Regex AbcOrDef();
```

`cultureName` solo importa para la coincidencia sin distinción de mayúsculas y minúsculas. Si pasas `RegexOptions.CultureInvariant`, no debes pasar también un nombre de cultura, y el modo de falla ahí es genuinamente confuso. Mira los detalles más abajo.

## Cómo se ven los números en realidad

Medí esto en lugar de repetir el folclore. La configuración: una aplicación de consola sobre .NET 10.0.201, Windows 11 x64, compilación en Release, comparando el patrón de correo anclado de arriba contra 1 000 cadenas, un tercio de las cuales no coincide. Tres motores: el intérprete, `RegexOptions.Compiled` y `[GeneratedRegex]`.

Throughput en estado estable, 200 000 llamadas a `IsMatch` por ronda, la mejor de diez rondas tras tres rondas completas de calentamiento de cada motor:

| Motor | Tiempo | Por llamada |
| --- | --- | --- |
| Intérprete | 22.1 ms | 111 ns |
| `RegexOptions.Compiled` | 7.4 ms | 37 ns |
| `[GeneratedRegex]` | 7.0 ms | 35 ns |

Primera coincidencia en proceso frío, cada motor medido en su propio proceso para que nada esté precalentado, cuatro ejecuciones:

| Motor | Construcción más primer `IsMatch` |
| --- | --- |
| Intérprete | 3.7 a 4.0 ms |
| `RegexOptions.Compiled` | 12.0 a 12.7 ms |
| `[GeneratedRegex]` | 5.7 a 6.1 ms |

Lee esas dos tablas juntas. Frente a `Compiled`, el generador es una ganancia pequeña de throughput y una ganancia grande de arranque: el mismo estado estable, menos de la mitad del tiempo para llegar allí. Frente al intérprete, es una ganancia de throughput de 3.2x que cuesta unos 2 ms de arranque adicional en un proceso frío, la mayor parte del cual es tiempo de JIT para el motor emitido, y que desaparece por completo bajo Native AOT porque ya no queda JIT que pagar.

Una advertencia sobre medir esto tú mismo: mi primer intento mostraba al intérprete el doble de rápido que `Compiled`, lo cual es un disparate. La causa era que los tres motores compartían un único método de medición, así que el que corría primero absorbía el costo de JIT por niveles del propio arnés de medición. Calienta cada motor a través del arnés antes de medir cualquiera de ellos.

## El analizador ya lo sabe

No tienes que encontrar estos puntos de llamada a mano. El SDK de .NET incluye `SYSLIB1045`, un analizador de nivel informativo que marca cualquier uso de `Regex` convertible a generación de código fuente, junto con una corrección de código que hace la conversión por ti. Severidad informativa significa que aparece como una bombilla en el IDE y en ningún otro lado, así que escálalo:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.SYSLIB1045.severity = warning
```

Ahora `dotnet build` lista cada punto de llamada restante, y `dotnet format analyzers` puede aplicar la corrección en masa. Pon la severidad en `error` una vez que la base de código esté limpia, para que nadie agregue uno nuevo.

## Cuando el generador se rinde en silencio

Esta es la parte que muerde, porque no es un error ni una advertencia. Dos construcciones hacen que el generador se niegue a emitir un motor de coincidencia personalizado, y en ambos casos recae en emitir una instancia `Regex` sencilla en caché. Tu código compila, tus pruebas pasan y no obtuviste nada del beneficio.

La primera es `RegexOptions.NonBacktracking`, que ni el generador de código fuente ni `RegexCompiler` soportan. La segunda son las retroreferencias sin distinción de mayúsculas y minúsculas: hacer coincidir retroreferencias con `IgnoreCase` requiere una tabla interna de mayúsculas y minúsculas que vive dentro de `System.Text.RegularExpressions.dll` y no es accesible desde el código generado. Esta es la única construcción que `RegexCompiler` maneja y el generador de código fuente no.

Puedes ver ambas directamente. Agrega esto a tu archivo de proyecto:

```xml
<PropertyGroup>
  <EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>
  <CompilerGeneratedFilesOutputPath>generated</CompilerGeneratedFilesOutputPath>
</PropertyGroup>
```

Luego compila estos tres miembros y lee `generated/System.Text.RegularExpressions.Generator/.../RegexGenerator.g.cs`:

```csharp
// .NET 11, C# 14
internal static partial class NonBt
{
    [GeneratedRegex(@"\d+", RegexOptions.NonBacktracking)]
    internal static partial Regex Digits();
}

internal static partial class IgnoreCaseBackref
{
    [GeneratedRegex(@"(\w)\1", RegexOptions.IgnoreCase)]
    internal static partial Regex Doubled();
}

internal static partial class Fine
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

El archivo emitido es inequívoco sobre cuál de los tres funcionó:

```csharp
/// <summary>Caches a <see cref="Regex"/> instance for the Digits method.</summary>
/// <remarks>A custom Regex-derived type could not be generated because RegexOptions.NonBacktracking isn't supported.</remarks>
file sealed class Digits_0 : Regex
{
    internal static readonly Regex Instance = new("\\d+", RegexOptions.NonBacktracking);
}

/// <summary>Caches a <see cref="Regex"/> instance for the Doubled method.</summary>
/// <remarks>A custom Regex-derived type could not be generated because the expression contains case-insensitive backreferences which are not supported by the source generator.</remarks>
file sealed class Doubled_1 : Regex
{
    internal static readonly Regex Instance = new("(\\w)\\1", RegexOptions.IgnoreCase);
}

/// <summary>Custom <see cref="Regex"/>-derived type for the Phone method.</summary>
file sealed class Phone_2 : Regex
{
    internal static readonly Phone_2 Instance = new();
    // ... RunnerFactory, Runner, TryMatchAtCurrentPosition, and so on
}
```

"Caches a `Regex` instance" es el repliegue. "Custom `Regex`-derived type" es lo real. El generador también reporta `SYSLIB1044` para los casos de repliegue, pero su severidad es **Info**, así que no aparecerá en un log de compilación normal ni hará fallar CI. Si te importa, súbelo en `.editorconfig`:

```ini
dotnet_diagnostic.SYSLIB1044.severity = warning
```

El repliegue no es inútil. Sigues obteniendo el cacheo y los comentarios XML descriptivos. Pero si convertiste una ruta caliente esperando una mejora de velocidad, necesitas saber que no la obtuviste.

## Los diagnósticos, con sus mensajes reales

Estas son las cadenas exactas que emite el SDK de .NET 10, no paráfrasis:

| ID | Severidad | Mensaje |
| --- | --- | --- |
| `SYSLIB1040` | Error | Invalid `GeneratedRegexAttribute` usage. |
| `SYSLIB1041` | Error | Multiple `GeneratedRegexAttribute` attributes were applied to the same method, but only one is allowed. |
| `SYSLIB1042` | Error | The specified regex is invalid. |
| `SYSLIB1043` | Error | `GeneratedRegexAttribute` method or property must be partial, parameterless, non-generic, non-abstract, and return `Regex`. If a property, it must also be get-only. |
| `SYSLIB1044` | Info | The regex generator couldn't generate a complete source implementation for the specified regular expression due to an internal limitation. |
| `SYSLIB1045` | Info | Use `GeneratedRegexAttribute` to generate the regular expression implementation at compile time. |

## Detalles que cuestan tiempo real

**Un tipo contenedor no parcial no te da un error SYSLIB.** El generador emite su mitad del tipo parcial de todos modos, y es el compilador de C# el que se queja, con `CS0260: Missing partial modifier on declaration of type 'NotPartial'; another partial declaration of this type exists`. Si estás anidado a tres tipos de profundidad, los tres necesitan `partial`.

**`CultureInvariant` más un nombre de cultura explícito produce un mensaje engañoso.** Esta combinación:

```csharp
[GeneratedRegex(@"abc", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, "en-US")]
internal static partial Regex Abc();
```

falla con `error SYSLIB1042: The specified regex is invalid. 'cultureName'`. El patrón `abc` es obviamente correcto. El problema es que `CultureInvariant` y una cultura con nombre son mutuamente excluyentes, y el diagnóstico reutiliza el mensaje de patrón inválido con el nombre del argumento ofensor como carga útil. Quita el nombre de cultura, o quita `CultureInvariant`.

**Un `LangVersion` fijado rompe la compilación en el archivo generado, no en el tuyo.** El generador emite tipos con ámbito `file`, una característica de C# 11. Fuerza `LangVersion` a 10 y obtienes `CS8936: Feature 'file types' is not available in C# 10.0. Please use language version 11.0 or greater`, apuntando a `RegexGenerator.g.cs`. Las propiedades parciales suben el piso a C# 13: `CS8703: The modifier 'partial' is not valid for this item in C# 10.0. Please use language version '13.0' or greater`. Los SDK modernos ponen `LangVersion` por defecto a juego con el target framework, así que esto solo muerde a las bases de código que lo fijan explícitamente.

**La coincidencia sin distinción de mayúsculas y minúsculas queda congelada en tiempo de compilación.** Para una expresión regular insensible a mayúsculas, los motores expanden el patrón usando una tabla Unicode interna de mayúsculas y minúsculas, de modo que `abc` se convierte en el equivalente de `[Aa][Bb][Cc]`. Los otros motores hacen esa expansión en runtime, usando la tabla del runtime en el que estés. El generador de código fuente la hace en tiempo de compilación, usando la tabla del target framework contra el que compilaste. Si una futura revisión de Unicode cambia una equivalencia, una expresión regular generada mantiene el comportamiento antiguo hasta que recompiles. Esto está documentado en las [notas de `GeneratedRegexAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute) y casi nunca es un problema, pero "casi nunca" no es "nunca".

**Las comprobaciones de tiempo de espera se compilan dentro o fuera, globalmente.** El código generado lee el valor por defecto del ambiente una sola vez:

```csharp
internal static readonly TimeSpan s_defaultTimeout =
    AppContext.GetData("REGEX_DEFAULT_MATCH_TIMEOUT") is TimeSpan timeout
        ? timeout
        : Regex.InfiniteMatchTimeout;

internal static readonly bool s_hasTimeout = s_defaultTimeout != Regex.InfiniteMatchTimeout;
```

y protege cada llamada a `base.CheckTimeout()` dentro de los bucles con retroceso detrás de `s_hasTimeout`. Eso es bueno para el throughput en la ruta por defecto, y significa que si nunca configuras `REGEX_DEFAULT_MATCH_TIMEOUT` y nunca pasas `matchTimeoutMilliseconds`, un patrón con retroceso catastrófico frente a entrada hostil correrá hasta la muerte térmica de tu pipeline de solicitudes. Si un patrón toca entrada no confiable, pon `matchTimeoutMilliseconds` en el atributo, o cambia ese patrón concreto a `RegexOptions.NonBacktracking` y acepta el repliegue.

**El tamaño del código crece.** El generador emite C# real por cada patrón, y un patrón grande genera mucho. Si tienes cientos de expresiones regulares y solo un puñado son calientes, convertirlas todas cambia tamaño de binario por throughput que no vas a observar. El intérprete es la respuesta correcta para un patrón que corre dos veces durante el arranque.

## Dónde más importa esto: trimming y Native AOT

El argumento más fuerte a favor del generador no son los 2 ns por llamada. Es que `RegexOptions.Compiled` depende de `System.Reflection.Emit`, que es exactamente el tipo de dependencia que el [código seguro para trimming](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) evita y que [Native AOT](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/) elimina por completo. Bajo AOT, `Compiled` es una operación nula silenciosa y tu ruta caliente cuidadosamente optimizada está corriendo sobre el intérprete.

La generación de código fuente invierte eso. Como el motor de coincidencia es C# plano que el enlazador puede ver, el trimmer puede eliminar `RegexCompiler` y potencialmente el propio reflection-emit de la salida publicada, y el motor generado se compila de forma anticipada junto con todo lo demás. Si publicas con AOT, convertir cada patrón constante no es una optimización, es una corrección de una suposición que tu código está haciendo en silencio.

## Relacionados

- [¿Qué es un generador de código fuente y cuándo lo necesito?](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [RegexOptions.AnyNewLine aterriza en .NET 11 Preview 3](/es/2026/04/regex-anynewline-dotnet-11-preview-3/)
- [Cómo usar SearchValues correctamente en .NET 11](/es/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)
- [¿Qué es Native AOT y cuánto te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [¿Qué es el código seguro para trimming y cómo lo escribo?](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)

## Fuentes

- [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators) en Microsoft Learn
- [Referencia de la API de `GeneratedRegexAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute), incluidas las notas sobre la tabla de mayúsculas y minúsculas en tiempo de compilación
- [Diagnósticos SYSLIB para la generación de código fuente de expresiones regulares](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib1040-1049)
- [Regular Expression Improvements in .NET 7](https://devblogs.microsoft.com/dotnet/regular-expression-improvements-in-dotnet-7/) en el blog de .NET
- [`DiagnosticDescriptors.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.RegularExpressions/gen/DiagnosticDescriptors.cs) en dotnet/runtime, para la severidad de cada diagnóstico

Los números de rendimiento y el texto de los diagnósticos de este artículo se produjeron localmente sobre el SDK .NET 10.0.201, Windows 11 x64, configuración Release.
