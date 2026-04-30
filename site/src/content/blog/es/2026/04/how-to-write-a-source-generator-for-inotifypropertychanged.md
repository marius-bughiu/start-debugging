---
title: "Cómo escribir un generador de código fuente para INotifyPropertyChanged"
description: "Una guía completa para construir tu propio generador de código fuente incremental para INotifyPropertyChanged en C# 14 y .NET 11: la pipeline IIncrementalGenerator, atributos marcadores, salida de partial class, el patrón SetProperty y cómo mantener la compatibilidad con AOT."
pubDate: 2026-04-30
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "source-generators"
  - "mvvm"
lang: "es"
translationOf: "2026/04/how-to-write-a-source-generator-for-inotifypropertychanged"
translatedBy: "claude"
translationDate: 2026-04-30
---

Para generar `INotifyPropertyChanged` (INPC) por tu cuenta, escribe un `IIncrementalGenerator` que encuentre clases marcadas con un atributo personalizado, lea sus campos anotados con `[ObservableProperty]` y emita una `partial class` que implemente la interfaz, exponga propiedades envoltorio y dispare `PropertyChanged` a través de un helper `SetProperty`. El generador se ejecuta en tiempo de compilación, aporta cero costo en runtime más allá del fontanería estándar de INPC y elimina cada línea de boilerplate manual de campo de respaldo y setter. Esta guía construye el generador de principio a fin sobre .NET 11 (preview 3) y C# 14, pero el mismo código funciona para cualquier consumidor que apunte a `netstandard2.0` para el analizador, ya que ese sigue siendo el contrato que Roslyn requiere para los generadores de código fuente.

## Por qué escribir el tuyo cuando existe CommunityToolkit.Mvvm

La respuesta conocida es `CommunityToolkit.Mvvm`, que incluye `[ObservableObject]`, `[ObservableProperty]`, `[NotifyPropertyChangedFor]` y una pequeña montaña de generadores bien probados. Para la mayoría de las aplicaciones, usa eso. Esta guía es para los casos en los que no puedes:

- Necesitas un generador que emita una interfaz diferente, como `IObservableObject` de un framework interno, o un contrato de notificación específico de un proveedor.
- Quieres combinar INPC con comportamiento extra que el toolkit no cubre (registro de auditoría, seguimiento de cambios sucios, coerción a través de una regla de dominio).
- Estás construyendo un artefacto de aprendizaje, un framework interno de la casa o un generador que tiene que convivir con `CommunityToolkit.Mvvm` sin colisionar en los nombres de atributos.
- Quieres entender el toolkit antes de confiar en él.

Los generadores de código fuente también son uno de los lugares más limpios para tocar las APIs de Roslyn de primera mano, e INPC es el objetivo canónico de "pequeño, bien definido, alto apalancamiento". Si nunca has escrito uno, este es un mejor punto de partida que intentar generar código de registro de inyección de dependencias o configuración de EF Core.

## Las piezas que necesitas entregar

Un generador INPC completo tiene tres partes, cada una en su propio proyecto o inyección `<None>`:

1. Un **atributo marcador** que los consumidores aplican a una `partial class`. Convención: `[Observable]` o `[GenerateInpc]`.
2. Un **atributo a nivel de campo** que marca el estado subyacente que el generador debe exponer como una propiedad. Convención: `[ObservableProperty]`.
3. El **generador incremental** en sí, empaquetado para que MSBuild lo cargue como un analizador.

El atributo marcador se entrega más fácilmente vía `RegisterPostInitializationOutput`, que permite al generador inyectar el código fuente del atributo en la compilación del consumidor. De esa manera, los consumidores agregan un `<ProjectReference>` (o un `<PackageReference>` con `OutputItemType="Analyzer"`) e inmediatamente tienen los atributos disponibles, sin necesidad de una DLL de runtime separada.

## Estructura del proyecto

El proyecto del analizador debe apuntar a `netstandard2.0`, porque ese es el único TFM que Roslyn carga en el IDE y en el MSBuild de .NET Framework que usan las instalaciones más antiguas de Visual Studio:

