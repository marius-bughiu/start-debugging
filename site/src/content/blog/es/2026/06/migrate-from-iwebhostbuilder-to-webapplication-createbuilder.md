---
title: "Migra de IWebHostBuilder a WebApplication.CreateBuilder en .NET 11"
description: "Una migración paso a paso del antiguo modelo de hospedaje con Startup.cs más WebHostBuilder al modelo de hospedaje mínimo con WebApplication.CreateBuilder, incluyendo la deprecación ASPDEPR008, el orden del middleware, IStartupFilter y cómo mantener tus pruebas funcionando."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "minimal-hosting"
lang: "es"
translationOf: "2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder"
translatedBy: "claude"
translationDate: 2026-06-06
---

Si tu `Program.cs` todavía llama a `Host.CreateDefaultBuilder(args).ConfigureWebHostDefaults(web => web.UseStartup<Startup>())`, estás ejecutando el modelo de hospedaje heredado y el compilador ha empezado a advertirte al respecto. A partir de .NET 10, `WebHost`, `WebHostBuilder` e `IWebHost` están marcados como obsoletos con el diagnóstico `ASPDEPR008`, y esa deprecación se traslada a .NET 11. El reemplazo es el modelo de hospedaje mínimo construido en torno a `WebApplication.CreateBuilder(args)`, que ha sido el predeterminado en todas las plantillas de proyecto desde ASP.NET Core 6.0. Este post migra una aplicación basada en `Startup` al hospedaje mínimo usando `net11.0` como destino, cubriendo las partes que de verdad hacen tropezar a la gente: el orden del middleware, el scope de inyección de dependencias perdido al iniciar, `IStartupFilter` y mantener en verde las pruebas con `WebApplicationFactory`.

La migración es mecánica para un servicio pequeño (una hora o dos) y de medio día para un monolito con middleware personalizado, implementaciones de `IStartupFilter` y un `ConfigureServices` grande. Nada del comportamiento de tu aplicación tiene que cambiar. Estás moviendo los mismos registros y el mismo pipeline de middleware a un archivo más plano. La única diferencia semántica real es el scope de inyección de dependencias al iniciar, que se cubre más abajo.

## Por qué migrar ahora

- `WebHost` / `WebHostBuilder` / `IWebHost` emiten advertencias de compilación `ASPDEPR008` a partir de .NET 10. Si compilas con `TreatWarningsAsErrors`, tu actualización a .NET 11 fallará al compilar hasta que dejes de usarlos.
- El modelo de hospedaje mínimo es donde aterriza toda la nueva inversión de ASP.NET Core. Características como Native AOT para las minimal APIs, el adelgazado `WebApplication.CreateSlimBuilder` y `CreateEmptyBuilder` solo existen en el nuevo camino.
- Dos archivos de arranque se colapsan en uno. `Startup.cs` más un método de plomería `CreateHostBuilder` se convierten en un único `Program.cs` legible, y la configuración, los servicios y el pipeline se leen de arriba a abajo.
- Desbloquea las minimal APIs. No puedes llamar limpiamente a `app.MapGet(...)` en una base de código cuyo pipeline vive dentro de una firma `Startup.Configure(IApplicationBuilder, IWebHostEnvironment)`.

## Qué se rompe

| Área                       | Cambio                                                                                       | Severidad |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| `WebHost` / `IWebHost`     | Obsoletos a partir de .NET 10 (`ASPDEPR008`). Advertencias, o errores bajo `TreatWarningsAsErrors`     | alta     |
| `Startup` vía `builder.Host`| `WebApplicationBuilder.Host.ConfigureWebHostDefaults(...UseStartup<T>())` lanza en tiempo de ejecución  | alta     |
| Scope de DI al iniciar           | No hay scope alrededor del proveedor de servicios durante el inicio; resolver servicios scoped ahora lanza    | media   |
| Orden del middleware        | El cuerpo de `Configure` debe re-expresarse después de `builder.Build()`, en el mismo orden             | media   |
| `IStartupFilter`           | Sigue ejecutándose, pero ahora se ejecuta alrededor del pipeline de hospedaje mínimo; verifica el orden       | baja      |
| `IHostingStartup`          | Sigue soportado, pero lee `WebApplicationBuilder` de forma diferente para algunos ensamblados              | baja      |
| `IWebHostBuilder` (interfaz)| Sobrevive vía `builder.WebHost` para configuración acotada (`UseKestrel`, `UseUrls`); no desaparece        | baja      |

