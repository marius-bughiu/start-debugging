---
title: "¿Qué es un generador de código fuente y cuándo lo necesito?"
description: "Una guía en lenguaje claro sobre los generadores de código fuente de C#: qué hacen en realidad, cómo funciona el pipeline de IIncrementalGenerator, cuándo superan a la reflexión o a T4, y los casos en que no deberías recurrir a uno. Con ejemplos ejecutables en .NET 11 y C# 14."
pubDate: 2026-06-19
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "source-generators"
  - "roslyn"
lang: "es"
translationOf: "2026/06/what-is-a-source-generator-and-when-do-i-need-one"
translatedBy: "claude"
translationDate: 2026-06-19
---

Un generador de código fuente es una pieza de código que el compilador de C# ejecuta mientras compila tu proyecto, y que puede leer tu código y agregar nuevos archivos C# a la misma compilación. Se ejecuta en tiempo de compilación, produce código fuente ordinario que luego el compilador compila como si lo hubieras escrito tú, y no agrega ningún costo en runtime más allá del código que emite. Lo necesitas cuando de otro modo pagarías reflexión en runtime, escribirías a mano código repetitivo, o ejecutarías un paso de generación de código aparte y fuera de banda, y quieres que el código generado tenga tipos fuertes, sea depurable, compatible con el recorte (trimming) y apto para Native AOT. Si no tienes alguno de esos problemas, casi con seguridad no necesitas escribir un generador. Esta guía cubre .NET 11 (preview 5) y C# 14, pero la mecánica aplica a cualquier proyecto en .NET 6 o posterior.

## Qué significa realmente "ejecutarse dentro del compilador"

La mayor parte del código que escribes se ejecuta después de la compilación, cuando la aplicación arranca. Un generador de código fuente es distinto: es un componente de Roslyn que el compilador carga como analizador e invoca durante la compilación. Obtiene una vista de solo lectura de todo lo que Roslyn sabe de tu proyecto hasta ese momento (árboles de sintaxis, símbolos semánticos, referencias, archivos adicionales) y su única salida es más código fuente. No puede reescribir tus archivos existentes, borrar código ni cambiar lo que ya escribiste. Solo puede agregar.

Esa restricción de "solo agregar" es todo el diseño. El código generado entra en la compilación como archivos adicionales, y el patrón dominante es el miembro `partial`: escribes la mitad de una clase a mano, la marcas como `partial` y el generador emite la otra mitad. Las dos mitades se compilan juntas en un solo tipo. Como la salida es C# real que se convierte en IL real, todo lo que está aguas abajo lo trata como código que escribiste tú: IntelliSense lo ve, el depurador entra en él, el linker puede recortarlo y Native AOT puede compilarlo de forma anticipada. No hay reflexión en runtime, ni `Reflection.Emit`, ni proxies dinámicos.

Este es el modelo mental clave. Un generador de código fuente no es un sistema de macros ni un script post-compilación. Es una función en tiempo de compilación que va de "tu código" a "más de tu código".

## Por qué supera a las alternativas que reemplaza

Antes de los generadores de código fuente (introducidos en .NET 5, Roslyn 3.8), las tres formas de evitar escribir código repetitivo a mano eran la reflexión, la emisión de IL y los generadores de código externos como las plantillas T4. Cada una tiene un costo real que un generador de código fuente elimina.

La reflexión en runtime (piensa en serializadores JSON clásicos, contenedores de inyección de dependencias, mappers de objetos) inspecciona los tipos al arrancar y o bien los interpreta en cada llamada, o bien construye un método dinámico una vez y lo cachea. Funciona, pero paga un impuesto de arranque, es invisible para el recortador (trimmer), así que infla las compilaciones recortadas y de AOT (o las rompe directamente), y el costo recae sobre tus usuarios, no sobre tu compilación. Una `System.InvalidOperationException` o una `System.PlatformNotSupportedException` de la reflexión solo aparece en runtime, a menudo en producción. Cubrimos exactamente ese modo de fallo en [por qué el código con mucha reflexión falla bajo Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/).