```xml
<!-- src/Inpc.SourceGenerator/Inpc.SourceGenerator.csproj -->
<!-- .NET 11 SDK, generator targets netstandard2.0 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <IsRoslynComponent>true</IsRoslynComponent>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp"
                      Version="4.13.0"
                      PrivateAssets="all" />
  </ItemGroup>
</Project>
```

`IsRoslynComponent` hace que Visual Studio lo trate como un generador para la carga en tiempo de diseño. `EnforceExtendedAnalyzerRules` es el conjunto de reglas estilo analizador que marca errores como `string.Format` con problemas de cultura dentro de generadores, donde la reproducibilidad importa.

El proyecto consumidor lo referencia como un analizador:

```xml
<!-- consumer .csproj -->
<ItemGroup>
  <ProjectReference Include="..\Inpc.SourceGenerator\Inpc.SourceGenerator.csproj"
                    OutputItemType="Analyzer"
                    ReferenceOutputAssembly="false" />
</ItemGroup>
```

`ReferenceOutputAssembly="false"` es crítico: **no** quieres la DLL del analizador en el path de runtime del consumidor. Si lo olvidas, el consumidor envía Roslyn en runtime, lo que son varios megabytes de peso muerto y rompe Native AOT.

## El atributo marcador, inyectado en post-init

Dentro del generador, registra la fuente del atributo antes de que se ejecute cualquier análisis. Esto garantiza que los consumidores puedan usar los atributos sin un paquete separado:

```csharp
// .NET 11, C# 14, generator-side code (netstandard2.0)
using Microsoft.CodeAnalysis;

[Generator]
public sealed class InpcGenerator : IIncrementalGenerator
{
    private const string AttributeSource = """
        // <auto-generated/>
        #nullable enable
        namespace Inpc;

        [global::System.AttributeUsage(
            global::System.AttributeTargets.Class, Inherited = false)]
        internal sealed class ObservableAttribute : global::System.Attribute { }

        [global::System.AttributeUsage(
            global::System.AttributeTargets.Field, Inherited = false)]
        internal sealed class ObservablePropertyAttribute : global::System.Attribute
        {
            public string? PropertyName { get; init; }
        }
        """;

    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        context.RegisterPostInitializationOutput(ctx =>
            ctx.AddSource("Inpc.Attributes.g.cs", AttributeSource));

        // pipeline registration follows in the next section
    }
}
```

Algunas decisiones no obvias:

- Los atributos son `internal`. Cada ensamblado consumidor obtiene su propia copia vía post-init. Eso significa que dos ensamblados pueden usar `[Observable]` sin juegos de `TypeForwardedTo` ni conflictos de versión. El costo es que los atributos no sobreviven a través de los límites de ensamblado, lo cual está bien porque el generador solo los necesita en tiempo de compilación.
- Cada referencia de tipo usa el prefijo `global::`. El código generado aterriza en espacios de nombres arbitrarios, incluyendo aquellos que se llaman `System` o `Inpc`. Sin `global::`, la resolución de nombres puede elegir el tipo equivocado y el archivo generado no compilará.
- El comentario de cabecera `// <auto-generated/>` suprime advertencias del analizador de reglas `EditorConfig` y StyleCop.

## La pipeline incremental

Ahora cablea el análisis real. La API de generador incremental de Roslyn tiene dos mitades: un `SyntaxProvider` que hace filtrado sintáctico barato en cada pulsación de tecla, y una transformación que hace el trabajo semántico costoso solo cuando cambia la instantánea sintáctica:

```csharp
// .NET 11, C# 14, generator-side
public void Initialize(IncrementalGeneratorInitializationContext context)
{
    context.RegisterPostInitializationOutput(ctx =>
        ctx.AddSource("Inpc.Attributes.g.cs", AttributeSource));

    var classes = context.SyntaxProvider
        .ForAttributeWithMetadataName(
            "Inpc.ObservableAttribute",
            predicate: static (node, _) => node is ClassDeclarationSyntax c
                && c.Modifiers.Any(SyntaxKind.PartialKeyword),
            transform: static (ctx, ct) => Extract(ctx, ct))
        .Where(static x => x is not null)
        .Select(static (x, _) => x!.Value);

    context.RegisterSourceOutput(classes,
        static (spc, model) => Emit(spc, model));
}
```

