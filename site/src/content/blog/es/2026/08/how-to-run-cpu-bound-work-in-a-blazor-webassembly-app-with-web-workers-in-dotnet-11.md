---
title: "Cómo ejecutar trabajo intensivo de CPU en una app Blazor WebAssembly con Web Workers en .NET 11"
description: "Guía completa para sacar el trabajo intensivo de CPU del hilo de UI de Blazor WebAssembly en .NET 11: por qué Task.Run no ayuda, la nueva plantilla blazorwebworker, la API WebWorkerClient con cancelación y timeouts, los límites de marshalling de JSExport y el costo del segundo runtime que pagas por cada worker."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "webassembly"
  - "web-workers"
  - "performance"
lang: "es"
translationOf: "2026/08/how-to-run-cpu-bound-work-in-a-blazor-webassembly-app-with-web-workers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Blazor WebAssembly ejecuta tu código .NET en el único hilo de UI del navegador, así que un bucle `for` apretado congela la página: sin repintados, sin clics, sin `StateHasChanged`. `Task.Run` no te salva, porque no hay un segundo hilo donde ejecutarse. La solución en .NET 11 es la plantilla de proyecto `blazorwebworker`, que genera una biblioteca de clases cuyos métodos se ejecutan dentro de un Web Worker real del navegador, en un hilo de sistema operativo separado. Marcas esos métodos con `[JSExport]`, referencias la biblioteca desde tu app y los llamas a través de `WebWorkerClient.InvokeAsync<TResult>`.

Todo lo que sigue apunta a .NET 11 (Preview 6 al momento de escribir esto, SDK `11.0.100-preview.6`) con C# 14. La plantilla llegó en .NET 11 Preview 1 con el nombre `webworker` y fue [renombrada a `blazorwebworker`](https://github.com/dotnet/aspnetcore/pull/66070) antes de la versión final; los proyectos generados con el nombre anterior siguen funcionando, solo cambió el identificador de la plantilla. Hay dos capacidades nuevas en el cliente final de .NET 11: `InvokeVoidAsync`, y soporte de cancelación y timeout tanto en la creación del worker como en la invocación.

## Los seis pasos, de principio a fin

1. Crea una biblioteca de clases worker con `dotnet new blazorwebworker` y referénciala desde la app Blazor WebAssembly.
2. Escribe tu código intensivo de CPU como métodos `static` marcados con `[JSExport]` dentro de una `static partial class`.
3. Devuelve solo primitivos o cadenas; serializa a JSON dentro del worker cualquier cosa más rica.
4. Crea el `WebWorkerClient` una sola vez (no por llamada) y consérvalo durante toda la vida del componente o de la app.
5. Invoca los métodos por su nombre completamente calificado, pasando un `CancellationToken` y un timeout.
6. Libera el cliente para terminar el worker y liberar el segundo runtime que cargó.

El resto de este post trata sobre por qué cada uno importa, y qué se rompe cuando te saltas alguno.

## Por qué `Task.Run` no mueve el trabajo fuera del hilo de UI

Esto es lo primero que la gente intenta, y vale la pena entender exactamente por qué falla antes de recurrir a los workers.

```csharp
// .NET 11, C# 14 - Blazor WebAssembly. This still freezes the browser.
private async Task Compute()
{
    status = "Working...";
    await Task.Run(() => CountPrimes(5_000_000));
    status = "Done";
}

private static int CountPrimes(int limit)
{
    var count = 0;
    for (var n = 2; n <= limit; n++)
    {
        var isPrime = true;
        for (var d = 2; d * d <= n; d++)
        {
            if (n % d == 0) { isPrime = false; break; }
        }
        if (isPrime) count++;
    }

    return count;
}
```

La línea `status = "Working..."` nunca se renderiza. La pestaña del navegador deja de responder por varios segundos, y después ambas actualizaciones de estado aparecen a la vez.

La razón es que el runtime de Blazor WebAssembly es de un solo hilo. `Task.Run` encola trabajo en el pool de hilos de .NET, pero en el runtime `browser-wasm` ese pool está emulado sobre el único hilo que el runtime posee. El delegado no arranca hasta que el bloque síncrono actual cede el control, y una vez que arranca, nada más puede intercalarse hasta que retorne. Un `await Task.Delay(1)` antes del bucle deja pasar el primer render, pero el bucle sigue bloqueando todo lo que viene después.

