---
title: "Solución: MSB4057 The target \"ResolvePackageAssets\" does not exist in the project en .NET MAUI"
description: "MSB4057 significa que un target se ejecutó contra la compilación externa cross-targeting de un proyecto multi-target de MAUI. Pasa un TFM o condiciona el target con TargetFramework."
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "dotnet-maui"
  - "msbuild"
  - "dotnet-10"
lang: "es"
translationOf: "2026/08/fix-msb4057-the-target-resolvepackageassets-does-not-exist-in-the-project"
translatedBy: "claude"
translationDate: 2026-08-13
---

`ResolvePackageAssets` no falta y tus paquetes no están dañados. El target se ejecutó contra la **compilación externa (cross-targeting)** de un proyecto multi-target, y el SDK de .NET no importa `ResolvePackageAssets` ahí. O fijas un solo framework (`dotnet build -f net10.0-android -t:ResolvePackageAssets`), o, si el archivo `.targets` de un paquete NuGet lo está llamando, condicionas ese target con `Condition="'$(TargetFramework)' != ''"` para que solo se ejecute en las compilaciones internas. Borrar `bin` y `obj` no va a ayudar.

Todo lo que sigue está verificado en .NET SDK 10.0.201 (MSBuild 18.3.0) con los workloads `maui-android` / `maui-ios` / `maui-maccatalyst` 10.0.20. El mecanismo de cross-targeting no cambia en .NET 11.

## El error en contexto

```text
C:\src\MauiApp1\MauiApp1.csproj : error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

Build FAILED.
    0 Warning(s)
    1 Error(s)
```

Cuando el disparador es un paquete NuGet, el error trae un archivo y una columna en lugar de la ruta del proyecto, y esa es la señal de que quien lo pidió fue un archivo `.targets`, no tú:

```text
C:\Users\me\.nuget\packages\ikvm.maven.sdk\1.9.2\buildTransitive\IKVM.Maven.Sdk.targets(37,64):
  error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

## Por qué MSB4057 aparece en un proyecto multi-target

Una aplicación MAUI tiene `TargetFrameworks` (en plural):

```xml
<!-- .NET 10, MAUI 10 app csproj, from dotnet new maui -->
<TargetFrameworks>net10.0-android</TargetFrameworks>
<TargetFrameworks Condition="!$([MSBuild]::IsOSPlatform('linux'))">$(TargetFrameworks);net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
<TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net10.0-windows10.0.19041.0</TargetFrameworks>
```

MSBuild compila ese proyecto **dos veces sobre sí mismo**: una pasada externa que no hace más que repartir el trabajo, y una pasada interna por cada framework. El SDK decide en cuál estás con una sola propiedad, definida en `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets`:

```xml
<!-- .NET SDK 10.0.201, Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets -->
<PropertyGroup Condition="'$(TargetFrameworks)' != '' and '$(TargetFramework)' == ''">
  <IsCrossTargetingBuild>true</IsCrossTargetingBuild>
</PropertyGroup>

<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.CrossTargeting.targets"
        Condition="'$(IsCrossTargetingBuild)' == 'true'"/>
<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.targets"
        Condition="'$(IsCrossTargetingBuild)' != 'true'"/>
