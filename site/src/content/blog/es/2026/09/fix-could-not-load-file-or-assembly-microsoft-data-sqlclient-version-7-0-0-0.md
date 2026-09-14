---
title: "Solución: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' tras actualizar EF Core"
description: "EF Core 11 está compilado contra Microsoft.Data.SqlClient 7.0.0.0, pero una copia 6.x ganó en el restore o en la implementación. Quita el pin antiguo de SqlClient y vuelve a implementar la salida completa."
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet"
  - "dotnet-11"
lang: "es"
translationOf: "2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0"
translatedBy: "claude"
translationDate: 2026-09-14
---

**Respuesta corta:** `Microsoft.EntityFrameworkCore.SqlServer` 11 (verificado en `11.0.0-rc.1.26425.128`, .NET 11 RC 1) está compilado contra `Microsoft.Data.SqlClient, Version=7.0.0.0` y requiere el paquete 7.0.2 o posterior. La excepción significa que el proceso encontró un SqlClient 6.x, o ninguno. Elimina la referencia sobrante a `Microsoft.Data.SqlClient` 6.x (o su `PackageVersion` en `Directory.Packages.props`), quita cualquier `NoWarn` para `NU1605`, vuelve a compilar y vuelve a implementar la carpeta de salida completa, incluida `runtimes/`.

El resto de este artículo muestra de dónde viene la copia 6.x, cómo encontrarla en menos de un minuto y los dos errores parecidos que llevan a la gente a la solución equivocada. Todos los escenarios de abajo se reprodujeron en macOS con el SDK de .NET 11 RC 1 (`11.0.100-rc.1.26425.128`) y el SDK 10.0.302; no hace falta una base de datos para provocarlo.

## El error en contexto

EF Core no toca SqlClient cuando registras el contexto. La carga ocurre la primera vez que el proveedor construye sus mapeos de tipos, que es la primera consulta, `SaveChanges`, `MigrateAsync` o `Database.GetDbConnection()`. Esta es la cadena de excepciones que imprimió mi reproducción, de la más externa a la más interna:

```text
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerTypeMappingSource' threw an exception.
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerVectorTypeMapping' threw an exception.
System.IO.FileNotFoundException: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5'. The system cannot find the file specified.
```

Si tus registros solo muestran la `TypeInitializationException` externa, desenvuelve `InnerException` dos veces. La `FileNotFoundException` del fondo es el error real.

