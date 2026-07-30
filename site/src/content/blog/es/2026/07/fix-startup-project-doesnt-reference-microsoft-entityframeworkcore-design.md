---
title: "Solución: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design"
description: "Agrega Microsoft.EntityFrameworkCore.Design al proyecto de inicio que compila dotnet ef, no al proyecto que contiene tu DbContext, y pasa -s en soluciones por capas."
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
lang: "es"
translationOf: "2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design"
translatedBy: "claude"
translationDate: 2026-07-30
---

Agrega el paquete al **proyecto de inicio**, que es el proyecto que `dotnet ef` compila y ejecuta, no a la biblioteca de clases que contiene tu `DbContext`: `dotnet add package Microsoft.EntityFrameworkCore.Design`. En una solución por capas, además indícale a las herramientas cuál es ese proyecto con `-s ./src/Api`. Desde `Microsoft.EntityFrameworkCore.Tools` 10.0.6 el paquete Design ya no se incorpora por ti.

```text
Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design. This package is required for the Entity Framework Core Tools to work. Ensure your startup project is correct, install the package, and try again.
```

Este artículo está escrito contra EF Core 11.0.0-preview.6 (`11.0.0-preview.6.26359.118`, 2026-07-14), el SDK de .NET 11 preview 6 y C# 14, con notas sobre EF Core 9 y 10 donde las herramientas se comportan de forma distinta. La línea estable actual es 10.0.10. El texto del error no ha cambiado desde EF Core 2.1, pero **cómo** deciden las herramientas que falta el paquete cambió sustancialmente en EF Core 10, y eso determina cuál de las soluciones siguientes te aplica.

## De qué se quejan realmente las herramientas

El mensaje se lee como una comprobación estática de tu `.csproj`. No lo es. Es un fallo de carga, reportado después del hecho.

Esta es la secuencia real cuando ejecutas `dotnet ef migrations add Init`:

1. `dotnet-ef` ejecuta una compilación de metadatos del proyecto de inicio. En EF Core 10 y 11 eso es `dotnet build --no-restore /getProperty:AssemblyName /getProperty:OutputPath ... /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems`.
2. Recorre los `RuntimeCopyLocalItems` devueltos buscando un `FullPath` que contenga `Microsoft.EntityFrameworkCore.Design` y se queda con esa ruta absoluta.
3. Compila el proyecto de inicio y luego invoca `ef.dll`, pasándole la ruta que encontró como `--design-assembly`, junto con los archivos `.deps.json` y `.runtimeconfig.json` del proyecto para que el proceso de la herramienta emule la carga de ensamblados de tu aplicación.
4. `ef.dll` carga `Microsoft.EntityFrameworkCore.Design.dll` en un `AssemblyLoadContext`: desde esa ruta si la recibió, o por nombre de ensamblado en caso contrario.
5. Si el paso 4 lanza una `FileNotFoundException` y el nombre del ensamblado ausente es exactamente `Microsoft.EntityFrameworkCore.Design`, la herramienta la captura e imprime el mensaje amable de arriba, nombrando el ensamblado de inicio.

De ahí se derivan dos consecuencias directas. Primero, el proyecto nombrado en el mensaje es el proyecto **de inicio**, así que si ese nombre te sorprende, tu problema está en el paso 1 y no en un paquete ausente. Segundo, un `PackageReference` que existe pero no produce un activo de runtime copiado localmente es invisible para el paso 2, y por eso hay gente que pega su `.csproj` en los reportes de incidencias insistiendo en que el paquete está justo ahí.

EF Core 9 y anteriores funcionaban de otra manera: `dotnet-ef` inyectaba un archivo `EntityFrameworkCore.targets` incrustado en el proyecto y `ef.dll` resolvía Design por nombre de ensamblado a través del `.deps.json` del proyecto de inicio. Esa distinción importa para un modo de fallo concreto que se cubre más abajo.

## Reproducción mínima

Una solución por capas de dos proyectos, que es el diseño que produce este error con más frecuencia:

```text
Shop.sln
  src/Shop.Api/Shop.Api.csproj          <- startup project, has Program.cs
  src/Shop.Data/Shop.Data.csproj        <- has AppDbContext and Migrations/
```

```xml
<!-- src/Shop.Data/Shop.Data.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

```xml
<!-- src/Shop.Api/Shop.Api.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Shop.Data/Shop.Data.csproj" />
  </ItemGroup>
