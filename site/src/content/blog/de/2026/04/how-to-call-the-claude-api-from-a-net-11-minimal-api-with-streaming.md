---
title: "Wie Sie die Claude API aus einer .NET 11 Minimal API mit Streaming aufrufen"
description: "Streamen Sie Claude-Antworten aus einer ASP.NET Core 11 Minimal API von Anfang bis Ende: das offizielle Anthropic .NET SDK, TypedResults.ServerSentEvents, SseItem, IAsyncEnumerable, Cancellation-Fluss und die Fallstricke, die Ihre Tokens stillschweigend puffern. Mit Beispielen für Claude Sonnet 4.6 und Opus 4.7."
pubDate: 2026-04-30
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "aspnet-core"
  - "dotnet-11"
  - "streaming"
lang: "de"
translationOf: "2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming"
translatedBy: "claude"
translationDate: 2026-04-30
---

Wenn Sie Claude auf die offensichtliche Weise an eine ASP.NET Core 11 Minimal API anschließen, bekommen Sie eine Anfrage, die "funktioniert", und eine Ausgabe, die nach zwölf Sekunden in einem langsamen Klumpen ankommt. Die Anthropic API streamt die Antwort, während sie jedes Token erzeugt. Ihr Endpunkt sammelt die Tokens, serialisiert die vollständige Nachricht in JSON und versendet das Ganze, sobald das Modell `message_stop` sagt. Jeder Server, Proxy und Browser zwischen Kestrel und Nutzer puffert sie, weil ihnen nichts gesagt hat, dass es sich um einen Stream handelt.

Diese Anleitung zeigt die korrekte Verdrahtung auf dem aktuellen Stack: ASP.NET Core 11 (Preview 3 Stand April 2026, RTM noch dieses Jahr), das offizielle Anthropic .NET SDK (`Anthropic` auf NuGet), Claude Sonnet 4.6 (`claude-sonnet-4-6`) und Claude Opus 4.7 (`claude-opus-4-7`), sowie `TypedResults.ServerSentEvents` aus `Microsoft.AspNetCore.Http`. Wir gehen von einem schlichten Endpunkt, der puffert, über einen `IAsyncEnumerable<string>`-Endpunkt, der gechunkten Text streamt, zu einem typisierten `SseItem<T>`-Endpunkt, der echte SSE-Events ausgibt, die ein Browser-`EventSource` lesen kann. Danach behandeln wir Cancellation, Fehler, Tool Calls und die Proxies, die das Ganze still kaputt machen.

## Warum "einfach auf die Antwort warten" hier falsch ist

Ein nicht-streaming Claude-Aufruf liefert eine vollständige `Message` zurück, nachdem das Modell fertig ist. Für eine Antwort von 1.500 Tokens auf Sonnet 4.6 sind das ungefähr sechs bis zwölf Sekunden tote Luft. Das ist schlechte UX in einer Chat-UI und schlechter auf einer langsamen Verbindung, weil der Nutzer nichts sieht, bis alles angekommen ist. Es kostet Sie auch dieselben Input-Tokens, ob Sie streamen oder nicht, also gibt es keinen Vorteil beim Puffern.

