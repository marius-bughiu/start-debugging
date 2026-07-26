---
title: "Cómo agregar Aspire a una solución ASP.NET Core existente sin reestructurarla"
description: "Agrega Aspire 13.4 a una solución ASP.NET Core heredada con dos proyectos nuevos y tres líneas por servicio: aspire init, cableado del AppHost con AddProject y WithReference, conservando tu launchSettings.json y tus cadenas de conexión, y los problemas de resiliencia, endpoints de salud y proxy que aparecen el primer día."
pubDate: 2026-07-26
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "opentelemetry"
  - "devops"
lang: "es"
translationOf: "2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it"
translatedBy: "claude"
translationDate: 2026-07-26
---

Agregas Aspire a una solución ASP.NET Core existente añadiendo dos proyectos nuevos junto a los que ya tienes, no moviendo nada. Un proyecto `AppHost` orquesta tus servicios en tiempo de desarrollo, una biblioteca de clases `ServiceDefaults` lleva el cableado compartido de telemetría y resiliencia, y cada servicio existente gana exactamente una referencia de proyecto más dos líneas en `Program.cs`. Tu estructura de carpetas, tus namespaces, tu `launchSettings.json`, tus cadenas de conexión, tus Dockerfiles y tu pipeline de CI se quedan tal como están. Este artículo recorre todo el proceso sobre Aspire 13.4.6 (la versión estable actual, publicada el 2026-06-20) contra .NET 10 y .NET 11 Preview 6.

Dos cosas cambiaron desde las guías que probablemente encontraste primero. Aspire dejó caer el ".NET" de su nombre con Aspire 13 en noviembre de 2025, y el paso `dotnet workload install aspire` desapareció ya en Aspire 9.0. Todo llega ahora por NuGet y un SDK de MSBuild, así que si todavía tienes el workload viejo en la máquina, `dotnet workload uninstall aspire` es lo primero que hay que ejecutar. Si quieres el recorrido conceptual antes de la mecánica, el [panorama de qué es Aspire](/es/2023/11/what-is-net-aspire/) sigue siendo válido.

## Qué aterriza realmente en tu repositorio

El inventario honesto, para una solución con una API y un worker:

```
MyApp.sln
  src/MyApp.Api/            <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.Worker/         <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.AppHost/        <- new
  src/MyApp.ServiceDefaults/<- new
  aspire.config.json        <- new, points the CLI at the AppHost
```

Ningún proyecto se mueve. Ningún cambio de namespace. Ningún cambio en cómo `dotnet publish` produce tus imágenes de contenedor, porque el AppHost es un orquestador de tiempo de desarrollo y no forma parte de lo que implementas. Ese último punto es el que la gente entiende mal: el AppHost no se ejecuta en producción. Lanza tus procesos localmente, les inyecta configuración y alimenta el dashboard.

## Pasos para agregar Aspire a una solución existente

1. Instala el CLI de Aspire como herramienta global y confirma que ve tu SDK.
2. Ejecuta `aspire init` desde la raíz de la solución para que detecte el `.sln` y genere un AppHost basado en proyecto.
3. Agrega una referencia de proyecto desde el AppHost a cada servicio que quieras que lance, y luego declara esos servicios con `AddProject` en el `Program.cs` del AppHost.
4. Referencia `ServiceDefaults` desde cada servicio y llama a `AddServiceDefaults()` y `MapDefaultEndpoints()`.
5. Modela tu infraestructura existente: contenedores para lo que te resulte cómodo ejecutar localmente, `AddConnectionString` para todo lo que deba permanecer externo.
6. Ejecuta `aspire run` y comprueba que cada servicio sigue arrancando con los endpoints que tenía antes.

El resto de este artículo son esos seis pasos con el código, y después las partes que se rompen.

## Instalar el CLI

Desde Aspire 13.3 el CLI se distribuye como herramienta global de .NET compilada con NativeAOT, lo que significa que no hay workload ni dependencia de Visual Studio:

```bash
dotnet tool install -g Aspire.Cli
aspire doctor
```

`aspire doctor` llegó en 13.4 y vale la pena ejecutarlo antes que nada. Imprime la versión del CLI, los SDK que puede ver y, sobre todo, si la versión de tu CLI y la de tu `Aspire.AppHost.Sdk` se han desincronizado. El desajuste de versiones entre ambos es la causa más común de "funcionaba en mi máquina" en un repositorio con Aspire.

## Generar el AppHost

