---
title: "Solución: MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' tras actualizar EF Core Tools"
description: "dotnet ef lanza MissingMethodException en ArgumentIsEmpty porque Tools 10.0.6 dejó de traer un Microsoft.EntityFrameworkCore.Design compatible. Fija Design a tu versión de EF Core."
pubDate: 2026-09-08
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "dotnet"
  - "dotnet-10"
  - "nuget"
lang: "es"
translationOf: "2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools"
translatedBy: "claude"
translationDate: 2026-09-08
---

Agrega un `PackageReference` explícito a `Microsoft.EntityFrameworkCore.Design` fijado a la misma versión que el resto de tus paquetes de EF Core, en el **proyecto de inicio**, y luego restaura. `Microsoft.EntityFrameworkCore.Tools` 10.0.6, 10.0.7 y 10.0.8 bajaron su dependencia de Design a `>= 8.0.0`, así que NuGet resuelve tranquilamente Design 8.0.0 junto a un runtime de EF Core 10 y el ensamblado de diseño llama a un método que ya no existe. Actualizar Tools a 10.0.9 o posterior también lo soluciona, porque 10.0.9 restauró la alineación de versiones por framework.

## El error en contexto

Al ejecutar `dotnet ef migrations add` contra un grafo de paquetes roto:

```
Build started...
Build succeeded.
System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigration.<>c__DisplayClass0_0.<.ctor>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.<>c__DisplayClass3_0`1.<Execute>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.Execute(Action action)
Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
```

Exactamente el mismo grafo de paquetes produce una excepción completamente distinta desde `dotnet ef database update` o `dotnet ef migrations list`:

```
System.TypeLoadException: Method 'Identifier' in type 'Microsoft.EntityFrameworkCore.Design.Internal.CSharpHelper' from assembly 'Microsoft.EntityFrameworkCore.Design, Version=8.0.26.0, Culture=neutral, PublicKeyToken=adb9793829ddae60' does not have an implementation.
   at Microsoft.EntityFrameworkCore.Design.DesignTimeServiceCollectionExtensions.<>c__DisplayClass0_0.<AddEntityFrameworkDesignTimeServices>b__0(ServiceCollectionMap services)
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder.TryAddProviderSpecificServices(Action`1 serviceMap)
```

En la Package Manager Console de Visual Studio lo mismo aparece con `Add-Migration` y `Update-Database`. Ambos mensajes tienen una única causa. La `TypeLoadException` es la más útil de las dos, porque imprime la versión del ensamblado culpable dentro del propio mensaje.

## Por qué ocurre

`Microsoft.EntityFrameworkCore.Design` es el ensamblado que realmente implementa el andamiaje de migraciones y la ingeniería inversa. Ni `dotnet ef` ni la Package Manager Console lo incluyen: lo cargan desde el grafo de dependencias resuelto de tu proyecto de inicio. Así que la versión de Design es la que eligió NuGet, y NuGet elige la versión más baja que satisface todas las restricciones.

Hasta 10.0.5, `Microsoft.EntityFrameworkCore.Tools` declaraba una dependencia de `Microsoft.EntityFrameworkCore.Design` con un piso igual a su propia versión, así que referenciar Tools bastaba para traer un Design compatible. En 10.0.6 ese piso bajó a `8.0.0`. El cambio se lee directamente en el catálogo de NuGet:

| Versión de Tools | Publicada | Dependencia de Design |
| --- | --- | --- |
| 10.0.5 | 2026-03-12 | `net8.0` -> `[10.0.5, )` |
| 10.0.6 | 2026-04-14 | `net8.0` -> `[8.0.0, )` |
| 10.0.7 | 2026-04-21 | `net8.0` -> `[8.0.0, )` |
| 10.0.8 | 2026-05-12 | `net8.0` -> `[8.0.0, )` |
| 10.0.9 | 2026-06-09 | `net8.0` -> `[8.0.26, )`, `net9.0` -> `[9.0.15, )`, `net10.0` -> `[10.0.9, )` |
| 10.0.10 | 2026-07-14 | misma forma, `net10.0` -> `[10.0.10, )` |
| 10.0.11 | 2026-08-11 | misma forma, `net10.0` -> `[10.0.11, )` |

La razón del cambio en 10.0.6 era legítima. El paquete Tools apunta a `net8.0` y está pensado para usarse desde proyectos `net8.0`, `net9.0` y `net10.0`, pero Design 10.0.x solo publica un asset `net10.0`, así que un único piso alto rompía la restauración de proyectos en frameworks más antiguos. Bajar el piso a `8.0.0` arregló la restauración y rompió a todos los que tenían un runtime de EF Core 9.x o 10.x, porque un único grupo de dependencias `net8.0` aplica a todos los frameworks consumidores. Tools 10.0.9 lo resolvió bien con tres grupos de dependencias, uno por framework de destino.

El fallo es una ruptura de compatibilidad binaria pura y dura. `Check.NotEmpty` en EF Core 10 llama a `AbstractionsStrings.ArgumentIsEmpty(object)`; las compilaciones 8.x y 9.x de esa clase de recursos exponen una firma distinta. El JIT resuelve la llamada en la primera ejecución de `AddMigrationImpl` y lanza la excepción.

## Reproducción mínima

Bastan dos referencias de paquete y un `DbContext`. Este es el proyecto completo, verificado con el SDK 10.0.302 y `dotnet-ef` 10.0.11 el 2026-09-08:

```xml
<!-- SDK 10.0.302. Reproduces the failure exactly as written. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=app.db");
}
```

Después de `dotnet restore`, el grafo queda así:

```
$ dotnet list package --include-transitive
   > Microsoft.EntityFrameworkCore              10.0.11
   > Microsoft.EntityFrameworkCore.Abstractions 10.0.11
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

Todo lo del lado del runtime es 10.0.11 y el ensamblado de diseño es 8.0.0. `dotnet ef migrations add Initial` entonces falla.

## La solución, en detalle

### 1. Fija Design explícitamente en el proyecto de inicio

Esta es la solución que recomienda el equipo de EF, y la que sigue funcionando sin importar lo que declaren las futuras versiones de Tools:

```xml
<!-- SDK 10.0.302, EF Core 10.0.11. Version must match your other EF Core packages. -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

`PrivateAssets=all` mantiene el ensamblado de diseño fuera de tu salida publicada, y por eso vale la pena escribir el bloque de metadatos completo en vez de usar la línea suelta. Con esto en su sitio, `dotnet ef migrations add Initial` funciona incluso con Tools todavía en 10.0.6.

La palabra **inicio** importa. `dotnet ef` compila y carga el proyecto de inicio, no el proyecto que contiene tu `DbContext`. En una solución donde `Data` posee el contexto y `Api` es el punto de entrada, fijar Design dentro de `Data` no sirve de nada, porque `PrivateAssets=all` impide que fluya a través de la referencia de proyecto:

```
$ dotnet list Api/Api.csproj package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

El comando sigue fallando con el mismo `MissingMethodException`. Mueve la referencia a `Api` y pasa. Si por convención mantienes los paquetes de diseño en el proyecto del contexto, agrega la referencia en ambos.

### 2. O actualiza Tools a 10.0.9 o posterior

Si prefieres no agregar una referencia de paquete, actualizar el paquete Tools basta por sí solo, porque 10.0.9 restauró la alineación por framework:

```
$ dotnet list package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       10.0.9
```

La advertencia: obtienes el piso del paquete Tools, no tu versión de EF Core. Tools 10.0.9 junto a EF Core 10.0.11 te da Design 10.0.9, que funciona, pero es un desfase de versión que tú no elegiste. La solución 1 sigue siendo el mejor hábito.

### 3. O vuelve Tools a 10.0.5

Bajar a 10.0.5 restaura la vieja dependencia de versión coincidente y es una parada de emergencia válida si estás a mitad de una entrega y no puedes tocar archivos de proyecto a lo ancho. Sin embargo es un callejón sin salida: 10.0.5 es anterior a varios meses de correcciones de herramientas, y cualquier actualización posterior te devuelve directo a la ventana rota a menos que apliques también la solución 1.

### 4. Central Package Management

Con CPM la versión vive en `Directory.Packages.props`, y aplica la misma regla: declara Design ahí y referéncialo desde el proyecto de inicio.

```xml
<!-- Directory.Packages.props, EF Core 10.0.11 -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.11" />
</ItemGroup>
```

Una entrada `PackageVersion` por sí sola no agrega el paquete. Solo fija la versión si algo lo referencia. Si Design llega al grafo de forma transitiva a través de Tools, `CentralPackageTransitivePinningEnabled` puesto en `true` elevará el Design transitivo a la versión que declaraste, lo cual es una segunda línea de defensa razonable para una solución grande.

## Cómo confirmar qué versión de Design cargará la herramienta

No confíes en `dotnet ef --version`. Reporta la herramienta global, que es independiente del grafo del proyecto:

```
$ dotnet ef --version
Entity Framework Core .NET Command-line Tools
10.0.11
```

Eso imprime 10.0.11 mientras el proyecto carga Design 8.0.0. Dos comandos dan la respuesta real. El primero muestra la versión resuelta y quién la pidió:

```
$ dotnet nuget why . Microsoft.EntityFrameworkCore.Design
Project 'EfToolsRepro' has the following dependency graph(s) for
'Microsoft.EntityFrameworkCore.Design':

  [net10.0]
  └── Microsoft.EntityFrameworkCore.Tools (v10.0.6)
      └── Microsoft.EntityFrameworkCore.Design (v8.0.0)
```

`dotnet nuget why` necesita el SDK de .NET 9 o posterior y es la forma más rápida de averiguar qué paquete está arrastrando el Design antiguo, que no siempre es Tools. Cualquier biblioteca de tu solución que referencie Design directamente con un piso antiguo puede hacer lo mismo.

La segunda comprobación lee la salida de compilación, que es contra lo que realmente resuelven las herramientas:

```
$ grep -o '"Microsoft.EntityFrameworkCore.Design/[0-9.]*"' bin/Debug/net10.0/Api.deps.json
"Microsoft.EntityFrameworkCore.Design/8.0.0"
```

Ten en cuenta que el ensamblado de Design no se copia a `bin`. Se resuelve desde la carpeta global de paquetes de NuGet a través de la entrada en `deps.json`, así que buscar la DLL junto a tu ejecutable no te dice nada.

## Trampas y errores parecidos

**Algunos comandos siguen funcionando, y por eso la gente descarta demasiado pronto un problema de paquetes.** Con Design 8.0.26 junto a EF Core 10.0.11, `dotnet ef dbcontext info` imprime el contexto, el proveedor y el origen de datos sin quejarse, y `dotnet ef dbcontext script` emite SQL correcto. Solo revientan las rutas de código que tocan los tipos desalineados. No concluyas que tus herramientas están alineadas porque un comando devolvió éxito.

**Lee la firma de `AddMigrationImpl` en la traza de pila.** Identifica la versión de Design cargada sin ninguna investigación adicional. Design 9.x tiene un parámetro `Boolean dryRun` que 8.x y 10.x no tienen:

```
// Design 9.0.15
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace, Boolean dryRun)

