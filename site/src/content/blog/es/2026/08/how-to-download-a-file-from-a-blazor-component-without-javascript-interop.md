---
title: "Cómo descargar un archivo desde un componente Blazor sin interoperabilidad con JavaScript"
description: "Olvídate del módulo JS downloadFileFromStream. Renderiza un ancla con el atributo download que apunte a un endpoint de minimal API que devuelva TypedResults.File, o envía por POST un formulario HTML simple con un AntiforgeryToken. Incluye por qué el atributo download es lo que impide que la navegación mejorada de Blazor se trague el clic, por qué data-enhance descarta el archivo en silencio y la trampa de cookies frente a bearer."
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "minimal-apis"
lang: "es"
translationOf: "2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop"
translatedBy: "claude"
translationDate: 2026-08-16
---

Para descargar un archivo desde un componente Blazor sin escribir una sola línea de JavaScript, renderiza un elemento `<a>` simple cuyo `href` apunte a un endpoint que devuelva `TypedResults.File` y que tenga presente el atributo `download`. Ese es todo el truco. El atributo `download` no es solo una sugerencia de nombre de archivo: es la marca que hace que la navegación mejorada de Blazor omita el clic y deje que el navegador realice una navegación real, que la cabecera `Content-Disposition: attachment` convierte luego en una descarga. Para archivos cuyo contenido depende de lo que escriba el usuario, envía por POST un `<form>` HTML simple con un `<AntiforgeryToken />` al mismo tipo de endpoint. Todo lo que sigue apunta a .NET 11 y C# 14, y fue verificado de principio a fin contra una Blazor Web App ejecutándose sobre ASP.NET Core 10.0.5, donde el comportamiento es idéntico. Las APIs no han cambiado desde .NET 8.

## Por qué la guía oficial recurre a la interoperabilidad con JS, y cuándo puedes ignorarla

La [documentación de descargas de archivos en Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads) te ofrece dos recetas, y ambas empiezan diciéndote que agregues un archivo `.js`. La receta para archivos pequeños envuelve un `Stream` en un `DotNetStreamReference`, lo envía a una función JS `downloadFileFromStream` y lo reconstruye como un `Blob` y una object URL en el cliente. La receta para archivos grandes llama a una función JS `triggerFileDownload` que construye un `HTMLAnchorElement` en script y dispara un `click` sintético sobre él.

Lee esa segunda otra vez. El JavaScript existe para crear un elemento ancla y hacerle clic. Estás dentro de un framework de UI cuyo trabajo entero es renderizar elementos HTML. Puedes renderizar el ancla tú mismo.

La ruta sin JS no es solo menos código: esquiva toda una clase de errores en la que la ruta de interoperabilidad cae de lleno. `IJSRuntime` no se puede usar mientras un componente está en prerenderizado, y por eso [las llamadas de interoperabilidad con JavaScript no se pueden emitir en este momento](/es/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) es una de las excepciones más comunes de Blazor. Tampoco está disponible en componentes que usan renderizado estático del lado del servidor (static SSR), porque no hay circuito ni runtime de WebAssembly al que llamar. Un ancla funciona en todos los modos de renderizado, incluido static SSR, sin ninguna regla de ciclo de vida.

Existe exactamente un escenario donde realmente necesitas interoperabilidad: una app Blazor WebAssembly independiente que genera bytes en el cliente y debe guardarlos sin ida y vuelta al servidor. Incluso ahí, un URI `data:` te lleva casi todo el camino, y cubro los límites al final.

## El atributo download es lo que impide que Blazor se coma tu clic

Esta es la parte que nadie explica, y es la razón por la que el consejo de "usa un ancla y ya" falla tan a menudo en una Blazor Web App.

Las Blazor Web Apps habilitan la navegación mejorada de forma predeterminada. Un manejador de clics a nivel de documento intercepta los enlaces internos, obtiene el destino con `fetch` y parchea el HTML devuelto dentro del DOM existente en lugar de hacer una carga completa de página. Eso es excelente para páginas y catastrófico para un CSV.

