---
title: "Migrar de Azure Functions in-process al modelo de worker aislado (.NET 8 / .NET 11)"
description: "Una lista paso a paso para mover una app de Azure Functions in-process de .NET al modelo de worker aislado antes del retiro del 10 de noviembre de 2026, con diffs de csproj, reescrituras de firmas y un despliegue con intercambio de slots."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
lang: "es"
translationOf: "2026/06/migrate-from-in-process-azure-functions-to-isolated-worker"
translatedBy: "claude"
translationDate: 2026-06-05
---

Una app de Azure Functions in-process típica sobre .NET 8 se mueve al modelo de worker aislado en aproximadamente un día de cambios de código enfocados, más una ventana de release escalonado. Lo que se rompe es mecánico y predecible: la referencia de SDK en tu `.csproj`, tu `Startup.cs`, cada atributo `[FunctionName]`, cada paquete `Microsoft.Azure.WebJobs.Extensions.*` y cualquier función que tomaba un parámetro `ILogger`. Nada de esto es difícil, pero todo es obligatorio, porque el modelo in-process se retira el **10 de noviembre de 2026**, y a partir de esa fecha Azure deja de dar a las apps in-process actualizaciones de seguridad y de funcionalidades. Esta guía es la lista completa: qué cambiar, el diff exacto de cada cambio, cómo verificar cada paso y cómo desplegar el cambio de runtime a través de un slot de staging para que producción nunca vea el estado intermedio roto.

Esto apunta al host v4 de Azure Functions, migrando una app `dotnet` (in-process) sobre .NET 6 o .NET 8 LTS al modelo de worker aislado `dotnet-isolated` sobre .NET 8 LTS (la ruta rápida recomendada) o .NET 11. Las versiones de paquetes referenciadas son las últimas estables a junio de 2026: `Microsoft.Azure.Functions.Worker` 2.0.x, `Microsoft.Azure.Functions.Worker.Sdk` 2.0.x y la familia `Microsoft.Azure.Functions.Worker.Extensions.*`. Si tu app aún está en el host v1, v2 o v3, haz primero la [actualización de host de la versión 3.x a 4.x](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-version-3-version-4); esa guía integra el movimiento al worker aislado en el mismo paso.

Si todavía estás decidiendo si migrar siquiera, lee primero [worker aislado vs in-process en .NET 11](/es/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/). Este post asume que ya decidiste y quieres la receta mecánica.

## Por qué esta migración no es opcional