`ForAttributeWithMetadataName` es el punto de entrada correcto para cualquier generador dirigido por atributos desde Roslyn 4.3. Usa el índice de atributos del compilador, así que el `predicate` se ejecuta solo sobre sintaxis que ya tiene el nombre de atributo coincidente. Eso es dramáticamente más barato que el patrón antiguo `CreateSyntaxProvider` más `Where`, y es la mayor ganancia individual de rendimiento disponible.

El `predicate` aplica `partial` a nivel de sintaxis, antes de que exista cualquier modelo semántico. Esto atrapa el error más común del consumidor (olvidar `partial`) con la verificación más barata posible.

## Extracción de un modelo estable

La transformación debe devolver un valor que sea estructuralmente comparable. La capa de caché de Roslyn compara valores de modelo entre ejecuciones para saltar la reemisión cuando nada cambió. Si devuelves símbolos (`INamedTypeSymbol`, `IFieldSymbol`), cada pulsación de tecla invalida la caché, porque los símbolos son iguales por referencia solo dentro de una única compilación.

Usa un `record` (o `readonly record struct`) de strings simples:

```csharp
// .NET 11, C# 14, generator-side
internal readonly record struct ClassModel(
    string Namespace,
    string ClassName,
    EquatableArray<PropertyModel> Properties);

internal readonly record struct PropertyModel(
    string FieldName,
    string PropertyName,
    string TypeName);
```

`EquatableArray<T>` es una envoltura delgada alrededor de `ImmutableArray<T>` que implementa `Equals` estructural. Roslyn no entrega una, pero cada proyecto de generador copia las mismas seis líneas del toolkit:

```csharp
// .NET 11, C# 14, generator-side
internal readonly record struct EquatableArray<T>(ImmutableArray<T> Items)
    : IEnumerable<T> where T : IEquatable<T>
{
    public bool Equals(EquatableArray<T> other) =>
        Items.AsSpan().SequenceEqual(other.Items.AsSpan());

    public override int GetHashCode()
    {
        var hash = new HashCode();
        foreach (var item in Items) hash.Add(item);
        return hash.ToHashCode();
    }

    public IEnumerator<T> GetEnumerator() =>
        ((IEnumerable<T>)Items).GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() =>
        ((IEnumerable)Items).GetEnumerator();
}
```

Olvidar esto y devolver un `ImmutableArray<T>` puro es el segundo bug de rendimiento más común en generadores después de usar mal `CreateSyntaxProvider`. `ImmutableArray<T>.Equals` se basa en referencia, así que cada instantánea parece nueva.

La función `Extract` real saca campos del símbolo:

```csharp
// .NET 11, C# 14, generator-side
private static ClassModel? Extract(
    GeneratorAttributeSyntaxContext ctx,
    CancellationToken ct)
{
    if (ctx.TargetSymbol is not INamedTypeSymbol type) return null;

    var properties = ImmutableArray.CreateBuilder<PropertyModel>();
    foreach (var member in type.GetMembers())
    {
        ct.ThrowIfCancellationRequested();
        if (member is not IFieldSymbol field) continue;

        var attr = field.GetAttributes().FirstOrDefault(a =>
            a.AttributeClass?.ToDisplayString() == "Inpc.ObservablePropertyAttribute");
        if (attr is null) continue;

        string property = attr.NamedArguments
            .FirstOrDefault(kv => kv.Key == "PropertyName")
            .Value.Value as string
            ?? Capitalize(field.Name.TrimStart('_'));

        properties.Add(new PropertyModel(
            FieldName: field.Name,
            PropertyName: property,
            TypeName: field.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)));
    }

    return new ClassModel(
        Namespace: type.ContainingNamespace.IsGlobalNamespace
            ? string.Empty
            : type.ContainingNamespace.ToDisplayString(),
        ClassName: type.Name,
        Properties: new EquatableArray<PropertyModel>(properties.ToImmutable()));
}

private static string Capitalize(string name) =>
    name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];
```

