---
title: "Migrar de llamadas bloqueantes .Result/.Wait() a async en toda la cadena en una base de código C# heredada"
description: "Un plan por etapas para eliminar sync-over-async de una base de código .NET existente: inventariar con analizadores, medir la inanición del ThreadPool, convertir una cadena de llamadas a la vez y reducir el conteo a cero en .NET 11."
pubDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "es"
translationOf: "2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-25
---

Eliminar sync-over-async de una base de código real no es un buscar y reemplazar. Presupuesta de uno a tres sprints para un servicio de unos cientos de miles de líneas, y espera que el trabajo tenga la forma de una serie de cortes verticales en lugar de un único PR masivo. Lo que se rompe son principalmente las firmas: cada método que deja de bloquear tiene que devolver `Task`, y eso se propaga hacia arriba a través de interfaces, constructores, `Dispose`, bloques `lock` y la superficie pública de tu API. Vale la pena hacerlo cuando ves inanición del ThreadPool bajo carga o interbloqueos duros en un hilo de UI, y vale la pena posponerlo cuando la llamada bloqueante está en una herramienta de línea de comandos que se ejecuta una vez y termina. Este plan apunta a .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14); todas las herramientas mencionadas funcionan desde .NET 6, salvo el paso de trazado en runtime, que requiere .NET 9 o posterior.

## Por qué las llamadas bloqueantes tienen que desaparecer

- **La inanición del ThreadPool desaparece.** Cada `.Result` en una ruta de solicitud aparca un hilo del pool. El propio [tutorial de inanición del ThreadPool](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-threadpool-starvation) de Microsoft mide el mismo endpoint en 3.48 s de latencia promedio con 125 conexiones concurrentes mientras bloquea, y 532 ms después de esperar la llamada. Eso no es una diferencia de ajuste fino, es una aplicación distinta.
- **Los interbloqueos duros se vuelven imposibles, no improbables.** En un hilo de WPF, WinForms o ASP.NET clásico, bloquear sobre una tarea cuya continuación necesita ese hilo es una espera circular. El mecanismo está cubierto en [por qué bloquear sobre un método asíncrono provoca un interbloqueo](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/); eliminar el bloqueo elimina toda esa clase de errores.
- **La memoria baja junto con el conteo de hilos.** Un pool que se ha estabilizado en 130 hilos para compensar el bloqueo mantiene 130 pilas. Pasar a asíncrono suele devolver el conteo a un múltiplo pequeño del número de núcleos.
- **La cancelación empieza a funcionar.** Un hilo bloqueado no puede observar un `CancellationToken`. Una vez que la cadena es asíncrona, los tiempos de espera y las desconexiones del cliente sí se propagan.

## Qué se rompe al pasar a asíncrono

| Área                              | Cambio                                                                                                | Severidad |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | --------- |
| Superficie pública de la API      | `T Get()` pasa a `Task<T> GetAsync()`: ruptura de código fuente y binaria para los consumidores         | alta      |
| Interfaces que no son tuyas       | A un método de interfaz de terceros o del framework no se le puede dar un tipo de retorno `Task`        | alta      |
| Constructores, getters de propiedad| Ninguno puede ser `async`; el trabajo se mueve a un método de fábrica o a un inicializador diferido     | alta      |
| Sentencias `lock`                 | `await` dentro de `lock` es el error de compilación `CS1996`; requiere `SemaphoreSlim`                  | media     |
| Manejo de excepciones             | `AggregateException` deja de aparecer, así que `catch (AggregateException)` deja de coincidir en silencio| media    |
| `TransactionScope`                | No fluye a través de `await` salvo que se construya con `TransactionScopeAsyncFlowOption.Enabled`       | media     |
| `IDisposable`                     | La limpieza asíncrona en `Dispose` necesita `IAsyncDisposable` y `await using`                          | media     |
| Suite de pruebas                  | Los métodos de prueba síncronos que llaman a código ahora asíncrono pasan a ser `async Task`            | baja      |

Las filas de severidad alta son las que deciden tu secuencia. Todo lo demás es mecánico.

## Lista de verificación previa

- La solución compila limpia en .NET 6 o posterior. Nada de esto requiere .NET 11, pero el paso de trazado en runtime necesita .NET 9+ para el evento `WaitHandleWait`.
- `Microsoft.VisualStudio.Threading.Analyzers` agregado a todos los proyectos, o al menos a los proyectos de la ruta caliente. Este es el paquete que encuentra llamadas bloqueantes en métodos síncronos, algo que los analizadores integrados de .NET no hacen.
- `dotnet-counters`, `dotnet-trace` y `dotnet-stack` instalados como herramientas globales.
- Una prueba de carga que reproduzca el síntoma. Sin ella no puedes demostrar que la migración funcionó, ni que no introdujo una regresión.
- Una estrategia de ramas que permita muchos PRs pequeños. Un PR de 400 archivos que cambia todas las firmas de la solución no va a ser revisado.

