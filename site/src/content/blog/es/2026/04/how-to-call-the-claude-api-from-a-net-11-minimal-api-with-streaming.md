---
title: "Cómo llamar a la Claude API desde una Minimal API de .NET 11 con streaming"
description: "Transmite respuestas de Claude desde una minimal API de ASP.NET Core 11 de extremo a extremo: el SDK oficial de Anthropic para .NET, TypedResults.ServerSentEvents, SseItem, IAsyncEnumerable, flujo de cancelación y los detalles que silenciosamente acumulan tus tokens en buffer. Con ejemplos de Claude Sonnet 4.6 y Opus 4.7."
pubDate: 2026-04-30
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "aspnet-core"
  - "dotnet-11"
  - "streaming"
lang: "es"
translationOf: "2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming"
translatedBy: "claude"
translationDate: 2026-04-30
---

Si conectas Claude a una minimal API de ASP.NET Core 11 por la vía obvia, vas a obtener una solicitud que "funciona" y una salida que llega en un solo bloque lento después de doce segundos. La API de Anthropic está transmitiendo la respuesta a medida que genera cada token. Tu endpoint los está acumulando, serializando el mensaje completo a JSON y enviando todo de una vez cuando el modelo dice `message_stop`. Cada servidor, proxy y navegador entre Kestrel y el usuario lo está acumulando en buffer porque nada les indicó que esto era un stream.

Esta guía muestra el cableado correcto sobre el stack actual: ASP.NET Core 11 (preview 3 a abril de 2026, RTM más adelante este año), el SDK oficial de Anthropic para .NET (`Anthropic` en NuGet), Claude Sonnet 4.6 (`claude-sonnet-4-6`) y Claude Opus 4.7 (`claude-opus-4-7`), y `TypedResults.ServerSentEvents` de `Microsoft.AspNetCore.Http`. Vamos a ir desde un endpoint simple que acumula en buffer, hasta un endpoint `IAsyncEnumerable<string>` que transmite texto en chunks, y luego a un endpoint `SseItem<T>` tipado que emite eventos SSE apropiados que un `EventSource` del navegador puede leer. Después tratamos cancelación, errores, llamadas a herramientas y los proxies que silenciosamente rompen todo.

## Por qué "simplemente esperar la respuesta" está mal aquí

Una llamada no streaming a Claude devuelve un `Message` completo después de que el modelo terminó. Para una respuesta de 1.500 tokens en Sonnet 4.6 eso son aproximadamente seis a doce segundos de aire muerto. Es mala UX en una UI de chat y peor en una conexión lenta, porque el usuario no ve nada hasta que todo llegó. Además te cuesta los mismos tokens de input transmitas o no, así que no hay ninguna ventaja en acumular en buffer.

