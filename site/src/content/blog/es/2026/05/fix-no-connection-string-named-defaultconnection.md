---
title: "Solución: System.InvalidOperationException: No connection string named 'DefaultConnection' could be found"
description: "Si GetConnectionString devuelve null en .NET 11, a tu appsettings.json le falta la clave, no se copia a la salida del build, o se está seleccionando el archivo de entorno equivocado. Tres comprobaciones resuelven el 95% de los casos."
pubDate: 2026-05-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "ef-core"
  - "configuration"
lang: "es"
translationOf: "2026/05/fix-no-connection-string-named-defaultconnection"
translatedBy: "claude"
translationDate: 2026-05-05
---

La solución: `IConfiguration.GetConnectionString("DefaultConnection")` devuelve `null`, y EF Core lanza la excepción porque esperaba una cadena. O bien tu `appsettings.json` no contiene una entrada `ConnectionStrings:DefaultConnection`, el archivo no se está copiando a la salida del build, o el entorno seleccionado es incorrecto y la clave solo existe en un archivo hermano. Verifica el JSON, configura `Copy to Output Directory = Copy if newer` y confirma que `ASPNETCORE_ENVIRONMENT` coincide con el archivo donde escribiste la cadena.

```text
Unhandled exception. System.InvalidOperationException: No connection string named 'DefaultConnection' could be found in the application configuration.
   at Microsoft.EntityFrameworkCore.SqlServerDbContextOptionsExtensions.UseSqlServer(DbContextOptionsBuilder optionsBuilder, String connectionString, Action`1 sqlServerOptionsAction)
   at Program.<Main>$(String[] args) in C:\src\Api\Program.cs:line 14
   at Program.<Main>(String[] args)
```

El error lo lanza `UseSqlServer(string)` de EF Core (y los equivalentes de Npgsql, MySQL, SQLite) cuando el parámetro de tipo string es `null`. El texto de la excepción proviene de la validación de parámetros de EF Core, pero la causa raíz siempre está aguas arriba en `Microsoft.Extensions.Configuration`. Esta guía está escrita contra .NET 11 preview 4, EF Core 11.0.0-preview.4 y `Microsoft.AspNetCore.App` 11.0.0-preview.4. El mismo consejo aplica hasta .NET Core 3.1.

## Por qué GetConnectionString devuelve null

`IConfiguration.GetConnectionString("X")` es azúcar sintáctica para `configuration["ConnectionStrings:X"]`. El sistema de configuración recorre cada proveedor registrado en orden (archivos JSON, user secrets, variables de entorno, argumentos de línea de comandos) y devuelve la primera coincidencia. `null` significa que **ninguno** de los proveedores tenía esa clave. Hay seis razones comunes:

1. La clave falta en `appsettings.json`.
2. La clave está presente, pero el archivo no se copia al directorio de salida, así que el binario en ejecución nunca la ve.
3. La clave está en `appsettings.Production.json`, pero la app corre en `Development`, donde solo se carga `appsettings.Development.json`.
4. Las herramientas en tiempo de diseño de EF Core (`dotnet ef migrations add`) se invocan desde una carpeta que no contiene el archivo JSON.
5. La clave vive en User Secrets, pero al `.csproj` del proyecto le falta `<UserSecretsId>`.
6. La cadena de conexión está como variable de entorno, pero el nombre usa un guion bajo simple (`ConnectionStrings_DefaultConnection`) en vez del doble guion bajo requerido (`ConnectionStrings__DefaultConnection`).

Los casos 2 y 6 son los asesinos silenciosos, porque el código se ve correcto al inspeccionarlo.

## Una reproducción mínima

Una Web API limpia creada con `dotnet new webapi -n Api` y un enganche de EF Core. Es la configuración más pequeña que reproduce el error de forma fiable.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));

var app = builder.Build();
app.MapGet("/", () => "ok");
app.Run();

public class AppDb : DbContext
{
    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

```json
// appsettings.json -- this file is what you THINK is being read
{
  "Logging": { "LogLevel": { "Default": "Information" } },
  "AllowedHosts": "*"
}
```

`builder.Configuration.GetConnectionString("DefaultConnection")` devuelve `null`, EF Core lanza en `UseSqlServer(null)`, y el host falla al construirse. El mensaje de la excepción nombra `DefaultConnection`, lo cual es engañoso: nada en EF Core obliga a usar ese nombre. Cualquier cadena que hayas pasado a `GetConnectionString(...)` aparecerá ahí.

## La solución en tres comprobaciones

Ejecútalas en orden. Cada una me ha pillado al menos una vez.

### 1. Verifica que el JSON tiene la clave

Abre `appsettings.json` en el proyecto que aloja `Program.cs` (no el proyecto que define `DbContext`, si difieren) y agrega la sección:

```json
// appsettings.json
{
  "ConnectionStrings": {
    "DefaultConnection": "Server=(localdb)\\mssqllocaldb;Database=AppDb;Trusted_Connection=True;TrustServerCertificate=True"
  }
}
```

El nombre del proveedor en `UseSqlServer` es independiente del formato de la cadena de conexión; SQL Server, PostgreSQL, MySQL y SQLite leen la misma forma `ConnectionStrings:Name`. Si tu JSON tiene la clave pero anidada dentro de un objeto `Settings`, `GetConnectionString` no la encontrará. La ruta exacta debe ser `ConnectionStrings.<Name>`.

### 2. Confirma que el archivo está en la salida del build

Esto pilla a las bibliotecas de clases y a los servicios worker, donde la plantilla del proyecto no incluye `appsettings.json` por defecto. Después de `dotnet build`, comprueba que el archivo esté junto a tu DLL:

```bash
dotnet build
ls bin/Debug/net11.0/appsettings.json
```

Si falta, agrega esto al `.csproj`:

```xml
<!-- .NET 11 SDK-style csproj -->
<ItemGroup>
  <None Update="appsettings.json">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
  </None>
  <None Update="appsettings.*.json">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    <DependentUpon>appsettings.json</DependentUpon>
  </None>