`SymbolDisplayFormat.FullyQualifiedFormat` produce nombres del estilo `global::System.Collections.Generic.List<global::Foo.Bar>`, lo que esquiva cada problema de resolución de espacio de nombres con el que el archivo emitido pudiera tropezar.

`ct.ThrowIfCancellationRequested()` dentro del bucle importa más de lo que esperarías. El IDE cancela las ejecuciones del generador agresivamente mientras el usuario teclea; un generador que ignora el token bloquea IntelliSense.

## Emitir la partial class

El paso de emisión es un único recorrido de `StringBuilder`. Los generadores tienden a hacer crecer constructores basados en `Roslyn.SyntaxFactory` que se ven hermosos y corren lento; una plantilla de string está bien para código tan regular y es mucho más fácil de depurar:

```csharp
// .NET 11, C# 14, generator-side
private static void Emit(SourceProductionContext ctx, ClassModel model)
{
    var sb = new StringBuilder(1024);
    sb.AppendLine("// <auto-generated/>");
    sb.AppendLine("#nullable enable");
    if (model.Namespace.Length > 0)
    {
        sb.Append("namespace ").Append(model.Namespace).AppendLine(";");
        sb.AppendLine();
    }

    sb.Append("partial class ").Append(model.ClassName)
      .AppendLine(" : global::System.ComponentModel.INotifyPropertyChanged");
    sb.AppendLine("{");
    sb.AppendLine("    public event global::System.ComponentModel.PropertyChangedEventHandler? PropertyChanged;");
    sb.AppendLine();
    sb.AppendLine("    private bool SetProperty<T>(ref T storage, T value, string propertyName)");
    sb.AppendLine("    {");
    sb.AppendLine("        if (global::System.Collections.Generic.EqualityComparer<T>.Default.Equals(storage, value))");
    sb.AppendLine("            return false;");
    sb.AppendLine("        storage = value;");
    sb.AppendLine("        PropertyChanged?.Invoke(this,");
    sb.AppendLine("            new global::System.ComponentModel.PropertyChangedEventArgs(propertyName));");
    sb.AppendLine("        return true;");
    sb.AppendLine("    }");
    sb.AppendLine();

    foreach (var p in model.Properties)
    {
        sb.Append("    public ").Append(p.TypeName).Append(' ').Append(p.PropertyName)
          .AppendLine();
        sb.AppendLine("    {");
        sb.Append("        get => this.").Append(p.FieldName).AppendLine(";");
        sb.Append("        set => SetProperty(ref this.").Append(p.FieldName)
          .Append(", value, nameof(").Append(p.PropertyName).AppendLine("));");
        sb.AppendLine("    }");
        sb.AppendLine();
    }

    sb.AppendLine("}");

    string hint = string.IsNullOrEmpty(model.Namespace)
        ? $"{model.ClassName}.Inpc.g.cs"
        : $"{model.Namespace}.{model.ClassName}.Inpc.g.cs";
    ctx.AddSource(hint, sb.ToString());
}
```

Cosas que vale la pena notar:

- `SetProperty` asigna un nuevo `PropertyChangedEventArgs` por cambio. Eso es aceptable para cargas de trabajo de UI típicas. Si vinculas un flujo de alta frecuencia (estado de juego, datos de sensores) a INPC, almacena en caché un `PropertyChangedEventArgs` por propiedad en un campo estático; el `[ObservableProperty]` del toolkit hace esto cuando lo activas.
- El nombre de hint (primer argumento de `AddSource`) debe ser único dentro de la compilación. Incluir el espacio de nombres previene colisiones cuando dos clases en diferentes espacios de nombres comparten un nombre.
- `EqualityComparer<T>.Default` maneja `null` correctamente para tipos de referencia y es el comparador correcto también para propiedades de tipo valor. Usar `==` cortocircuitaría la igualdad definida por el usuario.

## Código del consumidor

El propósito de todo el ejercicio:

```csharp
// .NET 11, C# 14, consumer code
using Inpc;

[Observable]
public partial class PersonViewModel
{
    [ObservableProperty]
    private string _firstName = "";

    [ObservableProperty]
    private string _lastName = "";

    [ObservableProperty(PropertyName = "Age")]
    private int _ageYears;
}
```

