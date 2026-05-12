---
title: "Solución: System.IO.FileNotFoundException: Could not load file or assembly en una aplicación publicada"
description: "Funciona con dotnet run y falla tras dotnet publish. La DLL suele faltar en la carpeta de publicación, no en el runtime. Revise deps.json, Private en ProjectReference y el trimming."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "publish"
  - "trimming"
lang: "es"
translationOf: "2026/05/fix-could-not-load-file-or-assembly-in-published-app"
translatedBy: "claude"
translationDate: 2026-05-12
---

La solución: un `FileNotFoundException: Could not load file or assembly` después de `dotnet publish` casi siempre significa que la DLL no está en la carpeta de publicación, no que el runtime no logre encontrarla. Liste la salida de publish, ubique el ensamblado faltante por nombre y trátelo como un fallo de empaquetado. Las cuatro causas que cubren el noventa por ciento de los reportes reales son un `ProjectReference` marcado con `Private=false`, un `PackageReference` con `PrivateAssets="all"`, el trimming descartando un ensamblado cargado por reflexión, y un publish self-contained frente a framework-dependent que elige el RID incorrecto. Establezca `COREHOST_TRACE=1`, ejecute el binario publicado una vez y el log del host le mostrará qué ruta de prueba intentó.

```text
Unhandled exception. System.IO.FileNotFoundException: Could not load file or assembly 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified.
File name: 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'
   at MyApp.Program.Main(String[] args)

--- End of stack trace from previous location ---
   at System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw()
   at System.Runtime.CompilerServices.TaskAwaiter.ThrowForNonSuccess(Task task)
```

Esta guía está escrita contra .NET 11 preview 4 (runtime `Microsoft.NETCore.App` 11.0.0-preview.4) y el .NET SDK 11.0.100-preview.4 en Windows, Linux y macOS. El tipo de excepción, la identidad de cuatro partes del ensamblado en el mensaje y las reglas de sondeo del host no han cambiado desde .NET Core 3.0; lo que cambió en .NET 8 y .NET 11 fue el analizador del trimmer, que ahora emite advertencias `IL2026` / `IL3050` de entrada, para que deje de descubrir esto en tiempo de ejecución. Si el mensaje dice `Could not load file or assembly` seguido de `or one of its dependencies`, la dependencia es el archivo que falta, no el que aparece primero. Lea la segunda cláusula antes de tocar nada.

## Por qué el runtime no encuentra el ensamblado

El host de .NET (`dotnet.exe` o el stub de apphost generado junto a su `.exe` en `dotnet publish`) carga ensamblados desde un conjunto fijo de rutas de sondeo derivadas de su `<app>.deps.json`. No busca en `PATH`, no busca en la GAC y no recurre a la carpeta bin del proyecto que lo compiló. Las rutas que prueba son, en orden:

1. El directorio del apphost (`AppContext.BaseDirectory`).
2. El directorio del framework compartido para aplicaciones framework-dependent (`{DOTNET_ROOT}/shared/Microsoft.NETCore.App/{version}`).
3. Las carpetas de fallback de NuGet si la resolución `useNuGet` está activa (solo desarrollo).
4. Lo que se declare en `additionalProbingPaths` dentro de `<app>.runtimeconfig.dev.json`, que **no** está presente en una aplicación publicada.

Cuando la máquina de desarrollo tiene el ensamblado en la caché de NuGet y el runtimeconfig apunta allí, `dotnet run` lo encuentra. La aplicación publicada no tiene ni la caché ni el runtimeconfig de desarrollo, por lo que la misma llamada lanza la excepción. La excepción es el host diciéndole que la identidad del ensamblado en `<app>.deps.json` no se resolvió a ningún archivo en disco.

La página oficial de Microsoft Learn [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) es la referencia autoritativa para el orden de sondeo; las [instrucciones de tracing del host](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) describen cómo volcar el log de sondeo a un archivo.

## Una reproducción mínima

```xml
<!-- .NET 11, SDK 11.0.100-preview.4 -->
<!-- src/MyApp/MyApp.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
      <Private>false</Private>
    </ProjectReference>
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14
using Contoso.Shared;

var greeter = new Greeter();
Console.WriteLine(greeter.Hello("world"));
```

