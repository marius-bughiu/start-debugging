---
title: "Solución: [MemberNotNull] no tiene efecto en un método factory estático y CS8618 sigue apareciendo"
description: "CS8618 se comprueba cuando el constructor termina, y [MemberNotNull] en un método estático se ignora en silencio para miembros de instancia. Pasa los valores a un constructor privado."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "nullable"
lang: "es"
translationOf: "2026/10/fix-membernotnull-has-no-effect-on-a-static-factory-method"
translatedBy: "claude"
translationDate: 2026-10-28
---

`[MemberNotNull]` en un método factory estático no puede eliminar `CS8618`, porque la advertencia se reporta en el constructor, en el momento en que el constructor termina, y el compilador nunca mira lo que hace el factory después. Además, un método estático no tiene `this`, así que cuando su `[MemberNotNull]` nombra un miembro de instancia el compilador ignora el atributo en silencio: ninguna advertencia en el método, ningún efecto para quien lo llama. La solución es devolver la asignación a un constructor: haz que el factory calcule los valores y los pase a un constructor privado, o marca los miembros como `required` y asígnalos en un inicializador de objeto dentro del factory. Verificado con el SDK de .NET 10 10.0.302 (C# 14); el comportamiento es el mismo desde que `[MemberNotNull]` llegó en C# 9.

## El error en contexto

La salida de compilación apunta al constructor privado, no al factory que anotaste:

```
Widget.cs(8,13): warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor. Consider adding the 'required' modifier or declaring the property as nullable.
```

No hay un segundo diagnóstico que te diga que el atributo se ignoró. Ese silencio es lo que lo vuelve confuso: el `[MemberNotNull(nameof(Name))]` parece que debería hacer algo, y nada en la compilación dice lo contrario.

## Por qué ocurre

Aquí se combinan dos reglas distintas.

**`CS8618` se comprueba por constructor, a su salida.** El compilador ejecuta el análisis de flujo de nulabilidad sobre el cuerpo de cada constructor (más los inicializadores de campos y propiedades) y hace una sola pregunta en la llave de cierre: ¿cada miembro de tipo de referencia no anulable tiene asignado con certeza un valor no nulo? No sigue al objeto después de que el constructor retorna. Un factory que hace `var w = new Widget(); w.Name = name; return w;` asigna `Name` cuando el constructor ya terminó con `Name` todavía en `null`, y esa salida es donde vive la advertencia. El equipo de Roslyn decidió desde el principio no rastrear la inicialización a través de llamadas a métodos ("We've decided not to track initialization interprocedurally for now" en [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358)). `[MemberNotNull]` es la vía de escape opcional para exactamente un caso: un helper llamado *desde dentro* del constructor sobre `this`.

**`[MemberNotNull]` en un método estático solo significa algo para miembros estáticos.** El atributo es una postcondición: "cuando este método retorna, estos miembros del receptor no son nulos". Para un método de instancia el receptor es `this` (o el objeto sobre el que lo llamaste). Un método estático no tiene receptor, así que los únicos miembros por los que puede responder son campos y propiedades estáticos. Cuando listas un miembro de instancia, Roslyn acepta el `nameof` (compila bien porque `nameof(Name)` es válido en cualquier parte de la clase) y luego descarta la anotación. Confirmé ambas mitades en el SDK 10.0.302: un método estático marcado con `[MemberNotNull(nameof(Nick))]` que nunca asigna `Nick` no produce `CS8774`, y un método de instancia que lo llama sigue recibiendo `CS8602` cuando desreferencia `Nick` después. El mismo atributo nombrando un campo estático sí se valida y se respeta.

Así que el factory estático falla por ambos lados: no es el constructor, y su anotación nombra miembros que no puede describir.

## Repro mínimo

```csharp
// .NET 10 SDK 10.0.302, C# 14, <Nullable>enable</Nullable>
using System.Diagnostics.CodeAnalysis;

public class Widget
{
    public string Name { get; set; }

    private Widget() { }                     // CS8618 is reported here

    [MemberNotNull(nameof(Name))]            // silently ignored: static method, instance member
    public static Widget Create(string name)
    {
        var w = new Widget();
        w.Name = name;
        return w;
    }
}
```

La segunda forma del mismo error es un helper estático que recibe la instancia como parámetro y se llama desde el constructor. Parece el patrón documentado, pero no lo es:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public class Gadget
{
    public string Name { get; set; }

    public Gadget(string name) => Init(this, name);   // CS8618 still fires here

    [MemberNotNull(nameof(Name))]
    private static void Init(Gadget g, string name) => g.Name = name;
}
```

`[MemberNotNull]` describe al receptor de la llamada, y `Init(this, name)` no tiene receptor. Pasar `this` como argumento no cuenta. La única versión estática que funciona es aquella en la que tanto el helper como los miembros son estáticos, por ejemplo un constructor estático que llama a un cargador estático:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public static class Config
{
    public static string ConnectionString;

    static Config() => Load();                 // no CS8618: static helper, static member

    [MemberNotNull(nameof(ConnectionString))]
    private static void Load() => ConnectionString = "Server=.;Database=app";
}
```

## La solución en detalle

Todas las soluciones de abajo devuelven la asignación a donde `CS8618` puede verla: dentro de un constructor, o detrás de un contrato que el compilador entiende. Están en orden de preferencia.

### 1. Pasa los valores calculados a un constructor privado

Esta es la forma correcta para casi cualquier factory. El factory hace el trabajo (validación, parseo, E/S) y luego entrega valores terminados a un constructor que solo asigna:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Widget
{
    public string Name { get; }

    private Widget(string name) => Name = name;

    public static Widget Create(string raw)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(raw);
        return new Widget(raw.Trim());
    }
}
```

Sin atributo, sin supresión, y `Name` puede pasar a ser de solo lectura, algo que un factory de "construir y luego asignar" nunca podría ofrecer. Si tienes varios miembros, el constructor simplemente gana parámetros. Un [record](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) con un constructor posicional privado es la versión compacta de la misma idea.

### 2. Convierte el helper estático en una función que devuelve el valor

Para la forma `Init(this, ...)`, cambia el helper para que devuelva lo que calculó, y deja que el constructor lo asigne:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Gadget
{
    public string Name { get; }

    public Gadget(string raw) => Name = Normalize(raw);

    private static string Normalize(string raw) => raw.Trim().ToLowerInvariant();
}
```

