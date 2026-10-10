---
title: "Qué es el layout transparente de un struct y por qué un struct envoltorio de un solo campo cambia la convención de llamada en .NET"
description: "Un struct transparente es aquel que el ABI trata exactamente igual que su único campo. .NET 11 no ofrece esa garantía: un struct que envuelve un double se pasa en RCX en Windows x64 pero en XMM0 en Linux y macOS. Aquí está el desensamblado del JIT de .NET 11 en tres ABI, los errores de P/Invoke que provoca y cómo escribir tipos envoltorio seguros en cualquier frontera."
pubDate: 2026-10-10
tags:
  - "dotnet-11"
  - "csharp"
  - "interop"
  - "jit"
  - "performance"
lang: "es"
translationOf: "2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-10
---

Respuesta corta: el "layout transparente" es la garantía de que un struct con exactamente un campo se organiza en memoria *y se pasa entre llamadas* exactamente igual que ese campo. Rust lo escribe `#[repr(transparent)]`. .NET 11 no lo tiene. Un struct de C# como `readonly record struct Meters(double Value)` tiene el mismo layout de memoria de 8 bytes que un `double`, pero en una frontera de llamada el JIT lo clasifica como un agregado, y cada ABI de plataforma decide cómo viajan los agregados. En Linux x64, macOS x64 y todos los destinos ARM64 el envoltorio sigue viajando en un registro de punto flotante, así que nunca lo notas. En Windows x64 va en `RCX`, un registro entero, y se devuelve en `RAX` en lugar de `XMM0`. Eso cuesta un par de movimientos de registros en código administrado y corrompe valores en silencio si usas el envoltorio en una firma de P/Invoke cuyo lado nativo recibe un `double` simple.

Todo lo que sigue se ejecutó en .NET 11 RC1 (runtime 11.0.0-rc.1.26425.128, SDK 11.0.100-rc.1.26425.128) con C# 15. El desensamblado administrado para Windows x64 y Linux x64 proviene del compilador cruzado `crossgen2` de RC1 con `JitDisasm`, los listados de macOS provienen de ejecutar la aplicación de forma nativa en arm64 y bajo Rosetta en x64, y los listados nativos provienen de Apple clang 21 apuntando a cada ABI.

## Layout de memoria y convención de llamada son dos contratos distintos

Cuando la gente dice que un struct de un solo campo es "gratis", normalmente se refiere al layout de memoria. Esa parte es cierta. `Meters` ocupa 8 bytes, alineados a 8, exactamente como `double`. `Unsafe.SizeOf<Meters>()` devuelve 8, un arreglo de `Meters` es compatible bit a bit con un arreglo de `double`, y `MemoryMarshal.Cast<Meters, double>` funciona.

La convención de llamada es un contrato aparte. Responde a esta pregunta: cuando este valor es un argumento o un valor de retorno, ¿qué registro o ranura de pila lo contiene? Un ABI toma esa decisión *clasificando* el tipo, y la mayoría de los ABI clasifican primero por "es un escalar o un agregado" y solo después miran dentro. Un struct es un agregado aunque tenga un solo campo. Que el ABI mire después a través de él hasta el `double` interno depende por completo de la plataforma:

- **System V AMD64 (Linux x64, macOS x64)** divide los agregados en eightbytes y clasifica cada uno según los campos que contiene. Un campo `double` significa que el eightbyte es de clase SSE, así que el struct va en `XMM0`, igual que un `double` suelto.
- **AAPCS64 (Linux, macOS y Windows en ARM64)** tiene la regla del agregado homogéneo de punto flotante (HFA): un struct de uno a cuatro campos del mismo tipo de punto flotante se pasa en registros SIMD consecutivos. Un `double` es un HFA de tamaño uno, así que va en `D0`, igual que un `double` suelto.
- **Windows x64** no mira dentro en absoluto. La [documentación de la convención de llamada x64](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention) dice que los structs de tamaño 8, 16, 32 o 64 bits "se pasan como si fueran enteros del mismo tamaño". Un struct con un `double` mide 64 bits, así que va en `RCX`. En los retornos, un tipo definido por el usuario del tamaño adecuado vuelve en `RAX`, mientras que los float y double vuelven en `XMM0`.

El JIT de .NET sigue el ABI de la plataforma en las llamadas de administrado a administrado, no solo en P/Invoke. Por eso esto no es una curiosidad exclusiva de la interoperabilidad. Aparece en código C# normal.

## El ABI nativo, directo desde el compilador

Este es el archivo C más pequeño que expone la diferencia. Compilarlo para tres destinos con `clang -O2 -S` muestra lo que espera cada ABI:

```c
// abi.c, Apple clang 21, -O2
typedef struct { double value; } Meters;
typedef struct { float x, y; } Vec2;

double take_double(double d) { return d * 2.0; }
double take_meters(Meters m) { return m.value * 2.0; }
Meters ret_meters(double d) { Meters m = { d }; return m; }
float  take_vec2(Vec2 v) { return v.x + v.y; }
float  take_two_floats(float x, float y) { return x + y; }
```

Para `x86_64-pc-windows-msvc`:

```asm
; Windows x64
take_double:
    addsd   %xmm0, %xmm0      ; double arrives in xmm0
    retq
take_meters:
    movq    %rcx, %xmm0       ; Meters arrives in rcx, moved to xmm0 first
    addsd   %xmm0, %xmm0
    retq
ret_meters:
    movq    %xmm0, %rax       ; Meters is returned in rax, not xmm0
    retq
```

Para `x86_64-apple-macos` (System V) y `arm64-apple-macos` (AAPCS64), `take_meters` se compila exactamente a las mismas instrucciones que `take_double` (`addsd %xmm0, %xmm0` y `fadd d0, d0, d0` respectivamente), y `ret_meters` se compila a un simple `ret` porque el valor ya está en el registro de retorno.

Así que el envoltorio es transparente en dos de los tres ABI por accidente de sus reglas de clasificación, y opaco en Windows x64.

## Qué emite el JIT de .NET 11 para un struct envoltorio

Ahora el lado administrado. Dos métodos, idénticos salvo por el envoltorio:

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.CompilerServices;

public readonly record struct Meters(double Value);

static class Managed
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static double ScaleDouble(double d) => d * 2.0;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static Meters ScaleMeters(Meters m) => new(m.Value * 2.0);
}
```

En Linux x64 (crossgen2 `--targetos:linux --targetarch:x64`), ambos métodos se compilan a los mismos 5 bytes:

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, linux-x64
       vaddsd   xmm0, xmm0, xmm0
       ret
; Total bytes of code 5
```

En macOS arm64, ejecutando de forma nativa con `DOTNET_JitDisasm`, ambos son los mismos 20 bytes, con `fadd d0, d0, d0` como único trabajo real.

En Windows x64 (crossgen2 `--targetos:windows --targetarch:x64`), `ScaleDouble` sigue siendo de 5 bytes, pero `ScaleMeters` se convierte en:

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, win-x64
       vmovq    xmm0, rcx          ; argument arrives in an integer register
       vaddsd   xmm0, xmm0, xmm0
       vmovq    rax, xmm0          ; result leaves in an integer register
       ret
; Total bytes of code 15
```

Dos movimientos entre dominios adicionales por llamada, tres veces el tamaño del código. Dentro del cuerpo del método el JIT promueve el struct a su único campo y trabaja sobre un registro `double` simple; el costo vive por completo en la frontera. Si la llamada se inlinea, la frontera desaparece y el costo también. Por eso la sobrecarga rara vez importa en la práctica, y por eso solo la ves en rutas calientes sin inlining: llamadas virtuales, despacho de interfaces, delegados, métodos `NoInlining` o métodos demasiado grandes para inlinearse.

Envolver un entero o una referencia no tiene este problema en ninguno de estos ABI. Un `readonly record struct UserId(int Value)` viaja en `ECX` en Windows x64, `EDI` en System V y `W0` en ARM64, exactamente como un `int` suelto. Un struct que envuelve una referencia a objeto viaja como un puntero. La divergencia es específica de los campos de punto flotante (y, como se muestra más abajo, de los structs con varios campos), porque solo los valores de punto flotante tienen un archivo de registros separado que el ABI puede decidir saltarse.

## El error real: tipos envoltorio en firmas de P/Invoke

La diferencia de rendimiento es una nota al pie. La diferencia de corrección no. Si usas un envoltorio fuertemente tipado en una firma de `LibraryImport` o `DllImport` cuyo equivalente nativo recibe la primitiva subyacente, estás afirmando que el envoltorio es transparente. El marshaller no lo comprueba, porque el struct es blittable y se pasa tal cual.

Aquí hay una reproducción contra la biblioteca `abi.c` anterior:

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.InteropServices;

Console.WriteLine($"{RuntimeInformation.ProcessArchitecture} / {RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"take_double(Meters 21)  = {Native.TakeDoubleAsMeters(new Meters(21)).Value}");
Console.WriteLine($"take_two_floats(Vec2)   = {Native.TakeTwoFloatsAsVec2(new Vec2(1f, 2f))}");
Console.WriteLine($"take_two_floats(f, f)   = {Native.TakeTwoFloats(1f, 2f)}");

public readonly record struct Meters(double Value);
public readonly record struct Vec2(float X, float Y);

static partial class Native
{
    // Wrong on purpose: the C side is double take_double(double)
    [LibraryImport("libabi", EntryPoint = "take_double")]
    public static partial Meters TakeDoubleAsMeters(Meters m);

    // Wrong on purpose: the C side is float take_two_floats(float, float)
    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloatsAsVec2(Vec2 v);

    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloats(float x, float y);
}
```

