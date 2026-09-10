---
title: "Solución: IsAuthenticated es false y RemoteUserAccount es null en Blazor WebAssembly tras actualizar MSAL"
description: "Microsoft.Authentication.WebAssembly.Msal 10.0.8, 9.0.16 y 8.0.27 pasaron a msal.js 4, cuyo init asíncrono compite consigo mismo. Inicializa MSAL una vez en Program.cs o fija la versión 10.0.7."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "blazor"
  - "blazor-webassembly"
  - "authentication"
  - "msal"
  - "entra-id"
  - "dotnet-10"
  - "aspnet-core"
lang: "es"
translationOf: "2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade"
translatedBy: "claude"
translationDate: 2026-09-10
---

Si el inicio de sesión en una aplicación Blazor WebAssembly dejó de funcionar al pasar `Microsoft.Authentication.WebAssembly.Msal` de 10.0.7 a 10.0.8 o posterior (o de 9.0.15 a 9.0.16, o de 8.0.26 a 8.0.27), no estás ante un problema de configuración. Esas versiones sustituyeron el msal.js 2.39.0 incluido por el 4.30.0, y ahora el `init` de JavaScript del paquete puede ejecutarse dos veces al mismo tiempo, creando dos clientes MSAL que se pisan entre sí. La solución es hacer que MSAL se inicialice exactamente una vez antes de que se renderice el primer componente: espera `GetAuthenticationStateAsync()` en `Program.cs` antes de `RunAsync()`. Fijar el paquete en 10.0.7 también funciona, pero solo como parche temporal. Al 2026-09-10, 10.0.12 es la versión más reciente y sigue afectada.

## El error en contexto

