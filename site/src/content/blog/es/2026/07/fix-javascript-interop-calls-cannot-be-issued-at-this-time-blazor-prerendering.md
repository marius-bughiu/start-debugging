---
title: "Solución: JavaScript interop calls cannot be issued at this time (prerenderizado de Blazor)"
description: "El prerenderizado ejecuta tu componente en el servidor sin navegador, así que IJSRuntime lanza una excepción. Mueve la llamada a OnAfterRenderAsync, condiciónala con RendererInfo.IsInteractive o desactiva el prerenderizado."
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
lang: "es"
translationOf: "2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering"
translatedBy: "claude"
translationDate: 2026-07-30
---

La solución: llamaste a `IJSRuntime` desde `OnInitialized`, `OnInitializedAsync`, `OnParametersSet{Async}` o el constructor de un componente, y ese código se ejecutó durante el prerenderizado, cuando no hay ningún navegador conectado para ejecutar JavaScript. Mueve la llamada a `OnAfterRenderAsync(bool firstRender)` protegida por `if (firstRender)`, que nunca se ejecuta durante el prerenderizado. Si necesitas bifurcar antes del primer renderizado interactivo, consulta `RendererInfo.IsInteractive` (.NET 9 y posteriores). Si el componente realmente no puede funcionar sin JavaScript, desactiva el prerenderizado para ese componente con `@rendermode @(new InteractiveServerRenderMode(prerender: false))`.

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued at this time.
This is because the component is being statically rendered. When prerendering is enabled,
JavaScript interop calls can only be performed during the OnAfterRenderAsync lifecycle method.
   at Microsoft.AspNetCore.Components.Server.Circuits.RemoteJSRuntime.BeginInvokeJS(...)
   at Microsoft.JSInterop.JSRuntime.InvokeAsync[TValue](String identifier, Object[] args)
   at BlazorSample.Components.Pages.Theme.OnInitializedAsync()
```

Este artículo apunta a .NET 11 (ASP.NET Core 11, `Microsoft.AspNetCore.Components` 11.0.x), pero el comportamiento no ha cambiado desde que se lanzó el prerenderizado y las recomendaciones también aplican a .NET 8, 9 y 10. La única excepción es `RendererInfo`, que llegó en .NET 9.

## Dos cadenas de error, dos renderizadores

El tráfico de búsqueda para este problema llega a dos mensajes distintos, y saber cuál obtuviste te dice qué modelo de hospedaje lo lanzó.

El mensaje citado arriba viene de `RemoteJSRuntime`, en la pila del circuito de Blazor Server. Se lanza cuando el proxy de cliente del runtime es null, lo que significa que el componente se está ejecutando fuera de un circuito SignalR activo. En una app clásica de Blazor Server con `render-mode="ServerPrerendered"`, este es el mensaje que ves.

El segundo mensaje viene de un tipo completamente distinto:

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued during
server-side static rendering, because the page has not yet loaded in the browser.
Statically-rendered components must wrap any JavaScript interop calls in conditional
logic to ensure those interop calls are not attempted during static rendering.
   at Microsoft.AspNetCore.Components.Endpoints.UnsupportedJavaScriptRuntime.Microsoft.JSInterop.IJSRuntime.InvokeAsync[TValue](...)
```

`UnsupportedJavaScriptRuntime` es un `IJSRuntime` interno y sellado que el renderizador de endpoints registra para el renderizado estático del lado del servidor. Todos sus métodos lanzan excepciones. En una Blazor Web App (la plantilla de .NET 8 y posteriores), tanto el prerenderizado como el SSR estático pasan por el renderizador de endpoints, así que este es el mensaje que obtienes para una página sin ningún render mode, y para la pasada de prerenderizado de un componente `InteractiveWebAssembly` o `InteractiveAuto`.

Ambos son `InvalidOperationException`, ambos tienen la misma causa raíz y ambos tienen el mismo conjunto de soluciones. Si ves `UnsupportedJavaScriptRuntime` en la traza de pila, fíjate en la redacción: "must wrap any JavaScript interop calls in conditional logic". Esa frase importa, y es la trampa que se cubre más adelante en este artículo.

## Por qué el prerenderizado no tiene navegador al que llamar

El prerenderizado es el proceso de renderizar el contenido de la página estáticamente en el servidor para que el HTML llegue al navegador lo más rápido posible. El árbol de componentes se ejecuta por completo, produce markup, se escribe en la respuesta HTTP y se descarta. Solo después arranca el script de Blazor en el navegador, abre un circuito (para `InteractiveServer`) o descarga el runtime (para `InteractiveWebAssembly`), y vuelve a instanciar el componente de forma interactiva.