Fíjate en la última fila. La *interfaz* `IWebHostBuilder` no se elimina. `WebApplicationBuilder` la expone como `builder.WebHost`, de modo que todavía puedes llamar a `builder.WebHost.ConfigureKestrel(...)`. Lo que está deprecado es el arranque independiente `WebHost.CreateDefaultBuilder()` y el `IWebHost` que construye. El destino de la migración es `WebApplication.CreateBuilder`, no la eliminación de todos los tipos que tengan `WebHost` en su nombre.

## Lista de verificación previa

1. Instala el SDK de .NET 11 en cada máquina de desarrollo y runner de CI. Verifica con `dotnet --list-sdks` y confirma que aparece `11.0.x`.
2. Confirma que el proyecto ya tiene como destino `net6.0` o posterior. El modelo de hospedaje mínimo no existe antes de .NET 6, así que una aplicación en .NET 5 o anterior necesita primero un salto de framework. Consulta la [lista de verificación de .NET 8 a .NET 11](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) si además estás cruzando versiones LTS, o la [guía de .NET Framework 4.8 a .NET 11](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) para el salto mayor.
3. Inventaría tu clase `Startup`. Lista cada línea de `ConfigureServices` y cada llamada de middleware en `Configure`, en orden. El orden en `Configure` es el contrato que debes preservar.
4. Busca con grep las implementaciones de `IStartupFilter` y los ensamblados `IHostingStartup`. Estos se ejecutan fuera de `Startup` y es fácil olvidarlos.
5. Confirma una línea base limpia para tener una reversión en un solo comando.

## El antes: una aplicación basada en Startup

Esta es la forma que comparte casi toda aplicación anterior a 6.0. Dos archivos, con el cableado del host separado de la configuración de servicios y del pipeline.

```csharp
// Program.cs -- legacy generic host, ASP.NET Core 3.1 / 5.0 style
// Builds with ASPDEPR008 warnings on .NET 10/11 if WebHost APIs are used
public class Program
{
    public static void Main(string[] args) =>
        CreateHostBuilder(args).Build().Run();

    public static IHostBuilder CreateHostBuilder(string[] args) =>
        Host.CreateDefaultBuilder(args)
            .ConfigureWebHostDefaults(webBuilder =>
            {
                webBuilder.UseStartup<Startup>();
            });
}
```

```csharp
// Startup.cs -- legacy services + pipeline split
public class Startup
{
    public Startup(IConfiguration configuration) => Configuration = configuration;

    public IConfiguration Configuration { get; }

    public void ConfigureServices(IServiceCollection services)
    {
        services.AddControllers();
        services.AddDbContext<AppDbContext>(o =>
            o.UseSqlServer(Configuration.GetConnectionString("DefaultConnection")));
        services.AddScoped<IOrderService, OrderService>();
        services.AddSwaggerGen();
    }

    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
    {
        if (env.IsDevelopment())
        {
            app.UseDeveloperExceptionPage();
            app.UseSwagger();
            app.UseSwaggerUI();
        }

        app.UseHttpsRedirection();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseEndpoints(endpoints => endpoints.MapControllers());
    }
}
```

## Pasos de migración

### 1. Mueve ConfigureServices al builder

Crea el builder, luego copia cada línea de `Startup.ConfigureServices` literalmente, reemplazando `services` por `builder.Services`. `IConfiguration` está disponible como `builder.Configuration`, así que la búsqueda de la cadena de conexión se traslada sin cambios.

```csharp
// Program.cs -- .NET 11, minimal hosting model
var builder = WebApplication.CreateBuilder(args);

// formerly Startup.ConfigureServices, services -> builder.Services
builder.Services.AddControllers();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddSwaggerGen();
```

Verifica: ejecuta `dotnet build`. El proyecto debería compilar con los registros de servicios en su sitio, antes de tocar el pipeline. Si un registro falla al resolver `builder.Configuration`, copiaste una referencia a un campo `Configuration` que ya no existe; cámbiala por `builder.Configuration`.

### 2. Construye la aplicación y re-expresa el pipeline en el mismo orden

Llama a `builder.Build()`, luego traduce `Startup.Configure` línea por línea. `IApplicationBuilder app` se convierte en la `WebApplication app`, y `env.IsDevelopment()` se convierte en `app.Environment.IsDevelopment()`. El orden del middleware debe coincidir con el original exactamente, porque el orden es el pipeline.