La pregunta obvia que sigue es si puedes simplemente activar los hilos. El runtime sí soporta `<WasmEnableThreads>true</WasmEnableThreads>`, pero esa es una característica a nivel de runtime, y Blazor WebAssembly no la soporta. El renderizador de Blazor depende de la garantía histórica de un solo hilo: los lotes de render se entregan a JavaScript mediante memoria compartida sin copias, y los eventos se despachan hacia .NET de forma síncrona. El runtime multihilo mueve todo el código .NET a un hilo "deputy" en segundo plano, lo que rompe ambas suposiciones. El issue de seguimiento [dotnet/aspnetcore#54365](https://github.com/dotnet/aspnetcore/issues/54365) sigue abierto. Activar la bandera en un proyecto Blazor WASM te da una compilación que no corre, no una app más rápida.

Así que la única opción real es ejecutar una segunda copia independiente del runtime de .NET dentro de un Web Worker, y hablar con ella por paso de mensajes. Eso es exactamente lo que construye la plantilla.

## Crear el proyecto worker

Dos comandos y una referencia de proyecto:

```bash
# .NET 11 SDK
dotnet new blazorwasm -n SampleApp
dotnet new blazorwebworker -n WebWorker

cd SampleApp
dotnet add reference ../WebWorker/WebWorker.csproj
```

La biblioteca generada se ve así:

```
WebWorker/
├── WebWorker.csproj
├── WebWorkerClient.cs
├── WorkerMethods.cs
└── wwwroot/
    ├── dotnet-web-worker-client.js
    └── dotnet-web-worker.js
```

`dotnet-web-worker.js` es el punto de entrada del worker. Llama a `dotnet.create()` para arrancar un runtime de WebAssembly sin ninguna capa de Blazor, luego a `getAssemblyExports(assemblyName)` para obtener un handle sobre tus métodos `[JSExport]`, y resuelve contra ese grafo de objetos los nombres de método que llegan. `dotnet-web-worker-client.js` corre en el hilo principal, levanta el worker y correlaciona solicitudes con respuestas por ID. `WebWorkerClient.cs` es el envoltorio en C# sobre ese cliente de JavaScript. No necesitas editar ninguno de los tres.

Una propiedad del proyecto importa y la plantilla ya la configura:

```xml
<PropertyGroup>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

`[JSExport]` y `[JSImport]` generan código de marshalling que usa punteros, así que el compilador se niega sin ella. Si más adelante agregas llamadas `[JSImport]` en el propio proyecto de la app Blazor, necesitas la misma propiedad ahí.

## Escribir los métodos del worker

Los métodos del worker son `static`, están marcados con `[JSExport]` y viven en una `static partial class`. El `partial` no es decorativo: el generador de código fuente de interop con JS emite la otra mitad. `[SupportedOSPlatform("browser")]` suprime las advertencias del analizador de compatibilidad de plataforma, ya que estas APIs solo existen en el runtime del navegador.

`WebWorker/WorkerMethods.cs`:

```csharp
// .NET 11, C# 14
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;

namespace WebWorker;

[SupportedOSPlatform("browser")]
public static partial class WorkerMethods
{
    [JSExport]
    public static int CountPrimes(int limit)
    {
        var count = 0;
        for (var n = 2; n <= limit; n++)
        {
            var isPrime = true;
            for (var d = 2; d * d <= n; d++)
            {
                if (n % d == 0) { isPrime = false; break; }
            }
            if (isPrime) count++;
        }

        return count;
    }

    [JSExport]
    public static string Analyze(string csv)
    {
        var rows = csv.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var report = new Report(rows.Length, rows.Length == 0 ? 0 : rows.Max(r => r.Length));
        return JsonSerializer.Serialize(report);
    }
}

public record Report(int RowCount, int WidestRow);
```

Fíjate en la forma de `Analyze`. `[JSExport]` hace marshalling de un conjunto fijo de tipos a través de la frontera con JavaScript: primitivos, `string`, `byte[]`, `Task<T>` de esos, y unos pocos tipos específicos de JS. No hace marshalling de POCOs ni records arbitrarios. La solución estándar es serializar dentro del worker y deserializar del otro lado, que es lo que recomienda la documentación y lo que hace el ejemplo generado. Si tu payload es una jerarquía polimórfica, la [configuración del discriminador `[JsonDerivedType]`](/es/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/) aplica aquí sin cambios, porque ambos extremos son System.Text.Json.

También vale la pena saberlo: `byte[]` sí cruza directamente, y el cliente generado optimiza las transferencias de `ArrayBuffer` para que los resultados binarios grandes se muevan en lugar de copiarse. Si devuelves bytes de imágenes o archivos, prefiere `byte[]` sobre base64 dentro de una cadena JSON.

## Llamar al worker desde un componente

`WebWorkerClient.CreateAsync` arranca el worker y espera hasta que el runtime dentro de él reporte que está listo. Esa es una operación asíncrona que implica una descarga de red, así que pertenece a `OnAfterRenderAsync`, no a `OnInitializedAsync`.

`Pages/Home.razor.cs`:

```csharp
// .NET 11, C# 14
using System.Text.Json;
using System.Runtime.Versioning;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using WebWorker;

namespace SampleApp.Pages;

[SupportedOSPlatform("browser")]
public partial class Home : ComponentBase, IAsyncDisposable
{
    private WebWorkerClient? worker;
    private string status = "Booting worker...";

    [Inject] private IJSRuntime JSRuntime { get; set; } = default!;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            worker = await WebWorkerClient.CreateAsync(JSRuntime);
            status = "Ready";
            StateHasChanged();
        }
    }

    private async Task Run()
    {
        if (worker is null) return;

        status = "Working...";

        var count = await worker.InvokeAsync<int>(
            "WebWorker.WorkerMethods.CountPrimes", [5_000_000]);

        status = $"Found {count} primes";
    }

    public async ValueTask DisposeAsync()
    {
        if (worker is not null)
        {
            await worker.DisposeAsync();
        }
    }
}
```

Ahora `status = "Working..."` se renderiza de inmediato, el spinner gira, y la UI sigue interactiva mientras cinco millones de números se factorizan en otro hilo del sistema operativo.

El nombre del método es una cadena: `AssemblyName.ClassName.MethodName`. El worker la separa y recorre el objeto de exports devuelto por `getAssemblyExports`, así que un error de tipeo es un fallo en tiempo de ejecución en lugar de un error de compilación. Envolver cada llamada en un pequeño método tipado sobre una clase de servicio vale las diez líneas, porque te da un único lugar donde viven las cadenas mágicas.

La ubicación en `OnAfterRenderAsync` no es una cuestión de estilo. En una Blazor Web App cuyo proyecto `.Client` se prerenderiza en el servidor, la interop con JS no está disponible durante la pasada de prerender, y llamarla ahí lanza el error [JavaScript interop calls cannot be issued at this time](/es/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/). `OnAfterRenderAsync` solo se ejecuta después de que la interactividad está establecida, así que el worker se crea exactamente una vez, en el cliente.

## Cancelación y timeouts

Esta es la adición de .NET 11 que hace usable el cliente en producción. La superficie completa:

```csharp
// .NET 11
public sealed class WebWorkerClient : IAsyncDisposable
{
    public static async Task<WebWorkerClient> CreateAsync(
        IJSRuntime jsRuntime,
        int timeoutMs = 60000,
        string? assemblyName = null,
        CancellationToken cancellationToken = default);

