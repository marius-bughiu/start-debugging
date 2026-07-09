---
title: "¿Qué es el código seguro para trimming y cómo lo escribo?"
description: "El código seguro para trimming es código que el trimmer de .NET puede probar estáticamente que es alcanzable, así que sobrevive cuando se elimina el código sin usar de una app autónoma. Esta es la guía práctica: enciende el analizador, lleva a cero cada advertencia IL2xxx, anota la reflexión con DynamicallyAccessedMembers, propaga RequiresUnreferencedCode a las APIs públicas y reemplaza los patrones no analizables con generadores de código fuente."
pubDate: 2026-07-09
tags:
  - "dotnet"
  - "trimming"
  - "native-aot"
  - "csharp"
  - "dotnet-11"
lang: "es"
translationOf: "2026/07/what-is-trim-safe-code-and-how-do-i-write-it"
translatedBy: "claude"
translationDate: 2026-07-09
---

El código seguro para trimming es código que el trimmer de .NET puede probar estáticamente que es alcanzable, así que no se elimina cuando publicas una app autónoma con trimming, y código que no rompe silenciosamente la app cuando se eliminan los miembros sin usar a su alrededor. En concreto, significa que tu proyecto compila limpio bajo el análisis de trimming: cero `IL2026`, `IL3050`, `IL2070` y compañía. Haces que el código sea seguro para trimming encendiendo el analizador y luego trabajando la lista de advertencias hasta cero: anota la reflexión que puedas expresar (`[DynamicallyAccessedMembers]`), pon en cuarentena la reflexión que no puedas detrás de `[RequiresUnreferencedCode]` y súbela hasta una API pública, y reemplaza los patrones que resisten ambas cosas con un generador de código fuente. Una compilación de análisis limpia es el contrato; si no puedes llegar a cero, la app no es segura para trimming y el trimming producirá fallos que solo aparecen en producción y que nunca se vieron en `dotnet run`.

Todo lo que sigue apunta al SDK de .NET 11 (`11.0.100`) y C# 14, pero las advertencias del análisis de trimming existen desde .NET 6, así que la mecánica aplica desde `net6.0` en adelante. El SDK de .NET 8 o posterior es el mínimo práctico para trabajar en bibliotecas, porque ahí es donde se estabilizaron el analizador y la historia de compatibilidad con AOT.

## Por qué el trimmer necesita que tu código coopere

El trimming funciona mediante análisis de alcanzabilidad. El trimmer (internamente `ILLink`) parte de tu punto de entrada, recorre cada llamada a método, acceso a campo y referencia de tipo que puede ver estáticamente, marca como conservado cada cosa que toca y elimina todo lo demás. Así es como una app autónoma se reduce de decenas de megabytes a una fracción: el framework es enorme, tu app usa una porción mínima y el resto se va. Desde .NET 6 la granularidad por defecto es a nivel de miembro (`TrimMode=full`), no el antiguo comportamiento a nivel de ensamblado `copyused`, así que el trimmer elimina métodos y tipos individuales sin usar, no solo ensamblados completos sin referenciar. Eso es más agresivo, y más propenso a eliminar algo que sí alcanzas de una forma que el análisis no pudo ver.

Lo que el análisis no puede ver es la reflexión. Cuando escribes `type.GetMethods()` o `Activator.CreateInstance(someType)`, el trimmer no tiene idea de qué tipo concreto fluye en tiempo de ejecución, así que no puede saber qué miembros conservar. Tiene dos malas opciones: conservar todo lo que podría posiblemente fluir ahí (lo que echa por tierra el trimming) o no conservar nada y dejar que lo descubras en tiempo de ejecución con una `MissingMethodException`. No hace ninguna de las dos. En cambio, exige que el código reflexivo lleve anotaciones que describan exactamente lo que toca, y advierte donde sea que un valor sin anotar fluya hacia una llamada de reflexión. El código seguro para trimming es código que satisface esas exigencias. Las mismas reglas gobiernan la [compilación Native AOT, que hace el trimming obligatorio](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/), así que todo lo de abajo es también el precio de entrada para AOT.

## Paso uno: enciende el analizador

No puedes corregir advertencias que no puedes ver, y por defecto una compilación normal no muestra ninguna. Hay dos maneras de sacarlas a la luz, y la documentación recomienda usar ambas porque detectan cosas distintas.

Para una aplicación que vas a publicar con trimming, define `PublishTrimmed` en el archivo del proyecto (no solo en la línea de comandos, para que también aplique durante `dotnet build`):