El generador emite las propiedades públicas `FirstName`, `LastName` y `Age`, el evento `PropertyChanged` y el helper `SetProperty`. El archivo del consumidor permanece exactamente como se ve arriba, sin fontanería de `OnPropertyChanged` y sin campos de respaldo en lockstep.

## Native AOT y trimming

Los generadores se ejecutan en tiempo de compilación, así que no pagan nada en runtime. La pregunta interesante es qué cuesta el código *generado* en una aplicación AOT o recortada:

- `INotifyPropertyChanged` es reconocido por el trimmer como parte del contrato de data binding. La interfaz y el evento `PropertyChanged` no serán recortados de los tipos observables.
- `EqualityComparer<T>.Default` es totalmente compatible con trim y con AOT; sin reflexión.
- El constructor de `PropertyChangedEventArgs` no se recorta porque la firma del evento lo enraíza.

Lo que hay que vigilar es el binding XAML. WPF y Avalonia usan reflexión para descubrir propiedades INPC, así que las configuraciones de trim para esos frameworks ya excluyen los tipos de view-model observables del trimming vía descriptores. Los bindings compilados de MAUI eliminan esa necesidad por completo, y un generador como este se compone naturalmente con codegen estilo `[BindableProperty]` si quieres ambos mundos.

## Trampas, en orden de frecuencia

- **Olvidar `partial` en la clase**: el `predicate` lo filtra y no se genera nada. El consumidor ve un error de "definición no encontrada" o de interfaz sin implementar y asume que el generador está roto. Agrega un diagnóstico en la ruta del predicate que muestre un mensaje amistoso vía `RegisterSourceOutput` en una rama `Where(x => x is null)`.
- **Devolver símbolos desde la transformación**: mata la incrementalidad. Cada pulsación de tecla retransforma y reemite. El generador parece "lo bastante rápido" en una reproducción de una sola clase, luego se arrastra en una solución real.
- **Olvidar `global::` en los nombres de tipo emitidos**: un espacio de nombres del consumidor llamado `System.Foo` ensombrece a `System` y el archivo generado falla al compilar en ese único proyecto, sin error en el proyecto del generador en sí. Siempre califica completamente.
- **Emitir atributos en una DLL de runtime separada**: factible, pero la inyección post-init es más simple y evita cualquier riesgo de desviación de versión de NuGet entre el analizador y el contrato de runtime.
- **No manejar la convención del prefijo `_`**: `string _firstName` debería producir `FirstName`, no `_FirstName`. El paso `Capitalize(name.TrimStart('_'))` maneja la convención estándar; documenta cualquier convención que elijas.
- **Generar nombres de hint duplicados**: `AddSource("Class.g.cs", ...)` desde dos espacios de nombres colisiona. Siempre incluye el espacio de nombres en el hint.

Un generador construido así tiene alrededor de 200 líneas de código, se ejecuta en microsegundos por cambio y reemplaza cientos de líneas de boilerplate manual por consumidor. Una vez que has enviado uno, el siguiente (comandos, registro de inyección de dependencias, máquinas de estado) es una copia del mismo esqueleto.

## Relacionado

- [Cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) -- otro punto de extensión adyacente a Roslyn pequeño con trampas similares.
- [Cómo usar Channels en lugar de BlockingCollection en C#](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- patrones asíncronos que se componen con view-models.
- [Cómo usar Native AOT con ASP.NET Core minimal APIs](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) -- cómo trim y AOT ven tu código generado.
- [Cómo agregar un filtro de excepciones global en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) -- otro patrón emparejado a menudo con boilerplate generado.

## Fuentes

- MS Learn: [Source generators overview](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview)
- Roslyn cookbook: [Incremental generators](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.md)
- Roslyn API: [`IIncrementalGenerator`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.iincrementalgenerator), [`ForAttributeWithMetadataName`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.csharpgeneratorextensions.forattributewithmetadataname)
- CommunityToolkit.Mvvm reference implementation: [CommunityToolkit/dotnet on GitHub](https://github.com/CommunityToolkit/dotnet)
