---
title: "Cómo configurar registro estructurado con Serilog y Seq en .NET 11"
description: "Una guía completa para conectar Serilog 4.x y Seq 2025.2 en una aplicación ASP.NET Core de .NET 11: AddSerilog vs UseSerilog, registro de arranque en dos etapas, configuración JSON, enrichers, registro de solicitudes, correlación de trazas con OpenTelemetry, claves de API y los problemas de producción relacionados con buffering, retención y nivel de señal."
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "logging"
  - "serilog"
  - "seq"
lang: "es"
translationOf: "2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-01
---

Para enviar registros estructurados desde una aplicación ASP.NET Core de .NET 11 a Seq, instala `Serilog.AspNetCore` 10.0.0 y `Serilog.Sinks.Seq` 9.0.0, registra el pipeline con `services.AddSerilog((sp, lc) => lc.ReadFrom.Configuration(...).WriteTo.Seq("http://localhost:5341"))`, y activa el registrador de solicitudes del host con `app.UseSerilogRequestLogging()`. Configura todo desde `appsettings.json` para que producción pueda cambiar el nivel mínimo sin un nuevo despliegue. Ejecuta Seq localmente como la imagen Docker `datalust/seq` con `ACCEPT_EULA=Y` y un mapeo de puertos, y apunta el sink a `http://localhost:5341`. Esta guía está escrita para .NET 11 preview 3 y C# 14, pero cada fragmento funciona también en .NET 8, 9 y 10.

## Por qué Serilog más Seq en lugar de "solo `ILogger`"

`Microsoft.Extensions.Logging` está bien para demos de hello-world y pruebas unitarias. No es suficiente para producción. `ILogger<T>.LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` es estructurado en el sitio de la llamada, pero el proveedor de consola predeterminado aplana esas propiedades en una sola cadena y descarta la estructura. En el momento que algo falla en producción, vuelves a hacer grep sobre un tarball.

Serilog mantiene la estructura. Cada llamada serializa los marcadores de posición con nombre como propiedades JSON y los reenvía a cualquier sink que configures. Seq es el extremo receptor: un servidor de registro autoalojado que indexa esas propiedades para que puedas escribir `select count(*) from stream where StatusCode >= 500 and Endpoint = '/api/orders' group by time(1m)` y obtener una respuesta en milisegundos. La combinación ha sido una opción predeterminada en el espacio de .NET durante una década porque ambas piezas están escritas por personas que realmente las usan.

Los números de versión que vale la pena recordar para 2026 son Serilog 4.3.1, Serilog.AspNetCore 10.0.0, Serilog.Sinks.Seq 9.0.0 y Seq 2025.2. Los números mayores siguen a Microsoft.Extensions.Logging, así que en .NET 11 te quedas en la línea 10.x de `Serilog.AspNetCore` y en la línea 9.x de `Serilog.Sinks.Seq` hasta que Microsoft saque una nueva versión mayor.

## Ejecuta Seq localmente en 30 segundos

Antes de cualquier código, pon en marcha una instancia de Seq. La línea de Docker es lo que la mayoría de equipos usan, incluido en CI:

```bash
# Seq 2025.2, default ports
docker run \
  --name seq \
  -d \
  --restart unless-stopped \
  -e ACCEPT_EULA=Y \
  -p 5341:80 \
  -p 5342:443 \
  -v seq-data:/data \
  datalust/seq:2025.2
```

`5341` es el puerto de ingesta HTTP y de la interfaz, `5342` es HTTPS. El volumen con nombre `seq-data` conserva tus eventos a través de los reinicios del contenedor. En Windows la alternativa es el instalador MSI de datalust.co; trae el mismo motor y los mismos puertos predeterminados. El nivel gratuito es ilimitado para un solo usuario; las licencias de equipo entran en juego cuando agregas cuentas autenticadas. Abre `http://localhost:5341` en un navegador, haz clic en "Settings", "API Keys" y crea una clave. La usarás tanto para la autenticación de ingesta como para cualquier panel de solo lectura que conectes más tarde.

## Instala los paquetes

Tres paquetes son suficientes para el camino feliz:

```bash
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Sinks.Seq --version 9.0.0
dotnet add package Serilog.Settings.Configuration --version 9.0.0
```

`Serilog.AspNetCore` arrastra `Serilog`, `Serilog.Extensions.Hosting` y el sink de consola. `Serilog.Sinks.Seq` es el sink HTTP que envía eventos por lotes al endpoint de ingesta de Seq. `Serilog.Settings.Configuration` es el puente que te permite describir todo el pipeline en `appsettings.json`, que es como realmente quieres ejecutar esto en producción.