```xml
<!-- .NET 11, C# 14. App project. Turns on the trimmer at publish and
     the trim-compat Roslyn analyzer during every build. -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

Para una biblioteca, no la publicas, así que en su lugar habilitas el análisis con alcance de proyecto. `<IsTrimmable>true</IsTrimmable>` marca el ensamblado como compatible con trimming y enciende las advertencias para ese proyecto:

```xml
<!-- .NET 11, C# 14. Library project. Marks the assembly trimmable and
     emits trim warnings for this project's own code. -->
<PropertyGroup>
  <IsTrimmable>true</IsTrimmable>
</PropertyGroup>
```

Aquí importan dos matices. Primero, si quieres las advertencias sin prometer que el ensamblado es seguro para trimming (digamos, mientras todavía las estás resolviendo), usa `<EnableTrimAnalyzer>true</EnableTrimAnalyzer>` en lugar de `IsTrimmable`. Emite el mismo análisis sin estampar el ensamblado como apto para trimming. Segundo, `IsTrimmable` toma el valor `true` por defecto cuando defines `<IsAotCompatible>true</IsAotCompatible>`, así que una biblioteca compatible con AOT obtiene análisis de trimming lo hayas pedido por separado o no.

El detalle con el análisis de biblioteca con alcance de proyecto es que solo ve tu código más los ensamblados de referencia de tus dependencias, y los ensamblados de referencia no llevan suficiente información para que el trimmer los juzgue. Para ver cada advertencia, incluidas las que vienen de cómo tu biblioteca usa sus dependencias, compila una pequeña app de prueba de trimming: un proyecto de consola que referencia tu biblioteca, define `<PublishTrimmed>true</PublishTrimmed>` y toma tu biblioteca como raíz para que todo se analice:

```xml
<!-- .NET 11. Trimming test app. Roots the library so ILLink walks every
     code path in it, not just the ones the console Main reaches. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\MyLibrary\MyLibrary.csproj" />
    <TrimmerRootAssembly Include="MyLibrary" />
  </ItemGroup>
</Project>
```

Luego `dotnet publish -c Release -r linux-x64` y lee las advertencias. `TrimmerRootAssembly` es lo que marca la diferencia: sin él, el trimmer solo analiza las llamadas que tu `Main` realmente alcanza; con él, trata la biblioteca completa como una raíz y recorre cada camino.

## Leer las advertencias que significan "todavía no es seguro para trimming"

Cuatro familias de advertencias cubren casi todo lo que te vas a encontrar. Saber cuál es cuál te dice la corrección.

`IL2026` (`RequiresUnreferencedCode`) significa que llamaste a un método que alguien ya declaró incompatible con trimming. `IL3050` (`RequiresDynamicCode`) es el hermano exclusivo de AOT: el método necesita generación de código en tiempo de ejecución que el JIT proveería pero AOT no puede. `IL2070`, `IL2075`, `IL2077` y el resto de la banda `IL207x` son advertencias de flujo de datos: un `Type` sin anotar (de un parámetro, un campo, un valor de retorno) fluyó hacia una llamada de reflexión que requiere una promesa `[DynamicallyAccessedMembers]`, y nadie hizo la promesa. Trata cada una de estas como un defecto real, no como ruido del analizador. El punto entero del analizador es convertir una `MissingMethodException` silenciosa, exclusiva de la publicación, a veces exclusiva de producción, en una advertencia en tiempo de compilación que apunta a la línea exacta.

Un consejo de lectura. En .NET 6+ el trimmer colapsa todas las advertencias internas de un ensamblado `PackageReference` en una sola advertencia por ensamblado, para que no te ahogues en ruido de una dependencia que no controlas. Cuando de verdad quieras verlas todas (estás tratando de decidir si una dependencia es arreglable), define `<TrimmerSingleWarn>false</TrimmerSingleWarn>` para expandirlas.

## Corregir IL207x: anota la reflexión que puedes expresar

Las advertencias de flujo de datos son las que corriges en tu propio código, y la corrección siempre tiene la misma forma: declara el requisito en el lugar de donde viene el `Type`, para que la promesa viva en el sistema de tipos. Toma este helper, que advierte porque `GetMethods()` requiere que el tipo conserve sus métodos públicos y el parámetro no promete nada:

```csharp
// .NET 11, C# 14. Warns IL2070: 'type' has no matching annotation.
using System.Diagnostics.CodeAnalysis;

