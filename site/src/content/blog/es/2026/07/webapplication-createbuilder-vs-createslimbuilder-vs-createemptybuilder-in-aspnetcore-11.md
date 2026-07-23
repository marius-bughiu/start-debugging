---
title: "WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder en ASP.NET Core 11"
description: "Usa CreateBuilder para una app normal, CreateSlimBuilder cuando publicas con trimming o Native AOT detrás de un proxy TLS, y CreateEmptyBuilder solo cuando quieres registrar cada servicio tú mismo. Aquí tienes la matriz de características y las trampas que fuerzan la decisión."
pubDate: 2026-07-23
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "native-aot"
  - "csharp"
lang: "es"
translationOf: "2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-23
---

Para una app web normal de ASP.NET Core 11, usa `WebApplication.CreateBuilder(args)`. Es el predeterminado por una razón: conecta cada característica de hosting que esperas. Cambia a `WebApplication.CreateSlimBuilder(args)` solo cuando publicas con trimming o Native AOT y corres detrás de un proxy que termina el TLS, porque descarta HTTPS, HTTP/3, la integración con IIS, los static web assets y dos proveedores de logging para reducir el binario. Recurre a `WebApplication.CreateEmptyBuilder(...)` solo en el raro caso en que quieres una base casi nula y vas a registrar el servidor, el enrutamiento y la configuración tú mismo. Este post apunta a .NET 11 (Preview 6 al momento de escribir, GA en noviembre de 2026) con `Microsoft.NET.Sdk.Web` y C# 14, pero los tres métodos de fábrica existen desde .NET 8, así que la guía se mantiene sin cambios de .NET 8 a 11.

## Qué significa realmente "predeterminados" aquí

Los tres métodos difieren en exactamente una cosa: cuánto registran en el `WebApplicationBuilder` antes de que corra tu código. Todo lo demás, la colección `builder.Services`, `builder.Build()`, `app.MapGet(...)`, es idéntico. Así que toda la decisión se reduce a qué predeterminados quieres que te entreguen frente a cuáles estás dispuesto a agregar de vuelta a mano.

`CreateBuilder` te da el host predeterminado completo. `CreateSlimBuilder` te da un subconjunto curado elegido para ser seguro con trimming y pequeño. `CreateEmptyBuilder` te da casi nada y espera que optes por cada pieza. Internamente incluso comparten maquinaria: `CreateSlimBuilder` se construye sobre el mismo empty host application builder que `CreateEmptyBuilder` expone, y luego vuelve a agregar el conjunto slim de servicios encima. Por eso el orden de abajo es una cadena de superconjuntos estricta: `CreateBuilder` incluye todo lo que hace `CreateSlimBuilder`, que incluye todo lo que hace `CreateEmptyBuilder`.

## Matriz de características

Cada fila está verificada contra la documentación de ASP.NET Core 11 y el código fuente de `WebApplication.cs`. "Manual" significa que la característica no se registra por ti, pero puedes agregarla con la llamada mostrada.

| Característica                              | CreateBuilder | CreateSlimBuilder             | CreateEmptyBuilder            |
| ------------------------------------------ | ------------- | ----------------------------- | ----------------------------- |
| appsettings.json + appsettings.{env}.json  | sí            | sí                            | manual                        |
| User secrets (Development)                 | sí            | sí                            | manual                        |
| Config por variable de entorno + línea de comandos | sí    | sí                            | manual                        |
| Logging de consola                         | sí            | sí                            | manual (`AddConsole`)         |
| Logging Debug / EventSource / EventLog     | sí            | no                            | no                            |
| Servidor Kestrel                           | completo      | core (`UseKestrelCore`)       | manual (`UseKestrelCore`)     |
| Endpoints HTTPS en Kestrel                 | sí            | no (`UseKestrelHttpsConfiguration`) | manual                  |
| HTTP/3 (QUIC)                              | sí            | no (`UseQuic`)                | manual                        |
| Integración con IIS                        | sí            | no                            | no                            |
| Static web assets                          | sí            | no                            | no                            |
| Hosting startup assemblies / `UseStartup`  | sí            | no                            | no                            |
| Restricciones de ruta regex y alpha        | sí            | no                            | no                            |
| Enrutamiento / `MapGet` etc.               | sí            | sí                            | manual                        |

La conclusión más importante de esa tabla: `CreateSlimBuilder` aún conserva tus fuentes de configuración y el logging de consola. No está quitando las cosas que usas todos los días. Elimina características de protocolo y de plataforma que un despliegue cloud-native, con proxy al frente, normalmente no necesita, más tres proveedores de logging que rara vez lees en producción.

## Cuándo elegir CreateBuilder

Este es el predeterminado, y para la mayoría de las apps debería seguir siéndolo.