La misma regresión llega a la gente a través de síntomas distintos, y cada uno tiene su propio issue en `dotnet/aspnetcore`. El reporte original, [dotnet/aspnetcore#66978](https://github.com/dotnet/aspnetcore/issues/66978), describe una aplicación que funcionaba en 10.0.7 donde, tras actualizar a 10.0.8 sin ningún otro cambio, `User.Identity.IsAuthenticated` siempre es `false` y el `RemoteUserAccount` que recibe un `AccountClaimsPrincipalFactory.CreateUserAsync` personalizado durante el callback de inicio de sesión es `null`. Lo único que aparece en la consola es el registro de autorización:

```
info: Microsoft.AspNetCore.Authorization.DefaultAuthorizationService[2]
      Authorization failed. These requirements were not met:
      DenyAnonymousAuthorizationRequirement: Requires an authenticated user.
```

Después, quien reportó el problema hizo el experimento decisivo: copiar el `AuthenticationService.js` de 10.0.7 en la aplicación con 10.0.8 lo arregló sin ningún otro cambio. El bug está en la capa de JavaScript.

[dotnet/aspnetcore#68549](https://github.com/dotnet/aspnetcore/issues/68549) muestra la variante ruidosa. En 10.0.10, recargar una página autenticada en Firefox falla con una excepción lanzada desde `_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js`:

```
uninitialized_public_client_application: You must call and await the initialize function before attempting to call any other MSAL API.
```

Edge no lo reprodujo. [dotnet/aspnetcore#68136](https://github.com/dotnet/aspnetcore/issues/68136) es la variante silenciosa: el inicio de sesión funciona, pero `InteractiveRequestOptions.ReturnUrl` se ignora y todos los usuarios terminan en `/`. Los comentarios en #66978 añaden que el cierre de sesión se queda colgado de 10.0.8 a 10.0.10. Los cuatro síntomas comparten una sola causa.

## Qué cambió en 10.0.8

`Microsoft.Authentication.WebAssembly.Msal` no referencia msal.js desde un CDN. Compila `@azure/msal-browser` dentro del recurso estático `AuthenticationService.js` que carga tu `index.html`. msal.js 2.x llegó al fin de su vida útil y el análisis de component governance de Microsoft lo marcó, así que [dotnet/aspnetcore#66055](https://github.com/dotnet/aspnetcore/pull/66055) lo movió a `^4.30.0` para .NET 11 preview 4 y se portó a todas las líneas con soporte: [#66094](https://github.com/dotnet/aspnetcore/pull/66094) para 10.0, [#66234](https://github.com/dotnet/aspnetcore/pull/66234) para 9.0 y [#66236](https://github.com/dotnet/aspnetcore/pull/66236) para 8.0. Las tres versiones de servicio se publicaron el 2026-05-12. Revisé los archivos publicados en lugar de fiarme de los milestones: el `AuthenticationService.js` de 10.0.7 incluye msal-browser 2.39.0 y el de 10.0.12 incluye 4.30.0.

| Línea | Última versión con msal.js 2 | Primera versión con msal.js 4 |
| ---- | --------------------------- | ---------------------------- |
| .NET 8 | 8.0.26 | 8.0.27 |
| .NET 9 | 9.0.15 | 9.0.16 |
| .NET 10 | 10.0.7 | 10.0.8 |
| .NET 11 | 11.0.0-preview.3 | 11.0.0-preview.4 (RC 1 incluida) |

## Por qué la actualización de msal.js rompe el inicio de sesión

msal-browser 3.0 introdujo un cambio que importa aquí: un `PublicClientApplication` ya no se puede usar justo después de construirlo. Primero hay que llamar a `initialize()` y esperarlo, según la [guía de migración de v2 a v3](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md). El paquete de Blazor añadió esa llamada en el lugar obvio, en medio de su `init` estático:

```ts
// Microsoft.Authentication.WebAssembly.Msal 10.0.8 through 10.0.12 (msal-browser 4.30.0)
public static async init(settings: AuthorizeServiceConfiguration, jsLoggingOptions: JavaScriptLoggingOptions) {
    if (!AuthenticationService._initialized) {
        AuthenticationService.instance = new MsalAuthorizeService(settings, new Logger(jsLoggingOptions));
        await AuthenticationService.instance.initialize(); // new in 10.0.8
        AuthenticationService.instance.initializeMsalHandler();
        AuthenticationService._initialized = true;
    }
    return Promise.resolve();
}
```

En 10.0.7 la línea con `await` no existía. Entre leer `_initialized` y asignarlo no había ningún punto de suspensión y, como JavaScript se ejecuta en un solo hilo, todo el bloque era atómico. Una segunda llamada siempre veía `_initialized === true` y no hacía nada. Ahora la bandera se asigna solo después de un `await`, así que una segunda llamada que llega mientras la primera está suspendida también pasa la comprobación.

Y esa segunda llamada sí llega, porque el lado de C# tiene la misma forma desde hace años. Este es `RemoteAuthenticationService` en `Microsoft.AspNetCore.Components.WebAssembly.Authentication` 10.0.x:

```csharp
// Microsoft.AspNetCore.Components.WebAssembly.Authentication 10.0.x
private async ValueTask EnsureAuthService()
{
    if (!_initialized)
    {
        await JsRuntime.InvokeVoidAsync("AuthenticationService.init", Options.ProviderOptions, _loggingOptions);
        _initialized = true;
    }
}
```

Todos los puntos de entrada lo llaman: `GetAuthenticationStateAsync`, `RequestAccessToken`, `SignInAsync`, `CompleteSignInAsync`, `SignOutAsync` y `CompleteSignOutAsync`. Si dos de ellos arrancan antes de que termine el primer `init` de JS, ambos lo invocan. Eso era inofensivo mientras el JS era atómico. Con msal.js 4 cada llamada construye su propio `MsalAuthorizeService`, cada una llama a `initialize()` y luego a `handleRedirectPromise()`, y la segunda asignación sobrescribe `AuthenticationService.instance`. A partir de ahí, cada método estático, `getUser`, `completeSignIn` y `signOut`, habla con la última instancia asignada. Esa instancia puede seguir inicializándose, o puede ser la que perdió la carrera por procesar la respuesta de la redirección.

Eso explica los síntomas. Si `getUser` llega a la segunda instancia antes de que su `initialize()` se resuelva, lanza `uninitialized_public_client_application`, y que eso ocurra depende del orden de las promesas, por eso Firefox lo muestra y Edge no. Blazor guarda la URL de retorno en `sessionStorage` y la borra en la primera lectura, así que cuando dos instancias procesan un mismo callback, una de ellas se queda sin estado y `RemoteAuthenticatorView` vuelve a `/`. Ese es el diagnóstico que publicó un comentarista en #68136, junto con un borrador de corrección que hace que `init` devuelva una única promesa compartida. Y cuando `completeSignIn` le pregunta a la instancia que no procesó la respuesta, no vuelve ninguna cuenta, `CreateUserAsync` recibe `null` y el usuario sigue siendo anónimo.

## Reproducción mínima

La doble inicialización se demuestra fácilmente sin un tenant de Entra. Crea la plantilla con IDs de ejemplo, en el .NET SDK 10.0.302:

```bash
dotnet new blazorwasm -au SingleOrg --client-id "00001111-aaaa-2222-bbbb-3333cccc4444" --tenant-id "aaaabbbb-0000-cccc-1111-dddd2222eeee" -o MsalRepro
```

Pon las tres referencias de paquete en 10.0.12. La plantilla sola no presenta la condición de carrera: `AuthorizeRouteView` espera el estado de autenticación antes de renderizar `RemoteAuthenticatorView`, así que el primer `init` ya terminó cuando algo más pregunta. Las aplicaciones reales rara vez se quedan así de simples. Basta con cualquier cosa fuera de la barrera de autorización que toque la autenticación al arrancar, por ejemplo un componente de layout que carga datos a través del `HttpClient` autorizado. `AuthorizeRouteView` renderiza el layout mientras todavía está autorizando, así que esto se ejecuta en paralelo con el primer `GetAuthenticationStateAsync`:

```razor
@* Layout/NavMenu.razor, .NET 10, Microsoft.Authentication.WebAssembly.Msal 10.0.12 *@
@using Microsoft.AspNetCore.Components.WebAssembly.Authentication
@inject IAccessTokenProvider TokenProvider

@code {
    protected override async Task OnInitializedAsync()
    {
        // Same effect as any startup call through the authorized HttpClient.
        await TokenProvider.RequestAccessToken();
    }
}
```

Para contar lo que pasa, carga un pequeño script de diagnóstico justo después de `AuthenticationService.js` que envuelve `init` y vigila las asignaciones a `AuthenticationService.instance`:

```js
// wwwroot/probe.js, diagnostic only. Load after AuthenticationService.js.
(() => {
  const svc = window.AuthenticationService;
  const probe = window.__probe = { initCalls: 0, instances: 0 };
  let current;
  Object.defineProperty(svc, 'instance', {
    configurable: true,
    get: () => current,
    set: v => { probe.instances++; current = v; }
  });
  const init = svc.init;
  svc.init = function (...args) { probe.initCalls++; return init.apply(svc, args); };
})();
```

Cargué `/` y `/authentication/login-callback` en un navegador basado en Chromium y leí `window.__probe` después del arranque. Ambas rutas dieron los mismos números:

| Configuración | Llamadas a `init` | Instancias de MSAL creadas |
| ----- | ------------ | ---------------------- |
| Msal 10.0.12 | 2 | 2 |
| Msal 10.0.7 (msal.js 2.39.0) | 2 | 1 |
| Msal 10.0.12 + preinicialización en `Program.cs` (solución 1) | 1 | 1 |
| Msal 10.0.12 + shim de `init` idempotente (solución 2) | 2 | 1 |

La fila de 10.0.7 es la útil: la doble llamada desde C# siempre existió, y el `init` síncrono de msal.js 2 la absorbía. Sin un registro de aplicación de Entra desechable no pude completar un inicio de sesión real con la versión rota, así que la relación entre la segunda instancia y cada síntoma sale del código y de los hilos de los issues citados arriba. La doble instancia en sí está medida.

## La solución, en detalle

### 1. Inicializa MSAL una vez en Program.cs

Llama al proveedor del estado de autenticación una vez, después de `Build()` y antes de `RunAsync()`:

```csharp
// .NET 10, Microsoft.Authentication.WebAssembly.Msal 10.0.12
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using MsalRepro;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });

builder.Services.AddMsalAuthentication(options =>
{
    builder.Configuration.Bind("AzureAd", options.ProviderOptions.Authentication);
});

var host = builder.Build();

// Run AuthenticationService.init to completion before any component can race it.
await host.Services.GetRequiredService<AuthenticationStateProvider>().GetAuthenticationStateAsync();

await host.RunAsync();
```

En ese punto todavía no existe ningún componente, así que nada puede solaparse con la llamada. `EnsureAuthService` se ejecuta hasta el final, lo que asigna la bandera `_initialized` de C# y la de JavaScript, y cualquier llamada posterior se salta `init` por completo. La interoperabilidad con JavaScript está disponible en un host de WebAssembly antes de `RunAsync`, y en mi reproducción esto bajó el conteo a una llamada a `init` y una instancia en ambas rutas.

El costo es que el primer renderizado espera a que MSAL se inicialice y lea su caché, trabajo que la aplicación hacía de todos modos unos milisegundos después. Si tu `AccountClaimsPrincipalFactory` llama a Microsoft Graph o a tu propia API en `CreateUserAsync`, esa llamada también se adelanta al primer renderizado. Mantenla ligera o acepta un primer pintado un poco más tardío.

### 2. O haz que init sea idempotente en JavaScript

Si no controlas el arranque, por ejemplo porque una biblioteca de componentes compartida dispara solicitudes de token que no son tuyas, corrige la condición de carrera donde está: en `init`. Este shim memoriza la promesa, que es también lo que hace dentro del paquete el borrador de corrección de #68136:

```js
// wwwroot/msal-init-fix.js
// Workaround for dotnet/aspnetcore#66978, #68549, #68136
// (Microsoft.Authentication.WebAssembly.Msal 8.0.27+, 9.0.16+, 10.0.8+).
(() => {
  const svc = window.AuthenticationService;
  if (!svc || svc.__initFixApplied) return;
  const originalInit = svc.init;
  let pending;
  svc.init = function (settings, loggingOptions) {
    pending ??= originalInit.call(svc, settings, loggingOptions)
      .catch(e => { pending = undefined; throw e; });
    return pending;
  };
  svc.__initFixApplied = true;
})();
```

El orden de los scripts importa. Tiene que ejecutarse después de que el script del paquete defina `window.AuthenticationService` y antes de que arranque Blazor:

```html
<!-- wwwroot/index.html -->
<script src="_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js"></script>
<script src="msal-init-fix.js"></script>
<script src="_framework/blazor.webassembly#[.{fingerprint}].js"></script>
```

C# sigue llamando a `init` dos veces, pero ahora ambas llamadas esperan la misma promesa y solo se crea un `MsalAuthorizeService`. El `.catch` limpia la caché para que una inicialización fallida se pueda reintentar en lugar de fallar para siempre. Funciona porque Blazor invoca `AuthenticationService.init` por nombre a través de `window` en cada llamada, así que basta con reemplazar la propiedad.

### 3. O fija el paquete en 10.0.7

```xml
<!-- .NET 10: last Msal release that bundles msal.js 2.39.0 -->
<PackageReference Include="Microsoft.Authentication.WebAssembly.Msal" Version="10.0.7" />
```

Los equivalentes son 9.0.15 y 8.0.26. Puedes mantener `Microsoft.AspNetCore.Components.WebAssembly` en 10.0.12: esa combinación compila y la aplicación sirve el bundle 2.39.0. Ten en cuenta que fijar la versión arrastra `Microsoft.AspNetCore.Components.WebAssembly.Authentication` a 10.0.7 como dependencia transitiva. El precio es distribuir un msal.js al final de su vida útil, que es justo la razón por la que Microsoft actualizó, así que trátalo como un puente. Confirma lo que el navegador recibe realmente:

```bash
curl -s http://localhost:5117/_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js | grep -oE '"(2\.39\.0|4\.30\.0)"'
```

Después de cualquier cambio de versión, borra los datos del sitio en el navegador con el que pruebas. La caché de MSAL y el estado que Blazor guarda en `sessionStorage` sobreviven a las actualizaciones de la aplicación, algo que la [sección de solución de problemas de Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id#cookies-and-site-data) señala precisamente para este tipo de pruebas.

## Trampas y errores parecidos

**Usuarios desconectados al cerrar el navegador, con `CacheLocation = "localStorage"`.** Esto es msal.js 4 funcionando según su diseño, no la condición de carrera. Desde v4, MSAL cifra la caché de `localStorage` con AES-GCM y guarda la clave en una cookie de sesión llamada `msal.cache.encryption` (presente en el bundle de 10.0.12). La [guía de migración de v3 a v4](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md) dice que la clave se elimina al cerrar el navegador, de modo que `localStorage` ya no persiste entre sesiones del navegador. Ninguna de las soluciones anteriores cambia eso. Prevé un inicio de sesión silencioso o interactivo después de reiniciar el navegador.

**El inicio de sesión silencioso falla solo en hosts con IP privadas.** Si la aplicación corre en `192.168.x.x` o `10.x.x.x` y Chrome 142 o posterior bloquea el iframe oculto con `LocalNetworkAccessPermissionDenied`, se trata de la restricción Local Network Access de Chrome, registrada en [dotnet/aspnetcore#64699](https://github.com/dotnet/aspnetcore/issues/64699). Aparece con cualquier versión del paquete.

**Las aplicaciones con `AddOidcAuthentication` no se ven afectadas por este cambio.** El cambio de msal.js solo tocó el script de interoperabilidad del paquete Msal. Si usas el proveedor OIDC genérico, o una Blazor Web App que autentica en el servidor, busca en otra parte.

**Cuando llegue la corrección, los parches son inofensivos.** Los tres issues están abiertos en el milestone 10.0.x sin ninguna corrección fusionada al 2026-09-10. Dejar la llamada en `Program.cs` no cuesta nada después. El shim se convierte en un envoltorio sin efecto, y puedes borrarlo cuando `AuthenticationService.init` guarde una promesa en lugar de un booleano.

Si se trata de una aplicación nueva y no de una rota, vale la pena leer primero [Blazor Server vs WebAssembly vs United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/). La autenticación del lado del servidor evita por completo los tokens en el navegador.

## Relacionado

- [Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [JWT vs autenticación por cookies en ASP.NET Core 11](/es/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/), para el lado de la API de un cliente WebAssembly.
- [Qué es un modo de renderizado de Blazor y cuál ejecuta mi componente](/es/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [SignalR en .NET 11 RC 1 cambia un token que expira sin cortar la conexión](/es/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/)

## Fuentes

- [dotnet/aspnetcore#66978, problema de autenticación MSAL tras actualizar a 10.0.8](https://github.com/dotnet/aspnetcore/issues/66978)
- [dotnet/aspnetcore#68549, `uninitialized_public_client_application` tras recargar en Firefox con 10.0.10](https://github.com/dotnet/aspnetcore/issues/68549)
- [dotnet/aspnetcore#68136, `RemoteAuthenticatorView` ignora `ReturnUrl` en 10.0.10](https://github.com/dotnet/aspnetcore/issues/68136)
- [dotnet/aspnetcore#66055, actualizar `@azure/msal-browser` a 4.x](https://github.com/dotnet/aspnetcore/pull/66055), y sus backports [#66094](https://github.com/dotnet/aspnetcore/pull/66094), [#66234](https://github.com/dotnet/aspnetcore/pull/66234), [#66236](https://github.com/dotnet/aspnetcore/pull/66236)
- [`AuthenticationService.ts` en `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/Authentication.Msal/src/Interop/AuthenticationService.ts)
- [`RemoteAuthenticationService.cs` en `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/WebAssembly.Authentication/src/Services/RemoteAuthenticationService.cs)
- [Proteger una aplicación independiente de Blazor WebAssembly con Microsoft Entra ID](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id)
- [Guía de migración de msal-browser de v2 a v3](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md) y [guía de migración de v3 a v4](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md)
- [Microsoft.Authentication.WebAssembly.Msal en NuGet](https://www.nuget.org/packages/Microsoft.Authentication.WebAssembly.Msal)