Desde el directorio que contiene tu `.sln`:

```bash
aspire init
```

Cuando `aspire init` encuentra un archivo de solución crea un AppHost basado en proyecto y lo agrega a la solución. Cuando no lo encuentra (un repositorio poliglota, por ejemplo) crea un `apphost.cs` de un solo archivo usando directivas `#:sdk` y `#:package`. Para una solución ASP.NET Core existente quieres la forma basada en proyecto, porque es la que te da el namespace `Projects` generado y la depuración integrada con el IDE sobre todos los servicios a la vez.

Si prefieres no usar el CLI, las plantillas hacen el mismo trabajo:

```bash
dotnet new aspire-apphost -o src/MyApp.AppHost
dotnet new aspire-servicedefaults -o src/MyApp.ServiceDefaults
dotnet sln add src/MyApp.AppHost src/MyApp.ServiceDefaults
```

El archivo de proyecto del AppHost es pequeño y es el único lugar donde aparece el SDK de Aspire:

```xml
<!-- src/MyApp.AppHost/MyApp.AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <Sdk Name="Aspire.AppHost.Sdk" Version="13.4.6" />

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <IsAspireHost>true</IsAspireHost>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.AppHost" Version="13.4.6" />
  </ItemGroup>
</Project>
```

Fíjate en el `TargetFramework`. El AppHost puede apuntar a un TFM más nuevo que el de los servicios que lanza, porque los lanza como procesos separados. Una solución atascada en `net8.0` para sus servicios todavía puede tener un AppHost en `net10.0`.

## Conectar tus proyectos existentes

Agrega las referencias desde el AppHost a los servicios y luego decláralos:

```bash
dotnet add src/MyApp.AppHost reference src/MyApp.Api src/MyApp.Worker
```

```csharp
// src/MyApp.AppHost/Program.cs -- Aspire 13.4.6
var builder = DistributedApplication.CreateBuilder(args);

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithExternalHttpEndpoints();

builder.AddProject<Projects.MyApp_Worker>("worker")
    .WithReference(api)
    .WaitFor(api);

builder.Build().Run();
```

El tipo `Projects.MyApp_Api` lo genera el SDK de Aspire a partir de los elementos `ProjectReference`, con los puntos reemplazados por guiones bajos. Tú no lo escribes y no existe hasta la primera compilación.

Aquí está la parte que hace que esto no sea invasivo, y está poco documentada: Aspire lee tu `Properties/launchSettings.json` existente. Cuando lanza un recurso de proyecto elige un perfil por precedencia: el argumento `launchProfileName` si lo pasaste, luego un perfil cuyo nombre coincida con el propio `DOTNET_LAUNCH_PROFILE` del AppHost, luego el primer perfil del archivo, y finalmente ningún perfil. Analiza `applicationUrl` del perfil seleccionado y lo convierte en `ASPNETCORE_URLS`, y aplica sin modificar las `environmentVariables` de ese perfil. Tus perfiles existentes siguen funcionando. Si un servicio tiene un perfil "IIS Express" primero en el archivo y tú quieres el de Kestrel, nómbralo:

```csharp
builder.AddProject<Projects.MyApp_Api>("api", launchProfileName: "https");
```

Pasar `launchProfileName: null` lanza el proyecto sin perfil alguno, que es la opción más limpia para un worker que no tiene un `launchSettings.json` con sentido.

## Las dos líneas por servicio

`ServiceDefaults` es una biblioteca de clases normal marcada como `IsAspireSharedProject`. Referénciala desde cada servicio y llama a sus métodos:

```csharp
// src/MyApp.Api/Program.cs -- ASP.NET Core on .NET 10 / .NET 11 Preview 6
var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();   // <- added

builder.Services.AddControllers();
// ... everything you already had, untouched

var app = builder.Build();

app.MapDefaultEndpoints();      // <- added

app.MapControllers();
app.Run();
```

`AddServiceDefaults()` hace cuatro cosas: configura logging, métricas y trazas de OpenTelemetry (con las solicitudes a los health checks filtradas fuera de las trazas); registra un health check de liveness; registra el descubrimiento de servicios; y aplica `ConfigureHttpClientDefaults` para que cada `HttpClient` reciba el handler de resiliencia estándar y la resolución por descubrimiento de servicios. `MapDefaultEndpoints()` mapea `/health` (todos los checks deben pasar) y `/alive` (solo los checks etiquetados como `live`), y la plantilla protege ambos detrás de una comprobación de entorno de desarrollo.

