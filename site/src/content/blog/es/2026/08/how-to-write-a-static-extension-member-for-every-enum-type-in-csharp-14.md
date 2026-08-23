---
title: "Cómo escribir un miembro de extensión estático que aplique a todos los tipos enum en C# 14"
description: "Declara un bloque extension genérico con la restricción struct, Enum y obtienes Status.Values, Status.Count y Status.Parse en cada enum de tu solución. La forma del receptor, las trampas CS0704 y CS0428, y por qué debes cachear Enum.GetValues."
pubDate: 2026-08-23
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
  - "enums"
lang: "es"
translationOf: "2026/08/how-to-write-a-static-extension-member-for-every-enum-type-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-08-23
---

C# 14 te permite escribir un solo bloque `extension` que agrega miembros estáticos a *todos* los tipos enum a la vez. La forma es `extension<TEnum>(TEnum) where TEnum : struct, Enum`, declarada dentro de una clase estática no genérica, omitiendo el nombre del parámetro receptor porque los miembros son estáticos. Eso te da `Status.Values`, `Status.Count` y `Status.Parse("active")` en cada enum de tu solución sin escribir una línea por enum. Todo lo que sigue se compiló y ejecutó con el SDK de .NET 10.0.201 sobre el runtime 10.0.5.

El detalle es que tres cosas distintas te van a morder: el parámetro de tipo es inalcanzable desde dentro de un método genérico, cualquier nombre de miembro que `System.Enum` ya posea queda oculto en silencio, y la implementación obvia asigna un arreglo nuevo en cada llamada.

## Por qué el receptor tiene que ser `TEnum`, no `Enum`

El instinto es escribir `extension(Enum)` y listo, ya que todo enum deriva de `System.Enum`. Eso compila, e incluso se resuelve desde el nombre de un tipo enum concreto:

```csharp
// .NET 10, C# 14 -- compiles and runs, but is a dead end
public static class B
{
    extension(Enum)
    {
        public static string Label => "Label:System.Enum";
    }
}

// both of these print "Label:System.Enum"
Console.WriteLine(Status.Label);
Console.WriteLine(Enum.Label);
```

Los miembros de extensión estáticos declarados sobre el tipo base sí son alcanzables a través del nombre de un enum derivado. Pero no hay parámetro de tipo en ese bloque, así que no puedes llamar a ninguna de las APIs genéricas de `Enum`. `Enum.GetValues<TEnum>()`, `Enum.Parse<TEnum>` y `Enum.TryParse<TEnum>` son exactamente las APIs que quieres, y todas necesitan un `TEnum`. Sin él vuelves a la reflexión sobre `typeof`, con boxing de cada valor a `object`.

Entonces el receptor tiene que cargar el parámetro de tipo. El siguiente instinto es `where TEnum : Enum`, que también compila hasta que realmente lo usas:

```csharp
extension<TEnum>(TEnum) where TEnum : Enum
{
    public static TEnum[] Values => Enum.GetValues<TEnum>();
}
```

```
error CS0453: The type 'TEnum' must be a non-nullable value type in order to use it
as parameter 'TEnum' in the generic type or method 'Enum.GetValues<TEnum>()'
```

`Enum` como restricción permite el propio `System.Enum`, que es un tipo de referencia abstracto. Los ayudantes genéricos de `Enum` están todos restringidos a `struct, Enum`, así que tu bloque tiene que coincidir. Eso deja exactamente una forma que funciona.

## Declara el bloque en tres pasos

1. **Crea una `static class` de nivel superior y no genérica.** Los bloques `extension` solo son legales ahí. El nombre de la clase nunca aparece en el sitio de llamada, así que elige algo descriptivo como `EnumExtensions`.
2. **Escribe `extension<TEnum>(TEnum) where TEnum : struct, Enum` y omite el nombre del parámetro receptor.** MS Learn es explícito: "the extension parameter doesn't need to include the parameter name if the only members are static". Quitar el nombre es lo que señala que este bloque contiene miembros estáticos; un receptor con nombre es para miembros de instancia.
3. **Declara miembros `public static` dentro del bloque.** Se enlazan contra el enum concreto que nombras en el sitio de llamada, así que `TEnum` se infiere como `Status` cuando escribes `Status.Values`.