T4 y otros generadores externos se ejecutan como un paso aparte, normalmente conectado a la compilación con su propio tooling. No pueden ver el modelo semántico (parsean texto, no símbolos), los archivos generados quedan en disco y se desincronizan, y son incómodos en CI. Los generadores de código fuente se ejecutan dentro de la misma compilación, ven símbolos completamente resueltos y nunca escriben un archivo desactualizado en tu repositorio.

Un generador de código fuente mueve todo ese trabajo al tiempo de compilación y emite C# plano y compilado de forma estática. El serializador no reflexiona sobre tu tipo al arrancar; ya tiene el código exacto para leerlo y escribirlo. Por eso el generador de código fuente integrado de `System.Text.Json` es el único camino JSON que funciona bajo Native AOT, un punto que destacamos en [System.Text.Json vs Newtonsoft.Json en 2026](/es/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

## Los generadores que ya usas

No tienes que escribir uno para aprovechar el concepto. El .NET moderno trae varios, y reconocerlos te dice para qué tipo de problema son buenos los generadores:

- La generación de código fuente de `System.Text.Json` (`[JsonSerializable]` + un `JsonSerializerContext`) emite código de serialización para que STJ nunca reflexione en runtime.
- La generación de código fuente de `LoggerMessage` (`[LoggerMessage]`) convierte un método parcial en una llamada de log con tipos fuertes y sin asignaciones.
- `GeneratedRegex` (`[GeneratedRegex]`) compila tu patrón de expresión regular a C# en tiempo de compilación en lugar de construir una máquina de estados en el primer uso.
- `System.Text.Json`, `Microsoft.Extensions.Configuration` y el binder de opciones tienen generadores que reemplazan el binding basado en reflexión.
- `CommunityToolkit.Mvvm` genera la plomería de `INotifyPropertyChanged` a partir de `[ObservableProperty]`.
- `Mapperly` genera el mapeo de objeto a objeto en tiempo de compilación, la base de nuestra [migración de AutoMapper a mapeo generado por código fuente](/es/2026/05/migrate-from-automapper-to-source-generated-mapping/).

La forma compartida: tomar un marcador declarativo (un atributo, un método parcial, una clase parcial) y emitir el código tedioso, propenso a errores y con forma de reflexión que de otro modo se escribiría a mano o se descubriría en runtime.

## Cómo se construye un generador: el pipeline incremental

Hay dos interfaces de generador, y solo una es la vigente. La original `ISourceGenerator` (un par `Initialize`/`Execute` que recibía toda la compilación y se ejecutaba en cada pulsación de tecla) está obsoleta. El código fuente de Roslyn lo dice explícitamente: "ISourceGenerator is deprecated and should not be implemented. Please implement IIncrementalGenerator instead." (consulta la [nota de obsolescencia de ISourceGenerator en dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/ISourceGenerator.cs)). Para cualquier cosa nueva, usa `IIncrementalGenerator`.

La razón es el rendimiento en el IDE. Un generador incremental no recalcula todo desde cero en cada ejecución. Declaras un pipeline, un grafo de pasos de transformación, y Roslyn cachea la salida de cada paso. Si las entradas de un paso no han cambiado desde la última pulsación, Roslyn se salta ese paso y reutiliza el resultado cacheado. Eso es lo que hace que un generador sea seguro para reejecutarse cientos de veces por minuto mientras escribes.

Aquí tienes un generador mínimo pero completo. Encuentra las clases marcadas con `[AutoToString]` y emite un override de `ToString()` que lista las propiedades públicas.

