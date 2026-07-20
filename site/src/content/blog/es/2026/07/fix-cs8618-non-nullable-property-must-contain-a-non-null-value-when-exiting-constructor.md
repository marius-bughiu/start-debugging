---
title: "Solución: CS8618 \"Non-nullable property must contain a non-null value when exiting constructor\" en C#"
description: "CS8618 significa que un campo o propiedad no anulable no se inicializó antes de que terminara el constructor. Asígnalo en el constructor, dale un valor por defecto, márcalo required o hazlo anulable."
pubDate: 2026-07-20
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "nullable"
lang: "es"
translationOf: "2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor"
translatedBy: "claude"
translationDate: 2026-07-20
---

`CS8618` se dispara cuando un miembro de referencia no anulable (un campo o una propiedad automática) no tiene garantizado un valor no nulo cuando el constructor termina. El compilador no puede probar que el miembro se asignó, así que advierte de que un `null` podría escaparse. Corrígelo de una de cuatro formas, en orden aproximado de preferencia: asígnalo en el constructor, dale un inicializador de campo, márcalo `required` para que quien construye deba asignarlo, o haz el miembro anulable (`string?`) si `null` es realmente válido. Esto está verificado con C# 14 en .NET 11; el diagnóstico se comporta así desde que los tipos de referencia anulables llegaron en C# 8, y .NET 6 fue la versión que activó el contexto anulable por defecto en los proyectos nuevos.

## El error en contexto

El compilador actual emite un único mensaje unificado para campos y propiedades:

```
warning CS8618: Non-nullable variable must contain a non-null value when exiting constructor. Consider declaring it as nullable.
```

Los SDK más antiguos (y muchos hilos de StackOverflow todavía abiertos) muestran las variantes específicas de campo y de propiedad, que es lo que mucha gente realmente escribe en el buscador:

```
warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor.
warning CS8618: Non-nullable field '_name' must contain a non-null value when exiting constructor.
```

Los tres son el mismo diagnóstico con la misma causa. Fíjate en la palabra *warning*, no *error*: `CS8618` no detiene la compilación por defecto. Se convierte en un error que rompe la compilación solo si tienes `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` o `<WarningsAsErrors>CS8618</WarningsAsErrors>` en tu proyecto, cosa que muchos equipos hacen precisamente para que los huecos de seguridad frente a null no puedan ignorarse.

## Por qué ocurre

Los tipos de referencia anulables, introducidos en C# 8 y activados por defecto en las plantillas desde .NET 6 (`<Nullable>enable</Nullable>` en el `.csproj`), dividen cada tipo de referencia en dos estados: no anulable (`string`) y anulable (`string?`). Un miembro no anulable es una promesa: "esto nunca será null." El trabajo del compilador es hacer que cumplas esa promesa, y el lugar donde más fácil puede comprobarlo es la construcción. Cuando un constructor retorna, cada campo y propiedad automática no anulable debe ser demostrablemente no nulo. Si el compilador no puede probarlo, obtienes `CS8618`.

La frase clave es "demostrablemente." El compilador hace análisis estático; no ejecuta tu código. Confía en exactamente tres cosas: un inicializador de campo o propiedad, una asignación directa dentro del constructor, y un método auxiliar anotado para decir que asigna el miembro. Un constructor que asigna el valor por algún camino que el compilador no puede seguir, o un miembro que un framework establece solo después, no cuenta para nada. Este es el mismo modelo de "probar, no mostrar" que hay detrás del [diagnóstico de miembro requerido CS9035](/es/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/): el compilador no deducirá tu intención a partir de los cuerpos de tus métodos.

Una trampa sutil: proteger con una comprobación de null dentro del constructor no ayuda. Código como `if (name is null) throw new ArgumentNullException(nameof(name));` prueba que el *parámetro* no es null, pero el compilador sigue viendo el *miembro* como no asignado a menos que realmente lo asignes. Esto sorprende a la gente con suficiente frecuencia como para tener su propio issue de Roslyn de larga data.

## Repro mínima

El tipo más pequeño que dispara `CS8618`, en un proyecto con el contexto anulable activado:

```csharp
// .NET 11, C# 14, <Nullable>enable</Nullable>
public class Person
{
    public string Name { get; set; }    // CS8618: never assigned
    public string Email { get; set; }   // CS8618: never assigned
    public int Age { get; set; }        // fine, value type has a default
}
```

Dos advertencias, una por cada propiedad de referencia no anulable. `Age` está en silencio porque los tipos de valor siempre tienen un valor por defecto (`0`); las advertencias de nulabilidad son sobre tipos de referencia. Agrega un constructor que solo establezca un miembro y todavía obtienes una advertencia:

```csharp
// .NET 11, C# 14
public class Person
{
    public Person(string name)
    {
        Name = name;      // Name is proven
    }

    public string Name { get; set; }
    public string Email { get; set; }   // CS8618: still not assigned on this path
}
```

El compilador comprueba cada constructor de forma independiente. Si cualquier constructor deja un miembro no anulable sin asignar, ese constructor produce la advertencia.

## La solución, en detalle