Algo que conviene saber antes de empezar: `Version=7.0.0.0` es una versión de **ensamblado**, no una versión de paquete. SqlClient fija `AssemblyVersion` en `Major.0.0.0` para cada versión de una línea mayor, así que el paquete 7.0.3 incluye una DLL cuya versión de ensamblado es `7.0.0.0` (versión de archivo `7.0.3.26253`). Los mantenedores confirmaron que es deliberado en [dotnet/SqlClient#4310](https://github.com/dotnet/SqlClient/issues/4310). Cualquier paquete 7.x satisface la referencia. No necesitas buscar "exactamente 7.0.0".

## Por qué ocurre

El runtime enlaza por versión de ensamblado, y solo avanza hacia versiones más nuevas, nunca retrocede. Cuando EF Core 11 pide `7.0.0.0` y la única `Microsoft.Data.SqlClient.dll` en la ruta de búsqueda es una compilación 6.x (versión de ensamblado `6.0.0.0`), la carga falla. Falla con el engañoso "cannot find the file specified" incluso cuando un archivo 6.x está exactamente en la ruta a la que apunta el `.deps.json`. Lo probé explícitamente: poner la DLL 6.1.6 encima de la 7.0.2 en la salida produce el mismo mensaje.

Esto es contra lo que compila cada paquete, leído directamente de los metadatos de ensamblado en los paquetes NuGet:

| Paquete | Dependencia del paquete SqlClient | Referencia de ensamblado en la DLL |
| --- | --- | --- |
| `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10, 10.0.11, 10.0.12 | `>= 6.1.x` (10.0.12: `>= 6.1.6`) | `Microsoft.Data.SqlClient 6.0.0.0` |
| `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 | `>= 7.0.2` | `Microsoft.Data.SqlClient 7.0.0.0` |

Así que en EF Core 10 el proveedor en sí nunca pide 7.0.0.0. En EF Core 11 siempre lo hace. Ordenadas por la frecuencia con que las veo, las formas en que una copia 6.x gana de todos modos son:

1. **Una referencia directa sobrante a `Microsoft.Data.SqlClient` 6.x, con la advertencia de degradación silenciada.** Muchos proyectos de EF Core 8 a 10 añadieron una referencia explícita a SqlClient para obtener una corrección o soporte de Entra ID. Tras la actualización de EF, ese pin es una degradación. NuGet la reporta como `NU1605`, que el SDK trata como error, a menos que el proyecto tenga `<NoWarn>NU1605</NoWarn>` por algún conflicto anterior.
2. **La implementación omite o reemplaza la DLL.** SqlClient no tiene una implementación portable. Los ensamblados reales viven en `runtimes/unix/lib/net9.0/` y `runtimes/win/lib/net9.0/`. Un Dockerfile o script de copia que solo toma `*.dll` de la raíz de `bin/`, o que descomprime una compilación nueva encima de una carpeta vieja, deja la aplicación sin un SqlClient 7.x.
3. **Un host de plug-ins carga tu capa de datos dinámicamente.** El proceso host no tiene una entrada de `.deps.json` para SqlClient, así que su contexto de carga predeterminado no puede resolver las dependencias del plug-in.

## Reproducción mínima

Una aplicación de consola que estaba en EF Core 10 con un pin de SqlClient, actualizada a EF Core 11 RC 1. El `NoWarn` es la línea que convierte un error de compilación en un fallo en tiempo de ejecución:

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <NoWarn>$(NoWarn);NU1605</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
    <PackageReference Include="Microsoft.Data.SqlClient" Version="6.1.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<ShopDb>()
    .UseSqlServer("Server=localhost;Database=Shop;User ID=sa;Password=x;TrustServerCertificate=True")
    .Options;

using var db = new ShopDb(options);
// Throws the FileNotFoundException above; no server connection is attempted.
Console.WriteLine(db.Database.GetDbConnection().GetType().Assembly.GetName());

class ShopDb(DbContextOptions<ShopDb> options) : DbContext(options);
```

Quita la línea `NoWarn` y la compilación se detiene en el restore, que es lo que quieres:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to 6.1.6. Reference the package directly from the project to select a different version.
error NU1605:  app -> Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128 -> Microsoft.Data.SqlClient (>= 7.0.2)
error NU1605:  app -> Microsoft.Data.SqlClient (>= 6.1.6)
```

Sin el pin, el mismo programa imprime `Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5`.

## La solución, en detalle

### 1. Averigua quién incluye la copia 6.x

No adivines. Pídele a NuGet el grafo de dependencias del proyecto de inicio, no de la biblioteca de clases:

```bash
# .NET SDK 10.0.302 or .NET 11 RC 1 SDK
dotnet nuget why src/Shop.Api/Shop.Api.csproj Microsoft.Data.SqlClient
dotnet list src/Shop.Api/Shop.Api.csproj package --include-transitive
```

`dotnet nuget why` imprime un árbol por framework de destino, así que una referencia directa 6.x, o un paquete que arrastra una, se ve de un vistazo. Luego revisa qué se escribió realmente para el runtime, porque eso es lo que lee el host:

```bash
# .NET 11 RC 1 SDK
grep -A3 '"Microsoft.Data.SqlClient/' src/Shop.Api/bin/Release/net11.0/Shop.Api.deps.json
```

Si el `.deps.json` dice `7.0.x` y la aplicación sigue fallando, el problema es la implementación (paso 4), no el restore.

### 2. Quita o sube el pin de SqlClient

Si nada en tu código necesita una versión específica de SqlClient, elimina la referencia directa y deja que EF Core traiga la versión contra la que fue compilado. Si prefieres mantenerla explícita, súbela a la 7.x actual:

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <!-- Was 6.1.6. Any 7.x works; 7.0.3 is the latest stable at the time of writing. -->
  <PackageReference Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

Con [Central Package Management](/es/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) y el pinning transitivo, el pin vive en `Directory.Packages.props`, y el error de restore tiene otro código:

```text
error NU1109: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to centrally defined 6.1.6. Update the centrally managed package version to a higher version.
```

Actualiza la propia entrada `PackageVersion`:

```xml
<!-- .NET 11 RC 1, Directory.Packages.props -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <PackageVersion Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

### 3. Deja de suprimir NU1605

Busca `NU1605` en `NoWarn` en toda la solución, incluido `Directory.Build.props`. Esa supresión es la única razón por la que esto llega alguna vez al runtime desde una compilación normal. Sin ella, la próxima persona que reintroduzca una degradación recibe un error de restore con la ruta exacta del paquete en lugar de un fallo en producción.

### 4. Vuelve a implementar toda la salida, incluida `runtimes/`

En una compilación dependiente del framework sin RID, la implementación real de SqlClient está en `runtimes/<os>/lib/net9.0/`, y el `.deps.json` apunta ahí. Eliminé ese único archivo de una compilación que funcionaba y obtuve la misma `FileNotFoundException`, y eliminar toda la carpeta `runtimes/` hace lo mismo. Si tu Dockerfile o pipeline copia de forma selectiva, cambia a copiar la carpeta de publicación completa:

```dockerfile
# .NET 11 RC 1 images
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish src/Shop.Api/Shop.Api.csproj -c Release -r linux-x64 --self-contained false -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Shop.Api.dll"]
```

Publicar con un RID (`-r linux-x64`) aplana el SqlClient específico de la plataforma en la raíz, junto a `Microsoft.Data.SqlClient.Extensions.Abstractions.dll` y `Microsoft.Data.SqlClient.Internal.Logging.dll`, lo que hace que la estructura sea mucho más difícil de romper. Para IIS, la implementación zip de Azure App Service o las implementaciones con xcopy, implementa en una carpeta limpia, para que una DLL 6.x de la versión anterior no pueda sobrevivir junto al nuevo `.deps.json`. Si no tienes claro si deberías distribuir la salida de `dotnet build` o la de `dotnet publish`, [la diferencia entre ambos](/es/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) importa aquí.

### 5. Añade la extensión de Azure si usas Entra ID

El paso a SqlClient 7.0 figura como un cambio de impacto medio en los [cambios importantes de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes). La autenticación de Entra ID (`Active Directory Default`, identidad administrada, entidad de servicio) salió del paquete principal. Una vez corregido el error de carga, una cadena de conexión que la use necesita una referencia más:

```xml
<!-- .NET 11 RC 1, Microsoft.Data.SqlClient 7.x -->
<PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.3" />
```

Mantén este paquete en la misma versión que `Microsoft.Data.SqlClient`. A partir de 7.0.2, SqlClient, `Extensions.Azure` y `Extensions.Abstractions` se publican sincronizados, y SqlClient 7.0.2 requiere `Extensions.Abstractions` en el rango `[7.0.2, 8.0.0)`. NuGet no tiene una 7.0.0 del paquete de Azure: sus versiones son 1.0.0, 7.0.2, 7.0.3, así que un `Version="7.0.0"` que copiaste de un fragmento de la documentación no se resuelve a esa versión exacta. Sin el paquete, 7.0 lanza un error accionable que lo nombra, así que no te quedarás adivinando. La [guía de migración de EF Core 6 a 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cubre esto junto con los demás cambios derivados de SqlClient.

### 6. Hosts de plug-ins: carga a través de un `AssemblyLoadContext`

Si un host sin referencia a EF Core carga tu capa de datos con `Assembly.LoadFrom`, el contexto predeterminado del host no tiene una entrada de `.deps.json` para SqlClient. La respuesta de los mantenedores en [#4310](https://github.com/dotnet/SqlClient/issues/4310) es el patrón estándar de plug-ins. Compila el plug-in con `<EnableDynamicLoading>true</EnableDynamicLoading>` y cárgalo a través de un contexto que lea el propio `.deps.json` del plug-in:

```csharp
// .NET 11 RC 1
using System.Reflection;
using System.Runtime.Loader;

sealed class PluginLoadContext(string pluginPath) : AssemblyLoadContext(isCollectible: false)
{
    private readonly AssemblyDependencyResolver _resolver = new(pluginPath);

    protected override Assembly? Load(AssemblyName name)
    {
        var path = _resolver.ResolveAssemblyToPath(name);
        return path is null ? null : LoadFromAssemblyPath(path);
    }

    protected override IntPtr LoadUnmanagedDll(string unmanagedDllName)
    {
        var path = _resolver.ResolveUnmanagedDllToPath(unmanagedDllName);
        return path is null ? IntPtr.Zero : LoadUnmanagedDllFromPath(path);
    }
}

// var asm = new PluginLoadContext(pluginPath).LoadFromAssemblyPath(pluginPath);
```

En mi prueba, el mismo plug-in falló con `Assembly.LoadFrom` y cargó `Microsoft.Data.SqlClient, Version=7.0.0.0` sin problemas a través de este contexto. El resolver importa en particular para SqlClient. Asigna la solicitud al archivo correcto de `runtimes/<os>/` en lugar del ensamblado de relleno del nivel raíz.

## Trampas y errores parecidos

**"Pero sigo en EF Core 10."** Entonces no es EF quien pide 7.0.0.0. Las DLL del proveedor de la 10.0.10 a la 10.0.12 referencian todas `6.0.0.0`. Por eso [dotnet/efcore#38845](https://github.com/dotnet/efcore/issues/38845), que reportó este error tras pasar de 10.0.10 a 10.0.11, se cerró sin una reproducción. Otra cosa en el grafo está compilada contra 7.x. Aspire es una fuente habitual. `Aspire.Microsoft.EntityFrameworkCore.SqlServer` 13.5.3 depende de `Microsoft.Data.SqlClient >= 7.0.1` y de EF Core 10.0.11 al mismo tiempo, así que `dotnet nuget why` en un servicio de Aspire muestra SqlClient resuelto a 7.0.1 bajo una aplicación EF Core 10. Esa combinación está bien: en mi prueba, EF Core 10.0.12 inicializó sus mapeos de tipos y creó una `SqlConnection` tanto con SqlClient 7.0.0 como con 7.0.3. Solo se rompe cuando gana un pin 6.x o una implementación obsoleta, lo que te lleva de vuelta a los pasos 1 a 4.

**`Could not load type 'Microsoft.Data.SqlClient.SqlAuthenticationMethod' from assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'`.** Este es un fallo distinto con la misma cadena de versión. El archivo se cargó bien, pero una biblioteca compilada contra 6.x (SQL Server Management Objects 181.x era la habitual) buscó un tipo que 7.0.0 movió a `Microsoft.Data.SqlClient.Extensions.Abstractions`. SqlClient 7.0.1 añadió reenvíos de tipos para `SqlAuthenticationMethod`, `SqlAuthenticationProvider` y tres tipos relacionados ([#4117](https://github.com/dotnet/SqlClient/pull/4117)), así que actualizar SqlClient a 7.0.1 o posterior lo corrige.

**`PlatformNotSupportedException: Microsoft.Data.SqlClient is not supported on this platform.`** El archivo se encontró, pero era el equivocado. El ensamblado de la raíz `lib/` del paquete es un relleno, y la implementación que funciona vive en `runtimes/`. Mi host de plug-ins se topó exactamente con esto con `Assembly.LoadFrom`, porque la carpeta raíz del plug-in contenía el relleno. La solución es el mismo `AssemblyLoadContext` del paso 6, o una implementación completa con los recursos específicos del RID.

**Un nombre de ensamblado distinto en el mensaje.** Si el error nombra tu propia biblioteca u otro paquete, los detalles específicos de SqlClient de arriba no aplican. La guía general para [un error "Could not load file or assembly" en una aplicación publicada](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) cubre el rastreo del host y el trimming. Para la versión de las herramientas de EF de un desajuste, donde falla `dotnet ef` en lugar de tu aplicación, consulta [la MissingMethodException tras actualizar EF Core Tools](/es/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/).

## Relacionado

- [Migrar una solución .NET a Central Package Management con Directory.Packages.props](/es/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)
- [Migrar de EF Core 6 a EF Core 11: los cambios importantes que realmente afectan](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Solución a FileNotFoundException "Could not load file or assembly" en una aplicación publicada](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [La columna json nativa frente a nvarchar(max) en SQL Server con EF Core 11](/es/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/), que muestra en acción el `SqlDbType.Json` de SqlClient 7
- [Cuál es la diferencia entre dotnet build y dotnet publish](/es/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)

## Fuentes

- [Cambios importantes en EF Core 11: Microsoft.Data.SqlClient se actualizó a 7.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Notas de la versión de Microsoft.Data.SqlClient 7.0.0](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md) y [notas de la versión 7.0.1](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.1.md)
- [dotnet/SqlClient#4310: la versión de ensamblado se mantiene en 7.0.0.0 en toda la 7.x, guía para cargar plug-ins](https://github.com/dotnet/SqlClient/issues/4310)
- [dotnet/efcore#38845: el reporte de EF Core 10.0.11](https://github.com/dotnet/efcore/issues/38845)
- [dotnet/SqlClient#4064](https://github.com/dotnet/SqlClient/issues/4064) y [#4117](https://github.com/dotnet/SqlClient/pull/4117): los reenvíos de tipos de `SqlAuthenticationMethod`
- [Advertencia NU1605 de NuGet](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1605) y [error NU1109](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1109)
- [Crear una aplicación .NET con plug-ins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) y [Sondeo predeterminado](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/default-probing)