```csharp
// .NET 10, C# 14
public static class EnumExtensions
{
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static TEnum[] Values => Enum.GetValues<TEnum>();
        public static int Count => Enum.GetValues<TEnum>().Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status { Draft = 1, Active = 2, Archived = 4 }
public enum Color { Red, Green, Blue }

Console.WriteLine(Status.Count);              // 3
Console.WriteLine(string.Join(",", Status.Values));  // Draft,Active,Archived
Console.WriteLine(Color.Parse("green"));      // Green
Console.WriteLine(Color.TryParse("BLUE", out var c));  // True
```

Un solo bloque, y cada enum de la compilación ganó cuatro miembros estáticos. Ese es todo el beneficio, y es la parte que genuinamente no se podía expresar antes de C# 14. Si quieres repasar la característica que rodea a esto, el [resumen de miembros de extensión de C# 14](/es/2026/02/csharp-14-extension-members/) cubre operadores y los casos no genéricos, y [declarar propiedades de extensión](/es/2026/06/how-to-declare-extension-properties-in-csharp-14/) profundiza en las reglas específicas de propiedades.

## Qué emite realmente el compilador

Los bloques `extension` no son una característica del runtime. Todo se reduce a métodos estáticos ordinarios en la clase estática contenedora, más un tipo marcador generado por el compilador que lleva los metadatos de la extensión. Usar reflexión sobre la clase en tiempo de ejecución lo muestra:

```
--- emitted members on EnumExtensions ---
  NestedType <G>$1AEBB925A470955AA56007A9C9196757`1
  Method   get_Count
  Method   get_Values
  Method   Parse
  Method   TryParse
```

El tipo anidado `<G>$<hash>` es el tipo de agrupación que el compilador usa para registrar el receptor y sus restricciones. Los miembros en sí son métodos estáticos planos, y por eso los bloques `extension` son compatibles a nivel binario con los antiguos métodos de extensión con parámetro `this` y por eso no hay costo de despacho en tiempo de ejecución.

Esa emisión plana tiene una consecuencia directa, y es lo primero que te va a sorprender.

## Un bloque `extension` no es un ámbito

MS Learn enuncia la regla sin rodeos: "An extension doesn't introduce a scope for member declarations. All members declared in a single class, even if in multiple extensions, must have unique signatures." Así que un miembro de instancia y uno estático con el mismo nombre chocan aunque vivan en bloques distintos:

```csharp
public static class E2
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Tag => "instance";
    }
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static string Tag => "static";   // CS0102
    }
}
```

```
error CS0102: The type 'E2' already contains a definition for 'Tag'
```

Sepáralos en dos clases estáticas y el choque se mueve al sitio de llamada, donde C# 14 tiene un diagnóstico dedicado:

```
error CS9339: The extension resolution is ambiguous between the following members:
'C1.extension<Status>(Status).Count' and 'C2.extension<Status>(Status).Count'
```

Vale la pena reconocer CS9339 a primera vista, porque un bloque enum genérico aplica a todos los enums en ámbito. Dos bibliotecas que ambas envíen una extensión `Values` chocarán en cada enum que tengas, y ninguna de las dos tiene la culpa. La misma familia de problemas aparece cuando mueves un método de extensión al estilo antiguo dentro de un bloque y olvidas borrar el original, lo que produce [la ambigüedad CS0121 tras migrar a miembros de extensión](/es/2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members/).

## `TEnum.Values` no compila dentro de un método genérico

Esta es la que más tiempo cuesta. El miembro de extensión se resuelve bien contra un nombre de enum concreto, pero no contra un parámetro de tipo:

```csharp
public static int CountOf<TEnum>() where TEnum : struct, Enum
{
    return TEnum.Values.Length;   // CS0704
}
```

```
error CS0704: Cannot do non-virtual member lookup in 'TEnum' because it is a type parameter
```

Los miembros de extensión estáticos se resuelven por búsqueda de nombre sobre un tipo, y un parámetro de tipo no es un tipo para ese propósito. Solo los miembros de interfaz `static` *abstract* participan en la búsqueda de miembros a través de un parámetro de tipo, y los miembros de extensión no son miembros de interfaz. No hay sintaxis que arregle esto.

La respuesta práctica es mantener la implementación real en una clase auxiliar genérica normal y dejar que el bloque `extension` sea una fachada delgada sobre ella. El código genérico llama al ayudante directamente; el código de aplicación llama al bonito miembro de extensión. Esa división también es lo que resuelve el problema de asignación de más abajo, así que lo obtienes gratis.

## `Enum.GetValues<TEnum>()` asigna un arreglo nuevo en cada llamada

`Enum.GetValues<TEnum>()` devuelve un `TEnum[]` fresco cada vez, porque entregar un arreglo mutable cacheado dejaría que cualquier llamador lo corrompa. Una propiedad que lo llama en cada acceso convierte una consulta en una asignación. Medido sobre el runtime 10.0.5, compilación Release, un millón de accesos a un enum de cinco miembros, indexando el resultado para que el JIT no pueda sacar la llamada del bucle:

| Implementación | Tiempo | Asignado | Por operación |
| --- | --- | --- | --- |
| `Enum.GetValues<TEnum>()` por acceso | 27.8 ms | 48 000 832 bytes | 48 B |
| caché estática genérica | 0.7 ms | 0 bytes | 0 B |

48 bytes por operación son la cabecera del arreglo más cinco valores de 4 bytes, redondeado a la alineación. El número escala con el enum, así que un enum de 30 miembros cuesta más. A lo largo de tres ejecuciones la versión sin caché midió entre 26.8 ms y 29.5 ms, y la versión con caché 0.7 ms siempre.

La solución es una clase genérica estática. El CLR te da una instancia de sus campos estáticos por cada tipo genérico cerrado, así que `EnumInfo<Status>` y `EnumInfo<Color>` obtienen almacenamiento separado, cada uno inicializado exactamente una vez en el primer uso:

```csharp
// .NET 10, C# 14
internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();
}
```

`ImmutableArray<TEnum>` importa aquí en lugar de `TEnum[]`: un arreglo cacheado entregado desde una propiedad es mutable por cualquier llamador, y un solo `Values[0] = ...` envenena en silencio la caché para todo el proceso. `FrozenSet` es la forma correcta para comprobaciones de pertenencia, ya que paga un costo de construcción mayor una vez a cambio de lecturas más rápidas, que es exactamente el compromiso que quiere una caché estática por tipo. El [benchmark de Dictionary vs FrozenDictionary](/es/2024/04/net-8-performance-dictionary-vs-frozendictionary/) tiene los números detrás de esa elección.

## Los nombres que `System.Enum` ya posee quedan ocultos

Los miembros de extensión son un plan de respaldo. La búsqueda de nombres encuentra primero los miembros reales, y solo recurre a las extensiones cuando no existe nada aplicable. `System.Enum` ya declara `IsDefined`, así que un miembro de extensión con ese nombre nunca llega a considerarse:

```csharp
extension<TEnum>(TEnum value) where TEnum : struct, Enum
{
    public bool IsDefined => Enum.IsDefined(value);
    public bool IsKnown => Enum.IsDefined(value);
}

