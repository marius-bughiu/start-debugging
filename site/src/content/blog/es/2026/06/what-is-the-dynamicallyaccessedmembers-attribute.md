---
title: "¿Qué es el atributo DynamicallyAccessedMembers?"
description: "DynamicallyAccessedMembers le indica al trimmer de .NET y al compilador AOT cuáles miembros de un Type alcanzas por reflexión, para que se conserven en lugar de ser eliminados. Convierte una silenciosa MissingMethodException en runtime en una advertencia IL2070 en tiempo de compilación. Esto es lo que hace el atributo, cómo funciona el análisis de flujo de datos detrás de él y cómo anotar correctamente parámetros, campos y parámetros de tipo genéricos."
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "trimming"
  - "native-aot"
  - "csharp"
  - "dotnet-11"
lang: "es"
translationOf: "2026/06/what-is-the-dynamicallyaccessedmembers-attribute"
translatedBy: "claude"
translationDate: 2026-06-20
---

`[DynamicallyAccessedMembers]` es el atributo que pones sobre un `Type` (o el nombre de un tipo como `string`) para indicarle al trimmer de .NET y al compilador de Native AOT "voy a alcanzar estos miembros por reflexión, así que no los elimines." Es el contrato que permite al análisis estático seguir la reflexión que de otro modo no puede ver. Sin él, el trimmer elimina cualquier miembro que no pueda probar que es alcanzable, y tu `type.GetMethod("Run").Invoke(...)` lanza una `MissingMethodException` en runtime en la app publicada aunque funcionaba con `dotnet run`. Con él, el mismo código o compila limpio o te da una advertencia precisa en tiempo de compilación (`IL2070`, `IL2075`, `IL2077` y compañía) apuntando al lugar exacto donde un `Type` sin anotar fluye hacia una llamada de reflexión. El atributo vive en `System.Diagnostics.CodeAnalysis`, se distribuye en `System.Runtime.dll` y ha sido estable desde .NET 5. Todo lo que sigue apunta al SDK de .NET 11 (`11.0.100`) y C# 14, pero la mecánica aplica desde .NET 6 en adelante, donde se emitieron por primera vez las advertencias del análisis de trim.

## Por qué el trimmer necesita una pista en primer lugar

El trimming, y la compilación [Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) que lo requiere, funcionan mediante análisis de alcanzabilidad. El trimmer empieza en tu punto de entrada, recorre cada llamada a método, acceso a campo y referencia de tipo que puede ver estáticamente, marca todo lo que toca como "conservado" y elimina el resto. Así es como una app autónoma se reduce de 70 MB a 15 MB: el framework es enorme y tu app usa apenas una porción de él.

La reflexión rompe el recorrido. Cuando escribes `type.GetMethods()`, el trimmer no tiene idea de qué tipo contiene `type` en runtime, así que no puede saber qué métodos conservar. Tiene dos opciones: conservar cada método de cada tipo que pudiera fluir hacia esa llamada (lo que anula por completo el trimming), o no conservar nada y dejar que lo descubras en runtime. No hace ninguna de las dos. En cambio, los métodos del BCL que reflejan están anotados ellos mismos, y el trimmer exige que el `Type` que les pasas lleve una promesa equivalente. `[DynamicallyAccessedMembers]` es cómo haces esa promesa.

Mira la firma de `Type.GetMethods()` en el código fuente de .NET y verás que el método de instancia está anotado, en efecto, para requerir `PublicMethods` en `this`. Así que este inocente método auxiliar produce una advertencia:

```csharp
// .NET 11, C# 14. Compiled with <PublishTrimmed>true</PublishTrimmed>.
static void UseMethods(Type type)
{
    // warning IL2070: 'this' argument does not satisfy
    // 'DynamicallyAccessedMemberTypes.PublicMethods' in call to
    // 'System.Type.GetMethods()'. The parameter 'type' of method
    // 'UseMethods(Type)' does not have matching annotations.
    foreach (var method in type.GetMethods())
    {
        // ...
    }
}
```