## Pasos de la migración

1. **Construye el inventario con analizadores, no con grep.**

   `grep -r "\.Result"` encuentra accesos a propiedades sobre cualquier cosa llamada Result y se pierde por completo la E/S síncrona. Activa las dos reglas que sí entienden el patrón:

   ```ini
   # .editorconfig -- .NET 11 SDK 11.0.0
   [*.cs]
   # Avoid problematic synchronous waits (.Result, .Wait(), GetAwaiter().GetResult())
   dotnet_diagnostic.VSTHRD002.severity = warning
   # Call async methods when in an async method
   dotnet_diagnostic.VSTHRD103.severity = warning
   # Built-in equivalent; off by default through .NET 10
   dotnet_diagnostic.CA1849.severity = warning
   ```

   La distinción importa en una base de código heredada. [CA1849](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1849) solo se dispara dentro de un método que devuelve `Task`, así que en código donde nada es asíncrono todavía, reporta casi nada. `VSTHRD002` se dispara sobre la llamada bloqueante viva donde viva, que es exactamente la población que intentas contar.

   **Verificación**: compila la solución y cuenta las líneas `VSTHRD002` en la salida. Guarda ese número. Es tu gráfico de reducción.

2. **Captura una línea base bajo carga antes de cambiar una sola línea.**

   Ejecuta tu prueba de carga y observa el pool:

   ```bash
   dotnet-counters monitor -n YourApp System.Runtime
   ```

   En .NET 9 y posteriores, los contadores que hay que leer son `dotnet.thread_pool.thread.count`, `dotnet.thread_pool.queue.length` y `dotnet.thread_pool.work_item.count`. La señal de inanición es un conteo de hilos que sube lentamente mientras la CPU se mantiene muy por debajo del 100%. Un conteo que se estabiliza por encima de aproximadamente tres veces el número de procesadores significa que el código está bloqueando hilos del pool y el runtime lo compensa creando más.

   **Verificación**: registra el conteo de hilos estabilizado, la latencia p95 y las solicitudes por segundo. Los compararás en el paso de verificación.

3. **Encuentra las llamadas bloqueantes que el análisis de código fuente no puede ver.**

   Los analizadores no pueden marcar `File.ReadAllText`, `SqlCommand.ExecuteReader` ni un `SemaphoreSlim.Wait()` enterrado en una dependencia de la que no tienes el código fuente. .NET 9 agregó el evento `WaitHandleWait` exactamente para esto:

   ```bash
   dotnet trace collect -n YourApp --clrevents waithandle --clreventlevel verbose --duration 00:00:30
   ```

   Abre el archivo `.nettrace` resultante en PerfView o en el .NET Events Viewer de la comunidad y expande las pilas `WaitHandleWaitStart`. Cualquier pila cuyos marcos base mencionen `ThreadPoolWorkQueue.Dispatch` o `WorkerThread.WorkerThreadStart` es un hilo del pool siendo bloqueado, y el marco por encima de la espera nombra tu método.

   **Verificación**: cada pila de la traza o bien se corresponde con un sitio de llamada que ya está en tu inventario del paso 1, o bien se agrega a él.

4. **Convierte una cadena de llamadas de punta a punta, no un archivo.**

   Elige el único punto de entrada más caliente del paso 3. Empieza por la hoja (el método que realmente llama a `HttpClient` o a EF Core), dale un gemelo asíncrono y sube por la pila convirtiendo cada llamador hasta llegar a un método que pueda hacer `await` sin tener un llamador propio: una acción de controlador, un `BackgroundService.ExecuteAsync`, un manejador de eventos o `Main`.

   ```csharp
   // .NET 11, C# 14 -- before: the block is three frames below the controller
   public IActionResult GetOrder(int id)
   {
       var order = _repository.Get(id);          // sync wrapper
       return Ok(order);
   }

   // after: no wrapper, no block, Task all the way to the framework
   public async Task<IActionResult> GetOrderAsync(int id, CancellationToken ct)
   {
       var order = await _repository.GetAsync(id, ct);
       return Ok(order);
   }
   ```

   Una conversión parcial es peor que ninguna en esta ruta. Un solo `.Result` restante en cualquier punto del segmento síncrono reintroduce tanto el interbloqueo como el hilo aparcado, así que un corte solo está terminado cuando llega a un punto de entrada.

   **Verificación**: vuelve a ejecutar la traza del paso 3 contra ese único endpoint. Cero eventos `WaitHandleWait` en hilos del pool para esa pila.