La cláusula de guarda del interceptor es visible en el `blazor.web.js` que se distribuye:

```js
return (!t || "_self" === t) && e.hasAttribute("href") && !e.hasAttribute("download")
```

Un ancla es candidata a interceptación solo cuando tiene un `href` y **no** tiene un atributo `download`. El atributo es una exclusión deliberada, integrada en el framework.

Déjalo fuera y esto es lo que pasa de verdad, medido en un navegador contra una app en ejecución. Hacer clic en `<a href="/exports/orders.csv">` produce:

```text
[warn] Enhanced navigation failed for destination http://localhost:5248/exports/orders.csv.
       Falling back to full page load.
```

La barra de direcciones cambia a `/exports/orders.csv?`, con un signo de interrogación suelto incluido, mientras el DOM sigue mostrando la página anterior. El registro de red muestra el endpoint golpeado **dos veces**: primero por el `fetch` de la navegación mejorada, que no supo qué hacer con `text/csv`, y luego por la navegación de documento de respaldo que el navegador finalmente entrega al gestor de descargas. Tu consulta de exportación se ejecuta dos veces, la URL del usuario queda mal y el archivo llega igual, que es la peor combinación posible porque parece que funciona.

Agrega `download` y nada de eso ocurre. El clic nunca se intercepta, la URL nunca cambia, sale una sola solicitud y vuelve un solo archivo.

## Pasos para armar una descarga sin JS

1. **Escribe un endpoint que devuelva el archivo.** Un `MapGet` de minimal API que devuelva `TypedResults.File`, `TypedResults.Bytes` o `TypedResults.Stream` establece `Content-Disposition: attachment` por ti cuando le pasas `fileDownloadName`.
2. **Renderiza un ancla que apunte a él, con el atributo `download` presente.** No lo omitas, ni siquiera cuando el endpoint ya establece `Content-Disposition`.
3. **Para exportaciones con parámetros, usa un `<form method="post">` simple** dirigido al endpoint, con un `<AntiforgeryToken />` dentro y sin atributo `data-enhance`.
4. **Asegúrate de que el endpoint autentique como lo hace una navegación del navegador**, es decir, con cookies y no con una cabecera `Authorization`.
5. **Verifica las cabeceras de la respuesta**, no el diálogo de guardado del navegador. `curl -I` contra el endpoint debería mostrar `Content-Disposition: attachment` y el nombre de archivo que esperas.

## El endpoint: tres formas de TypedResults

Para contenido que ya cabe en memoria, entrégale al endpoint un `byte[]`:

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders.csv", () =>
{
    var csv = new StringBuilder("Id,Customer,Total\n");
    foreach (var order in OrderStore.Recent())
    {
        csv.Append(CultureInfo.InvariantCulture, $"{order.Id},{order.Customer},{order.Total}\n");
    }

    return TypedResults.File(
        Encoding.UTF8.GetBytes(csv.ToString()),
        contentType: "text/csv",
        fileDownloadName: "orders.csv");
});
```

Eso produce exactamente las cabeceras que un navegador necesita:

```text
HTTP/1.1 200 OK
Content-Length: 75
Content-Type: text/csv
Content-Disposition: attachment; filename=orders.csv; filename*=UTF-8''orders.csv
```

Fíjate en los parámetros `filename` y `filename*` duplicados. ASP.NET Core emite la forma de RFC 6266 automáticamente, y eso es lo que hace que los nombres de archivo con caracteres no ASCII sobrevivan al viaje.

Para cualquier cosa lo bastante grande como para que almacenarla en memoria sea un riesgo, usa `TypedResults.Stream` con un callback y escribe directamente en el cuerpo de la respuesta:

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders-stream.csv", (IOrderQuery query, CancellationToken ct) =>
    TypedResults.Stream(
        async stream =>
        {
            await using var writer = new StreamWriter(stream, new UTF8Encoding(false), leaveOpen: true);
            await writer.WriteLineAsync("Id,Customer,Total");

            await foreach (var order in query.StreamAsync(ct))
            {
                await writer.WriteLineAsync($"{order.Id},{order.Customer},{order.Total}");
            }
        },
        contentType: "text/csv",
        fileDownloadName: "orders-stream.csv"));
```

