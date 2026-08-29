---
title: "Migrar una solución .NET a Central Package Management con Directory.Packages.props"
description: "Mueve todas las versiones de paquetes de tus archivos csproj a un único Directory.Packages.props. Cubre un script generador que reconcilia versiones en conflicto con ordenación semver real, el diff del grafo de dependencias antes/después que demuestra qué cambió, NU1008/NU1010/NU1013/NU1507, el anclaje transitivo, GlobalPackageReference, VersionOverride y por qué un Directory.Packages.props anidado eclipsa silenciosamente al de la raíz."
pubDate: 2026-08-28
template: migration
tags:
  - "migration"
  - "dotnet"
  - "nuget"
  - "csharp"
lang: "es"
translationOf: "2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props"
translatedBy: "claude"
translationDate: 2026-08-28
---

Central Package Management saca todos los atributos `Version` de tus archivos `.csproj` y los lleva a un único `Directory.Packages.props` en la raíz del repositorio. Actívalo con `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`, declara un `<PackageVersion Include="..." Version="..." />` por cada paquete que use la solución y elimina el atributo `Version` de cada `<PackageReference>`. La migración en sí es mecánica y automatizable. La parte que necesita a una persona es reconciliar los paquetes anclados a versiones distintas en proyectos distintos, porque consolidarlos es un cambio real de comportamiento, no un cambio de formato. Todo lo que sigue fue verificado contra el SDK de .NET 10 10.0.302 con NuGet 7.6.0 incluido.

## Qué cambia realmente

Antes, cada proyecto es dueño de sus versiones:

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
</ItemGroup>
```

Después, el proyecto declara solo *de qué* depende, y el archivo raíz decide *qué versión*:

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" />
</ItemGroup>
```

```xml
<!-- Directory.Packages.props -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
```

`Directory.Packages.props` se descubre subiendo *hacia arriba* desde el directorio de cada proyecto, igual que `Directory.Build.props`. No tiene por qué estar junto al archivo de solución, y nada lo importa explícitamente. Fíjate en que solo se mueve la versión. `PrivateAssets`, `IncludeAssets` y `ExcludeAssets` se quedan en el `PackageReference` del proyecto que los necesita, porque son decisiones por proyecto.

## Pasos

1. Crea `Directory.Packages.props` en la raíz del repositorio con `ManagePackageVersionsCentrally` en `true`.
2. Recopila la versión de cada `PackageReference` de cada proyecto y emite un elemento `PackageVersion` por identificador de paquete.
3. Resuelve los paquetes que aparecen con más de una versión. Este es el único paso que no es mecánico.
4. Elimina el atributo `Version` de cada `PackageReference` de cada proyecto.
5. Restaura y compara el grafo de dependencias resuelto con el que capturaste antes de empezar.

## Generar el archivo a partir de lo que ya tienes

Una aplicación C# basada en archivo encaja bien aquí: un solo archivo, sin proyecto, y `dotnet run` la ejecuta directamente. Captura las versiones, informa de los conflictos, escribe el archivo de propiedades y luego elimina los atributos.

```csharp
// migrate-to-cpm.cs -- ejecutar con: dotnet run migrate-to-cpm.cs .
#:property ManagePackageVersionsCentrally=false
#:package NuGet.Versioning@6.*

using System.Xml.Linq;
using NuGet.Versioning;

var root = args.Length > 0 ? args[0] : ".";
var projects = Directory.GetFiles(root, "*.csproj", SearchOption.AllDirectories);
var versions = new Dictionary<string, SortedSet<NuGetVersion>>(StringComparer.OrdinalIgnoreCase);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        var id = (string?)reference.Attribute("Include") ?? (string?)reference.Attribute("Update");
        var version = (string?)reference.Attribute("Version") ?? (string?)reference.Element("Version");
        if (id is null || version is null) continue;
        if (!versions.TryGetValue(id, out var set))
            versions[id] = set = new SortedSet<NuGetVersion>();
        if (NuGetVersion.TryParse(version, out var parsed)) set.Add(parsed);
    }
}

foreach (var (id, set) in versions.Where(v => v.Value.Count > 1))
    Console.WriteLine($"conflict: {id} -> {string.Join(", ", set)}");

var props = new XElement("Project",
    new XElement("PropertyGroup",
        new XElement("ManagePackageVersionsCentrally", true),
        new XElement("CentralPackageTransitivePinningEnabled", true)),
    new XElement("ItemGroup",
        versions.OrderBy(v => v.Key, StringComparer.OrdinalIgnoreCase)
                .Select(v => new XElement("PackageVersion",
                    new XAttribute("Include", v.Key),
                    new XAttribute("Version", v.Value.Max()!)))));

File.WriteAllText(Path.Combine(root, "Directory.Packages.props"), props + Environment.NewLine);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    var changed = false;
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        if (reference.Attribute("Version") is { } attribute) { attribute.Remove(); changed = true; }
        if (reference.Element("Version") is { } element) { element.Remove(); changed = true; }
    }
    if (changed) doc.Save(project);
}

Console.WriteLine($"wrote {versions.Count} PackageVersion entries from {projects.Length} projects");
```