5. **Borra el gemelo síncrono en lugar de conservar ambos.**

   El atajo tentador es dejar `Get()` en su lugar como `GetAsync().GetAwaiter().GetResult()` para que nada más tenga que cambiar. Ese es el envoltorio síncrono contra el que argumenta Stephen Toub en [Should I expose synchronous wrappers for asynchronous methods?](https://devblogs.microsoft.com/dotnet/should-i-expose-synchronous-wrappers-for-asynchronous-methods/), y en una migración es activamente dañino: el envoltorio es donde se esconden tus llamadas bloqueantes restantes, y permite que los llamadores se libren del trabajo para siempre.

   Si de verdad tienes un consumidor síncrono y otro asíncrono y no puedes prescindir de ninguno, usa el patrón de argumento bandera que usa la BCL en lugar de un envoltorio:

   ```csharp
   // .NET 11, C# 14 -- one implementation, two entry points, no sync-over-async
   public int Read(byte[] buffer) => ReadCoreAsync(buffer, sync: true).GetAwaiter().GetResult();
   public Task<int> ReadAsync(byte[] buffer) => ReadCoreAsync(buffer, sync: false);

   private async Task<int> ReadCoreAsync(byte[] buffer, bool sync)
   {
       // Every I/O call inside branches on `sync`, so the synchronous path
       // never awaits an incomplete task and cannot deadlock.
       return sync ? _stream.Read(buffer) : await _stream.ReadAsync(buffer);
   }
   ```

   **Verificación**: el punto de entrada síncrono ya no aparece en una traza `WaitHandleWait`, porque nunca espera sobre una tarea incompleta.

6. **Atiende las costuras que realmente no pueden ser asíncronas.**

   Aparecen tres en toda migración. Un constructor no puede ser `async`, así que mueve la inicialización a una fábrica estática (`public static async Task<Foo> CreateAsync()`) o a un campo `Lazy<Task<T>>` que los llamadores esperen. Un `Dispose` que hace limpieza asíncrona debería implementar `IAsyncDisposable` y consumirse con [await using](/es/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/). Un bloque `lock` que contiene trabajo asíncrono nuevo falla al compilar con `CS1996`, porque un monitor debe liberarse en el mismo hilo que lo tomó:

   ```csharp
   // .NET 11, C# 14 -- lock cannot span an await; SemaphoreSlim can
   private readonly SemaphoreSlim _gate = new(1, 1);

   public async Task<Config> LoadAsync(CancellationToken ct)
   {
       await _gate.WaitAsync(ct);
       try { return _cached ??= await FetchAsync(ct); }
       finally { _gate.Release(); }
   }
   ```

   **Verificación**: el proyecto compila sin `CS1996` y sin nuevos `async void` fuera de manejadores de eventos.

7. **Propaga el CancellationToken mientras las firmas ya están abiertas.**

   Agregar `CancellationToken ct = default` no cuesta nada en una firma que de todos modos vas a cambiar, y es doloroso incorporarlo después. Pásalo a cada llamada asíncrona de la cadena, no solo a la más externa, siguiendo las reglas de [propagar un CancellationToken a través de métodos asíncronos](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

   **Verificación**: cancela una solicitud en pleno vuelo (corta la conexión del cliente) y confirma que la llamada a la base de datos se abandona de verdad en lugar de ejecutarse hasta el final.

8. **Fija el analizador como trinquete para que el conteo solo pueda bajar.**

   Una vez que un proyecto llega a cero, bloquéalo:

   ```xml
   <!-- Directory.Build.props -- .NET 11 SDK 11.0.0 -->
   <PropertyGroup>
     <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
     <WarningsAsErrors>$(WarningsAsErrors);VSTHRD002;CA1849</WarningsAsErrors>
   </PropertyGroup>
   ```

   Para los proyectos que siguen a mitad de migración, mantén las reglas en `warning` y haz que CI falle ante un aumento del conteo en lugar de ante cualquier advertencia. Un trinquete que bloquea deuda nueva mientras la vieja se reduce es la única versión de esto que los equipos realmente mantienen.

   **Verificación**: agrega un `.Result` deliberado en un proyecto ya convertido y confirma que la compilación falla.

## Verificar que la migración funcionó de verdad

Que las firmas compilen no es evidencia. Ejecuta la misma prueba de carga del paso 2 y compara cuatro números:

- **El conteo de hilos del ThreadPool** debería estabilizarse cerca de un múltiplo pequeño del número de núcleos en lugar de trepar a los cientos.
- **La latencia p95 bajo carga** debería acercarse a la latencia de una sola solicitud. El endpoint del tutorial de inanición pasó de 3.48 s de vuelta a aproximadamente sus 500 ms sin carga.
- **El throughput** debería subir, a menudo en un orden de magnitud, porque los mismos hilos ahora atienden muchas más solicitudes.
- **Los eventos `WaitHandleWait` en hilos del pool** deberían ser casi cero en las rutas convertidas.

Después corre las comprobaciones funcionales: `dotnet test` con cero fallos, una prueba de cancelación que demuestre que una desconexión del cliente aborta la llamada aguas abajo, y una revisión manual de cualquier bloque `catch (AggregateException)` en el código tocado, ya que esos ya no coinciden con nada una vez que las llamadas bloqueantes desaparecen.

## Cómo revertir

Corte a corte, esta migración se revierte limpiamente: cada corte vertical es un PR autocontenido, y revertirlo restaura la llamada bloqueante y sus firmas. Ese es el principal argumento para cortar por cadena de llamadas en lugar de por capa.

Lo que no se revierte limpiamente es una biblioteca publicada. Cambiar `T Get()` por `Task<T> GetAsync()` es una ruptura binaria para todos los consumidores que compilaron contra el ensamblado anterior, así que para un paquete NuGet esto es una migración de versión mayor y la reversión tiene que ser un nuevo lanzamiento, no un `git revert`. Decide antes de empezar si el paquete publica ambas superficies durante una versión mayor (usando el patrón de argumento bandera del paso 5, nunca un envoltorio síncrono) o si rompe de una sola vez.

## Trampas que nos costaron tiempo

**`async void` se cuela de vuelta a través de lambdas.** Una lambda pasada a un parámetro de tipo `Action` se convierte en `async void`, así que las excepciones dentro de ella tumban el proceso en lugar de aparecer en una tarea. `List<T>.ForEach(async x => ...)` y `Parallel.ForEach` con un cuerpo asíncrono son los dos portadores comunes. `VSTHRD101` detecta el caso del delegado; el límite entre el uso legítimo y el roto está en [cuándo async void es correcto y cuándo es una trampa](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

**`.Select(async x => ...)` produce `IEnumerable<Task>`, no resultados.** Compila, parece convertido y nada lo espera. Acompáñalo con `await Task.WhenAll(...)` o cambia la enumeración a [IAsyncEnumerable](/es/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/).

**`TransactionScope` deja de fluir en silencio.** El constructor por defecto no propaga la transacción ambiente a través de un `await`, así que el código posterior al primer await se ejecuta fuera de la transacción sin ningún error. Constrúyelo con `TransactionScopeAsyncFlowOption.Enabled`.

**ASP.NET Core lanza excepciones antes de que termines.** Convertir las capas externas puede sacar a la luz `InvalidOperationException: Synchronous operations are disallowed` desde un `Stream.Read` síncrono más abajo, porque `AllowSynchronousIO` es false por defecto. Esa excepción es un mapa del trabajo pendiente, no una razón para volver a activar el interruptor; los detalles están en [cómo arreglar synchronous operations are disallowed](/es/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).

**Bloquear un `ValueTask` es comportamiento indefinido, no solo lento.** Si una hoja convertida devuelve `ValueTask<T>` y algún llamador aguas arriba sigue bloqueando, `.Result` sobre él es comportamiento indefinido más que un riesgo de interbloqueo. Convierte con `.AsTask()` en esa frontera hasta que el llamador esté listo, y lee las restricciones en [qué te cuesta ValueTask](/es/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

**No uses `ConfigureAwait(false)` como sustituto de terminar.** Desactiva el interbloqueo dentro de una biblioteca que tú controlas, pero no hace nada respecto al hilo aparcado, y en ASP.NET Core no hay contexto del cual desengancharse de todos modos. Es una mitigación para código que no puedes cambiar, no una estrategia de migración.

La medida del éxito no es que el conteo del analizador llegue a cero. Es que el conteo de hilos del pool deje de trepar bajo carga, y que una solicitud cancelada ahora cancele algo de verdad.

## Relacionado

- [Fix: interbloqueo al llamar .Result o .Wait() sobre un método asíncrono en C#](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await en C#](/es/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)
- [Cómo propagar un CancellationToken a través de métodos asíncronos en .NET 11](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Cuándo async void es correcto y cuándo es una trampa en C#](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock en C#](/es/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)

## Fuentes

- [Debug ThreadPool starvation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-threadpool-starvation) -- Microsoft Learn
- [CA1849: Call async methods when in an async method](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1849) -- Microsoft Learn
- [VSTHRD002: Avoid problematic synchronous waits](https://microsoft.github.io/vs-threading/analyzers/VSTHRD002.html) -- Microsoft.VisualStudio.Threading
- [Should I expose synchronous wrappers for asynchronous methods?](https://devblogs.microsoft.com/dotnet/should-i-expose-synchronous-wrappers-for-asynchronous-methods/) -- Stephen Toub
- [CS1996: Cannot await in the body of a lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs1996) -- Microsoft Learn
- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
