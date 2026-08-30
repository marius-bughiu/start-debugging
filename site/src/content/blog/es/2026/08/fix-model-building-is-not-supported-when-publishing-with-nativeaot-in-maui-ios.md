---
title: "Solución: Model building is not supported when publishing with NativeAOT en una compilación de .NET MAUI para iOS"
description: "Las compilaciones de iOS ponen DynamicCodeSupport=false, así que EF Core se niega a construir el modelo aunque nunca hayas activado NativeAOT. Publica un modelo compilado más consultas precompiladas, o vuelve a activar el intérprete."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "maui"
  - "ios"
  - "native-aot"
  - "dotnet-10"
lang: "es"
translationOf: "2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios"
translatedBy: "claude"
translationDate: 2026-08-30
---

Tu aplicación MAUI para iOS falla en la primera llamada a la base de datos con `Model building is not supported when publishing with NativeAOT. Use a compiled model.`, y poner `<PublishAot>false</PublishAot>` no cambia nada. Eso ocurre porque EF Core nunca mira `PublishAot`. Comprueba `RuntimeFeature.IsDynamicCodeSupported`, y los targets de .NET para iOS ponen ese interruptor en `false` en toda compilación de iOS, tvOS y Mac Catalyst salvo que el intérprete esté activado. La solución soportada es mover tu `DbContext` y todas las consultas LINQ a una biblioteca de clases normal, ejecutar `dotnet ef dbcontext optimize --precompile-queries --nativeaot` sobre ella y agregar `<InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>`. La salida de emergencia de una línea es `<UseInterpreter>true</UseInterpreter>`, con un costo real de arranque.

Todo lo que sigue se verificó en macOS con el .NET SDK 10.0.302, `Microsoft.EntityFrameworkCore.Sqlite` 8.0.21 / 9.0.19 / 10.0.11 y la CLI `dotnet-ef` 10.0.11. El fallo y las tres soluciones se reproducen en una simple aplicación de consola, sin Xcode y sin iPhone, porque el disparador es un único interruptor de AppContext. Cuando una afirmación se refiere a la compilación de iOS en sí y no a algo que ejecuté, viene de los targets de `dotnet/macios` y `dotnet/sdk` y lo digo explícitamente.

## El error en contexto

```text
System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder...
   at Microsoft.EntityFrameworkCore.DbContext.get_Model()
```

Aparece en la primera operación que toca el modelo: una consulta, `Add`, `SaveChanges` o `EnsureCreated`. Crear el `DbContext` por sí solo no lo dispara, y por eso el fallo suele caer muy lejos del código donde configuras la base de datos.

Los dos mensajes hermanos con los que te puedes topar cuando empieces a arreglar esto son `Design-time DbContext operations are not supported when publishing with NativeAOT.` y `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` Ambos se cubren más abajo.

## Por qué una compilación de iOS reporta un error de NativeAOT si nunca activaste NativeAOT

El mensaje nombra NativeAOT, pero nada en la comprobación lo menciona. Este es el código real, de [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs):

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, DbContextServices.CreateModel
if (modelFromOptions == null
    || (designTime && modelFromOptions is not Metadata.Internal.Model))
{
    return RuntimeFeature.IsDynamicCodeSupported
        ? dependencies.ModelSource.GetModel(_currentContext!.Context, dependencies, designTime)
        : designTime
            ? throw new InvalidOperationException(CoreStrings.NativeAotDesignTimeModel)
            : throw new InvalidOperationException(CoreStrings.NativeAotNoCompiledModel);
}
```

`RuntimeFeature.IsDynamicCodeSupported` lee el interruptor de AppContext `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported`, que el SDK escribe en `runtimeconfig.json` a partir de la propiedad MSBuild `DynamicCodeSupport`. De [`Microsoft.NET.Sdk.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.Sdk.targets):

```xml
<!-- .NET SDK 10.0.302 -->
<RuntimeHostConfigurationOption Include="System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported"
                                Condition="'$(DynamicCodeSupport)' != ''"
                                Value="$(DynamicCodeSupport)"
                                Trim="true" />
```