El trimmer está diciendo: estoy a punto de dejarte enumerar los métodos públicos de lo que sea `type`, pero nadie prometió que esos métodos sobrevivirían al trimming. Anota el origen del `Type` para que la promesa esté en el sistema de tipos.

## La solución: declara el requisito en el parámetro

La solución es copiar el requisito en el parámetro que suministra el `Type`:

```csharp
// .NET 11, C# 14.
using System.Diagnostics.CodeAnalysis;

static void UseMethods(
    [DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)] Type type)
{
    foreach (var method in type.GetMethods()) // no warning
    {
        // ...
    }
}
```

Ahora `UseMethods` queda satisfecho internamente, pero el requisito no desaparece. Se traslada a quienes lo llaman. Cualquiera que llame a `UseMethods` debe pasarle un `Type` que se sepa, él mismo, que conserva sus métodos públicos. Ese es todo el modelo: el atributo no preserva nada por sí mismo. Es una anotación de flujo que empuja la obligación hacia arriba por la cadena de llamadas hasta que alcanza un punto donde el tipo concreto es conocido.

## Dónde termina realmente la obligación

El requisito deja de propagarse en uno de dos lugares. El primero es `typeof`. Cuando escribes `typeof(Customer)`, el trimmer conoce el tipo exacto y puede preservar lo que sea que el destino exija:

```csharp
// .NET 11. typeof gives the trimmer a concrete type, so it keeps
// Customer's public methods and the call is clean.
UseMethods(typeof(Customer));
```

El segundo es un límite de API pública. Si el `Type` viene de un parámetro, un campo o el valor de retorno de un método, anotas también esa ubicación, y la cadena continúa hacia afuera. Aquí está el caso del campo, que es el que la gente pasa por alto:

```csharp
// .NET 11, C# 14.
static Type _type = typeof(Customer);

static void UseMethodsHelper()
{
    // warning IL2077: 'type' argument does not satisfy
    // 'DynamicallyAccessedMemberTypes.PublicMethods' in call to 'UseMethods(Type)'.
    // The field '_type' does not have matching annotations.
    UseMethods(_type);
}
```

El campo no lleva ninguna promesa, así que pasarlo a un parámetro anotado genera una advertencia. Anota el campo, y ahora el trimmer hace cumplir la promesa en cada asignación a ese campo en su lugar:

```csharp
// .NET 11, C# 14.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
static Type _type = typeof(Customer); // assignment of a concrete type: clean

static void UseMethodsHelper() => UseMethods(_type); // clean
```

Asigna a ese campo anotado algo sobre lo que el trimmer no puede razonar (un parámetro `Type` sin anotar, un `Type.GetType("…")` a partir de un string en runtime) y obtienes una advertencia en la asignación. La promesa ahora es portante en ambas direcciones.

## Las banderas de DynamicallyAccessedMemberTypes

El único argumento del constructor es un enum `[Flags]`, así que combinas valores con `|` para conservar exactamente lo que tu reflexión toca y nada más. Los valores principales y sus banderas numéricas:

| Valor | Qué preserva |
| --- | --- |
| `None` | Nada. |
| `PublicParameterlessConstructor` | El constructor público por defecto (lo que `Activator.CreateInstance(type)` necesita). |
| `PublicConstructors` | Todos los constructores públicos. |
| `NonPublicConstructors` | Todos los constructores no públicos. |
| `PublicMethods` / `NonPublicMethods` | Métodos públicos / no públicos. |
| `PublicFields` / `NonPublicFields` | Campos públicos / no públicos. |
| `PublicProperties` / `NonPublicProperties` | Propiedades públicas / no públicas. |
| `PublicEvents` / `NonPublicEvents` | Eventos públicos / no públicos. |
| `PublicNestedTypes` / `NonPublicNestedTypes` | Tipos anidados. |
| `Interfaces` | Las interfaces que el tipo implementa. |
| `All` | Todo (valor `-1`). |