</Project>
```

```bash
# .NET 11 SDK preview 6
cd src/Shop.Data
dotnet ef migrations add Init -s ../Shop.Api
# Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design.
```

El paquete Design está referenciado. Está referenciado en el proyecto equivocado, y no puede viajar.

## Solución 1: referencia Design en el proyecto de inicio

Esta es la solución en casi todos los casos. Ejecútala desde el directorio del proyecto de inicio:

```bash
# .NET 11 SDK preview 6, EF Core 11
dotnet add src/Shop.Api/Shop.Api.csproj package Microsoft.EntityFrameworkCore.Design
```

NuGet escribe esto, porque Design está marcado como `developmentDependency` en su nuspec:

```xml
<!-- src/Shop.Api/Shop.Api.csproj - EF Core 11.0.0-preview.6 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

Lee esa lista de `IncludeAssets` con atención, porque explica las dos mitades del problema:

- `runtime` **sí** está en la lista. Eso es lo que pone `Microsoft.EntityFrameworkCore.Design.dll` en tu carpeta `bin` y, por tanto, dentro de `RuntimeCopyLocalItems`, que es lo que buscan las herramientas. No lo quites.
- `compile` **no** está en la lista. No puedes referenciar tipos de Design desde el código de tu aplicación, lo cual es intencional: es un paquete de tiempo de diseño y nada de tu código de producción debería enlazar con él.
- `PrivateAssets: all` significa que la referencia **no fluye de forma transitiva**. Esa es toda la razón por la que la Solución 1 existe como paso aparte de tener el paquete en tu proyecto de datos.

## Solución 2: apunta las herramientas al proyecto de inicio correcto

Si el nombre del proyecto en el error no es el proyecto que querías, el paquete está bien y el destino está mal. La regla, según la documentación de la CLI de EF Core: el *proyecto de destino* es donde se escriben los archivos (`--project`, `-p`, por defecto el directorio actual), y el *proyecto de inicio* es el que las herramientas compilan y ejecutan para descubrir tu cadena de conexión y tu modelo (`--startup-project`, `-s`, también por defecto el directorio actual).

```bash
# EF Core 11, run from the repository root
dotnet ef migrations add Init -p src/Shop.Data -s src/Shop.Api
```

Escribir eso en cada comando es la razón por la que los equipos terminan pegando el paquete al proyecto equivocado solo para que el error desaparezca. EF Core 11 añade un archivo de configuración precisamente para esto, que se descubre subiendo desde el directorio actual hasta el primer `.config/dotnet-ef.json` que encuentre:

```json
{
  "project": "src/Shop.Data",
  "startupProject": "src/Shop.Api"
}
```

Las rutas relativas se resuelven contra el directorio padre del directorio `.config`, así que coloca el archivo en la raíz de tu repositorio y cualquier invocación de `dotnet ef` desde cualquier subdirectorio lo tomará. Las opciones explícitas de línea de comandos siguen ganando sobre el archivo. Solo se aceptan las claves documentadas: `project`, `startupProject`, `context`, `framework`, `configuration`, `runtime`, `verbose`, `noColor`, `prefixOutput`. Una clave desconocida es un error grave, no una advertencia, así que un typo como `startProject` hace fallar el comando por completo.

## Solución 3: deja de intentar que fluya la referencia del proyecto de datos

De vez en cuando alguien encuentra este truco y sí funciona:

```xml
<!-- src/Shop.Data/Shop.Data.csproj - do not do this -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>none</PrivateAssets>
</PackageReference>
```

Poner `PrivateAssets` en `none` hace que la referencia fluya transitivamente hasta `Shop.Api`, y el error desaparece. También arrastra Roslyn a cada proyecto que referencie tu capa de datos, porque Design depende de `Microsoft.CodeAnalysis.CSharp` y `Microsoft.CodeAnalysis.CSharp.Workspaces` (5.0.0 o posterior en el paquete 10.0.10), además de `Microsoft.Build.Framework`, `Humanizer.Core`, `Mono.TextTemplating` y `Newtonsoft.Json`. Has movido una cadena de generación de código a tu grafo de dependencias de runtime para ahorrarte una línea en un `.csproj`. Toma en su lugar la referencia explícita en el proyecto de inicio.

## La variante de versiones incompatibles desde Tools 10.0.6

