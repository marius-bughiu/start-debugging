---
title: "Qué es ref-safe-context en C# y cómo lo decide el compilador para los ref locals"
description: "ref-safe-context es el ámbito en el que una referencia a una variable sigue siendo válida. Aquí están los cuatro contextos, la regla que fija el contexto de un ref local en su inicializador, por qué la reasignación de ref nunca puede ampliarlo ni reducirlo, y los errores CS8157, CS8168, CS8374 y CS9079 que se derivan de ello, con la salida del compilador de C# 14 en .NET 10 y .NET 11 RC1."
pubDate: 2026-10-15
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
lang: "es"
translationOf: "2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals"
translatedBy: "claude"
translationDate: 2026-10-15
---

Respuesta corta: ref-safe-context (contexto seguro de referencia) es la región de código en la que se garantiza que una referencia (un `ref` local, un `ref` return, un `ref` field) a una variable dada apunta a memoria viva. El compilador de C# asigna a cada variable uno de cuatro contextos, del más estrecho al más amplio: declaration-block, function-member, return-only y caller-context. Un `ref` local no obtiene un contexto propio. Copia el ref-safe-context de la expresión con la que fue inicializado, ese contexto queda fijo durante el resto de su vida, y cada `r = ref other;` posterior debe apuntar a algo cuyo contexto sea al menos igual de amplio. Esa única regla explica por qué un `ref` local inicializado a partir de un local de pila nunca se puede devolver, aunque más tarde lo reasignes a un elemento de un arreglo.

Todos los resultados de este artículo provienen de compilaciones reales: el SDK de .NET 10 10.0.302 con `<LangVersion>14</LangVersion>`, y los mismos archivos recompilados con el SDK de .NET 11 RC1 (11.0.100-rc.1.26425.128). Los diagnósticos son idénticos en ambos, y están pegados de la salida del compilador, no parafraseados.

## Por qué el compilador sigue un "contexto"

Un `ref` en C# es un puntero administrado. Puede apuntar al heap (un elemento de un arreglo, un campo de una instancia de clase), a almacenamiento estático o a un marco de pila (un local, un parámetro). La memoria del heap y la estática sobreviven a cualquier llamada a método. Un marco de pila muere cuando su método retorna. Si un método pudiera entregar un `ref` a uno de sus propios locales, quien lo llamó tendría un puntero a un marco muerto, que es exactamente el bug de uso después de liberar que `ref` fue diseñado para no tener.

C# no resuelve esto con una comprobación en tiempo de ejecución. Lo resuelve de forma estática: cada variable recibe un ref-safe-context que describe hasta dónde puede viajar una referencia a ella, y cada lugar que almacena o devuelve una referencia comprueba que el contexto del referente sea al menos tan amplio como el de la propia referencia. El estándar de C# lo resume en una frase en la [sección 9.7.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts): "The referent of a reference variable shall have a ref-safe-context that is at least as wide as the ref-safe-context of the reference variable itself."

Hay un concepto hermano, safe-context (contexto seguro), que se aplica a valores de tipos `ref struct` como `Span<T>`. Ref-safe-context responde a "¿cuánto tiempo es válida una referencia a esta variable?". Safe-context responde a "¿cuánto tiempo es válido el valor almacenado en esta variable (que a su vez contiene referencias)?". La mayor parte de este artículo trata del primero, pero se encuentran en los indexadores de `Span<T>`, que se cubre más abajo.

## Los cuatro contextos, del más estrecho al más amplio

| Contexto | Quién lo tiene | ¿Se puede devolver con ref? |
| --- | --- | --- |
| declaration-block | Locales ordinarios, con alcance al bloque donde se declaran | No |
| function-member | Parámetros por valor, parámetros `out`, `this` en un método de struct, locales y parámetros `scoped ref` | No |
| return-only | Parámetros `ref` e `in` | Sí, solo mediante `return ref` |
| caller-context | Elementos de arreglos, campos de instancias de clase, campos estáticos, campos alcanzados a través de parámetros `ref` | Sí |

Hay dos detalles fáciles de pasar por alto. Primero, declaration-block es realmente por bloque: un local declarado dentro del cuerpo de un `if` tiene un contexto más estrecho que uno declarado al inicio del método. Segundo, return-only existe para que un parámetro `ref` se pueda devolver (`return ref p;` es legal), pero no se pueda almacenar en un lugar que sobreviva a la llamada, como un `ref` field de un `ref struct` pasado por quien llama. Ese nivel se añadió en C# 11 como parte de las [mejoras de structs de bajo nivel](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements).

Aquí está la base en código, con todos los métodos compilados bajo C# 14:

```csharp
// .NET 10 SDK 10.0.302, C# 14 (same result on .NET 11 RC1)
class Contexts
{
    int[] _arr = new int[10];
    static int s_counter;

    // declaration-block: error CS8168
    static ref int FromLocal() { int v = 5; return ref v; }

    // function-member (value parameter): error CS8157 once aliased
    static ref int FromValueParam(int p) { ref int r = ref p; return ref r; }

    // return-only (ref parameter): OK
    static ref int FromRefParam(ref int p) { ref int r = ref p; return ref r; }

    // caller-context (array element): OK
    ref int FromArray() { ref int r = ref _arr[3]; return ref r; }

    // caller-context (static field): OK
    static ref int FromStatic() { ref int r = ref s_counter; return ref r; }
}
```

Los dos errores:

```text
error CS8168: Cannot return local 'v' by reference because it is not a ref local
error CS8157: Cannot return 'r' by reference because it was initialized to a value that cannot be returned by reference
```

Lee con atención el texto de CS8157: "because it was initialized to" (porque fue inicializado con). El compilador no mira a qué apunta `r` en el `return`. Mira con qué fue inicializado `r`.

## Cómo obtiene su contexto un ref local

La regla del estándar para los locales ([sección 9.7.2.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9722-local-variable-ref-safe-context)) tiene dos líneas:

- Si `v` es una variable de referencia, su ref-safe-context es el mismo que el ref-safe-context de su expresión de inicialización.
- En caso contrario, su ref-safe-context es declaration-block.

Así, el compilador decide el contexto de un `ref` local en un solo lugar: la declaración. La expresión inicializadora se evalúa para obtener su contexto con estas reglas:

1. Un local o un parámetro por valor: su propio contexto (declaration-block o function-member).
2. Un parámetro `ref` o `in`: return-only.
3. Un campo `e.F` de una instancia de clase, un elemento de arreglo, un campo estático: caller-context.
4. Un campo `e.F` de un struct: el contexto de `e`. Un campo de un struct local es declaration-block; un campo de `this` dentro de un método de struct es function-member.
5. Un condicional `c ? ref a : ref b`: el más estrecho entre `a` y `b`.
6. Una llamada a un método, propiedad o indexador que devuelve `ref`: el más estrecho entre caller-context y el ref-safe-context de cada argumento `ref` (más el safe-context de cada argumento, incluido el receptor), omitiendo los argumentos enlazados a parámetros `scoped` y `out`.

La regla 6 es la que sorprende a la gente, porque significa que un helper perfectamente inocente puede envenenar un `ref` local:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int Pick(ref int a) => ref a;

static ref int ThroughHelper()
{
    int v = 5;
    ref int r = ref Pick(ref v); // r inherits v's declaration-block context
    return ref r;                // error CS8157
}
```

`Pick` en sí está bien, devuelve su propio parámetro `ref`. Pero el compilador no mira dentro de `Pick`. Solo ve la firma: "devuelve un `ref` que puede ser cualquiera de mis argumentos `ref`", así que el contexto del resultado es el del argumento más estrecho, y ese argumento es un local. Así es como la especificación evita blanquear una referencia a la pila a través de una llamada a método.

La salida, cuando el helper realmente nunca devuelve ese argumento, es decirlo con `scoped`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int PickSecond(scoped ref int a, ref int b) => ref b;

static ref int Fine(ref int b)
{
    int v = 5;
    ref int r = ref PickSecond(ref v, ref b); // only b contributes: return-only
    return ref r;                             // OK
}
```

Un parámetro `scoped ref` no puede ser devuelto ni capturado por el método llamado, así que ya no contribuye al contexto del resultado. El operador condicional no tiene una salida de emergencia así:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Either(bool f)
{
    int v = 1;
    ref int r = ref f ? ref _arr[0] : ref v; // narrowest wins: declaration-block
    return ref r;                            // error CS8157
}
```

## La reasignación de ref no puede ampliar ni reducir

Desde C# 7.3, un `ref` local puede apuntar a otro lugar con `r = ref other;`. La regla de la [sección 9.7.2.9](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9729-limitations-on-reference-variables) es: "For a ref reassignment `e1 = ref e2`, the ref-safe-context of `e2` shall be at least as wide a context as the ref-safe-context of `e1`." El contexto del local no cambia como resultado. Eso tiene consecuencias en ambas direcciones.

**Reducir es un error.** Inicializa a partir de un elemento de arreglo y luego intenta apuntar a un local:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Narrowing()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    return ref r;
}
```

```text
error CS8374: Cannot ref-assign 'v' to 'r' because 'v' has a narrower escape scope than 'r'.
```