- **Despliegas en IIS o IIS Express, o corres en Windows y lees el EventLog de Windows.** Ambos solo los conecta `CreateBuilder`. `CreateSlimBuilder` no tiene integración con IIS, así que un despliegue in-process de IIS simplemente no hará hosting correctamente.
- **Sirves static web assets desde Razor Class Libraries o usas `UseStaticWebAssets`.** Las apps de UI con Blazor y MVC dependen de esto. El slim builder no lo registra, y el modo de falla es CSS/JS faltante sin error obvio.
- **Usas restricciones de ruta `{id:regex(...)}` o `{name:alpha}`.** Estas se omiten del slim builder para ahorrar cerca de un megabyte de binario. `{id:int}` y otras restricciones primitivas están bien; regex y alpha son las dos que desaparecen.
- **No estás publicando con trimming ni AOT en absoluto.** Si envías una build JIT normal, dependiente del framework o self-contained, el slim builder no te aporta casi nada en runtime. Las ganancias en tamaño de binario y arranque vienen del trimming y AOT, no de la elección del builder por sí sola. Elegir slim aquí solo significa volver a agregar HTTPS y compañía sin ninguna recompensa.

## Cuándo elegir CreateSlimBuilder

`CreateSlimBuilder` se introdujo en .NET 8 específicamente para ser el predeterminado de la plantilla de Web API con Native AOT (`dotnet new webapiaot`). Elígelo cuando lo siguiente describa tu despliegue.

