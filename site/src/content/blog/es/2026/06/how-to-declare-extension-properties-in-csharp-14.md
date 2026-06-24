---
title: "Cómo declarar propiedades de extensión en C# 14"
description: "Las propiedades de extensión llegan en C# 14 mediante el nuevo bloque extension. Declara propiedades de extensión de solo lectura, con setter, estáticas y genéricas, por qué se rechazan las propiedades automáticas y cómo el compilador las traduce a accesores get_/set_."
pubDate: 2026-06-24
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "extension-members"
lang: "es"
translationOf: "2026/06/how-to-declare-extension-properties-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-06-24
---

Respuesta rápida: declara una propiedad de extensión dentro de un bloque `extension` en una clase estática. Nombra el receptor para agregar una propiedad de instancia (`extension(string s) { public int WordCount => ...; }`), omite el nombre para agregar una estática (`extension(Point) { public static Point Origin => ...; }`). El cuerpo de la propiedad es el getter; agrega un accesor `set` para una propiedad de escritura. La única regla que confunde a todo el mundo: no existen campos de extensión, así que una propiedad automática como `public int Count { get; set; }` no compilará. Cada accesor debe calcular un valor o reenviarlo a almacenamiento real.

Esta característica llega en C# 14, que requiere el SDK de .NET 10 o posterior (funciona igual con el SDK de .NET 11). Configura `<LangVersion>14</LangVersion>` o `<LangVersion>latest</LangVersion>` en tu `.csproj`. Las propiedades de extensión son una parte de la característica más amplia de los miembros de extensión; este artículo es la guía enfocada en la mitad de las propiedades. Si quieres el recorrido más amplio que también cubre operadores y miembros estáticos, lee la [introducción a los miembros de extensión de C# 14](/es/2026/02/csharp-14-extension-members/).

## Por qué nunca pudiste escribir `string.WordCount` antes de C# 14

Los métodos de extensión existen desde C# 3.0, pero solo extendían un tipo de miembro: los métodos. Si querías agregar un valor calculado a un tipo que no controlas, tenías que escribirlo como una llamada a método:

```csharp
// Before C# 14 - the only option was a method
public static class StringExtensions
{
    public static int WordCount(this string s) =>
        s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
}

// Call site reads like a function, not a property
int n = "hello there world".WordCount();
```

Ese `()` final es la señal. `WordCount` es conceptualmente una propiedad de la cadena, pero el lenguaje lo forzaba a tener forma de método. Las propiedades automáticas, las propiedades calculadas y los indexadores sobre tipos que no controlas estaban simplemente fuera de alcance. C# 14 cierra esa brecha con el bloque `extension`, un contenedor que puede albergar propiedades, operadores y miembros estáticos junto a los antiguos métodos de estilo `this`.

## Declara una propiedad de extensión en tres pasos

1. Crea una clase estática de nivel superior y no genérica para alojar la extensión. Es la misma regla de contención que para los métodos de extensión clásicos: la clase no puede estar anidada ni ser genérica.
2. Abre un bloque `extension` y declara el receptor. Escribe `extension(string s)` para nombrar la instancia que la propiedad extiende, o `extension(string)` sin nombre para una propiedad estática sobre el propio tipo.
3. Declara la propiedad dentro del bloque con un getter de cuerpo de expresión (o un cuerpo completo de `get`/`set`). Haz referencia al parámetro receptor por el nombre que le diste en el paso 2.

Juntando todo, el ejemplo de `WordCount` se convierte en una propiedad real:

```csharp
// .NET 11, C# 14 - an instance extension property
public static class StringExtensions
{
    extension(string s)
    {
        public bool IsBlank => string.IsNullOrWhiteSpace(s);

        public int WordCount =>
            s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

Ahora el sitio de llamada pierde los paréntesis y se lee exactamente como un miembro integrado:

```csharp
string title = "hello there world";
Console.WriteLine(title.WordCount);  // 3
Console.WriteLine(title.IsBlank);    // False
```

El nombre del receptor (`s` aquí) está en ámbito para cada miembro dentro del bloque, así que las propiedades relacionadas comparten una sola declaración de lo que extienden. Ese es justamente el propósito del bloque: agrupa los miembros por el tipo que aumentan en lugar de repetir `this string` en cada firma.

## Las propiedades de extensión con setter necesitan dónde poner el valor

Las propiedades de extensión no son de solo lectura por defecto. Puedes agregar un accesor `set`, pero como el runtime no le da a una extensión ningún lugar para almacenar datos, el setter tiene que reenviar el valor a almacenamiento que ya existe en el receptor. Un caso claro es exponer una vista alternativa sobre un campo que el tipo ya posee:

```csharp
// .NET 11, C# 14 - a get/set extension property over existing state
public class Sensor
{
    public double Celsius { get; set; }
}