Lo mismo ocurre entre bloques anidados, que es la versión con la que la gente se topa en bucles reales:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static void NestedBlock()
{
    int outer = 1;
    ref int r = ref outer;   // declaration-block of the method body
    {
        int inner = 2;
        r = ref inner;       // error CS8374: inner's block is narrower
    }
}
```

**Ampliar está permitido pero no ayuda.** Inicializa a partir de un local y luego apunta a un elemento de arreglo. La reasignación compila. El return no:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Widening()
{
    int v = 1;
    ref int r = ref v;   // declaration-block, fixed forever
    r = ref _arr[0];     // OK: caller-context is wider
    return ref r;        // error CS8157: r was *initialized* to a local
}
```

Esto es insensible al flujo a propósito. El compilador no rastrea que `r` casualmente apunte ahora al heap. Solo conoce el contexto declarado, y ese es declaration-block.

**La trampa de return-only.** Un parámetro `ref` es return-only, que es más estrecho que caller-context. Por eso esto falla, con un código de error distinto:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int FieldThenParam(ref int p)
{
    ref int r = ref _arr[0]; // caller-context
    r = ref p;               // error CS9079
    return ref r;
}
```

```text
error CS9079: Cannot ref-assign 'p' to 'r' because 'p' can only escape the current method through a return statement.
```

Tanto `_arr[0]` como `p` se pueden devolver por separado, y aun así la combinación se rechaza. La solución en todos estos casos es la misma: inicializa el `ref` local con el referente **más estrecho** que vaya a contener, y luego reasígnalo a otros más amplios.

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ParamThenField(ref int p, bool useField)
{
    ref int r = ref p;               // return-only
    if (useField) r = ref _arr[0];   // caller-context is wider: OK
    return ref r;                    // OK: return-only is returnable
}
```

## Locales `scoped ref`: optar por un contexto más estrecho

También puedes estrechar un `ref` local de forma deliberada. Declararlo `scoped ref` le da contexto function-member sin importar el inicializador:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ScopedLocal()
{
    scoped ref int r = ref _arr[0]; // function-member, despite caller-context initializer
    return ref r;                   // error CS8157
}
```

Por sí solo parece inútil. Rinde cuando el local se reasigna después a algo más estrecho. Compara los dos métodos siguientes, que se diferencian solo en la palabra clave `scoped`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
void Unscoped()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    r = 5;
}

void Scoped()
{
    scoped ref int r = ref _arr[0]; // function-member
    int v = 1;
    r = ref v;                      // OK: v's block is the method body
    r = 5;
}
```

Piensa en `scoped` como la forma documentada de decir "esta referencia nunca sale del método", lo que desbloquea reasignaciones que el contexto inferido prohibiría. La misma palabra clave en un local `ref struct` (`scoped Span<int> s`) estrecha en cambio su safe-context, lo que impide que su contenido escape.

## Structs, `this` y `[UnscopedRef]`

Dentro de un método de instancia de un struct, `this` es un parámetro `scoped ref` implícito, así que su contexto es function-member, y también lo son todos sus campos (regla 4). Por eso un struct no puede devolver con ref su propio campo:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

struct Counter
{
    int _n;

    public ref int Bad() => ref _n;                 // error CS8170
    [UnscopedRef] public ref int Good() => ref _n;  // OK: this widened to return-only

    static ref int UseGood()
    {
        Counter c = default;
        ref int r = ref c.Good(); // receiver c is a local: declaration-block
        return ref r;             // error CS8157
    }
}
```

```text
error CS8170: Struct members cannot return 'this' or other instance members by reference
```

`[UnscopedRef]` amplía `this` un nivel, de function-member a return-only, lo cual basta para `return ref _n`. Pero no hace que el resultado sea seguro para el heap. En el sitio de la llamada, `c.Good()` es una llamada que devuelve `ref` cuyo receptor se pasa por `ref`, así que se aplica la regla 6 y el resultado hereda el contexto declaration-block del local `c`. La referencia devuelta vive tanto como el struct al que apunta, que es precisamente lo correcto.

## Spans: donde ref-safe-context se encuentra con safe-context

`Span<T>` tiene un indexador que devuelve `ref`, así que `ref span[i]` también sigue la regla 6. El receptor aporta su **safe-context**, y el safe-context de un span depende de dónde vino su memoria:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int FromStackSpan()
{
    Span<int> local = stackalloc int[4]; // safe-context: function-member
    ref int r = ref local[0];
    return ref r;                        // error CS8157
}

static ref int FromHeapSpan()
{
    Span<int> local = new int[4];        // safe-context: caller-context
    ref int r = ref local[0];
    return ref r;                        // OK
}
```