Status s = Status.Active;
bool a = s.IsKnown;     // fine
bool b = s.IsDefined;   // CS0428
```

```
error CS0428: Cannot convert method group 'IsDefined' to non-delegate type 'bool'.
Did you intend to invoke the method?
```

El compilador encontró el grupo de métodos `Enum.IsDefined` y dejó de buscar. El mensaje de error es activamente engañoso, porque sugiere que olvidaste los paréntesis cuando el problema real es que tu propiedad de extensión es inalcanzable por ese nombre. Lo mismo le pasa a los miembros de extensión estáticos: `Status.IsDefined` declarado como propiedad de extensión estática produce el CS0428 idéntico.

Nota que esto va de nombres, no de firmas. `GetValues` como *método* de extensión funciona bien:

```csharp
extension<TEnum>(TEnum) where TEnum : struct, Enum
{
    public static TEnum[] GetValues() => Enum.GetValues<TEnum>();  // compiles
}

Status[] all = Status.GetValues();   // resolves to your extension
```

`Enum.GetValues` existe, pero ninguna de sus sobrecargas es aplicable con cero argumentos, así que la búsqueda cae hasta la extensión. Confiar en eso es frágil. La regla segura es evitar todo nombre que ya esté en `System.Enum`: `IsDefined`, `Parse`, `TryParse`, `GetName`, `GetNames`, `GetValues`, `GetUnderlyingType`, `Format`, `ToObject`, `HasFlag` y `CompareTo`. Elegir `Values`, `Count`, `Names` e `IsKnown` esquiva toda la categoría.

`Parse` y `TryParse` son las excepciones incómodas, porque son los nombres que los llamadores esperan. Sí se resuelven actualmente, por la misma razón de cero sobrecargas aplicables que `GetValues`. Si quieres ser conservador, llámalos `ParseName` y `TryParseName`.

## La trampa de descomponer `[Flags]`

Si agregas un miembro que divide un valor de flags en sus partes, la implementación obvia está mal para cualquier enum con un miembro cero:

```csharp
[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Admin = Read | Write }