```csharp
// Generator project: netstandard2.0, references Microsoft.CodeAnalysis.CSharp
// .NET 11 preview 5, Roslyn 4.x, C# 14
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

[Generator]
public sealed class AutoToStringGenerator : IIncrementalGenerator
{
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        // 1. Cheap syntactic filter, then a semantic transform into a small,
        //    value-equatable model. Returning a record (not a symbol) is what
        //    lets Roslyn cache this step and skip work when nothing changed.
        var classes = context.SyntaxProvider.ForAttributeWithMetadataName(
            "AutoToStringAttribute",
            predicate: static (node, _) => node is ClassDeclarationSyntax,
            transform: static (ctx, _) =>
            {
                var symbol = (INamedTypeSymbol)ctx.TargetSymbol;
                var props = symbol.GetMembers()
                    .OfType<IPropertySymbol>()
                    .Where(p => p.DeclaredAccessibility == Accessibility.Public)
                    .Select(p => p.Name)
                    .ToImmutableArray();
                return new Model(symbol.ContainingNamespace.ToDisplayString(),
                                 symbol.Name, props);
            });

        // 2. Emit one source file per matched class.
        context.RegisterSourceOutput(classes, static (spc, model) =>
        {
            var sb = new StringBuilder();
            sb.AppendLine($"namespace {model.Namespace};");
            sb.AppendLine($"partial class {model.Name}");
            sb.AppendLine("{");
            sb.AppendLine("    public override string ToString() =>");
            var body = string.Join(" + \", \" + ",
                model.Properties.Select(p => $"\"{p}=\" + {p}"));
            sb.AppendLine($"        {body};");
            sb.AppendLine("}");
            spc.AddSource($"{model.Name}.AutoToString.g.cs", sb.ToString());
        });
    }

    private record Model(string Namespace, string Name,
                         ImmutableArray<string> Properties);
}
```

El lado del consumidor es solo un atributo y una `partial class`:

```csharp
// Consumer project, C# 14
[AutoToString]
public partial class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
}

// Elsewhere: new Order { Id = 7, Customer = "Acme" }.ToString()
// => "Id=7, Customer=Acme"   (the ToString override is generated)
```

Dos detalles cargan con casi todo el peso. Primero, `ForAttributeWithMetadataName` es el punto de entrada rápido agregado en Roslyn 4.3: permite que Roslyn pre-filtre a los nodos que realmente llevan tu atributo en lugar de recorrer cada nodo de sintaxis, lo cual es la mayor palanca de rendimiento en un generador real. Segundo, el `transform` devuelve un `record` pequeño (`Model`), no el `INamedTypeSymbol`. Esto importa más de lo que parece: la incrementalidad depende de la igualdad por valor. Como dice el cookbook de Roslyn, quieres que por el pipeline fluyan tipos comparables por valor como `record`, `struct`, tuplas e `ImmutableArray<T>`, porque en el momento en que un paso devuelve un valor igual a su salida anterior, Roslyn se detiene y reutiliza el resultado cacheado aguas abajo. Pasa un `Symbol` o un `Compilation` por el pipeline y derrotas el cacheo por completo, porque esos tipos son grandes, comparables por referencia y cambian en cada pulsación.

## Cuándo deberías recurrir a uno

Escribe o adopta un generador de código fuente cuando todo esto sea cierto:

1. El código es mecánico y derivable de algo que ya está en el fuente (la forma de un tipo, un atributo, la firma de un método). Si un humano que lo escribiera solo estaría transcribiendo, un generador puede hacerlo.
2. Actualmente lo pagas con reflexión en runtime, y ese costo es real: latencia de arranque, asignaciones en una ruta caliente, o una incompatibilidad con el recorte o con AOT.
3. Quieres que el resultado sea depurable y con tipos estáticos, no un método dinámico en el que no puedes entrar a depurar.

Las victorias más claras: serialización, mapeo de DTO, registro de inyección de dependencias, `INotifyPropertyChanged`, binding de configuración con tipos fuertes, generación de clientes a partir de un contrato, y reemplazar cualquier ruta caliente con `Activator.CreateInstance` o `Expression.Compile`. Si apuntas a Native AOT, el cálculo se inclina aún más hacia los generadores, ya que los enfoques basados en reflexión son justo lo que se rompe ahí. Recorrimos esa restricción en [usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).

