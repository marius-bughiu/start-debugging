---
title: "Solución: CS9035 \"Required member 'X' must be set in the object initializer\" en C#"
description: "CS9035 significa que un miembro marcado como required no se asignó. Asígnalo en el inicializador de objeto, o agrega un constructor con [SetsRequiredMembers] que asigne cada miembro required."
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
lang: "es"
translationOf: "2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer"
translatedBy: "claude"
translationDate: 2026-07-06
---

`CS9035` se dispara en tiempo de compilación cuando creas una instancia de un tipo que tiene un miembro `required`, pero ese miembro no se asigna. El compilador quiere que cada campo o propiedad `required` se establezca antes de que el objeto salga de la construcción. Corrígelo de forma directa: agrega el miembro al inicializador de objeto, por ejemplo `new Person { Name = "Ada" }`. Si un constructor ya asigna el miembro, díselo al compilador poniendo `[SetsRequiredMembers]` en ese constructor para que deje de exigir el inicializador. Esto está verificado con C# 14 en .NET 11; el modificador `required` y este diagnóstico se comportan igual desde C# 11 en .NET 7.

## El error en contexto

El mensaje completo nombra el miembro exacto que le falta al compilador:

```
error CS9035: Required member 'Person.Name' must be set in the object initializer or attribute constructor.
```

Verás un `CS9035` por cada miembro required sin asignar, así que un tipo con tres propiedades required y un `new Person()` vacío produce tres errores a la vez. Es un diagnóstico de tiempo de compilación, no una excepción en tiempo de ejecución: la compilación falla, nada se ejecuta. Ese es todo el propósito de `required`: la comprobación pasó de ser un `NullReferenceException` que golpeabas en producción a un subrayado rojo que ves en el editor.

## Por qué ocurre

El modificador `required`, introducido en C# 11, marca un campo o propiedad como obligatorio en el momento de la inicialización. Cuando cualquier expresión construye una nueva instancia del tipo, el compilador verifica que cada miembro `required` esté asignado, ya sea a través de un inicializador de objeto o de un constructor que promete establecerlos. Si no puede probarlo, emite `CS9035`.

La palabra clave es "probar". El compilador no ejecuta tu código. Solo confía en dos cosas: un miembro que asignas directamente en el inicializador de objeto, y un constructor anotado explícitamente con `[SetsRequiredMembers]`. Un constructor que da la casualidad de que asigna el miembro en su cuerpo pero carece del atributo no cuenta para nada; el compilador no leerá el cuerpo para averiguarlo. Por eso el error persiste incluso cuando tu constructor claramente establece el valor: tienes que decírselo al compilador, no mostrárselo.

Tres situaciones producen el error:

- Llamas a `new T()` o `new T { ... }` sin asignar cada miembro `required`.
- Escribiste un constructor que establece los miembros required pero olvidaste `[SetsRequiredMembers]`, así que el compilador sigue exigiendo un inicializador.
- Agregaste `required` a un miembro de un tipo base, y la ruta de construcción de un tipo derivado ya no lo satisface.

## Reproducción mínima

El tipo más pequeño que dispara `CS9035`:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public int Age { get; init; }   // not required, optional
}
```

Cada una de estas construcciones no compila:

```csharp
// .NET 11, C# 14
var a = new Person();                        // CS9035 x2 (Name and Email)
var b = new Person { Name = "Ada" };         // CS9035 x1 (Email still missing)
var c = new Person { Age = 36 };             // CS9035 x2 (Name and Email)
```

Solo cuando ambos miembros required están presentes compila:

```csharp
// .NET 11, C# 14 -- compiles
var ok = new Person { Name = "Ada", Email = "ada@example.com" };
```

Fíjate en que `Age` se omite y eso está bien. `required` es por miembro; los miembros opcionales siguen siendo opcionales. Al compilador solo le importa que los miembros que llevan el modificador `required` estén asignados.

## La solución en detalle

Recorre estas opciones en orden. La primera es la respuesta en la gran mayoría de los casos; el resto cubre las situaciones donde un inicializador no es lo que quieres.

### 1. Asigna los miembros required en el inicializador de objeto

La solución prevista es establecer cada miembro required en el sitio de la llamada:

```csharp
// .NET 11, C# 14
var person = new Person
{
    Name = "Ada Lovelace",
    Email = "ada@example.com",
    // Age is optional, omit it freely
};
```

Para esto sirve `required`: el contrato del tipo dice que estos campos son obligatorios, y el inicializador lo respeta. Si te encuentras repitiendo los mismos valores, es señal de que el tipo quiere un constructor, que es la siguiente solución.

### 2. Agrega un constructor anotado con [SetsRequiredMembers]

Cuando un constructor ya toma los valores y los asigna, decóralo con `System.Diagnostics.CodeAnalysis.SetsRequiredMembers`. Este atributo le asegura al compilador que el constructor inicializa cada miembro required, así que los llamadores ya no necesitan un inicializador de objeto:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public class Person
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public int Age { get; init; }

    [SetsRequiredMembers]
    public Person(string name, string email)
    {
        Name = name;
        Email = email;
    }
}

// now this compiles, no initializer needed
var person = new Person("Ada", "ada@example.com");
```