En macOS arm64:

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 3
take_two_floats(f, f)   = 3
```

Todo "funciona". `Meters` es un HFA de un `double`, `Vec2` es un HFA de dos `float`, y AAPCS64 los pone en `D0` y `S0`/`S1`, exactamente donde mira el código nativo.

En macOS x64 (System V), mismo binario, misma biblioteca:

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 1
take_two_floats(f, f)   = 3
```

`Meters` sigue funcionando, porque un único eightbyte SSE va en `XMM0`. `Vec2` no: System V empaqueta ambos floats en un solo eightbyte, así que el struct completo llega en los 64 bits bajos de `XMM0`. La función nativa lee `x` de `XMM0` y `y` de `XMM1`, que contiene lo que hubiera quedado ahí. En esta ejecución resultó ser cero, así que la respuesta fue `1`. En otra ejecución podría ser cualquier cosa.

En Windows x64, ambas declaraciones incorrectas fallan. `Meters` va en `RCX` mientras `take_double` lee `XMM0`, y el resultado se lee de vuelta desde `RAX` mientras el código nativo escribió `XMM0`. `Vec2` (8 bytes) también va en `RCX`. Puedes confirmar el lado nativo con el listado de `x86_64-pc-windows-msvc` de arriba; el lado administrado sigue la misma regla que muestra el desensamblado de `ScaleMeters`.

Este es el clásico error de "funciona en mi Mac, basura en el agente de compilación de Windows". El código revisado y probado en laptops ARM64 pasa, y la primera ejecución en Windows x64 produce disparates o un valor sutilmente incorrecto.

## Cómo escribir tipos envoltorio seguros en cualquier frontera

No hay ningún atributo en .NET 11 que haga transparente a un struct. `[StructLayout(LayoutKind.Sequential)]`, `Pack` y `Size` controlan el layout de memoria, no la clasificación de registros. Así que la solución es mantener los envoltorios del lado administrado de la frontera.

1. **Declara las firmas nativas con los tipos nativos exactos.** Si C recibe `double`, el P/Invoke recibe `double`. Envuelve y desenvuelve en un método administrado delgado:

    ```csharp
    // .NET 11 RC1, C# 15
    static partial class Native
    {
        [LibraryImport("libabi", EntryPoint = "take_double")]
        private static partial double TakeDouble(double d);

        public static Meters Scale(Meters m) => new(TakeDouble(m.Value));
    }
    ```

    El método envoltorio se inlinea, así que no pagas nada por la seguridad de tipos.

2. **Usa un struct en un P/Invoke solo cuando el lado nativo use un struct con los mismos campos.** Si el encabezado de C dice `Vec2 v`, un `Vec2` de C# con los mismos campos en el mismo orden es correcto en cualquier ABI, porque ambos lados aplican la misma clasificación. El error ocurre únicamente cuando hay un struct de un lado y escalares sueltos del otro.

3. **Trata los punteros a función y `UnmanagedCallersOnly` de la misma manera.** Un `delegate* unmanaged<Meters, Meters>` tiene el mismo problema que un `LibraryImport`, y también lo tiene una exportación `[UnmanagedCallersOnly]` que un host nativo llama con un `double`. Si construyes addons de Node o hosts de plugins de esa manera, como en [escribir addons de Node.js con .NET Native AOT](/es/2026/04/nodejs-addons-dotnet-native-aot/), mantén primitivas en las firmas exportadas.

4. **En rutas administradas calientes en Windows x64, comprueba si la llamada se inlinea antes de preocuparte.** Si un profiler señala un método sin inlining que recibe o devuelve un envoltorio de punto flotante, mira el desensamblado. El [visor ASM de Rider para desensamblado de JIT y Native AOT](/es/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) o `DOTNET_JitDisasm` mostrarán el par de `vmovq`. Después puedes pasar la primitiva a través de la frontera caliente, o reestructurar para que la llamada se inlinee.

## Casos límite y trampas