`dotnet run` funciona. `dotnet publish -c Release -r win-x64 -o ./out` termina sin errores. `./out/MyApp.exe` lanza `Could not load file or assembly 'Contoso.Shared'`. La marca `<Private>false</Private>` le indica a MSBuild que no copie `Contoso.Shared.dll` a la salida del consumidor, asumiendo que la GAC o algún otro vehículo de despliegue lo aportará. Para aplicaciones .NET (Core) no existe GAC, así que el archivo simplemente está ausente.

Esta es la forma canónica del bug: una sola propiedad en algún lugar del grafo de proyectos le dice a MSBuild que no incluya la DLL, y el paso de publish lo respeta. La solución es localizar la propiedad y eliminarla.

## Solución 1: deje de suprimir la copia

Abra el archivo de proyecto del padre del ensamblado faltante y busque cualquiera de estas propiedades en la referencia:

```xml
<!-- These three lines all suppress the copy. Remove them. -->
<ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
  <Private>false</Private>
</ProjectReference>

<Reference Include="Contoso.Shared">
  <CopyLocal>false</CopyLocal>
</Reference>

<PackageReference Include="Some.Library" Version="1.0.0">
  <PrivateAssets>all</PrivateAssets>
</PackageReference>
```

`Private=false` y `CopyLocal=false` son equivalentes para referencias de proyecto y de ensamblado. `PrivateAssets="all"` en un `PackageReference` significa que el activo se consume en tiempo de compilación pero no fluye al proyecto consumidor, así que la DLL se omite de `deps.json`. El uso legítimo de `PrivateAssets="all"` es para paquetes de analyzers, generadores de código fuente y tareas de compilación (donde el runtime nunca necesita la DLL). Si el paquete es `Microsoft.Extensions.Logging.Abstractions` o cualquier otro que llame en tiempo de ejecución, la marca es incorrecta. Quítela, ejecute `dotnet publish` y confirme que la DLL ahora aparece junto a su aplicación.

La página de MS Learn [Controlling dependency assets](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) lista todos los valores que acepta `PrivateAssets` y qué deshabilita cada uno.

## Solución 2: active el tracing del host y lea el log de sondeo

Si no sabe qué DLL falta, pregúntele al host. Defina `COREHOST_TRACE=1` y `COREHOST_TRACEFILE=corehost.log` antes de lanzar el binario publicado:

```powershell
# Windows, PowerShell, .NET 11
$env:COREHOST_TRACE = "1"
$env:COREHOST_TRACE_VERBOSITY = "4"
$env:COREHOST_TRACEFILE = "corehost.log"
./out/MyApp.exe
```

```bash
# Linux / macOS, bash, .NET 11
COREHOST_TRACE=1 COREHOST_TRACE_VERBOSITY=4 COREHOST_TRACEFILE=corehost.log ./out/MyApp
```

El log es extenso pero la sección que debe buscar es `Attempting to load`. Cada intento se registra con la ruta completa que probó el host. El último intento fallido antes de la excepción es la respuesta:

```text
Attempting to load: C:\out\Contoso.Shared.dll - false
Attempting to load: C:\out\runtimes\win-x64\lib\net11.0\Contoso.Shared.dll - false
File [C:\out\Contoso.Shared.dll] does not exist
```

Ahora sabe que el host esperaba `Contoso.Shared.dll` directamente bajo la carpeta de la aplicación y no lo encontró. La solución es lograr que la salida de publish incluya el archivo en esa ruta, no agregar rutas de sondeo o contextos de carga.

## Solución 3: cuando el trimming descarta el ensamblado en silencio

Recortar (trimming) una aplicación self-contained de .NET 11 elimina cualquier ensamblado que el trimmer no pueda probar como alcanzable mediante análisis estático. `Assembly.Load("Plugins.Foo")`, `Type.GetType("Some.Type, Some.Assembly")` y la mayoría de contenedores DI basados en reflexión son invisibles para el trimmer. El ensamblado se excluye de la salida de publish y aparece en tiempo de ejecución como `FileNotFoundException`.

Para confirmar que el trimming es la causa, publique una vez con las advertencias del trimmer convertidas en fatales:

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <TrimmerSingleWarn>false</TrimmerSingleWarn>
  <SuppressTrimAnalysisWarnings>false</SuppressTrimAnalysisWarnings>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