```

Ese último par lo explica todo. `ResolvePackageAssets` está definido en `Microsoft.PackageDependencyResolution.targets`, que se importa desde `Microsoft.NET.Sdk.targets`, que se importa **solo cuando `IsCrossTargetingBuild` no es true**. En la compilación externa obtienes `Microsoft.NET.Sdk.CrossTargeting.targets` en su lugar, y el conjunto completo de targets disponibles se reduce a esto:

- De `Microsoft.Common.CrossTargeting.targets`: `Build`, `Clean`, `Rebuild`, `DispatchToInnerBuilds`, `GetTargetFrameworks`, `GetTargetFrameworksWithPlatformFromInnerBuilds`, `InitializeSourceControlInformation`
- De `Microsoft.NET.Sdk.CrossTargeting.targets`: `Publish`, `GetAllRuntimeIdentifiers`, `GetPackagingOutputs`
- De `Microsoft.NET.Sdk.Workloads.CrossTargeting.targets`: `_GetRequiredWorkloads`

Pide cualquier cosa fuera de esa lista contra la compilación externa y MSBuild lanza MSB4057. `ResolvePackageAssets`, `GetTargetPath`, `GetCopyToOutputDirectoryItems` y `ComputeFilesToPublish` están todos fuera. Por eso también el mismo texto de error aparece como `The target "GetTargetPath" does not exist in the project` cuando el AppHost de .NET Aspire intenta orquestar un proyecto MAUI: mismo mecanismo, distinto nombre de target.

## Reproducción mínima

No necesitas MAUI para verlo. Cualquier proyecto con `TargetFrameworks` en plural se comporta igual, lo que reduce esto a dos archivos:

```xml
<!-- MultiLib/MultiLib.csproj, .NET SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net10.0;net9.0</TargetFrameworks>
  </PropertyGroup>
</Project>
```

```bash
# .NET SDK 10.0.201
# outer build: no -f, so TargetFramework is empty
dotnet build -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

# inner build: -f selects one framework
dotnet build -t:ResolvePackageAssets -f net10.0
# Build succeeded.
```

Los mismos dos comandos contra una aplicación `dotnet new maui` recién creada fallan y funcionan igual, con `-f net10.0-android`.

## ¿Cómo confirmo que estoy en una compilación externa?

Antes de ponerte a editar archivos de proyecto, comprueba en cuál compilación estás. El modificador `-getProperty` evalúa el proyecto sin compilarlo, así que es instantáneo incluso en una aplicación MAUI:

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:IsCrossTargetingBuild -getProperty:TargetFramework
```

En una aplicación MAUI sin framework seleccionado:

```json
{
  "Properties": {
    "IsCrossTargetingBuild": "true",
    "TargetFramework": ""
  }
}
```

`IsCrossTargetingBuild: true` confirma que MSB4057 es el problema de cross-targeting y no un error de tipeo. Agrega `-p:TargetFramework=net10.0-android` y el mismo comando devuelve un `IsCrossTargetingBuild` vacío, lo que significa que la compilación interna tiene el conjunto completo de targets del SDK. Para ver entre qué frameworks puedes elegir, pídelos directamente:

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:TargetFrameworks
# net10.0-android;net10.0-ios;net10.0-maccatalyst;net10.0-windows10.0.19041.0
```

Si `IsCrossTargetingBuild` vuelve vacío y aun así obtienes MSB4057, salta a la sección del proyecto que no es de estilo SDK: es otra causa raíz con el mismo código de error.

## ¿Cómo evito que el archivo .targets de un paquete NuGet rompa la compilación externa?

Esta es la solución para la gran mayoría de los reportes en MAUI, porque es la que te encuentras sin haber pedido ningún target por nombre. Un paquete NuGet (o tu propio `Directory.Build.targets`) se engancha a `AfterTargets="Build"` y declara una dependencia de `ResolvePackageAssets`. En las compilaciones internas eso está bien. Después se ejecuta el target `Build` externo, `AfterTargets="Build"` se dispara de nuevo, y la dependencia no resuelve:

```xml
<!-- Directory.Build.targets, broken on a multi-targeted project -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

Un `dotnet build` normal contra el `MultiLib` de arriba produce exactamente esto, y el orden es la pista clave:

```text
ran for TF=[net9.0]
ran for TF=[net10.0]
Directory.Build.targets(4,11): error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
Build FAILED.
```

Las dos compilaciones internas funcionaron y *después* falló la pasada externa. Si tu registro de compilación muestra el trabajo por framework completándose y *luego* MSB4057, este es tu caso. Agrega la condición:

```xml
<!-- Directory.Build.targets, fixed. .NET SDK 10.0.201 -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets"
          Condition="'$(TargetFramework)' != ''">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

Ahora la misma compilación reporta `ran for TF=[net9.0]`, `ran for TF=[net10.0]`, `Build succeeded.` La condición es el idioma canónico del SDK para decir "solo en la compilación interna", y es lo que el paquete debería haber publicado. Si el target problemático vive dentro de un paquete en `~/.nuget/packages/<id>/<ver>/build*/`, no lo edites ahí: la siguiente restauración sobrescribe tu cambio. Reporta el bug al proyecto original y, mientras tanto, deshabilita la importación localmente.

## ¿Cómo invoco un solo target desde la CLI?

Si eres tú quien escribe `-t:`, nombra un framework:

```bash
# .NET SDK 10.0.201, MAUI 10
dotnet build -t:ResolvePackageAssets -f net10.0-android
```

Esto importa para scripts y pasos de CI que llaman targets individuales para inspeccionar una compilación. `dotnet build` y `dotnet publish` sin `-t:` son seguros por sí solos, porque `Build` y `Publish` existen ambos en el conjunto de cross-targeting y saben repartir el trabajo.

## ¿Cómo llamo a un target de otro proyecto con la tarea MSBuild?

Cuando un proyecto ejecuta un target sobre otro (herramientas propias, los targets de orquestación de un SDK, un paso de empaquetado), la tarea `MSBuild` hereda la misma regla. Esto falla:

```xml
<!-- broken: no framework selected on the callee -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj" Targets="GetTargetPath">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

```text
MultiLib.csproj : error MSB4057: The target "GetTargetPath" does not exist in the project.
```

Define la propiedad en la llamada y se resuelve:

```xml
<!-- fixed. .NET SDK 10.0.201 -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj"
           Targets="GetTargetPath"
           Properties="TargetFramework=net10.0">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

Si no quieres dejar un framework fijo en el código, llama primero a `GetTargetFrameworks` (existe en la compilación externa, que es justamente para lo que sirve) y luego recorre el resultado.

## ¿Necesito cambiar un ProjectReference hacia un proyecto multi-target?

Un `ProjectReference` normal hacia un proyecto multi-target **no** produce MSB4057. MSBuild negocia automáticamente un framework compatible, y una aplicación de consola `net10.0` que referencia la biblioteca `net10.0;net9.0` de arriba compila sin problemas. Solo necesitas intervenir cuando la negociación no puede elegir un ganador, algo común cuando un proyecto de pruebas o de herramientas referencia el head de una aplicación MAUI. Usa `SetTargetFramework`:

```xml
<!-- .NET SDK 10.0.201 -->
<ItemGroup>
  <ProjectReference Include="..\MultiLib\MultiLib.csproj"
                    SetTargetFramework="TargetFramework=net9.0" />
</ItemGroup>
```

Eso fuerza la referencia hacia una única compilación interna, y `MultiLib.dll` aterriza en el directorio de salida del consumidor como esperas. Si en lugar de MSB4057 ves `NETSDK1005: Assets file doesn't have a target for ...`, eso es la negociación fallando en vez de un target ausente, y `SetTargetFramework` sigue siendo la solución.

## ¿Y si el proyecto no es de estilo SDK?

Hay una segunda ruta, no relacionada, hacia el mismo código de error. Un `.csproj` heredado que importa `Microsoft.CSharp.targets` directamente nunca importa los targets del SDK de .NET, así que `ResolvePackageAssets` no existe en **ninguna** pasada:

```xml
<!-- legacy non-SDK csproj -->
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>
  </PropertyGroup>
  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />
</Project>
```