## El Program.cs mínimo

Aquí está el cableado viable más pequeño para una API mínima de .NET 11. Usa la API `AddSerilog` que se convirtió en el único punto de entrada compatible después de que Serilog.AspNetCore 8.0.0 eliminara la extensión obsoleta `IWebHostBuilder.UseSerilog()`.

```csharp
// .NET 11 preview 3, C# 14
// Serilog 4.3.1, Serilog.AspNetCore 10.0.0, Serilog.Sinks.Seq 9.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.Seq("http://localhost:5341"));

var app = builder.Build();

app.UseSerilogRequestLogging();

app.MapGet("/api/orders/{id:int}", (int id, ILogger<Program> log) =>
{
    log.LogInformation("Fetching order {OrderId}", id);
    return Results.Ok(new { id, total = 99.95m });
});

app.Run();
```

Cinco líneas hacen el trabajo real. `ReadFrom.Configuration` carga los niveles mínimos y las sobreescrituras desde `appsettings.json`. `ReadFrom.Services` permite que los sinks resuelvan dependencias con scope, lo cual importa una vez que empiezas a escribir enrichers personalizados. `Enrich.FromLogContext` es lo que te permite empujar un bloque `using (LogContext.PushProperty("CorrelationId", id))` en middleware y que cada línea de registro dentro de ese alcance quede etiquetada automáticamente. `WriteTo.Console` mantiene rápida la experiencia de desarrollo local. `WriteTo.Seq` es el sink real.

`UseSerilogRequestLogging` reemplaza el middleware predeterminado de registro de solicitudes de ASP.NET Core con un único evento estructurado por solicitud. En lugar de tres o cuatro líneas por solicitud, obtienes una línea con `RequestPath`, `StatusCode`, `Elapsed` y cualquier propiedad que empujes mediante el callback `EnrichDiagnosticContext`. Menos ruido, más señal.

## Mueve la configuración a appsettings.json

Codificar `http://localhost:5341` está bien para una demo y mal para producción. Mueve toda la descripción del pipeline a `appsettings.json` para poder cambiar la verbosidad sin redespliegue:

```json
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Sinks.Seq" ],
    "MinimumLevel": {
      "Default": "Information",
      "Override": {
        "Microsoft.AspNetCore": "Warning",
        "Microsoft.EntityFrameworkCore.Database.Command": "Warning",
        "System.Net.Http.HttpClient": "Warning"
      }
    },
    "Enrich": [ "FromLogContext", "WithMachineName", "WithThreadId" ],
    "WriteTo": [
      { "Name": "Console" },
      {
        "Name": "Seq",
        "Args": {
          "serverUrl": "http://localhost:5341",
          "apiKey": "REPLACE_WITH_API_KEY"
        }
      }
    ],
    "Properties": {
      "Application": "Orders.Api"
    }
  }
}
```

Algunos detalles importan. El arreglo `Using` es lo que `Serilog.Settings.Configuration` 9.x usa para cargar los ensamblados de los sinks; sin él, el parser de JSON no sabe qué ensamblado contiene `WriteTo.Seq`. El mapa `Override` es la característica más subestimada de Serilog: te permite mantener el nivel global en `Information` mientras fijas el registrador de comandos de EF Core en `Warning` para que no te ahogues en SQL en un servidor con carga. Agrega `WithMachineName` y `WithThreadId` solo si instalas `Serilog.Enrichers.Environment` y `Serilog.Enrichers.Thread`; quítalos en caso contrario o la configuración fallará al inicio con un silencioso error de "method not found".

La propiedad `Application` es la clave para usar una sola instancia de Seq para muchos servicios. Empuja el nombre de cada aplicación a través de `Properties` y obtienes un filtro gratis en la interfaz de Seq: `Application = 'Orders.Api'`.

## Registro de arranque: captura el fallo antes de que arranque el registro

El registro impulsado por configuración tiene una debilidad. Si `appsettings.json` está mal formado, el host explota antes de que los sinks configurados estén vivos, y no obtienes nada. El patrón oficial, y lo que `Serilog.AspNetCore` documenta, es el arranque en dos etapas: instala un registrador mínimo antes de construir el host, luego reemplázalo una vez que la configuración haya cargado.

