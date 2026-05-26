---
title: "Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11: ¿cuál elegir en 2026?"
description: "Para cualquier app Blazor nueva en .NET 11, crea un Blazor Web App (la plantilla antes apodada Blazor United) y elige el modo de render por página. Las plantillas Server-only o WebAssembly-only solo siguen teniendo sentido en casos puntuales."
pubDate: 2026-05-26
tags:
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
lang: "es"
translationOf: "2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

Para un proyecto Blazor nuevo en .NET 11, la respuesta es la plantilla Blazor Web App (el modelo apodado "Blazor United" cuando .NET 8 estaba en preview). Te permite decidir el renderizado por componente: renderizado estático del servidor para páginas de marketing, Server interactivo para pantallas CRUD de baja latencia, WebAssembly interactivo para widgets con capacidad offline, y Auto para componentes que deben pasar de Server a WebAssembly cuando el payload de WASM termine de descargarse. Elige una plantilla solo Server o solo WebAssembly únicamente si tienes una restricción que descarte el modelo unificado: una app interna donde la descarga de WebAssembly sea inviable, o una PWA que deba funcionar totalmente offline contra una API de terceros.

Este artículo apunta a .NET 11 (en preview al momento de escribir, GA prevista para noviembre de 2026) y al conjunto de paquetes `Microsoft.AspNetCore.Components` 11.0.x. Las plantillas de proyecto provienen de `Microsoft.AspNetCore.Components.WebAssembly.Templates` y de la plantilla `dotnet new blazor` incluida en el SDK de .NET 11. Donde el comportamiento varíe entre versiones, indico las diferencias entre .NET 8, .NET 9, .NET 10 y .NET 11 de forma inline.

## Qué es realmente "Blazor United" en .NET 11

"Blazor United" no es un modelo de hosting separado. Era el nombre de trabajo que Microsoft usó durante el ciclo de preview de .NET 8 para lo que finalmente se publicó como la plantilla **Blazor Web App**. La plantilla combina cuatro modos de render en un solo proyecto:

- **Static Server (SSR)**: HTML renderizado en el servidor, sin interactividad, sin circuito SignalR, sin descarga de WebAssembly. Carga como una Razor Page.
- **Interactive Server**: HTML renderizado en el servidor, actualizaciones del DOM enviadas por un circuito SignalR. El modelo clásico de Blazor Server.
- **Interactive WebAssembly**: El componente se ejecuta en el navegador sobre un runtime de WebAssembly. El modelo clásico de Blazor WebAssembly.
- **Interactive Auto**: Renderiza en Server mientras el usuario espera la descarga en segundo plano del bundle de WebAssembly, y luego pasa de forma transparente a WebAssembly en la siguiente navegación. Hace fallback por componente si WebAssembly no carga.

Declaras el modo por componente con `@rendermode InteractiveServer`, `@rendermode InteractiveWebAssembly` o `@rendermode InteractiveAuto`. El mismo archivo `.razor` puede correr en cualquiera de esos modos si no llama a APIs específicas del modo (más sobre esto abajo).

Blazor Server (la plantilla autónoma, `dotnet new blazorserver`) y Blazor WebAssembly (`dotnet new blazorwasm`) siguen existiendo en .NET 11, pero la guía de Microsoft desde .NET 8 ha sido: prefiere la plantilla unificada Blazor Web App salvo que tengas una razón específica para no hacerlo.

## La matriz de características