Recorre estas opciones en orden. Las tres primeras son las que quieres la mayor parte del tiempo; las dos últimas son válvulas de escape para cuando el miembro realmente se inicializa en algún lugar que el compilador no puede ver.

### 1. Inicializa el miembro en un constructor

Si el valor es necesario para construir un objeto válido, tómalo como parámetro del constructor y asígnalo. Este es el diseño hacia el que te empuja la advertencia:

```csharp
// .NET 11, C# 14
public class Person
{
    public Person(string name, string email)
    {
        Name = name;
        Email = email;
    }

    public string Name { get; set; }
    public string Email { get; set; }
}
```

Ambos miembros ahora están demostrablemente asignados en cada camino de construcción, así que ambas advertencias desaparecen. Si tienes varios constructores, canalízalos a través de uno solo para que la asignación viva en un único lugar: `public Person() : this("John", "Doe") { }` satisface al compilador porque el constructor encadenado hace el trabajo.

### 2. Dale al miembro un valor por defecto con un inicializador de campo

Cuando hay un valor por defecto sensato y no quieres forzar a cada llamante a pasar el valor, inicializa el miembro donde se declara:

```csharp
// .NET 11, C# 14
public class Person
{
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
}
```

Un inicializador de campo se ejecuta antes que el cuerpo de cualquier constructor, así que el miembro es no nulo en cada camino automáticamente. Esta es la solución más limpia para valores más o menos opcionales como cadenas vacías o colecciones `new List<string>()`. También es mejor que hacer el tipo anulable si el miembro nunca debería ser null en tiempo de ejecución, porque mantiene el contrato de no nulo para todo el que lea la propiedad.

### 3. Marca el miembro como `required` (C# 11 y posteriores)

Si el miembro es obligatorio pero no quieres un parámetro de constructor para él, usa el modificador `required`. Mueve la obligación al inicializador de objeto del llamante y, como bono, silencia `CS8618`, porque el compilador ahora sabe que el miembro debe establecerse antes de que el objeto se escape:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; set; }
    public required string Email { get; set; }
}

// the caller is now forced to set both
var p = new Person { Name = "Ada", Email = "ada@example.com" };
```

Esta suele ser la mejor respuesta moderna para DTO y objetos de configuración: sin constructor de relleno, sin valor por defecto falso, y la garantía de no nulo se aplica en cada punto de llamada. La contrapartida es que omitir un valor se convierte en un error de compilación (`CS9035`) en el punto de llamada en lugar de una advertencia sobre el tipo. Si recurres a esto, lee el artículo complementario sobre [CS9035 y los miembros required](/es/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) para saber cómo se ve el error del lado del llamante.

### 4. Haz el miembro anulable si `null` es un estado válido

Si el miembro realmente puede estar ausente, debería ser `string?`, no `string`. Agregar el `?` le dice al compilador y a cada lector que este valor podría ser null, lo cual es honesto y mueve la comprobación de null a donde se consume el valor:

```csharp
// .NET 11, C# 14
public class Person
{
    public string Name { get; set; } = string.Empty;
    public string? MiddleName { get; set; }   // legitimately optional
}
```

No recurras a esto solo para silenciar la advertencia sobre un miembro que nunca es realmente null. Marcar un miembro como anulable cuando en la práctica siempre está establecido empuja comprobaciones de null fantasma (u operadores `!` de perdón de null) sobre cada consumidor. Reserva `?` para valores que sean realmente opcionales.

### 5. Anota un método auxiliar con `[MemberNotNull]`, o usa `null!` para miembros inicializados por un framework

A veces el miembro está inicializado, solo que no en algún lugar que el compilador siga. Dos herramientas cubren esto.

Si un método privado compartido hace la inicialización, díselo al compilador con `[MemberNotNull]`:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public class Student
{
    public string Major { get; set; }

    public Student() => SetMajor();

    [MemberNotNull(nameof(Major))]
    private void SetMajor(string? major = null) => Major = major ?? "Undeclared";
}
```

`[MemberNotNull]` afirma que después de que el método retorna, el miembro nombrado no es null, así que un constructor que lo llama se considera que ha asignado el miembro. Como `[SetsRequiredMembers]`, esta es una promesa que el compilador cree sin verificar, así que mantenla honesta.

El otro caso es un miembro que un framework establece por reflexión, el clásico siendo un `DbSet` de EF Core. El `DbContext` base los rellena, pero el compilador no puede verlo, así que el idioma es inicializar a `null!`:

```csharp
// .NET 11, EF Core 11
public class TodoContext : DbContext
{
    public TodoContext(DbContextOptions<TodoContext> options) : base(options) { }

    public DbSet<TodoItem> TodoItems { get; set; } = null!;
}
```

El `null!` dice "asume que esto no es null; sé que se establece en otro lugar." Es una supresión dirigida, no una solución, así que úsalo solo cuando algo fuera de tu constructor realmente hace la inicialización. Este patrón aparece por todo el código de EF Core; el mismo razonamiento aplica a las entidades que el ORM materializa, cubierto en [cómo usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/).

## Trampas y variantes