```csharp
// .NET 11 preview 3, C# 14
using Serilog;

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .WriteTo.Console()
    .WriteTo.Seq("http://localhost:5341")
    .CreateBootstrapLogger();

try
{
    var builder = WebApplication.CreateBuilder(args);

    builder.Services.AddSerilog((services, lc) => lc
        .ReadFrom.Configuration(builder.Configuration)
        .ReadFrom.Services(services)
        .Enrich.FromLogContext()
        .WriteTo.Console()
        .WriteTo.Seq("http://localhost:5341"));

    var app = builder.Build();

    app.UseSerilogRequestLogging();
    app.MapGet("/", () => "ok");

    app.Run();
}
catch (Exception ex) when (ex is not HostAbortedException)
{
    Log.Fatal(ex, "Host terminated unexpectedly");
    throw;
}
finally
{
    Log.CloseAndFlush();
}
```

`CreateBootstrapLogger` devuelve un registrador que es a la vez utilizable ahora y reemplazable más tarde, así que el mismo estático `Log.Logger` sigue funcionando después de que `AddSerilog` intercambia la implementación. `Log.CloseAndFlush()` en el bloque `finally` es lo que asegura que el lote en memoria de `Serilog.Sinks.Seq` realmente se vacíe antes de que el proceso termine. Sáltatelo y perderás los últimos segundos de registros en un apagado limpio, que es exactamente la ventana donde viven los eventos interesantes.

## Registro de solicitudes que sea realmente útil

`UseSerilogRequestLogging` escribe un evento por solicitud en `Information` para 2xx y 3xx, `Warning` para 4xx y `Error` para 5xx. Los valores predeterminados son razonables. Para hacerlo apto para producción, sobreescribe la plantilla del mensaje y enriquece cada evento con la identidad del usuario y el id de traza:

```csharp
// .NET 11 preview 3, C# 14
app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate =
        "HTTP {RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0} ms";

    options.EnrichDiagnosticContext = (diagnosticContext, httpContext) =>
    {
        diagnosticContext.Set("UserId", httpContext.User?.FindFirst("sub")?.Value);
        diagnosticContext.Set("ClientIp", httpContext.Connection.RemoteIpAddress?.ToString());
        diagnosticContext.Set("TraceId", System.Diagnostics.Activity.Current?.TraceId.ToString());
    };
});
```

La línea de `TraceId` es el enricher más valioso que puedes agregar. Combinado con la recolección de id de traza que llegó en Serilog 3.1, cada evento de registro que tu código escriba dentro de una solicitud llevará el mismo `TraceId` que la solicitud misma. En Seq puedes hacer clic en cualquier evento y pivotar a "show all events with this TraceId" para obtener la cadena de llamadas completa en una sola consulta.

## Conecta la correlación de trazas con OpenTelemetry

Si también exportas trazas vía OpenTelemetry, no agregues un exportador de registro separado. Serilog ya entiende `Activity.Current` y escribe `TraceId` y `SpanId` automáticamente cuando están presentes. El rastreo nativo de OpenTelemetry en ASP.NET Core 11 significa que las trazas comienzan en la solicitud entrante y se propagan a través de `HttpClient`, EF Core y cualquier otra biblioteca instrumentada. Serilog recoge el mismo contexto de `Activity`, así que cada evento de registro termina correlacionado con la traza sin ningún cableado extra del lado del registro. Lee [el pipeline de rastreo nativo de OpenTelemetry en .NET 11](/es/2026/04/aspnetcore-11-native-opentelemetry-tracing/) para la configuración del lado de las trazas.

Para enviar esas trazas a Seq en lugar de a un backend separado, instala `Serilog.Sinks.Seq` más el soporte OTLP que viene con Seq 2025.2 y apunta el exportador de OpenTelemetry a `http://localhost:5341/ingest/otlp/v1/traces`. Seq mostrará trazas y registros en la misma interfaz, unidos por `TraceId`.

## Niveles, muestreo y "nos están alertando por nada"

El nivel predeterminado `Information` en una API ocupada producirá cientos de eventos por segundo. Dos perillas controlan el volumen.

La primera es el mapa `MinimumLevel.Override` mostrado arriba. Empuja los registros ruidosos del framework a `Warning` y cortarás la manguera por un orden de magnitud sin perder los registros de tu propia aplicación. Sobreescribe siempre `Microsoft.AspNetCore` a `Warning` una vez que actives `UseSerilogRequestLogging`, de lo contrario obtienes la línea por solicitud dos veces: una del framework, otra de Serilog.