Nada de esto es específico de Aspire en tiempo de ejecución. Un servicio que llama a `AddServiceDefaults()` funciona perfectamente fuera del AppHost, bajo `dotnet run`, en un contenedor, en tu implementación de Kubernetes existente. Simplemente exporta telemetría OTLP a donde sea que apunte `OTEL_EXPORTER_OTLP_ENDPOINT`, que es el dashboard cuando el AppHost lo lanzó y tu colector real cuando no. Si todavía no tienes un colector, el [recorrido por un backend de OpenTelemetry gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) cubre el otro extremo de esa tubería.

## Modelar la infraestructura que ya tienes

Aquí es donde un proyecto heredado se aparta más de los tutoriales desde cero, que siempre empiezan por meter todo en contenedores. Normalmente no puedes. El SQL Server de desarrollo compartido está compartido por una razón, y la cola tiene datos dentro.

Para las dependencias que te resulte cómodo ejecutar localmente, agrega la integración y deja que Aspire sea dueño del contenedor:

```bash
aspire add redis
```

```csharp
var cache = builder.AddRedis("cache");

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(cache)
    .WaitFor(cache);
```

`WithReference(cache)` inyecta `ConnectionStrings__cache` en el proceso de la API. Tu llamada existente a `builder.Configuration.GetConnectionString("cache")` lo lee sin modificaciones, porque las variables de entorno tienen mayor precedencia que `appsettings.json` en la configuración por defecto. Ese es todo el truco: Aspire no le pide a tu código que cambie cómo lee la configuración, solo suministra los valores con una precedencia mayor. La misma historia si estás cableando [HybridCache con Redis como L2](/es/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/): el recurso de caché alimenta la cadena de conexión y el resto de tu configuración no cambia.

Para las dependencias que deben permanecer externas, `AddConnectionString` crea un recurso respaldado por la configuración del propio AppHost en lugar de un contenedor:

```csharp
// Reads ConnectionStrings:orders from the AppHost's appsettings.json or user secrets
var orders = builder.AddConnectionString("orders");

builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(orders);
```

Pon el valor real en los user secrets del AppHost, no en `appsettings.json`:

```bash
dotnet user-secrets --project src/MyApp.AppHost set "ConnectionStrings:orders" "Server=dev-sql;Database=Orders;..."
```

El servicio ve `ConnectionStrings__orders` y nada más cambia. Si un servicio busca un nombre que el AppHost nunca declaró, obtendrás el conocido fallo de arranque que se cubre en [no existe ninguna cadena de conexión llamada DefaultConnection](/es/2026/05/fix-no-connection-string-named-defaultconnection/); el nombre del recurso en `AddConnectionString` tiene que coincidir exactamente con la clave que pide tu código.

Las llamadas entre servicios reciben el mismo tratamiento. `WithReference(api)` inyecta `services__api__https__0` y `services__api__http__0`, y el descubrimiento de servicios resuelve el nombre lógico:

```csharp
builder.Services.AddHttpClient<OrdersClient>(
    c => c.BaseAddress = new("https+http://api"));
```

`https+http://` significa preferir HTTPS con respaldo en HTTP. Solo se resuelve en un proyecto que registró el descubrimiento de servicios, cosa que `AddServiceDefaults()` hace por ti. Usa ese esquema en un proyecto que se saltó `AddServiceDefaults()` y obtendrás una `UriFormatException` en la primera solicitud, no al arrancar.

## Ejecutarlo

```bash
aspire run
```

El CLI encuentra el AppHost a través de `aspire.config.json`, arranca todos los recursos e imprime la URL del dashboard. En Visual Studio o Rider, pon el AppHost como proyecto de inicio y pulsa F5; ya no hacen falta las configuraciones de inicio con varios proyectos.

Una cosa que sorprende a quienes vienen de las guías de la época de 2023: no necesitas Docker en ejecución a menos que hayas declarado realmente un recurso de contenedor. Un AppHost que no es más que llamadas a `AddProject` arranca perfectamente sin ningún runtime de contenedores instalado. Eso hace que el primer commit sea seguro: puedes aterrizar el AppHost con cero recursos de contenedor, obtener el dashboard y el trazado distribuido, y contenerizar las dependencias después o nunca.

## Qué se rompe el primer día