static void UseMethods(Type type)
{
    foreach (var m in type.GetMethods()) { /* ... */ }
}
```

Copia el requisito al parámetro:

```csharp
// .NET 11, C# 14. Clean: the parameter now carries the promise.
static void UseMethods(
    [DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)] Type type)
{
    foreach (var m in type.GetMethods()) { /* ... */ }
}
```

El requisito no desaparece, se mueve a los llamadores, y sigue propagándose hacia afuera hasta que aterriza en un `typeof(Customer)` o un argumento de tipo concreto, donde el trimmer por fin sabe exactamente qué conservar. Pide el mínimo: si todo lo que haces es `Activator.CreateInstance(type)`, solicita `PublicParameterlessConstructor`, no `All`. Cada bandera que agregas son miembros que el trimmer tiene prohibido eliminar, que es tamaño binario que pagas. El modelo de flujo completo, incluyendo cómo anotar campos, parámetros de tipo genéricos y valores de retorno, está cubierto en [el análisis a fondo de DynamicallyAccessedMembers](/es/2026/06/what-is-the-dynamicallyaccessedmembers-attribute/); el resumen de una línea es que el atributo no preserva nada por sí mismo, propaga una obligación hasta donde nace el tipo concreto.

## Corregir IL2026: pon en cuarentena la reflexión que no puedes expresar

A veces la reflexión genuinamente no es analizable. Cargas un tipo por cadena desde la configuración, o recorres `GetProperties()` sobre un objeto cuyo tipo no se conoce hasta el tiempo de ejecución. No puedes anotar tu salida de eso, así que declaras el método incompatible con trimming con `[RequiresUnreferencedCode]` y dejas que la advertencia se propague:

```csharp
// .NET 11, C# 14. Honest: this method reflects in a way trimming can break.
[RequiresUnreferencedCode("Serializes arbitrary types via reflection over their properties.")]
static string Serialize(object value)
{
    var sb = new StringBuilder();
    foreach (var p in value.GetType().GetProperties())
        sb.Append(p.Name).Append('=').Append(p.GetValue(value)).Append(';');
    return sb.ToString();
}
```

El atributo no corrige nada. Mueve la advertencia `IL2026` a cada llamador de `Serialize`, de la misma forma que `[DynamicallyAccessedMembers]` mueve su requisito, hasta que alcanza una frontera de API pública donde el autor de la biblioteca documenta la limitación y detiene la propagación. Este es el resultado correcto para el código que de verdad no es seguro para trimming: en lugar de un fallo silencioso en tiempo de ejecución, el llamador obtiene una advertencia en tiempo de compilación que le dice que este camino es inseguro bajo trimming, y puede decidir si lo evita. Es también por lo que propagar limpiamente a las APIs públicas importa, ya que suprime la genérica `IL2104: Assembly produced trim warnings` y da a los consumidores señales precisas por método.

Si el patrón es mayormente reflexión, no anotes tu salida rodeándolo llamada por llamada. Esa es la señal para reemplazarlo con generación de código en tiempo de compilación. Los serializadores y mapeadores basados en reflexión son el ejemplo canónico: en lugar de anotar un recorrido con `GetProperties()`, adoptas un [generador de código fuente](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) que emite el código de acceso en tiempo de compilación, que es exactamente por lo que existe `System.Text.Json` con generación de código fuente y por lo que es el camino recomendado para AOT.

## Las vías de escape, y cuándo son una trampa

Dos atributos te dejan silenciar advertencias sin cambiar el código, y ambos son filosos.

`[UnconditionalSuppressMessage]` silencia una advertencia específica y, a diferencia del `[SuppressMessage]` simple, se persiste en IL para que el análisis de trimming lo respete. Úsalo solo cuando el flujo de datos es real y correcto pero el analizador no puede seguirlo, por ejemplo un `Type[]` de cuyos elementos sabes que cada uno conserva su constructor por construcción:

```csharp
// .NET 11, C# 14. Valid only because the setter guarantees the invariant.
[UnconditionalSuppressMessage("ReflectionAnalysis", "IL2063",
    Justification = "The array only holds types stored through the annotated setter.")]
