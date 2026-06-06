---
title: "Migrar una app de Blazor Server a Blazor United (Blazor Web App) en .NET 11"
description: "Una lista de pasos para mover una app de Blazor Server independiente a la plantilla unificada Blazor Web App en .NET 11, manteniendo cada página en InteractiveServer sin cambios de comportamiento."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet"
  - "aspnetcore"
  - "csharp"
lang: "es"
translationOf: "2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-05
---

Si tienes una app de Blazor Server independiente (`dotnet new blazorserver`) y quieres moverla a la plantilla unificada que se apodó "Blazor United" durante el ciclo de versión preliminar de .NET 8 y que se publicó como **Blazor Web App**, la migración es en su mayoría mecánica y suele tomar medio día para una app pequeña, de uno a tres días para una grande. Nada del código de tus componentes tiene que cambiar. Lo que cambia es el host: `_Host.cshtml` desaparece, el enrutamiento se mueve a un componente `Routes`, `Program.cs` cambia `MapBlazorHub` por `MapRazorComponents`, y declaras un render mode de forma explícita. Mantén cada página en `@rendermode InteractiveServer` y el comportamiento será idéntico al de Blazor Server de la era .NET 7. Lo único que muerde es la doble ejecución del prerenderizado. Esta guía apunta a **.NET 11** (versión preliminar al momento de escribir, con GA programada para noviembre de 2026) y al conjunto de paquetes `Microsoft.AspNetCore.Components` 11.0.x.

## Por qué dejar la plantilla Server independiente

La plantilla `blazorserver` independiente sigue funcionando en .NET 11, así que esta no es una migración forzada. Hazla cuando uno de estos sea un resultado real que deseas, no antes:

- **Render modes por página.** Una vez en la plantilla Web App puedes poner una página de marketing en `@rendermode StaticServer` (sin circuito SignalR, sin JavaScript, se indexa como una Razor Page) mientras mantienes el panel en `InteractiveServer`. No puedes mezclar modos en absoluto en la plantilla independiente.
- **Un camino hacia WebAssembly y Auto sin una reescritura.** Agregar más adelante un widget con capacidad offline significa agregar un proyecto `.Client` y un `@rendermode InteractiveWebAssembly`, no portar toda la app.
- **Estás en el valor predeterminado recomendado por Microsoft.** Las plantillas, los ejemplos de la documentación y los nuevos tutoriales lideran con la plantilla Blazor Web App desde .NET 8. Quedarte en Server independiente es ahora una desviación que tienes que justificar en la revisión de código.
- **Estado de circuito resiliente en .NET 10+.** La plantilla Web App junto con el atributo `[PersistentState]` puede restaurar el estado del componente cuando un circuito SignalR caído se reconecta, algo que el viejo modelo `ServerPrerendered` nunca hizo de forma limpia.

Si ninguno de esos aplica, un cambio `<TargetFramework>net11.0</TargetFramework>` en tu app de Server independiente existente es una alternativa válida y no es esta migración.

## Qué se rompe

| Área                       | Cambio                                                                                       | Severidad |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| Página host                | `Pages/_Host.cshtml` y `_Layout.cshtml` se reemplazan por un componente host raíz `App.razor` | high     |
| Enrutamiento               | `<Router>` se mueve fuera de `App.razor` a un nuevo `Routes.razor`                            | high     |
| Inicio en `Program.cs`     | `AddServerSideBlazor()` + `MapBlazorHub()` + `MapFallbackToPage("/_Host")` reemplazados por `AddRazorComponents().AddInteractiveServerComponents()` + `MapRazorComponents<App>().AddInteractiveServerRenderMode()` | high     |
| Render mode                | La interactividad es opt-in por componente o global; no hay un "toda la app es interactiva" implícito | high     |
| Prerenderizado             | `OnInitialized`/`OnInitializedAsync` se ejecutan dos veces (pasada de prerender + pasada interactiva) de forma predeterminada | medium   |
| Script de cliente          | `_framework/blazor.server.js` pasa a ser `_framework/blazor.web.js`                          | medium   |
| Cableado de autenticación  | El componente `CascadingAuthenticationState` se reemplaza por `AddCascadingAuthenticationState()` en DI | medium   |
| Acceso a `HttpContext`     | `HttpContext` solo está disponible durante el SSR estático, no dentro de un componente interactivo | medium   |
| Semántica de `App.razor`   | `App.razor` ya no es el enrutador; es el shell del documento HTML                            | low      |