| Capacidad                                 | Blazor Server (autónomo)                 | Blazor WebAssembly (autónomo)                | Blazor Web App / United (.NET 11)            |
| ----------------------------------------- | ---------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Lugar de renderizado                      | servidor                                 | navegador                                    | por componente (Static, Server, WASM, Auto)  |
| Payload inicial (caché frío)              | ~50-80 KB HTML                           | ~1,4 MB WASM + ensamblados (R2R, .NET 11)    | ~50-80 KB HTML, WASM se descarga perezoso    |
| First Contentful Paint (LAN)              | ~80-150 ms                               | ~600-900 ms                                  | ~80-150 ms (Static / Server) ~600-900 ms (WASM-first) |
| Tiempo hasta interactividad tras FCP      | decenas de ms (apertura del WebSocket)   | cientos de ms (arranque del WASM)            | depende del modo de render de la página      |
| Requiere WebSocket persistente            | sí (SignalR)                             | no                                           | solo para componentes Interactive Server     |
| Funciona offline                          | no                                       | sí (con service worker)                      | sí para componentes WebAssembly, no para Server |
| Acceso directo a base de datos / archivos / secretos | sí (proceso del servidor)         | no (sandbox del navegador)                   | sí en componentes Server, no en componentes WASM |
| Superficie de API .NET                    | runtime de servidor completo             | subconjunto recortado, seguro para navegador | ambas, según el componente                   |
| Historia de depuración                    | F5 en Visual Studio / Rider              | devtools de Chrome + depurador WASM de VS    | ambas                                        |
| Techo de escala por servidor              | acotado por circuitos abiertos (~5k por nodo) | ilimitado (archivos estáticos + API)    | acotado solo para las páginas Interactive Server |
| Soporte Native AOT                        | no (el servidor sigue siendo JIT)        | parcial vía WASM AOT                         | por modo de render                           |
| Historia de autenticación                 | cookie + circuito                        | OIDC / token en el navegador                 | cookie para SSR/Server, token para WASM      |
| Estado en .NET 11                         | soportado, no es el predeterminado recomendado | soportado, no es el predeterminado recomendado | predeterminado recomendado              |

La fila que cierra la conversación para la mayoría de las apps nuevas es la última. Las propias plantillas, los ejemplos de la documentación y los tutoriales de Microsoft empiezan con la plantilla Blazor Web App. Elegir solo Server o solo WebAssembly en 2026 es ahora una desviación explícita que necesita justificación.

## Cuándo elegir Blazor Server (autónomo)

La plantilla autónoma Blazor Server sigue siendo la opción correcta cuando tienes alguna de estas restricciones:

- **Aplicación interna en LAN, número fijo de usuarios, prohibición de descargas de WebAssembly.** Herramientas de servicio en campo, dashboards de manufactura, pantallas en piso hospitalario. Una descarga de 1,4 MB de WebAssembly sobre un Wi-Fi de kiosco inestable es peor experiencia que una reconexión SignalR. Con .NET 11, la plantilla autónoma Server también es la imagen de contenedor más liviana porque nunca copia el runtime WASM a tu salida de publicación.
- **Necesitas llamar a un SQL Server con autenticación de Windows o a un servicio protegido por Kerberos desde el componente.** El componente corre en el proceso del servidor, así que puede usar las credenciales integradas de la identidad del app pool. No hay equivalente para WebAssembly sin un proxy del lado servidor.
- **El equipo no tiene front-end ni lo tendrá.** El renderizado de servidor con un circuito SignalR oculta casi todas las preocupaciones del navegador. El estado vive en el servidor, depuras con herramientas .NET normales y no hay un segundo pipeline de build para el bundle WASM.

Un `Program.cs` mínimo de Blazor Server en .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

Ten en cuenta que `AddRazorComponents()` más `AddInteractiveServerComponents()` es la API de .NET 8+. La antigua `AddServerSideBlazor()` todavía funciona, pero pasa por una capa de compatibilidad y no activa la nueva plomería de modos de render. Usa las APIs nuevas en cualquier proyecto greenfield.

## Cuándo elegir Blazor WebAssembly (autónomo)

Recurre a la plantilla autónoma de WebAssembly cuando:

- **La app deba funcionar offline.** Una PWA que se envía a ingenieros en campo, una app de tablet para asociados en tienda, cualquier cosa que hable con un backend detrás de una conexión inestable. Combina un service worker con almacenamiento local (`IndexedDB` a través de `Microsoft.JSInterop`) y la app sobrevive a una pérdida total de red.
- **Estás haciendo deploy en un CDN o host estático sin runtime .NET.** Blazor WebAssembly es solo `wwwroot/` más una carpeta `_framework/`. Súbelo a Cloudflare Pages, GitHub Pages, Azure Static Web Apps o cualquier bucket de S3 detrás de CloudFront. Pagas cero cómputo. La plantilla Blazor Web App, en cambio, necesita un host de ASP.NET Core para las páginas Server y SSR.
- **El backend es una API de terceros que no controlas.** Si tu almacén de datos es Stripe, Auth0 o una API REST pública, no hay lógica de servidor que hospedar. La plantilla autónoma de WASM más un flujo OIDC PKCE te da una app totalmente del lado cliente sin infraestructura propia.
- **Quieres enviar el front-end como parte de una app MAUI Hybrid o Electron.** Tanto `BlazorWebView` como la plantilla .NET MAUI Hybrid esperan un grafo de componentes estilo WebAssembly autónomo. Incrustar un proyecto Blazor Web App ahí no aporta nada.

