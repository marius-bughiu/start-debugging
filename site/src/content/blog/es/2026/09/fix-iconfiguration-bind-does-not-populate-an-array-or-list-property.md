---
title: "Solución: IConfiguration.Bind no llena una propiedad array o List<T> desde appsettings.json"
description: "El binder omite en silencio las propiedades array sin setter público, los IReadOnlyList<T> de solo lectura, los campos y los miembros init con el source generator, y agrega a los valores predeterminados en lugar de reemplazarlos. Medido en .NET 10.0.12 y 11 RC 1."
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "dotnet-11"
  - "configuration"
  - "options-pattern"
  - "aspnetcore"
lang: "es"
translationOf: "2026/09/fix-iconfiguration-bind-does-not-populate-an-array-or-list-property"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Respuesta corta:** `ConfigurationBinder` nunca lanza una excepción cuando no puede enlazar una colección. Simplemente deja la propiedad como está. Las causas habituales son: la propiedad es un array (o `IReadOnlyList<T>`, `IEnumerable<T>`) sin setter público, es un campo público en lugar de una propiedad, el nombre de sección que pasaste a `GetSection` no coincide con el JSON, o activaste Native AOT o trimming, lo que cambia el binder a su source generator, y el generador ignora los accesores `init`. Dale a la propiedad un `get; set;` público, enlaza la sección correcta y activa `ErrorOnUnknownConfiguration` para que la próxima discrepancia falle de forma visible. Si la lista se enlaza pero tiene elementos *de más*, esa es la otra mitad de este bug: el binder agrega a lo que la propiedad ya contiene, nunca lo reemplaza.

Todo lo que sigue se midió con una prueba basada en archivo sobre el SDK 10.0.302 contra `Microsoft.Extensions.Configuration.Binder` 10.0.12, y luego se repitió con 11.0.0-rc.1.26425.128 en el SDK de .NET 11 RC 1. Cada fila fue idéntica en ambas versiones. Las diferencias que importan están entre el binder por reflexión y el binder generado por código, no entre .NET 10 y 11.

## Por qué el binder omite una colección en silencio

El binder por reflexión en `ConfigurationBinder.cs` decide por cada propiedad si puede escribir en ella. La comprobación es breve: necesita un getter público y, para todo lo que tiene que *reemplazar* en lugar de *modificar*, también necesita un setter público (o `BinderOptions.BindNonPublicProperties = true`). Si la comprobación falla, `BindProperty` retorna sin decir nada.

Esa división entre "reemplazar" y "modificar" explica la mayoría de los casos confusos:

- Un **array** nunca se puede modificar en el lugar, porque tiene longitud fija. El binder construye un array nuevo y necesita un setter para guardarlo. `string[] Hosts { get; } = [];` se queda vacío para siempre.
- Un **`List<T>` o `IList<T>`** que ya contiene una instancia se puede modificar. El binder llama a `Add` sobre ella, así que un `List<string> Hosts { get; } = new();` de solo lectura se enlaza sin problemas.
- Un **`IReadOnlyList<T>`** o **`IEnumerable<T>`** no tiene `Add`. Con un setter, el binder crea un array nuevo y lo asigna. Sin setter, no pasa nada.

Los errores de conversión de elementos también se tragan. En `BindArray` y `BindCollection`, cada elemento se enlaza dentro de un `try`/`catch` que solo vuelve a lanzar cuando `ErrorOnUnknownConfiguration` está activado. Un valor como `"abc"` en un `int[]` simplemente desaparece del resultado.

## La matriz medida

La prueba enlaza `{ "App": { "Hosts": [ "a.example", "b.example" ] } }` en distintas formas de clase de opciones, una vez con el binder por reflexión predeterminado y otra con `EnableConfigurationBindingGenerator=true`:

```csharp
// .NET 10.0.12 / .NET 11 RC 1, Microsoft.Extensions.Configuration.Binder
class GetOnlyArray { public string[] Hosts { get; } = []; }
class GetOnlyList { public List<string> Hosts { get; } = new(); }
class GetOnlyRoList { public IReadOnlyList<string> Hosts { get; } = []; }
class FieldArray { public string[] Hosts = []; }
class PrivateSet { public string[] Hosts { get; private set; } = []; }
class InitOnly { public string[] Hosts { get; init; } = []; }
class Settable { public string[] Hosts { get; set; } = []; }
```