## Lista previa al vuelo

- Instala el **SDK de .NET 11** (`dotnet --version` informa `11.0.1xx`). Confírmalo con `dotnet --list-sdks`.
- Haz commit de un punto de control limpio y **crea una rama**. Esta migración elimina archivos; quieres una forma fácil de volver.
- Anota tu punto de entrada actual. Blazor Server independiente usa o bien `_Host.cshtml` (el layout común anterior a .NET 8) o ya un host `App.razor`. Los pasos a continuación asumen `_Host.cshtml`.
- Inventaría cada `OnInitializedAsync` que tenga efectos secundarios (escrituras, eventos de analítica, fetches de una sola vez). Estos son los métodos que el prerenderizado ejecutará dos veces. Volverás a cada uno en el paso 7.
- Actualiza tu CI a una imagen de SDK de .NET 11 y confirma que un `dotnet build` y un `dotnet test` de referencia pasan sobre el código actual antes de tocar nada.
- Genera una app de referencia descartable con `dotnet new blazor --interactivity Server -o _ref` para tener un `App.razor`, `Routes.razor` y `Program.cs` conocidos como buenos desde los que copiar la estructura.

## Pasos de migración

### 1. Sube el target framework y los paquetes

Edita el `.csproj`. El SDK sigue siendo `Microsoft.NET.Sdk.Web`.

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <Nullable>enable</Nullable>
  <ImplicitUsings>enable</ImplicitUsings>
</PropertyGroup>
```

Sube cualquier referencia de paquete `Microsoft.AspNetCore.Components.*` a `11.0.x`. Elimina `Microsoft.AspNetCore.Components.Web` si se referencia explícitamente; es parte de la referencia de framework para los proyectos del SDK web.

Verifica: `dotnet restore` se completa y `dotnet build` falla solo con errores sobre la página host y `Program.cs` (esperado en este punto), no con errores de resolución de paquetes.

### 2. Crea el componente host `App.razor`

En la plantilla Server independiente, el documento HTML vive en `Pages/_Host.cshtml` y `Pages/_Layout.cshtml`. Mueve ese marcado a un nuevo `App.razor` raíz (elimina primero el viejo enrutador `App.razor`, o renómbralo). El tag helper `<component>` que arrancaba la raíz pasa a ser `<Routes />`.

```razor
@* .NET 11 - App.razor is now the HTML document shell, not the router *@
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="/" />
    <link rel="stylesheet" href="app.css" />
    <link rel="stylesheet" href="YourApp.styles.css" />
    <HeadOutlet />
</head>
<body>
    <Routes />
    <script src="_framework/blazor.web.js"></script>
</body>
</html>
```

Dos cambios fáciles de pasar por alto: el script es `blazor.web.js` (no `blazor.server.js`), y `<HeadOutlet />` junto con `<Routes />` son componentes, así que adoptan el render mode que les asignes en el paso 6.

Verifica: el archivo compila como un componente Razor (sin directiva `@page`, sin `@model`).

### 3. Mueve el enrutamiento a `Routes.razor`

Crea `Routes.razor` en la raíz del proyecto y pega el bloque `<Router>` que solía vivir en el viejo `App.razor`.

```razor
@* .NET 11 - Routes.razor holds the router that used to be in App.razor *@
<Router AppAssembly="@typeof(Program).Assembly">
    <Found Context="routeData">
        <RouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
        <FocusOnNavigate RouteData="@routeData" Selector="h1" />
    </Found>
    <NotFound>
        <PageTitle>Not found</PageTitle>
        <LayoutView Layout="@typeof(Layout.MainLayout)">
            <p role="alert">Sorry, there's nothing at this address.</p>
        </LayoutView>
    </NotFound>
</Router>
```

Verifica: un `dotnet build` ya no se queja de un tipo `Routes` faltante.

### 4. Habilita las abreviaturas de render mode en `_Imports.razor`

Agrega esta línea a `_Imports.razor` para que puedas escribir `InteractiveServer` en lugar de calificarlo por completo:

```razor
@* .NET 11 *@
@using static Microsoft.AspNetCore.Components.Web.RenderMode
```

Verifica: `@rendermode InteractiveServer` en un componente se resuelve sin un error de using.

### 5. Reescribe `Program.cs`

Cambia el registro de Blazor Server y los endpoints por los equivalentes de Razor Components.

```csharp
// .NET 11, C# 14 - Blazor Web App startup
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