Un `Program.cs` mínimo de Blazor WebAssembly en .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.WebAssembly 11.0.x
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(builder.HostEnvironment.BaseAddress)
});

await builder.Build().RunAsync();
```

En .NET 11 el runtime de WebAssembly tiene multithreading habilitado por defecto en proyectos nuevos cuando activas `<WasmEnableThreads>true</WasmEnableThreads>` en el `.csproj`. Eso elimina una de las razones más usadas para descartar Blazor WebAssembly: el trabajo intensivo en CPU ya no bloquea el hilo de UI.

## Cuándo elegir Blazor Web App (el modelo United)

Para todo lo demás. La plantilla unificada te da un único proyecto donde:

- La landing es `@rendermode StaticServer` y carga en menos de 100 ms sin nada de JavaScript. Para un crawler es indistinguible de una Razor Page.
- El dashboard es `@rendermode InteractiveServer` porque habla directamente con un `DbContext` y no quieres exponer esas consultas a través de una API.
- El anotador de imágenes es `@rendermode InteractiveWebAssembly` porque ejecuta un modelo ONNX en el navegador vía `Microsoft.ML.OnnxRuntime`.
- Los componentes compartidos del shell son `@rendermode InteractiveAuto`: renderizan bajo Server en el primer paint y luego pasan a WebAssembly cuando termina la descarga del bundle, de modo que las navegaciones siguientes son instantáneas y sobreviven a un reinicio del servidor.

Esta capacidad de composición es lo que no iguala ninguna otra opción. Dejas de tener una decisión binaria "app Server o app WASM" y pasas a una decisión por página, igual que Next.js te deja mezclar `ssr`, `static` y `client`. Un `Program.cs` mínimo de Blazor Web App en .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x +
// Microsoft.AspNetCore.Components.WebAssembly.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode()
    .AddAdditionalAssemblies(typeof(BlazorApp.Client._Imports).Assembly);

app.Run();
```

El proyecto `.Client` que viene con la plantilla es donde pones los componentes que necesitan correr en WebAssembly. Los componentes solo-servidor quedan en el proyecto host. Los componentes Interactive Auto viven en `.Client` (porque también deben ser alcanzables desde el lado WebAssembly).

## Los datos de cold start y tamaño de bundle

Los números a continuación vienen de un `dotnet new blazor`, `dotnet new blazorserver` y `dotnet new blazorwasm` limpios en el SDK de .NET 11 `11.0.100-preview.4.26152.6`, publicados con `dotnet publish -c Release` y servidos por `dotnet run`. Medidos con Chrome 137 en un MacBook Pro M2, caché frío, con throttling "Fast 3G" en DevTools.

| Métrica                                      | Blazor Server | Blazor WebAssembly | Blazor Web App (landing Auto) |
| -------------------------------------------- | ------------- | ------------------ | ----------------------------- |
| HTML inicial transferido                     | 8 KB          | 4 KB               | 8 KB                          |
| WebAssembly + ensamblados transferidos       | 0             | 1,42 MB (gzip)     | 1,42 MB (gzip, perezoso)      |
| Tiempo hasta First Contentful Paint          | 320 ms        | 1850 ms            | 340 ms                        |
| Tiempo hasta interactividad (botón contador) | 410 ms        | 2300 ms            | 440 ms (Server) / 2400 ms (handoff a WASM) |
| Memoria tras la primera navegación           | 7 MB navegador| 38 MB navegador    | 9 MB y luego 41 MB tras handoff |

El Blazor Web App en modo Auto le gana a WebAssembly autónomo en first paint por un factor de cinco porque no espera al bundle. No le gana al Server autónomo porque, una vez que el bundle de WebAssembly termina de cargar, igualmente cuesta memoria. El punto no es que Auto sea el más rápido en una métrica. El punto es que nunca es el más lento.

Para una mirada más profunda a cómo el SDK de .NET 11 recorta el bundle WASM, mira [la nueva plantilla Blazor WebWorker de .NET 11](/2026/04/dotnet-11-preview-2-blazor-webworker-template/), que usa los mismos ajustes del trimmer.

