---
title: "Solución: el WebSocket de hot reload de Blazor en dotnet watch falla en un dominio local personalizado (403)"
description: "Desde los SDK de .NET de septiembre de 2026 (10.0.112, 10.0.401, 11 RC1), dotnet watch rechaza los WebSockets de browser-refresh desde orígenes desconocidos. Define DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS con el nombre de tu host."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-10"
  - "dotnet-11"
lang: "es"
translationOf: "2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain"
translatedBy: "claude"
translationDate: 2026-09-29
---

Define `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` con el nombre de tu host personalizado (solo el host, como `myapp.localhost`, sin esquema y sin puerto) en el shell que inicia `dotnet watch` y reinícialo. Los SDK del 8 de septiembre de 2026 (10.0.112, 10.0.401, 9.0.121, 9.0.318, 8.0.131, 8.0.425 y 11.0.100-rc.1) corrigieron CVE-2026-58649. Desde entonces, el WebSocket de browser-refresh solo acepta un `Origin` de `localhost`, `127.0.0.1`, `[::1]`, o un host que incluyas en esa variable. Cualquier otro recibe un 403. Medí todo lo que sigue en macOS con el SDK 10.0.302 (antes de la corrección) y 10.0.401 (después), usando la plantilla estándar `dotnet new blazor`.

## El error en contexto

Abres la aplicación con un nombre como `http://myapp.localhost:5080`, `https://shop.test` o un alias del archivo hosts, en lugar de `localhost` a secas. La página se renderiza y el circuito propio de Blazor se conecta, pero la consola del navegador muestra esto:

```
Failed to load resource: the server responded with a status of 403 (Forbidden)
WebSocket connection to 'ws://localhost:5599/' failed:
WebSocket failed to connect.
WebSocket connection to 'wss://localhost:63038/' failed:
WebSocket failed to connect.
Unable to establish a connection to the browser refresh server.
```

Las tres últimas líneas son salida de `console.debug` de `aspnetcore-browser-refresh.js`, así que solo las ves con el nivel "Verbose" activado en las DevTools de Chrome o Edge. Los números de puerto son aleatorios a menos que los fijes. Mientras tanto, la terminal de `dotnet watch` se ve perfectamente sana:

```
dotnet watch ⌚ Files updated: ./Components/Pages/Home.razor
dotnet watch 🔥 C# and Razor changes applied in 109ms.
```

La terminal dice que el cambio se aplicó y el navegador dice lo contrario. Esa discrepancia es lo que hace tan confuso este problema. Muchas personas que lo sufren tampoco cambiaron nada en su proyecto: el SDK se actualizó por debajo mediante Visual Studio, Homebrew o un `global.json` con `rollForward: latestPatch`. El reporte en [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291) dice exactamente eso: el hot reload dejó de funcionar en `bug.dev.localhost` con el SDK 10.0.401, y fijar 10.0.400 lo hizo funcionar de nuevo.

## Por qué el socket de browser-refresh ahora devuelve 403

Bajo `dotnet watch`, las aplicaciones web reciben un pequeño script inyectado, `_framework/aspnetcore-browser-refresh.js`. Ese script abre un WebSocket hacia un servidor alojado dentro del proceso de `dotnet watch`. El servidor escucha en `127.0.0.1` en un puerto aleatorio, más un puerto WSS cuando el certificado de desarrollo está disponible. El socket transporta recargas de página, actualizaciones de CSS, deltas de Blazor WebAssembly y diagnósticos. La URL inyectada siempre apunta a `localhost`, sea cual sea el nombre de host con el que se cargó la página:

```js
// injected by dotnet watch, SDK 10.0.401
const webSocketUrls = 'ws://localhost:5599,wss://localhost:63038'.split(',');
```