</ItemGroup>
```

`Microsoft.NET.Sdk.Web` lo incluye implícitamente, así que un proyecto creado con `dotnet new webapi` no lo necesita. Los proyectos worker (`Microsoft.NET.Sdk.Worker`) también lo incluyen. El `Microsoft.NET.Sdk` plano no, y ahí es donde viven la mayoría de estos bugs: un host de consola reutilizado para `dotnet ef`, o una biblioteca de clases que ganó un `Program.cs` después.

### 3. Haz que el entorno coincida con el archivo donde escribiste

`WebApplication.CreateBuilder` carga primero `appsettings.json`, luego `appsettings.{Environment}.json`, y el segundo sobrescribe al primero. El entorno se lee desde `ASPNETCORE_ENVIRONMENT` (Web) o `DOTNET_ENVIRONMENT` (host genérico), con `Production` por defecto si ninguno está definido. Un modo de fallo común: pones la cadena de conexión solo en `appsettings.Development.json`, y luego ejecutas la app en producción donde solo se cargan `appsettings.json` y `appsettings.Production.json`.

```bash
# powershell
$env:ASPNETCORE_ENVIRONMENT = "Development"

# bash
export ASPNETCORE_ENVIRONMENT=Development

dotnet run
```

Imprime el valor resuelto una vez durante el arranque para verlo en los logs:

```csharp
// .NET 11, C# 14
var cs = builder.Configuration.GetConnectionString("DefaultConnection");
Console.WriteLine($"DefaultConnection length: {cs?.Length ?? 0}");
```

Nunca registres la cadena de conexión completa en producción, porque las contraseñas suelen vivir ahí. Registrar la longitud es suficiente para distinguir `null` de "cargada pero vacía" de "cargada con contenido".

## Variantes que afectan a distintas audiencias

### `dotnet ef migrations add` desde una biblioteca de clases

Las herramientas en tiempo de diseño de EF Core resuelven el `DbContext` llamando a tu `Program.Main` o encontrando un `IDesignTimeDbContextFactory<T>`. Si el `DbContext` vive en una biblioteca de clases, `dotnet ef` invoca al **proyecto de inicio** (la Web API) y lee su configuración. Ejecuta desde la carpeta correcta:

```bash
# Bad: connection string is in Api/appsettings.json,
# but you ran this in Data/, where there is no JSON.
cd Data
dotnet ef migrations add Init