```csharp
// .NET 11, minimal hosting model -- continued
var app = builder.Build();

// formerly Startup.Configure, same order
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

Dos cosas se encogieron. `UseRouting` y `UseEndpoints` ya no son necesarios: el host mínimo agrega el middleware de enrutamiento automáticamente, y `app.MapControllers()` reemplaza el bloque `UseEndpoints(e => e.MapControllers())`. Si tienes middleware que debe ejecutarse *entre* el enrutamiento y la ejecución del endpoint (por ejemplo, un middleware personalizado que lee los metadatos del endpoint coincidente), mantén una llamada explícita a `app.UseRouting()` y coloca ese middleware después de ella. De lo contrario, elimina ambos.

Verifica: `dotnet run`, luego accede a una ruta conocida. Un 200 en una acción de un controlador confirma que el pipeline está cableado. Un 404 en todas las rutas suele significar que falta `MapControllers` o que está antes de un middleware terminal.

### 3. Elimina Startup.cs y la plomería de CreateHostBuilder

Una vez que `Program.cs` contiene todo, elimina `Startup.cs` y el antiguo método `CreateHostBuilder`. No intentes mantener `Startup` vivo llamando a `builder.Host.ConfigureWebHostDefaults(web => web.UseStartup<Startup>())`. Eso lanza en tiempo de ejecución: el hospedaje mínimo prohíbe configurar el web host a través de `builder.Host` o `builder.WebHost` una vez que estás en `WebApplicationBuilder`.

Si no puedes eliminar `Startup` de una sola pasada (un `ConfigureServices` gigante que quieres migrar de forma incremental), el patrón puente es instanciarlo manualmente en lugar de enrutarlo a través del host:

```csharp
// .NET 11 -- temporary bridge, not the WebApplicationBuilder.Host path
var builder = WebApplication.CreateBuilder(args);
var startup = new Startup(builder.Configuration);
startup.ConfigureServices(builder.Services);