    public async Task<TResult> InvokeAsync<TResult>(
        string method,
        object[] args,
        int timeoutMs = 60000,
        CancellationToken cancellationToken = default);

    public async Task InvokeVoidAsync(
        string method,
        object[] args,
        int timeoutMs = 60000,
        CancellationToken cancellationToken = default);

    public async ValueTask DisposeAsync();
}
```

Tanto `timeoutMs` como el token protegen la espera del hilo principal, no la ejecución del worker. Un método `[JSExport]` que corre un bucle síncrono no puede observar un `CancellationToken`, porque no hay forma de interrumpirlo desde afuera. Lo que te compra la cancelación es la capacidad de dejar de esperar y desmontar un worker atascado:

```csharp
// .NET 11, C# 14
private CancellationTokenSource? cts;

private async Task RunCancellable()
{
    cts?.Cancel();
    cts?.Dispose();
    cts = new CancellationTokenSource();

    try
    {
        var count = await worker!.InvokeAsync<int>(
            "WebWorker.WorkerMethods.CountPrimes",
            [5_000_000],
            timeoutMs: 10_000,
            cancellationToken: cts.Token);

        status = $"Found {count} primes";
    }
    catch (OperationCanceledException)
    {
        status = "Cancelled";

        // The worker is still busy. Kill it and start a fresh one.
        await worker.DisposeAsync();
        worker = await WebWorkerClient.CreateAsync(JSRuntime);
    }
}

