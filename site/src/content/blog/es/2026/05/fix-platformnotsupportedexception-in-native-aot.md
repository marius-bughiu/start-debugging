---
title: "Fix: PlatformNotSupportedException: Operation is not supported on this platform en Native AOT"
description: "Native AOT elimina el JIT y el intérprete, así que reflection emit, compilación de árboles de expresión y MakeGenericType no vistos lanzan en runtime. Localiza la llamada con IL3050 y reemplázala por un generador de código fuente o un camino prehorneado."
pubDate: 2026-05-10
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "native-aot"
  - "trimming"
lang: "es"
translationOf: "2026/05/fix-platformnotsupportedexception-in-native-aot"
translatedBy: "claude"
translationDate: 2026-05-10
---

La solución: Native AOT publica un único binario nativo sin JIT y sin intérprete, por lo que cualquier ruta de código que emita IL en runtime, compile un árbol `Expression<T>` o pida al runtime que hornee una instanciación genérica que nunca ha visto, lanzará `PlatformNotSupportedException`. El primer paso es siempre el mismo: vuelve a compilar con `dotnet publish -r <rid> -c Release` y lee el aviso `IL3050` que nombra al miembro infractor, luego reemplázalo por una alternativa compatible con AOT (un generador de código fuente, un genérico preinstanciado o un feature switch).

```text
System.PlatformNotSupportedException: Operation is not supported on this platform.
   at System.Reflection.Emit.DynamicMethod..ctor(String name, Type returnType, Type[] parameterTypes)
   at SomeLibrary.Internal.ExpressionCompiler.Compile(LambdaExpression expr)
   at SomeLibrary.PublicEntryPoint.DoTheThing()
   at Program.<Main>$(String[] args) in /src/Program.cs:line 12
```

```text
System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
   at System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(...)
   at System.Linq.Expressions.Compiler.LambdaCompiler.CompileLambda(LambdaExpression lambda, Boolean hasClosureArgument)
   at System.Linq.Expressions.Expression`1[[T]].Compile()
```

Esta guía está escrita contra el SDK de .NET 11 (preview 4), `Microsoft.NET.Sdk` 11.0.0-preview.4 y C# 14. El texto de la excepción y la restricción subyacente han sido estables desde que Native AOT se publicó como implementación soportada en .NET 8, así que todo lo de abajo aplica sin cambios en .NET 8, 10 y 11. La versión .NET 9 añadió la historia del analizador `RequiresDynamicCodeAttribute` que respalda IL3050, y .NET 11 la endurece todavía más promoviendo más rutas de la BCL a variantes seguras para AOT.

Dos mensajes distintos comparten el mismo tipo de excepción. `Operation is not supported on this platform` viene de la ruta rápida del JIT-emit tropezando con `RuntimeFeature.IsDynamicCodeSupported == false`. `Dynamic code generation is not supported on this platform` viene del propio `Reflection.Emit` cuando algo intenta construir un `DynamicAssembly` o un `DynamicMethod`. Ambas tienen la misma causa raíz y la misma superficie de solución, así que no pierdas tiempo tratándolas como bugs distintos.

## Por qué un binario Native AOT de un solo archivo no puede emitir IL

`dotnet publish /p:PublishAot=true` produce una imagen nativa totalmente compilada por adelantado. El JIT no está enlazado estáticamente. El intérprete de Mono no está enlazado estáticamente. El escritor `Reflection.Emit` de CoreCLR está compilado fuera. En runtime, `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported` devuelve `false`, y cualquier API que dependa de escribir IL nuevo o de ensamblar un nuevo delegado a partir de código máquina en bruto, devuelve un fallo de guarda estilo `IsSupported` o esta excepción.

Las cuatro formas que tropiezan con esta restricción en código real:

1. **Uso directo de `Reflection.Emit`.** `DynamicMethod`, `AssemblyBuilder.DefineDynamicAssembly`, `TypeBuilder`, `ILGenerator.Emit`. Lanzan inmediatamente.
2. **`Expression<T>.Compile()` sobre un árbol no trivial.** El compilador de expresiones internamente reduce a `DynamicMethod`. `Compile(preferInterpretation: true)` recurre al intérprete en .NET 8 y 10, pero el intérprete también se quita del Native AOT, así que incluso la sobrecarga `true` lanza salvo que la BCL tenga un fallback que recorra el árbol.
3. **`Type.MakeGenericType` / `MethodInfo.MakeGenericMethod` con argumentos de tipo que el compilador no vio.** `List<int>` funciona porque el compilador AOT lo instanció. `MakeGenericType(someTypeFromReflection)` sobre un tipo de valor que el compilador nunca alcanzó lanza.
4. **Transitivamente, todo lo construido sobre lo anterior.** Los mappers compilados por expresiones de AutoMapper, FastMember, los genéricos abiertos de MediatR, la caché de convertidores de Newtonsoft.Json, la ruta de consulta compilada de EF Core sobre grafos de POCO que el model builder no cubrió, gRPC.Core con su codegen antiguo, y los clientes Dataverse / Service Fabric / WCF que se apoyan en proxies dinámicos.

En una compilación JIT, el runtime simplemente genera el código tier-0 del nuevo método y sigue. En Native AOT no tiene dónde poner el código nuevo, así que lanza en el primer momento en que se llama a la API.

## Reproducción mínima

```csharp
// .NET 11 SDK preview 4, C# 14, <PublishAot>true</PublishAot>
using System.Linq.Expressions;

Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();   // throws on Native AOT
Console.WriteLine(compiled(41));
```

`.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