## Cuándo no necesitas uno (y no deberías escribirlo)

Los generadores no son gratis de construir ni de mantener. Sáltate escribir el tuyo cuando:

- Ya existe un generador bien probado. No reimplementes `CommunityToolkit.Mvvm`, Mapperly o el generador del contexto de STJ por diversión. Úsalos. El [recorrido del generador de INotifyPropertyChanged](/es/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) existe para enseñar la API de Roslyn, no para argumentar que deberías publicar tu propio toolkit de MVVM.
- La repetición es pequeña o de una sola vez. Un puñado de clases similares no es razón para asumir un proyecto de analizador en `netstandard2.0`, un harness de pruebas aparte y una historia de depuración que implica adjuntar un segundo compilador.
- En realidad necesitas transformar o reescribir código existente. Los generadores solo pueden agregar. Si quieres inyectar comportamiento en métodos que no escribiste, eso son los interceptores (una característica aparte de C# 14) o un weaver de IL post-compilación como Fody, no un generador de código fuente.
- La forma es genuinamente dinámica, decidida en runtime a partir de datos que el compilador no puede ver (un archivo de configuración leído al arrancar, un plugin cargado desde disco). El compilador no sabe nada del estado en runtime, así que un generador no puede ayudar.
- Un simple genérico `T`, una clase base o un método auxiliar plano bastarían. Recurre primero al lenguaje. Los generadores son para los casos en que el lenguaje no puede expresar la abstracción sin código repetitivo por cada tipo.

El valor por defecto honesto para la mayoría de los equipos es: consume generadores con liberalidad, escribe los tuyos rara vez.

## Los problemas que muerden primero

Algunas cosas hacen tropezar a todos la primera vez:

- El proyecto del generador debe apuntar a `netstandard2.0`. Ese sigue siendo el contrato que Roslyn requiere para los analizadores, sin importar a qué apunte tu aplicación. Estarás escribiendo el generador en una superficie de lenguaje más vieja que el código que emite.
- Referéncialo como analizador, no como dependencia normal: `<ProjectReference Include="..\Gen.csproj" OutputItemType="Analyzer" ReferenceOutputAssembly="false" />`. Si te equivocas en esto, o bien el generador no se ejecuta, o bien se filtra a tu salida de runtime.
- El código generado es aditivo y no puedes verlo por defecto. Pon `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` en el proyecto consumidor para volcar los archivos `.g.cs` bajo `obj/` y así poder leer lo que realmente se emitió. Esto es lo primero que hay que hacer cuando la salida se ve mal.
- No pongas `Compilation`, `ISymbol` ni `SyntaxNode` en el modelo de datos del pipeline. No son comparables por valor y matan la incrementalidad, lo que convierte tu generador de vuelta en el comportamiento lento de `ISourceGenerator` que intentabas evitar. Proyéctalos a records pronto.
- Nunca lances una excepción desde un generador. Una excepción se convierte en una advertencia de compilación (`CS8785`) y tu código silenciosamente no se genera. Maneja el caso de "atributo presente pero tipo mal formado" emitiendo un diagnóstico, no estrellándote.
- Un generador se ejecuta en cada compilación del proyecto consumidor, incluso en el IDE en cada edición. Un generador lento o no incremental hace que todo el editor se sienta lento. Esto no es teórico; es la razón por la que existe la API incremental.

El atajo mental que te mantiene fuera de problemas: un generador de código fuente es una función pura y cacheada que va de entradas inmutables a texto fuente. Mantén las entradas pequeñas y comparables por valor, mantén la función rápida, nunca dejes que lance excepciones, y solo escribe uno cuando la reflexión o el código repetitivo a mano te cueste algo que puedas medir.

## Fuentes y lecturas adicionales

- [Generadores incrementales, docs de dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.md)
- [Cookbook de generadores incrementales, dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.cookbook.md)
- [Nota de obsolescencia de ISourceGenerator, fuente de dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/ISourceGenerator.cs)
- [Resumen de generadores de código fuente, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview)