Dos detalles de ese script son fundamentales.

El primero es `NuGetVersion` en lugar de cadenas simples. Ordenar versiones como texto es incorrecto, y lo es en la dirección que te degrada silenciosamente:

```text
string  max: 13.0.3
semver  max: 13.0.10
```

El segundo es la directiva `#:property ManagePackageVersionsCentrally=false` de la línea 1. Sin ella, el script se rompe a sí mismo en cuanto tiene éxito. La directiva `#:package` de una aplicación basada en archivo se traduce a un `PackageReference` *con* `Version`, y el `Directory.Packages.props` que el script acaba de escribir está en el mismo árbol de directorios, así que la siguiente ejecución falla antes de llegar a `Main`:

```text
migrate-to-cpm.cs.csproj : error NU1008: The following PackageReference items cannot define a value for
Version: NuGet.Versioning. Projects using Central Package Management must define a Version value on a
PackageVersion item.
```

Esto merece recordarse más allá de este script: activar CPM en la raíz del repositorio afecta también a todas las aplicaciones `.cs` basadas en archivo del repositorio, y `#:package` no es compatible con ello. Excluye cada una con `#:property`, o mantén tus scripts fuera del árbol.

## Los conflictos son la migración

Ejecuta el script sobre una solución donde tres proyectos no coinciden y obtienes la lista real de tareas:

```text
conflict: Serilog -> 4.1.0, 4.2.0
conflict: Newtonsoft.Json -> 13.0.1, 13.0.3
wrote 3 PackageVersion entries from 3 projects
```

Tomar la versión más alta, que es lo que hace el script, es el *valor predeterminado* correcto y la *política* incorrecta. Es correcto porque una solución que distribuye dos versiones de la misma biblioteca suele ser un accidente más que una decisión, y porque el anclaje más bajo suele ser el obsoleto que nadie revisó. Es incorrecto como política porque "gana la más alta" es exactamente la forma de cruzar sin saberlo un límite de versión mayor en un proyecto cuando solo intentabas reorganizar tus archivos de compilación. Lee la lista y, para todo lo que salte una versión mayor, migra ese proyecto deliberadamente en lugar de dejar que lo haga el script.

## Demuestra qué se movió

CPM no es una operación neutra, y la forma de saber qué hizo realmente es comparar el grafo resuelto. Captúralo antes de empezar, desde la salida de restauración de cada proyecto:

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); [print(k) for t in d['targets'].values() for k in sorted(t)]" src/Domain/obj/project.assets.json
```

Antes y después, para la solución de tres proyectos anterior:

```text
            BEFORE                       AFTER
Api       Newtonsoft.Json/13.0.3      Newtonsoft.Json/13.0.3
          Polly/8.5.0                 Polly/8.5.0
          Serilog/4.2.0               Serilog/4.2.0
Domain    Newtonsoft.Json/13.0.1  ->  Newtonsoft.Json/13.0.3
Workers   Serilog/4.1.0           ->  Serilog/4.2.0
          Polly/8.5.0                 Polly/8.5.0