Así, una página en `http://myapp.localhost:5080` hace una solicitud WebSocket de origen cruzado a `ws://localhost:5599`, y el navegador envía `Origin: http://myapp.localhost:5080` con ella. Antes de septiembre de 2026 el servidor de refresh ignoraba por completo el encabezado `Origin`. Cualquier página abierta en tu navegador, de cualquier sitio, podía conectarse a él, y el socket transporta cargas de actualización de IL y PDB. Eso es [CVE-2026-58649](https://github.com/dotnet/sdk/issues/56166), clasificado como CWE-346 (Origin Validation Error), CVSS 6,5.

La corrección ([dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198) en `release/11.0.1xx`, portada a `main` como [#56246](https://github.com/dotnet/sdk/pull/56246)) agrega esta comprobación antes de aceptar el WebSocket:

```csharp
// src/Dotnet.Watch/HotReloadClient/Web/BrowserRefreshServer.cs (SDK fix for CVE-2026-58649)
if (!Uri.TryCreate(context.Request.Headers.Origin.FirstOrDefault(), UriKind.Absolute, out var originUri) ||
    !webSocketConfig.GetAllowedOriginDomains().Contains(originUri.Host, StringComparer.OrdinalIgnoreCase))
{
    context.Response.StatusCode = StatusCodes.Status403Forbidden;
    return;
}
```

`GetAllowedOriginDomains()` devuelve `localhost`, `127.0.0.1`, `[::1]`, cada entrada de `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` y el valor de `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` si está definido. La comparación es una coincidencia exacta, sin distinguir mayúsculas, contra `Uri.Host`. No hay comodines, ni coincidencia por sufijo, ni un caso especial para `*.localhost`. Una solicitud sin encabezado `Origin` también se rechaza.

## Reproducción mínima

```bash
# .NET SDK 10.0.401, macOS 26 (any OS behaves the same)
dotnet new blazor -o BlazorRepro
cd BlazorRepro
DOTNET_WATCH_AUTO_RELOAD_WS_PORT=5599 dotnet watch run --urls http://localhost:5080
```

Fijar el puerto con `DOTNET_WATCH_AUTO_RELOAD_WS_PORT` solo facilita sondear el socket. Los navegadores basados en Chromium resuelven cualquier nombre `*.localhost` a loopback sin una entrada en el archivo hosts, así que navega a `http://myapp.localhost:5080/` y obtendrás la salida de consola anterior. Ni siquiera necesitas un navegador. Un handshake WebSocket en bruto con `curl` muestra la decisión directamente:

```bash
# .NET SDK 10.0.401, while dotnet watch is running
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: http://myapp.test:5000' \
  http://127.0.0.1:5599/
```

Ejecuté ese handshake contra ambos SDK, con distintos valores de la nueva variable:

| Encabezado `Origin` | 10.0.302 | 10.0.401 | 10.0.401 + `ORIGINS=myapp.test;bug.dev.localhost` |
|---|---|---|---|
| `http://localhost:5000` | 101 | 101 | 101 |
| `http://myapp.test:5000` | 101 | 403 | 101 |
| `https://myapp.test` | 101 | 403 | 101 |
| `http://bug.dev.localhost:5000` | 101 | 403 | 101 |
| `https://evil.example` | 101 | 403 | 403 |
| (sin `Origin`) | 101 | 403 | 403 |

En 10.0.302, el 101 (Switching Protocols) para `https://evil.example` es la vulnerabilidad en sí. En 10.0.401, todo nombre personalizado se rechaza hasta que lo incluyes en la lista.

## La solución: permite el nombre de tu host

`dotnet watch` lee la variable del entorno de su **propio** proceso cuando arranca. Defínela en el shell, el ejecutor de tareas o el contenedor que lanza `dotnet watch`, y luego reinicia el watcher. Un watcher en ejecución no la toma.

```bash
# bash / zsh, .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.localhost"
dotnet watch run --urls http://localhost:5080
```

```powershell
# PowerShell, .NET SDK 10.0.401+
$env:DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS = "myapp.localhost"
dotnet watch run
```

Para más de un nombre, sepáralos con `;` o `,`. Los espacios alrededor de cada entrada se recortan:

```bash
# .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="shop.test;admin.shop.test,api.shop.test"
```

Si inicias el watcher desde VS Code, pon la variable en la tarea, no en `launch.json`. El `env` de una configuración de lanzamiento `coreclr` va a la aplicación, y la aplicación no es el proceso que hace la comprobación:

```json
// .vscode/tasks.json, .NET SDK 10.0.401+
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "watch",
      "type": "process",
      "command": "dotnet",
      "args": ["watch", "run", "--project", "BlazorRepro/BlazorRepro.csproj"],
      "options": { "env": { "DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS": "myapp.localhost" } },
      "isBackground": true
    }
  ]
}
```

Con `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS=myapp.localhost` definido, la misma página en `http://myapp.localhost:5080` se conectó, y las ediciones llegaron al navegador sin una recarga manual. Un cambio de texto en el `Home.razor` de SSR estático y un cambio de color en `wwwroot/app.css` se reflejaron en la pestaña abierta.

## Qué se rompe realmente, y por qué algunas ediciones parecen funcionar

El síntoma depende de dónde se renderiza el componente, lo que hace que el error parezca intermitente. En 10.0.401 sin la variable, con la página abierta en `myapp.localhost`:

- **Componentes Interactive Server** (el `Counter.razor` de la plantilla con `@rendermode InteractiveServer`): las ediciones de Razor y C# **sí aparecieron**. El delta se aplica dentro del proceso del servidor, y Blazor vuelve a renderizar a través de su propio circuito SignalR (`ws://myapp.localhost:5080/_blazor`), que es del mismo origen y nunca toca el servidor de refresh.
- **Páginas SSR estáticas** (el `Home.razor` de la plantilla): las ediciones de Razor **no aparecieron**. `dotnet watch` imprimió "C# and Razor changes applied", pero solo una recarga del navegador empujada a través del socket de refresh mostraría el nuevo HTML.
- **CSS en `wwwroot`**: los cambios **no aparecieron** en ninguna página, aunque la terminal imprimió "Static asset changes applied". Las actualizaciones de CSS se entregan a través del socket de refresh.
- **Blazor WebAssembly** (independiente o el proyecto `.Client`): los deltas mismos viajan por el socket de refresh, así que el hot reload de C# y Razor para componentes de WebAssembly también se detiene (no medí este caso, pero la ruta de entrega es el mismo socket).

Así que "el hot reload funciona en la página del contador pero no en la página de inicio" es este mismo error, no dos distintos. Si no estás seguro de en qué grupo cae un componente, consulta [cómo decide Blazor qué modo de renderizado ejecuta un componente](/es/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/).

## Trampas y casos parecidos

**El valor es un nombre de host, no un origen.** La comprobación compara `Uri.Host`, así que `http://myapp.test` y `myapp.test:5000` nunca coinciden con nada. En mis pruebas, `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.test:5000,*.localhost"` y `"http://myapp.test"` siguieron devolviendo 403 para todos los orígenes personalizados. Enumera cada subdominio de forma explícita.

**`launchSettings.json` no funciona.** Las `environmentVariables` de un perfil se pasan al proceso de la aplicación. Para entonces `dotnet watch` ya construyó su lista de permitidos. Agregué la variable a ambos perfiles del `launchSettings.json` de la plantilla y aun así obtuve 403 para `myapp.test`. La misma corrección también cambió cómo llegan a la aplicación las variables del perfil de lanzamiento: ahora van por RPC al agente de hot reload en lugar de como argumentos `-e` ([CVE-2026-69806](https://github.com/dotnet/sdk/issues/56167), mismo PR). Nada de eso afecta a la configuración propia del watcher, sin embargo. Si quieres dejarlo ligado al repositorio, un script estilo `.env` o la definición de tarea de arriba es el lugar para ello.

**`DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` es otro mando distinto.** Su host también se agrega a la lista de permitidos (con `HOSTNAME=myapp.test` los orígenes de `myapp.test` devolvieron 101 en mi prueba), pero hace más que eso. Cambia el host al que se enlaza el servidor de refresh y la URL a la que se conecta el script inyectado. Kestrel trata un nombre de host que no es una IP como "escuchar en todas las interfaces", de modo que el socket pasa a ser accesible desde tu red. Usa `HOSTNAME` solo cuando el navegador realmente no puede alcanzar `localhost`, por ejemplo cuando `dotnet watch` se ejecuta dentro de un contenedor o en una máquina de desarrollo remota. Cuando solo difiere el nombre de la página, usa `ORIGINS`.

**Fijar el SDK antiguo "lo arregla" devolviendo la vulnerabilidad.** Un `global.json` fijado a 10.0.400 o 10.0.302 hace desaparecer el 403, porque esos SDK aceptan cualquier origen, `https://evil.example` incluido. Trátalo como un paso de diagnóstico, no como una solución.

**La tabla del aviso y las notas de la versión no coinciden en los números de versión.** El aviso lista 10.0.111 y 10.0.400 como "corregidas". Los [metadatos de la versión](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json) ubican CVE-2026-58649 en la versión del 8 de septiembre (runtime 10.0.12, SDK 10.0.112 y 10.0.401). La medición y quien reportó el problema coinciden con los metadatos de la versión: 10.0.400 acepta cualquier origen, y 10.0.401 aplica la comprobación. Las etiquetas públicas `v10.0.400` y `v10.0.401` apuntan al mismo commit porque las correcciones de seguridad se compilan desde el repositorio interno, así que no te molestes en comparar las etiquetas.

**Un 403 en la página misma es otra cosa.** Si todo el documento devuelve 403, revisa qué está escuchando realmente en ese puerto. En macOS, el puerto 5000 pertenece al receptor de AirPlay del Centro de control, que responde 403 para cualquier ruta. Los navegadores pueden resolver `*.localhost` a `::1` antes que a `127.0.0.1`, así que un Kestrel enlazado solo a `127.0.0.1:5000` pierde esa conexión frente a AirPlay. Me topé exactamente con esto mientras armaba la reproducción, por eso los comandos de arriba usan `--urls http://localhost:5080`.

**¿Sin dominio personalizado y aun así sin refresh?** Si navegas a `localhost` y el socket sigue fallando, la causa está en otra parte: una página HTTPS que intenta `wss://` sin un certificado de desarrollo de confianza, `DOTNET_WATCH_SUPPRESS_BROWSER_REFRESH=1` olvidado en el entorno, o un middleware que reescribe la respuesta de modo que el script nunca se inyecta. [Qué agrega dotnet watch sobre dotnet run](/es/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) recorre la inyección y las variables de entorno que define.

**Esto desaparecerá más adelante.** En la rama `main` del SDK, [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118) (fusionado el 2026-09-21) enruta el WebSocket de las herramientas del navegador a través del origen propio de la aplicación y lo reenvía a un proveedor solo de loopback. En ese diseño la página y el socket comparten origen, y un comentario en el código dice que `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` "no longer applies to this hop". Ese cambio no se ha publicado en ningún SDK al momento de escribir esto, así que en 10.0.401 y 11 RC1 todavía necesitas la variable.

## Relacionado

Esta es la segunda vez que una actualización del SDK rompe en silencio una aplicación Blazor sin un solo cambio en el proyecto. La primera fue [el 404 de blazor.server.js tras instalar el SDK de .NET 10](/es/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/). Para lo que `dotnet watch` ha ganado recientemente además del socket del navegador, consulta [dotnet watch en .NET 11 Preview 3 con hosts de Aspire y recuperación ante fallos](/es/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/). Si usas Visual Studio en lugar de la CLI, [el reinicio automático de Hot Reload en Visual Studio 2026](/es/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) explica cómo el IDE maneja las ediciones que no puede aplicar. No probé la conexión propia de Visual Studio con el navegador para esta publicación.

## Fuentes

- [Aviso de CVE-2026-58649, dotnet/sdk#56166](https://github.com/dotnet/sdk/issues/56166), y el [anuncio, dotnet/announcements#441](https://github.com/dotnet/announcements/issues/441).
- [dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198), la corrección, que documenta `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` como salida de emergencia para dominios personalizados, y su port a `main` [#56246](https://github.com/dotnet/sdk/pull/56246).
- [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291), el reporte de regresión sobre `*.dev.localhost` con el SDK 10.0.401 y la solución alternativa del mantenedor.
- [`EnvironmentVariables.cs` en dotnet/sdk](https://github.com/dotnet/sdk/blob/main/src/Dotnet.Watch/Watch/Context/EnvironmentVariables.cs), para los nombres de variables, separadores y valores predeterminados.
- [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118), el rediseño de las herramientas del navegador con el mismo origen en `main`.
- [Metadatos de versión de .NET 10](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json), para saber qué compilaciones del SDK incluyen la corrección.