Si ahora la publicación falla con `IL2026` o `IL3050` señalando el punto donde su código hace reflexión, el trimming es la causa. La solución es enraizar el ensamblado para que el trimmer lo conserve:

```xml
<!-- .NET 11 -->
<ItemGroup>
  <TrimmerRootAssembly Include="Plugins.Foo" />
</ItemGroup>
```

Para un tipo individual, marque el método que dispara la carga con `DynamicDependencyAttribute`:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public static class PluginLoader
{
    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicConstructors, "Plugins.Foo.Entry", "Plugins.Foo")]
    public static object Load() => Activator.CreateInstance(Type.GetType("Plugins.Foo.Entry, Plugins.Foo")!)!;
}
```

La lista completa de raíces del trimmer y atributos de dependencia está en [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming). Para una mirada más profunda al lado del runtime, el artículo [Native AOT con ASP.NET Core minimal APIs](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) recorre las mismas advertencias del trimmer en una forma más agresiva.

## Solución 4: RID equivocado, o framework-dependent publicado como self-contained

Si el ensamblado listado en el error es `Microsoft.NETCore.App` o uno de sus componentes (`System.Private.CoreLib.dll`, `System.Runtime.dll`), el problema no es su código, es que la aplicación publicada es framework-dependent pero la máquina objetivo no tiene un framework compartido compatible instalado:

```text
Could not load file or assembly 'System.Runtime, Version=11.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
```

Este mensaje significa que el host encontró `MyApp.dll`, leyó `MyApp.runtimeconfig.json` y luego pidió `Microsoft.NETCore.App 11.0.0` sin obtener nada. O bien instale el framework compartido en la máquina objetivo (`dotnet --list-runtimes`), o vuelva a publicar como self-contained:

```bash
# .NET 11
dotnet publish -c Release -r win-x64 --self-contained true -o ./out
```

El runtime envía cada DLL del framework a `./out`, la aplicación deja de depender del runtime instalado en la máquina, y la FileNotFoundException desaparece. El artículo correspondiente [reducir el tiempo de arranque en frío de un AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) discute las compensaciones del publish (tamaño vs portabilidad vs cold start) con más profundidad.

El otro fallo con forma de RID es un paquete NuGet con binarios nativos que solo distribuye algunos RIDs. Si publica para `osx-arm64` pero un paquete solo lleva nativos `win-x64` y `linux-x64`, el `runtimes/win-x64/native/foo.dll` del paquete se excluye de su publish y el wrapper administrado lanza `FileNotFoundException`. La solución es reportar el hueco al mantenedor del paquete o fijar una versión que distribuya el RID que necesita. La carpeta `runtimes/` del paquete es la fuente de verdad.

## Sutilezas y casos parecidos

**`Could not load file or assembly 'X' or one of its dependencies`.** El ensamblado nombrado está en disco. Una de sus dependencias no. Ejecute `dotnet-dump analyze` o `dnSpy` contra `X.dll` para leer su lista de ensamblados referenciados, o use el trace del host de la Solución 2 para encontrar el fallo de segundo nivel. Tratar el primer nombre como el archivo faltante lo hace dar vueltas en círculos.

**`FileLoadException`, no `FileNotFoundException`.** Un `FileLoadException: Could not load file or assembly 'X, Version=2.0.0.0'` significa que el archivo está presente, pero la versión, la cultura o el public key token no coinciden con lo solicitado. Este es un problema de redirección de enlace de ensamblados (común cuando una dependencia transitiva se actualiza solo en el nivel superior). La solución es añadir una versión coincidente al `PackageReference` de nivel superior para que el grafo resuelto colapse a una sola versión. El runtime ya no lee las redirecciones de enlace de `app.config` en .NET (Core); solo lo hacía el runtime de .NET Framework. Si migró desde `app.config`, las redirecciones se ignoran ahora y la versión resuelta desde `deps.json` es la que se carga.

**`TypeLoadException` y `MissingMethodException`.** No son errores de "ensamblado no encontrado". Significan que el ensamblado se cargó, pero el tipo o método dentro de él tiene una firma diferente de la que el llamador esperaba, casi siempre un desajuste de versión. La forma de la solución es la misma que para `FileLoadException`: alinear el grafo de versiones.

**`BadImageFormatException`.** El archivo está en disco y tiene el nombre correcto, pero es de la arquitectura incorrecta (una DLL `x86` cargada en un proceso `x64`, o una DLL administrada cargada como nativa). Revise el RID y la `Platform` de ambos lados. Es una categoría hermana, no un `FileNotFoundException` disfrazado.

**Publicación en un solo archivo.** Con `PublishSingleFile=true`, el apphost extrae los ensamblados empaquetados a una carpeta temporal en el primer arranque (`%TEMP%/.net/<appname>/<hash>`). Si ve `FileNotFoundException` para un ensamblado que sí ve dentro del bundle (`dotnet-bundle list`), la causa más común es una llamada personalizada `AssemblyLoadContext.LoadFromAssemblyPath(Assembly.GetExecutingAssembly().Location)`. `Assembly.Location` está vacío para bundles de un solo archivo en .NET 6+, así que el argumento de ruta es incorrecto. Cambie a `AppContext.BaseDirectory`, o use `Assembly.LoadFromAssemblyName` y deje que el host resuelva el archivo empaquetado.

**Despliegue de ASP.NET Core en IIS.** Si la publicación envía el archivo pero IIS aún lanza la excepción, verifique que la `Identity` del application pool tenga acceso de lectura a la carpeta de publish y que `aspnetcorev2.dll` esté en la versión actual (`%programfiles%\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll`). Un ANCM obsoleto toma un `deps.json` viejo. Es un problema de despliegue, no de build.

**Plugins / contextos dinámicos de carga.** Si carga plugins vía `AssemblyLoadContext`, el contexto del plugin no hereda los ensamblados del contexto por defecto. Un plugin que llama a `Newtonsoft.Json` necesita su propio `Newtonsoft.Json.dll` al lado del plugin, o un `AssemblyDependencyResolver` construido a partir de la ruta del plugin. La misma forma que la Solución 1, pero la superficie es la carpeta del plugin, no la de la aplicación. El recorrido de MS Learn en [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) muestra el patrón del resolver de principio a fin.

**El build lo copió, el publish no.** Publish ejecuta un conjunto de targets de MSBuild distinto al de build (`ComputeFilesToPublish` en lugar de `BuiltProjectOutputGroup`). Un `<Content Include="Foo.dll" CopyToOutputDirectory="PreserveNewest" />` pone el archivo en `bin/`, pero solo `<None Include="Foo.dll"><Pack>true</Pack><CopyToPublishDirectory>PreserveNewest</CopyToPublishDirectory></None>` (o `<Content>` con la marca de publish) lo coloca en la carpeta de publish. Si la DLL aparece en `bin/Release/net11.0/` pero no en `bin/Release/net11.0/publish/`, esta es la causa.

## Relacionados

- [Solución: No se puede encontrar el tipo o el espacio de nombres después de una referencia de proyecto](/es/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) es el primo en tiempo de compilación de esta excepción: los mismos desajustes de `Private` y `TargetFramework` aparecen como `CS0246` en el build, o como `FileNotFoundException` en tiempo de ejecución.
- [Solución: MSBuild MSB3027 could not copy exceeded retry count](/es/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) cubre el fallo de copia hermano en tiempo de publish que lo deja con media carpeta publicada.
- [Solución: PlatformNotSupportedException en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/) es el caso parecido de trim-and-publish donde el ensamblado está presente pero falta un camino de código.
- [Cómo reducir el tiempo de arranque en frío de un AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) discute las compensaciones self-contained vs framework-dependent para el mismo paso de publish.
- [Cómo usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) es la mirada más profunda a las advertencias del trimmer que atrapan esta clase de bug en tiempo de compilación.

## Fuentes

- [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) (MS Learn)
- [Host tracing in the .NET runtime host](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) (`dotnet/runtime`)
- [Controlling dependency assets with PackageReference](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) (MS Learn)
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming) (MS Learn)
- [`DynamicDependencyAttribute` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicdependencyattribute) (MS Learn)
- [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) (MS Learn)
- [`AppContext.BaseDirectory` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.appcontext.basedirectory) (MS Learn)
