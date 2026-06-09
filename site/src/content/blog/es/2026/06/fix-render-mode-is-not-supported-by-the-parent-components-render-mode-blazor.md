---
title: "Solución: el render mode no es compatible con el render mode del componente padre (Blazor)"
description: "Pusiste @rendermode en un hijo cuyo padre ya es interactivo. Un subárbol tiene exactamente un render mode. Quita la directiva del hijo o muévela al límite."
pubDate: 2026-06-09
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
lang: "es"
translationOf: "2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor"
translatedBy: "claude"
translationDate: 2026-06-09
---

La solución: aplicaste `@rendermode` a un componente hijo que vive dentro de un subárbol que ya tiene un render mode interactivo, y los dos modos no coinciden. Un subárbol de Blazor tiene exactamente un render mode, fijado en su límite interactivo. No puedes cambiar de `InteractiveServer` a `InteractiveWebAssembly` (ni al revés) a mitad del árbol. Quita la directiva `@rendermode` del hijo para que herede el modo del padre, o sube el render mode al único componente que posee el límite interactivo. Si los modos son en realidad el mismo, el problema real es un `@rendermode` duplicado en un componente anidado, y debes eliminar el interno.

```text
System.InvalidOperationException: Cannot create a component of type
'BlazorSample.Components.SharedMessage' because its render mode
'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode'
is not supported by Interactive Server rendering.
   at Microsoft.AspNetCore.Components.Rendering.ComponentState..ctor(...)
   at Microsoft.AspNetCore.Components.RenderTree.Renderer.AddToRenderQueue(...)
   at Microsoft.AspNetCore.Components.Endpoints.EndpointHtmlRenderer...
```

Esta guía está escrita contra .NET 11 (ASP.NET Core 11, `Microsoft.AspNetCore.Components` 11.0.0), pero la regla es idéntica desde que los render modes llegaron en .NET 8. El texto del mensaje varía según la combinación que toques, así que el tráfico de búsqueda llega aquí con varias formulaciones: "its render mode is not supported by Interactive Server rendering", "render mode is not supported by the parent component's render mode" y la muy relacionada "Cannot pass the parameter X to component Y with rendermode InteractiveServerRenderMode". Las tres provienen de la misma restricción de fondo, y la última tiene una solución distinta, que se cubre más abajo.

## Un subárbol, un render mode

En una Blazor Web App, la interactividad no es un interruptor por componente que puedes esparcir donde quieras. Cuando un componente declara `@rendermode InteractiveServer` o `@rendermode InteractiveWebAssembly`, crea un *límite* interactivo. Todo lo que se renderiza dentro de ese límite (cada hijo, nieto y el contenido que renderizan) se ejecuta bajo ese único render mode. El límite es la raíz de una *isla* interactiva, y una isla tiene un único modelo de hospedaje: o un circuito SignalR en el servidor, o un runtime WebAssembly en el navegador. No hay forma de ejecutar media isla en el servidor y media en el navegador, porque ambas comparten un árbol de estado de componentes vivo y un único dispatcher.

Por eso las reglas de la documentación oficial se enuncian como absolutos. De la [documentación de render modes de Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes):

- Los render modes se propagan hacia abajo por la jerarquía de componentes.
- El render mode por defecto es Static.
- No puedes cambiar a un render mode interactivo distinto en un componente hijo. Por ejemplo, un componente Server no puede ser hijo de un componente WebAssembly.

Así que cuando el renderizador recorre el árbol, llega a tu componente hijo y encuentra un `@rendermode` que entra en conflicto con la isla en la que ya está, no puede respetarlo. Lanza una excepción en lugar de elegir uno en silencio. La excepción se construye cuando el framework intenta crear el estado del componente para el hijo problemático, por eso la traza de pila apunta a `ComponentState` y al renderizador, no a tu código.

Un modelo mental útil: `@rendermode` responde a la pregunta "¿dónde empieza esta isla y qué la hospeda?". No es una propiedad de cada componente. La mayoría de los componentes no deberían llevar ningún render mode y simplemente heredar la isla en la que caen.

## El repro mínimo

Una página es interactiva en el servidor y anida un componente que pide WebAssembly:

```razor
@* RenderMode11.razor -- .NET 11, ASP.NET Core 11 -- throws at render time *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage @rendermode="InteractiveWebAssembly" />
```

`SharedMessage` en sí es agnóstico respecto al render mode (no declara modo propio):

```razor
@* SharedMessage.razor -- .NET 11 *@
<p>@message</p>
<button @onclick="UpdateMessage">Update</button>

@code {
    private string message = "Not updated yet.";
    private void UpdateMessage() => message = "Updated!";
}
```

Navega a `/render-mode-11` y la página falla al renderizar con:

```text
Cannot create a component of type 'SharedMessage' because its render mode
'InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.
```

El padre posee una isla de servidor. El hijo exigió una isla WebAssembly anidada dentro. Esa anidación no es representable, así que lanza la excepción.

## La solución, ordenada por prioridad

**1. Quita el render mode del hijo (lo más común).** Nueve de cada diez veces el hijo nunca debió tener un `@rendermode`. Se copió de un ejemplo, o se añadió por precaución "para hacerlo interactivo", cuando en realidad hereda la interactividad de su padre gratis. Elimina la directiva:

```razor
@* RenderMode11.razor -- fixed: child inherits the parent's server island *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage />
```

Ahora `SharedMessage` se ejecuta de forma interactiva sobre la misma conexión SignalR que su padre. El botón funciona. Este es el comportamiento de [herencia de render mode](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-inheritance) que describe la documentación: un componente colocado dentro de un padre interactivo adopta el modo de ese padre.

**2. Haz que los dos modos coincidan.** Si de verdad querías WebAssembly aquí, lo que está mal es el *padre*. Pon toda la isla en WebAssembly en su límite y quita la directiva del hijo:

```razor
@* fixed: the whole island is WebAssembly *@
@page "/render-mode-11"
@rendermode InteractiveWebAssembly

<SharedMessage />
```

Recuerda que una isla WebAssembly solo puede vivir en el proyecto cliente (el que termina en `.Client`). Mueve allí tanto la página como `SharedMessage`, o esta solución cambiará un error por `Could not find any interactive components`.

**3. Divide la isla para que los dos modos sean hermanos, no anidados.** El contenido Server y WebAssembly puede coexistir en la misma página siempre que ninguno esté *dentro* del otro. Haz que ambos sean hijos de un padre estático:

```razor
@* fixed: two sibling islands under a static page *@
@page "/render-mode-11"

@* no @rendermode here -- the page stays static SSR *@
<ServerWidget @rendermode="InteractiveServer" />
<WasmWidget @rendermode="InteractiveWebAssembly" />
```

La página en sí se renderiza estáticamente y hospeda dos islas independientes. Este es el patrón correcto cuando un widget necesita servicios solo de servidor (una base de datos, cookies HTTP) y otro necesita ejecutarse sin conexión en el navegador. La restricción es solo sobre *anidar* modos no coincidentes, no sobre tener ambos en una página.

**4. Usa `InteractiveAuto` en el límite, no en el medio.** `InteractiveAuto` sigue siendo un único render mode para la isla: elige Server para la primera visita y WebAssembly una vez que el bundle está en caché. Lo pones una sola vez, en el límite, igual que los otros dos. No te permite mezclar modos dentro de un subárbol.

## El parecido: "Cannot pass the parameter ... with rendermode"

Un error distinto pero que se confunde constantemente tiene casi el mismo disparador. Cuando un hijo interactivo está bajo un padre *estático* y le pasas un `RenderFragment` (contenido hijo), obtienes:

```text
System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to
component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is
because the parameter is of the delegate type
'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and
cannot be serialized.
```

Aquí los modos no entran en conflicto; el *parámetro* no puede cruzar el límite. Los parámetros que un padre estático entrega a un hijo interactivo deben ser serializables a JSON, porque el servidor estático tiene que serializarlos dentro de la página para que el runtime interactivo los rehidrate. Un `RenderFragment` es un delegado compilado (código arbitrario), así que no se puede marshalar.

