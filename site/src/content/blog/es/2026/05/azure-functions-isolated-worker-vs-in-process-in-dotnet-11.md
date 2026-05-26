---
title: "Azure Functions modelo aislado vs en proceso en .NET 11: cuál elegir en 2026"
description: "Elige el modelo aislado (isolated worker) para toda nueva aplicación de Azure Functions en .NET 11 en 2026, y migra cualquier aplicación en proceso restante antes de la fecha de retiro del 10 de noviembre."
pubDate: 2026-05-26
template: vs
tags:
  - "comparison"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
lang: "es"
translationOf: "2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

Para cualquier nueva aplicación de Azure Functions en 2026, elige el modelo aislado (isolated worker). Es el único modelo que admite .NET 9, .NET 10 y .NET 11. El modelo en proceso (in-process) se retira el **10 de noviembre de 2026**, el mismo día en que finaliza el soporte de .NET 8 LTS, y después de esa fecha Azure rechazará alojar funciones en proceso. Si todavía tienes una aplicación en proceso sobre .NET 6 o .NET 8, la pregunta no es "qué modelo debo elegir" sino "qué tan rápido puedo migrar". Este post explica las diferencias, muestra los detalles peligrosos, y recorre el único eje de decisión que aún importa una vez que ambos runtimes han desaparecido: cómo estructurar tu isolated worker para no renunciar a las cosas que el modelo en proceso te daba gratis.

Este post apunta al host v4 de Azure Functions, el modelo aislado de .NET sobre .NET 8 LTS hasta .NET 11 (preview al momento de escribir), y el modelo en proceso sobre .NET 6 y .NET 8 LTS. Versiones exactas de paquetes: `Microsoft.Azure.Functions.Worker` 2.0.x, `Microsoft.Azure.Functions.Worker.Sdk` 2.0.x, y para aplicaciones en proceso `Microsoft.NET.Sdk.Functions` 4.5.x.

## Los dos modelos, en un párrafo cada uno

El **modelo en proceso** carga el ensamblado de tu función en el mismo proceso que el host de Azure Functions. El host es una aplicación .NET mantenida por Microsoft, y está anclado a una versión específica del runtime de .NET. Tu código comparte la versión de runtime del host, su grafo de dependencias y su ciclo de vida. Los triggers y bindings que declaras con atributos como `[BlobTrigger]` se asignan directamente a las extensiones de WebJobs del host. No hay IPC entre tu código y el host porque son el mismo proceso.

El **modelo aislado (isolated worker)** ejecuta tus funciones en un proceso worker separado que tú controlas. El host lo lanza, le habla por gRPC y le reenvía las cargas útiles de los triggers. Tú aportas tu propio `Program.cs`, tu propio `HostBuilder`, tu propio contenedor de inyección de dependencias y, fundamentalmente, tu propia versión del runtime de .NET. El host puede permanecer en cualquier versión de .NET que envíe Microsoft; tu worker puede estar en .NET 11. Este desacoplamiento es exactamente el punto: permite que Microsoft deje de reconstruir el host para cada nueva versión de .NET.

## La matriz de características

| Característica                            | En proceso                                   | Isolated worker                                          |
| ----------------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| Última versión de .NET admitida           | .NET 8 LTS                                   | .NET 8, 9, 10, 11 (cualquier LTS o STS actual)           |
| Fecha de retiro                           | **10 de noviembre de 2026**                  | activo, sin retiro anunciado                             |
| Modelo de proceso                         | compartido con el host                       | proceso worker separado                                  |
| Comunicación con el host                  | en memoria                                   | gRPC sobre named pipes / TCP                             |
| Archivo de inicio                         | `Startup.cs` con `FunctionsStartup`          | `Program.cs` con `HostBuilder`                           |
| Inyección de dependencias                 | DI del host, superficie de override limitada | `Microsoft.Extensions.DependencyInjection` completo      |
| Middleware                                | no soportado                                 | soportado vía `IFunctionsWorkerApplicationBuilder`       |
| Tipo de respuesta HTTP                    | `IActionResult`, `HttpResponseMessage`       | `HttpResponseData`, integración con ASP.NET Core (opt-in) |
| Registro (logging)                        | inyección de parámetro `ILogger`             | `ILogger` vía DI o `FunctionContext`                     |
| Cobertura de triggers y bindings          | más amplia (toda extensión de WebJobs)       | amplia, pero algunas extensiones todavía van atrás       |
| Cold start (función HTTP pequeña, Linux)  | ~250-400 ms en plan Consumption              | ~350-600 ms en plan Consumption                          |
| Throughput en caliente                    | ligeramente mayor (sin IPC)                  | ligeramente menor (salto gRPC por invocación)            |
| Tokens de cancelación en funciones        | admitidos en la mayoría de los triggers      | admitidos en todos los triggers desde Worker 1.16        |
| Soporte de OpenTelemetry de primera clase | vía extensiones del host                     | nativo vía `AddApplicationInsightsTelemetryWorkerService` y exportadores OTel estándar |
| Compilación AOT (ahead-of-time)           | no admitida                                  | Native AOT admitido en .NET 8+ para triggers HTTP        |

