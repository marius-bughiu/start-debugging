---
title: "¿Qué copia realmente una expresión `with` de C# y por qué las propiedades calculadas de un record no se recalculan?"
description: "Una expresión with llama al método <Clone>$ que el compilador genera en el record, el cual ejecuta un constructor de copia que copia todos los campos de instancia y omite todos los inicializadores. Por eso las propiedades inicializadas a partir de otras propiedades, los valores en caché y los ID Guid quedan desactualizados. Medido en .NET 10 con C# 14, con las soluciones que sí funcionan."
pubDate: 2026-10-16
tags:
  - "csharp"
  - "csharp-14"
  - "records"
  - "dotnet-10"
  - "immutability"
lang: "es"
translationOf: "2026/10/what-does-a-csharp-with-expression-actually-copy"
translatedBy: "claude"
translationDate: 2026-10-16
---

**Respuesta corta:** en C# 14 sobre .NET 10 (y en todas las versiones desde que los records llegaron con C# 9), `a with { X = 1 }` sobre un record de tipo clase hace dos cosas: llama al método `<Clone>$` generado por el compilador, que a su vez llama al constructor de copia del record, y después ejecuta los accesores `init` que indicaste, en orden. El constructor de copia copia **todos los campos de instancia** byte a byte (una copia superficial) y **no** ejecuta ningún inicializador de campo ni de propiedad. Así, una propiedad como `public string FullName { get; } = $"{First} {Last}";` se calcula una sola vez en el constructor del original, se copia como un valor almacenado y nunca se recalcula. Haz que los valores derivados sean miembros con cuerpo de expresión (`=> $"{First} {Last}"`), o reinicia las cachés dentro de los accesores `init` de las propiedades de las que dependen.

El resto de este artículo muestra exactamente qué genera el compilador, qué tipos de miembros "calculados" sobreviven a un `with` y cuáles no, un desagradable efecto secundario en la igualdad al usar caché dentro de un record, y los patrones que resisten. Cada salida de abajo proviene de aplicaciones basadas en archivo (`dotnet run probe.cs`) con el SDK 10.0.302 y el runtime 10.0.10.

## Qué genera el compilador para un record

Toma un record posicional sencillo:

```csharp
// .NET 10, C# 14
record Person(string First, string Last);
```

Además del constructor primario, las propiedades, la igualdad y `ToString`, el compilador emite dos miembros de copia. La [especificación de records](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members) los llama "constructor de copia" y método "clone". Puedes verlos ambos con reflexión:

```csharp
// .NET 10, C# 14
using System.Reflection;

foreach (var m in typeof(Person).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)
                                .Where(m => m.Name.Contains("Clone")))
    Console.WriteLine($"method: {m.Name} virtual={m.IsVirtual} returns {m.ReturnType.Name}");

foreach (var c in typeof(Person).GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
    Console.WriteLine($"ctor: ({string.Join(",", c.GetParameters().Select(p => p.ParameterType.Name))}) protected={c.IsFamily}");
```

Salida:

```text
method: <Clone>$ virtual=True returns Person
ctor: (String,String) protected=False
ctor: (Person) protected=True
```

`<Clone>$` es un nombre que no puedes escribir en C#, así que solo el compilador puede llamarlo. Su cuerpo es simplemente `return new Person(this);`. El constructor protegido `Person(Person original)` es donde ocurre la copia, y la especificación es precisa sobre lo que hace: después de llamar al constructor de copia de la base (o a `object()`), "copia los valores de todos los campos de instancia declarados implícita o explícitamente dentro del tipo record", y "no ejecuta ningún inicializador de campo/propiedad de instancia presente en la declaración del record."

Entonces esto:

```csharp
var b = a with { First = "Grace" };
```

se reduce aproximadamente a:

```csharp
var tmp = a.<Clone>$();   // new Person(a): field-by-field copy, no initializers
tmp.First = "Grace";       // the init accessor, legal here because the compiler emits it
var b = tmp;
```

De esa transformación se desprenden dos consecuencias. Primero, nada de lo que escribiste en el cuerpo del record se ejecuta durante la copia, salvo los accesores `init` de los miembros que nombras. Segundo, esos accesores `init` se ejecutan después de la copia, sobre una instancia que ya contiene todos los campos del original.

## Cuatro formas de escribir una propiedad "calculada", cuatro resultados distintos

