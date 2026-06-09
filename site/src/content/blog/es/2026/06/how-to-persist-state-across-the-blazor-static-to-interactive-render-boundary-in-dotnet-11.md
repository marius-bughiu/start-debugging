---
title: "Cómo persistir el estado a través del límite de renderizado estático-a-interactivo de Blazor en .NET 11"
description: "Un componente Blazor prerenderizado ejecuta su inicialización dos veces y pierde el estado en el traspaso a interactivo. Resuélvelo con el atributo [PersistentState] o el servicio PersistentComponentState en .NET 11."
pubDate: 2026-06-09
template: how-to
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "ssr"
lang: "es"
translationOf: "2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-09
---

Un componente Blazor sobre la plantilla Blazor Web App ejecuta su inicialización dos veces: una durante el prerenderizado (renderizado estático del lado del servidor) y otra cuando el componente se renderiza de forma interactiva. Todo lo que hayas obtenido o calculado en `OnInitializedAsync` la primera vez desaparece para la segunda, así que el componente vuelve a obtener los datos y el usuario ve cómo parpadea la UI prerenderizada al ser reemplazada. La solución es capturar ese estado durante el prerenderizado y pasarlo al otro lado del límite. En .NET 11 tienes dos formas de hacerlo: el atributo declarativo `[PersistentState]` (la vía fácil, disponible desde .NET 10) y el servicio imperativo `PersistentComponentState` (disponible desde .NET 8, para todo lo que el atributo no pueda expresar). Esta publicación apunta a .NET 11 (en versión preliminar al momento de escribir, con GA programada para noviembre de 2026) y al conjunto de paquetes `Microsoft.AspNetCore.Components` 11.0.x.

## Por qué el componente se inicializa dos veces

La plantilla Blazor Web App renderiza una página en dos pasadas. La primera pasada es el prerenderizado: el servidor ejecuta tu componente como HTML estático, ejecuta `OnInitialized` / `OnInitializedAsync` y envía el marcado resultante para que la página se pinte rápido y se indexe bien. La segunda pasada es la interactividad: una vez que el runtime arranca (un circuito SignalR para `InteractiveServer`, la carga WASM descargada para `InteractiveWebAssembly`, o cualquiera de los dos para `InteractiveAuto`), Blazor instancia una copia nueva del componente y ejecuta la inicialización por segunda vez.

Esa segunda instancia no hereda ningún campo que hayas establecido durante el prerenderizado. Arranca desde los valores por defecto. Si tu inicialización se veía así:

```razor
@* PrerenderedCounter1.razor *@
@* .NET 11, Blazor Web App, any interactive render mode *@
@page "/prerendered-counter-1"
@inject ILogger<PrerenderedCounter1> Logger

<p role="status">Current count: @currentCount</p>

@code {
    private int currentCount;

    protected override void OnInitialized()
    {
        currentCount = Random.Shared.Next(100);
        Logger.LogInformation("currentCount set to {Count}", currentCount);
    }
}
```

verás `currentCount set to 41` durante el prerenderizado y `currentCount set to 92` un momento después, cuando el componente se vuelve interactivo, con un salto visible de 41 a 92 en el navegador. Con un número aleatorio es solo una curiosidad. Con una llamada a la base de datos es una consulta duplicada, un tiempo hasta interactivo más lento y un parpadeo real entre el valor prerenderizado y el reobtenido.

Esto es específicamente el límite de prerenderizado-a-interactivo. Si tu componente `Routes` no tiene un render mode y llegas a la página a través de una [navegación mejorada](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing) interna, el prerenderizado no ocurre en absoluto, así que la inicialización se ejecuta una vez y no hay nada que persistir. Para reproducir la doble inicialización necesitas una carga completa de la página.

## La solución declarativa: el atributo `[PersistentState]`

La forma más limpia de llevar el estado al otro lado del límite en .NET 11 es ponerlo en una propiedad pública y anotarla con `[PersistentState]`. Blazor serializa la propiedad dentro del HTML prerenderizado y luego la deserializa de vuelta en la instancia interactiva antes de la inicialización. Tu trabajo es solo detectar si el valor fue restaurado:

```razor
@* PrerenderedCounter2.razor *@
@* .NET 11 / .NET 10. [PersistentState] requires aspnetcore 10.0+ *@
@page "/prerendered-counter-2"
@inject ILogger<PrerenderedCounter2> Logger

<p role="status">Current count: @CurrentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int? CurrentCount { get; set; }

    protected override void OnInitialized()
    {
        if (CurrentCount is null)
        {
            CurrentCount = Random.Shared.Next(100);
            Logger.LogInformation("CurrentCount set to {Count}", CurrentCount);
        }
        else
        {
            Logger.LogInformation("CurrentCount restored to {Count}", CurrentCount);
        }
    }

    private void IncrementCount() => CurrentCount++;
}
```

Ahora el registro dice `CurrentCount set to 96` durante el prerenderizado y `CurrentCount restored to 96` cuando entra la interactividad. El mismo valor, sin un segundo `Random.Shared.Next`, sin parpadeo.

Tres reglas hacen que esto funcione y son fáciles de pasar por alto:

1. **La propiedad debe ser `public`.** El framework usa reflexión sobre ella para la serialización, el análisis de trimming y la generación de código fuente. Un campo `private` con el atributo no será detectado.
2. **Usa un tipo anulable o cuyo valor por defecto sea detectable.** Necesitas distinguir "restaurado" de "nunca establecido". Un tipo anulable (`int?`, `WeatherForecast[]?`) es la señal idiomática. Para tipos de referencia, `null` significa que el prerenderizado debe poblarlo.
3. **Pobla solo cuando sea null.** La guarda `if (CurrentCount is null)` es lo que mantiene el trabajo costoso en la pasada de prerenderizado y lo omite en la pasada interactiva.

La versión realista es una carga de datos. Obtén en el prerenderizado, reutiliza en el interactivo:

```razor
@* ContactList.razor -- .NET 11, InteractiveAuto render mode *@
@page "/contacts"
@inject IContactService Contacts

@if (Items is null)
{
    <p>Loading...</p>
}
else
{
    <ul>@foreach (var c in Items) { <li>@c.Name</li> }</ul>
}

@code {
    [PersistentState]
    public IReadOnlyList<Contact>? Items { get; set; }

    protected override async Task OnInitializedAsync()
    {
        // Runs the query on the prerender pass; the interactive pass
        // gets Items back already populated and skips the call.
        Items ??= await Contacts.GetAllAsync();
    }
}
```

### Mantener el estado asociado a la instancia correcta

Cuando una página renderiza varios componentes del mismo tipo en un bucle, el estado persistido tiene que volver a asociarse con la instancia correcta. Usa la directiva `@key` para que Blazor pueda alinear los blobs serializados con el componente adecuado:

```razor
@* Parent.razor -- .NET 11 *@
@page "/parent"

@foreach (var element in elements)
{
    <PersistentChild @key="element.Name" />
}
```

Dentro de `PersistentChild`, la propiedad `[PersistentState]` se restaura por clave. Sin `@key`, dos instancias pueden acabar intercambiando o perdiendo su estado.

### Datos de solo lectura y navegación mejorada

Por defecto, el estado persistido se carga solo cuando un componente interactivo aparece por primera vez en la página. Eso es deliberado: evita que una navegación mejorada posterior a la misma página pisotee estado en vivo, como un formulario a medio editar. Si tu estado es de solo lectura y es barato equivocarse con él por un momento (datos en caché que rara vez cambian), opta por las actualizaciones durante la navegación mejorada con `AllowUpdates`:

```csharp
// .NET 11 -- allow the value to refresh on enhanced navigation
[PersistentState(AllowUpdates = true)]
public WeatherForecast[]? Forecasts { get; set; }

protected override async Task OnInitializedAsync()
{
    Forecasts ??= await ForecastService.GetForecastAsync();
}
```

Ten en cuenta que la persistencia a través de navegaciones mejoradas es una capacidad de .NET 10+. En .NET 8 y .NET 9, el servicio `PersistentComponentState` solo entregaba estado en la carga inicial de la página, nunca a través de una navegación mejorada sobre un circuito ya en ejecución. Si dependes de ese comportamiento, .NET 11 es donde funciona limpiamente.

### Omitir la restauración en situaciones específicas

.NET 10 añadió un segundo trabajo a `[PersistentState]`: persistir el estado cuando un circuito `InteractiveServer` es desalojado y restaurarlo al reconectar, de modo que una conexión caída ya no borre el estado del componente. Eso introduce dos casos en los que puedes querer renunciar a una restauración. `RestoreBehavior` los controla:

```csharp
// Do not restore the prerendered value (start fresh on interactivity)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipInitialValue)]
public string? NoPrerenderedData { get; set; }

// Do not restore the last snapshot on reconnection (force fresh data after a reconnect)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipLastSnapshot)]
public int CounterNotRestoredOnReconnect { get; set; }
```

## La solución imperativa: el servicio `PersistentComponentState`

El atributo cubre la mayoría de los casos, pero a veces necesitas persistir algo que no es una sola propiedad: un valor derivado de varios campos, una clave que calculas en tiempo de ejecución, o estado que solo persistes bajo ciertas condiciones. Inyecta el servicio `PersistentComponentState` y registra un callback. Este es el mecanismo original de .NET 8 y sigue funcionando en .NET 11 exactamente igual que antes:

```razor
@* PrerenderedCounter3.razor -- .NET 11, PersistentComponentState service *@
@page "/prerendered-counter-3"
@implements IDisposable
@inject ILogger<PrerenderedCounter3> Logger
@inject PersistentComponentState ApplicationState

<p role="status">Current count: @currentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    private int currentCount;
    private PersistingComponentStateSubscription persistingSubscription;

    protected override void OnInitialized()
    {
        if (!ApplicationState.TryTakeFromJson<int>(
            nameof(currentCount), out var restoredCount))
        {
            currentCount = Random.Shared.Next(100);
            Logger.LogInformation("currentCount set to {Count}", currentCount);
        }
        else
        {
            currentCount = restoredCount!;
            Logger.LogInformation("currentCount restored to {Count}", currentCount);
        }

        // Register LAST to avoid a race condition at app shutdown.
        persistingSubscription = ApplicationState.RegisterOnPersisting(PersistCount);
    }

    private Task PersistCount()
    {
        ApplicationState.PersistAsJson(nameof(currentCount), currentCount);
        return Task.CompletedTask;
    }

    private void IncrementCount() => currentCount++;

    void IDisposable.Dispose() => persistingSubscription.Dispose();
}
```

La forma es siempre la misma:

1. `TryTakeFromJson<T>("key", out var value)` primero. Si devuelve `true`, estás en la pasada interactiva y el valor fue restaurado. Si es `false`, estás en la pasada de prerenderizado y necesitas producir el valor.
2. Registra un callback de persistencia con `RegisterOnPersisting` y dentro de él llama a `PersistAsJson("key", value)`. Regístralo al **final** de la inicialización para evitar una condición de carrera durante el apagado de la aplicación.
3. Libera la `PersistingComponentStateSubscription` para que el callback no provoque una fuga. Implementar `IDisposable` no es opcional aquí.

Si necesitas controlar la restauración de forma imperativa igual que `RegisterOnPersisting` controla la persistencia, .NET 10 añadió `RegisterOnRestoring`, que te permite engancharte al paso de restauración. Eso encaja de forma natural con los escenarios de reconexión de circuito anteriores.

## Persistir estado que vive en un servicio, no en un componente

El estado no siempre pertenece a un componente. Si un servicio de DI con ámbito (scoped) contiene los datos, también puedes persistir sus propiedades. Marca la propiedad con `[PersistentState]` y registra el servicio para persistencia con `RegisterPersistentService`, indicando a Blazor a qué render mode aplica (el render mode no se puede inferir del tipo de servicio):

```csharp
// CounterTracker.cs -- .NET 11
public class CounterTracker
{
    [PersistentState]
    public int CurrentCount { get; set; }

    public void IncrementCount() => CurrentCount++;
}
```

```csharp
// Program.cs -- .NET 11
using Microsoft.AspNetCore.Components.Web;

builder.Services.AddScoped<CounterTracker>();

builder.Services.AddRazorComponents()
    .RegisterPersistentService<CounterTracker>(RenderMode.InteractiveAuto);
```

Solo se admiten servicios con ámbito (scoped). El argumento de render mode (`RenderMode.Server`, `RenderMode.Webassembly` o `RenderMode.InteractiveAuto`) decide qué contextos interactivos reciben el estado deserializado. Como la serialización funciona a partir de la instancia real, puedes marcar una abstracción como el servicio persistente y mantener la implementación concreta como internal, lo cual es útil cuando el servidor de prerenderizado y el cliente WebAssembly comparten una interfaz pero no la implementación.

## Qué viaja por la red y la línea de seguridad que no puedes cruzar

El estado persistido se incrusta en el HTML y se transfiere al cliente. Dónde aterriza depende del render mode, y este es el único error que convierte una comodidad en una fuga:

- **`InteractiveServer`**: el estado va y vuelve a través del navegador pero está protegido por [ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/introduction), así que está cifrado en tránsito.
- **`InteractiveWebAssembly` e `InteractiveAuto`**: el estado se expone al navegador en claro, porque el código WebAssembly se ejecuta en el cliente y necesita leerlo. El modo `Auto` puede resolverse a WebAssembly, así que trátalo como el caso CSR.

La regla: nunca pongas nada privado en el estado persistido de un componente WebAssembly o Auto. Persiste la lista de contactos, no el token de acceso. Si necesitas secretos solo de servidor, mantenlos en el servidor y obténlos después de la interactividad, o quédate en `InteractiveServer`.

## Serialización, trimming y Native AOT

Por defecto, `[PersistentState]` y `PersistAsJson` serializan con `System.Text.Json` usando la configuración por defecto. Eso tiene dos consecuencias que conviene planificar.

Primero, el serializador por defecto no es seguro frente al trimming. Si publicas con trimming de IL o [Native AOT](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/), debes preservar los tipos que persistes o el ida y vuelta fallará en tiempo de ejecución una vez que se recorten los metadatos. Configura un generador de código fuente `JsonSerializerContext` para tus tipos persistidos, la misma disciplina que aplicarías al [escribir un JsonConverter personalizado para System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

Segundo, si la forma JSON por defecto no te conviene (un formato binario compacto, una codificación heredada, un tipo que System.Text.Json maneja con torpeza), .NET 10 introdujo `PersistentComponentStateSerializer<T>` para que puedas tomar el control de la serialización de un tipo específico:

```csharp
// Registered in Program.cs; applies to int? persisted state
builder.Services.AddSingleton<PersistentComponentStateSerializer<int?>,
    CustomIntSerializer>();
```

El serializador implementa `Persist(T value, IBufferWriter<byte> writer)` y `Restore(ReadOnlySequence<byte> data)`. Sin un serializador personalizado registrado para un tipo, Blazor recurre a JSON, así que solo implementas esto para los tipos que lo necesitan.

## Componentes incrustados en Razor Pages o MVC

Un detalle que no aplica a la plantilla Blazor Web App pero que pilla a la gente cuando incrusta Blazor en una aplicación existente: si dejas componentes interactivos dentro de una vista de Razor Pages o MVC, el mecanismo de persistencia necesita que se añada a mano el tag helper. Pon `<persist-component-state />` justo antes del `</body>` de cierre en tu layout:

```cshtml
@* Pages/Shared/_Layout.cshtml -- only needed for Razor Pages / MVC hosts *@
<body>
    ...
    <persist-component-state />
</body>
```

Los proyectos Blazor Web App puros conectan esto automáticamente; solo necesitas el tag helper en el caso de hosting mixto.

## Cómo elegir entre los dos modelos

Recurre primero a `[PersistentState]`. Es menos código, maneja el límite de prerenderizado y la reconexión de circuito de forma gratuita, y `AllowUpdates` más `RestoreBehavior` cubren las variaciones comunes de forma declarativa. Baja al servicio `PersistentComponentState` cuando la unidad de estado no sea una sola propiedad pública, cuando calcules la clave de persistencia en tiempo de ejecución, o cuando necesites persistir condicionalmente dentro del callback. Ambos pueden coexistir en la misma aplicación, y ambos resuelven el mismo problema subyacente: asegurarse de que el trabajo que hiciste durante el prerenderizado sobreviva al salto a la interactividad en lugar de ejecutarse de nuevo.

Si todavía estás decidiendo qué render modes deberían usar tus páginas, los compromisos en [Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) enmarcan dónde se aplica siquiera el prerenderizado, y si estás moviendo una aplicación más antigua a este modelo, la [lista de verificación de migración de Blazor Server a Blazor Web App](/es/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) señala la doble ejecución del prerenderizado como lo único que pilla. Para pasar mensajes de una sola vez en lugar de persistir el estado de renderizado, [el soporte de TempData en Blazor SSR en .NET 11](/es/2026/04/blazor-ssr-tempdata-dotnet-11/) es la herramienta adecuada en su lugar.

Fuente primaria: [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0) en Microsoft Learn, que documenta el atributo `[PersistentState]`, el servicio `PersistentComponentState`, `RegisterPersistentService` y el punto de extensibilidad `PersistentComponentStateSerializer<T>` para .NET 10 y .NET 11.