var app = builder.Build();
startup.Configure(app, app.Environment); // Configure must accept IApplicationBuilder
app.Run();
```

Esto compila porque `WebApplication` implementa `IApplicationBuilder` e `IEndpointRouteBuilder`. Trátalo como andamiaje para un único PR, no como un destino.

Verifica: busca en la solución `UseStartup`, `WebHost.CreateDefaultBuilder` y `ConfigureWebHostDefaults`. Cero coincidencias significa que el arranque heredado desapareció y `ASPDEPR008` no se disparará.

### 4. Mueve la configuración del host y de Kestrel al builder

Todo lo que configuraste en el antiguo `IWebHostBuilder` (límites de Kestrel, URLs, content root) se mueve a `builder.WebHost`, que todavía expone la superficie de `IWebHostBuilder`. Las cuestiones del host genérico (registro de eventos, la integración con Serilog, `UseWindowsService`) se mueven a `builder.Host`.

```csharp
// .NET 11 -- host/web host configuration on the new builder
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 50 * 1024 * 1024);
builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));
```

Verifica: confirma que el límite configurado surte efecto (un cuerpo de solicitud por encima del límite devuelve `413`), y que tu sink de registro sigue recibiendo entradas.

## Verificación

Ejecuta esta lista de verificación después de la migración antes de hacer merge:

- `dotnet build` produce cero advertencias `ASPDEPR008` y cero referencias a `UseStartup`.
- `dotnet run` arranca y sirve una ruta conocida con el código de estado esperado.
- `dotnet test` pasa, incluyendo cualquier prueba de integración con `WebApplicationFactory` (consulta la trampa más abajo).
- El comportamiento dependiente del middleware sigue funcionando de extremo a extremo: desafíos de autenticación, redirección HTTPS, preflight de CORS, respuestas del manejador de excepciones.
- Un cuerpo de solicitud por encima de tu límite de Kestrel sigue devolviendo `413`, confirmando que la configuración del host migró.

## Plan de reversión

Esta migración es reversible hasta que elimines `Startup.cs`. La secuencia segura es hacer los pasos 1 y 2 en una rama, confirmar que las pruebas pasan, y solo entonces eliminar los archivos heredados en un commit aparte. Si algo regresa después de la eliminación, haz `git revert` del commit de eliminación para restaurar `Startup.cs` y el antiguo `Program.cs`. Como el patrón `Startup` sigue funcionando en .NET 11 (solo advierte, no se elimina), una reversión temporal te mantiene entregando mientras depuras. El punto de no retorno es eliminar por completo el arranque del host genérico; mantén eso en su propio commit.

## Trampas con las que tropezamos

**El scope de DI al iniciar desapareció.** El antiguo host genérico creaba un scope de DI mientras construía el proveedor de servicios, así que el código que resolvía un servicio scoped durante el inicio funcionaba por casualidad. El hospedaje mínimo no lo hace. Si resolvías un `DbContext` en `Configure` para ejecutar una migración o un paso de seed, ahora obtienes `Cannot resolve scoped service '...' from root provider`. Envuelve el trabajo de inicio en un scope explícito:

```csharp
// .NET 11 -- explicit scope for startup-time scoped resolution
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}
app.Run();
```

Esta es la ruptura en tiempo de ejecución más común en la migración. La regla general y sus variantes se cubren en [resolver servicios scoped desde un singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) y en [usar servicios scoped dentro de un BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

**`WebApplicationFactory<TStartup>` ya no tiene un `Startup` al que apuntar.** Las pruebas de integración que referenciaban `WebApplicationFactory<Startup>` necesitan un nuevo tipo de punto de entrada. El punto de entrada del host mínimo es la clase `Program` autogenerada, pero es `internal`, así que el proyecto de pruebas no puede verla. Exponla agregando una declaración parcial al final de `Program.cs`:

```csharp
// Program.cs -- end of file, .NET 11
public partial class Program { }
```

Luego cambia la fábrica de pruebas a `WebApplicationFactory<Program>`. Sin la declaración parcial obtienes `'Program' is inaccessible due to its protection level` en el proyecto de pruebas.

**`IStartupFilter` sigue ejecutándose, pero el orden cambia.** Los filtros registrados vía `services.AddTransient<IStartupFilter, MyFilter>()` continúan ejecutándose, envolviendo el pipeline configurado. Con el hospedaje mínimo no hay un método `Configure` explícito que envolver, así que un filtro que asumía que se ejecutaba antes de tu configuración de enrutamiento puede ahora ejecutarse en una posición ligeramente diferente. Si usabas `IStartupFilter` únicamente para inyectar middleware de una biblioteca, audita dónde aterriza ese middleware respecto a tus llamadas `app.Use...` y reordena si una solicitud se comporta de forma diferente.

**El middleware que lee el endpoint coincidente necesita `UseRouting` explícito.** Eliminar `UseRouting` está bien para el caso común, pero si tienes middleware que llama a `context.GetEndpoint()`, debe ubicarse después de que el enrutamiento se haya ejecutado. Vuelve a agregar `app.UseRouting()` antes de ese middleware y mantén `app.MapControllers()` después. Para una comparación más profunda de los dos estilos de endpoint, consulta [minimal APIs vs controladores en ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/).

**Registro de opciones nombradas dependiente del orden.** Un puñado de equipos dependían de que `ConfigureServices` se ejecutara antes del `IHostingStartup` de una biblioteca. El host mínimo evalúa `builder.Services` de forma anticipada en `builder.Build()`, así que si registraste un servicio después de llamar a una extensión de biblioteca que capturó la colección, el momento puede diferir. Esto es raro, pero si una opción configurada vuelve null después de la migración, comprueba si la registraste después de la llamada `Add...` que la consume.

Una vez que estás en `WebApplication.CreateBuilder`, el resto de la superficie moderna se abre: endpoints de minimal API junto a tus controladores, `CreateSlimBuilder` para Native AOT, y el manejo de excepciones más limpio mostrado en [agregar un manejador global de excepciones en ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/). La migración del hospedaje es la puerta; todo lo demás es incremental a partir de ahí.

## Fuentes

- [WebHostBuilder, IWebHost, and WebHost are obsolete](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/webhostbuilder-deprecated) (cambios disruptivos de .NET, diagnóstico `ASPDEPR008`)
- [Migrate from ASP.NET Core in .NET 5 to .NET 6](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60) (la guía original de migración al hospedaje mínimo)
- [Code samples migrated to the new minimal hosting model](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60-samples) (ejemplos de `Startup` antes/después)
- [Deprecating WebHostBuilder, IWebHost, and WebHost](https://github.com/dotnet/aspnetcore/discussions/63480) (discusión #63480 de dotnet/aspnetcore)