Aquí hay un record con cuatro miembros que parecen derivarse de `First` y `Last`:

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string Init { get; } = $"{First} {Last}";   // property initializer
    public string Expr => $"{First} {Last}";            // expression-bodied
    private string? _cached;
    public string Cached => _cached ??= $"{First} {Last}"; // lazy cache in a field
}
```

Y una ejecución que toca la caché antes de copiar:

```csharp
var a = new Name("Ada", "Lovelace");
Console.WriteLine(a.Cached);              // fills the cache on a
var b = a with { First = "Grace" };
Console.WriteLine($"{b.Init} | {b.Expr} | {b.Cached}");
Console.WriteLine(b);
```

Salida:

```text
Ada Lovelace
Ada Lovelace | Grace Lovelace | Ada Lovelace
Name { First = Grace, Last = Lovelace, Init = Ada Lovelace, Expr = Grace Lovelace, Cached = Ada Lovelace }
```

Solo la propiedad con cuerpo de expresión es correcta. Las razones se corresponden una a una con la transformación anterior:

- **`Init { get; } = ...`** tiene como respaldo un campo oculto `<Init>k__BackingField`. El inicializador se ejecutó una vez, dentro del constructor primario de `a`. El constructor de copia copió el campo de respaldo como una cadena y no volvió a ejecutar el inicializador. `First` cambió después, pero nada vuelve a asignar `Init`.
- **`Expr => ...`** no tiene campo de respaldo. Es un método que lee `First` y `Last` en cada llamada, así que refleja lo que la copia contiene ahora.
- **`Cached => _cached ??= ...`** es el caso sutil. Si llamas a `with` *antes* de que alguien lea `Cached` en el original, `_cached` sigue siendo `null`, se copia como `null` y la copia calcula el valor correcto. Si la caché del original ya está llena, la copia hereda `"Ada Lovelace"` y el `??=` nunca se dispara. El error depende de si algún camino de código no relacionado leyó la propiedad primero, lo que lo hace muy difícil de reproducir.

Lo mismo le pasa a cualquier cosa que produzca un inicializador de campo. Un record con `public Guid Id { get; } = Guid.NewGuid();` conserva el **mismo** `Id` en cada copia hecha con `with`. Confirmé que el inicializador simplemente no se ejecuta con un contador:

```csharp
// .NET 10, C# 14
var t = new Tracked("x");
var t2 = t with { Value = "y" };
Console.WriteLine($"initializer runs: {Counter.Count}, stamp same: {t.Stamp == t2.Stamp}");

static class Counter { public static int Count; }
record Tracked(string Value)
{
    public long Stamp { get; } = ++Counter.Count;
}
```

```text
initializer runs: 1, stamp same: True
```

Una construcción, una ejecución del inicializador, dos instancias. Si usas records para eventos o comandos con un ID o una marca de tiempo generados, `with` te da un segundo objeto que afirma ser el mismo evento.

## La trampa de la igualdad: los campos ocultos participan en `==`

La igualdad de los records también se sintetiza a partir de los campos de instancia, y eso incluye los privados. Por lo tanto, la copia desactualizada de arriba no es igual a un record recién construido con los mismos datos visibles:

```csharp
var c = new Name("Grace", "Lovelace");
Console.WriteLine(b == c); // False: b.Init and b._cached still say "Ada Lovelace"
```

Peor aún, una caché perezosa hace que la igualdad dependa del *historial de lecturas*, incluso sin ningún `with`:

```csharp
// .NET 10, C# 14
var x = new Name2("Ada", "Lovelace");
var y = new Name2("Ada", "Lovelace");
Console.WriteLine(x == y);   // True
_ = x.FullName;              // only reads a property
Console.WriteLine(x == y);   // False

record Name2(string First, string Last)
{
    private string? _fullName;
    public string FullName => _fullName ??= $"{First} {Last}";
}
```

```text
True
False
```

Leer un getter cambió el resultado de `==`. Si esos records son claves de diccionario, miembros de un conjunto o se comparan en la aserción de una prueba, obtienes fallos que desaparecen cuando agregas un `Console.WriteLine` para depurarlos. Este es el argumento más fuerte contra usar caché dentro de un record.

## Es una copia superficial, hasta el fondo

El constructor de copia copia valores de campo. Para los campos de tipo referencia, el valor es una referencia, así que ambos records apuntan al mismo objeto:

```csharp
// .NET 10, C# 14
var o = new Order(1, new List<string> { "apple" });
var o2 = o with { Id = 2 };
o2.Items.Add("pear");
Console.WriteLine($"o.Items: {string.Join(",", o.Items)} same list: {ReferenceEquals(o.Items, o2.Items)}");