public static class SensorExtensions
{
    extension(Sensor sensor)
    {
        public double Fahrenheit
        {
            get => sensor.Celsius * 9 / 5 + 32;
            set => sensor.Celsius = (value - 32) * 5 / 9;
        }
    }
}
```

El setter lee `value` como cualquier setter de propiedad y escribe a través del campo `Celsius` real:

```csharp
var s = new Sensor { Celsius = 20 };
Console.WriteLine(s.Fahrenheit);  // 68
s.Fahrenheit = 212;
Console.WriteLine(s.Celsius);     // 100
```

Lo que no puedes hacer es pedirle al compilador que invente almacenamiento por ti. Este es el error de compilación más común que encuentra la gente:

```csharp
public static class SensorExtensions
{
    extension(Sensor sensor)
    {
        // ERROR: an extension property cannot be an auto-property,
        // because there is no backing field to generate.
        public string Label { get; set; }
    }
}
```

No hay campos de extensión en C# 14, así que no hay campo de respaldo que sintetizar. Cada accesor debe tener un cuerpo que calcule un valor o lo enrute a través de miembros que el receptor ya posee. Si realmente necesitas adjuntar nuevo estado a instancias de un tipo que no controlas, una propiedad de extensión es la herramienta equivocada; recurre a un `ConditionalWeakTable<TKey, TValue>` con la instancia como clave y exponlo a través del getter y el setter.

## Mutar un struct requiere un receptor `ref`

El ejemplo de `Sensor` funciona porque `Sensor` es una clase, así que el setter muta el objeto que todos comparten. Para un tipo de valor, el receptor se copia por defecto, y un setter mutaría esa copia desechable. Declara el receptor `ref` para escribir de vuelta al original, exactamente como `this ref` funcionaba para los métodos de extensión que mutaban:

```csharp
// .NET 11, C# 14 - ref receiver so the setter mutates the caller's struct
public static class PointExtensions
{
    extension(ref System.Drawing.Point p)
    {
        public int ManhattanLength
        {
            get => Math.Abs(p.X) + Math.Abs(p.Y);
        }
    }
}
```

Un receptor `ref` también significa que la propiedad solo puede usarse sobre una variable direccionable, no sobre un valor temporal como el resultado de una llamada a método. Esa restricción es la misma que los métodos de extensión `ref` siempre han llevado, y es lo que mantiene la mutación segura.

## Las propiedades de extensión estáticas omiten el nombre del receptor

Omite el nombre del parámetro y el bloque extiende el tipo en sí en lugar de una instancia. Así es como agregas constantes con nombre o valores tipo fábrica que se leen como miembros estáticos de un tipo que no controlas:

```csharp
// .NET 11, C# 14 - a static extension property on a type you don't own
using System.Drawing;

public static class PointExtensions
{
    extension(Point)
    {
        public static Point Origin => Point.Empty;
    }
}
```

El sitio de llamada parece un miembro estático que siempre estuvo ahí:

```csharp
Point start = Point.Origin;
```

Los miembros estáticos y de instancia pueden vivir en bloques separados dentro de la misma clase. Usa un bloque con receptor nombrado para los miembros de instancia y un bloque de tipo desnudo para los estáticos; el compilador acepta ambos estilos uno al lado del otro en una sola clase estática.

## Propiedades de extensión genéricas: cada parámetro de tipo debe alcanzar el receptor

Coloca los parámetros de tipo sobre la palabra clave `extension` y fluyen a cada miembro dentro del bloque. Esto te permite agregar propiedades a tipos genéricos abiertos como `IReadOnlyList<T>`:

```csharp
// .NET 11, C# 14 - generic extension properties
public static class ListExtensions
{
    extension<T>(IReadOnlyList<T> list)
    {
        public bool IsEmpty => list.Count == 0;