Un puñado de situaciones producen `CS8618`, o algo adyacente, por razones que el mensaje no detalla:

- **Una comprobación de null sobre el parámetro no asigna el miembro.** Lanzar `ArgumentNullException` cuando un parámetro es null prueba que el parámetro no es null pero deja el miembro sin asignar en el modelo del compilador. Todavía tienes que escribir `Name = name;`. Valida y asigna; validar por sí solo no basta.

- **La construcción por defecto de un `struct` sortea tu constructor.** Para un `struct`, el valor por defecto sin parámetros (`default(MyStruct)` o `new MyStruct()` cuando no se ejecuta un constructor sin parámetros explícito) inicializa a cero cada campo, dejando los campos de referencia no anulables como `null` sin advertencia en el sitio de `default`. El compilador advierte sobre los constructores declarados de tu struct, pero no puede impedir que un llamante obtenga una instancia en cero. No confíes en `required` ni en un constructor para garantizar campos no nulos en un struct; un valor `default` esquiva ambos.

- **La reflexión y los serializadores construyen objetos sin tu constructor.** `Activator.CreateInstance`, `System.Text.Json` y los ORM pueden construir un objeto sin ejecutar el constructor que habría asignado tus miembros, así que un miembro que el compilador probó no nulo todavía puede ser `null` en tiempo de ejecución. Si usas `required`, ten en cuenta que `System.Text.Json` respeta los miembros required desde .NET 8 y lanzará una `JsonException` cuando el JSON omita uno, que es la mitad en tiempo de ejecución del mismo contrato. Cuando necesitas control total sobre cómo se construye un tipo desde JSON, [un JsonConverter personalizado](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) toma el control de la construcción por completo.

- **Propiedades respaldadas por campo y la palabra clave `field`.** Con una propiedad automática normal, el campo de respaldo es lo que el análisis rastrea. Si usas la palabra clave `field` de C# 14 para agregar lógica a un accesor, la misma regla aplica al campo de respaldo sintetizado por el compilador: debe ser no nulo cuando el constructor termina, así que inicialízalo igual que cualquier otro miembro.

- **`= default!` frente a `= null!`.** Para miembros de referencia significan lo mismo (`default` para un tipo de referencia es `null`), y ambos silencian la advertencia. Prefiere `null!` para miembros de referencia porque se lee como "intencionalmente null por ahora," y reserva `default!` para miembros genéricos donde el parámetro de tipo podría ser un tipo de valor.

- **Apagar todo casi nunca es la solución.** Puedes reducir el alcance del contexto anulable con `#nullable disable` alrededor de un archivo o región, pero eso descarta el análisis de seguridad frente a null para todo lo que hay dentro, no solo para ese miembro. Si quieres silenciar un único miembro que sabes que está bien, `null!` sobre ese miembro es mucho más dirigido que deshabilitar el contexto. Un `#nullable disable` de archivo completo es una herramienta de migración, no una solución.

El modelo mental a mantener: `CS8618` es el compilador haciendo cumplir la promesa que hace un miembro no anulable. Cuando lo veas, decide qué es realmente cierto y actúa en consecuencia. El miembro es obligatorio (asígnalo en un constructor, o márcalo `required`), tiene un valor por defecto razonable (dale un inicializador de campo), es realmente opcional (hazlo `string?`), o lo inicializa código que el compilador no puede ver (`[MemberNotNull]` o `null!`). Recurrir a `null!` sobre un miembro que se supone que un llamante debe establecer solo mueve una advertencia en tiempo de compilación a una `NullReferenceException` en tiempo de ejecución, que es exactamente el bug que los tipos de referencia anulables existen para prevenir.

## Relacionados

- [Solución: CS9035 "Required member 'X' must be set in the object initializer"](/es/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) para el error del lado del llamante que obtienes una vez que marcas un miembro como `required`.
- [record vs class vs struct en C#: una matriz de decisión](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) para elegir la forma del tipo antes de decidir cómo se inicializan los miembros.
- [Cómo usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/) para el idioma del DbSet `null!` y los miembros que el ORM materializa por reflexión.
- [Cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) para tomar el control de la construcción cuando la serialización sortea tu constructor.
- [Asignación condicional de null en C# 14](/es/2026/02/csharp-14-null-conditional-assignment/) para más sobre cómo C# razona acerca de null en el código cotidiano.

## Fuentes

- Microsoft Learn, [Nullable reference type warnings (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) (texto exacto de `CS8618`, la sección "nonnullable reference not initialized" y las cuatro técnicas de solución, incluyendo `[MemberNotNull]` y `null!`).
- Microsoft Learn, [required modifier (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) (cómo `required` mueve la obligación al llamante y satisface la comprobación de no nulo).
- Microsoft Learn, [Working with nullable reference types in EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/nullable-reference-types) (el patrón `DbSet` = `null!` y por qué el compilador no puede ver la inicialización de la clase base).
- GitHub, [dotnet/roslyn Issue #60283](https://github.com/dotnet/roslyn/issues/60283) (por qué una comprobación de null en el constructor no limpia `CS8618`).