Un método estático con valor de retorno es más fácil de probar que uno que muta un parámetro, y el compilador ve una asignación simple en el constructor. Cuando el helper produce varios valores, devuelve una tupla y desconstrúyela: `(Name, Slug) = Parse(raw);` es una asignación definitiva de ambos miembros.

### 3. Haz que el helper sea un método de instancia y llámalo desde el constructor

Si la inicialización realmente es un bloque de código imperativo compartido, mantenla en un helper, pero hazlo método de instancia para que `[MemberNotNull]` describa a `this`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Report
{
    public string Title { get; private set; }

    private Report(string raw) => Normalize(raw);

    [MemberNotNull(nameof(Title))]
    private void Normalize(string raw) => Title = raw.Trim();

    public static Report Create(string raw) => new(raw);
}
```

Este es el patrón que documenta la [página de Microsoft Learn sobre atributos de nulabilidad](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis#helper-methods-membernotnull-and-membernotnullwhen). A diferencia del caso estático, el compilador revisa el helper: si `Normalize` puede retornar sin asignar `Title`, obtienes `CS8774: Member 'Title' must have a non-null value when exiting.`

Una trampa: llamar al helper de instancia desde el factory sobre el objeto nuevo (`var r = new Report(); r.Normalize(raw);`) sí hace que `r.Title` sea no nulo durante el resto del factory, porque `[MemberNotNull]` se aplica a cualquier receptor sobre el que lo llames. Aun así no hace nada por `CS8618`, porque el constructor ya terminó antes de que esa línea se ejecutara.

### 4. Marca los miembros como `required` y usa un inicializador de objeto en el factory

Si prefieres la construcción estilo propiedades, `required` mueve la obligación del constructor a la expresión de creación del objeto, y el factory es el único lugar que puede crear uno:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Invoice
{
    public required string Number { get; init; }
    public required string Customer { get; init; }

    private Invoice() { }

    public static Invoice Create(string number, string customer) =>
        new() { Number = number.Trim(), Customer = customer.Trim() };
}
```

`CS8618` desaparece porque un miembro `required` no es responsabilidad del constructor. También obtienes una red de seguridad que el factory original nunca tuvo: si olvidas uno, la compilación falla con `CS9035: Required member 'Invoice.Customer' must be set in the object initializer or attribute constructor.` Eso es un error, no una advertencia. El [recorrido de CS9035](/es/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) cubre el lado del llamador de este contrato.

### 5. Usa `[SetsRequiredMembers]` en un constructor privado

Si el tipo tiene miembros `required` para sus llamadores públicos pero el factory quiere pasar valores de forma posicional, agrega un constructor que prometa asignarlos todos:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Tag
{
    public required string Value { get; init; }

    public Tag() { }

    [SetsRequiredMembers]
    private Tag(string value) => Value = value;

    public static Tag Create(string raw) => new(raw.Trim().ToLowerInvariant());
}
```

Igual que `[MemberNotNull]`, `[SetsRequiredMembers]` se confía, no se verifica: si ese constructor olvida un miembro, nada te avisa. Mantén el constructor lo bastante corto como para revisarlo a ojo.

### 6. Último recurso: suprime en el constructor, no en la propiedad

Si el tipo lo construye un framework que exige un constructor sin parámetros y rellena los miembros después, limita la supresión a ese constructor para no perder el análisis en ningún otro lugar:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class LegacyRow
{
    public string Name { get; private set; }

#pragma warning disable CS8618 // Name is always assigned by Create before the instance escapes
    private LegacyRow() { }
#pragma warning restore CS8618

    public static LegacyRow Create(string name) => new() { Name = name };
}
```