Si instalas `Microsoft.EntityFrameworkCore.Tools` (el módulo de la Package Manager Console) y esperas que arrastre Design consigo, esa suposición ya caducó. Antes de 10.0.6, Tools dependía de una versión de Design coincidente. Eso rompía el restore en proyectos que apuntaban a `net8.0`, porque Design 10.0.x solo apunta a `net10.0`, así que el equipo de EF bajó el mínimo a Design 8.0.0 en Tools 10.0.6. En la rama de EF Core 11, `Microsoft.EntityFrameworkCore.Tools` no lleva ningún `PackageReference` a Design.

El resultado práctico es que ahora NuGet puede resolver una versión antigua de Design que satisface el mínimo, y el síntoma no es este error, sino:

```text
System.MissingMethodException: Method not found ...
System.TypeLoadException: Could not load type ...
```

La solución es una referencia explícita con versión coincidente. Con la gestión centralizada de paquetes, fíjala una sola vez:

```xml
<!-- Directory.Packages.props - EF Core 11.0.0-preview.6 -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

La gestión centralizada de paquetes también tiene su propia trampa aquí: una entrada `PackageVersion` en `Directory.Packages.props` no es una referencia. El proyecto de inicio sigue necesitando `<PackageReference Include="Microsoft.EntityFrameworkCore.Design" />` sin atributo `Version`. Mantén también `dotnet-ef` al día, porque una herramienta 10.x manejando un ensamblado Design 11.x es una clase de fallo aparte:

```bash
dotnet tool update --global dotnet-ef --version 11.0.0-preview.6.26359.118
```

## Cuando la referencia está ahí y aun así falla

Ejecuta la misma consulta que ejecutan las herramientas y mira la respuesta tú mismo. El modificador `-getItem` requiere el SDK de .NET 8 o posterior:

```bash
# .NET 11 SDK preview 6
dotnet build src/Shop.Api/Shop.Api.csproj --no-restore \
  /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems
```

Si `Microsoft.EntityFrameworkCore.Design.dll` no está en ese JSON, EF Core 10 y 11 no pueden verlo, diga lo que diga el `.csproj`. Los culpables habituales son atributos de flujo de activos que alguien copió de un paquete que solo trae analizadores:

- `<ExcludeAssets>runtime</ExcludeAssets>` o `<ExcludeAssets>all</ExcludeAssets>` en la referencia a Design.
- Una lista `<IncludeAssets>` que omite `runtime`, por ejemplo `build; analyzers`.
- `<PackageReference ... GeneratePathProperty="true" ExcludeAssets="all" />`, un patrón que aparece cuando alguien solo quiere el directorio de herramientas del paquete.

Agrega `-v` para obtener el propio relato de la herramienta sobre lo que resolvió. La salida detallada imprime el comando completo de compilación de metadatos y la ruta del ensamblado Design que eligió, lo que convierte un juego de adivinanzas en un diagnóstico de dos líneas:

```bash
dotnet ef migrations add Init -s src/Shop.Api -v
```

El único caso en el que un `.csproj` correcto realmente no bastaba: en EF Core 9 con ciertas compilaciones del SDK de .NET 9, [dotnet/sdk#45259](https://github.com/dotnet/sdk/pull/45259) dejó de emitir hacia `.deps.json` las entradas `PackageReference` marcadas con `PrivateAssets="all"`. Como el `ef.dll` de EF Core 9 resolvía Design por nombre de ensamblado a través de ese archivo, las herramientas perdían el paquete ([dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265), con [#35544](https://github.com/dotnet/efcore/issues/35544) como uno de sus duplicados). Se corrigió en EF Core 10 mediante [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527), que registra un manejador `AssemblyLoadContext.Resolving` que sondea la ruta base de la aplicación, junto con la ruta explícita `--design-assembly` descrita antes. Si estás atascado en un proyecto de EF Core 9 con este problema, actualizar la herramienta global `dotnet-ef` a 10 o posterior es suficiente, porque las herramientas son independientes de la versión de los paquetes de runtime que manejan.

## Trampas y falsos parecidos

**Proyectos generados sin el paquete.** Las primeras compilaciones del SDK de .NET 11 preview 3 generaban proyectos de `dotnet new mvc --auth Individual` sin referencia a Design, una regresión respecto a preview 2 registrada como [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750). Dejó de reproducirse a partir del SDK `11.0.100-preview.3.26166.111`. Si un proyecto se generó durante esa ventana, la plantilla es la culpable y la Solución 1 es todo lo que necesitas.

**Una biblioteca de clases `netstandard2.0` como proyecto de inicio.** Las herramientas tienen que ejecutar código de la aplicación, lo que requiere un runtime real, y .NET Standard es una especificación más que una implementación. Agregar Design no ayudará. Crea un proyecto de consola desechable que referencie la biblioteca y úsalo como `-s`.

**Un target framework específico de plataforma.** Con `net11.0-android` o `net11.0-ios` obtienes un mensaje distinto sobre un framework específico de plataforma, y la respuesta documentada es implementar `IDesignTimeDbContextFactory<TContext>` para que las herramientas nunca necesiten arrancar tu aplicación.

**`NETSDK1004` en la salida detallada.** La compilación de metadatos se ejecuta con `--no-restore`. Si el proyecto nunca se restauró, `dotnet-ef` informa de que se requiere un restore en lugar de un paquete ausente. Ejecuta `dotnet restore` y vuelve a intentarlo.

**Multi-targeting.** `dotnet-ef` toma el primer target framework y se reinvoca a sí mismo. Si Design está condicionado a un TFM y el primero no es ese, pasa `--framework net11.0` de forma explícita.

**`Unable to create an object of type 'AppDbContext'`.** Error distinto, causa distinta. El ensamblado Design se cargó bien y luego las herramientas no pudieron instanciar tu contexto. Eso se cubre en [la guía sobre el descubrimiento de DbContext en tiempo de diseño](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

**Contenedores de CI.** La imagen `dotnet/sdk`, no `dotnet/aspnet`, y `dotnet tool install --global dotnet-ef` antes de cualquier llamada a `dotnet ef`. Si tu pipeline solo necesita aplicar migraciones y no crearlas, sáltate la herramienta por completo y despacha un bundle de migraciones.

## El diseño que nunca cae en esto

Cuatro reglas, y este error deja de aparecer en tu solución:

1. `Microsoft.EntityFrameworkCore.Design` está referenciado por el proyecto de inicio, con los `PrivateAssets` e `IncludeAssets` predeterminados que escribe `dotnet add package`.
2. El paquete del proveedor (`Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.EntityFrameworkCore.PostgreSQL`, etc.) es alcanzable desde el proyecto de inicio, y de forma transitiva a través del proyecto de datos está bien.
3. Todas las versiones de los paquetes de EF Core y la versión de la herramienta `dotnet-ef` coinciden, idealmente fijadas en `Directory.Packages.props`.
4. `.config/dotnet-ef.json` registra `project` y `startupProject` para que nadie tenga que recordar `-p` y `-s`.

## Relacionados

- [Por qué las herramientas de tiempo de diseño no pueden instanciar tu DbContext](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) cubre el error que encontrarás inmediatamente después de resolver este.
- [Enviar cambios de esquema con bundles de migraciones](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) es el comando de tiempo de diseño que este paquete también condiciona, y la manera de mantener `dotnet-ef` fuera de las máquinas de producción.
- [PendingModelChangesWarning y qué detecta realmente](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) es lo siguiente de lo que te avisará CI una vez que las migraciones se ejecuten.
- [Registrar DbContextOptions correctamente](/es/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/) explica el fallo del lado de la inyección de dependencias que se parece a este en una solución por capas.
- [Cambios que rompen al pasar de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) incluye los cambios de tooling que vale la pena conocer antes de actualizar.

## Fuentes

- [Referencia de herramientas de EF Core (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), incluidas las reglas de proyecto de destino frente a proyecto de inicio y el archivo de configuración `dotnet-ef.json` de EF Core 11.
- [Arquitectura de las herramientas de tiempo de diseño](https://learn.microsoft.com/en-us/ef/core/miscellaneous/internals/tools) para la cadena de `dotnet-ef` a `ef.dll` a `EFCore.Design.dll`.
- [`src/dotnet-ef/Project.cs`](https://github.com/dotnet/efcore/blob/main/src/dotnet-ef/Project.cs) y [`src/ef/Commands/ProjectCommandBase.cs`](https://github.com/dotnet/efcore/blob/main/src/ef/Commands/ProjectCommandBase.cs) para la búsqueda en `RuntimeCopyLocalItems` y el punto exacto donde la `FileNotFoundException` se convierte en este mensaje.
- [Anuncio: cambio de dependencia del paquete Design en Microsoft.EntityFrameworkCore.Tools 10.0.6](https://github.com/dotnet/efcore/issues/38124).
- [dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265) y [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527) para la regresión de `.deps.json` y `PrivateAssets`.
- [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750) para la regresión de plantillas de .NET 11 preview 3.