| Forma de la propiedad | Binder por reflexión | Source generator |
| --- | --- | --- |
| `string[] { get; }` | `[]` | `[]` |
| `List<string> { get; } = new()` | `[a, b]` | `[a, b]` |
| `IReadOnlyList<string> { get; } = []` | `[]` | `[]` |
| `IList<string> { get; } = new List<string>()` | `[a, b]` | `[a, b]` |
| campo público `string[]` | `[]` | `[]` |
| `string[] { get; private set; }` | `[]` | `[]` |
| lo mismo, `BindNonPublicProperties = true` | `[a, b]` | `NotSupportedException` |
| `string[] { get; init; }` | `[a, b]` | `[]` |
| `string[] { get; set; }` | `[a, b]` | `[a, b]` |
| `record Opts(string[] Hosts)` vía `Get<T>()` | `[a, b]` | `[a, b]` |
| `ImmutableArray<string> { get; set; }` | `[]` | `NullReferenceException` |

Tres filas merecen una segunda mirada. Los accesores `init` funcionan con reflexión y el generador los omite en silencio. `ImmutableArray<T>` nunca se llena. Y la compilación con el generador de esta prueba reportó **cero** advertencias, así que nada en tiempo de compilación te avisa de ninguno de los dos casos.

## Soluciónalo paso a paso

1. **Confirma la ruta de la sección.** `builder.Configuration.GetSection("App")` debe coincidir exactamente con el JSON hasta el nombre de la propiedad (la coincidencia no distingue mayúsculas de minúsculas, así que ese no es tu problema). Enlazar la raíz en lugar de la sección, el error más común, produjo `[]` en la prueba. Imprime lo que realmente contiene la configuración antes de culpar al binder:

   ```csharp
   // .NET 10 / 11
   foreach (var kv in builder.Configuration.GetSection("App").AsEnumerable())
       Console.WriteLine($"{kv.Key} = {kv.Value}");
   // Among the output you should see:
   // App:Hosts:0 = a.example
   // App:Hosts:1 = b.example
   ```

   Los arrays se aplanan en claves indexadas (`App:Hosts:0`, `App:Hosts:1`). Si faltan esas líneas, el problema está en el archivo (no se copia a la salida, nombre de entorno incorrecto, anidamiento incorrecto), no en la clase.

2. **Dale a la colección un setter público.** Esta es la solución para la mayoría de los reportes:

   ```csharp
   // .NET 10 / 11
   public sealed class AppOptions
   {
       public string[] Hosts { get; set; } = [];
       public List<EndpointOptions> Endpoints { get; set; } = [];
   }

   public sealed class EndpointOptions
   {
       public string Url { get; set; } = "";
   }
   ```

   Usa `get; set;`, no `init`, si existe alguna posibilidad de que el proyecto se publique con `PublishAot` o `PublishTrimmed` (ver más abajo). Evita `ImmutableArray<T>` en las clases de opciones. Si quieres semántica de solo lectura para los consumidores, expón `IReadOnlyList<T> { get; set; }`: el binder por reflexión le asigna un `string[]` y el generador le asigna un `List<T>`, y ambos se llenaron correctamente en la prueba.

3. **Haz que las discrepancias fallen de forma visible.** `ErrorOnUnknownConfiguration` lanza una excepción cuando la configuración tiene una clave sin propiedad correspondiente, y además impide que el binder se trague los errores de conversión de elementos:

   ```csharp
   // .NET 10 / 11
   builder.Services.AddOptions<AppOptions>()
       .Bind(builder.Configuration.GetSection("App"),
             o => o.ErrorOnUnknownConfiguration = true)
       .ValidateOnStart();
   ```

   Con `"Host": ["a"]` en el JSON (en singular) la prueba lanzó `InvalidOperationException: 'ErrorOnUnknownConfiguration' was set on the provided BinderOptions, but the following properties were not found on the instance of Settable: 'Host'`. Con `"Ports": [1, "abc", 3]` lanzó `'ErrorOnUnknownConfiguration' was set and binding has failed`, con la excepción interna `Failed to convert configuration value 'abc' at 'App:Ports:1' to type 'System.Int32'`. Sin la opción, el mismo enlace devolvió `[1, 3]`.

   Combínalo con validación para que una lista vacía sea un fallo al arrancar en lugar de un misterio en producción. [Validar opciones al arrancar con `IValidateOptions<T>`](/es/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) cubre en detalle la parte de `ValidateOnStart`.

4. **Deja de inicializar colecciones con valores predeterminados.** Consulta la siguiente sección: a los valores predeterminados se les agrega, no se reemplazan.

## El binder agrega a los valores predeterminados en lugar de reemplazarlos