```bash
# .NET SDK 10.0.201
dotnet msbuild -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

Esto es lo que golpea a quienes agregan un paquete NuGet consciente del SDK (IKVM.Maven.SDK es el ejemplo recurrente) a una biblioteca de clases antigua, o a quienes mantienen un proyecto de binding de la era Xamarin dentro de una solución MAUI. Aquí `IsCrossTargetingBuild` está vacío, así que el diagnóstico de arriba distingue ambos casos con un solo comando. La solución es convertir el proyecto a estilo SDK, o dejar de referenciar paquetes que asumen targets del SDK. Migrar esos restos suele ser lo correcto de todos modos si ya estás pasando de Xamarin.Forms 5.0 a .NET MAUI 11.

## Detalles y errores parecidos que aterrizan en esta página por equivocación

**MSB4018: The "ResolvePackageAssets" task failed unexpectedly.** Otro error, otra causa. El target existe y *se ejecutó*; la tarea lanzó una excepción. Eso suele ser un `project.assets.json` corrupto o un paquete ilegible en la caché global, y es el único caso donde borrar `obj/` y volver a ejecutar `dotnet restore` sirve de verdad.

**"The ResolvePackageAssets task was not given a value for the required parameter TargetFramework."** También es confusión entre compilación interna y externa, pero significa que se llegó al target con un `TargetFramework` vacío en lugar de no encontrarlo. Misma solución: selecciona un framework.

**MSB4057 desde `dotnet ef` en .NET 10.** Registrado como una regresión de la herramienta `dotnet-ef` 10 en [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230), corregida para el hito 10.0.2. Si te topas con esto, fija la versión de la herramienta en lugar de reestructurar tu proyecto:

```bash
# workaround for the dotnet-ef 10 regression
dotnet tool update --global dotnet-ef --version 9.0.10
```

**MSB4057 nombrando un target que escribiste tú.** Entonces sí que falta el target o está mal escrito, que es el caso que describe [MSB4057 en la documentación de MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057). Revisa la escritura de `BeforeTargets`, `AfterTargets`, `DependsOnTargets` y `CallTarget`, y comprueba que ninguna `Condition` en la definición del target lo haya excluido.

**Orquestación de Aspire sobre un head de MAUI.** [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043) es el mismo problema de compilación externa saliendo a la superficie como `The target "GetTargetPath" does not exist`. No hay solución limpia de tu lado: una aplicación MAUI no es un recurso servible de Aspire, así que quítala del AppHost y referencia en su lugar una biblioteca de clases compartida de un solo target.

## ¿Qué targets pertenecen a la compilación interna?

Todo lo que se meta dentro de un proyecto a buscar entradas del compilador, activos de paquetes o rutas de salida pertenece a la compilación interna. Si un target tuyo toca `ResolvePackageAssets`, `@(ReferencePath)` o `$(TargetPath)`, necesita `Condition="'$(TargetFramework)' != ''"`. Esa sola línea previene la mayoría de los reportes de MSB4057 en repositorios MAUI, y no cuesta nada en proyectos de un solo target, donde `TargetFramework` siempre está definido.

Para otros fallos de compilación en el mismo stack, mira los artículos sobre [por qué MSB3027 reporta que no pudo copiar un archivo tras diez reintentos](/es/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/), [qué revisar cuando una compilación de Gradle no produce un .apk en MAUI Android](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/), [cómo resolver un error de tipo o espacio de nombres tras agregar una referencia de proyecto](/es/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/), y [la lista completa de migración de Xamarin.Forms a .NET MAUI 11](/es/2026/05/migrate-from-xamarin-forms-to-maui-11/).

## Fuentes

- [Código de diagnóstico MSB4057](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057), documentación de MSBuild
- `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets` y `Microsoft.Common.CrossTargeting.targets`, .NET SDK 10.0.201
- [ikvmnet/ikvm-maven#76](https://github.com/ikvmnet/ikvm-maven/issues/76), MSB4057 desde el archivo `.targets` de un paquete en un proyecto que no es de estilo SDK
- [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043), la variante `GetTargetPath` en un head de MAUI
- [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230), la regresión de `dotnet-ef` 10