El endpoint de streaming, documentado en la [referencia de streaming de Anthropic](https://platform.claude.com/docs/en/build-with-claude/streaming), usa Server-Sent Events. Cada chunk es un frame SSE con un evento nombrado (`message_start`, `content_block_delta`, `message_stop`, etc.) y un payload JSON. El SDK de .NET envuelve eso en un `IAsyncEnumerable` para que no tengas que parsear SSE tú mismo al llamar a Anthropic. La mitad más difícil es el lado de *salida*: cómo reemites esos chunks al navegador sin que un framework te los acumule en buffer útilmente.

ASP.NET Core 8 ganó streaming nativo de `IAsyncEnumerable<T>` para minimal APIs. ASP.NET Core 10 agregó `TypedResults.ServerSentEvents` y `SseItem<T>` para que puedas devolver SSE apropiado sin escribir a mano `text/event-stream`. Ambos vienen en 11. Juntos cubren las dos formas que realmente quieres.

## La versión con buffer que no deberías enviar

Aquí está el endpoint ingenuo, solo para tener un punto de partida que romper.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha (NuGet: Anthropic)
using Anthropic;
using Anthropic.Models.Messages;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(_ => new AnthropicClient());
var app = builder.Build();

app.MapPost("/chat", async (ChatRequest req, AnthropicClient client) =>
{
    var parameters = new MessageCreateParams
    {
        Model = Model.ClaudeSonnet4_6,
        MaxTokens = 1024,
        Messages = [new() { Role = Role.User, Content = req.Prompt }]
    };

    var message = await client.Messages.Create(parameters);
    return Results.Ok(new { text = message.Content[0].Text });
});

app.Run();

record ChatRequest(string Prompt);
```

Esto funciona. También bloquea toda la respuesta hasta que Claude termine. La solución son dos cambios: cambiar la llamada del SDK a `CreateStreaming` y entregarle a ASP.NET un enumerador en lugar de una `Task<T>`.

## Transmitiendo chunks de texto con IAsyncEnumerable<string>

El SDK de Anthropic para .NET expone `client.Messages.CreateStreaming(parameters)`, que devuelve un enumerable asíncrono de deltas de texto. Combina eso con un endpoint de minimal API que devuelva `IAsyncEnumerable<string>` y ASP.NET Core lo transmitirá como `application/json` (un array JSON, escrito de forma incremental) sin acumular en buffer.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha
using System.Runtime.CompilerServices;
using Anthropic;
using Anthropic.Models.Messages;

app.MapPost("/chat/stream", (ChatRequest req,
                              AnthropicClient client,
                              CancellationToken ct) =>
{
    return StreamChat(req.Prompt, client, ct);

    static async IAsyncEnumerable<string> StreamChat(
        string prompt,
        AnthropicClient client,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var parameters = new MessageCreateParams
        {
            Model = Model.ClaudeSonnet4_6,
            MaxTokens = 1024,
            Messages = [new() { Role = Role.User, Content = prompt }]
        };

        await foreach (var chunk in client.Messages.CreateStreaming(parameters)
                                                    .WithCancellation(ct))
        {
            yield return chunk;
        }
    }
});
```

Tres detalles importan aquí:

1. **Función local**, no una lambda. El compilador de C# no permite `yield return` dentro de lambdas o métodos anónimos, así que el delegado de la minimal API llama a un método iterador async local. Esto sorprende a todos los que han escrito minimal APIs desde .NET 6, porque cualquier otra forma de endpoint funciona como lambda.
2. **`[EnumeratorCancellation]`** en el parámetro `CancellationToken` del iterador. Sin él, el token de aborto de la solicitud que ASP.NET pasa no fluirá al enumerador, y una conexión cerrada no detendrá al SDK que felizmente seguirá el stream y quemará tus tokens de output. El compilador no advierte sobre esto. Agrega el atributo o verifica con un profiler que cerrar la pestaña realmente cancela la solicitud.
3. **`.WithCancellation(ct)`** sobre el enumerable del SDK. Cinturón y tirantes, pero hace explícita la cancelación en el límite que te importa.

El formato en cable de este endpoint es un array JSON. El navegador no recibe un stream amistoso para `EventSource`, pero `fetch` con un lector de `ReadableStream` funciona bien, y también cualquier consumidor que sepa manejar un array JSON en chunks. Si tu cliente es un hub de SignalR o un framework de UI dirigido por servidor, esta suele ser la forma que quieres.

## Transmitiendo SSE apropiado con TypedResults.ServerSentEvents

Si tu cliente es un navegador usando `EventSource` o una herramienta de terceros que espera `text/event-stream`, quieres SSE, no JSON. ASP.NET Core 10 agregó `TypedResults.ServerSentEvents`, que toma un `IAsyncEnumerable<SseItem<T>>` y escribe una respuesta SSE real con el content type correcto, headers no-cache y framing correcto.

`SseItem<T>` está en `System.Net.ServerSentEvents`. Cada item lleva un tipo de evento, un ID opcional, un intervalo de reconexión opcional y un payload `Data` de tipo `T`. ASP.NET serializa el payload como JSON salvo que envíes un string, en cuyo caso pasa tal cual.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using Anthropic;
using Anthropic.Models.Messages;
using Microsoft.AspNetCore.Http;

app.MapPost("/chat/sse", (ChatRequest req,
                           AnthropicClient client,
                           CancellationToken ct) =>
{
    return TypedResults.ServerSentEvents(StreamChat(req.Prompt, client, ct));

    static async IAsyncEnumerable<SseItem<string>> StreamChat(
        string prompt,
        AnthropicClient client,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var parameters = new MessageCreateParams
        {
            Model = Model.ClaudeSonnet4_6,
            MaxTokens = 1024,
            Messages = [new() { Role = Role.User, Content = prompt }]
        };

        await foreach (var chunk in client.Messages.CreateStreaming(parameters)
                                                    .WithCancellation(ct))
        {
            yield return new SseItem<string>(chunk, eventType: "delta");
        }

        yield return new SseItem<string>("", eventType: "done");
    }
});
```

Ahora un navegador puede hacer esto:

```javascript
// Browser, native EventSource (still GET-only) or fetch-event-source for POST.
const es = new EventSource("/chat/sse?prompt=...");
es.addEventListener("delta", (e) => append(e.data));
es.addEventListener("done", () => es.close());
```

El framing en cable es la forma SSE estándar:

```
event: delta
data: "Hello"

event: delta
data: " world"

event: done
data: ""

```

Dos notas sobre cómo elegir entre los dos endpoints. Si el cliente es un navegador usando `EventSource`, quieres SSE. Si es cualquier otra cosa, incluido tu propio front-end con un lector de `fetch`, el endpoint `IAsyncEnumerable<string>` es más simple, más cacheable en config de CDN y mantiene la forma del body obvia. La API `TypedResults.ServerSentEvents` está documentada en [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0).

## Fijando IDs de modelo y costo

Para streaming estilo chat, los defaults correctos en abril de 2026 son:

- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)** para chat general. $3 / millón de tokens de input, $15 / millón de output. Latencia al primer byte alrededor de 400-600 ms en `us-east-1`. Ventana de contexto 200k.
- **Claude Opus 4.7 (`claude-opus-4-7`)** para razonamiento difícil. $15 / $75. Primer byte más lento, 800 ms-1.2 s. Ventana de contexto 200k, 1M con la beta de contexto largo.
- **Claude Haiku 4.5 (`claude-haiku-4-5`)** para llamadas baratas de alto throughput. $1 / $5. Primer byte sub-300 ms.

Declara el ID del modelo en código, nunca vía un string de configuración que el front end pueda sobrescribir. Las constantes del SDK (`Model.ClaudeSonnet4_6`, `Model.ClaudeOpus4_7`, `Model.ClaudeHaiku4_5`) compilan eliminando el riesgo de typos. Los precios están en la [página de precios de la Claude API](https://www.anthropic.com/pricing); verifica antes de facturar nada.

Si estás por poner un system prompt largo o un catálogo de herramientas delante de cada solicitud, también quieres prompt caching activado, porque streaming y caching componen limpiamente. El detalle está en [Cómo agregar prompt caching a una app del Anthropic SDK y medir la tasa de aciertos](/es/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

## Lo que el SDK te está ocultando

Los chunks de string que salen de `CreateStreaming` son la vista amigable del SDK del stream crudo de eventos SSE. Los eventos reales que verías si parseaste el cable tú mismo son:

- `message_start`: un envoltorio `Message` con `content` vacío. Lleva el ID del mensaje y el `usage` inicial.
- `content_block_start`: abre un bloque de contenido (text, tool_use o thinking).
- `content_block_delta`: actualizaciones incrementales. El `delta.type` es uno de `text_delta`, `input_json_delta`, `thinking_delta` o `signature_delta`.
- `content_block_stop`: cierra el bloque actual.
- `message_delta`: actualizaciones de nivel superior incluyendo `stop_reason` y uso acumulado de tokens de output.
- `message_stop`: fin del stream.
- `ping`: relleno, enviado para evitar que los proxies cierren conexiones inactivas. Ignorar.

El SDK colapsa todo eso en la salida del iterador que ves, pero obtienes una vista más rica si la pides. Revisa la sobrecarga del SDK que devuelve los eventos crudos, o aférrate al `Message` acumulado después del loop con `.GetFinalMessage()` para que puedas leer el `usage` real (acumulado en `message_delta`, final en `message_stop`). Para un loop de agente casi siempre quieres el mensaje final: ahí es donde el SDK te da `stop_reason`, las llamadas a herramientas ensambladas y los conteos de tokens de input/output que necesitas para facturación.

## Cancelación que realmente cancela

Este es el bug que nadie atrapa en dev y todos atrapan en prod. El usuario cierra la pestaña. ASP.NET dispara el token de aborto de la solicitud. Tu `IAsyncEnumerable` del endpoint debería detenerse, el SDK debería detenerse, el stream HTTP subyacente a Anthropic debería cerrarse. Cada eslabón de esa cadena tiene que honrar el token, y cualquiera que lo rompa te deja generando tokens que nadie está leyendo.

Tres lugares para verificar:

1. El atributo `[EnumeratorCancellation]` en el parámetro de token de tu iterador. Sin él, el token pasado por ASP.NET en `WithCancellation` no se vuelve el `ct` del iterador.
2. La llamada a `CreateStreaming` necesita el token. Pásalo vía `.WithCancellation(ct)` o vía las opciones por llamada del SDK si estás en una versión que acepta un token directamente.
3. El lado del navegador tiene que cerrar realmente. `EventSource` reconecta por defecto. Si no llamas a `es.close()` desde el cliente, una navegación a otra parte puede disparar una solicitud nueva unos segundos después. Para completados largos, esto puede costar dinero real.

La prueba más limpia es llamar al endpoint con `curl`, matarlo con Ctrl-C a mitad del stream y observar el dashboard de Anthropic o tus propios logs de solicitud. La conexión a Anthropic debería cerrarse en menos de un segundo de la desconexión del cliente. Si no, tu token no está fluyendo en alguna parte.

Para un tratamiento más largo de la cancelación en loops de IO en general, consulta [Cómo cancelar una tarea de larga duración en C# sin interbloqueo](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Errores a mitad del stream

Una respuesta streaming que ya empezó no puede devolver un 500. Te comprometiste con un 200 en el momento en que Kestrel envió el primer byte. Los errores después de ese punto tienen que fluir como datos, no como un estado HTTP. El patrón que mantiene a los clientes sanos:

```csharp
static async IAsyncEnumerable<SseItem<string>> StreamChat(
    string prompt,
    AnthropicClient client,
    [EnumeratorCancellation] CancellationToken ct)
{
    var parameters = new MessageCreateParams
    {
        Model = Model.ClaudeSonnet4_6,
        MaxTokens = 1024,
        Messages = [new() { Role = Role.User, Content = prompt }]
    };

    IAsyncEnumerator<string>? enumerator = null;
    try
    {
        enumerator = client.Messages.CreateStreaming(parameters)
                                     .WithCancellation(ct)
                                     .GetAsyncEnumerator();
    }
    catch (Exception ex)
    {
        yield return new SseItem<string>(ex.Message, eventType: "error");
        yield break;
    }

    while (true)
    {
        bool moved;
        try
        {
            moved = await enumerator.MoveNextAsync();
        }
        catch (OperationCanceledException) { yield break; }
        catch (Exception ex)
        {
            yield return new SseItem<string>(ex.Message, eventType: "error");
            yield break;
        }

        if (!moved) break;
        yield return new SseItem<string>(enumerator.Current, eventType: "delta");
    }

    yield return new SseItem<string>("", eventType: "done");
}
```

Esto es más feo que el camino feliz, pero es la forma correcta. Un `try` no puede envolver un `yield return`, así que divides la iteración en un loop manual de `MoveNextAsync`. Las fallas a mitad del stream (rate limits, sobrecarga del modelo, hipos de red) se vuelven un evento `error` que el cliente puede renderizar. Los apagados limpios se vuelven un evento `done`. Las cancelaciones salen silenciosamente porque la solicitud ya se fue.

Dos errores específicos de Anthropic merecen su propio manejo del lado del cliente: `overloaded_error` (el modelo está temporalmente sin capacidad, reintenta con backoff) y `rate_limit_error` (chocaste con el límite por minuto o por día de la org). Ambos llegan como excepciones del SDK del lado .NET, con un `AnthropicException` tipado sobre el que puedes hacer pattern matching.

## Llamadas a herramientas en un stream

Si tu endpoint puede producir bloques de contenido `tool_use`, el SDK te sigue dando un iterador tipo string para deltas de texto, pero pierdes el payload de la llamada a herramienta a menos que también te suscribas a los eventos que lo llevan. El nivel inferior `Messages.CreateStreamingRaw` (o el equivalente en tu versión del SDK) expone los eventos tipados. El patrón: enrutar `text_delta` a tu canal SSE delta, enrutar `input_json_delta` (los fragmentos de argumento de la llamada a herramienta) a un canal `tool` separado, y dejar que el cliente decida qué renderizar.

En la práctica, la mayoría de las UIs de chat no necesitan renderizar los argumentos JSON mientras se transmiten. Esperan a `content_block_stop` en el bloque de herramienta, luego muestran "Calling get_weather..." y el resultado. Transmitir los argumentos de herramienta token a token es mayormente una ayuda de depuración.

Si ya estás cableando llamadas a herramientas, también probablemente estás exponiendo servicios a Claude como herramientas MCP. El patrón del lado servidor en .NET está en [Cómo construir un servidor MCP personalizado en C# en .NET 11](/es/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/). El endpoint streaming aquí es el *cliente* de esas herramientas, no el servidor.

## El buffering de proxy que rompe todo

Cableas todo correctamente. Lo golpeas desde `localhost`. Transmite. Lo despliegas detrás de nginx, Cloudflare o un Azure Front Door, y la respuesta vuelve en un gran bloque acumulado. Tres ajustes a conocer, en orden de prioridad:

- **nginx**: configura `proxy_buffering off;` en la location SSE, o agrega `X-Accel-Buffering: no` como header de respuesta desde tu endpoint. El truco del header es portable y sobrevive a cambios de proxy reverso. Agrégalo en middleware para cualquier endpoint que devuelva `text/event-stream` o `application/json` con `IAsyncEnumerable`.
- **Cloudflare**: activa [Streaming responses](https://developers.cloudflare.com/) en la ruta correspondiente. El comportamiento por defecto preserva chunks en la mayoría de los planes, pero las reglas WAF empresariales pueden acumular en buffer. Prueba primero con el truco del header de respuesta.
- **Compresión**: el middleware de compresión de respuesta puede recolectar chunks para comprimirlos en bloques más grandes. O desactiva compresión para `text/event-stream`, o usa `application/json` con transferencia en chunks; la compresión de respuesta de ASP.NET conoce ambos, pero un middleware personalizado ordenado antes del endpoint streaming puede vencerla.

Agrega este filtro a los endpoints streaming para asegurar que el header esté presente:

```csharp
app.MapPost("/chat/sse", ...)
   .AddEndpointFilter(async (ctx, next) =>
   {
       ctx.HttpContext.Response.Headers["X-Accel-Buffering"] = "no";
       return await next(ctx);
   });
```

Para más sobre transmitir bodies de forma segura desde ASP.NET Core, consulta [Cómo transmitir un archivo desde un endpoint de ASP.NET Core sin acumular en buffer](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/). La lección de "no dejes que el middleware recolecte tus chunks" aplica idénticamente a los streams de LLM.

## Observabilidad para el endpoint streaming

Una llamada streaming a Claude tiene dos números de latencia que vale la pena rastrear: tiempo al primer token (la latencia que siente el usuario) y tiempo total a completado. Ambos deberían aterrizar en tus traces. El soporte nativo de OpenTelemetry de ASP.NET Core 11 hace esto fácil sin tomar dependencia de paquetes `Diagnostics.Otel`. La configuración está en [Tracing nativo de OpenTelemetry en ASP.NET Core 11](/es/2026/04/aspnetcore-11-native-opentelemetry-tracing/).

Captura tres atributos personalizados en el span de la solicitud: el ID del modelo, el conteo de tokens de input (del `Message` final del SDK) y el conteo de tokens de output. Reconstruir costos solo desde logs es doloroso de otro modo. Histogramas de latencia agrupados por modelo hacen obvio cuándo deberías caer de Opus 4.7 a Sonnet 4.6 para tráfico de rutina.

## Y Microsoft.Extensions.AI

Si prefieres codear contra las abstracciones neutrales de proveedor, `IChatClient.GetStreamingResponseAsync` de Microsoft.Extensions.AI devuelve `IAsyncEnumerable<ChatResponseUpdate>` y funciona igual en el límite HTTP. Envuelve el adaptador `IChatClient` de Anthropic, proyecta los updates a texto o `SseItem<T>`, y el resto de este artículo aplica sin cambios. El trade-off es una capa de abstracción a cambio de la opción de cambiar a OpenAI o un modelo local más adelante. Para código de agentes también quieres la versión del framework, consulta [Microsoft Agent Framework 1.0: agentes de IA en C#](/es/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/), que se construye sobre esas mismas abstracciones.

Para el ángulo BYOK (entregando esta misma clave de Anthropic a GitHub Copilot en VS Code), la configuración refleja lo que haces aquí: los mismos IDs de modelo, la misma clave, un consumidor diferente. Consulta [GitHub Copilot en VS Code: BYOK con Anthropic, Ollama y Foundry Local](/es/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

## Fuentes

- [Streaming Messages, Claude API docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic .NET SDK on GitHub](https://github.com/anthropics/anthropic-sdk-csharp)
- [Anthropic NuGet package](https://www.nuget.org/packages/Anthropic/)
- [Create responses in Minimal API applications, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0)
- [System.Net.ServerSentEvents.SseItem<T>](https://learn.microsoft.com/en-us/dotnet/api/system.net.serversentevents.sseitem-1)
- [Claude API pricing](https://www.anthropic.com/pricing)