Y esta es la línea que la establece, de [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) en `dotnet/macios`:

```xml
<!-- dotnet/macios, Xamarin.Shared.Sdk.targets -->
<DynamicCodeSupport Condition="'$(DynamicCodeSupport)' == '' And ( '$(MtouchInterpreter)' == '' And '$(UseInterpreter)' != 'true' ) And ('$(_PlatformName)' == 'iOS' Or '$(_PlatformName)' == 'tvOS' Or '$(_PlatformName)' == 'MacCatalyst')">false</DynamicCodeSupport>
```

De esa condición se desprenden tres cosas, y las tres contradicen el folclore que rodea a este error.

No se trata de `PublishAot`. Esa propiedad no aparece en ningún punto de la cadena, y por eso ponerla en `false` no cambia nada.

No se trata de la configuración Release. La condición no tiene ninguna comprobación de `Configuration`. Lo que realmente decide es si el intérprete está activado, así que una compilación Debug sin intérprete también recibe `IsDynamicCodeSupported = false`, y una compilación Release con `UseInterpreter=true` no.

No aplica a Android. La lista de plataformas es solo iOS, tvOS y Mac Catalyst, y por eso la misma solución sigue funcionando en Android y Windows mientras iOS falla.

La propiedad la introdujo [el PR #18555 de dotnet/macios](https://github.com/dotnet/macios/pull/18555), "Set `DynamicCodeSupport=false` to enable trimming in full AOT mode", y llegó al workload de MAUI en la banda 8.0.6x. Ese calendario coincide con [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595), donde quien reportó acotó la regresión entre el workload 8.0.40 (funcionaba) y el 8.0.61 (roto) sin cambiar una línea de código de EF Core.

## Reproducirlo sin un iPhone

Como el disparador es un solo interruptor, puedes reproducir y arreglar esto en una aplicación de consola de escritorio. Crea un proyecto y define la misma propiedad que definen los targets de iOS:

```xml
<!-- .NET SDK 10.0.302, net10.0 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <!-- exactly what Xamarin.Shared.Sdk.targets sets for iOS/tvOS/MacCatalyst -->
  <DynamicCodeSupport>false</DynamicCodeSupport>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
</ItemGroup>
```

```csharp
// .NET 10, EF Core 10.0.11
using System.Runtime.CompilerServices;
using Microsoft.EntityFrameworkCore;

Console.WriteLine($"IsDynamicCodeSupported = {RuntimeFeature.IsDynamicCodeSupported}");

using var db = new NotesContext();
db.Database.EnsureCreated();

public class Note
{
    public int Id { get; set; }
    public string Text { get; set; } = "";
}

public class NotesContext : DbContext
{
    public DbSet<Note> Notes => Set<Note>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=notes.db");
}
```

`dotnet run` imprime `IsDynamicCodeSupported = False` y luego lanza el error exacto. El archivo generado `bin/Debug/net10.0/<app>.runtimeconfig.json` muestra de dónde salió:

```json
"configProperties": {
  "System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
}
```

Este ciclo de reproducción importa, porque la alternativa es una compilación para dispositivo de 10 minutos por cada intento.

## Solución 1: modelo compilado más consultas precompiladas en una biblioteca compartida

Esta es la ruta soportada y la única que conserva el beneficio de recorte para el que existe el interruptor. Tiene tres partes, y saltarse cualquiera de ellas solo te lleva a la siguiente excepción.

**Paso 1: mueve el `DbContext`, las entidades y todas las consultas LINQ a una biblioteca de clases `net10.0` normal.** No `net10.0-ios`. Las herramientas `dotnet ef` cargan tu ensamblado en un proceso de tiempo de diseño en el host, y necesitan un proyecto que puedan compilar y cargar de verdad. Una biblioteca normal también te da un proyecto donde `IsDynamicCodeSupported` sigue siendo `true`, que es lo que exige el paso siguiente.

Lo de "todas las consultas LINQ" no es una preferencia de estilo. Lo verifiqué: una consulta escrita en el proyecto de la aplicación que referencia la biblioteca optimizada sigue lanzando `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` La precompilación funciona generando interceptores de C# para los puntos de llamada que puede ver, así que un punto de llamada en otro proyecto le resulta invisible. En la práctica esto te empuja hacia una clase de repositorio o de servicio de datos dentro de la biblioteca, que es donde las aplicaciones MAUI deberían tener este código de todos modos.

```csharp
// .NET 10, EF Core 10.0.11 - Notes.Data class library
public static class NoteRepository
{
    public static async Task<List<Note>> GetAllAsync()
    {
        using var db = new NotesContext();
        return await db.Notes.OrderBy(n => n.Id).ToListAsync();
    }

    public static async Task<Note?> FindByTextAsync(string text)
    {
        using var db = new NotesContext();
        var needle = text;
        return await db.Notes.FirstOrDefaultAsync(n => n.Text == needle);
    }
}
```

Esa línea `var needle = text;` no es cosmética. Escribir `n.Text == text` directamente contra el parámetro del método hace fallar la precompilación en EF Core 10.0.11 con `System.Diagnostics.UnreachableException: IdentifierName of type ParameterSymbol: text`. Copiar el parámetro a una variable local primero hace que la misma consulta se precompile sin problemas. Conserva la variable local hasta que eso se corrija en el proyecto original.

**Paso 2: activa los interceptores y genera el modelo.** Agrega la propiedad a la biblioteca:

```xml
<!-- Notes.Data.csproj, EF Core 10.0.11 -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
</PropertyGroup>
```

Sin ella la compilación falla con `CS9137: The 'interceptors' feature is not enabled in this namespace`. Si ese código te suena, es la misma activación con la que tropieza la gente con [los interceptores del generador de código fuente de OpenAPI](/es/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/).

Entonces, desde el directorio de la biblioteca:

```bash
dotnet ef dbcontext optimize --output-dir CompiledModels --namespace Notes.Data.CompiledModels --precompile-queries --nativeaot
```

Cuando tiene éxito imprime:

```text
Successfully generated a compiled model, it will be discovered automatically, but you can also
call 'options.UseModel(Notes.Data.CompiledModels.NotesContextModel.Instance)'.
Run this command again when the model is modified.
```

Ese "discovered automatically" es un comportamiento de EF Core 9 en adelante: el generador emite `[assembly: DbContextModel(typeof(NotesContext), typeof(NotesContextModel))]` en `NotesContextAssemblyAttributes.cs`, y EF lo encuentra siempre que el atributo esté en el mismo ensamblado que el `DbContext`. En EF Core 8 no hay atributo y tienes que llamar a `UseModel` tú mismo.

**Paso 3: regenera en cada cambio de código.** Los interceptores de C# están anclados a ubicaciones de código fuente, así que cualquier edición en la biblioteca los invalida. La documentación de EF es contundente al respecto: la generación de interceptores "isn't expected to happen in the inner loop". Para una aplicación real, agrega el paquete [`Microsoft.EntityFrameworkCore.Tasks`](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks) (10.0.11) a la biblioteca para que MSBuild lo haga al publicar, en lugar de depender de que alguien recuerde el comando de la CLI. Verifiqué la ruta por CLI de principio a fin; la integración con MSBuild es lo que la documentación recomienda para CI.

Con las tres partes en su sitio, mi aplicación de consola con `DynamicCodeSupport=false` inserta una fila, lista filas y ejecuta una búsqueda parametrizada sin ninguna excepción.

## Solución 2: vuelve a activar el intérprete

Mira otra vez la condición de macios: definir `MtouchInterpreter` o `UseInterpreter` suprime `DynamicCodeSupport=false` por completo, así que EF Core construye su modelo en tiempo de ejecución exactamente como lo hace en Android.

```xml
<!-- MAUI app csproj -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <UseInterpreter>true</UseInterpreter>
</PropertyGroup>
```

Esta es una configuración legítima, no un truco: el intérprete de IL de Mono no es JIT, y Apple lo permite. Lo que pagas es throughput y arranque, ya que el código interpretado es más lento que el compilado con AOT y el modelo se sigue construyendo por reflexión en el primer uso. Úsala para desbloquear una versión, y luego aplica la Solución 1.

Dos advertencias. El intérprete también desactiva el recorte de IL (`EnableAssemblyILStripping` se fuerza a `false` cuando se define `MtouchInterpreter`), así que tu paquete de aplicación crece. Y es una característica de Mono: los targets de macios emiten la advertencia "The property 'UseInterpreter' has no effect when not using the Mono runtime (for instance when using CoreCLR)". Eso importa de cara al futuro, porque [MAUI móvil es solo CoreCLR desde .NET 11 Preview 6](/es/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/). Trata esta solución como un puente para .NET 10, no como un plan a largo plazo.

## Solución 3: forzar DynamicCodeSupport de vuelta a true

```xml
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <DynamicCodeSupport>true</DynamicCodeSupport>
</PropertyGroup>
```

La condición de la línea de macios empieza con `'$(DynamicCodeSupport)' == ''`, así que un valor explícito gana y el interruptor aterriza en `runtimeconfig.json` como `true`. EF Core deja entonces de lanzar la excepción.

La pongo al final por una razón. El interruptor no es decorativo: es lo que le dice al recortador que puede eliminar las rutas de código dinámico, que es justamente el objetivo del [PR #18555](https://github.com/dotnet/macios/pull/18555). Ponerlo en `true` mientras la aplicación sigue compilada completamente con AOT le miente al runtime, y quedas dependiendo de que cada biblioteca de tu grafo de dependencias tolere un entorno que declara un soporte de código dinámico que no tiene. Si ya trabajaste [lo que realmente exige el código seguro para recorte](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) reconocerás la forma del riesgo. Úsalo para diagnosticar, no para publicar.

## EnsureCreated y Migrate siguen fallando después de arreglar el modelo

Este es el paso que atrapa a la mayoría de las aplicaciones MAUI, porque el arranque estándar de SQLite es una llamada a `EnsureCreated()` en el constructor de la aplicación. Con un modelo compilado en su sitio y `IsDynamicCodeSupported = false`, estas dos lanzan:

```text
EnsureCreated: InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
Migrate:       InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
```

Vuelve al fragmento de `CreateModel`: un modelo compilado es un `RuntimeModel`, no un `Metadata.Internal.Model`, así que cualquier ruta de código que pida el modelo de tiempo de diseño toma la rama `NativeAotDesignTimeModel`. La creación del esquema necesita el modelo de tiempo de diseño para emitir DDL, así que no puede funcionar desde un modelo compilado. Esta es otra regresión de EF Core 9: ejecuté la misma llamada a `EnsureCreated()` con el interruptor apagado contra EF Core 8.0.21 y creó la base de datos sin quejarse.

La alternativa es dejar de pedirle a la aplicación que calcule el DDL. Genera el SQL una vez en el host y ejecútalo como texto:

```bash
dotnet ef migrations script -o Migrations.sql
```

```csharp
// .NET 10, EF Core 10.0.11 - runs fine with IsDynamicCodeSupported = false
using var db = new NotesContext();
db.Database.ExecuteSqlRaw(await File.ReadAllTextAsync(scriptPath));
```

Publica `Migrations.sql` como recurso raw de MAUI y ejecútalo en el primer arranque. Ten en cuenta que SQLite no soporta `--idempotent`; `dotnet ef migrations script --idempotent` falla con "Generating idempotent scripts for migrations is not currently supported for SQLite", así que lleva tú el registro de la migración aplicada o protege el script con `CREATE TABLE IF NOT EXISTS`. El mismo razonamiento de "entrega un script en vez de ejecutar `Migrate()`" aplica cuando [un inicio de sesión de migración no puede crear la base de datos](/es/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/), por motivos distintos.

## Qué cambió entre EF Core 8, 9 y 10

Si tu aplicación funcionaba en iOS solo con un modelo compilado y se rompió de nuevo tras actualizar EF Core, esta es la razón. Ejecuté el mismo código con `DynamicCodeSupport=false` y un modelo compilado pero sin consultas precompiladas, contra tres versiones de EF Core:

| EF Core | Descubrimiento del modelo compilado | `EnsureCreated()` | Consulta LINQ simple |
| --- | --- | --- | --- |
| 8.0.21 | requiere `UseModel(...)` | funciona | funciona |
| 9.0.19 | automático | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |
| 10.0.11 | automático | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |

En EF Core 8 la canalización de consultas todavía compilaba LINQ en tiempo de ejecución, y el intérprete de expresiones lo sostenía. Desde EF Core 9 en adelante el compilador se apoya en el mismo interruptor, en [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs):

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, QueryCompiler.ExecuteAsync
var compiledQuery
    = _compiledQueryCache
        .GetOrAddQuery(
            _compiledQueryCacheKeyGenerator.GenerateCacheKey(queryAfterExtraction, async),
            () => RuntimeFeature.IsDynamicCodeSupported
                ? CompileQueryCore<TResult>(_database, queryAfterExtraction, _model, async)
                : throw new InvalidOperationException(CoreStrings.QueryNotPrecompiled));
```

No hay ningún interruptor de AppContext para restaurar el comportamiento antiguo. Un modelo compilado bastaba en EF Core 8; desde EF Core 9 también necesitas consultas precompiladas.

## Errores parecidos

`Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` significa que se encontró el modelo compilado y la consulta no. Comprueba que la consulta viva en el proyecto sobre el que ejecutaste `optimize --precompile-queries`, y que el archivo generado `*.EFInterceptors.*.cs` se esté compilando.

`Dynamic LINQ queries are not supported when precompiling queries.` viene del comando optimize, no de la aplicación. Significa que la consulta se compone a lo largo de varias instrucciones (`query = query.Where(...)` dentro de un `if`). Reescríbela como dos consultas completas detrás de una expresión condicional, tal como muestra la documentación de forma explícita.

`Design-time DbContext operations are not supported when publishing with NativeAOT.` es `EnsureCreated`, `Migrate`, `GenerateCreateScript`, o una herramienta de tiempo de diseño ejecutándose contra una configuración donde el interruptor está apagado. Fíjate en que esto también bloquea al propio `dotnet ef`: ejecutar `dotnet ef dbcontext optimize` en un proyecto con `DynamicCodeSupport=false` falla con la misma familia de errores de NativeAOT, que es el problema del huevo y la gallina que hace necesaria la biblioteca de clases aparte.

`PlatformNotSupportedException` al arrancar en una aplicación recortada o con AOT es un fallo distinto con una causa distinta; mira las notas sobre [PlatformNotSupportedException con Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/).

## Relacionado

- [¿Qué es Native AOT y qué te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/) cubre el compromiso que este interruptor existe para habilitar.
- [MAUI móvil es solo CoreCLR en .NET 11 Preview 6](/es/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/) explica por qué la salida de emergencia del intérprete tiene fecha de caducidad.
- [¿Qué es el código seguro para recorte y cómo lo escribo?](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) es el trasfondo de por qué anular el interruptor es arriesgado.
- [Solución: la característica 'interceptors' no está habilitada en este espacio de nombres](/es/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/) cubre el CS9137 con el que te vas a topar en el paso 2.
- [Solución: CREATE DATABASE permission denied in database 'master'](/es/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/) es el otro caso donde publicar un script SQL supera a llamar a `Migrate()`.

## Fuentes

- [Soporte de NativeAOT y consultas precompiladas](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries), documentación de EF Core, incluyendo la activación de `InterceptorsNamespaces`, el paquete `Microsoft.EntityFrameworkCore.Tasks` y la limitación de consultas dinámicas.
- [Modelos compilados](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models), documentación de EF Core, para `dotnet ef dbcontext optimize` y las limitaciones del modelo compilado.
- [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs) y [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs) en `dotnet/efcore`, para ambas comprobaciones de `RuntimeFeature.IsDynamicCodeSupported`.
- [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) en `dotnet/macios`, para el valor por defecto de `DynamicCodeSupport` y las condiciones del intérprete.
- [PR #18555 de dotnet/macios](https://github.com/dotnet/macios/pull/18555), que introdujo la propiedad.
- [dotnet/maui#23653](https://github.com/dotnet/maui/issues/23653) y [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595), los reportes originales que acotan la regresión a la actualización del workload.