La regla es pedir el mínimo. Si todo lo que haces es `Activator.CreateInstance(type)`, solicita `PublicParameterlessConstructor`, no `All`. Cada bandera que agregas son miembros que el trimmer tiene prohibido eliminar, lo que es tamaño binario que pagas en la app final. `All` es la respuesta perezosa que silenciosamente deshace la mayor parte del beneficio del trimming para ese tipo.

.NET 9 y 10 agregaron una segunda familia de banderas `...WithInherited` y `All...`, por ejemplo `AllMethods`, `AllConstructors` y `NonPublicMethodsWithInherited`. La bandera simple `PublicMethods` ya incluye los métodos públicos heredados porque forman parte de la superficie pública del tipo, pero las variantes no públicas históricamente no recorrían las clases base. Las banderas `WithInherited` cierran esa brecha cuando reflejas sobre miembros privados o protegidos heredados. Recurre a ellas solo cuando tu reflexión realmente cruza el límite de herencia.

## Anotar parámetros de tipo genéricos y valores de retorno

El atributo no se limita a parámetros y campos. Su `AttributeUsage` cubre parámetros, campos, propiedades, valores de retorno, parámetros genéricos, clases, interfaces, structs y métodos. Dos de estos vale la pena destacarlos.

Un parámetro de tipo genérico puede llevar el requisito, que es como escribes una fábrica respaldada por reflexión que se mantiene segura para el trim:

```csharp
// .NET 11, C# 14.
using System.Diagnostics.CodeAnalysis;

static T Create<[DynamicallyAccessedMembers(
    DynamicallyAccessedMemberTypes.PublicParameterlessConstructor)] T>()
{
    return Activator.CreateInstance<T>(); // clean
}

// The constraint flows to the call site. typeof is implicit in the type argument.
var c = Create<Customer>(); // trimmer keeps Customer's parameterless ctor
```

Aplicar el atributo a un método es un caso especial documentado: se trata como si se aplicara al parámetro `this`, así que solo tiene sentido en métodos de instancia de un tipo asignable a `Type`. El target de valor de retorno permite que un método prometa algo sobre el `Type` que devuelve:

```csharp
// .NET 11, C# 14. The caller can reflect over public methods of the returned Type.
[return: DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
static Type ResolveHandler(string name) =>
    name == "customer" ? typeof(Customer) : typeof(Order);
```

## Cuando el patrón genuinamente no puede anotarse

A veces el flujo de datos es real y correcto pero el analizador no puede seguirlo, por ejemplo un `Type[]` donde sabes por construcción que cada elemento conserva su constructor pero el trimmer no puede ver esa invariante. Para estos casos, `[UnconditionalSuppressMessage]` silencia una advertencia específica y, a diferencia de `[SuppressMessage]`, se persiste en IL para que el análisis de trim lo respete:

```csharp
// .NET 11, C# 14.
[UnconditionalSuppressMessage("ReflectionAnalysis", "IL2063",
    Justification = "The array only ever holds types stored through the annotated setter.")]
get => _types[i];
```

Esta es una promesa que haces bajo tu palabra. La documentación es contundente en que solo es válido suprimir cuando los miembros sobre los que se refleja son objetivos genuinos de reflexión en otra parte del programa, porque los miembros que no son objetivos visibles de reflexión pueden ser insertados, renombrados o movidos por el optimizador, y tu código suprimido entonces fallará de una manera que ninguna advertencia predijo.

La otra vía de escape es `[DynamicDependency]`, que conserva miembros nombrados pero no informa al análisis. Es un último recurso para patrones que ni siquiera `[DynamicallyAccessedMembers]` puede expresar, como cargar un miembro por string desde un ensamblado separado:

```csharp
// .NET 11, C# 14.
[DynamicDependency("Helper", "MyType", "MyAssembly")]
static void RunHelper()
{
    var helper = Assembly.Load("MyAssembly").GetType("MyType").GetMethod("Helper");
    helper.Invoke(null, null);
}
```