Der Streaming-Endpunkt, dokumentiert in der [Anthropic-Streaming-Referenz](https://platform.claude.com/docs/en/build-with-claude/streaming), nutzt Server-Sent Events. Jeder Chunk ist ein SSE-Frame mit einem benannten Event (`message_start`, `content_block_delta`, `message_stop` usw.) und einem JSON-Payload. Das .NET SDK verpackt das in ein `IAsyncEnumerable`, sodass Sie SSE beim Aufruf von Anthropic nicht selbst parsen müssen. Die schwierigere Hälfte ist die *Ausgabeseite*: Wie geben Sie diese Chunks an den Browser weiter, ohne dass ein Framework sie hilfsbereit puffert?

ASP.NET Core 8 hat natives `IAsyncEnumerable<T>`-Streaming für Minimal APIs erhalten. ASP.NET Core 10 hat `TypedResults.ServerSentEvents` und `SseItem<T>` ergänzt, sodass Sie echtes SSE zurückgeben können, ohne `text/event-stream` von Hand zu schreiben. Beide sind in 11 enthalten. Zusammen decken sie die zwei Formen ab, die Sie tatsächlich wollen.

## Die gepufferte Version, die Sie nicht ausliefern sollten

Hier ist der naive Endpunkt, nur damit wir einen Ausgangspunkt haben, den wir aufbrechen können.

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

Das funktioniert. Es blockiert auch die gesamte Antwort, bis Claude fertig ist. Die Lösung sind zwei Änderungen: Den SDK-Aufruf auf `CreateStreaming` umstellen und ASP.NET einen Enumerator statt einer `Task<T>` übergeben.

## Text-Chunks streamen mit IAsyncEnumerable<string>

Das Anthropic .NET SDK stellt `client.Messages.CreateStreaming(parameters)` bereit, das ein asynchrones Enumerable von Text-Deltas zurückgibt. Kombinieren Sie das mit einem Minimal-API-Endpunkt, der `IAsyncEnumerable<string>` zurückgibt, und ASP.NET Core streamt es als `application/json` (ein JSON-Array, inkrementell geschrieben) ohne Pufferung.

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

Drei Details sind hier wichtig:

1. **Lokale Funktion**, keine Lambda. Der C#-Compiler erlaubt `yield return` nicht innerhalb von Lambdas oder anonymen Methoden, daher ruft das Minimal-API-Delegate eine lokale async-Iteratormethode auf. Das überrascht jeden, der seit .NET 6 Minimal APIs schreibt, weil jede andere Endpunktform als Lambda funktioniert.
2. **`[EnumeratorCancellation]`** am `CancellationToken`-Parameter des Iterators. Ohne das fließt das Request-Abort-Token von ASP.NET nicht in den Enumerator, und eine geschlossene Verbindung stoppt das SDK nicht, das fröhlich weiter streamt und Ihre Output-Tokens verbrennt. Der Compiler warnt nicht davor. Fügen Sie das Attribut hinzu oder prüfen Sie mit einem Profiler, ob das Schließen des Tabs die Anfrage tatsächlich abbricht.
3. **`.WithCancellation(ct)`** auf dem SDK-Enumerable. Hosenträger und Gürtel, aber es macht die Cancellation an der Grenze explizit, die Sie interessiert.

Das Drahtformat dieses Endpunkts ist ein JSON-Array. Der Browser bekommt keinen `EventSource`-freundlichen Stream, aber `fetch` mit einem `ReadableStream`-Reader funktioniert gut, ebenso jeder Konsument, der ein gechunktes JSON-Array verarbeiten kann. Wenn Ihr Client ein SignalR-Hub oder ein servergesteuertes UI-Framework ist, ist das in der Regel die Form, die Sie wollen.

## Echtes SSE streamen mit TypedResults.ServerSentEvents

Wenn Ihr Client ein Browser ist, der `EventSource` verwendet, oder ein Drittanbieter-Tool, das `text/event-stream` erwartet, wollen Sie SSE, nicht JSON. ASP.NET Core 10 hat `TypedResults.ServerSentEvents` ergänzt, das ein `IAsyncEnumerable<SseItem<T>>` entgegennimmt und eine echte SSE-Antwort mit dem richtigen Content Type, No-Cache-Headern und korrektem Framing schreibt.

`SseItem<T>` befindet sich in `System.Net.ServerSentEvents`. Jedes Item trägt einen Event-Typ, eine optionale ID, ein optionales Reconnection-Intervall und einen `Data`-Payload vom Typ `T`. ASP.NET serialisiert den Payload als JSON, es sei denn, Sie senden einen String, dann geht er unverändert durch.

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

Jetzt kann ein Browser das hier tun:

```javascript
// Browser, native EventSource (still GET-only) or fetch-event-source for POST.
const es = new EventSource("/chat/sse?prompt=...");
es.addEventListener("delta", (e) => append(e.data));
es.addEventListener("done", () => es.close());
```

Das Drahtformat ist die Standard-SSE-Form:

```
event: delta
data: "Hello"

event: delta
data: " world"

event: done
data: ""

```

Zwei Hinweise zur Wahl zwischen den beiden Endpunkten. Wenn der Client ein Browser mit `EventSource` ist, wollen Sie SSE. Bei allem anderen, einschließlich Ihres eigenen Frontends mit einem `fetch`-Reader, ist der `IAsyncEnumerable<string>`-Endpunkt einfacher, in der CDN-Konfiguration leichter cachebar und hält die Body-Form offensichtlich. Die `TypedResults.ServerSentEvents`-API ist dokumentiert unter [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0).

## Modell-IDs fixieren und Kosten

Für Streaming im Chat-Stil sind die richtigen Defaults im April 2026:

- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)** für allgemeinen Chat. $3 / Million Input-Tokens, $15 / Million Output-Tokens. Latenz bis zum ersten Byte etwa 400-600 ms in `us-east-1`. Kontextfenster 200k.
- **Claude Opus 4.7 (`claude-opus-4-7`)** für anspruchsvolles Reasoning. $15 / $75. Erstes Byte langsamer, 800 ms-1,2 s. Kontextfenster 200k, 1M mit der Long-Context-Beta.
- **Claude Haiku 4.5 (`claude-haiku-4-5`)** für günstige Aufrufe mit hohem Durchsatz. $1 / $5. Erstes Byte unter 300 ms.