- **Publicas con `<PublishAot>true</PublishAot>` o trimming agresivo (`<PublishTrimmed>true</PublishTrimmed>`).** El slim builder evita traer rutas de código poco amigables con el trimming al grafo, lo que mantiene bajas las advertencias y pequeña la salida. Mira [cómo usar Native AOT con minimal APIs de ASP.NET Core](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para la configuración completa de AOT para la que está diseñado este builder.
- **Corres detrás de un proxy o ingress que termina el TLS (Nginx, Caddy, YARP, Azure Application Gateway).** El proxy maneja HTTPS, así que tu proceso escuchando en HTTP plano es exactamente lo correcto. Esta es la suposición que el slim builder integra al descartar la configuración de HTTPS de Kestrel.
- **Quieres la imagen de contenedor más pequeña razonable para un microservicio de minimal API.** Combinado con trimming y AOT, el slim builder produce un único ejecutable nativo pequeño con una superficie de ataque diminuta.

Si eliges slim y luego descubres que sí necesitas HTTPS o HTTP/3, no tienes que cambiar de builder. Agrégalos de vuelta explícitamente:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateSlimBuilder(args);

// Re-enable HTTPS endpoints that CreateSlimBuilder omits by default.
builder.WebHost.UseKestrelHttpsConfiguration();

// Re-enable HTTP/3 (QUIC) if a client actually needs it.
builder.WebHost.UseQuic();

var app = builder.Build();
app.MapGet("/", () => "Hello from a slim host");
app.Run();
```

## Cuándo elegir CreateEmptyBuilder

`CreateEmptyBuilder(WebApplicationOptions)` crea un builder sin ningún comportamiento incorporado. La app que construye contiene solo los servicios y el middleware que configuras explícitamente. Esta es una herramienta especializada, no un predeterminado general. Recurre a ella cuando estás construyendo el servicio más pequeño posible y quieres controlar cada registro, o cuando estás experimentando con exactamente qué tan poco necesita ASP.NET Core para servir una solicitud.

Aquí está el ejemplo mínimo canónico de las notas de la versión de .NET 8, que aún compila sin cambios en .NET 11:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateEmptyBuilder(new WebApplicationOptions());

// Nothing is registered by default, so add the server yourself.
builder.WebHost.UseKestrelCore();

var app = builder.Build();

app.Use(async (context, next) =>
{
    await context.Response.WriteAsync("Hello, World!");
    await next(context);
});

Console.WriteLine("Running...");
app.Run();
```

Nota lo que falta y tendría que agregarse a mano si lo necesitaras: no hay carga de `appsettings.json`, no hay logging de consola, no hay enrutamiento (así que no hay `MapGet`; escribes middleware crudo en su lugar) y no hay binding de configuración. Agregas cada uno con una llamada explícita: `builder.Configuration.AddJsonFile("appsettings.json")`, `builder.Logging.AddConsole()`, `builder.Services.AddRouting()`, y así sucesivamente. Ese es todo el sentido del empty builder: pagas exactamente por lo que usas.

## La historia del tamaño, y por qué es una historia de trimming

La razón por la que existen los tres es el tamaño del binario y el arranque para Native AOT, no el throughput de solicitudes en crudo. Para una app compilada con JIT, los tres builders registran distintos grafos de servicios, pero una vez que la app está caliente la diferencia en solicitudes por segundo no es donde está el valor. El valor aparece cuando haces trimming y compilas con AOT.

El propio benchmark de Microsoft para la plantilla de Web API con Native AOT compara una publicación con Native AOT contra una build de runtime con trimming y una build de runtime sin trimming, y reporta que la app AOT tiene el menor tamaño de app, uso de memoria y tiempo de arranque de las tres. Las notas de la versión de .NET 8 dan un ancla concreta para el extremo vacío del espectro: el ejemplo "Hello, World" de `CreateEmptyBuilder` de arriba, publicado con Native AOT en una máquina linux-x64, produjo un ejecutable nativo self-contained de cerca de 8.5 MB. Esa cifra es lo que parece una base casi nula una vez que AOT y el trimming hacen su trabajo.

El orden práctico, de mayor a menor huella publicada, es `CreateBuilder`, luego `CreateSlimBuilder`, luego `CreateEmptyBuilder`. Pero la brecha entre ellos solo se abre bajo `PublishAot` o `PublishTrimmed`. Envía una build simple y habrás pagado la ceremonia del slim o empty builder sin cobrar la recompensa. Ese es el error más común: elegir el slim builder para un despliegue normal porque "slim suena más rápido". No es más rápido en runtime; es más pequeño cuando se le hace trimming. Si no estás haciendo trimming, [lo que Native AOT realmente te cuesta](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) vale la pena leerlo antes de comprometerte con el camino slim, y [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) cubre dónde gana cada modo de publicación.

## La trampa que decide por ti

La preferencia rara vez decide esto. Una de estas normalmente lo hace.

- **El hosting in-process de IIS fuerza `CreateBuilder`.** Sin integración con IIS no hay módulo in-process. Si tu host es IIS, la decisión está tomada.
- **Los static web assets fuerzan `CreateBuilder`.** Una app de UI con Blazor o Razor que pierde `UseStaticWebAssets` envía estilos rotos sin excepción en el arranque. Esta muerde en silencio, así que trata cualquier app de UI como una app de `CreateBuilder` a menos que tengas una razón específica para no hacerlo.
- **Las restricciones de ruta regex o alpha fuerzan `CreateBuilder`.** Si tu tabla de enrutamiento tiene `{code:regex(^[A-Z]{3}$)}` o `{slug:alpha}`, el slim builder no resolverá esas restricciones. Las restricciones primitivas como `:int`, `:guid` y `:datetime` no se ven afectadas.
- **AOT más un proxy TLS fuerza `CreateSlimBuilder`.** Si estás publicando con AOT para un microservicio con proxy al frente, slim es el predeterminado previsto, y pelearte con él empezando desde `CreateBuilder` vuelve a traer código poco amigable con el trimming al grafo.
- **Los controladores de MVC descartan AOT por completo, lo que cambia toda la pregunta.** MVC no es compatible con Native AOT, así que si necesitas controladores de todos modos no vas a ir con AOT completo, y la ventaja principal del slim builder se evapora. Mira [minimal APIs vs controladores en ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) si aún estás sopesando esa elección.

## La decisión, replanteada

Usa `CreateBuilder` por defecto. Es la elección correcta para la abrumadora mayoría de las apps de ASP.NET Core 11, incluyendo toda app que usa IIS, static web assets, MVC, Blazor o restricciones de ruta regex. Muévete a `CreateSlimBuilder` cuando, y solo cuando, publicas con trimming o Native AOT y te sientas detrás de un proxy que termina el TLS, que es exactamente el escenario al que apunta la plantilla `webapiaot`; vuelve a agregar HTTPS o HTTP/3 con una sola llamada `UseKestrelHttpsConfiguration()` o `UseQuic()` si los necesitas. Guarda `CreateEmptyBuilder` en tu bolsillo para el servicio genuinamente mínimo donde quieres registrar cada última pieza tú mismo y medir el piso. Lo único que no hay que hacer es elegir el slim o empty builder para un despliegue JIT normal con la teoría de que es más rápido. Es más pequeño cuando se le hace trimming, no más rápido cuando corre, y en una build normal obtienes la fricción sin la recompensa. Si de entrada estás migrando un host más antiguo a este modelo, la [migración de IWebHostBuilder a WebApplication.CreateBuilder](/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/) es la puerta que hay que cruzar antes de optimizar qué método de fábrica llamas.

## Related

- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [Migrate from IWebHostBuilder to WebApplication.CreateBuilder in .NET 11](/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Sources

- [WebApplication.CreateSlimBuilder Method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.webapplication.createslimbuilder)
- [ASP.NET Core support for Native AOT: Compare CreateSlimBuilder and CreateBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot)
- [What's new in ASP.NET Core in .NET 8: New CreateEmptyBuilder method (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-8.0#new-createemptybuilder-method)
- [Andrew Lock: Comparing WebApplication.CreateBuilder to the new CreateSlimBuilder method](https://andrewlock.net/exploring-the-dotnet-8-preview-comparing-createbuilder-to-the-new-createslimbuilder-method/)