Esto es honesto sobre lo que pasa, y el comentario le dice al próximo lector qué método sostiene la promesa. Prefiérelo sobre `= null!` en la propiedad: `null!` silencia la advertencia para todos los constructores que el tipo tenga alguna vez, incluidos los que se agreguen después y que de verdad olviden asignar.

## Trampas y variantes

- **Borra el atributo muerto.** Después de arreglar el factory, quita `[MemberNotNull]` de cualquier método estático que nombre miembros de instancia. No hace nada, el compilador nunca te lo dirá, y la próxima persona lo copiará. Una búsqueda rápida de `MemberNotNull` en toda la solución, revisando cada resultado en busca de `static`, los encuentra todos.

- **Los factories asíncronos chocan con `CS8774` por otra razón.** Un `static async Task<T> CreateAsync()` es el motivo habitual para usar un factory en primer lugar, ya que los constructores no pueden hacer `await`. Si en cambio pones `[MemberNotNull]` en un helper de instancia `async Task InitAsync()`, el compilador comprueba la postcondición en los puntos `await`, donde el método puede devolver el control a quien lo llamó, no cuando la tarea termina, así que asignar el miembro después de un `await` sigue produciendo `CS8774`. Roslyn considera esto intencional ([dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022)). La solución es la misma que la 1: haz `await` de la E/S dentro del factory estático y luego pasa los resultados a un constructor privado.

- **Para un factory `TryCreate`, anota el parámetro `out`, no los miembros.** Lo que le importa al llamador es si el objeto devuelto es nulo, y eso es una postcondición del parámetro:

  ```csharp
  // .NET 10 SDK 10.0.302, C# 14
  using System.Diagnostics.CodeAnalysis;

  public sealed class Sku
  {
      public string Code { get; }
      private Sku(string code) => Code = code;

      public static bool TryCreate(string? raw, [NotNullWhen(true)] out Sku? sku)
      {
          sku = string.IsNullOrWhiteSpace(raw) ? null : new Sku(raw.Trim());
          return sku is not null;
      }
  }
  ```

  Los miembros en sí son no anulables y están garantizados por el constructor privado, así que nada más necesita un atributo.

- **No puedes poner `[MemberNotNull]` en un constructor.** El atributo solo se aplica a métodos y propiedades. Pedir que un constructor derivado responda por un miembro de la clase base es una solicitud abierta ([dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526)). Pasa el valor hacia arriba con `base(...)` en su lugar.

- **Los helpers de instancia llamados sobre otro objeto sí fluyen, pero solo localmente.** `other.Init(); other.Name.Length` no genera advertencia, porque el receptor es `other`. Eso es útil dentro del cuerpo de un factory, pero nunca satisface retroactivamente al constructor que creó `other`.

- **Los miembros perezosos son otro problema.** Si `Name` legítimamente no tiene valor hasta el primer uso, es anulable o pertenece detrás de `Lazy<T>`. Compara las opciones en [Lazy&lt;T&gt; vs LazyInitializer vs double-checked locking](/es/2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp/) en lugar de pelear con `CS8618`.

## Relacionado

- [Solución: CS8618 "Non-nullable property must contain a non-null value when exiting constructor"](/es/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) para la advertencia general y el patrón de helper de instancia con `[MemberNotNull]`.
- [Solución: CS9035 "Required member 'X' must be set in the object initializer"](/es/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) para el error que obtienes cuando un factory basado en `required` omite un miembro.
- [record vs class vs struct en C#: una matriz de decisión](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) para elegir una forma de tipo que haga natural la inicialización en el constructor.
- [Qué copia realmente una expresión with de C#](/es/2026/10/what-does-a-csharp-with-expression-actually-copy/) para otro caso donde la construcción se salta el código que esperas que se ejecute.
- [Asignación condicional nula en C# 14](/es/2026/02/csharp-14-null-conditional-assignment/) para más sobre cómo razona el compilador acerca de null.

## Fuentes

- Microsoft Learn, [Attributes interpreted by the compiler: Nullable static analysis](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis) (la sección "Helper methods: MemberNotNull and MemberNotNullWhen" y su ejemplo de helper en el constructor).
- Microsoft Learn, [MemberNotNullAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.membernotnullattribute) (destinos del atributo: métodos y propiedades).
- Microsoft Learn, [Nullable reference type warnings](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) (`CS8618`, `CS8774`).
- GitHub, [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358) (la inicialización no se rastrea a través de llamadas a métodos).
- GitHub, [dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526) (`[MemberNotNull]` no está permitido en constructores).
- GitHub, [dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022) (`CS8774` en métodos `[MemberNotNull]` asíncronos es intencional).