// Design 8.0.26
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
```

**"Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design" es un error distinto con una causa vecina.** Ese significa que Design está ausente por completo en lugar de presente con la versión equivocada. Vale la pena saber que `Microsoft.EntityFrameworkCore.Tools` 11.0.0-preview.7.26381.103, publicado el 2026-08-11, declara un grupo de dependencias `net10.0` vacío: ninguna dependencia de Design. Si arrastras la costumbre de referenciar solo Tools hacia una actualización a EF Core 11, te encontrarás con [el error de que el proyecto de inicio no referencia Design](/es/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/) en vez de con este. El pin explícito de la solución 1 cubre ambos.

**"Unable to create an object of type 'DbContext'" no tiene relación.** Eso es un problema de fábrica de diseño o de host builder, no un desfase de versiones. Si tu traza de pila menciona `DbContextActivator` o un `IDesignTimeDbContextFactory` faltante, lo que quieres es [la ruta de diagnóstico para la creación del DbContext](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) y no esta página.

**`MissingMethodException` en tiempo de ejecución de la aplicación en vez de en tiempo de diseño.** Si la excepción salta desde tu aplicación web y no desde `dotnet ef`, el culpable suele ser una biblioteca compilada contra una versión mayor distinta de EF Core, no el paquete Design. El diagnóstico es el mismo, eso sí: ejecuta `dotnet nuget why` sobre `Microsoft.EntityFrameworkCore` y busca un paquete con un piso antiguo.

**Un bundle de migraciones hereda el problema.** Como `dotnet ef migrations bundle` ejecuta la misma pila de diseño para construir el ejecutable, un grafo roto puede producir un bundle a partir de un modelo obsoleto o fallar directamente. Arregla la referencia antes de generar el artefacto que piensas ejecutar contra producción, tal como se describe en el [recorrido de despliegue con bundle de migraciones](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Qué hacer al actualizar a EF Core 11

EF Core 11 está en preview a septiembre de 2026 y se lanza con .NET 11 en noviembre de 2026. Como el único SDK en esta máquina es 10.0.302, toda la salida de comandos de arriba se produjo contra EF Core 10.0.11, no 11. Lo que sí es verificable hoy desde el catálogo de NuGet es la forma de las dependencias: Tools 11.0.0-preview.7 no tiene ninguna dependencia de paquete. Trata `Microsoft.EntityFrameworkCore.Design` como un paquete que siempre declaras tú, en la versión exacta de tus otros paquetes de EF Core, y esta clase de fallo deja de ser posible sin importar lo que declare Tools. Es un cambio de una línea que conviene hacer antes de empezar [el trabajo más amplio de migración a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), porque un comando de migraciones que falla a mitad de una actualización es muy difícil de atribuir a un piso de NuGet.

La regla general que ilustra este incidente: mantén todos los paquetes `Microsoft.EntityFrameworkCore.*` en una misma versión, incluidos los que nunca haces `using`. EF Core no admite mezclar versiones mayores entre sus propios ensamblados, y las herramientas no te avisan cuando NuGet resuelve en silencio un grafo que las mezcla.

## Relacionados

- [Solución: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/es/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/)
- [Solución: dotnet tool install --global dotnet-ef lanza un error](/es/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [Solución: dotnet ef migrations add falla con "Unable to create an object of type DbContext"](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Cómo aplicar migraciones de EF Core 11 en producción con un bundle de migraciones](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Solución: "The model for context 'X' has pending changes" en EF Core 11](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)

## Fuentes

- [dotnet/efcore#38124, anuncio: cambio de dependencia del paquete Design en Microsoft.EntityFrameworkCore.Tools 10.0.6](https://github.com/dotnet/efcore/issues/38124)
- [dotnet/efcore#38107, excepción en Add-Migration: AbstractionsStrings.ArgumentIsEmpty](https://github.com/dotnet/efcore/issues/38107)
- [dotnet/efcore#38123, cerrado como duplicado del 38107, con la variante TypeLoadException](https://github.com/dotnet/efcore/issues/38123)
- [Microsoft.EntityFrameworkCore.Tools en NuGet, grupos de dependencias por versión](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tools/)
- [Referencia de herramientas de Entity Framework Core para la CLI de .NET](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [Referencia del comando dotnet nuget why](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-why)
