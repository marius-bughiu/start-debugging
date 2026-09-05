---
title: "¿Qué es un modo de renderizado en Blazor y cuál ejecuta mi componente?"
description: "Un modo de renderizado decide dónde se ejecuta un componente Razor y si es interactivo. Estos son los cuatro modos de .NET 11, las reglas de propagación que deciden qué hereda tu componente, y las propiedades RendererInfo y AssignedRenderMode que te dicen en tiempo de ejecución cuál ganó."
pubDate: 2026-09-05
tags:
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "csharp"
lang: "es"
translationOf: "2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component"
translatedBy: "claude"
translationDate: 2026-09-05
---

Un modo de renderizado es la configuración por componente de una Blazor Web App que decide dos cosas: dónde se ejecuta el componente (servidor o navegador) y si puede responder a eventos de la interfaz. Hay cuatro: Static Server, Interactive Server, Interactive WebAssembly e Interactive Auto. Asignas uno con la directiva o el atributo de directiva `@rendermode`, el valor por defecto es Static Server, y los modos se propagan hacia abajo por el árbol de componentes, así que la mayoría de los componentes nunca declaran ninguno. Para averiguar qué modo ejecuta realmente un componente dado, lee `ComponentBase.AssignedRenderMode` y `ComponentBase.RendererInfo` desde dentro del componente: `AssignedRenderMode` es `null` en el SSR estático, y `RendererInfo.IsInteractive` es `false` durante el prerenderizado incluso en un componente cuyo modo asignado es interactivo.

Todo lo de aquí apunta a .NET 11 y ASP.NET Core 11, con C# 14. Los modos de renderizado existen solo en una Blazor Web App (la plantilla unificada introducida en .NET 8). Una app Blazor WebAssembly independiente o una app Blazor Server heredada tiene un único modelo de hospedaje para toda la app y no tiene directiva `@rendermode`. Cuando el comportamiento cambió en .NET 10 o .NET 11, lo señalo.

## Los cuatro modos y los dos ejes en los que varían

| Modo | Se ejecuta en | Interactivo | Requiere un proyecto `.Client` |
| --- | --- | --- | --- |
| Static Server | Servidor | No | No |
| Interactive Server | Servidor, sobre un circuito SignalR | Sí | No |
| Interactive WebAssembly | Navegador | Sí | Sí |
| Interactive Auto | Servidor primero, navegador en visitas posteriores | Sí | Sí |

Static Server, que suele escribirse SSR estático, renderiza el componente al flujo de respuesta HTTP y se detiene. No hay circuito, no hay runtime de .NET en el navegador y no hay manejo de eventos. Un `@onclick` en un botón renderizado estáticamente compila bien y no hace nada en tiempo de ejecución. Este es el valor por defecto, y para páginas de contenido es el correcto: ninguna conexión que mantener abierta, ninguna carga de WebAssembly que descargar.

Interactive Server mantiene el componente vivo en el servidor y canaliza eventos del DOM y diffs sobre una conexión SignalR. Interactive WebAssembly descarga el runtime de .NET y el bundle de tu app y ejecuta el componente en el navegador. Interactive Auto no es un tercer runtime: renderiza con Interactive Server en la primera visita mientras el bundle de WebAssembly se descarga en segundo plano, y luego usa WebAssembly en visitas posteriores una vez que el bundle está en caché.