# Good: point at the startup project explicitly.
cd Data
dotnet ef migrations add Init --startup-project ../Api/Api.csproj
```

Si debes ejecutar las migraciones desde el proyecto de datos en modo independiente (por ejemplo, en un pipeline de release), agrega un `IDesignTimeDbContextFactory<AppDb>`:

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbFactory : IDesignTimeDbContextFactory<AppDb>
{
    public AppDb CreateDbContext(string[] args)
    {
        var config = new ConfigurationBuilder()
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile("appsettings.json", optional: false)
            .AddEnvironmentVariables()
            .Build();

        var options = new DbContextOptionsBuilder<AppDb>()
            .UseSqlServer(config.GetConnectionString("DefaultConnection"))
            .Options;

        return new AppDb(options);
    }
}
```

Esta factory es solo de tiempo de diseño; no se registra en DI ni se ejecuta en runtime.

### Variables de entorno en contenedores

En Docker y Kubernetes, la convención es aplanar las rutas de configuración con dobles guiones bajos. `ConnectionStrings:DefaultConnection` se convierte en `ConnectionStrings__DefaultConnection`. Un guion bajo simple es solo un nombre normal, y el sistema de configuración no lo reconocerá.

```yaml
# docker-compose, .NET 11
services:
  api:
    image: api:11.0
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      ConnectionStrings__DefaultConnection: "Server=db;Database=App;User Id=sa;Password=..."
```

```bash
# Kubernetes secret reference
- name: ConnectionStrings__DefaultConnection
  valueFrom:
    secretKeyRef:
      name: db
      key: connection
```

Si la variable es correcta pero sigue sin aparecer, confirma que `AddEnvironmentVariables()` esté en el pipeline de configuración. `WebApplication.CreateBuilder` lo llama por ti. Un `ConfigurationBuilder` personalizado en un proyecto de consola no, a menos que lo agregues explícitamente.

### User Secrets en desarrollo

`dotnet user-secrets set "ConnectionStrings:DefaultConnection" "..."` solo funciona cuando el `.csproj` del proyecto tiene un elemento `<UserSecretsId>`:

```xml
<!-- .NET 11 SDK-style csproj -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <UserSecretsId>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</UserSecretsId>
</PropertyGroup>
```

`dotnet user-secrets init` lo agrega por ti. Los user secrets solo se cargan cuando `IHostEnvironment.IsDevelopment()` es `true`, que es otra razón por la que importa la comprobación 3 (la del entorno).

### Azure Key Vault y otros proveedores

Si usas `builder.Configuration.AddAzureKeyVault(...)`, el nombre del secreto debe coincidir con la ruta de configuración usando `--` como separador. Un secreto del vault llamado `ConnectionStrings--DefaultConnection` aparece como `ConnectionStrings:DefaultConnection`. Un secreto llamado `DefaultConnection` no.

### El error menciona un nombre que no reconoces

Si el mensaje dice `No connection string named 'X'` y `X` no es el nombre que escribiste, probablemente estás llamando a `UseSqlServer(connectionStringName: "X")` en una sobrecarga antigua de EF Core que resuelve nombres contra la tabla de cadenas de conexión de la aplicación. EF Core 11 todavía lo soporta por compatibilidad. La solución es la misma: agrega una entrada `ConnectionStrings:X`, o pasa la cadena de conexión literal en vez de un nombre.

### Native AOT y trimming

Si publicas con Native AOT, el binding de configuración sigue funcionando para `GetConnectionString`, que es una búsqueda de string plana. El error que estás viendo no es una advertencia de trim de AOT. Si además ves `IL3050`, esa es la advertencia de binding para el binding por reflexión de `Configure<T>`, no para cadenas de conexión.

## Relacionado

Para el contexto más amplio de EF Core que suele rodear este error, revisa el resumen sobre [detección de consultas N+1](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) y la guía de [consultas compiladas en rutas críticas](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). Cuando conectes pruebas contra la misma cadena de conexión, el [tutorial de Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) muestra cómo levantar un SQL Server real por fixture sin commitear credenciales. Para diagnosticar este tipo de fallo de arranque en una app en ejecución, la [configuración de Serilog y Seq](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) hace legible la configuración resuelta en los logs de producción.

## Fuentes

- [`IConfiguration.GetConnectionString` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.configuration.configurationextensions.getconnectionstring), Microsoft Learn.
- [Configuration in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/), Microsoft Learn.
- [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation), EF Core docs.
- [Safe storage of app secrets in development](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets), Microsoft Learn.
- [Environment variables configuration provider](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/#environment-variables), Microsoft Learn, sobre el separador `__`.