Un detalle delicado: `[SetsRequiredMembers]` es una aserción, no una garantía verificada. El compilador te toma la palabra y no comprueba que el constructor realmente asigne cada miembro required. Si agregas el atributo pero olvidas establecer `Email` en el cuerpo, no obtienes ningún `CS9035` ni ninguna advertencia, solo un `null` donde prometiste un valor. Mantén el atributo honesto.

Si conservas un constructor sin parámetros junto al anotado, los llamadores de la versión sin parámetros aún necesitan el inicializador. El atributo solo exime al constructor específico donde reside.

### 3. Quita `required` si el miembro no es realmente obligatorio

Si el miembro tiene un valor por defecto razonable o es genuinamente opcional, no debería ser `required` en primer lugar. Quitar el modificador elimina la obligación:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; init; }
    public string Email { get; init; } = "";   // was required, now optional with a default
}
```

Esta es la decisión correcta sorprendentemente a menudo. Recurre a `required` solo cuando no haya un valor por defecto razonable y construir sin el valor dejaría al objeto en un estado inválido. Darle un valor por defecto a una propiedad y quitar `required` es más limpio que forzar a cada sitio de llamada a pasar una cadena vacía.

### 4. Para records, usa un constructor posicional o con [SetsRequiredMembers]

Un record posicional genera una propiedad `init` por parámetro, pero esas no son `required` por defecto. Si agregas explícitamente una propiedad `required` a un record con un constructor primario, el constructor primario no la satisface automáticamente, y obtienes `CS9035` cuando usas la forma posicional. Esto confunde a la gente porque parece que el constructor debería contar. Consulta la discusión de diseño en [dotnet/csharplang #6780](https://github.com/dotnet/csharplang/discussions/6780) para el razonamiento. La solución es establecer la propiedad en un inicializador encima de la llamada posicional, o agregar `[SetsRequiredMembers]` a un constructor que la asigne:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public record Product(string Sku)
{
    public required string Name { get; init; }

    [SetsRequiredMembers]
    public Product(string sku, string name) : this(sku) => Name = name;
}

// both work now
var withInit = new Product("A-100") { Name = "Widget" };
var withCtor = new Product("A-100", "Widget");
```