Publica en Linux x64:

```bash
dotnet publish -r linux-x64 -c Release
```

El paso de publicación imprime:

```text
warning IL3050: Using member 'System.Linq.Expressions.Expression`1<TDelegate>.Compile()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. Compiling a lambda requires dynamic code.
```

Ejecuta el binario:

```text
Unhandled exception. System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
```

Esta es la versión canónica del error. La misma forma aplica tanto si el infractor es tu propio código, un paquete NuGet o una pieza del framework arrastrada transitivamente.

## La solución, en detalle

Las soluciones siguientes están ordenadas de la más barata a la más invasiva. Toma la primera que compile.

### 1. Reemplaza la API por una alternativa compatible con AOT (preferida)

Casi cada API problemática tiene ahora un reemplazo amigable con AOT que el equipo de .NET publicó específicamente por esta clase de excepción.

| Hostil a AOT | Reemplazo amigable con AOT |
|---|---|
| `Newtonsoft.Json` | `System.Text.Json` con un contexto generador de código fuente `[JsonSerializable]` |
| `AutoMapper` (compilado por expresiones) | Mappers de código fuente generado (modo source-generator de Mapster, Riok.Mapperly, `MapTo`) |
| `MediatR` (registro de genéricos abiertos) | Interfaces de handler escritas a mano, o `Mediator` (el de generador de código fuente) |
| `Microsoft.AspNetCore.Mvc.Controllers` | `WebApplication.CreateSlimBuilder` + minimal APIs con `JsonSerializerContext` |
| Modelo de EF Core construido en runtime | `OptimizeQuery` / `dotnet ef dbcontext optimize` para pregenerar el modelo |
| Interceptores de `Castle.DynamicProxy` | Decoradores de código fuente generado (por ejemplo vía Roslyn o PolySharp) |
| `Expression<T>.Compile()` | `delegate*<...>`, un literal `Func<...>`, o un reemplazo `IL` escrito a mano y compilado en build |

Ejemplo concreto, reemplazando la llamada a compilar lambda:

```csharp
// .NET 11, C# 14
// Before: AOT-hostile
Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();