- **El modelo in-process se retira el 10 de noviembre de 2026.** Es el mismo día en que .NET 8 LTS sale de soporte. A partir de esa fecha, las apps in-process siguen funcionando pero no reciben parches de seguridad ni actualizaciones de funcionalidades de Microsoft, y no puedes desplegar una nueva app in-process. Microsoft ha publicado [el aviso de retiro](https://aka.ms/azure-functions-retirements/in-process-model) desde principios de 2024.
- **El worker aislado desbloquea .NET 9, 10 y 11.** El host in-process está fijado a .NET 8 y nunca avanza más. En el momento en que quieres constructores primarios, la palabra clave `field`, el tipo `System.Threading.Lock`, expresiones de colección o Native AOT, necesitas el worker aislado, donde tú traes tu propio runtime.
- **Obtienes un pipeline de middleware real y DI completa.** El worker aislado expone `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()` y el contenedor estándar `Microsoft.Extensions.DependencyInjection` sin límites en la superficie de override. Los IDs de correlación, los atajos de autenticación para sondas de warmup y la validación de solicitudes se convierten en middleware en lugar de código copiado y pegado al inicio de cada función.
- **El cold start puede terminar más bajo, no más alto.** El worker aislado con JIT plano es aproximadamente 150 ms más lento en cold start que in-process, pero Native AOT en el worker aislado arranca más rápido de lo que in-process arrancó jamás. Si el cold start es la razón por la que te quedaste en in-process, la respuesta moderna es aislado más AOT.

## Qué se rompe

| Área                       | Cambio                                                                                                  | Severidad |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| Referencia de SDK          | `Microsoft.NET.Sdk.Functions` eliminado; reemplazar con `Microsoft.Azure.Functions.Worker` + `.Worker.Sdk` | alta     |
| Tipo de salida             | el `.csproj` necesita `<OutputType>Exe</OutputType>`; el worker ahora es un proceso de consola real      | alta     |
| Startup                    | `FunctionsStartup` / `Startup.cs` reemplazado por `Program.cs` con un `HostBuilder`                      | alta     |
| Atributo de función        | `[FunctionName("X")]` se convierte en `[Function("X")]`                                                  | alta     |
| Paquetes de binding        | cada `Microsoft.Azure.WebJobs.Extensions.*` cambia a `Microsoft.Azure.Functions.Worker.Extensions.*`    | alta     |
| Parámetro `ILogger`        | el `ILogger log` inyectado por método se convierte en `ILogger<T>` inyectado por constructor             | media    |
| Tipo de retorno HTTP       | `IActionResult` solo sigue funcionando si activas la integración con ASP.NET Core; si no, `HttpResponseData` | media    |
| Bindings de entrada / salida | los bindings de entrada ganan el sufijo `Input`, los de salida ganan el sufijo `Output`, las salidas dejan la lista de parámetros | media    |
| `IBinder` / `IAsyncCollector<T>` | `IBinder` eliminado; `IAsyncCollector<T>` se convierte en un retorno `T[]` o un cliente inyectado    | media    |
| `FUNCTIONS_WORKER_RUNTIME` | el valor cambia de `dotnet` a `dotnet-isolated` localmente y en la configuración de la app en Azure       | alta     |
| Filtrado de logs           | host.json ya no filtra los logs de tu código; el filtrado se mueve a `Program.cs`                        | baja     |

## Lista de preparación previa

Antes de tocar una línea de código:

- Confirma que la app está en el **host v4**. Ejecuta `func --version` (Core Tools 4.x) y revisa el ajuste de versión del runtime de Functions en el portal. Si estás en v3 o anterior, actualiza el host primero.
- Instala el **SDK de .NET 8** (o el SDK de .NET 11 si apuntas a eso) y las **Azure Functions Core Tools v4** localmente para poder ejecutar `func start` contra el proyecto migrado.
- Inventaria tus **paquetes de trigger y binding**. Haz grep en el `.csproj` por `Microsoft.Azure.WebJobs.Extensions` y anota cada uno; necesitarás el reemplazo `Microsoft.Azure.Functions.Worker.Extensions.*` correspondiente.
- Inventaria las funciones que toman un **parámetro de método `ILogger`** y las que usan **`IBinder` o `IAsyncCollector<T>`**. Estas necesitan ediciones manuales que las herramientas de actualización no pueden automatizar por completo.
- Asegúrate de tener un **slot de despliegue de staging** disponible, o de poder crear uno. El cambio de runtime no debe ocurrir en sitio sobre producción.
- Toma la red de seguridad habitual: una rama limpia, una compilación verde y una suite de pruebas que pasa en la versión in-process para tener una línea base conocida-buena contra la cual hacer diff.
- Opcional pero recomendado: instala el **.NET Upgrade Assistant** (`dotnet tool install -g upgrade-assistant`). Automatiza los cambios de `.csproj`, `Program.cs`, atributos y muchas firmas; luego corriges a mano los bindings que no pudo inferir.

## Pasos de migración

Cada paso a continuación es un cambio discreto con una línea de verificación. Hazlos en orden; el proyecto no compilará limpiamente hasta que el último esté hecho, lo cual es esperado.

1. **Convierte el SDK y los paquetes del `.csproj`.** Elimina la referencia a `Microsoft.NET.Sdk.Functions`, agrega los paquetes del worker y agrega `<OutputType>Exe</OutputType>`. El antes y el después:

   ```xml
   <!-- BEFORE: in-process, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.NET.Sdk.Functions" Version="4.5.0" />
     </ItemGroup>
   </Project>
   ```

   ```xml
   <!-- AFTER: isolated worker, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
       <OutputType>Exe</OutputType>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
     </PropertyGroup>
     <ItemGroup>
       <FrameworkReference Include="Microsoft.AspNetCore.App" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Sdk" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Extensions.Http.AspNetCore" Version="2.0.0" />
       <PackageReference Include="Microsoft.ApplicationInsights.WorkerService" Version="2.23.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.ApplicationInsights" Version="2.0.0" />
     </ItemGroup>
   </Project>
   ```

   Para apuntar a .NET 11 en su lugar, pon `<TargetFramework>net11.0</TargetFramework>`. El `FrameworkReference` a `Microsoft.AspNetCore.App` es lo que permite que los triggers HTTP sigan retornando `IActionResult`; consérvalo incluso si no tienes triggers HTTP, porque mejora el arranque del worker. **Verifica:** `dotnet restore` tiene éxito y obtiene los paquetes del worker. La compilación seguirá fallando en el código, lo cual está bien.

2. **Reemplaza cada paquete de extensión de binding.** Por cada `Microsoft.Azure.WebJobs.Extensions.*` que inventariaste, cambia al equivalente del worker. Los comunes:

   ```text
   Microsoft.Azure.WebJobs.Extensions.Storage.Blobs
     -> Microsoft.Azure.Functions.Worker.Extensions.Storage.Blobs
   Microsoft.Azure.WebJobs.Extensions.ServiceBus
     -> Microsoft.Azure.Functions.Worker.Extensions.ServiceBus
   Microsoft.Azure.WebJobs.Extensions.CosmosDB
     -> Microsoft.Azure.Functions.Worker.Extensions.CosmosDB
   Microsoft.Azure.WebJobs.Extensions.EventHubs
     -> Microsoft.Azure.Functions.Worker.Extensions.EventHubs
   Microsoft.Azure.WebJobs.Extensions.DurableTask
     -> Microsoft.Azure.Functions.Worker.Extensions.DurableTask
   ```

   Un trigger de timer necesita que se agregue `Microsoft.Azure.Functions.Worker.Extensions.Timer` explícitamente. Elimina `Microsoft.Azure.Functions.Extensions` por completo; el worker aislado provee el startup de DI de forma nativa. **Verifica:** no queda ninguna referencia a ningún paquete `Microsoft.Azure.WebJobs.*`. `dotnet list package | Select-String WebJobs` (PowerShell) no debería imprimir nada.

3. **Agrega `Program.cs` y elimina `Startup.cs`.** El worker aislado es una app de consola y necesita un punto de entrada. Mueve todo lo de tu `FunctionsStartup.Configure` a `ConfigureServices`:

   ```csharp
   // Program.cs -- .NET 8 / .NET 11, Microsoft.Azure.Functions.Worker 2.0.x
   using Microsoft.Azure.Functions.Worker;
   using Microsoft.Extensions.DependencyInjection;
   using Microsoft.Extensions.Hosting;

   var builder = FunctionsApplication.CreateBuilder(args);

   // ConfigureFunctionsWebApplication() opts into ASP.NET Core integration so HTTP
   // triggers can keep using HttpRequest / IActionResult. Use
   // ConfigureFunctionsWorkerDefaults() instead if you have no HTTP triggers.
   builder.ConfigureFunctionsWebApplication();

   builder.Services
       .AddApplicationInsightsTelemetryWorkerService()
       .ConfigureFunctionsApplicationInsights();

   // Everything that used to be in Startup.Configure goes here:
   builder.Services.AddHttpClient();
   builder.Services.AddSingleton<IOrderStore, OrderStore>();

   builder.Build().Run();
   ```

   Luego elimina la clase que llevaba el atributo `[assembly: FunctionsStartup(typeof(Startup))]`. **Verifica:** el archivo compila de forma aislada y no queda ningún atributo `FunctionsStartup` en ninguna parte (`Select-String FunctionsStartup -Path **/*.cs`).

4. **Renombra los atributos de función.** `[FunctionName("X")]` se convierte en `[Function("X")]`. La firma es idéntica, así que es un reemplazo de cadenas seguro en todo el proyecto. **Verifica:** `Select-String "FunctionName" -Path **/*.cs` no devuelve nada.

5. **Mueve `ILogger` del parámetro al constructor.** In-process te permitía tomar un parámetro `ILogger log` en el método de la función. El worker aislado usa inyección por constructor. Convierte cada clase de función afectada a un constructor primario:

   ```csharp
   // BEFORE (in-process)
   public static class HttpTriggerCSharp
   {
       [FunctionName("HttpTriggerCSharp")]
       public static IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req,
           ILogger log)
       {
           log.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   ```csharp
   // AFTER (isolated worker, .NET 8 / .NET 11, C# 12+ primary constructor)
   public class HttpTriggerCSharp(ILogger<HttpTriggerCSharp> logger)
   {
       [Function("HttpTriggerCSharp")]
       public IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req)
       {
           logger.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   Nota que la función ya no es `static`, la clase ya no es `static`, e `ILogger` salió de la firma del método. **Verifica:** la clase de función compila y ningún método de función tiene aún un parámetro `ILogger`.

6. **Corrige los usings y los nombres de atributos de triggers y bindings.** Elimina `using Microsoft.Azure.WebJobs;`, agrega `using Microsoft.Azure.Functions.Worker;`. Los triggers normalmente mantienen su nombre (`QueueTrigger` sigue siendo `QueueTrigger`), los bindings de entrada ganan un sufijo `Input` (`CosmosDB` se convierte en `CosmosDBInput`), y los bindings de salida ganan un sufijo `Output` (`Queue` se convierte en `QueueOutput`, `Blob` se convierte en `BlobOutput`). Los bindings de salida también dejan la lista de parámetros: una sola salida va en el tipo de retorno, y múltiples salidas van en propiedades de una pequeña clase de resultado. Reemplaza `IAsyncCollector<T>` con un retorno `T[]`, y elimina cualquier parámetro `IBinder` en favor de un cliente inyectado. **Verifica:** `dotnet build` ahora tiene éxito con cero errores.

7. **Actualiza `local.settings.json`.** Cambia el valor del runtime del worker:

   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "FUNCTIONS_WORKER_RUNTIME": "dotnet-isolated"
     }
   }
   ```

   No se requiere ningún cambio en `host.json`. **Verifica:** `func start` arranca la app localmente y tus funciones aparecen en el banner de inicio con sus rutas.

## Verificación

Después de que la compilación esté verde, ejecuta esta prueba de humo antes de acercarte a Azure:

- `dotnet build` devuelve cero errores y cero referencias a `Microsoft.Azure.WebJobs.*`.
- `func start` arranca y lista cada función con el trigger y la ruta correctos.
- Golpea cada trigger HTTP localmente (`curl` o tu cliente de pruebas) y confirma el mismo código de estado y cuerpo que devolvía la versión in-process.
- Dispara cada trigger no-HTTP: deja caer un blob, encola un mensaje, deja que el timer marque. Confirma que la función se ejecuta y escribe sus salidas.
- `dotnet test` pasa. Vigila específicamente las pruebas que afirmaban sobre la salida de logs o sobre el comportamiento del serializador, ya que ambos pueden cambiar (ver gotchas).
- Compara una traza capturada de Application Insights de antes y después. Confirma que tus categorías de log aún aparecen en los niveles que esperas; si desaparecieron, falta el filtrado de logs en tu `Program.cs`.

## Despliegue en Azure, y reversión

El lado de Azure son dos cambios que deben ocurrir juntos: poner `FUNCTIONS_WORKER_RUNTIME` en `dotnet-isolated` y desplegar el payload aislado. Si solo uno aterriza, la app queda en un estado de error porque el código desplegado no coincide con el runtime configurado. Nunca hagas esto en sitio sobre producción. En su lugar:

1. Crea o reutiliza un **slot de despliegue de staging**.
2. En el slot de staging, pon el ajuste de app `FUNCTIONS_WORKER_RUNTIME` en `dotnet-isolated`. **No** lo marques como ajuste de slot. Si también cambiaste la versión de .NET, actualiza la configuración del stack en el slot también.
3. Publica el proyecto migrado en el slot de staging. Verás errores transitorios en los logs del slot durante el intermedio; espera a que se detengan.
4. Haz pruebas de humo del slot de staging contra dependencias reales de Azure. Confirma que los errores se aclararon y que el comportamiento coincide con producción.
5. **Intercambia** (swap) el slot de staging hacia producción. El swap es una actualización atómica única, así que producción nunca ve el estado intermedio roto.
6. Confirma que producción está sana.

**Reversión:** esto es totalmente reversible mientras conserves la compilación in-process. Para revertir, intercambia los slots de vuelta: el payload de producción anterior (aún in-process) regresa al slot de producción en una sola operación. Como el swap es atómico, la reversión es el mismo movimiento de un clic que el despliegue. Conserva la rama in-process y su último artefacto bueno hasta que el nuevo modelo haya rodado bajo tráfico real durante al menos unos días. La migración solo se vuelve de un solo sentido en el momento en que eliminas ese artefacto in-process, así que no lo elimines el primer día.

## Gotchas que encontramos

**Los logs desaparecen silenciosamente de Application Insights.** En el modelo in-process, `host.json` controlaba el filtrado de logs para todo, incluido tu código. En el worker aislado, `host.json` solo filtra el runtime del host de Functions; los logs de tu aplicación son filtrados por la configuración de logging en `Program.cs`. Si migras y tus logs `Information` desaparecen, agrega filtrado explícito en `Program.cs` en lugar de esperar que `host.json` los cubra.

**Las respuestas HTTP cambian de forma si dependías de Newtonsoft.** Los triggers HTTP in-process que retornaban `IActionResult` serializaban a través de los formateadores MVC del host, que muchas apps habían configurado con un contract resolver de Newtonsoft. El worker aislado usa `System.Text.Json` por defecto. Si tu JSON de pronto usa otro casing o pierde un convertidor personalizado, registra tu serializador en el worker. Si estás sopesando si conservar Newtonsoft del todo, lee [System.Text.Json vs Newtonsoft.Json en 2026](/es/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

**Los orquestadores de Durable Functions que inyectaban servicios empiezan a hacer replay de forma no determinista.** La DI del host in-process era lo bastante indulgente como para que llamar a un servicio con scope de instancia dentro de un orquestador a veces funcionara por accidente. En el worker aislado ese mismo código puede provocar interbloqueo o hacer replay de forma no determinista. La corrección es la regla estándar de Durable que el modelo in-process te dejaba doblar: los orquestadores llaman solo a funciones de actividad, y los efectos secundarios viven en actividades, no en servicios inyectados.

**La app se ve en rojo en Azure durante el deploy, y eso es normal.** La primera vez que empujas el payload aislado a un slot cuyo `FUNCTIONS_WORKER_RUNTIME` aún es `dotnet` (o viceversa), el slot reporta un estado de error. Esa es la discrepancia intermedia que advierte la documentación. Es exactamente por eso que el despliegue va a través de un slot de staging, y se aclara una vez que tanto el ajuste como el payload coinciden.

**Los bindings de salida en la lista de parámetros no compilarán.** El error de compilación más común tras el cambio de paquetes es un binding de salida que sigue siendo un parámetro `out` o `IAsyncCollector<T>`. Muévelo al tipo de retorno (salida única) o a una clase de resultado (múltiples salidas). El error del compilador apunta al parámetro, pero la corrección es estructural, no un cast de tipo.

## Relacionados

- [Azure Functions worker aislado vs in-process en .NET 11](/es/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/) es el compañero centrado-en-decisión de esta lista, con la matriz completa de funcionalidades y el benchmark de cold start.
- [Migrar de .NET 8 a .NET 11: la lista completa](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) es el paso natural siguiente una vez que estás en el worker aislado y quieres mover el runtime hacia adelante.
- [Cómo usar Native AOT con APIs mínimas de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) cubre los ajustes de publish y las advertencias de trim que encontrarás cuando actives AOT para el worker migrado.
- [Native AOT vs ReadyToRun vs JIT plano](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) tiene los números detrás de la afirmación "aislado más AOT le gana a in-process en cold start".
- [Cómo reducir el tiempo de cold-start para un AWS Lambda de .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) comparte la mayor parte del consejo de cold-start con AOT si además ejecutas funciones fuera de Azure.

## Fuentes

- Microsoft Learn, [Migrar apps de C# del modelo in-process al modelo de worker aislado](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-dotnet-to-isolated-model).
- Microsoft Learn, [Diferencias entre el modelo in-process y el modelo de worker aislado](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences).
- Microsoft Learn, [Guía para ejecutar Azure Functions de C# en un proceso de worker aislado](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide).
- Azure updates, [El soporte para el modelo in-process termina el 10 de noviembre de 2026](https://aka.ms/azure-functions-retirements/in-process-model).
- Microsoft Learn, [Migrar Durable Functions de in-process al modelo de worker aislado](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-migrate).
- `Microsoft.Azure.Functions.Worker` en [NuGet](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker).