        public T? LastOrDefaultValue =>
            list.Count > 0 ? list[^1] : default;
    }
}
```

Hay una restricción dura que el compilador aplica: cada parámetro de tipo declarado en el bloque debe ser usado por el tipo receptor. `extension<T>(IReadOnlyList<T> list)` es legal porque `T` aparece en `IReadOnlyList<T>`. Un bloque como `extension<T>(string s)` que declara `T` pero nunca lo usa en el receptor es un error de compilación, porque el compilador no tiene nada de donde inferir `T` en el sitio de llamada. Las restricciones también van en el bloque:

```csharp
public static class ComparableExtensions
{
    extension<T>(IReadOnlyList<T> list) where T : IComparable<T>
    {
        public T Max
        {
            get
            {
                var max = list[0];
                for (int i = 1; i < list.Count; i++)
                    if (list[i].CompareTo(max) > 0) max = list[i];
                return max;
            }
        }
    }
}
```

## Cómo el compilador traduce una propiedad de extensión, y cómo desambiguar

Una propiedad de extensión es azúcar puramente en tiempo de compilación. El compilador convierte el bloque en métodos accesores estáticos ordinarios en un tipo anidado oculto: un getter llamado `get_PropertyName` y, si está presente, un setter llamado `set_PropertyName`, cada uno tomando el receptor como su primer argumento. Cuando escribes `title.WordCount`, el compilador lo reescribe a una llamada a ese accesor `get_WordCount` generado. El orden de parámetros de tipo en la forma traducida es primero los parámetros del receptor, luego cualquier parámetro de método, lo que solo importa si inspeccionas los metadatos generados.

De esto se derivan dos consecuencias. Primero, la resolución usa las mismas reglas de ámbito que los métodos de extensión: gana el candidato en el espacio de nombres o `using` más cercano, y cuando dos propiedades de extensión del mismo nombre están igualmente en ámbito obtienes un error de ambigüedad en lugar de una elección silenciosa. Lo resuelves restringiendo las directivas `using`, o calificando a través de la clase estática para que el compilador sepa a qué accesor te refieres. Segundo, como la propiedad existe solo en el sitio de llamada, nunca aparece en la reflexión en tiempo de ejecución sobre el tipo extendido: `typeof(string).GetProperty("WordCount")` devuelve `null`. Las propiedades de extensión son una comodidad del lenguaje, no una modificación en tiempo de ejecución del tipo, así que cualquier cosa que refleje sobre miembros reales (serializadores, enlace de datos, ORM) no las verá.

## La nulabilidad es tuya para declarar

Como escribes el parámetro receptor tú mismo, decides si la propiedad acepta un receptor nulo. Anota el receptor como anulable para escribir una propiedad que sea segura de llamar sobre una referencia nula, algo que una propiedad de instancia ordinaria nunca puede ser:

```csharp
// .NET 11, C# 14 - a null-tolerant extension property
public static class StringExtensions
{
    extension(string? s)
    {
        public bool HasText => !string.IsNullOrWhiteSpace(s);
    }
}

string? maybe = null;
Console.WriteLine(maybe.HasText);  // False, no NullReferenceException
```

Esto combina bien con el manejo de nulos en el sitio de llamada que llegó junto a ello; consulta [la asignación condicional de nulos de C# 14](/es/2026/02/csharp-14-null-conditional-assignment/) para las mejoras de `?.` y `?[]` en el lado izquierdo de una asignación.

## Los casos límite que vale la pena conocer antes de publicar

Unas pocas reglas y límites te ahorran un error de compilación confuso:

- **Sin campos, sin propiedades automáticas, sin eventos, sin constructores.** Los bloques `extension` de C# 14 admiten métodos, propiedades, indexadores y operadores. Los campos están explícitamente excluidos, que es justamente por qué se rechazan las propiedades automáticas.
- **El contenedor debe ser una clase estática no genérica y no anidada.** Coloca tus parámetros de tipo en el bloque `extension`, no en la clase.
- **Una colisión de nombre con un miembro real pierde.** Si el tipo extendido ya tiene una propiedad `WordCount`, la real siempre gana y tu propiedad de extensión nunca se considera. Las extensiones solo llenan huecos; nunca sobrescriben.
- **Los indexadores siguen la misma forma.** Puedes declarar `public T this[int i] => ...` dentro de un bloque `extension` de instancia, lo que te da indexadores de extensión en tipos que carecen de ellos.

Las propiedades de extensión son la porción más ergonómica del trabajo de los miembros de extensión, y se componen limpiamente con el resto de C# 14. Si estás agregando miembros calculados a un tipo que controlas frente a uno que no, sopésalas contra las otras herramientas de modelado de la versión: tanto [el truco de los miembros de extensión para devolver múltiples valores](/es/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) como [los operadores de asignación compuesta definidos por el usuario](/es/2026/04/csharp-14-user-defined-compound-assignment-operators/) se apoyan en la misma familia de sintaxis.

## Fuentes

- [Explore extension members in C# 14 (tutorial de Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members)
- [C# 14: Exploring extension members (.NET Blog)](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/)
- [Andrew Lock: C# 14 extension members, AKA extension everything](https://andrewlock.net/exploring-dotnet-10-preview-features-3-csharp-14-extensions-members/)