// After: pure delegate, no expression tree, no Compile()
Func<int, int> compiled = x => x + 1;
```

Si genuinamente necesitas la forma del árbol de expresiones (porque estás inspeccionando el cuerpo), conserva el árbol, pero deja de llamar a `Compile()` y cambia el consumidor a un `delegate` que escribiste tú a mano.

### 2. Usa `RuntimeFeature.IsDynamicCodeSupported` como feature switch

Si la ruta dinámica es opcional, ponla detrás del flag de característica de runtime y publica un fallback lento pero seguro para AOT:

```csharp
// .NET 11, C# 14
using System.Runtime.CompilerServices;

public static T Materialize<T>(IDataReader reader)
{
    if (RuntimeFeature.IsDynamicCodeSupported)
    {
        return EmitMaterializer<T>.Compile()(reader);   // existing fast path
    }

    return ReflectionMaterializer<T>.Materialize(reader); // slower but no IL emit
}
```

El compilador AOT evalúa estáticamente `IsDynamicCodeSupported` como `false` para el binario publicado y recorta toda la rama dinámica, incluido `EmitMaterializer<T>`. Sin más IL3050, sin más lanzamiento en runtime. Importante: el analizador solo recorta cuando la prueba es la lectura literal de la propiedad; no la asignes a una variable local antes ni la envuelvas en un método, o el trimmer mantendrá la rama muerta.

### 3. Preinstanciar genéricos que el compilador no puede ver

Si el mensaje nombra `MakeGenericType` o `MakeGenericMethod`, el compilador AOT no sabe qué `T` hornear. Dos salidas:

```csharp
// .NET 11, C# 14
// Tell the AOT compiler exactly which generic instantiations to keep.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]
public class Repository<T> { /* ... */ }

// And in your DI bootstrap, use closed generics:
services.AddScoped<Repository<User>>();
services.AddScoped<Repository<Order>>();
// not: services.AddScoped(typeof(Repository<>));
```

O bien, para una llamada puramente reflexiva, cambia al equivalente generado por código fuente. ASP.NET Core 11 publica sobrecargas seguras para AOT para las formas comunes de inyección de dependencias; el equipo de runtime también añadió intrínsecos `Activator.CreateInstance<T>()` amigables con AOT para constructores sin parámetros.

### 4. Marca el método como `RequiresDynamicCode` y deja de llamarlo desde rutas AOT

Si estás escribiendo una biblioteca y un método genuinamente necesita codegen dinámico, propaga el requisito a quienes te llaman para que el analizador pueda avisar a su nivel:

```csharp
// .NET 11, C# 14
[RequiresDynamicCode("Builds a per-type accessor with Reflection.Emit. " +
                     "Not supported in Native AOT. Use SourceGenAccessor<T> instead.")]