Esto responde con `Transfer-Encoding: chunked` y sin `Content-Length`, así que el usuario no obtiene barra de progreso, pero el servidor nunca retiene la exportación completa. La misma disyuntiva aplica siempre que necesites [transmitir un archivo desde un endpoint de ASP.NET Core sin almacenarlo en memoria](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

El `new UTF8Encoding(false)` es deliberado. El `Encoding.UTF8` predeterminado de `StreamWriter` tiene habilitado el preámbulo BOM, así que la versión atajo escribe tres bytes sueltos antes de tu fila de encabezado. Me topé con esto en la app de prueba: el endpoint de `byte[]` produjo una salida limpia porque `Encoding.UTF8.GetBytes` nunca emite un preámbulo, mientras que el endpoint de streaming prefijó `Id,Customer,Total` con un BOM. Para un CSV abierto en Excel ese BOM es justo lo que quieres, así que elige según el formato en vez de por accidente.

Si el archivo ya existe en disco, sáltate el búfer por completo: `TypedResults.File(File.OpenRead(path), "application/pdf", "manual.pdf", enableRangeProcessing: true)`. El procesamiento de rangos permite al navegador reanudar una descarga interrumpida.

## Static SSR: un ancla y un formulario simple, sin circuito

Aquí hay un componente que adopta static SSR, no tiene modo de renderizado, no tiene `@onclick` y descarga dos archivos distintos:

```razor
@* .NET 11, static SSR, no render mode *@
@page "/exports"

<h1>Exports</h1>

<a href="/exports/orders.csv" download>Download today's orders</a>

<a href="/exports/orders.csv" download="orders-2026-08.csv">Download with a custom name</a>

<form method="post" action="/exports/orders">
    <AntiforgeryToken />
    <label>
        Rows
        <input type="number" name="maxRows" value="500" />
    </label>
    <input type="hidden" name="format" value="csv" />
    <button type="submit">Export</button>
</form>
```

La segunda ancla muestra lo único que el atributo `download` hace más allá de excluirse de la navegación mejorada: su valor sobrescribe el nombre de archivo sugerido por el servidor. Déjalo vacío cuando el `fileDownloadName` del endpoint ya sea el correcto.

El formulario es un `<form>` HTML simple con un `action`, no un `EditForm`, y no lleva `@formname` ni `@onsubmit`. Eso es intencional. Un `EditForm` publica de vuelta hacia el componente Blazor, y el trabajo de un componente es renderizar HTML, así que no hay manera de que devuelva un archivo. Publicar hacia un endpoint separado es el único camino que termina en una descarga.

`<AntiforgeryToken />` renderiza un campo oculto `__RequestVerificationToken`. Es obligatorio, porque un endpoint de minimal API que enlaza parámetros `[FromForm]` está cubierto por la validación antifalsificación desde .NET 8. Publica sin el token y obtienes un `400` pelado:

```csharp
// .NET 11, C# 14
app.MapPost("/exports/orders", ([FromForm] string format, [FromForm] int maxRows) =>
{
    var bytes = ExportBuilder.Build(format, maxRows);

    return TypedResults.File(bytes, "text/csv", $"orders.{format}");
});
```

Con `app.UseAntiforgery()` en el pipeline y el token en el formulario, esto devuelve el archivo directamente al navegador. Sin circuito, sin payload de WebAssembly, sin JavaScript.

.NET 11 agrega una segunda capa aquí. La protección CSRF automática basada en cabeceras está activada de forma predeterminada para apps construidas con `WebApplication.CreateBuilder`, inspeccionando `Sec-Fetch-Site` y `Origin` en métodos no seguros, y los envíos de formularios de Blazor SSR devuelven `400 Bad Request` para publicaciones de origen cruzado no confiables. La validación de token sigue ejecutándose solo si llamas a `UseAntiforgery`, y cuando ambas están presentes gana el veredicto del token. Si un formulario que funcionaba en .NET 10 empieza a devolver 400 tras la actualización, ese middleware es lo primero que hay que revisar. Repasé su comportamiento en detalle cuando [ASP.NET Core 11 activó la protección CSRF automática](/es/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/).

## Modos de renderizado interactivos: entrégale al cliente una URL, no bytes

En un componente interactivo el instinto es hacer que el manejador del botón produzca un `byte[]` y luego buscar alguna forma de empujarlo hacia el navegador. Dale la vuelta. Haz que el manejador prepare la exportación en el servidor, la guarde detrás de un token y renderice un ancla:

```razor
@* .NET 11, C# 14 *@
@page "/reports"
@rendermode InteractiveServer
@inject IReportService Reports

<button @onclick="Prepare" disabled="@_working">Prepare export</button>

@if (_token is not null)
{
    <a href="@($"/exports/report/{_token}")" download="report.csv">Your export is ready</a>
}

@code {
    private string? _token;
    private bool _working;

    private async Task Prepare()
    {
        _working = true;
        _token = await Reports.QueueExportAsync();
        _working = false;
    }
}
```

El usuario hace dos clics, lo cual es una UI honesta para una exportación que de todos modos toma tiempo real, y los bytes nunca viajan por el circuito de SignalR.

Si insistes en un solo clic, `NavigationManager.NavigateTo(url, forceLoad: true)` funciona y sigue sin involucrar código de interoperabilidad tuyo. Como la respuesta lleva `Content-Disposition: attachment`, el navegador inicia una descarga y abandona la navegación. Confirmé que la URL de la SPA queda intacta después: era `/interactive` antes de la llamada y `/interactive` después, con el archivo entregado.

```csharp
// .NET 11, C# 14
private void Download() => Nav.NavigateTo("/exports/orders-stream.csv", forceLoad: true);
```

La salvedad es que esto es una navegación, así que si el endpoint devuelve un `404` o un `500` en lugar de un archivo, el navegador te saca de tu app hacia una página de error. Un ancla falla igual, pero al menos el usuario eligió hacer clic.

## Blazor WebAssembly sin servidor: la salida de emergencia del URI data

Cuando los bytes se producen en el cliente y no hay ningún endpoint al que apuntar, pásalos a base64 dentro del `href`:

```razor
@* .NET 11, C# 14, Blazor WebAssembly *@
@rendermode InteractiveWebAssembly

<button @onclick="Build">Build report</button>

@if (_href is not null)
{
    <a href="@_href" download="client-report.csv">Save client-report.csv</a>
}

@code {
    private string? _href;

    private void Build()
    {
        var bytes = Encoding.UTF8.GetBytes(ReportBuilder.ToCsv());
        _href = $"data:text/csv;base64,{Convert.ToBase64String(bytes)}";
    }
}
```

Chrome bloquea la navegación de nivel superior a URIs `data:`, pero exime explícitamente a las anclas que llevan un atributo `download`, así que esto sobrevive. Verifiqué que el ancla renderizada conserva intacto `download="client-report.csv"` en el DOM tras la hidratación de WebAssembly.

Dos límites impiden que esta sea la respuesta general. Base64 infla los payloads alrededor de un tercio y todo eso vive en un atributo del DOM, así que una exportación de 30 MB se convierte en una cadena de 40 MB dentro del árbol de renderizado. Y los navegadores no se ponen de acuerdo en los techos: Chrome y Edge imponen un límite de 2 MB en algunos contextos `data:`, mientras que Firefox y Safari no documentan ninguno. Por debajo de un megabyte más o menos, esto está bien. Más allá, agrega un endpoint en el servidor o acepta que necesitas `Blob` y `URL.createObjectURL`, lo que significa interoperabilidad.

## Los detalles que sí te van a morder

**`data-enhance` en el formulario tira tu archivo a la basura en silencio.** El manejo mejorado de formularios publica con `fetch` y se niega a hablar con cualquier cosa que no sea un endpoint de Blazor. Agregar `data-enhance` al formulario de exportación de arriba produjo esto en la consola:

```text
Enhanced navigation does not support making a non-GET request to a non-Blazor endpoint.
Avoid enabling enhanced navigation for forms that post to a non-Blazor endpoint.
```

La pestaña de red mostró el `POST` devolviendo `200` con el cuerpo CSV completo. El servidor construyó la exportación, la envió y el cliente la descartó. No se descargó nada. `EditForm` con `Enhance` falla de manera idéntica.

**Los tokens bearer no sobreviven a una navegación.** Un clic en un ancla y un envío de formulario son solicitudes iniciadas por el navegador. No hay cabecera `Authorization`, porque no hay código tuyo ejecutándose para adjuntarla. Si tu API se autentica con JWTs guardados en memoria, el endpoint de descarga devuelve `401` sin importar lo correcto que sea el marcado. O le das autenticación por cookies a ese único endpoint, o emites un token de un solo uso y corta duración y lo pones en la ruta, como en el ejemplo interactivo. Vale la pena leer las [diferencias entre autenticación JWT y por cookies](/es/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) antes de elegir, porque esto es una bifurcación arquitectónica genuina y no un parche.

**El atributo `download` se ignora entre orígenes.** Desde Chrome 65 la sugerencia de nombre de archivo se descarta en silencio para URLs de origen cruzado, y Firefox ignora el atributo por completo y navega en su lugar. Si tus archivos viven en una CDN o en un host de API separado, el atributo deja de ser determinante y `Content-Disposition: attachment` establecido por el servidor de origen se vuelve lo único que dispara el guardado. Configúralo allí.

**Los activos estáticos también necesitan el atributo.** `<a href="/docs/manual.pdf" download>` funciona contra archivos en `wwwroot`, pero sin `download` la interceptación de la navegación mejorada también aplica a esos, y un PDF es exactamente el tipo de respuesta que hace que la navegación mejorada se rinda a medio parcheo.

**No intentes escribir la respuesta desde el componente.** Tomar el `HttpContext` en cascada dentro de un componente static SSR y escribir bytes en `Response.Body` pelea contra el renderizador y te deja en [las cabeceras son de solo lectura, la respuesta ya ha comenzado](/es/2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore/). Los componentes renderizan marcado. Los endpoints devuelven archivos. Mantén la separación.

La regla que sale de todo esto es lo bastante pequeña como para recordarla: el navegador ya sabe descargar archivos, y Blazor ya sabe renderizar anclas. Lo único que se interpone entre ambos es un atributo que el framework está comprobando explícitamente.

## Fuentes

- [ASP.NET Core Blazor file downloads](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads) en Microsoft Learn, por las recetas basadas en interoperabilidad que este post reemplaza
- [ASP.NET Core Blazor forms overview](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/) por el componente `AntiforgeryToken`, el manejo mejorado de formularios y el middleware CSRF automático de .NET 11
- [Breaking change: IFormFile parameters require anti-forgery checks](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/8/antiforgery-checks) por qué el enlace `[FromForm]` necesita un token
- [Deprecations and removals in Chrome 65](https://developer.chrome.com/blog/chrome-65-deprecations) por la restricción de origen cruzado del atributo `download`
- Comportamiento confirmado contra una app `dotnet new blazor -int Auto` sobre ASP.NET Core 10.0.5, inspeccionando `blazor.web.js`, las cabeceras de respuesta y la consola del navegador