Este es el bug con el que la gente se topa justo después de arreglar la lista vacía. Dale un valor predeterminado a la propiedad y enlaza una sección que tenga valores:

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public List<string> Hosts { get; set; } = ["localhost"];
}
// appsettings.json: "App": { "Hosts": [ "a.example", "b.example" ] }
// Result: [ "localhost", "a.example", "b.example" ]
```

Eso es lo que devolvió la prueba para `List<T>`, `string[]`, `IEnumerable<T>`, `IReadOnlyList<T>` y `HashSet<T>` por igual, y tanto para `Bind` como para `Get<T>()`. `BindArray` literalmente empieza copiando los elementos existentes en una lista nueva antes de agregar los configurados. Llamar a `Bind` dos veces sobre la misma instancia, por ejemplo desde un callback de change token, produjo `[a, b, a, b]`.

Es un comportamiento antiguo y deliberado. Una opción para sobrescribir colecciones existentes se propuso en [dotnet/runtime#62112](https://github.com/dotnet/runtime/issues/62112) en 2021 y sigue abierta en el milestone Future, al igual que [dotnet/runtime#118204](https://github.com/dotnet/runtime/issues/118204), así que no esperes un flag. Aplica los valores predeterminados *después* de enlazar, y solo cuando la configuración no aportó nada:

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public string[]? Hosts { get; set; }
}

builder.Services.Configure<AppOptions>(builder.Configuration.GetSection("App"));
builder.Services.PostConfigure<AppOptions>(o => o.Hosts ??= ["localhost"]);
```

En la prueba esto dio `[a, b]` cuando la sección existía y `[localhost]` cuando no. La fábrica de `IOptionsMonitor<T>` construye una instancia nueva en cada recarga, así que el paso de post-configuración se ejecuta sobre un estado limpio cada vez. [IOptions vs IOptionsSnapshot vs IOptionsMonitor](/es/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) explica cuándo se crea cada una de esas instancias.

## Los archivos en capas combinan los arrays por índice

`appsettings.Development.json` no reemplaza un array de `appsettings.json`. Los proveedores de configuración solo aportan claves, y el último proveedor que establece una clave determinada gana. Un array no es más que las claves `0`, `1`, `2`. La prueba superpuso estos dos archivos:

```json
// appsettings.json
{ "App": { "Hosts": [ "a", "b", "c" ] } }
```

```json
// appsettings.Development.json
{ "App": { "Hosts": [ "dev1", "dev2" ] } }
```

El resultado enlazado fue `[dev1, dev2, c]`. El índice 2 sigue viniendo del archivo base. Lo mismo ocurre con las variables de entorno (`App__Hosts__0=env.example` reemplazó solo el primer elemento) y con los argumentos de línea de comandos (`--App:Hosts:2=cli.example` agregó un tercero). La documentación de configuración de ASP.NET Core lo señala y sugiere mantener los índices alineados entre las fuentes.

Dos cosas que podrías intentar para vaciar el array base no funcionan:

- Un array vacío `"Hosts": []` en el archivo de sobrescritura: el resultado siguió siendo `[a, b]`.
- `"Hosts": null` en el archivo de sobrescritura: también `[a, b]`.

Lo que sí funciona es no definir ese array en el archivo base, definir el array completo en cada archivo de entorno, o guardar el valor como una sola cadena delimitada y dividirla en `PostConfigure`. Un `"Hosts": "a.example,b.example"` simple enlazado directamente a `string[]` da `[]`, el binder no divide cadenas por ti.

## Native AOT y trimming cambian el binder sin que te des cuenta

El SDK de .NET activa automáticamente el source generator de enlace de configuración para aplicaciones con trimming. De `Microsoft.NET.Sdk.FrameworkReferenceResolution.targets` en el SDK 10.0.302:

```xml
<PropertyGroup Condition="'$(PublishTrimmed)' == 'true' Or '$(PublishAot)' == 'true'">
  <EnableRequestDelegateGenerator Condition="'$(EnableRequestDelegateGenerator)' == ''">true</EnableRequestDelegateGenerator>
  <EnableConfigurationBindingGenerator Condition="'$(EnableConfigurationBindingGenerator)' == ''">true</EnableConfigurationBindingGenerator>
</PropertyGroup>
```

El generador intercepta tus llamadas a `Bind`, `Get<T>` y `Configure<T>` en tiempo de compilación. Así es como Native AOT obtiene enlace sin reflexión, pero es una implementación distinta, y la prueba encontró cuatro diferencias de comportamiento:

| Caso | Reflexión | Source generator |
| --- | --- | --- |
| `string[] { get; init; }` | se enlaza | se omite en silencio |
| `BindNonPublicProperties = true` | enlaza setters privados | `NotSupportedException` |
| `"Ports": [1, "abc", 3]` en `int[]` | `[1, 3]` | `InvalidOperationException: Failed to convert configuration value 'abc'` |
| `"Ports": [1, null, 3]` en `int[]` | `InvalidCastException` | `[1, 3]` |
| `ImmutableArray<string>` | `[]` | `NullReferenceException` |