Una propiedad de Auto sorprende a la gente. Según la [documentación de modos de renderizado](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes), Auto nunca cambia el modo de renderizado de un componente que ya está en la página. Toma una decisión cuando el componente se renderiza por primera vez y conserva ese modo mientras el componente viva. Además prefiere igualar el modo de los componentes interactivos que ya están en la página, para no introducir a media página un segundo runtime de .NET que no comparte estado con el primero. Si todavía estás eligiendo entre modelos de hospedaje en lugar de depurar uno, el tratamiento más largo está en [Blazor Server vs WebAssembly vs Blazor United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

Los modos interactivos necesitan que los servicios y endpoints correspondientes estén registrados en `Program.cs`, o el `@rendermode` no significa nada:

```csharp
// .NET 11, C# 14 -- Program.cs of a Blazor Web App
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

// ...

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode();
```

## Tres lugares donde se puede fijar un modo de renderizado

El modo que llega a un componente puede venir de tres posiciones sintácticas distintas, y no son intercambiables.

**Sobre una instancia de componente**, como atributo de directiva, donde se usa el componente:

```razor
@* .NET 11 -- any render mode instance is allowed here *@
<Dialog @rendermode="InteractiveServer" />
```

**Sobre la definición de un componente**, como directiva al principio del archivo `.razor`. Esto es lo que usas para una página enrutable, porque nada instancia una página a mano:

```razor
@* .NET 11 -- Pages/Counter.razor *@
@page "/counter"
@rendermode InteractiveServer
```

`@rendermode` es a la vez una directiva de Razor y un atributo de directiva de Razor, y la diferencia importa exactamente una vez: la forma de directiva requiere una instancia estática de modo de renderizado, mientras que la forma de atributo de directiva acepta cualquier instancia, incluida una que construyas con opciones.

**Para toda la app**, poniendo el modo en el componente `Routes` dentro de `App.razor`. El router propaga su modo a cada página que enruta:

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="InteractiveServer" />
<HeadOutlet @rendermode="InteractiveServer" />
```

Fijar un modo sobre el propio componente raíz `App` no está soportado. Por eso la interactividad global se expresa sobre `Routes` y `HeadOutlet` en lugar de con una sola directiva arriba del todo. Si estás moviendo una app heredada a este modelo, la mecánica está en [migrar una app Blazor Server a Blazor Web App en .NET 11](/es/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/).

También puedes calcular el modo, que es la forma de recortar páginas con SSR estático dentro de una app por lo demás interactiva:

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="PageRenderMode" />

@code {
    private IComponentRenderMode? PageRenderMode => InteractiveServer;
}
```

## Las reglas de propagación que deciden qué recibe tu componente

La mayoría de los componentes de una app real no tienen ningún `@rendermode`. Heredan, y las cuatro reglas son cortas:

1. El modo de renderizado por defecto es Static.
2. Un componente sin `@rendermode` toma el modo de su padre.
3. No puedes cambiar a un modo interactivo distinto en un hijo. Un componente Interactive Server no puede hospedar un hijo Interactive WebAssembly.
4. Los parámetros que se pasan de un padre estático a un hijo interactivo deben ser serializables a JSON.

La regla 2 es la razón por la que un componente compartido que funciona en una página y está inerte en otra casi nunca es culpa del componente. Coloca esto en una página sin modo y el botón no hace nada:

```razor
@* .NET 11 -- Components/SharedMessage.razor, render-mode agnostic *@
<button @onclick="UpdateMessage">Click me</button> @message

@code {
    private string message = "Not updated yet.";

    private void UpdateMessage() => message = "Somebody updated me!";
}
```

Pon el mismo componente bajo `@rendermode InteractiveServer` y funciona. Nada del componente cambió. El instinto correcto ante "mi botón no hace nada" es mirar hacia arriba en el árbol, no al manejador.

La regla 3 produce un error en tiempo de ejecución en lugar de silencio. Una página fijada a Interactive Server con un hijo WebAssembly falla con `Cannot create a component of type '...' because its render mode 'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.` Componentes hermanos con modos interactivos distintos en una página estática están bien; anidar uno dentro del otro no.

La regla 4 es la que produce el mensaje más confuso. Pasar contenido hijo a través de una frontera estático-a-interactivo lanza:

> System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is because the parameter is of the delegate type 'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and cannot be serialized.

Un hijo interactivo de un padre estático es un componente raíz para su propio renderizador, y sus parámetros tienen que cruzar una frontera de proceso (o de red) como JSON. Un `RenderFragment` es un delegado, y un delegado no se serializa. El arreglo histórico es mover la frontera hacia arriba: envuelve el hijo en un componente que no reciba ningún render fragment y pon `@rendermode` sobre el envoltorio.

```razor
@* .NET 11 -- Components/WrapperComponent.razor *@
<SharedMessage>
    Child content
</SharedMessage>
```

```razor
@* .NET 11 -- the page *@
@page "/render-mode-10"

<WrapperComponent @rendermode="InteractiveServer" />
```

Esta es exactamente la razón por la que la plantilla incluye un `Routes.razor` que envuelve al `Router` en lugar de poner `@rendermode` directamente sobre `Router`.

## El cambio de .NET 11: los layouts interactivos por fin funcionan

La regla 4 tenía una víctima muy conocida. `LayoutComponentBase` expone `@Body` como un `RenderFragment`, así que poner `@rendermode InteractiveServer` sobre `MainLayout` en una app con interactividad por página lanzaba el mismo error de serialización, con `'Body'` como nombre del parámetro. Toda solución alternativa de las últimas tres versiones mayores ha sido alguna forma de "pon la interactividad en un envoltorio o en una sección de Blazor".

Esa restricción desaparece en .NET 11. La documentación de Microsoft ahora acota toda la limitación de "Statically-rendered layout components" a las versiones `>= 8.0 < 11.0` y declara que aplica "prior to the release of .NET 11". El trabajo de fondo es [dotnet/aspnetcore#52768](https://github.com/dotnet/aspnetcore/issues/52768), publicado en .NET 11 Preview 5: cuando un componente con un modo de renderizado recibe un parámetro `RenderFragment`, el framework ahora invoca el fragmento del lado estático, serializa el árbol de renderizado resultante como JSON y lo rehidrata en un delegado `RenderFragment` del lado interactivo. Para mantener esto honesto, el compilador exige que esas funciones envueltas sean funciones locales estáticas, de modo que no puedan capturar estado del servidor que no sobreviviría al viaje.

El efecto práctico: en .NET 11 puedes escribir

```razor
@* .NET 11 only -- Components/Layout/MainLayout.razor *@
@inherits LayoutComponentBase
@rendermode InteractiveServer

<div class="page">
    <NavMenu />
    <main>@Body</main>
</div>
```

y obtener una barra de navegación interactiva sin el baile del envoltorio basado en secciones. En .NET 10 y anteriores ese mismo archivo lanza en tiempo de ejecución. Declara el framework objetivo antes de copiar un fragmento de layout de internet, porque este cambió de sentido.

## ¿Qué modo ejecuta mi componente ahora mismo?

`ComponentBase` expone dos propiedades para esto, ambas disponibles desde .NET 9. Ninguna requiere inyección.

`AssignedRenderMode` devuelve el modo que se asignó al componente: una instancia de `InteractiveServerRenderMode`, `InteractiveWebAssemblyRenderMode` o `InteractiveAutoRenderMode`, o `null` cuando el componente corre bajo SSR estático.

`RendererInfo` describe el renderizador que realmente ejecuta el componente. `RendererInfo.Name` es uno de `Static`, `Server`, `WebAssembly` o `WebView`. `RendererInfo.IsInteractive` es `true` solo cuando el componente es genuinamente interactivo, y `false` tanto para SSR estático como durante la pasada de prerenderizado de un componente interactivo.

Esa última distinción es la útil. Un componente con `@rendermode InteractiveServer` se renderiza dos veces: una durante el prerenderizado, donde `AssignedRenderMode` es una instancia de `InteractiveServerRenderMode` pero `RendererInfo.IsInteractive` es `false`, y otra sobre el circuito, donde ambas coinciden. Entonces:

- Usa `AssignedRenderMode is null` para preguntar "¿este componente llegará a ser interactivo alguna vez?" Esa es una decisión sobre la forma del markup.
- Usa `RendererInfo.IsInteractive` para preguntar "¿puedo manejar eventos ahora mismo?" Esa es una decisión sobre la pasada actual.

Un componente de diagnóstico que puedes soltar en cualquier punto del árbol para ver qué heredó un subárbol:

```razor
@* .NET 11 -- Components/RenderModeProbe.razor *@
<dl>
    <dt>AssignedRenderMode</dt>
    <dd>@(AssignedRenderMode?.GetType().Name ?? "null (static SSR)")</dd>
    <dt>RendererInfo.Name</dt>
    <dd>@RendererInfo.Name</dd>
    <dt>RendererInfo.IsInteractive</dt>
    <dd>@RendererInfo.IsInteractive</dd>
</dl>
```

Como la sonda no declara ningún modo propio, hereda, y reporta exactamente lo que su página anfitriona le pasó hacia abajo. Esa es una respuesta más rápida que leer directivas `@rendermode` hacia arriba en el árbol, sobre todo en una app que asigna modos de forma programática.

El uso documentado de `AssignedRenderMode` es degradar con elegancia: renderizar un `form` HTML real cuando el componente es estático, y entradas enlazadas con un manejador de eventos cuando no lo es.

```razor
@* .NET 11 *@
@if (AssignedRenderMode is null)
{
    <form action="/movies">
        <input type="text" name="titleFilter" />
        <input type="submit" value="Search" />
    </form>
}
else
{
    <input @bind="titleFilter" />
    <button @onclick="FilterMovies">Search</button>
}
```

Y el uso documentado de `IsInteractive` es suprimir controles que no harían nada en silencio durante la pasada de prerenderizado:

```razor
@* .NET 11 *@
<button @onclick="Send" disabled="@(!RendererInfo.IsInteractive)">
    Send
</button>
```

## El prerenderizado, y por qué tu inicializador corre dos veces

El prerenderizado está activado por defecto para los tres modos interactivos. El servidor renderiza el componente estáticamente dentro de la respuesta HTML inicial, y luego el renderizador interactivo toma el relevo y lo renderiza otra vez. Por eso `OnInitializedAsync` corre dos veces, una por renderizador, que es la causa real de las quejas de "mi API se llama dos veces" y "la interfaz parpadea de vuelta al estado de carga".

`OnAfterRender` y `OnAfterRenderAsync` son la excepción: no se llaman durante el prerenderizado en absoluto. Esa es también la razón por la que la interoperabilidad JS desde `OnInitializedAsync` lanza, ya que todavía no hay navegador al que llamar, tratado en detalle en [JavaScript interop calls cannot be issued at this time](/es/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/).

Tienes dos respuestas. Desactivar el prerenderizado para el componente:

```razor
@* .NET 11 -- component definition form *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

```razor
@* .NET 11 -- component instance form *@
<Dialog @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

O, mejor para cualquier cosa visible al usuario, conservar el prerenderizado y llevar el estado a través de la frontera con el atributo `[PersistentState]` (`[SupplyParameterFromPersistentComponentState]` bajo su nombre antiguo; `PersistentStateAttribute` es la API de .NET 10 en adelante):

```csharp
// .NET 11, C# 14
[PersistentState]
public int? CurrentCount { get; set; }
```

El tratamiento completo, incluidos `RestoreBehavior` y `AllowUpdates`, está en [cómo persistir estado a través de la frontera de renderizado estático-a-interactivo de Blazor en .NET 11](/es/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

Una trampa en el camino de desactivar: `prerender: false` solo surte efecto en un modo de renderizado de nivel superior. Si un componente padre ya declaró un modo, la configuración de prerenderizado de sus hijos se ignora por completo. Fijarlo en un componente anidado y ver que el prerenderizado continúa no es un bug.

## El SSR estático pierde más que la interactividad

Bajo SSR estático la solicitud la maneja el pipeline de middleware de ASP.NET Core, y los componentes Razor no se renderizan durante ese procesamiento. Así que las propias funciones del router de Blazor no participan. En .NET 10 y .NET 11, el contenido `<NotAuthorized>` de `AuthorizeRouteView` no se muestra en páginas renderizadas estáticamente; las solicitudes no autorizadas las maneja el middleware de autorización, normalmente a través de un `IAuthorizationMiddlewareResultHandler` personalizado. Antes de .NET 10, el contenido `<NotFound>` tenía el mismo problema. Una app con interactividad a nivel raíz no se topa con esto, porque tras el primer renderizado estático el pipeline de middleware ya no interviene.

.NET 11 añade además una herramienta adyacente a los modos de renderizado que vale la pena conocer: el componente `CacheView` cachea la salida renderizada de un subárbol de componentes durante el SSR estático y reproduce el markup en un acierto sin instanciar los componentes hijos ni ejecutar sus métodos de ciclo de vida.

```razor
@* .NET 11 *@
<CacheView VaryByQuery="category" ExpiresAfter="TimeSpan.FromMinutes(5)">
    <ProductList Category="@Category" />
</CacheView>
```

Solo aplica al SSR estático, que es una razón más para dejar las páginas de contenido en el modo por defecto en lugar de hacer toda la app interactiva por costumbre.

## La versión corta

Un modo de renderizado es dónde corre el componente y si puede manejar eventos. Asígnalo sobre una instancia, sobre una definición, o sobre `Routes` para toda la app; todo lo que no tenga directiva hereda de su padre, y el valor por defecto es estático. Un botón muerto significa mirar hacia arriba en el árbol. Una excepción de serialización significa que un `RenderFragment` cruzó una frontera estático-a-interactivo, lo que en .NET 10 y anteriores incluye cualquier layout interactivo y en .NET 11 ya no. Una llamada duplicada a la API significa prerenderizado, y el arreglo es `[PersistentState]` mucho más a menudo que `prerender: false`. Cuando necesites la verdad sobre el terreno en lugar de una suposición, lee `AssignedRenderMode` para la asignación y `RendererInfo.IsInteractive` para la pasada actual, y recuerda que discrepan a propósito durante el prerenderizado.

## Relacionado

- [Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [Migrar una app Blazor Server a Blazor United (Blazor Web App) en .NET 11](/es/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)
- [Cómo persistir estado a través de la frontera de renderizado estático-a-interactivo de Blazor en .NET 11](/es/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time (prerenderizado de Blazor)](/es/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [Fix: Attempting to reconnect to the server cuando se desconecta un circuito de Blazor Server](/es/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/)

## Fuentes

- [ASP.NET Core Blazor render modes -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0)
- [Prerender ASP.NET Core Razor components -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender?view=aspnetcore-11.0)
- [ASP.NET Core Blazor layouts -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/layouts?view=aspnetcore-11.0)
- [Persist state across prerendering -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0)
- [What's new in ASP.NET Core in .NET 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11)
- [Support serializing RenderFragment parameters -- dotnet/aspnetcore #52768](https://github.com/dotnet/aspnetcore/issues/52768)
- [ComponentBase.AssignedRenderMode Property -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.componentbase.assignedrendermode)
- [RendererInfo Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendererinfo)