Si quieres que toda la construcción del record se aplique a través de los parámetros posicionales, prefiere propiedades `init` planas en lugar de propiedades `required`. Mezclar records posicionales y miembros `required` es una fuente de confusión; decide qué modelo usa el tipo. Para una visión más amplia de cuándo vale la pena un record, consulta [record vs class vs struct en C#](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).

## Puntos delicados y variantes

Un puñado de situaciones producen `CS9035`, o algo que se le parece, por razones que no son obvias a partir del mensaje:

- **`[SetsRequiredMembers]` es confianza, no prueba.** Como se cubrió arriba, el compilador no verifica el constructor. Un constructor con el atributo que se salta un miembro required compila limpio y te entrega un `null`. Trata el atributo como un contrato que eres responsable de cumplir.

- **System.Text.Json respeta `required`.** Desde .NET 8, el deserializador JSON aplica los miembros required: si el JSON entrante omite una propiedad required, la deserialización lanza una `JsonException` en tiempo de ejecución en lugar de producir un objeto a medio construir. Este es un error en tiempo de ejecución, no `CS9035`, pero es el mismo contrato apareciendo en la ruta de deserialización. Si ves un fallo de deserialización que menciona un miembro required, al JSON le falta un campo que el tipo exige. Para la forma general de ese error, consulta [el valor JSON no se pudo convertir](/es/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/), y si necesitas lógica de construcción personalizada, [cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Un converter que construye el objeto por sí mismo esquiva la comprobación de miembros required, así que también es una vía de escape cuando un tipo que no controlas te da pelea.

- **La reflexión y `Activator.CreateInstance` saltan la comprobación por completo.** `required` lo aplica el compilador de C#, no el runtime. `Activator.CreateInstance(typeof(Person))` compila y se ejecuta, dejando los miembros de referencia required como `null`. Si un framework construye tus objetos mediante reflexión sin honrar `[SetsRequiredMembers]`, puedes terminar con un objeto "imposible" que el compilador nunca te habría dejado escribir a mano. Los ORM y serializadores que materializan objetos son los sospechosos habituales; comprueba si soportan miembros required antes de confiar en el modificador para esos tipos. Esto importa especialmente para las entidades, consulta [cómo usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/).

- **La herencia arrastra la obligación hacia abajo.** Si una clase base tiene un miembro `required`, cada tipo derivado también debe satisfacerlo en la construcción, y un constructor derivado que no lo establece necesita `[SetsRequiredMembers]` o deja el requisito al inicializador del llamador. Agregar `required` a un miembro base es un cambio que rompe el código fuente de todos los constructores en la jerarquía que dependían de que el miembro fuera opcional.

- **`init` frente a `set` no le importa a `required`.** `required` es ortogonal a la accesibilidad del setter. Puedes marcar un miembro `required` con `init` (establecible solo durante la construcción) o con un `set` normal. El modificador controla si el miembro debe asignarse; el accesor controla cuándo puede asignarse. Un patrón común es `public required string Name { get; init; }`: obligatorio de establecer, y solo en la construcción.

- **El miembro debe ser al menos tan accesible como el tipo.** Un miembro `required` tiene que poder establecerlo cualquier código que pueda construir el tipo. Un tipo `public` con un miembro `required` que tiene un accesor init `internal` produce un diagnóstico diferente (`CS9032`/`CS9033`), porque los llamadores externos podrían construir el tipo pero no satisfacer su requisito. Si estrechas el accesor de un miembro required, estrecha también el constructor o el tipo.

El modelo mental que hay que retener: `required` mueve una regla de "debes proporcionar esto" de una esperanza en tiempo de ejecución a una garantía en tiempo de compilación, y `CS9035` es esa garantía haciendo su trabajo. Cuando lo veas, la solución es siempre una de "proporciona el valor en el sitio de la llamada" o "dile al compilador que un constructor ya lo proporciona". Decide cuál es cierta para el tipo, luego completa el inicializador o agrega `[SetsRequiredMembers]`, y nunca recurras al atributo como una forma de silenciar el error sin establecer realmente el miembro.

## Relacionados

- [record vs class vs struct en C#: una matriz de decisión](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) para elegir la forma de tipo correcta antes de esparcir `required` por encima.
- [Cómo usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/) para cómo los miembros required interactúan con las entidades que el ORM materializa por reflexión.
- [Cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) para tomar el control de la construcción cuando el serializador por defecto pelea con tus miembros required.
- [Solución: el valor JSON no se pudo convertir](/es/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) para el lado de tiempo de ejecución del mismo contrato durante la deserialización.
- [Cómo declarar propiedades de extensión en C# 14](/es/2026/06/how-to-declare-extension-properties-in-csharp-14/) para más de lo que el modelo de propiedades de C# 14 puede y no puede expresar.

## Fuentes

- Microsoft Learn, [modificador required (referencia de C#)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) (semántica de `required`, el atributo `SetsRequiredMembers`, y la regla de que el compilador no verifica el cuerpo del constructor).
- Microsoft Learn, [Inicializadores de objetos y colecciones](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/object-and-collection-initializers) (cómo los miembros required deben establecerse a través de un inicializador o un constructor de atributo).
- GitHub, [dotnet/csharplang Discussion #6780](https://github.com/dotnet/csharplang/discussions/6780) (por qué se dispara `CS9035` para records que combinan un constructor primario con propiedades `required` explícitas).