La segunda es el muestreo. Serilog no tiene un muestreador integrado, pero puedes envolver el sink de Seq en un predicado `Filter.ByExcluding` para descartar eventos de bajo valor antes de que salgan del proceso:

```csharp
// .NET 11, C# 14: drop /health probe noise
.Filter.ByExcluding(le =>
    le.Properties.TryGetValue("RequestPath", out var p) &&
    p is ScalarValue { Value: string path } &&
    path.StartsWith("/health", StringComparison.OrdinalIgnoreCase))
```

Para tráfico de alto volumen, una mejor respuesta es mantener `Information` para el registro de solicitudes y subir todo lo demás a `Warning`, luego usar la característica "signal" de Seq para marcar la pequeña porción sobre la que realmente quieres alertar.

## Problemas de producción

Un puñado de problemas atrapan a cada equipo que envía Serilog más Seq por primera vez.

**El batching del sink oculta caídas.** `Serilog.Sinks.Seq` almacena en buffer eventos durante hasta 2 segundos o 1000 eventos antes de vaciar. Si Seq no es alcanzable, el sink reintenta con backoff exponencial, pero el buffer está acotado. En una caída sostenida de Seq descartarás eventos silenciosamente. Los despliegues de producción deben configurar `bufferBaseFilename` para que el sink se desborde primero a disco y reproduzca cuando Seq vuelva:

```json
{
  "Name": "Seq",
  "Args": {
    "serverUrl": "https://seq.internal",
    "apiKey": "...",
    "bufferBaseFilename": "/var/log/myapp/seq-buffer"
  }
}
```

**Las llamadas síncronas al sink de Seq no son gratis.** Aunque el sink es asíncrono, la llamada a `LogInformation` hace trabajo en el hilo que llama para renderizar la plantilla del mensaje y empujar al canal. En una ruta caliente esto aparece en los perfiles. Usa `Async` ([`Serilog.Sinks.Async`](https://github.com/serilog/serilog-sinks-async)) para envolver el sink de Seq en un hilo de fondo dedicado y que el hilo de la solicitud regrese al instante.

**Las claves de API en `appsettings.json` son una fuga esperando a ocurrir.** Muévelas a user secrets en desarrollo y a tu almacén de secretos (Key Vault, AWS Secrets Manager) en producción. Serilog lee cualquier proveedor de configuración que el host registre, así que lo único que cambias es de dónde viene el valor.

**La retención de Seq no es infinita.** El volumen Docker `seq-data` predeterminado crece hasta que el disco se llena y Seq comienza a descartar la ingesta. Configura políticas de retención en la interfaz de Seq bajo "Settings", "Data". Un buen punto de partida son 30 días para `Information`, 90 días para `Warning` y superior.

**`UseSerilogRequestLogging` debe ir antes de `UseEndpoints` y después de `UseRouting`.** Si lo colocas antes, no verá el endpoint coincidente, y `RequestPath` contendrá la URL cruda en lugar de la plantilla de ruta, lo que hace que los paneles de Seq sean mucho menos útiles.

## Dónde encaja esto en tu stack

Serilog más Seq es la pata de registro de un stack de observabilidad de tres patas: registros (Serilog/Seq), trazas (OpenTelemetry) y excepciones ([manejadores globales de excepciones](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)). Cuando algo va mal en una API de producción, empiezas en Seq, encuentras la solicitud que falla, copias el `TraceId` y pivotas a la vista de la traza o al código fuente que lanzó. Ese viaje de ida y vuelta es el punto entero. Si no puedes hacerlo en menos de un minuto, tu registro no se está ganando su sueldo.

Si estás rastreando una lentitud específica en lugar de un error de runtime, sigue con [un bucle de profiling con `dotnet-trace`](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) en su lugar. Seq es excelente para "qué pasó", `dotnet-trace` es la herramienta correcta para "por qué esto está lento". Y si la respuesta termina siendo "serializamos demasiado por solicitud", la [guía de JsonConverter personalizado](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) cubre el lado de System.Text.Json.

Enlaces de la fuente:

- [Serilog.AspNetCore release notes](https://github.com/serilog/serilog-aspnetcore/releases)
- [Serilog.Sinks.Seq on NuGet](https://www.nuget.org/packages/Serilog.Sinks.Seq/)
- [Seq documentation](https://docs.datalust.co/docs)
- [Datalust seq-extensions-logging](https://github.com/datalust/seq-extensions-logging)