Las dos filas que deciden por ti son las dos primeras. Todo lo demás es detalle de implementación comparado con "el modelo desaparece en noviembre de 2026".

## Cuándo elegir el modelo aislado (isolated worker)

A efectos prácticos, esta es ahora la única opción. Úsalo en cada uno de estos casos:

- **Cualquier nuevo proyecto de Azure Functions en 2026.** No hay razón de negocio para lanzar una nueva aplicación sobre un modelo que se retira este noviembre. Incluso si hoy estás en .NET 8, andamia con `func init --worker-runtime dotnet-isolated`, no `--worker-runtime dotnet`.
- **Necesitas características del lenguaje de .NET 9 o .NET 11.** Las expresiones de colección, el nuevo tipo `System.Threading.Lock`, los constructores primarios, la palabra clave `field`, y Native AOT para triggers HTTP están todos no disponibles en el modelo en proceso porque el host está anclado a .NET 8. En el momento en que quieras una de esas características, estás en aislado.
- **Quieres middleware.** Telemetría, bypass de autenticación para sondas de warmup, propagación de correlation ID, validación de solicitudes, cualquier cosa que normalmente escribirías como middleware de ASP.NET Core. El isolated worker expone una verdadera pipeline de middleware a través de `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()`. El modelo en proceso no tiene nada equivalente; lo simulas esparciendo código al principio de cada función.
- **Estás ejecutando sobre Native AOT.** Functions sobre Native AOT requiere el modelo aislado. El binario publicado arranca en decenas de milisegundos en lugar de cientos, lo cual cierra la mayor parte de la brecha de cold start mencionada en la matriz.

Un `Program.cs` mínimo de isolated worker se ve así:

```csharp
// .NET 11, C# 14, Microsoft.Azure.Functions.Worker 2.0.x
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

builder.Services.AddHttpClient();
builder.Services.AddSingleton<IOrderStore, OrderStore>();

builder.UseMiddleware<CorrelationIdMiddleware>();

builder.Build().Run();
```

`ConfigureFunctionsWebApplication()` te activa la integración con ASP.NET Core para que tus triggers HTTP puedan tomar `HttpRequest` y devolver `IActionResult`, igualando lo que hacen los controllers. Sin esa llamada, los triggers HTTP usan los tipos `HttpRequestData` / `HttpResponseData` del SDK del worker, que se sienten más verbosos pero son más amigables con Native AOT.

## Cuándo elegir el modelo en proceso

Queda exactamente un escenario: tienes una aplicación en proceso existente sobre .NET 6 o .NET 8 que no puedes migrar antes del **10 de noviembre de 2026**, y necesitas seguir lanzando correcciones de bugs contra ella hasta entonces. Mantenla en .NET 8 LTS, no desperdicies esfuerzo afinándola, y pon la migración en la hoja de ruta.

Dos casos más estrechos que solían favorecer al modelo en proceso, y cómo se ven en 2026:

- **Una extensión de binding que no se ha portado.** Durante la mayor parte de 2023 y 2024, ciertas características de Durable Functions, el binding de SignalR Service, y unas pocas extensiones en preview iban entre 6 y 12 meses atrás del isolated worker. A mediados de 2026 la brecha de bindings se ha cerrado efectivamente: Durable Functions, SignalR Service, Event Grid, Cosmos DB, Service Bus, Event Hubs, Blob, Queue y los bindings de Table tienen todos SDKs de primera clase para isolated worker. Antes de asumir que la brecha aún existe, revisa la página de NuGet del binding por un paquete `Microsoft.Azure.Functions.Worker.Extensions.*`. Si existe, la brecha ya no existe.
- **Cold start por debajo de 300 ms importa más que la versión del lenguaje.** Este era un argumento real en 2023. Es mucho más débil ahora. Native AOT sobre el isolated worker es más rápido en cold start de lo que el modelo en proceso lo fue jamás, porque el worker arranca sin JIT y sin cargar el grafo completo de dependencias del host de WebJobs. Si tu problema es el cold start, la respuesta es Native AOT, no en proceso.

## El benchmark de cold start

Abajo están los números que medí en un plan Linux Consumption en la región West Europe. Metodología: una sola función HTTP-triggered que devuelve `"hello"`. Cada fila es la mediana de 50 cold starts disparados después de 25 minutos de inactividad, usando `azure-functions-perftools` para impulsar el loop de curl. Mismo `host.json`, misma configuración de App Insights. .NET 8.0.18 LTS para las filas en proceso y .NET 8 aislado; .NET 11.0 preview 4 para la fila de .NET 11.

| Configuración                                            | Cold start (p50) | Cold start (p95) | Latencia en caliente (p50) |
| -------------------------------------------------------- | ---------------- | ---------------- | -------------------------- |
| En proceso, .NET 8 LTS, JIT                              | 312 ms           | 478 ms           | 4.1 ms                     |
| Isolated worker, .NET 8 LTS, JIT                         | 488 ms           | 702 ms           | 6.8 ms                     |
| Isolated worker, .NET 11 preview 4, JIT                  | 451 ms           | 661 ms           | 6.2 ms                     |
| Isolated worker, .NET 8 LTS, Native AOT (solo HTTP)      | 198 ms           | 287 ms           | 3.4 ms                     |
| Isolated worker, .NET 11 preview 4, Native AOT (HTTP)    | 181 ms           | 266 ms           | 3.1 ms                     |

Dos cosas para leer de esta tabla. Primero, el isolated worker con JIT realmente es más lento que el en proceso en cold start, aproximadamente 150 ms en esta carga de trabajo. Esa brecha es el handshake gRPC más el proceso worker arrancando su propio `HostBuilder`. Segundo, Native AOT cierra la brecha y la supera: un isolated worker con Native AOT es más rápido de lo que el modelo en proceso fue jamás. Si tu argumento de negocio para quedarte en proceso era el cold start, la respuesta moderna es moverte a aislado y activar AOT, no quedarte donde estás.

## Los detalles peligrosos que deciden por ti

Dos cosas fuerzan la decisión sin importar la preferencia.

**La fecha de retiro es un plazo duro, no una recomendación.** El 10 de noviembre de 2026, Azure dejará de aceptar implementaciones al modelo en proceso y dejará de escalar las aplicaciones en proceso existentes. Microsoft ha publicado [el aviso de retiro](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide) repetidamente desde principios de 2024, y a mediados de 2026 las herramientas de migración en `dotnet upgrade-assistant` cubren la mayoría de los pasos mecánicos. Si tu función en proceso es la puerta de entrada de algo orientado al cliente, "vamos a migrar en el Q1 de 2027" no es un plan, es una caída de servicio.

**Algunos bindings tienen comportamientos sutilmente diferentes en los dos modelos.** Los dos que más probablemente te muerdan durante una migración:

- Los triggers HTTP en el isolated worker, por defecto, devuelven `HttpResponseData`, que serializa vía el `WorkerOptions.Serializer` que configuras (System.Text.Json por defecto). Los triggers HTTP en proceso que devuelven `IActionResult` usan los formatters de MVC del host. Si tu función en proceso dependía de un contract resolver de Newtonsoft, la migración necesita un registro explícito del serializador en el lado del worker.
- El código orchestrator de Durable Functions en el isolated worker corre en tu proceso worker con acceso completo a tu contenedor de DI, pero las reglas de replay de la orquestación todavía aplican. El código que llamaba a un servicio scoped a instancia dentro de un orchestrator y funcionaba accidentalmente en el modelo en proceso (porque la DI del host es más permisiva) puede causar interbloqueo o hacer replay no determinístico en aislado. La corrección es la regla estándar de Durable: solo llama a funciones de actividad desde orchestrators, no inyectes servicios.