**El handler de resiliencia estándar cambia el comportamiento de tu HTTP.** `AddServiceDefaults()` lo aplica a cada `HttpClient` del proceso, lo que significa reintentos, un circuit breaker y un tiempo límite total de solicitud. Si tienes un cliente que legítimamente tarda dos minutos, o ya tienes pipelines de Polly hechos a mano, ahora tienes dos capas. Quita las tuyas, o limita el alcance de los valores por defecto, pero no dejes ambas cosas en su sitio.

**Endpoints de salud duplicados.** Si ya mapeas `/health` por tu cuenta, `MapDefaultEndpoints()` te da un segundo registro en la misma ruta. Elige uno. El [recorrido por health checks en minimal API](/es/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) cubre qué conservar si quieres una salida más rica que la predeterminada.

**Doble registro de OpenTelemetry.** `ConfigureOpenTelemetry` en `ServiceDefaults` es aditivo sobre todo lo que ya hayas registrado. Si tu `Program.cs` tiene su propio `AddOpenTelemetry().WithTracing(...)`, tendrás instrumentación duplicada y, con Serilog de por medio, registros de log duplicados. Borra los tuyos y personaliza en su lugar la versión de `ServiceDefaults`, que es el propósito del proyecto compartido.

**Los endpoints pasan por proxy por defecto.** Aspire pone un proxy inverso delante de cada endpoint, así que el puerto al que llega tu navegador no es el puerto al que se enlazó Kestrel. Eso es invisible hasta que algo externo fija un puerto: una URI de redirección OIDC registrada con tu proveedor de identidad, un webhook de un sandbox de pagos, una URL hardcodeada en un cliente móvil. Desactívalo por endpoint:

```csharp
builder.AddProject<Projects.MyApp_Api>("api")
    .WithEndpoint("https", e => e.IsProxied = false);
```

**Tu CI ahora compila el AppHost.** `dotnet build MyApp.sln` recoge el proyecto nuevo, que necesita restaurar `Aspire.AppHost.Sdk` desde NuGet. En un feed restringido con una lista blanca explícita de paquetes eso falla, y el error es un error de resolución de SDK en vez de un error de paquete faltante, lo que lo hace más lento de diagnosticar de lo que debería. O bien pones el SDK y los paquetes de hosting en la lista blanca, o excluyes el AppHost de la compilación de CI con un filtro de solución. Nada en tu pipeline de implementación necesita cambiar más allá de eso, porque sigues publicando los mismos proyectos de servicio de la misma forma.

**Usuarios de Postgres en 13.4:** la imagen por defecto pasó de 17.6 a 18.3, y no se acoplará a un volumen de datos 17.x existente. Fija el tag con `WithImageTag` si tienes datos locales que te importen.

## Relacionados

- [¿Qué es .NET Aspire?](/es/2023/11/what-is-net-aspire/) para el modelo conceptual detrás del AppHost y las integraciones.
- [Cómo agregar un endpoint de health check a una minimal API en ASP.NET Core 11](/es/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) si `MapDefaultEndpoints` choca con lo que ya tienes.
- [Cómo usar OpenTelemetry con .NET 11 y un backend gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) para saber a dónde van las trazas cuando dejas atrás el dashboard.
- [Fix: No existe ninguna cadena de conexión llamada 'DefaultConnection'](/es/2026/05/fix-no-connection-string-named-defaultconnection/) para el modo de fallo por desajuste de nombre de recurso.
- [Modo aislado de Aspire 13.2 e instancias paralelas del AppHost](/es/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/) si dos desarrolladores, o dos ramas, necesitan ejecutar el mismo AppHost a la vez.

## Fuentes

- [Add Aspire to an existing app](https://aspire.dev/get-started/add-aspire-existing-app/), documentación de Aspire.
- [C# service defaults](https://aspire.dev/get-started/csharp-service-defaults/), documentación de Aspire.
- [C# launch profiles in the Aspire AppHost](https://aspire.dev/integrations/dotnet/launch-profiles/), documentación de Aspire.
- [External parameters and secrets in the AppHost](https://aspire.dev/fundamentals/external-parameters/), documentación de Aspire.
- [Service discovery](https://aspire.dev/fundamentals/service-discovery/), documentación de Aspire.
- [What's new in Aspire 13.3](https://aspire.dev/whats-new/aspire-13-3/) y [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/), documentación de Aspire.
- [Aspire releases](https://github.com/microsoft/aspire/releases) en GitHub, para la versión 13.4.6 y su fecha.