record Order(int Id, List<string> Items);
```

```text
o.Items: apple,pear same list: True
```

Lo mismo ocurre con un campo `Lazy<T>` (ambas copias comparten el `Lazy` ya evaluado), un `StringBuilder` o una clase mutable anidada. Un record es tan inmutable como su campo menos inmutable. Prefiere `ImmutableArray<T>` o `IReadOnlyList<T>` respaldado por un arreglo que nunca mutes, y trata `with` como "copiar el nivel superior".

## Herencia: `with` conserva el tipo en tiempo de ejecución

`<Clone>$` es virtual, y cada record derivado lo sobrescribe con un tipo de retorno covariante. Un `with` a través de una variable del tipo base produce el tipo derivado:

```csharp
// .NET 10, C# 14
Person p = new Student("Alan", "Turing", "King's");
var q = p with { First = "Alonzo" };
Console.WriteLine(q.GetType().Name); // Student

record Person(string First, string Last);
record Student(string First, string Last, string College) : Person(First, Last);
```

La reflexión sobre `Student` muestra `<Clone>$ returns Student`. Normalmente es lo que quieres, pero significa que `with` sobre una referencia base copia el estado exclusivo del derivado (aquí `College`) que el código que llama ni siquiera puede ver, incluidos los campos de caché desactualizados declarados en el record derivado.

Para un `sealed record`, el compilador hace que el constructor de copia sea `private` y que `<Clone>$` no sea virtual (la sonda imprimió `sealed copy ctor private: True; clone virtual: False`).

## Qué puede asignar una expresión `with`

Como `with` ejecuta los accesores después del clon, solo puede asignar miembros que tengan un accesor `set` o `init` y sean accesibles en el sitio de la llamada. Intentar "arreglar" una propiedad calculada desactualizada asignándola falla:

```csharp
// .NET 10, C# 14
record A(int X) { public int Computed { get; } = X * 2; }

var b = new A(1) with { Computed = 3 };
// error CS0200: Property or indexer 'A.Computed' cannot be assigned to -- it is read only
```

`with` sobre una clase ordinaria se rechaza de plano, porque una clase no tiene `<Clone>$`:

```text
error CS8858: The receiver type 'Svc' is not a valid record type and is not a struct type.
```

Desde C# 10, `with` también funciona con structs (incluido `record struct`), tuplas y tipos anónimos. Para esos no hay método clone ni constructor de copia: el valor se copia como cualquier asignación de struct, y luego se asignan los miembros indicados. La [documentación de la expresión `with`](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression) establece claramente que no se puede personalizar la semántica de copia de los tipos struct.

Los miembros `required` no te obligan a repetirte en un `with`. El constructor de copia sintetizado está marcado con `[SetsRequiredMembers]`, así que `r with { }` sobre un record con `required string Name` compila y copia `Name`. Si los miembros `required` te confunden en los inicializadores, el [recorrido por CS9035](/es/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) cubre el lado de los inicializadores de objeto.

## Soluciones que sí resisten

### 1. Calcular al acceder (la respuesta por defecto)

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string FullName => $"{First} {Last}";
}
```

Sin campo de respaldo, nada que copiar, nada que se desactualice y nada extra en `Equals`/`GetHashCode`. La propia guía de Microsoft en la página de `with` dice lo mismo: las propiedades calculadas en los records "deben calcularse al acceder, no inicializarse cuando se crea la instancia." Interpolar dos cadenas es barato; mide antes de decidir que no lo es.

### 2. Validar o recalcular en los accesores `init`

Los accesores `init` son la única parte de tu código que sí se ejecuta durante un `with`. La [palabra clave `field`](/es/2025/04/c-14-the-field-keyword-and-field-backed-properties/) de C# 14 facilita poner lógica ahí sin declarar un campo de respaldo. La validación funciona como esperarías:

```csharp
// .NET 10, C# 14
record Person(string First, string Last)
{
    public string Last { get; init => field = string.IsNullOrEmpty(value)
        ? throw new ArgumentException("Last required")
        : value; } = Last;
}

var bad = new Person("Ada", "Lovelace") with { Last = "" }; // throws ArgumentException: Last required
```

