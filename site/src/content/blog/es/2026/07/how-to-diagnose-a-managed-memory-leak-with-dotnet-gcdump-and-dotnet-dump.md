---
title: "Cómo diagnosticar una fuga de memoria administrada con dotnet-gcdump y dotnet-dump"
description: "Un flujo de trabajo completo para encontrar una fuga de memoria administrada en .NET 11: confirma el crecimiento con dotnet-counters, toma dos gcdumps y compáralos, y luego recolecta un dump y usa dumpheap, gcroot y objsize en dotnet-dump analyze para descubrir qué sigue reteniendo la referencia."
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "diagnostics"
  - "memory"
  - "performance"
lang: "es"
translationOf: "2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump"
translatedBy: "claude"
translationDate: 2026-07-27
---

Para diagnosticar una fuga de memoria administrada en .NET, confirma que el crecimiento es real con `dotnet-counters monitor`, captura dos instantáneas de `dotnet-gcdump collect` separadas por unos minutos para ver qué conteo de tipo está subiendo, y luego toma un `dotnet-dump collect` y ejecuta `dumpheap -stat`, `dumpheap -type <Name>` y `gcroot <address>` dentro de `dotnet-dump analyze` para encontrar la cadena de referencias que mantiene vivos a esos objetos. El gcdump te dice *qué* está creciendo con casi nada de sobrecarga; el dump te dice *quién lo está reteniendo*. Necesitas ambos, en ese orden. Este artículo usa `dotnet-gcdump` y `dotnet-dump` 10.0 sobre .NET 11 (Preview 6 al momento de escribir, GA en noviembre de 2026), pero todos los comandos que aparecen aquí son estables desde .NET Core 3.1.

## Por qué el GC no te va a salvar aquí

Una fuga de memoria administrada no es una fuga en el sentido de C. Nada queda sin liberar. El recolector de basura hace exactamente lo que se diseñó que hiciera: no va a recolectar un objeto que sea alcanzable desde una raíz, y tu código volvió alcanzables por accidente a unos cuantos cientos de miles de objetos. Una raíz es un campo estático, una variable local o un argumento vivo en la pila de algún hilo, un handle fuerte del GC, o la cola de finalización. Todo lo demás es alcanzable transitivamente desde ahí.

Eso significa que la pregunta de diagnóstico nunca es "¿por qué no corrió el GC?". Es "¿qué cadena de raíces sigue apuntando a este objeto?". Todas las herramientas de abajo existen para responder esa única pregunta. Los sospechosos clásicos en una aplicación ASP.NET Core:

- Una colección estática o singleton que solo crece: un `ConcurrentDictionary` usado como caché sin desalojo, una `List<T>` de "solicitudes recientes".
- Una suscripción a un evento de la que nunca se hace baja. El publicador retiene un delegado, el delegado retiene al suscriptor, y si el publicador es un singleton o un estático, cada suscriptor vive para siempre.
- Un servicio con ámbito capturado por un singleton, que arrastra consigo todo el grafo de objetos del ámbito. Este suele aparecer primero como [una ObjectDisposedException sobre un DbContext ya liberado](/es/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/), porque la captura también es [un error de tiempo de vida de un servicio con ámbito dentro de un singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- Un `Timer` o un `CancellationTokenSource` de larga vida cuyo callback captura un grafo de objetos grande.

## Paso 0: demuestra que realmente hay una fuga

No recolectes nada hasta que hayas visto crecer el heap administrado a lo largo del tiempo. El crecimiento del working set por sí solo no es una fuga administrada; puede ser asignación nativa, fragmentación, o simplemente que el GC no devuelve memoria al sistema operativo porque nada lo está presionando.

Instala las herramientas una sola vez y encuentra el PID:

```bash
# Verified with the .NET 11 SDK, July 2026
dotnet tool install --global dotnet-counters
dotnet tool install --global dotnet-gcdump
dotnet tool install --global dotnet-dump

dotnet-counters ps
# 4807  MyApi  /srv/myapi/MyApi
```

Luego observa el heap, no el proceso:

```bash
dotnet-counters monitor --refresh-interval 5 --process-id 4807 \
  --counters System.Runtime[dotnet.gc.last_collection.heap.size,dotnet.process.memory.working_set]
```

En .NET 9 y posteriores, `System.Runtime` es un `Meter` y los nombres de los contadores son los de estilo OpenTelemetry que se muestran arriba. En .NET 8 y anteriores, `dotnet-counters` cae de vuelta a los EventCounters antiguos y lo que buscas es `GC Heap Size (MB)`.

El número que importa es `dotnet.gc.last_collection.heap.size` desglosado por generación. Dos lecturas te dicen a qué te enfrentas:

- **gen2 subiendo de forma monótona a lo largo de las recolecciones**: una fuga administrada real. Los objetos sobreviven hasta la generación más antigua y nunca mueren. Continúa con este artículo.
- **gen0/gen1 con mucha rotación pero gen2 plano, working set alto**: no es una fuga. Eso es presión de asignación o fragmentación. En su lugar, usa [dotnet-trace con el perfil gc-verbose](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) para encontrar el punto caliente de asignación.
- **tamaño del heap plano pero working set subiendo**: la fuga es nativa. gcdump y SOS no te mostrarán nada útil. Revisa la interoperabilidad nativa, los tiempos de vida de `SafeHandle`, o el LOH que se confirma pero no se descompromete.

## Una reproducción mínima que tiene fuga

Este es el servicio ASP.NET Core más pequeño que tiene una fuga de una forma que ambas herramientas pueden encontrar. Es un singleton que se suscribe a un evento de otro singleton y nunca se da de baja:

```csharp
// .NET 11, C# 14
public sealed class TelemetryBus
{
    public event EventHandler<string>? MetricRecorded;
    public void Record(string metric) => MetricRecorded?.Invoke(this, metric);
}

public sealed class ReportSession
{
    private readonly byte[] _buffer = new byte[64 * 1024];
    private readonly List<string> _log = [];

    public ReportSession(TelemetryBus bus)
    {
        // Nothing ever removes this handler, so `bus` roots every ReportSession
        // ever created, and each one roots 64 KB plus a growing List<string>.
        bus.MetricRecorded += OnMetric;
    }

    private void OnMetric(object? sender, string metric) => _log.Add(metric);
}

app.MapPost("/reports", (TelemetryBus bus) =>
{
    _ = new ReportSession(bus);   // per-request, never released
    return Results.Accepted();
});
```

`TelemetryBus` es un singleton, así que su lista de invocación está enraizada durante toda la vida del proceso. Cada `ReportSession` es alcanzable desde ese delegado, y por lo tanto cada `byte[64*1024]` también lo es. Golpea `/reports` con carga y el heap de gen2 sube para siempre.

## El procedimiento completo

1. **Confirma que el heap administrado está creciendo** con `dotnet-counters monitor --counters System.Runtime[dotnet.gc.last_collection.heap.size]`, mirando específicamente gen2.
2. **Captura un gcdump de referencia** con `dotnet-gcdump collect --process-id <PID> --output baseline.gcdump`.
3. **Deja la aplicación corriendo bajo carga** el tiempo suficiente para que la fuga sea inequívoca, típicamente de cinco a quince minutos.
4. **Captura un segundo gcdump** con `dotnet-gcdump collect --process-id <PID> --output after.gcdump`, y compara los conteos de tipos de ambos para encontrar cuál está creciendo.
5. **Recolecta un dump completo** con `dotnet-dump collect --process-id <PID> --type Heap --output leak.dmp` una vez que sepas qué estás buscando.
6. **Ábrelo** con `dotnet-dump analyze leak.dmp` y confirma el tipo con `dumpheap -stat` o `dumpheap -type <TypeName> -stat`.
7. **Toma la dirección de una instancia** de `dumpheap -type <TypeName>` y ejecuta `gcroot <address>` para imprimir la cadena de referencias desde una raíz hasta ese objeto.
8. **Arregla la cadena**, no el objeto. El último salto antes de tu tipo en la salida de `gcroot` es lo que retiene la referencia.

## Pasos 2 a 4: gcdump, la primera mirada barata

`dotnet-gcdump` no escribe un dump del proceso. Induce una recolección de gen2, activa eventos de supervivencia del heap del GC, y reconstruye el grafo de objetos a partir del flujo de [EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe). El resultado es un archivo `.gcdump` que contiene tipos, conteos, tamaños y aristas, pero ningún valor de campo ni pilas de hilos. Suele ocupar unos pocos megabytes donde un dump completo del mismo proceso ocuparía cientos.

```bash
dotnet-gcdump collect --process-id 4807 --output baseline.gcdump
# Writing gcdump to './baseline.gcdump'...
#     Finished writing 5763432 bytes.

# ... let it run under load ...

dotnet-gcdump collect --process-id 4807 --output after.gcdump
```

No necesitas una interfaz gráfica para compararlos. El verbo `report` imprime una tabla de estadísticas del heap directamente en stdout, lo cual funciona en Linux, donde nada puede abrir un archivo `.gcdump`:

```bash
dotnet-gcdump report ./after.gcdump
#           Size (Bytes) Count       Type
#         ============== =====       ====
#          1,603,588,000 22,000,000  System.String
#            201,096,000  2,010,000  System.Byte[]
#             25,000,000    250,000  MyApi.Reports.ReportSession
```

Ejecuta `report` contra ambos archivos y compara los conteos. En Windows también puedes abrir los dos archivos `.gcdump` al mismo tiempo en Visual Studio y obtener una vista de comparación lado a lado real con una columna de diferencia, lo cual vale el viaje si tienes una máquina Windows a mano. PerfView también los lee. Actualmente no hay forma de abrir un `.gcdump` en Linux o macOS, así que ahí `dotnet-gcdump report` es tu única opción.

`report` también acepta `--process-id` directamente, lo que recolecta e imprime de una sola vez cuando no quieres el archivo:

```bash
dotnet-gcdump report --process-id 4807
```

Al final de este paso deberías tener un nombre de tipo. Eso es todo lo que gcdump te debe.

## Pasos 5 a 7: dotnet-dump, donde encuentras la raíz

Un gcdump no puede decirte qué *campo* de qué *objeto* retiene la referencia, y no puede mostrarte las pilas de hilos. Para eso necesitas un dump de verdad y SOS.

```bash
dotnet-dump collect --process-id 4807 --type Heap --output leak.dmp
```

`--type` por defecto es `Full`, que incluye las imágenes de los módulos mapeados y normalmente es mucho más grande de lo necesario. `Heap` te da listas de módulos, listas de hilos, todas las pilas, información de excepciones y handles, y toda la memoria excepto las imágenes mapeadas, que cubre todo lo de este flujo de trabajo. Usa `Mini` solo para triaje de fallos; no lleva el heap del GC.

Después abre el shell interactivo de SOS:

```bash
dotnet-dump analyze leak.dmp
```

Empieza por la vista estadística. Agrega `-live` para que se use la fase de marcado del GC y se excluyan los objetos que ya son basura pero aún no se han barrido, lo que elimina mucho ruido:

```console
> dumpheap -stat -live

Statistics:
              MT    Count    TotalSize Class Name
00007f6c1dc014c0      467       416464 System.Byte[]
00007f6c20a67498   250000     16000000 MyApi.Reports.ReportSession
00007f6c1dc00f90   206770     19494060 System.String
```

Variantes útiles del mismo comando:

- `dumpheap -stat -bycount` ordena por conteo de instancias en lugar de por tamaño total, lo que saca a la luz fugas del tipo "un millón de objetos diminutos" que los totales en bytes esconden.
- `dumpheap -type MyApi.Reports -stat` filtra por una subcadena del nombre del tipo, así puedes acotar la tabla a un espacio de nombres e ignorar el ruido del framework.
- `dumpheap -gen loh -stat` se restringe al heap de objetos grandes. Acepta `gen0`, `gen1`, `gen2`, `loh`, `poh` y `foh`.
- `dumpheap -min 100000 -stat` ignora todo lo que esté por debajo de 100 000 bytes.

Ahora consigue una dirección concreta y busca su raíz:

```console
> dumpheap -type MyApi.Reports.ReportSession
         Address               MT     Size
00007f6ad09421f8 00007f6c20a67498       32
...

> gcroot 00007f6ad09421f8

HandleTable:
    00007F6C98BB15F8 (pinned handle)
    -> 00007F6BDFFFF038 System.Object[]
    -> 00007F69D0033570 MyApi.Telemetry.TelemetryBus
    -> 00007F69D0033588 System.EventHandler`1[[System.String, System.Private.CoreLib]]
    -> 00007F69D00335A0 System.Object[]
    -> 00007F6AD0942258 MyApi.Reports.ReportSession

Found 1 root.
```

Lee esa cadena de abajo hacia arriba. El objeto que tiene la fuga está abajo; la raíz está arriba. El salto inmediatamente encima de tu tipo es el culpable, y aquí es inconfundible: un delegado multicast `EventHandler<string>` cuya lista de invocación (`System.Object[]`) retiene todas las sesiones. Eso se corresponde directamente con la línea `bus.MetricRecorded += OnMetric` sin un `-=` que la compense.

`gcroot` imprime solo raíces únicas por defecto. Pasa `-all` cuando quieras todos los caminos, y `-nostacks` para restringir la búsqueda a handles y objetos alcanzables cuando el escaneo de pilas produce falsos positivos por registros obsoletos.

Dos comandos más que vale la pena conocer en este punto. `objsize <address>` reporta el tamaño retenido de un objeto incluyendo todo lo que retiene transitivamente, que es como conviertes "esta cosa mide 32 bytes" en "esta cosa mantiene vivos 68 KB". Y `dumpobj <address>` imprime la disposición campo por campo para que puedas confirmar cuál campo del retenedor es el que apunta hacia ti:

```console
> dumpobj 00007F69D0033570
Name:        MyApi.Telemetry.TelemetryBus
MethodTable: 00007f6c20a67498
Size:        24(0x18) bytes
Fields:
              MT    Field   Offset                 Type VT     Attr            Value Name
00007f6c1dc00f90  4000001        8 ...EventHandler`1  0 instance 00007F69D0033588 MetricRecorded
```

## Trampas que le cuestan una tarde a mucha gente

**gcdump dispara una recolección de gen2 completa y bloqueante.** Así es como recorre el heap. En un proceso con un heap grande esto puede suspender el runtime por bastante tiempo. No lo ejecutes en un bucle cerrado contra una instancia de producción sensible a la latencia, y espera un pico de pausa visible en tus métricas cuando sí lo ejecutes.

**gcdump puede fallar en silencio con un heap enorme.** El búfer de eventos es propiedad de la aplicación objetivo y puede crecer hasta 256 MB. Si el heap es lo bastante grande como para que se descarten eventos, obtienes `System.ApplicationException: ETL file shows the start of a heap dump but not its completion`, o un `.gcdump` que contiene calladamente solo una parte del heap. Cuando eso pase, sáltate gcdump y ve directo a `dotnet-dump collect`.

**Ambas herramientas necesitan el mismo usuario y el mismo `TMPDIR`.** En Linux y macOS, `--process-id` y `--name` funcionan conectándose a un socket de dominio Unix que el runtime crea bajo `TMPDIR`. Si tu herramienta corre como otro usuario, o bajo un `TMPDIR` distinto, el comando simplemente agota su tiempo de espera tras 30 segundos sin ningún error útil. Ejecútalo como el mismo usuario que el proceso objetivo o como root.

**En contenedores necesitas `ptrace`.** `dotnet-dump collect` requiere capacidades de `ptrace`, que suelen concederse con `--cap-add=SYS_PTRACE`. Por separado, recolectar un dump de heap o completo obliga al sistema operativo a paginar mucha memoria virtual del proceso objetivo, lo que puede empujar a un contenedor con límite de memoria más allá de su límite de cgroup y hacer que el OOM killer lo mate a mitad de la recolección. Sube o quita temporalmente el límite si tu plataforma lo permite.

**Las filas `Free` no son objetos.** Un conteo alto de `Free` en `dumpheap -stat` significa fragmentación, no una fuga. Es espacio entre objetos vivos que el GC no ha compactado, típicamente en el LOH. Problema distinto, solución distinta (pooling, `ArrayPool<T>`, o `GCSettings.LargeObjectHeapCompactionMode`).

**Las fugas con forma de caché pueden ser un error de configuración, no de código.** Si el tipo que crece es un DTO tuyo sentado dentro de un `IMemoryCache`, la "fuga" normalmente es un límite de tamaño o una política de expiración que falta, más que una referencia rebelde. Esa decisión pertenece a [la comparativa entre HybridCache, IMemoryCache e IDistributedCache](/es/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) y no a un depurador.

**Revisa la cola de finalización antes de culpar a tu código.** `finalizequeue` en el shell de análisis lista los objetos registrados para finalización. Una cola atascada significa que objetos finalizables están siendo promovidos a gen2 y retenidos por un ciclo de recolección extra, lo cual se ve exactamente igual que una fuga lenta en una gráfica. Ahí la solución casi siempre es liberar de forma determinista, que es justo para lo que sirve [implementar IAsyncDisposable y usar await using](/es/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/).

**Las máquinas de estado asíncronas esconden sus propias raíces.** Si los tipos que crecen son estructuras generadas por el compilador tipo `<SomeMethod>d__12`, usa `dumpasync -roots` en lugar de `gcroot`. Entiende las cadenas de continuación y te mostrará qué tarea en espera está reteniendo la máquina, algo que un recorrido crudo de `gcroot` presenta como una pila ilegible de objetos `Task` y `Action`.

## Qué hacer con la respuesta

Una vez que `gcroot` nombra al retenedor, la solución es código común y corriente. Da de baja la suscripción en un `Dispose`. Ponle un límite de tamaño y una expiración a la caché. Deja de capturar un servicio con ámbito dentro de un singleton y, en su lugar, [crea un ámbito por unidad de trabajo dentro del BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/). Después repite los pasos 1 a 4: corre bajo carga, toma dos gcdumps y confirma que el conteo del tipo está plano. Una fuga solo está arreglada cuando el segundo gcdump lo demuestra.

Fuentes: [referencia de dotnet-gcdump](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-gcdump), [referencia de dotnet-dump](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dump), [tutorial de depuración de una fuga de memoria](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-memory-leak), [extensión de depuración SOS](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/sos-debugging-extension) y [referencia de dotnet-counters](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-counters).