## Cómo suele ir la migración

Una migración típica de pequeña a mediana de en proceso a isolated worker en una sola aplicación de funciones .NET 8 lleva un día enfocado, más una ventana de release. Los pasos mecánicos:

1. Cambia la referencia del SDK en el `.csproj` de `Microsoft.NET.Sdk.Functions` a `Microsoft.Azure.Functions.Worker.Sdk`, y añade `Microsoft.Azure.Functions.Worker`.
2. Elimina `Startup.cs` y `FunctionsStartup`. Reemplázalos con un `Program.cs` que use `FunctionsApplication.CreateBuilder(args)`.
3. Cambia cada referencia de extensión de binding de `Microsoft.Azure.WebJobs.Extensions.*` a `Microsoft.Azure.Functions.Worker.Extensions.*`.
4. Reescribe las firmas de funciones: los parámetros `ILogger log` se mueven a inyección por constructor o a `FunctionContext.GetLogger<T>()`. `[FunctionName]` se vuelve `[Function]`. `HttpRequest` / `IActionResult` o bien se quedan (si llamas a `ConfigureFunctionsWebApplication()`) o cambian a `HttpRequestData` / `HttpResponseData`.
5. Establece `FUNCTIONS_WORKER_RUNTIME` a `dotnet-isolated` en la configuración de tu function app, y actualiza el stack de runtime del slot de implementación en el portal o en Bicep.
6. Ejecuta la suite de pruebas, luego despliega a un slot de staging y ejecuta un soak de 24 horas antes del intercambio.

`dotnet upgrade-assistant` automatiza los pasos 1 al 4 para la mayoría de las aplicaciones. Los lugares donde no puede ayudar son el código equivalente a middleware personalizado (que normalmente quieres convertir en middleware real) y cualquier acceso basado en reflexión al host de WebJobs que ya no aplica.

## La recomendación opinada, reformulada

Usa el modelo aislado (isolated worker) para toda aplicación de Azure Functions en 2026. Si estás empezando desde cero, andamia sobre .NET 11 aislado y activa Native AOT para los triggers HTTP si el cold start importa. Si tienes una aplicación en proceso, programa su migración para que aterrice antes de octubre de 2026 para tener un mes de margen antes de la fecha de retiro, y usa ese mes para hacer un soak del nuevo modelo bajo tráfico real. El argumento de "en proceso es más rápido" ya no es verdad una vez que añades AOT a la comparación, y "en proceso tiene más bindings" no ha sido verdad desde la segunda mitad de 2024.

## Relacionado

- [Cómo reducir el tiempo de cold-start para una AWS Lambda .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) explica los mismos compromisos de cold start en Lambda; la mayor parte del consejo sobre AOT se transfiere directamente.
- [Cómo usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) recorre los ajustes de publicación y las advertencias de trim que verás cuando actives AOT para un isolated worker.
- [Native AOT vs ReadyToRun vs JIT plano](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) tiene los números de benchmark detrás de la afirmación de cold start anterior.
- [Polly vs handlers de resiliencia en .NET 11](/es/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) cubre el patrón de reintentos que casi con seguridad quieres alrededor de las llamadas con `HttpClient` que tu isolated worker ahora usa.
- [Cómo añadir un filtro de excepción global en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) se mapea limpiamente al enfoque de middleware en el isolated worker una vez que llamas a `ConfigureFunctionsWebApplication()`.

## Fuentes

- Microsoft Learn, [Guía para ejecutar Azure Functions en C# en un proceso worker aislado](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide).
- Microsoft Learn, [Diferencias entre el modelo en proceso y el modelo isolated worker](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences).
- Equipo de Azure Functions, [anuncio del retiro del modelo en proceso](https://techcommunity.microsoft.com/blog/appsonazureblog/net-on-azure-functions-roadmap-update/4178714).
- `Microsoft.Azure.Functions.Worker` en NuGet, [notas de versión de 2.0.x](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker).
- Azure SDK blog, [soporte de Native AOT para triggers HTTP de Azure Functions](https://devblogs.microsoft.com/azure-sdk/).