Geben Sie die Modell-ID im Code an, niemals über einen Konfigurations-String, den das Frontend überschreiben kann. Die SDK-Konstanten (`Model.ClaudeSonnet4_6`, `Model.ClaudeOpus4_7`, `Model.ClaudeHaiku4_5`) kompilieren das Tippfehlerrisiko weg. Die Preise stehen auf der [Claude API Preisseite](https://www.anthropic.com/pricing); überprüfen Sie sie, bevor Sie irgendetwas in Rechnung stellen.

Wenn Sie kurz davor sind, einen langen System Prompt oder Tool-Katalog vor jede Anfrage zu stellen, wollen Sie auch Prompt Caching aktiviert haben, weil Streaming und Caching sauber zusammenarbeiten. Die Aufschlüsselung steht in [Wie Sie Prompt Caching zu einer Anthropic-SDK-App hinzufügen und die Trefferrate messen](/de/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

## Was das SDK vor Ihnen verbirgt

Die String-Chunks, die aus `CreateStreaming` kommen, sind die freundliche Sicht des SDK auf den rohen SSE-Eventstream. Die tatsächlichen Events, die Sie sehen würden, wenn Sie den Draht selbst parsen, sind:

- `message_start`: ein `Message`-Umschlag mit leerem `content`. Trägt die Message-ID und initiales `usage`.
- `content_block_start`: öffnet einen Content-Block (text, tool_use oder thinking).
- `content_block_delta`: inkrementelle Updates. Der `delta.type` ist eines von `text_delta`, `input_json_delta`, `thinking_delta` oder `signature_delta`.
- `content_block_stop`: schließt den aktuellen Block.
- `message_delta`: Top-Level-Updates inklusive `stop_reason` und kumulativer Output-Token-Nutzung.
- `message_stop`: Ende des Streams.
- `ping`: Füllmaterial, gesendet, um Proxies davon abzuhalten, untätige Verbindungen zu beenden. Ignorieren.

Das SDK fasst all das in der Iterator-Ausgabe zusammen, die Sie sehen, aber Sie bekommen eine reichere Sicht, wenn Sie danach fragen. Prüfen Sie die SDK-Überladung, die die rohen Events zurückgibt, oder halten Sie nach der Schleife mit `.GetFinalMessage()` an der akkumulierten `Message` fest, damit Sie das echte `usage` lesen können (kumulativ in `message_delta`, final in `message_stop`). Für eine Agent-Schleife wollen Sie fast immer die finale Message: dort gibt das SDK Ihnen `stop_reason`, die zusammengesetzten Tool Calls und die Input/Output-Token-Zähler, die Sie für die Abrechnung brauchen.

## Cancellation, die tatsächlich abbricht

Das ist der Bug, den niemand in dev fängt und jeder in Produktion. Der Nutzer schließt den Tab. ASP.NET löst das Request-Abort-Token aus. Ihr `IAsyncEnumerable` des Endpunkts soll stoppen, das SDK soll stoppen, der zugrunde liegende HTTP-Stream zu Anthropic soll schließen. Jedes Glied in dieser Kette muss das Token honorieren, und wenn auch nur eines davon es bricht, generieren Sie weiter Tokens, die niemand liest.

Drei Stellen zu überprüfen:

1. Das `[EnumeratorCancellation]`-Attribut am Token-Parameter Ihres Iterators. Ohne das wird das von ASP.NET über `WithCancellation` übergebene Token nicht zum `ct` des Iterators.
2. Der `CreateStreaming`-Aufruf braucht das Token. Übergeben Sie es per `.WithCancellation(ct)` oder über die Per-Call-Optionen des SDK, falls Sie auf einer Version sind, die ein Token direkt akzeptiert.
3. Die Browserseite muss tatsächlich schließen. `EventSource` reconnectet standardmäßig. Wenn Sie nicht `es.close()` vom Client aus aufrufen, kann eine Navigation weg ein paar Sekunden später eine frische Anfrage auslösen. Bei langen Completions kann das echtes Geld kosten.

Der sauberste Test ist, den Endpunkt mit `curl` aufzurufen, ihn mitten im Stream mit Ctrl-C zu killen und das Anthropic-Dashboard oder Ihre eigenen Request-Logs zu beobachten. Die Verbindung zu Anthropic sollte innerhalb einer Sekunde nach der Client-Trennung schließen. Wenn nicht, fließt Ihr Token irgendwo nicht.

Für eine längere Behandlung von Cancellation in IO-Schleifen allgemein siehe [Wie Sie einen lang laufenden Task in C# ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Fehler mitten im Stream

Eine Streaming-Antwort, die schon begonnen hat, kann keine 500 zurückgeben. Sie haben sich auf eine 200 festgelegt, sobald Kestrel das erste Byte ausgeschoben hat. Fehler nach diesem Punkt müssen als Daten fließen, nicht als HTTP-Status. Das Muster, das Clients bei Verstand hält:

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

Das ist hässlicher als der Happy Path, aber es ist die richtige Form. Ein `try` kann kein `yield return` umschließen, also teilen Sie die Iteration in eine manuelle `MoveNextAsync`-Schleife auf. Mid-Stream-Fehler (Rate Limits, Modellüberlastung, Netzwerkschluckauf) werden zu einem `error`-Event, das der Client rendern kann. Saubere Shutdowns werden zu einem `done`-Event. Cancellations beenden sich still, weil die Anfrage schon weg ist.

Zwei spezifische Anthropic-Fehler verdienen ihr eigenes clientseitiges Handling: `overloaded_error` (das Modell ist vorübergehend ohne Kapazität, mit Backoff erneut versuchen) und `rate_limit_error` (Sie haben das Pro-Minute- oder Pro-Tag-Limit der Org getroffen). Beide kommen auf der .NET-Seite als Exceptions vom SDK, mit einer typisierten `AnthropicException`, auf die Sie Pattern Matching anwenden können.

## Tool Calls in einem Stream

Wenn Ihr Endpunkt `tool_use`-Content-Blöcke produzieren kann, gibt Ihnen das SDK weiterhin einen string-typisierten Iterator für Text-Deltas, aber Sie verlieren den Tool-Call-Payload, wenn Sie sich nicht auch für die Events anmelden, die ihn tragen. Das niedrigerlevelige `Messages.CreateStreamingRaw` (oder das Äquivalent in Ihrer SDK-Version) legt die typisierten Events offen. Das Muster: `text_delta` zu Ihrem SSE-Delta-Kanal routen, `input_json_delta` (die Argumentfragmente des Tool Calls) zu einem separaten `tool`-Kanal routen, und den Client entscheiden lassen, was er rendert.

In der Praxis müssen die meisten Chat-UIs die JSON-Argumente nicht rendern, während sie streamen. Sie warten auf `content_block_stop` am Tool-Block, zeigen dann "Calling get_weather..." und das Ergebnis. Tool-Argumente Token für Token zu streamen ist meistens ein Debugging-Hilfsmittel.

Wenn Sie bereits Tool Calls verdrahten, exponieren Sie wahrscheinlich auch Dienste an Claude als MCP-Tools. Das serverseitige Muster in .NET steht in [Wie Sie einen benutzerdefinierten MCP-Server in C# auf .NET 11 bauen](/de/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/). Der Streaming-Endpunkt hier ist der *Client* dieser Tools, nicht der Server.

## Das Proxy-Buffering, das alles bricht

Sie verdrahten das alles korrekt. Sie treffen es von `localhost`. Es streamt. Sie deployen es hinter nginx, Cloudflare oder einer Azure Front Door, und die Antwort kommt als ein großer gepufferter Klumpen zurück. Drei Einstellungen, die Sie kennen müssen, in Reihenfolge der Priorität:

- **nginx**: Setzen Sie `proxy_buffering off;` an der SSE-Location, oder fügen Sie `X-Accel-Buffering: no` als Response-Header von Ihrem Endpunkt hinzu. Der Header-Trick ist portabel und überlebt Reverse-Proxy-Wechsel. Fügen Sie ihn in Middleware für jeden Endpunkt hinzu, der `text/event-stream` oder `application/json` mit `IAsyncEnumerable` zurückgibt.
- **Cloudflare**: Aktivieren Sie [Streaming responses](https://developers.cloudflare.com/) auf der relevanten Route. Das Standardverhalten erhält Chunks in den meisten Plänen, aber Enterprise-WAF-Regeln können puffern. Testen Sie zuerst mit dem Response-Header-Trick.
- **Komprimierung**: Response-Compression-Middleware kann Chunks sammeln, um sie in größeren Blöcken zu komprimieren. Deaktivieren Sie entweder Komprimierung für `text/event-stream`, oder verwenden Sie `application/json` mit Chunked Transfer; die Response Compression von ASP.NET kennt beide, aber eine benutzerdefinierte Middleware, die vor dem Streaming-Endpunkt geordnet ist, kann sie aushebeln.

Fügen Sie diesen Filter den Streaming-Endpunkten hinzu, um sicherzustellen, dass der Header vorhanden ist:

```csharp
app.MapPost("/chat/sse", ...)
   .AddEndpointFilter(async (ctx, next) =>
   {
       ctx.HttpContext.Response.Headers["X-Accel-Buffering"] = "no";
       return await next(ctx);
   });
```

Mehr zum sicheren Streamen von Bodies aus ASP.NET Core finden Sie in [Wie Sie eine Datei aus einem ASP.NET Core-Endpunkt ohne Pufferung streamen](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/). Die Lehre "Lassen Sie Middleware Ihre Chunks nicht sammeln" gilt identisch für LLM-Streams.

## Observability für den Streaming-Endpunkt

Ein Streaming-Claude-Aufruf hat zwei Latenzwerte, die zu tracken lohnt: Zeit bis zum ersten Token (die Latenz, die der Nutzer spürt) und Gesamtzeit bis zum Abschluss. Beide sollten in Ihren Traces landen. Die native OpenTelemetry-Unterstützung von ASP.NET Core 11 macht das einfach, ohne eine Abhängigkeit zu `Diagnostics.Otel`-Paketen aufzunehmen. Das Setup steht in [Native OpenTelemetry-Tracing in ASP.NET Core 11](/de/2026/04/aspnetcore-11-native-opentelemetry-tracing/).

Erfassen Sie drei benutzerdefinierte Attribute am Request-Span: die Modell-ID, den Input-Token-Zähler (aus der finalen `Message` des SDK) und den Output-Token-Zähler. Kostenrekonstruktion allein aus Logs ist sonst schmerzhaft. Latenzhistogramme gruppiert nach Modell machen offensichtlich, wann Sie für Routinetraffic von Opus 4.7 auf Sonnet 4.6 zurückfallen sollten.

## Was ist mit Microsoft.Extensions.AI

Wenn Sie lieber gegen die anbieterneutralen Abstraktionen programmieren, gibt `IChatClient.GetStreamingResponseAsync` von Microsoft.Extensions.AI ein `IAsyncEnumerable<ChatResponseUpdate>` zurück und funktioniert an der HTTP-Grenze genauso. Wickeln Sie den Anthropic-`IChatClient`-Adapter ein, projizieren Sie die Updates auf Text oder `SseItem<T>`, und der Rest dieses Artikels gilt unverändert. Der Trade-off ist eine Abstraktionsschicht für die Option, später auf OpenAI oder ein lokales Modell zu wechseln. Für Agent-Code wollen Sie auch die Framework-Version, siehe [Microsoft Agent Framework 1.0: KI-Agenten in C#](/de/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/), das auf denselben Abstraktionen aufbaut.

Für den BYOK-Aspekt (denselben Anthropic-Schlüssel an GitHub Copilot in VS Code zu reichen) spiegelt das Setup das hier wider: dieselben Modell-IDs, derselbe Schlüssel, ein anderer Konsument. Siehe [GitHub Copilot in VS Code: BYOK mit Anthropic, Ollama und Foundry Local](/de/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

## Quellen

- [Streaming Messages, Claude API docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic .NET SDK on GitHub](https://github.com/anthropics/anthropic-sdk-csharp)
- [Anthropic NuGet package](https://www.nuget.org/packages/Anthropic/)
- [Create responses in Minimal API applications, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0)
- [System.Net.ServerSentEvents.SseItem<T>](https://learn.microsoft.com/en-us/dotnet/api/system.net.serversentevents.sseitem-1)
- [Claude API pricing](https://www.anthropic.com/pricing)