## El gotcha que decide por ti

Tres cosas fuerzan la decisión sin importar tu preferencia:

1. **No puedes inyectar un `DbContext` en un componente WebAssembly.** Ni ningún valor de `IConfiguration` que contenga un secreto. Ni ningún cliente de blob que use una cadena de conexión. El navegador es un entorno hostil por diseño. Si tu componente debe leer la base de datos directamente, tiene que ser Server (o necesitas una API backend a la que llame el componente WASM). La plantilla Blazor Web App lo deja claro fallando rápido: pon `@inject ApplicationDbContext Db` en un componente `.Client` y el build falla con un error claro de inyección de dependencias faltante.

2. **No puedes hacer cambios de `@rendermode` dentro de un límite de modo de render.** Una página renderizada como Static Server puede hospedar una isla Interactive Server, y una página Interactive Server puede hospedar islas Interactive WebAssembly, pero no puedes anidar interactividad dentro de interactividad. En la práctica esto significa: elige el modo de render más bajo que sirva para la página y solo escala a nivel de isla.

3. **HTTPS, antiforgery y el estado de autenticación fluyen por cookies por defecto.** Los componentes WebAssembly no ven esas cookies en solicitudes cross-origin. Si la parte WebAssembly de un Blazor Web App llama a una API externa, necesitas un flujo de token OIDC encima, no solo la cookie del host. Este es el tropezón más común al migrar una app Blazor Server a la plantilla Web App.

Para el ángulo específico de antiforgery, [el comportamiento de TempData en Blazor SSR en .NET 11](/2026/04/blazor-ssr-tempdata-dotnet-11/) y la [guía de lógica de validación compartida](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) cubren los patrones prácticos.

## Recomendación reformulada

Para un proyecto Blazor nuevo en .NET 11 en 2026, empieza con `dotnet new blazor` (la plantilla Blazor Web App) y asigna modos de render por página. El costo de poder bajar a `@rendermode StaticServer` para una página de marketing o subir a `@rendermode InteractiveWebAssembly` para un componente con capacidad offline es casi nulo comparado con el costo de elegir la plantilla autónoma equivocada y reescribir más tarde. Elige `dotnet new blazorserver` solo si tienes una prohibición dura de descargas de WebAssembly. Elige `dotnet new blazorwasm` solo si tu destino de despliegue no tiene runtime .NET, o si estás embebiendo el front-end en MAUI Hybrid o Electron.

Si ya estás en Blazor Server hoy y sopesas una migración, el destino casi siempre es la plantilla Blazor Web App con la mayoría de tus páginas existentes en `@rendermode InteractiveServer`. Esa es la migración de menor riesgo: el comportamiento queda idéntico para las páginas que se mueven y desbloqueas la opción de añadir componentes Static Server y Auto de forma incremental.

## Relacionado

- [Minimal APIs vs controllers en ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para las decisiones de API backend que abre un Blazor Web App.
- [Cómo usar Tailwind CSS con Blazor WebAssembly en .NET 11](/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) para las diferencias del pipeline de estilos entre WASM autónomo y la plantilla Blazor Web App.
- [Cómo compartir lógica de validación entre servidor y Blazor WebAssembly](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) para el patrón práctico de "proyecto compartido" que la plantilla Web App formaliza.
- [Native AOT vs ReadyToRun vs JIT en .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) para los compromisos del modo de compilación que afectan tanto a Server como a WASM.
- [Blazor virtualize con altura variable en .NET 11 Preview 3](/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/) para una de las APIs nuevas que benefician a listas de componentes en modo Auto.

## Fuentes

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, consultado 2026-05-26.
- [What's new in ASP.NET Core in .NET 8](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-8.0) para la primera salida de la plantilla unificada (entonces llamada "Blazor United" en previews).
- [What's new in ASP.NET Core for .NET 11](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-11.0) para las mejoras por modo de render.
- [ASP.NET Core Blazor WebAssembly with multithreading](https://learn.microsoft.com/aspnet/core/blazor/performance#webassembly-multithreading) para el flag `WasmEnableThreads`.
- [`dotnet/aspnetcore` discussion 51020](https://github.com/dotnet/aspnetcore/discussions/51020), donde ingenieros de Microsoft explicaron por qué "United" se convirtió en "Web App" en el nombre de la plantilla GA.