Los dos métodos son idénticos salvo por el inicializador de `local`, y solo uno compila. Un parámetro span tiene safe-context caller-context, lo que hace legal sin anotaciones el patrón clásico de "encontrar el elemento por referencia":

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int MaxRef(Span<int> values)
{
    ref int best = ref values[0];        // caller-context via the span parameter
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i]; // same context: OK
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

Cada reasignación dentro del bucle proviene del mismo span, así que el contexto nunca entra en conflicto. Esta es la forma a la que apuntar: una fuente, un contexto, reasigna libremente.

## Cómo leer los códigos de error

Cuando te topes con uno de estos, el código te dice qué lado de la regla falló:

1. **CS8168** ("not a ref local"): intentaste `return ref` sobre un local simple o un parámetro por valor. Devuelve el valor, o mueve el almacenamiento al heap.
2. **CS8157** ("was initialized to a value that cannot be returned"): el inicializador del `ref` local tenía un contexto más estrecho que return-only. Mira el inicializador, no la última reasignación. Revisa las llamadas a helpers con argumentos `ref` locales y marca los parámetros que no escapan como `scoped`.
3. **CS8374** ("narrower escape scope"): una reasignación intentó estrechar el local. Inicializa primero con el referente más estrecho, o declara el local en el mismo bloque que el referente.
4. **CS9079** ("can only escape the current method through a return statement"): el caso especial de CS8374 en el que el nuevo referente es un parámetro `ref` o `in` (return-only) y el local era caller-context. Inicializa a partir del parámetro.
5. **CS8170**: un struct devuelve un ref a su propio campo. Añade `[UnscopedRef]` si quienes llaman pueden vivir con que el resultado esté atado al tiempo de vida del propio struct.

## Detalles que conviene conocer

- Los `ref` locales no pueden ser capturados por lambdas ni funciones locales, y no pueden estar vivos a través de un `await` o `yield return`. Es una restricción aparte de la sección 9.7.2.9, no un error de contexto, pero a menudo aparece en la misma refactorización.
- Los parámetros `out` son implícitamente `scoped ref` bajo las reglas de seguridad de ref de C# 11, así que `return ref outParam;` falla con `error CS9075: Cannot return a parameter by reference 'o' because it is scoped to the current method`, aunque `return ref refParam;` funcione. Bajar `<LangVersion>` no devuelve el comportamiento antiguo: con `<LangVersion>10</LangVersion>` en un proyecto `net10.0` obtuve el mismo CS9075, porque el compilador aplica las reglas nuevas siempre que el runtime de destino admite `ref` fields. Marca el parámetro como `[UnscopedRef] out int o` si realmente lo necesitas.
- Los parámetros `in` son return-only igual que los parámetros `ref`, pero solo como `ref readonly`. El [artículo sobre parámetros `ref readonly`](/es/2023/10/csharp-ref-readonly-parameters/) cubre cuándo elegir cada uno.
- El compilador es conservador. La regla 6 asume que un método que devuelve `ref` puede devolver cualquiera de sus argumentos `ref`. Si tu método no lo hace, `scoped` no es un parche, es el contrato correcto y documentado.
- El código unsafe queda fuera. Dentro de bloques `unsafe` puedes tomar punteros a locales y el compilador no rastrea su tiempo de vida. El [rediseño de `unsafe` en C# 16 como contrato del llamador](/es/2026/05/csharp-16-unsafe-keyword-caller-contract/) trata de hacer explícita esa frontera.

## Relacionado

- Si los spans en sí son nuevos para ti, empieza por [qué es `Span<T>` y cuándo realmente hace el código más rápido](/es/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).
- Para elegir la forma de una colección antes de preocuparte por los tiempos de vida, consulta [List vs Span vs ReadOnlySpan en C#](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).
- C# 14 también cambió cómo se enlazan los spans; [el breaking change de resolución de sobrecargas con spans](/es/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) explica las sorpresas de `MemoryExtensions`.
- Las [conversiones implícitas de span en C# 14](/es/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) cubren las conversiones más nuevas a nivel de lenguaje que permiten que los arreglos fluyan hacia parámetros span como `MaxRef` de arriba en más lugares, incluidos los receptores de métodos de extensión.

## Fuentes

- [C# standard, section 9.7.2 Ref safe contexts](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts), que incluye 9.7.2.2 (locales), 9.7.2.6 (invocación de funciones) y 9.7.2.9 (reasignación de ref).
- [C# standard, section 9.7.3 The scoped modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#973-the-scoped-modifier).
- [Low-level struct improvements](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements), la propuesta de C# 11 que introdujo return-only, `scoped` y `[UnscopedRef]`.
- [Reference variables](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables) y [`ref` structure types](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/ref-struct) en la referencia del lenguaje C#.