La solución que usa el propio framework es un componente envoltorio que no recibe parámetros y aplica el render mode en su propia definición. Por eso exactamente la plantilla de Blazor Web App envuelve `Router` dentro de un componente `Routes`:

```razor
@* WrapperComponent.razor -- holds the render mode, takes no serialized params *@
@rendermode InteractiveServer

<SharedMessage>
    <p>This child content is created inside the interactive island, not passed across it.</p>
</SharedMessage>
```

Como el `RenderFragment` ahora se escribe *dentro* del límite interactivo en lugar de pasarse a través de él, no hay nada que serializar. El mismo truco resuelve la variante que tocas al intentar hacer interactivo un layout que deriva de `LayoutComponentBase` en una app con interactividad por página: envuelve la parte interactiva en lugar de marcar el layout.

## Trampas que llevan a la solución equivocada

**Marcar el componente `App` o raíz como interactivo.** Hacer interactivo un componente raíz como `App` no es compatible, así que no puedes establecer el render mode de toda la app directamente en `App`. La plantilla lo establece en `<Routes @rendermode="..." />` y `<HeadOutlet @rendermode="..." />`. Si pones `@rendermode` en `App.razor` verás errores de límite relacionados; muévelo hacia abajo a `Routes`.

**Un render mode `null` no es "estático".** Pasar `@rendermode="@unaVariableNull"` no fuerza el renderizado estático. Un render mode `null` significa "hereda del padre". Si el padre es interactivo, un hijo `null` sigue siendo interactivo. La única razón por la que el [patrón de páginas SSR estáticas](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#static-ssr-pages-in-an-interactive-app) funciona con un modo `null` es que su padre (`App`) es estático de entrada.

**La interactividad global oculta la directiva.** Si adoptaste la interactividad global poniendo el modo en `Routes`, cada página lo hereda. Añadir un *segundo* `@rendermode` a una página o componente es ahora redundante en el mejor caso y conflictivo en el peor. Busca directivas `@rendermode` perdidas en tu proyecto antes de suponer que el framework se equivoca.

**Definición de componente vs instancia de componente.** Puedes aplicar `@rendermode` de dos formas: en una *instancia* de componente (`<SharedMessage @rendermode="InteractiveServer" />`) o en la *definición* del componente (`@rendermode InteractiveServer` al inicio de `SharedMessage.razor`, mediante la forma de atributo). Un modo incrustado en la definición se dispara dondequiera que se use el componente, incluso dentro de una isla que ya tiene un modo distinto. Si no encuentras una directiva de instancia problemática, revisa el propio archivo `.razor` del hijo por una a nivel de definición.

El hilo conductor de cada variante: decide dónde empieza cada isla interactiva, establece el modo una sola vez en ese límite y deja que todo lo de dentro herede. El renderizador lanza la excepción precisamente porque intentaste redibujar un límite en medio de un subárbol que ya tenía uno.

## Relacionado

- [Cómo persistir estado a través del límite de renderizado estático a interactivo de Blazor en .NET 11](/es/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) cubre el lado de los datos del mismo límite que protege este error.
- [Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) explica qué modelo de hospedaje elige cada render mode y cuándo usar cuál.
- [Migrar una app de Blazor Server a Blazor United en .NET 11](/es/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) recorre cómo introducir render modes en una app que nunca los tuvo.
- [Cómo compartir lógica de validación entre el servidor y Blazor WebAssembly](/es/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) es el patrón que quieres cuando islas hermanas necesitan las mismas reglas.
- [Blazor SSR por fin tiene TempData en .NET 11](/es/2026/04/blazor-ssr-tempdata-dotnet-11/) es útil cuando una página SSR estática en una app interactiva necesita pasar datos a través de una recarga completa de página.

## Fuentes

- [ASP.NET Core Blazor render modes -- Render mode propagation and inheritance](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes), Microsoft Learn (aspnetcore-11.0).
- [ASP.NET Core Blazor render modes -- Child component with a different render mode than its parent](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-propagation), Microsoft Learn.
- [dotnet/aspnetcore #55319 -- Blazor component cannot be nested inside a parent using a render fragment if the nested component is interactive](https://github.com/dotnet/aspnetcore/issues/55319).
</content>