Si te encuentras recurriendo a cualquiera de las dos vías de escape en muchos sitios de llamada, esa es la señal de que la API tiene una forma fundamentalmente basada en reflexión y debería reemplazarse con generación de código en tiempo de compilación. Los serializadores y mapeadores basados en reflexión son el ejemplo canónico: en lugar de anotar para sortear los recorridos de `GetProperties()`, adoptas un generador de código fuente que emite el código de acceso en tiempo de compilación. Si ese término es nuevo, [qué es un generador de código fuente y cuándo necesitas uno](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) es la introducción, y es la razón por la que existe el `System.Text.Json` generado por código fuente.

## Cómo se relaciona esto con RequiresUnreferencedCode

Es fácil confundir `[DynamicallyAccessedMembers]` con `[RequiresUnreferencedCode]`. Resuelven problemas adyacentes. `[DynamicallyAccessedMembers]` es para reflexión analizable: sabes exactamente cuáles miembros de un `Type` tocas, así que lo declaras y el trimmer los conserva. `[RequiresUnreferencedCode]` es para reflexión que no puede hacerse segura para el trim en absoluto, una admisión de que el método hace algo que el trimmer no puede modelar. Anotar un método con él no arregla nada; propaga una advertencia `IL2026` a cada quien lo llama, de la misma forma en que `[DynamicallyAccessedMembers]` propaga su requisito, hasta que la advertencia alcanza una API pública donde el autor de la biblioteca puede documentar la limitación. Usa `[DynamicallyAccessedMembers]` cuando puedas expresar el requisito y recurre a `[RequiresUnreferencedCode]` solo cuando genuinamente no puedas.

El flujo de trabajo práctico es el mismo que rige toda la historia del trimming y AOT: activa el analizador, trata cada advertencia `IL2xxx` como un defecto real en lugar de ruido, y lleva el conteo a cero antes de publicar. Configura `<IsTrimmable>true</IsTrimmable>` en una biblioteca para obtener advertencias acotadas a ese proyecto, o compila una pequeña app de prueba de trimming con `<PublishTrimmed>true</PublishTrimmed>` y una entrada `TrimmerRootAssembly` para ver cada advertencia a lo largo del grafo de dependencias. Una compilación limpia es el contrato. Cuando una llamada incompatible con AOT se cuela ante el analizador y solo falla en runtime, vuelves a depurar una [PlatformNotSupportedException en Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/), que es exactamente el fallo silencioso que estas anotaciones existen para prevenir. Y si estás conectando esto para un servicio web real, [cómo usar Native AOT con ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) recorre la receta de compilación limpia de principio a fin.

El modelo mental que hace encajar todo esto: `[DynamicallyAccessedMembers]` no preserva código. Propaga un requisito a lo largo del flujo de un valor `Type`, desde la llamada de reflexión de vuelta hasta donde sea que ese `Type` nació, y la preservación ocurre solo en el `typeof` o la asignación concreta donde el requisito finalmente aterriza. Haz bien ese flujo y el trimming deja de ser una fuente de misteriosos cierres inesperados solo-en-producción y se vuelve una característica del compilador en la que realmente puedes confiar.

## Relacionado

- [¿Qué es Native AOT y qué te cuesta?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) explica por qué el trimming es obligatorio bajo AOT y qué más resignas.
- [¿Qué es un generador de código fuente y cuándo necesito uno?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) cubre la generación de código en tiempo de compilación que reemplaza la reflexión que no puedes anotar.
- [Cómo usar Native AOT con ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) es el recorrido de compilación limpia donde estas advertencias aparecen en la práctica.
- [Solución: PlatformNotSupportedException en Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) es el fallo en runtime que una compilación anotada y libre de advertencias previene.

## Fuentes

- [DynamicallyAccessedMembersAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicallyaccessedmembersattribute), MS Learn (definición, targets de AttributeUsage, el caso especial método-es-this).
- [DynamicallyAccessedMemberTypes Enum](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicallyaccessedmembertypes), MS Learn (la lista completa de banderas incluyendo las adiciones WithInherited de .NET 9/10).
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming), MS Learn (ejemplos de IL2070/IL2077, UnconditionalSuppressMessage, DynamicDependency, recomendaciones).
- [Introduction to trim warnings](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/fixing-warnings), MS Learn (catálogo de advertencias y el modelo de flujo de datos).