public static Func<object, object> BuildGetter(PropertyInfo prop) => /* emit */;
```

El atributo no soluciona la excepción en runtime, pero convierte el cierre silencioso en un IL3050 en build, que es el contrato que los consumidores de Native AOT esperan.

### 5. Elimina la dependencia

Último recurso. Si una biblioteca de la que dependes hardcodea `Reflection.Emit` y no ofrece modo AOT, las únicas opciones honestas son (a) reemplazar la biblioteca, (b) mantener ese subsistema en una frontera de proceso no-AOT (un worker publicado con JIT detrás de una frontera HTTP o de named pipe), o (c) esperar a que el mantenedor upstream publique una ruta AOT. No tapes la excepción con un `try/catch`; el programa queda entonces en un estado indefinido porque el consumidor casi seguro depende de la operación fallida.

## Variantes y errores parecidos comunes

- **`PlatformNotSupportedException: System.Reflection.Emit.DynamicMethod` desde `System.Linq.Expressions`.** Misma causa raíz que Compile(), suele aflorar dentro de proveedores `Queryable` y convertidores JSON. Busca en el log de publicación la línea IL3050 que nombra al método originador. Si llegas aquí desde un serializador JSON, consulta [nuestro recorrido sobre cómo escribir convertidores System.Text.Json compatibles con AOT](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).
- **`PlatformNotSupportedException: Operation is not supported on this platform` desde `Assembly.Load(byte[])`.** Native AOT no permite cargar ensamblados administrados adicionales en runtime. No hay fallback. Mueve la carga de plugins a un host no-AOT.
- **`PlatformNotSupportedException: Cannot emit a dynamic assembly.` desde `Castle.DynamicProxy`.** Castle no tiene ruta AOT a partir de la 5.x; reemplaza la interceptación por decoradores de código fuente generado o saca el servicio proxiado del binario AOT.
- **`NotSupportedException: BinaryFormatter serialization and deserialization are disabled.`** Tipo de excepción distinto, pero el mismo tema general de "eliminado del binario AOT". No cambies a un `try/catch` a su alrededor; reescribe la serialización a System.Text.Json.
- **`PlatformNotSupportedException: ... requires the JIT.`** Este es el mensaje que ves en objetivos del intérprete de Mono (iOS, watchOS, MAUI Catalyst) cuando el intérprete también está apagado. La superficie de solución es la misma que en Native AOT: prehornea el genérico, cambia a un generador de código fuente o pon la ruta tras un feature switch.
- **El error solo aparece en una única plataforma.** Algunos paquetes publican un activo de runtime NuGet por RID. La build de `linux-x64` puede compilar con `Reflection.Emit` deshabilitado, mientras que `win-x64` funciona. Prueba siempre la publicación en cada RID que envías.

## Cómo verificar que realmente lo arreglaste

Tres comprobaciones antes de cantar victoria:

1. `dotnet publish -r <rid> -c Release` no produce ningún aviso `IL3050`. Promuévelos a errores con `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` y `<IsAotCompatible>true</IsAotCompatible>`.
2. El binario publicado ejecuta la ruta antes fallida bajo `DOTNET_TieredCompilation=0` y `DOTNET_ReadyToRun=0`. Native AOT no honra estas variables, pero las variables de entorno son una manera rápida de confirmar que no estás probando accidentalmente una build JIT autocontenida.
3. La tabla de imports del binario publicado no contiene ninguna referencia al JIT (`clrjit.dll` / `libclrjit.so`). En Linux, `nm --dynamic` sobre el binario no debería mostrar símbolos `clrjit`.

Si las tres pasan, tienes un binario limpio para AOT y la excepción no volverá por la misma ruta.

## Relacionado

- [Cómo usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) recorre la ruta completa de publicación y la superficie del aviso IL3050 para un servicio web típico.
- [Cómo reducir el tiempo de arranque en frío de un AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) es la razón por la que la mayoría de los equipos echan mano de Native AOT en primer lugar.
- [Cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) es el reemplazo seguro para AOT cuando estuviste tentado de pasarle metadatos reflexivos a un `JsonSerializer`.
- [Cómo escribir un generador de código fuente para INotifyPropertyChanged](/es/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) es el patrón que usas siempre que una biblioteca existente quiere hacer `Reflection.Emit` por ti.
- [Rider 2026.1 incorpora un visor de ASM que decodifica salida de JIT y Native AOT](/es/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) es útil cuando quieres confirmar que el trimmer realmente eliminó la rama dinámica.

## Fuentes

- [Native AOT deployment overview, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [IL3050: Avoid calling members annotated with RequiresDynamicCodeAttribute when publishing as Native AOT, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/warnings/il3050)
- [Introduction to AOT warnings, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/fixing-warnings)
- [Intrinsic APIs marked RequiresDynamicCode, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/intrinsic-requiresdynamiccode-apis)
- [How to make libraries compatible with Native AOT, .NET Blog](https://devblogs.microsoft.com/dotnet/creating-aot-compatible-libraries/)
- [AOT with Reflection, dotnet/runtime discussion #95244](https://github.com/dotnet/runtime/discussions/95244)
- [RuntimeFeature.IsDynamicCodeSupported, .NET API browser](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.runtimefeature.isdynamiccodesupported)