Durante esa primera pasada no hay DOM, ni `window`, ni transporte por el que enviar un mensaje de JS interop. `IJSRuntime` sigue siendo inyectable, porque el servicio está registrado y el componente compila sin problemas, pero la implementación detrás de él o no tiene proxy de cliente o es un marcador de posición cuyo único trabajo es lanzar un mensaje útil. Por eso este es un error en tiempo de ejecución y nunca en tiempo de compilación.

La documentación del ciclo de vida es explícita sobre la consecuencia: `OnAfterRender` y `OnAfterRenderAsync` "aren't invoked during prerendering or static server-side rendering (static SSR) on the server because those processes aren't attached to a live browser DOM and are already complete before the DOM is updated". Esa propiedad es justamente lo que convierte a `OnAfterRenderAsync` en el lugar seguro para el interop.

Ten en cuenta también que `OnInitializedAsync` se ejecuta dos veces en un componente prerenderizado: una vez durante la pasada estática y otra cuando el componente pasa a ser interactivo. Todo lo que obtengas ahí se calcula dos veces. Ese es un problema distinto con una solución distinta, cubierto en [cómo persistir el estado a través del límite de renderizado estático-a-interactivo de Blazor](/es/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

## Reproducción mínima

Pon esto en una Blazor Web App creada con la plantilla de .NET 11 con un render mode interactivo global o por página. Falla en la primera solicitud, siempre.

```razor
@* Theme.razor *@
@* .NET 11, Microsoft.AspNetCore.Components 11.0.0, Blazor Web App *@
@page "/theme"
@rendermode InteractiveServer
@inject IJSRuntime JS

<p>Stored theme: @theme</p>

@code {
    private string? theme;

    protected override async Task OnInitializedAsync()
    {
        // Throws during the prerender pass: no browser, no localStorage.
        theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
    }
}
```

El mismo código con `@rendermode InteractiveWebAssembly` lanza en su lugar la variante de `UnsupportedJavaScriptRuntime`, porque la pasada de prerenderizado ocurre en el renderizador de endpoints del servidor y no en un circuito. Quita la línea `@rendermode` por completo y también obtienes la variante de `UnsupportedJavaScriptRuntime`, de forma permanente, porque ahora la página es SSR estático y nunca se vuelve interactiva.

## Solución 1: mueve la llamada a `OnAfterRenderAsync`

Esta es la solución recomendada y a la que apunta el propio mensaje de error del framework. `OnAfterRenderAsync` solo se llama después de que el componente se haya renderizado de forma interactiva con un DOM activo, así que el interop siempre es legal ahí.

```razor
@* Theme.razor *@
@* .NET 11, Microsoft.AspNetCore.Components 11.0.0 *@
@page "/theme"
@rendermode InteractiveServer
@inject IJSRuntime JS

<p>Stored theme: @(theme ?? "loading...")</p>

@code {
    private string? theme;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
            StateHasChanged();
        }
    }
}
```

Dos detalles con los que la gente tropieza:

La protección `if (firstRender)` no es higiene opcional. Sin ella vuelves a ejecutar el interop en cada renderizado y, como `StateHasChanged` dispara un renderizado, obtienes un bucle infinito.

El `StateHasChanged()` explícito es obligatorio. A diferencia de los demás métodos del ciclo de vida, el framework deliberadamente no programa un nuevo renderizado cuando se completa la `Task` devuelta por `OnAfterRenderAsync`, precisamente para evitar ese bucle infinito. Si asignas un campo y no llamas a `StateHasChanged`, la interfaz nunca se actualiza y el bug parece "mi interop devuelve null".

Diseña el markup para que la salida prerenderizada tenga sentido sin el resultado de JavaScript. El usuario ve esa primera pasada. Un placeholder, un esqueleto o un valor por defecto razonable es mejor que un elemento vacío que aparece de golpe un instante después.

## Solución 2: condiciona con `RendererInfo.IsInteractive`

A veces necesitas bifurcar antes del primer renderizado interactivo, por ejemplo para decidir qué renderizar en lugar de qué obtener. `ComponentBase.RendererInfo` (.NET 9 y posteriores) expone exactamente eso:

- `RendererInfo.Name` devuelve `Static`, `Server`, `WebAssembly` o `WebView`.
- `RendererInfo.IsInteractive` es `true` cuando el renderizado es interactivo y `false` durante el prerenderizado o el SSR estático.
- `ComponentBase.AssignedRenderMode` devuelve el render mode asignado al componente, o `null` cuando no tiene ninguno.

```razor
@* ThemeAware.razor *@
@* .NET 11 / .NET 10 / .NET 9. RendererInfo requires aspnetcore 9.0+ *@
@page "/theme-aware"
@rendermode InteractiveServer
@inject IJSRuntime JS

@if (!RendererInfo.IsInteractive)
{
    <p>Loading preferences...</p>
}
else
{
    <p>Stored theme: @theme</p>
}

@code {
    private string? theme;

    protected override async Task OnInitializedAsync()
    {
        if (RendererInfo.IsInteractive)
        {
            theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
        }
    }
}
```

Esta es la "conditional logic" que pide el mensaje de `UnsupportedJavaScriptRuntime`. También es la herramienta adecuada para un componente que debe renderizar markup estático usable, por ejemplo un formulario que se envía normalmente cuando `AssignedRenderMode is null` y usa un manejador de eventos cuando no lo es.

En .NET 8, donde `RendererInfo` no existe, el equivalente más cercano para detectar la pasada de prerenderizado es un `[CascadingParameter] public HttpContext? HttpContext { get; set; }` en el componente: solo es distinto de null durante el renderizado del lado del servidor. Funciona, pero acopla el componente a tipos de hospedaje de ASP.NET Core, así que prefiere `RendererInfo` si puedes apuntar a .NET 9 o posterior.

## Solución 3: desactiva el prerenderizado para el componente

Si un componente no tiene sentido sin JavaScript (un envoltorio de gráficos, un mapa, un editor de texto enriquecido), el prerenderizado solo te compra un destello de markup roto. Desactívalo en la definición del componente:

```razor
@* MapView.razor *@
@* .NET 11. prerender: false is valid on all three interactive render modes *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

O en el punto de uso:

```razor
@* .NET 11 *@
<MapView @rendermode="new InteractiveWebAssemblyRenderMode(prerender: false)" />
```

Para desactivarlo en toda la app, asigna el modo al componente `Routes` en `App.razor`, y recuerda hacer lo mismo con `HeadOutlet`:

```razor
@* App.razor, .NET 11 Blazor Web App template *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
<HeadOutlet @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Una regla que pilla a mucha gente: desactivar el prerenderizado solo surte efecto para los render modes de nivel superior. Si un componente padre ya especifica un render mode, la configuración de prerenderizado de sus hijos se ignora. Esa es la misma restricción de "un subárbol, un render mode" que está detrás [del error el render mode no es compatible con el render mode del componente padre](/es/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/). Recurre a `prerender: false` solo cuando seas dueño del límite, y trátalo como último recurso: estás renunciando al primer pintado rápido y al beneficio de SEO por el que existe el prerenderizado.

## La trampa: `OnAfterRenderAsync` nunca se ejecuta en una página con SSR estático

Esta es la razón más común de "lo moví a `OnAfterRenderAsync` y sigue sin funcionar".

`OnAfterRender{Async}` no se llama durante el prerenderizado *ni* durante el SSR estático. En un componente interactivo prerenderizado eso está bien, porque el componente se vuelve a crear de forma interactiva un instante después y el método se dispara entonces. Pero en una página **sin** render mode, el componente solo se renderiza estáticamente. No hay segunda pasada. `OnAfterRenderAsync` nunca se invoca, tu interop simplemente nunca ocurre y el síntoma pasa de una excepción ruidosa a una funcionalidad muerta.

Si el interop dejó de lanzar excepciones pero también dejó de ejecutarse, comprueba que el componente realmente tenga un render mode interactivo, ya sea directamente, heredado de un padre o aplicado globalmente en `Routes`. `AssignedRenderMode is null` dentro del componente es una confirmación de una línea de que estás en SSR estático. Qué modelo de hospedaje deberías asignar es una decisión aparte, expuesta en [Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## La tercera variante: "the circuit has disconnected and is being disposed"

Hay un tercer mensaje con las mismas palabras iniciales, y es un bug distinto con una solución distinta:

```text
Microsoft.JSInterop.JSDisconnectedException: JavaScript interop calls cannot be issued
at this time. This is because the circuit has disconnected and is being disposed.
```

Fíjate en el tipo de excepción: `JSDisconnectedException`, no `InvalidOperationException`. Esto no tiene nada que ver con el prerenderizado. Ocurre en el otro extremo de la vida del componente, en apps del lado del servidor, cuando llamas a JS (o liberas un `IJSObjectReference`) después de que el circuito SignalR haya desaparecido, típicamente desde `DisposeAsync` mientras el usuario navega a otra página o recarga. La solución es capturarla:

```csharp
// .NET 11, server-side Blazor. Disposing a JS module after the circuit is gone.
async ValueTask IAsyncDisposable.DisposeAsync()
{
    try
    {
        if (module is not null)
        {
            await module.DisposeAsync();
        }
    }
    catch (JSDisconnectedException)
    {
    }
}
```

En un componente de WebAssembly no hay circuito que perder, así que elimina el `try`/`catch` y libera el módulo sin más. Y si necesitas ejecutar limpieza real en el navegador después de que se pierda la conexión, JS interop es la herramienta equivocada: usa el patrón `MutationObserver` o el `disconnectedCallback` de un custom element en el cliente.

## Trampas que producen la misma excepción

**Bibliotecas de componentes de terceros.** MudBlazor, Radzen y bibliotecas similares llaman a interop internamente para medir viewports, posicionar popovers o leer capacidades del navegador. Si la traza de pila de la excepción termina en un tipo de la biblioteca en lugar de en tu código, la solución suele ser un interruptor a nivel de biblioteca o desactivar el prerenderizado para la página que aloja el componente. Revisa primero las notas de la versión de la biblioteca: la mayoría ha añadido protecciones para el prerenderizado desde .NET 8.

**Servicios inyectados que llaman a JS.** Un servicio con ámbito que envuelve `localStorage` lanzará la excepción desde donde lo llames por primera vez, que a menudo es `OnInitializedAsync`. El servicio no puede arreglar esto por ti; el punto de llamada es el que hay que mover o condicionar. Algunas bibliotecas (Blazored.LocalStorage entre ellas) documentan esto como la recomendación de tocar el almacenamiento solo después del primer renderizado, exactamente por esta razón.

**`IJSInProcessRuntime` en WebAssembly.** El interop síncrono solo está disponible en componentes del lado del cliente una vez que el runtime de WebAssembly está en marcha. Durante la pasada de prerenderizado en el servidor de un componente `InteractiveWebAssembly`, convertir `IJSRuntime` a `IJSInProcessRuntime` falla o la llamada lanza una excepción. Usa `OperatingSystem.IsBrowser()` cuando necesites saber si el código se está ejecutando realmente en WebAssembly.

**El enrutamiento interactivo se salta el prerenderizado.** Si llegas a la página mediante una navegación mejorada interna en una app cuyo componente `Routes` es interactivo, el prerenderizado no ocurre en absoluto, así que el bug solo se reproduce en una carga completa de página. Un componente que funciona al hacer clic en un enlace y falla al pulsar F5 casi siempre es esto.

**Trabajo largo en la inicialización.** Como el prerenderizado espera a la quiescencia, un `OnInitializedAsync` lento bloquea toda la respuesta prerenderizada. Esa no es esta excepción, pero es el problema vecino que el renderizado en streaming existe para resolver, y suele aparecer en los mismos componentes.

## Relacionado

- [Cómo persistir el estado a través del límite de renderizado estático-a-interactivo de Blazor en .NET 11](/es/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) resuelve la mitad de doble inicialización del límite de prerenderizado.
- [Solución: el render mode no es compatible con el render mode del componente padre (Blazor)](/es/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/) explica la regla de un subárbol y un render mode que limita dónde surte efecto `prerender: false`.
- [Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) cubre qué render mode asignar en primer lugar.
- [Migrar una app de Blazor Server a Blazor United (Blazor Web App) en .NET 11](/es/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) recorre la introducción de render modes en una app que antes no tenía ninguno.
- [Cómo compartir la lógica de validación entre el servidor y Blazor WebAssembly](/es/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) es el patrón para la lógica que debe ejecutarse en ambos lados del límite.

## Fuentes

- [Prerender ASP.NET Core Razor components](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender) (Microsoft Learn, .NET 10/11)
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/lifecycle) (Microsoft Learn)
- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes) (Microsoft Learn), "Detect rendering location, interactivity, and assigned render mode at runtime"
- [ASP.NET Core Blazor JavaScript interoperability (JS interop)](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/) (Microsoft Learn), "JavaScript interop calls without a circuit"
- [`RemoteJSRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Server/src/Circuits/RemoteJSRuntime.cs) y [`UnsupportedJavaScriptRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Endpoints/src/DependencyInjection/UnsupportedJavaScriptRuntime.cs) en `dotnet/aspnetcore`, donde se lanzan los dos mensajes
- [dotnet/aspnetcore #24320](https://github.com/dotnet/aspnetcore/issues/24320), el issue de larga duración que sigue este error