```

Se movieron dos proyectos. Ese es el cambio que hay que probar y que hay que poner en la descripción de la pull request. Si tu diff está vacío, la migración fue genuinamente mecánica y puedes fusionarla con mucha menos ceremonia.

## Los cuatro errores que te vas a encontrar

**NU1008**: un `PackageReference` todavía lleva una `Version`. Este es el estado esperado a mitad de la migración y es un error, no una advertencia, así que un repositorio migrado a medias no compila.

```text
error NU1008: The following PackageReference items cannot define a value for Version: Serilog.
```

**NU1010**: un `PackageReference` no tiene un `PackageVersion` correspondiente. Normalmente es un paquete que solo aparece en un proyecto que el script no analizó, por ejemplo uno fuera de la raíz que le pasaste.

```text
error NU1010: The following PackageReference items do not define a corresponding PackageVersion item:
Humanizer.Core.
```

**NU1013**: se usó un `VersionOverride` mientras `CentralPackageVersionOverrideEnabled` está en `false`. Consulta las vías de escape más abajo.

**NU1507**: una advertencia, y la que la gente ignora:

```text
warning NU1507: There are 2 package sources defined in your configuration. When using central package
management, please map your package sources with package source mapping
(https://aka.ms/nuget-package-source-mapping) or specify a single package source.
The following sources are defined: nuget.org, contoso
```

Con una sola fuente no cambia nada. Con un feed privado junto a nuget.org, una versión declarada centralmente pasa a ser resoluble desde cualquiera de los dos, lo que amplía la ventana para una sustitución por confusión de dependencias. Arréglalo con el mapeo de fuentes de paquetes en lugar de suprimir la advertencia.

## Anclaje transitivo

Esta es la funcionalidad que por sí sola justifica la migración. Actívala con `<CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>` y cualquier `PackageVersion` que declares se aplicará también a los paquetes que lleguen de forma transitiva.

Toma un proyecto que referencia `Newtonsoft.Json.Bson` y nada más. Su dependencia de `Newtonsoft.Json >= 12.0.1` se resuelve exactamente a eso, aunque `Directory.Packages.props` declare 13.0.3, porque un `PackageVersion` sin un `PackageReference` correspondiente no hace nada de forma predeterminada:

```text
warning NU1903: Package 'Newtonsoft.Json' 12.0.1 has a known high severity vulnerability
```

Activa el anclaje transitivo y la misma restauración queda limpia:

```text
Top-level Package           Requested   Resolved
> Newtonsoft.Json.Bson      1.0.2       1.0.2

Transitive Package      Resolved
> Newtonsoft.Json       13.0.3
```

El paquete se eleva a 13.0.3 y sigue clasificado como transitivo, así que no pasa a formar parte de la superficie pública de dependencias de tu proyecto ni se filtra al nuspec de un paquete que produzcas. Ese es todo el objetivo: puedes corregir una dependencia transitiva vulnerable en todos los proyectos a la vez sin añadir una referencia directa que luego tendrás que acordarte de eliminar.

## GlobalPackageReference

Los paquetes que solo actúan en tiempo de compilación y que corresponden a todos los proyectos, como los proveedores de source link, los analizadores y las herramientas de versionado, tienen su propio tipo de elemento. Decláralo una vez en `Directory.Packages.props` y no toques ningún `.csproj`:

```xml
<ItemGroup>
  <GlobalPackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0.0" />
</ItemGroup>
```

Ten en cuenta que un `GlobalPackageReference` lleva su `Version` en línea, a diferencia de un `PackageReference`. Se aplica en todas partes como referencia de nivel superior con comportamiento de activos solo de desarrollo, así que aparecerá en `dotnet package list` de todos los proyectos. Úsalo solo para paquetes que realmente correspondan a todos ellos; un paquete que es global "por ahora" es muy difícil de eliminar después.

## Vías de escape

Un proyecto necesita una versión distinta y tienes un motivo real. `VersionOverride` gana sobre el valor central:

```xml
<PackageReference Include="Newtonsoft.Json" VersionOverride="13.0.1" />
```

Si tu objetivo al adoptar CPM era hacer imposible la deriva de versiones, cierra esa puerta con `<CentralPackageVersionOverrideEnabled>false</CentralPackageVersionOverrideEnabled>`, que convierte cualquier uso en NU1013.

Un proyecto entero puede quedar excluido con `<ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>` en su `.csproj`, tras lo cual vuelve a gestionar sus propias versiones en línea. Ten en cuenta que eso también lo excluye del anclaje transitivo, así que una dependencia transitiva vulnerable que el resto de la solución ha elevado vuelve directamente en ese proyecto.

## Un Directory.Packages.props anidado eclipsa, no fusiona

El recorrido de descubrimiento se detiene en el primer archivo que encuentra. Por lo tanto, un `Directory.Packages.props` en un subdirectorio reemplaza por completo al de la raíz en lugar de añadirse a él, y todos los proyectos por debajo fallan de inmediato con NU1010 para los paquetes que declaraba el archivo raíz. Si necesitas versiones por área, importa el padre explícitamente y superpón con `Update`:

```xml
<Project>
  <Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Packages.props', '$(MSBuildThisFileDirectory)../'))" />
  <ItemGroup>
    <PackageVersion Update="Newtonsoft.Json" Version="13.0.2" />
  </ItemGroup>
</Project>
```

`Update` en lugar de `Include`, porque el elemento ya existe. Equivocarte aquí te deja dos elementos `PackageVersion` para un paquete, lo cual es ambiguo.

## La CLI ya lo sabe

No necesitas editar a mano el archivo de propiedades tras la migración. Los comandos de paquete del SDK de .NET 10 conocen CPM y escriben en el archivo correcto por su cuenta.

`dotnet package add Humanizer.Core --project src/Lib1/Lib1.csproj` añade un `PackageReference` sin versión al proyecto *y* además inserta un `PackageVersion` en `Directory.Packages.props` en orden alfabético:

```text
info : PackageReference for package 'Humanizer.Core' version '3.0.10' added to file
'/repo/Directory.Packages.props'.
```

`dotnet package update Serilog --project src/App/App.csproj` edita solo la versión central y deja el archivo de proyecto intacto. `dotnet package list --outdated` sigue informando correctamente, incluidos los elementos `GlobalPackageReference`. `dotnet nuget why <project> <package>` sigue siendo la forma más rápida de averiguar qué referencia arrastró un paquete transitivo que estás a punto de anclar.

## Relacionado

- CPM combina de forma natural con la limpieza de dependencias transitivas de [la poda de paquetes NuGet activada por defecto en .NET 10](/es/2026/05/nuget-package-pruning-default-net-10/), que elimina del grafo los paquetes proporcionados por el framework antes de que el anclaje tenga que pensar en ellos.
- Las directivas `#:package` y `#:property` que usa el script de migración se cubren por completo en [cómo ejecutar una aplicación C# basada en archivo con `dotnet run app.cs`](/es/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/).
- Consolidar versiones entre proyectos es algo bueno que conviene hacer *antes* de [migrar de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), para que el salto de framework sea la única variable del diff.
- Si un proyecto deja de compilar después de quitarle las versiones, la causa suele ser la referencia en sí y no CPM; consulta [no se encontró el tipo o el nombre del espacio de nombres tras añadir una referencia de proyecto](/es/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/).
- Cuando dos proyectos convergen en una sola versión, los errores de carga en tiempo de ejecución son la forma en que te enteras; [no se pudo cargar el archivo o ensamblado en una aplicación publicada](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) cubre cómo diagnosticarlos.

## Fuentes

- [Central Package Management](https://learn.microsoft.com/es-es/nuget/consume-packages/central-package-management) en la documentación de NuGet, para `PackageVersion`, `GlobalPackageReference`, `VersionOverride` y el anclaje transitivo.
- [Referencia de errores y advertencias de NuGet](https://learn.microsoft.com/es-es/nuget/reference/errors-and-warnings/) para NU1008, NU1010, NU1013 y NU1507.
- [Mapeo de fuentes de paquetes](https://learn.microsoft.com/es-es/nuget/consume-packages/package-source-mapping), la respuesta recomendada a NU1507.
- [Personalizar la compilación con Directory.Build.props](https://learn.microsoft.com/es-es/visualstudio/msbuild/customize-by-directory) para el recorrido de directorios que también rige `Directory.Packages.props`.