// keep your existing app services here (DbContext, HttpClient, etc.)

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

Elimina `AddServerSideBlazor()`, `app.MapBlazorHub()` y `app.MapFallbackToPage("/_Host")`. La llamada `app.UseAntiforgery()` es nueva y obligatoria; la plantilla Web App habilita el middleware de antiforgery de forma predeterminada y los envíos de formularios fallan sin ella.

Verifica: `dotnet build` se completa con cero errores.

### 6. Vuelve la app interactiva (render mode global)

La migración de menor riesgo vuelve toda la app `InteractiveServer`, reproduciendo el viejo comportamiento exactamente. Establece el render mode en `<Routes />` y `<HeadOutlet />` dentro de `App.razor`:

```razor
@* .NET 11 - global InteractiveServer, matches standalone Blazor Server behaviour *@
<HeadOutlet @rendermode="InteractiveServer" />
...
<Routes @rendermode="InteractiveServer" />
```

Verifica: ejecuta `dotnet run`, abre la app, y confirma que los componentes interactivos (botones, `@onclick`, envíos de `EditForm`) funcionan y que el navegador mantiene un WebSocket abierto hacia `/_blazor`. Una vez que esto funcione, más adelante puedes bajar páginas individuales a `@rendermode StaticServer` o escalar islas a WebAssembly, pero eso es trabajo posterior a la migración.

### 7. Maneja la doble ejecución del prerenderizado

Este es el único cambio de comportamiento que sorprende a la gente. Con un render mode interactivo, Blazor prerenderiza primero el HTML estático, luego renderiza de nuevo sobre el circuito en vivo, así que `OnInitialized` y `OnInitializedAsync` se ejecutan dos veces. El viejo predeterminado de Server independiente (`render-mode="ServerPrerendered"`) tenía la misma propiedad, pero muchas apps usaban `render-mode="Server"` y nunca lo vieron.

Tienes tres opciones. La más limpia en .NET 11 es el atributo declarativo `[PersistentState]` (agregado en .NET 10): hace fetch una vez durante el prerender, lo serializa en el HTML, lo restaura en la pasada interactiva.

```csharp
// .NET 11 - fetch once, survive the prerender-to-interactive handoff
public partial class Dashboard : ComponentBase
{
    [PersistentState]
    public List<Order>? Orders { get; set; }

    [Inject] public required IOrderService OrderService { get; init; }

    protected override async Task OnInitializedAsync()
    {
        // Orders is non-null on the interactive pass: state was restored,
        // so the service is not hit a second time.
        Orders ??= await OrderService.GetRecentAsync();
    }
}
```

Si no quieres hacer fetch durante el prerender en absoluto, deshabilita el prerenderizado para ese límite:

```razor
@* .NET 11 - skip the prerender pass entirely for this component tree *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Verifica: pon un breakpoint o una línea de registro en cada `OnInitializedAsync` con efectos secundarios y confirma que se ejecuta una vez por navegación real, no dos.

### 8. Recablea la autenticación y la autorización

Si tu app usaba `<CascadingAuthenticationState>` envolviendo el enrutador, elimina ese componente y regístralo en DI en su lugar, luego cambia `RouteView` por `AuthorizeRouteView` en `Routes.razor`.

```csharp
// .NET 11 - Program.cs
builder.Services.AddCascadingAuthenticationState();
```

```razor
@* .NET 11 - Routes.razor, authorized routing *@
<AuthorizeRouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
```

Verifica: visita una página `[Authorize]` sin haber iniciado sesión y confirma que se te redirige, luego inicia sesión y confirma el acceso.

### 9. Elimina los archivos host muertos

Quita `Pages/_Host.cshtml`, `Pages/_Layout.cshtml` y cualquier llamada `app.MapRazorPages()` que existiera solo para servir `_Host`. Elimina `AddRazorPages()` de `Program.cs` si nada más usa Razor Pages.

Verifica: `dotnet build` está limpio y la app sigue sirviendo cada ruta.

## Verificación: la prueba de humo posterior a la migración

Ejecuta todas estas antes de hacer merge:

- `dotnet build -c Release` informa cero advertencias relacionadas con render modes.
- `dotnet test` pasa con el mismo conteo que tu referencia previa a la migración.
- La app arranca con `dotnet run` y la página de inicio se renderiza.
- Un control interactivo (`@onclick`, `EditForm`) funciona y el navegador mantiene un WebSocket `/_blazor` abierto.
- Una navegación de página no dispara dos veces un efecto secundario (la verificación del paso 7, repetida de extremo a extremo).
- Una ruta protegida con `[Authorize]` redirige cuando no se ha iniciado sesión.
- Un POST de formulario tiene éxito (esta es la verificación del middleware de antiforgery del paso 5).
- Ver el código fuente de una página: el marcado es HTML prerenderizado, no un `<div id="app">` vacío.

## Plan de reversión

Esta migración es reversible solo si conservaste la rama del paso previo al vuelo. Una vez que eliminas `_Host.cshtml` y reescribes `Program.cs`, no hay un interruptor in situ para volver al modelo Server independiente. Revierte haciendo checkout del commit previo a la migración, no editando hacia adelante. Como el cambio es estructural y no una migración de datos, no hay nada que deshacer en tu base de datos o almacenamiento. Crea una rama, haz el trabajo, verifica contra la prueba de humo, y haz merge solo cuando esté en verde.

## Tropiezos que tuvimos

- **Olvidar `app.UseAntiforgery()`.** La plantilla Web App requiere el middleware de antiforgery. Sin la llamada, cada POST de `EditForm` devuelve un 400 con `Antiforgery token validation failed`. La plantilla Server independiente no necesitaba esto porque el manejo de formularios iba sobre el circuito SignalR, no sobre POST HTTP.
- **`HttpContext` es null dentro de componentes interactivos.** En Server independiente a veces podías alcanzar `IHttpContextAccessor` desde un componente. Bajo la plantilla Web App, `HttpContext` existe solo durante la pasada de SSR estático. Lee lo que necesitas (encabezados, cookies, el usuario autenticado) durante el prerender y pásalo hacia abajo, o usa el `AuthenticationState` en cascada.
- **`blazor.server.js` dejado en el marcado.** Si copias el viejo tag de script de `_Host.cshtml` literalmente, la página carga pero no se abre ningún circuito y nada es interactivo. Debe ser `_framework/blazor.web.js`.
- **Servicios scoped comportándose de forma diferente a través del límite del prerender.** Un servicio resuelto durante el prerender y de nuevo durante la pasada interactiva son dos scopes diferentes. Si cacheabas estado por solicitud en un servicio scoped esperando que sobreviviera, no lo hará. Esta es la misma clase de problema cubierta en [No se puede consumir un servicio scoped desde un singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- **Activos estáticos con 404 después del movimiento.** La plantilla Web App sirve el CSS con alcance de componente como `YourApp.styles.css`. Si tu viejo `_Layout.cshtml` referenciaba un bundle con nombre diferente, el enlace se rompe en silencio. Revisa los hrefs `<link>` en el nuevo `App.razor`.

El destino aquí es casi siempre "cada página en `InteractiveServer`, prerenderizado manejado". Esa es la migración que no cambia nada que el usuario pueda ver. Agregar páginas Static Server, islas WebAssembly y componentes Auto es la recompensa que cobras después, un componente a la vez, sin más agitación estructural.

## Relacionado

- [Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11: cuál deberías elegir](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) para la decisión detrás de la plantilla de destino.
- [Cómo compartir la lógica de validación entre el servidor y Blazor WebAssembly](/es/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) para el patrón de proyecto compartido que querrás una vez que agregues componentes WASM.
- [Blazor SSR por fin tiene TempData en .NET 11](/es/2026/04/blazor-ssr-tempdata-dotnet-11/) para los flujos Post-Redirect-Get en las páginas de SSR estático que ahora puedes agregar.
- [Solución: No se puede consumir un servicio scoped desde un singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) para los problemas de tiempo de vida de scope que expone el límite del prerender.
- [Migrar de .NET Framework 4.8 a .NET 11 en 2026](/es/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) si este movimiento de Blazor es parte de un salto de framework mayor.

## Fuentes

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, consultado 2026-06-05.
- [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/aspnet/core/blazor/state-management/prerendered-state-persistence), Microsoft Learn, para el atributo `[PersistentState]` agregado en .NET 10.
- [Migrate from ASP.NET Core in .NET 7 to .NET 8](https://learn.microsoft.com/aspnet/core/migration/70-to-80), Microsoft Learn, para los pasos originales de reestructuración del host de Blazor Server a Web App.
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/aspnet/core/blazor/components/lifecycle), Microsoft Learn, para el comportamiento de doble ejecución del prerender.
</content>