private void Cancel() => cts?.Cancel();
```

Liberar el cliente después de una cancelación es la mitad importante. Si cancelas la espera pero conservas el cliente, el cálculo abandonado sigue quemando un núcleo y el siguiente `InvokeAsync` queda encolado detrás. `DisposeAsync` llama a `terminate()` sobre el `Worker` subyacente, lo que lo detiene de inmediato sin importar qué esté haciendo. La forma general de propagar un token a través de una cadena de llamadas está cubierta en la guía sobre [propagar un CancellationToken a través de métodos asíncronos](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/), y [`CancellationTokenSource.CancelAfter`](/es/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/) se compone con `timeoutMs` si quieres una fecha límite del lado del cliente que también dispare tu propia limpieza.

Para trabajo cuyo resultado no necesitas, `InvokeVoidAsync` se salta el viaje de vuelta del resultado:

```csharp
await worker.InvokeVoidAsync("WebWorker.WorkerMethods.WarmCaches", []);
```

## El costo: cada worker descarga su propio runtime

Esta es la parte que sorprende a la gente, y la que impulsa la mayoría de las decisiones de diseño de arriba.

El worker no comparte el runtime del hilo principal. Arranca un segundo runtime de .NET WebAssembly completo: `dotnet.js`, el `.wasm` del runtime, y cada ensamblado que tu biblioteca worker referencia transitivamente. La caché HTTP del navegador hace que la segunda descarga suela ser barata después de la primera carga, pero la instanciación no es gratis, y la memoria se duplica de verdad porque los dos runtimes tienen heaps separados.

Las reglas prácticas que se derivan:

- **Crea el cliente una vez, reutilízalo siempre.** Un `CreateAsync` por cada clic de botón es la forma más común de hacer que un worker sea más lento que el código que reemplazó.
- **Para uso en toda la app, regístralo como singleton** e inicialízalo de forma perezosa en lugar de crearlo por componente:

  ```csharp
  // .NET 11, C# 14 - Program.cs of the Blazor WebAssembly app
  builder.Services.AddSingleton<WorkerService>();
  ```

  ```csharp
  public sealed class WorkerService(IJSRuntime js) : IAsyncDisposable
  {
      private WebWorkerClient? client;
      private readonly SemaphoreSlim gate = new(1, 1);

      private async Task<WebWorkerClient> GetClientAsync(CancellationToken ct)
      {
          if (client is not null) return client;

          await gate.WaitAsync(ct);
          try
          {
              return client ??= await WebWorkerClient.CreateAsync(js, cancellationToken: ct);
          }
          finally
          {
              gate.Release();
          }
      }

      public async Task<int> CountPrimesAsync(int limit, CancellationToken ct = default)
      {
          var c = await GetClientAsync(ct);
          return await c.InvokeAsync<int>(
              "WebWorker.WorkerMethods.CountPrimes", [limit], cancellationToken: ct);
      }

      public async ValueTask DisposeAsync()
      {
          if (client is not null) await client.DisposeAsync();
          gate.Dispose();
      }
  }
  ```

  El semáforo importa porque dos componentes renderizándose al mismo tiempo van a ver ambos `client is null` y ambos van a llamar a `CreateAsync`, dejándote con dos runtimes donde querías uno.

- **Mantén pequeño el grafo de dependencias de la biblioteca worker.** Cada paquete que referencies desde el proyecto worker es un ensamblado extra descargado y cargado en el segundo runtime. Pon ahí solo el código de cálculo, no tu biblioteca de modelos compartida con EF Core y validación colgando de ella.
- **Agrupa las llamadas.** Cada invocación es un viaje de ida y vuelta de `postMessage` con un paso de serialización en ambos extremos. Diez llamadas en un bucle son medibles peor que una llamada con un argumento de arreglo.

## Qué no cruza la frontera

El worker es un runtime genuinamente separado, y tratarlo como un hilo en segundo plano dentro del mismo proceso es de donde vienen los bugs.

**Sin estado compartido.** Los campos estáticos de tu ensamblado worker existen dos veces: una copia en el runtime del hilo principal, otra en el worker. Escribir en un estático desde un componente y leerlo desde un método `[JSExport]` devuelve lo que sea que tenga la copia del worker. Todo el estado debe viajar en los argumentos y en el valor de retorno.

**Sin inyección de dependencias.** Los métodos del worker son estáticos y el runtime del worker nunca construye un proveedor de servicios. Si tu código de cálculo necesita configuración, pásasela como argumentos o como un blob JSON.

**Sin DOM, sin `IJSRuntime`, sin `NavigationManager`.** Un Web Worker no tiene `document` ni `window`. Cualquier cosa que toque la UI tiene que ocurrir de vuelta en el hilo principal después de que `InvokeAsync` retorne.

**Sin callbacks de progreso, de fábrica.** El cliente generado modela solicitud y respuesta, no streaming. Si necesitas una barra de progreso para un cálculo largo, divide el trabajo en trozos y haz una llamada por trozo, actualizando la UI entre llamadas.

## Depuración y trimming, los dos bordes ásperos

Las excepciones lanzadas dentro de un método `[JSExport]` vuelven como una cadena de mensaje a través de `postMessage`, así que la traza de pila de C# que obtienes en el hilo principal describe la capa de interop, no tu bucle. Cuando un método del worker se porta mal, el camino más rápido suele ser llamar temporalmente al mismo método estático directamente desde el componente, reproducirlo en el hilo principal con el depurador adjunto, y después moverlo de vuelta.

El trimming es la segunda cosa a vigilar. Las apps Blazor publicadas hacen trimming agresivo, y el worker resuelve tus métodos por nombre en tiempo de ejecución a través de `getAssemblyExports`. El atributo `[JSExport]` es lo que mantiene esos métodos enraizados, así que un método exportado está a salvo. Cualquier cosa a la que llegue solo por reflexión, no. Si una llamada al worker funciona en `dotnet run` y falla después de `dotnet publish`, reflexión más trimming es la primera hipótesis a probar, y las mismas [reglas de seguridad de trimming que aplican a Native AOT](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/) aplican aquí.

Por último, sé honesto sobre si realmente necesitas esto. Si estás construyendo una Blazor Web App en lugar de una app WebAssembly independiente, el servidor normalmente puede hacer el cálculo más rápido de lo que el cliente tarda en arrancar un segundo runtime, y una simple llamada a la API es menos maquinaria para el mismo resultado. Los compromisos entre los modelos de hosting están expuestos en la comparación de [Blazor Server, WebAssembly y United](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/). Los Web Workers son la respuesta correcta cuando los datos ya están en el cliente, cuando el trabajo es genuinamente intensivo de CPU en lugar de intensivo de IO, y cuando un viaje de ida y vuelta al servidor no es aceptable. Para todo lo demás, el servidor sigue siendo un pool de hilos con mejor hardware.

## Relacionados

- [dotnet new webworker: Web Workers de primera clase para Blazor en .NET 11 Preview 2](/es/2026/04/dotnet-11-preview-2-blazor-webworker-template/)
- [Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [Cómo propagar un CancellationToken a través de métodos asíncronos en .NET 11](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time durante el prerenderizado de Blazor](/es/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [Cómo serializar una jerarquía de tipos polimórfica con JsonDerivedType en System.Text.Json](/es/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [Cómo escribir un isolate de Dart para trabajo intensivo de CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)

## Fuentes

- [ASP.NET Core Blazor with .NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-with-dotnet-on-web-workers?view=aspnetcore-11.0), Microsoft Learn
- [.NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-11.0), Microsoft Learn
- [What's new in ASP.NET Core in .NET 11: New Blazor Web Worker template](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0), Microsoft Learn
- [.NET Web Worker template update to Blazor Web Worker template (dotnet/aspnetcore #66070)](https://github.com/dotnet/aspnetcore/pull/66070), GitHub
- [Make Blazor WebAssembly work on multithreaded runtime (dotnet/aspnetcore #54365)](https://github.com/dotnet/aspnetcore/issues/54365), GitHub
- [JSExportAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.javascript.jsexportattribute), Microsoft Learn
- [Running background tasks in Blazor with Web Workers](https://andrewlock.net/exploring-the-dotnet-11-preview-1-running-background-tasks-in-blazor-with-web-workers/), Andrew Lock
- [Web Workers API](https://developer.mozilla.org/docs/Web/API/Web_Workers_API), MDN