get => _types[i];
```

La documentación es tajante sobre el modo de fallo: solo es válido suprimir cuando los miembros sobre los que se reflexiona son objetivos genuinos de reflexión en otra parte del programa. Un miembro que se usa de forma no reflexiva (una llamada a método normal) no es un objetivo de supresión válido, porque el optimizador es libre de hacerle inline, renombrarlo o moverlo, y tu reflexión suprimida entonces se rompe sin advertencia que te advierta. Suprimir "la propiedad la usa la app así que debe estar ahí" es exactamente el patrón inválido que la documentación señala.

`[DynamicDependency]` es el último recurso. Conserva miembros nombrados pero no informa al análisis, así que no silencia advertencias por sí mismo y se usa junto con una supresión. Recurre a él solo para patrones que ni siquiera `[DynamicallyAccessedMembers]` puede expresar, como cargar un miembro por cadena desde un ensamblado separado:

```csharp
// .NET 11, C# 14. Last resort. Keeps Helper so the reflection below finds it.
[DynamicDependency("Helper", "MyType", "MyAssembly")]
static void RunHelper()
{
    var helper = Assembly.Load("MyAssembly").GetType("MyType").GetMethod("Helper");
    helper.Invoke(null, null);
}
```

Si te encuentras esparciendo cualquiera de los dos atributos por muchos sitios de llamada, eso no es una corrección de seguridad para trimming, es un olor de diseño que te dice que la API tiene forma fundamentalmente reflexiva y debería regenerarse en tiempo de compilación en su lugar.

## Interruptores de característica del framework: recortar código que nunca llamas

No toda la seguridad para trimming se trata de tu reflexión. Una parte del framework viene con directivas de trimmer detrás de interruptores de característica, así que puedes decirle al trimmer que elimine áreas de característica completas que no usas. Estas funcionan a la vez como configuración en tiempo de ejecución y como instrucciones de trimming. Unas cuantas que vale la pena conocer: `<EventSourceSupport>false</EventSourceSupport>` descarta la maquinaria de EventSource, `<UseSystemResourceKeys>true</UseSystemResourceKeys>` reduce el texto completo de los mensajes de excepción de los ensamblados `System.*` a IDs de recursos, `<InvariantGlobalization>true</InvariantGlobalization>` elimina los datos de globalización, y `<StackTraceSupport>false</StackTraceSupport>` (.NET 8+) elimina la generación de trazas de pila en tiempo de ejecución. .NET 10 agregó `<UseSizeOptimizedLinq>true</UseSizeOptimizedLinq>`, que intercambia algo de throughput de LINQ por una salida más pequeña y es el valor por defecto bajo `PublishAot`. Estos no se tratan de hacer tu código analizable; se tratan de no pagar, en tamaño binario, por características del framework que nunca tocas. Habilítalos deliberadamente, porque cada uno elimina comportamiento real.

## El flujo de trabajo que de verdad te lleva a seguro para trimming

El modelo mental que hace que todo esto cuadre: la seguridad para trimming no es un interruptor, es un estado de compilación que defiendes. Enciende el analizador (`PublishTrimmed` para apps, `IsTrimmable` más una app de prueba con raíz para bibliotecas). Lee las advertencias y clasifícalas: las `IL207x` las corriges anotando el origen del `Type` con las banderas `DynamicallyAccessedMembers` mínimas; las `IL2026`/`IL3050` o las anotas con `[RequiresUnreferencedCode]` y las propagas a una API pública, o reemplazas la reflexión con un generador de código fuente; las dos vías de escape las usas solo cuando un invariante es real y el analizador genuinamente no puede verlo. Lleva la cuenta a cero, luego mantenla ahí, porque introducir una nueva advertencia de trimming es un cambio disruptivo para cualquiera que publique tu biblioteca con trimming, y una subida de dependencia puede reintroducir una sin ningún cambio de API de tu lado. Cuando una llamada insegura se cuela pasando el analizador y solo falla en tiempo de ejecución, estás de vuelta depurando una [PlatformNotSupportedException en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/), que es precisamente el fallo que la compilación libre de advertencias existe para prevenir. Y si el objetivo es un servicio web real, [el recorrido de minimal API con Native AOT](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) muestra la receta de compilación limpia de principio a fin. El código seguro para trimming no es un dialecto especial de C#; es C# ordinario que mantiene honesto el análisis de alcanzabilidad del trimmer, y el analizador es la herramienta que te dice, en tiempo de compilación, si lo has logrado.

## Relacionados

- [¿Qué es Native AOT y qué te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/) explica por qué el trimming es obligatorio bajo AOT y qué más sacrificas.
- [¿Qué es el atributo DynamicallyAccessedMembers?](/es/2026/06/what-is-the-dynamicallyaccessedmembers-attribute/) es el análisis a fondo de la anotación que corrige las advertencias de flujo de datos IL207x.
- [¿Qué es un generador de código fuente y cuándo necesito uno?](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) cubre la generación de código en tiempo de compilación que reemplaza la reflexión que no puedes anotar.
- [Cómo usar Native AOT con las minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) es el recorrido de compilación limpia donde estas advertencias aparecen en una app real.
- [Solución: PlatformNotSupportedException en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/) es el fallo en tiempo de ejecución que una compilación de trimming libre de advertencias previene.

## Fuentes

- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming), MS Learn (IsTrimmable, EnableTrimAnalyzer, the test-app pattern, RequiresUnreferencedCode, DynamicallyAccessedMembers, UnconditionalSuppressMessage, DynamicDependency).
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options), MS Learn (PublishTrimmed, TrimmerSingleWarn, ILLinkTreatWarningsAsErrors, the feature-switch table).
- [Trim self-contained deployments and executables](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trim-self-contained), MS Learn (TrimMode granularity and how reachability trimming works).
- [Introduction to trim warnings](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/fixing-warnings), MS Learn (the IL2026/IL3050/IL207x warning catalog and the data-flow model).