public ImmutableArray<TEnum> NaiveFlags =>
    [.. EnumInfo<TEnum>.Values.Where(f => value.HasFlag(f))];
```

```
naive : [None, Read, Write, Admin]
```

`HasFlag` es una prueba de subconjunto, así que `x.HasFlag(None)` es verdadero para todo `x`, y los miembros compuestos como `Admin` también coinciden. Filtrar a los miembros de un solo bit arregla ambos problemas a la vez:

```csharp
// .NET 10, C# 14 -- add to EnumInfo<TEnum>; needs using System.Numerics;
public static readonly ImmutableArray<TEnum> SingleBitFlags =
    [.. Enum.GetValues<TEnum>().Where(v =>
        BitOperations.PopCount(Convert.ToUInt64(v)) == 1)];

public ImmutableArray<TEnum> Flags =>
    [.. EnumInfo<TEnum>.SingleBitFlags.Where(f => value.HasFlag(f))];
```

```
fixed : [Read, Write]
none  : []
read  : [Read]
```

`Convert.ToUInt64` hace boxing, pero se ejecuta una vez por tipo enum dentro del inicializador estático, no por llamada.

## La versión que vale la pena enviar

Juntando las piezas: un ayudante genérico que guarda las cachés, un bloque estático para los miembros a nivel de tipo, un bloque de instancia para los miembros a nivel de valor, y ningún nombre que `System.Enum` ya posea.

```csharp
// .NET 10, C# 14
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.ComponentModel;
using System.Reflection;

internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();

    public static readonly FrozenDictionary<TEnum, string> Descriptions =
        Enum.GetValues<TEnum>()
            .DistinctBy(v => v)
            .ToFrozenDictionary(
                v => v,
                v => typeof(TEnum).GetField(v.ToString())
                        ?.GetCustomAttribute<DescriptionAttribute>()?.Description
                     ?? v.ToString());
}

public static class EnumExtensions
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Description => EnumInfo<TEnum>.Descriptions[value];
        public bool IsKnown => EnumInfo<TEnum>.Defined.Contains(value);
    }

    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static ImmutableArray<TEnum> Values => EnumInfo<TEnum>.Values;
        public static int Count => EnumInfo<TEnum>.Values.Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status
{
    [Description("Not yet published")] Draft,
    [Description("Live")]              Active,
    Archived,
}
```

```
Status.Count      : 3
Status.Values     : [Draft, Active, Archived]
Description       : Not yet published
Description (none): Archived
IsKnown           : True / False
Parse             : Active
TryParse bad input: False
```

El `DistinctBy(v => v)` en el constructor del diccionario no es decoración. `Enum.GetValues` devuelve una entrada por *miembro*, y dos miembros pueden compartir un valor (`Alias = Active`), lo que lanzaría una excepción de clave duplicada sin él. Ese es el mismo detalle de alias que hace difícil la persistencia de enums, cubierto en [almacenar un enum como cadena en EF Core 11](/es/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/).

La reflexión en `Descriptions` significa que este patrón necesita una anotación de trimming si publicas con trimming o Native AOT habilitado. Elimina el miembro `Description` si apuntas a cualquiera de los dos, o alimenta las cadenas desde un generador de código fuente.

Un límite que vale la pena enunciar: los miembros de extensión se resuelven en tiempo de compilación contra un nombre que escribes en el código fuente. Si tu tipo enum solo se conoce como un `Type` en tiempo de ejecución, nada de esto aplica y vuelves a las APIs de reflexión no genéricas. Los bloques `extension` hacen que los enums sean más agradables de usar en el código que compilas, no en el código que descubres.

## Fuentes

- [Extension member declarations, C# reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/extension) en MS Learn, actualizado el 2026-08-13
- [C# 14: Exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/) en el blog de .NET
- Referencia de la API [Enum.GetValues&lt;TEnum&gt;()](https://learn.microsoft.com/en-us/dotnet/api/system.enum.getvalues)
- Referencia de la API [FrozenSet&lt;T&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.collections.frozen.frozenset-1)