Si un valor realmente es costoso y debes guardarlo en caché, invalida la caché desde los accesores `init` de las entradas, y saca la caché de la igualdad:

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    private string? _fullName;
    public string First { get; init { field = value; _fullName = null; } } = First;
    public string Last  { get; init { field = value; _fullName = null; } } = Last;
    public string FullName => _fullName ??= $"{First} {Last}";

    public virtual bool Equals(Name? other) =>
        other is not null && EqualityContract == other.EqualityContract
        && First == other.First && Last == other.Last;
    public override int GetHashCode() => HashCode.Combine(First, Last);
}
```

Con esta versión, `a with { First = "Grace" }` imprime `Grace Lovelace` incluso si `a.FullName` se leyó primero, y `b == new Name("Grace", "Lovelace")` es `True`. El costo es que ahora mantienes `Equals` y `GetHashCode` a mano, y el compilador no te avisará cuando agregues una propiedad y olvides incluirla.

### 3. Escribir tu propio constructor de copia

Puedes declarar tú mismo el constructor de copia y copiar solo lo que debe sobrevivir:

```csharp
// .NET 10, C# 14
record Fixed(string First, string Last)
{
    private string? _full;
    public string FullName => _full ??= $"{First} {Last}";

    protected Fixed(Fixed original)
    {
        First = original.First;
        Last = original.Last;
        // _full deliberately not copied
    }
}
```

Esto funciona (`f with { First = "Grace" }` da `Grace Lovelace` después de que la caché del original se llenó), y es la forma documentada de hacer una copia profunda de una lista. También tiene los bordes más filosos:

- Ahora te encargas de copiar **todos** los campos. Agrega una propiedad el mes que viene, olvida este constructor, y `with` la restablecerá en silencio a `default`.
- En un record derivado debes encadenar con el constructor de copia de la base. Si lo omites, obtienes dos errores, `CS1729: 'Base' does not contain a constructor that takes 0 arguments` y `CS8868: A copy constructor in a record must call a copy constructor of the base, or a parameterless object constructor if the record inherits from object.` La solución es `protected Derived(Derived other) : base(other) { ... }`.
- Debe ser `public` o `protected` a menos que el record esté sellado.
- No hace nada por `Equals`: un campo de caché sigue haciendo que `==` dependa del historial de lecturas.

Úsalo para copias profundas de colecciones, no como mecanismo de invalidación de caché.

### 4. No pongas la identidad en un inicializador

Para los ID y las marcas de tiempo que deben ser únicos por instancia, no los generes en un inicializador de propiedad en un record al que piensas aplicarle `with`. Pásalos de forma explícita (`evt with { Id = Guid.NewGuid() }`) o crea nuevos eventos mediante una factory en lugar de `with`. Copiar un evento y conservar su ID es exactamente lo que `with` está diseñado para hacer.

## Una lista de verificación para los tipos record a los que aplicas `with`

- Todo valor derivado tiene cuerpo de expresión, o se recalcula desde los accesores `init`.
- Sin campos de caché privados, a menos que también sobrescribas `Equals` y `GetHashCode`.
- Sin colecciones mutables, o un constructor de copia personalizado que las clone.
- Sin inicializadores `= Guid.NewGuid()` ni `= DateTime.UtcNow` en tipos que se copian.
- Los records derivados que declaran un constructor de copia encadenan con `base(original)`.

Si estás decidiendo si un tipo debería ser un record, la [matriz de decisión record vs clase vs struct](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) cubre las ventajas y desventajas, y el ángulo de EF Core (una copia con `with` es una instancia que el change tracker nunca ha visto) está en [cómo usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/). Los desarrolladores de Dart se topan con la misma pregunta sobre copias superficiales con `copyWith`, tratada en [records de Dart vs clases Freezed](/es/2026/05/dart-records-vs-freezed-classes/).

## Relacionado

- [Record vs clase vs struct en C#: una matriz de decisión](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)
- [Cómo usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [C# 14: la palabra clave `field` y las propiedades respaldadas por campo](/es/2025/04/c-14-the-field-keyword-and-field-backed-properties/)
- [Corregir CS9035: el miembro required debe asignarse en el inicializador de objeto](/es/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/)

## Fuentes

- [La expresión `with`, referencia de C# (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression)
- [Records, mutación no destructiva (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record#nondestructive-mutation)
- [Propuesta de records, "Copy and Clone members" (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members)
- [La palabra clave `field` (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/field)