Así que una aplicación que se enlaza sin problemas con `dotnet run` puede enlazarse de otra forma después de que alguien agregue `<PublishAot>true</PublishAot>` al proyecto. Si estás migrando a AOT, establece `<EnableConfigurationBindingGenerator>true</EnableConfigurationBindingGenerator>` explícitamente también en Debug, para que tus pruebas ejerciten el mismo binder que producción. [Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) cubre los otros generadores que se activan al mismo tiempo. Las aplicaciones basadas en archivo (`dotnet run app.cs`) usan `PublishAot=true` de forma predeterminada, así que una prueba rápida escrita de esa manera ya está ejecutando el generador a menos que agregues `#:property PublishAot=false`.

## Otros casos que conviene conocer

- **Los índices dispersos se compactan.** Las claves `App:Hosts:0` y `App:Hosts:5` se enlazaron a `[a, f]`, un array de dos elementos, no seis elementos con huecos. El ejemplo de la documentación para el índice 3 faltante muestra lo mismo.
- **Las claves de objeto funcionan como índices.** `"Hosts": { "x": "a", "y": "b" }` se enlazó a `[a, b]`. Por eso un objeto JSON donde querías un array no falla.
- **Los elementos de cadena null sobreviven.** `["a", null, "c"]` en `string[]` dio `[a, null, c]` con ambos binders, aunque la documentación de ASP.NET Core dice que el binder no puede crear entradas `null`. No dependas de ninguno de los dos comportamientos; filtra los null en `PostConfigure` o en la validación.
- **El enlace por constructor funciona para colecciones.** `record AppOptions(string[] Hosts)` y los tipos de elemento con solo un constructor con parámetros (`class Endpoint(string url)`) se enlazaron correctamente con `Get<T>()` en ambos modos.
- **`Get<string[]>()` sobre la propia sección del array** (`GetSection("App:Hosts").Get<string[]>()`) es una forma rápida de comprobar los datos independientemente de tu clase de opciones.

## Cómo probar tu propia clase de opciones

Mantén una prueba unitaria que enlace tu `appsettings.json` real en tu tipo de opciones real, con la misma configuración del generador que en producción:

```csharp
// .NET 10 / 11, xUnit
[Fact]
public void AppOptions_binds_hosts()
{
    var config = new ConfigurationBuilder()
        .AddJsonFile("appsettings.json")
        .Build();

    var options = config.GetSection("App")
        .Get<AppOptions>(o => o.ErrorOnUnknownConfiguration = true);

    Assert.NotNull(options);
    Assert.Equal(new[] { "a.example", "b.example" }, options.Hosts);
}
```

Para una cobertura de extremo a extremo que incluya archivos específicos de entorno y variables de entorno, las [pruebas de integración con WebApplicationFactory](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) te permiten resolver `IOptions<AppOptions>` desde el host real.

## Relacionado

- [Cómo validar opciones al arrancar con IValidateOptions<T> en .NET 11](/es/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) convierte una lista vacía en un error de arranque.
- [IOptions<T> vs IOptionsSnapshot<T> vs IOptionsMonitor<T> en .NET 11](/es/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) para saber cuándo se crean y se reconstruyen las instancias enlazadas.
- [Cómo usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para los otros source generators que AOT habilita.
- [Cómo escribir pruebas de integración con WebApplicationFactory<T> en ASP.NET Core 11](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) para probar la configuración contra el host real.

## Fuentes

- [Configuración en ASP.NET Core: enlazar un array](https://learn.microsoft.com/aspnet/core/fundamentals/configuration/#bind-an-array), Microsoft Learn
- [Source generator de enlace de configuración](https://learn.microsoft.com/dotnet/core/extensions/configuration-generator), Microsoft Learn
- [`ConfigurationBinder.cs` en v10.0.12](https://github.com/dotnet/runtime/blob/v10.0.12/src/libraries/Microsoft.Extensions.Configuration.Binder/src/ConfigurationBinder.cs), dotnet/runtime
- [dotnet/runtime#62112: permitir sobrescribir opcionalmente instancias existentes de colecciones mutables](https://github.com/dotnet/runtime/issues/62112)
- [dotnet/runtime#118204: la combinación predeterminada de arrays de configuración es confusa y propensa a errores](https://github.com/dotnet/runtime/issues/118204)
- [`Microsoft.Extensions.Configuration.Binder` en NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Configuration.Binder), versiones 10.0.12 y 11.0.0-rc.1.26425.128 probadas