- **Dos floats no son un double.** Mucha gente asume que "8 bytes son 8 bytes". `Vec2(float, float)` mide 8 bytes, pero es un eightbyte SSE en System V, un HFA de dos en ARM64 y un blob del tamaño de un entero en Windows x64. Tres ABI, tres respuestas. Este es el caso que más a menudo muerde al código multiplataforma de juegos y gráficos.
- **Los campos mixtos cambian la clasificación otra vez.** Un `struct { int Id; float Weight; }` mide 8 bytes. En System V se convierte en un eightbyte de clase INTEGER (gana el entero cuando un eightbyte mezcla clases) y va en `RDI`. En ARM64 no es un HFA, así que va en `X0`. En Windows x64, `RCX`. Ninguno de esos coincide con pasar un `int` y un `float` por separado.
- **El tamaño importa en Windows x64.** Solo los structs de 1, 2, 4 y 8 bytes se pasan por valor en un registro. Un struct de 12 o 16 bytes se pasa por referencia a una copia asignada por el llamador, lo cual es un cambio mucho mayor que pasar sus campos individualmente. En System V y ARM64, los structs de hasta 16 bytes siguen yendo en registros.
- **Los métodos de instancia de clases C++ son otra historia.** MSVC devuelve los tipos definidos por el usuario desde funciones miembro no estáticas a través de un puntero oculto incluso cuando cabrían en `RAX`. Por eso existe `CallConvMemberFunction` en `System.Runtime.CompilerServices`, y por eso los métodos COM que devuelven structs pequeños son una trampa conocida.
- **La promoción de structs oculta el costo, no lo elimina.** Dentro de un método el JIT reemplaza un struct promovido por su campo, así que la aritmética local sobre `Meters` es tan rápida como sobre `double`. La promoción no cambia cómo cruza el valor una llamada. Si estás sopesando structs frente a clases para objetos de valor, la [matriz de decisión record vs class vs struct](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) cubre el lado del tamaño y la copia de ese compromiso.
- **ReadyToRun y Native AOT usan las mismas reglas.** El código precompilado también debe coincidir con el ABI de la plataforma, así que publicar con [Native AOT o ReadyToRun](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) no hace transparente a un envoltorio. La salida de crossgen2 en este artículo es código ReadyToRun.

## ¿Tendrá .NET un layout transparente de verdad?

No en .NET 11. Lo más cercano en la hoja de ruta es la [propuesta de layout de structs para interoperabilidad en dotnet/runtime#100896](https://github.com/dotnet/runtime/issues/100896), que aprobó un `CustomLayoutAttribute` con tipos de layout para structs al estilo C, uniones y tipos de Swift. El issue menciona explícitamente solicitudes de un mecanismo como el `repr(transparent)` de Rust, pero la forma aprobada no incluye uno, y el issue pasó del hito 11.0.0 al 12.0.0 en julio de 2026. Si alguna vez llega un tipo transparente, permitiría que el JIT y el marshaller clasifiquen un envoltorio de un solo campo como su campo en cada ABI, que es exactamente lo que hace el [RFC 1758 de Rust](https://rust-lang.github.io/rfcs/1758-repr-transparent.html) para sus newtypes.

Hasta entonces, la regla es corta: los envoltorios son gratis en memoria y gratis tras el inlining, pero en una frontera de ABI son agregados, y solo la plataforma decide si eso importa. Mantenlos fuera de las firmas nativas, y si tienes que pasarlos a través de una llamada caliente sin inlining en Windows x64, lee primero el desensamblado.

## Relacionado

- [Record vs class vs struct en C#: una matriz de decisión](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) para elegir la forma de un tipo de valor desde el principio.
- [El visor ASM de Rider 2026.1 para desensamblado de JIT y Native AOT](/es/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/), la forma más fácil de ver tú mismo el par de `vmovq`.
- [Native AOT vs ReadyToRun vs JIT en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) para ver en qué se diferencian los tres modos de generación de código, y en qué no.
- [Polars.NET y LibraryImport](/es/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/) para una biblioteca real respaldada por Rust que tiene que acertar con estas firmas.
- [Addons de Node.js con .NET Native AOT](/es/2026/04/nodejs-addons-dotnet-native-aot/), donde las exportaciones `UnmanagedCallersOnly` enfrentan la misma regla a la inversa.

## Fuentes

- [x64 calling convention](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention), documentación de Microsoft C++, para las reglas de agregados y valores de retorno en Windows x64.
- [System V AMD64 ABI](https://gitlab.com/x86-psABIs/x86-64-ABI), sección 3.2.3, para la clasificación de eightbytes.
- [Procedure Call Standard for the Arm 64-bit Architecture (AAPCS64)](https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst), para la regla HFA.
- [dotnet/runtime#100896: New attribute for interop-specific struct concerns](https://github.com/dotnet/runtime/issues/100896).
- [dotnet/runtime#43867: Keep structs in registers](https://github.com/dotnet/runtime/issues/43867), el issue de seguimiento del JIT para el manejo de structs de un solo campo.
- [Rust RFC 1758: repr(transparent)](https://rust-lang.github.io/rfcs/1758-repr-transparent.html).
