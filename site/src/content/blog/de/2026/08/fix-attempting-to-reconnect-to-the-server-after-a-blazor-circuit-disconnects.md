---
title: "Lösung: Attempting to reconnect to the server nach dem Abbruch eines Blazor-Server-Circuits"
description: "Das Reconnect-Modal bedeutet, dass der SignalR-Circuit abgerissen ist, nicht dass die Anwendung abgestürzt ist. Prüfen Sie, ob der Versuch in failed oder rejected endet, und beheben Sie Session-Affinität, das 3-Minuten-Fenster, das 32-KB-Limit oder persistieren Sie den Zustand mit [PersistentState]."
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
lang: "de"
translationOf: "2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects"
translatedBy: "claude"
translationDate: 2026-08-06
---

Das Modal ist kein Fehler, es ist Blazors Hinweis darauf, dass der SignalR-Circuit abgerissen ist und der Client es erneut versucht. Entscheidend ist, wie der Versuch endet. Endet er in `failed` ("Reconnection failed", "Failed to rejoin"), hat der Browser den Server nie erreicht: Prüfen Sie den WebSocket-Pfad durch Ihren Proxy, die Keep-Alive-Zeiten und das 32-KB-Limit von `MaximumReceiveMessageSize`. Endet er in `rejected` ("Could not reconnect to the server", "Failed to resume the session"), wurde der Server erreicht und hat abgelehnt: Der Circuit ist weg, weil die Anwendung neu gestartet wurde, weil der Load Balancer Sie ohne Session-Affinität auf eine andere Instanz geleitet hat, oder weil die `DisconnectedCircuitRetentionPeriod` von 3 Minuten abgelaufen ist. In .NET 10 und .NET 11 lautet die dauerhafte Antwort auf die letzte Gruppe: Kümmern Sie sich nicht länger um die Identität des Circuits, sondern markieren Sie Ihren Zustand mit `[PersistentState]`.

```text
Attempting to reconnect to the server: 3 of 8
Reconnection failed. Try reloading the page if you're unable to reconnect.
Could not reconnect to the server. Reload the page to restore functionality.
```

Das sind die Texte aus .NET 8 und früher, und genau die landen bei den meisten in der Suchmaske. Ab .NET 9 haben dieselben Zustände einen anderen Wortlaut, weshalb die Suchergebnisse wie ein anderes Problem wirken:

```text
Rejoining the server...
Rejoin failed... trying again in 5 seconds.
Failed to rejoin. Please retry or reload the page.
The session has been paused by the server.
Failed to resume the session. Please retry or reload the page.
```

Alles Folgende ist gegen .NET 11 Preview 6 (SDK `11.0.100-preview.6.26359.118`) mit dem Blazor-Web-App-Template im Rendermodus Interactive Server verifiziert und weist darauf hin, wo sich .NET 8, 9 und 10 anders verhalten. Blazor WebAssembly hat keinen Circuit. Wenn Sie dieses Modal sehen, rendern Ihre Komponenten also mit `InteractiveServer` oder mit `InteractiveAuto`, das aktuell serverseitig aufgelöst ist.

## Warum ein abgerissener WebSocket ein Modal statt einer Ausnahme erzeugt

Eine serverseitige Blazor-Anwendung hält den Komponentenbaum, jedes Feld jeder Komponenteninstanz und jeden auf den Circuit begrenzten DI-Dienst im Serverspeicher. Dieses Bündel ist der Circuit. Der Browser hält nur ein gerendertes DOM und eine SignalR-Verbindung; jeder Klick ist ein Remote-Aufruf an den Server, und jedes Rendering ist ein Diff, das zurückgeschickt wird. Bricht die Verbindung, hat der Browser nichts, womit er rendern könnte, also legt sich das Framework über die Seite und versucht, sich anhand der ID wieder an denselben Circuit anzuhängen.

Diese Oberfläche muss niemand schreiben. Definiert Ihre Anwendung ein Element mit `id="components-reconnect-modal"`, setzt und entfernt Blazor darauf CSS-Klassen. Fehlt es, injiziert Blazor sein eigenes eingebautes Modal, und daher stammt der klassische Wortlaut. Das ist der wichtige Punkt beim Debuggen: Die Meldung, die Sie sehen, entsteht vollständig auf dem Client und aus Client-Zustand. Sie sagt nichts darüber aus, was der Server für passiert hält. Die Serverseite steht in Ihren Logs.

## Die drei Endzustände, und welchen Sie tatsächlich haben

Seit .NET 10 löst das Framework auf dem Modal-Element ein `components-reconnect-state-changed`-Ereignis aus und setzt die passende CSS-Klasse, sodass Sie das Ergebnis ablesen statt raten können:

| CSS-Klasse | `detail.state` des Ereignisses | Bedeutung |
| --- | --- | --- |
| `components-reconnect-show` | `show` | Verbindung verloren, es wird erneut versucht. |
| `components-reconnect-retrying` | `retrying` | Ein Verbindungsversuch läuft gerade. |
| `components-reconnect-paused` | `paused` | Der Circuit wurde pausiert (durch Client oder Server). |
| `components-reconnect-hide` | `hide` | Wieder verbunden. Es ging nichts verloren. |
| `components-reconnect-failed` | `failed` | Der Server wurde nie erreicht. Rufen Sie `Blazor.reconnect()` auf. |
| `components-reconnect-rejected` | `rejected` | Der Server wurde erreicht und hat abgelehnt. Rufen Sie `location.reload()` auf. |

In .NET 9 und früher gibt es nur die CSS-Klassen, kein Ereignis. So oder so sind `failed` und `rejected` die Weggabelung der Diagnose, und sie haben fast keine gemeinsamen Ursachen. Protokollieren Sie, welchen Zustand Sie bekommen, bevor Sie irgendeine Konfiguration ändern:

```javascript
// .NET 10 or .NET 11, wwwroot or a collocated ReconnectModal.razor.js
const modal = document.getElementById("components-reconnect-modal");
modal.addEventListener("components-reconnect-state-changed", e => {
  console.log("[circuit]", e.detail.state, new Date().toISOString());
});
```

## Die minimale Reproduktion

Sie brauchen dafür keine kaputte Anwendung. Eine beliebige Interactive-Server-Komponente plus ein beendeter Prozess genügen:

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();
app.MapRazorComponents<App>()
   .AddInteractiveServerRenderMode();
app.Run();
```

Starten Sie sie, öffnen Sie die Counter-Seite, klicken Sie ein paar Mal und beenden Sie den Prozess mit Ctrl+C. Das Modal erscheint nach etwa einer halben Sekunde. Starten Sie den Prozess neu und beobachten Sie, was passiert: Die Verbindung kommt zustande, aber die Circuit-ID ist dem neuen Prozess unbekannt, Sie erhalten also `rejected` statt `hide`, und der Zählerstand ist wieder auf null. Vergleichen Sie das mit einem Netzwerkabbruch (DevTools, Network, Offline): Die Versuche erreichen nichts, Sie erhalten `failed`, und nach Wiederherstellung des Netzwerks landet ein Versuch auf dem ursprünglichen Circuit mit unverändertem Zählerstand, solange Sie innerhalb des Aufbewahrungsfensters sind.

Dieser Unterschied ist die gesamte Diagnose im Kleinen. `failed` ist ein Transportproblem. `rejected` ist ein Lebensdauerproblem.

## Lösung 1: Session-Affinität, wenn Sie mehr als eine Instanz betreiben

Das ist die häufigste Produktionsursache und erzeugt bei praktisch jedem Reconnect ein `rejected`. Der Circuit liegt im Speicher genau eines Prozesses. Ein Reconnect, der auf einer anderen Instanz landet, findet die Circuit-ID nicht und lehnt ab. Zwei Server hinter einem Round-Robin-Load-Balancer bedeuten, dass etwa die Hälfte aller Reconnects dauerhaft scheitert, und es wirkt sporadisch, weshalb es Tests überlebt.

Aktivieren Sie Session-Affinität (Sticky Sessions) am Load Balancer: ARR-Affinität bei Azure App Service, `sessionAffinity` an Ihrem Ingress, `ip_hash` oder ein Sticky-Cookie bei nginx. Das zugehörige Symptom, nach dem Sie in den Logs suchen können, ist `Invocation canceled due to the underlying connection being closed`. Ist Affinität nicht möglich, können Sie In-Memory-Circuits nicht über Instanzen hinweg halten, und Sie brauchen stattdessen die verteilte Persistenz aus Lösung 5.

## Lösung 2: Wiederholungsplan und Aufbewahrungsfenster aufeinander abstimmen

Der Server behält einen getrennten Circuit für `DisconnectedCircuitRetentionPeriod`, standardmäßig 3 Minuten, und hält höchstens `DisconnectedCircuitMaxRetained` davon vor, standardmäßig 100. Danach wird der Circuit verworfen, und jeder spätere Reconnect ist per Definition `rejected`.

Der clientseitige Plan hat sich in .NET 9 geändert und überdauert dieses Fenster inzwischen regelmäßig:

- **.NET 8 und früher**: `maxRetries: 8`, `retryIntervalMilliseconds: 20000`. Fester Abstand von 20 Sekunden, der Client gibt also nach rund 160 Sekunden auf, knapp innerhalb der 3 Minuten des Servers.
- **.NET 9, .NET 10, .NET 11**: `maxRetries: 30` mit berechnetem Backoff. Die ersten 10 Versuche laufen so schnell, wie der Handshake es zulässt, die Versuche 11 bis 20 liegen 5 Sekunden auseinander, alles danach 30 Sekunden. Das sind rund 350 Sekunden Wiederholung gegen einen Circuit, den der Server bei 180 gelöscht hat.

Ab .NET 9 bekommt also jemand, der 4 Minuten weggeht, ein Modal, das weiter herunterzählt und dann ablehnt. Das ist so vorgesehen, aber es ist eine schlechte Erfahrung, und es lohnt sich, die beiden Zahlen in Einklang zu bringen. Entweder verlängern Sie den Server:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents(options =>
    {
        options.DisconnectedCircuitRetentionPeriod = TimeSpan.FromMinutes(6);
        options.DisconnectedCircuitMaxRetained = 100;
        options.JSInteropDefaultCallTimeout = TimeSpan.FromSeconds(30);
    });
```

oder Sie kürzen den Client, damit er schnell scheitert und neu lädt, statt etwas vorzutäuschen:

```html
<!-- .NET 10 or .NET 11, App.razor. Requires autostart="false" on the Blazor script. -->
<script src="_framework/blazor.web.js" autostart="false"></script>
<script>
  Blazor.start({
    circuit: {
      reconnectionOptions: {
        maxRetries: 8,
        retryIntervalMilliseconds:
          Array.prototype.at.bind([0, 0, 1000, 2000, 5000, 10000, 15000, 30000])
      }
    }
  });
</script>
```

Ein `null` oder `undefined` aus `retryIntervalMilliseconds` beendet die Wiederholungen, und genau das liefert `Array.prototype.at`, sobald Sie über das Ende des Arrays hinauslaufen. Beachten Sie die Speicherkosten, bevor Sie den Serverwert erhöhen: Jeder vorgehaltene Circuit ist ein lebender Komponentenbaum samt seiner Scoped-Dienste, und 100 davon sind in einer ausgelasteten Anwendung eine reale Größe.

## Lösung 3: das 32-KB-Limit, wenn das Modal endlos wiederkehrt

Erscheint das Modal im normalen Betrieb immer wieder, besonders direkt nach einem Datei-Upload, einem großen Formular-Post oder einer großen JS-Interop-Nutzlast, dann treffen Sie mit ziemlicher Sicherheit `HubOptions.MaximumReceiveMessageSize`, standardmäßig 32 KB. Eine Überschreitung schließt den Circuit mit einem Fehler, der Client verbindet sich neu, der Benutzer wiederholt die Aktion, und es schließt erneut.

Die Browserkonsole zeigt nur ein generisches Close:

```text
Error: Connection disconnected with error 'Error: Server returned an error on close: Connection closed with an error.'
```

Die eigentliche Meldung erscheint nur mit `Microsoft.AspNetCore.SignalR`-Logging auf Debug oder Trace:

```text
System.IO.InvalidDataException: The maximum message size of 32768B was exceeded.
```

Das Limit anzuheben funktioniert und kostet Sie Spielraum gegen Denial-of-Service:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.MaximumReceiveMessageSize = 64 * 1024;
    });
```

Die bessere Lösung für alles wirklich Große ist Streaming-JS-Interop, das unterhalb des Limits stückelt, statt es anzuheben. Lassen Sie `MaximumParallelInvocationsPerClient` auf dem Standardwert `1`: Blazor setzt das voraus, und ein höherer Wert bricht `InputFile`-Uploads.

Es gibt eine zweite Ausprägung desselben Problems, die beim ersten Laden auftritt und nicht bei der Interaktion. Überschreitet der über `PersistentComponentState` durchgereichte vorgerenderte Zustand das Limit, startet der Circuit nie, und im Log steht `Circuit host not initialized`. Persistieren Sie weniger, oder heben Sie das Limit an.

## Lösung 4: Timeouts und Proxys, die untätige WebSockets kappen

Ein `failed`, das nur nach einer Leerlaufphase, auf Mobilgeräten oder hinter einem Reverse Proxy auftritt, ist ein Transport-Timeout. Drei Zahlen müssen zusammenpassen:

```csharp
// .NET 11 preview 6. Program.cs. These are the framework defaults, stated explicitly.
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
        options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        options.HandshakeTimeout = TimeSpan.FromSeconds(15);
    });
```

Die Regel lautet: Das Server-Timeout sollte mindestens doppelt so groß sein wie das Keep-Alive-Intervall. Erhöhen Sie das eine, erhöhen Sie auch das andere. Sorgen Sie dann dafür, dass Ihre Infrastruktur eine zwischen Keep-Alives untätige Verbindung toleriert: `proxy_read_timeout` bei nginx, das WebSocket-Leerlauf-Timeout im Application Gateway sowie `webSocket enabled="true"` plus ein sinnvolles `pingInterval` in IIS. Ein Proxy, der nach 20 Sekunden schließt, erzeugt dauerhaft alle 20 Sekunden ein Reconnect-Modal, und keine Blazor-Konfiguration wird das beheben.

Mobile Browser und Hintergrund-Tabs sind die andere Hälfte davon. Ein gedrosselter Tab führt keine Timer mehr aus, das Keep-Alive setzt aus, und der Server verwirft den Circuit. Ab .NET 9 wird sofort neu verbunden, sobald der Tab wieder sichtbar wird, statt auf den nächsten geplanten Versuch zu warten, und das `ReconnectModal.razor.js` aus dem .NET-10-Template versucht es nach einem Fehlschlag zusätzlich bei `visibilitychange` erneut. Ein Upgrade ist also eine echte Lösung für die Meldung "ich kam zu meinem Tab zurück und alles war weg".

## Lösung 5: In .NET 10 und 11 den Zustand persistieren und den Circuit loslassen

Alles bisher Genannte versucht, einen Circuit am Leben zu halten. .NET 10 bietet die Möglichkeit, das aufzugeben und stattdessen den Zustand zu behalten. Markieren Sie Eigenschaften von Komponenten oder von Scoped-Diensten mit `[PersistentState]`, und Blazor serialisiert sie, wenn der Circuit geräumt wird, und füllt sie wieder in den neuen Circuit, sobald derselbe Tab sich neu verbindet:

```razor
@* .NET 10 or .NET 11, Counter.razor *@
@page "/counter"
@rendermode InteractiveServer

<p role="status">Current count: @CurrentCount</p>
<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int CurrentCount { get; set; }

    private void IncrementCount() => CurrentCount++;
}
```

Das ist standardmäßig aktiv, sobald `AddInteractiveServerComponents` aufgerufen wird. Der In-Memory-Provider hält bis zu 1.000 persistierte Circuits für zwei Stunden vor, beides konfigurierbar:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.Configure<CircuitOptions>(options =>
{
    options.PersistedCircuitInMemoryMaxRetained = 2_000;
    options.PersistedCircuitInMemoryRetentionPeriod = TimeSpan.FromHours(3);
});
```

Für mehrere Instanzen weisen Sie einen `HybridCache` zu, und der persistierte Zustand wird verteilt, mit eigener `PersistedCircuitDistributedRetentionPeriod` von standardmäßig acht Stunden. Das ist der Notausgang, wenn keine Session-Affinität verfügbar ist:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddHybridCache()
    .AddRedis("{CONNECTION STRING}");

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();
```

Einschränkungen, die Sie kennen sollten, bevor Sie sich darauf verlassen: Es funktioniert nur beim Rendermodus Interactive Server, der Zustand muss JSON-serialisierbar sein (EF-Core-Entitäten mit Zyklen überstehen das nicht), ein vollständiges Neuladen der Seite verwirft ihn, und es gibt keine Garantie auf Wiederherstellung, die Anwendung fällt bei fehlgeschlagener Persistenz also auf das normale Trennungsverhalten zurück. Verwenden Sie `@key`, wenn Sie persistierte Komponenten in einer Schleife rendern.

Dieselbe Mechanik trägt das Pausieren. `Blazor.pauseCircuit()` und `Blazor.resumeCircuit()` erlauben es, den Circuit eines verborgenen Tabs fallen zu lassen und bei der Rückkehr neu aufzubauen, und .NET 11 ergänzt die Serverseite mit `Circuit.RequestCircuitPauseAsync(CancellationToken)`. Eine Bereitstellung kann verbundene Clients so bitten, vor dem Prozessstopp zu pausieren und zu persistieren, statt jedem Benutzer einen abgelehnten Reconnect zu bescheren. Clients können das über den Callback `onPauseRequested` in `Blazor.start` aufschieben.

## Fallstricke, die zur falschen Lösung führen

- **Das Reconnect-Modal ist nicht `blazor-error-ui`.** Der gelbe Balken mit "An unhandled error has occurred" ist eine Komponentenausnahme, die den Circuit ebenfalls abreißt. Sehen Sie beides, beheben Sie zuerst die Ausnahme: Jede unbehandelte Ausnahme in einer Komponente beendet den Circuit, und der anschließende Reconnect ist immer `rejected`.
- **Nur das erste passende Element bekommt die Klassen.** Rendern ein Layout und eine Seite jeweils ein Element mit `id="components-reconnect-modal"`, schaltet Blazor nur das zuerst gefundene um, und das zweite wirkt kaputt.
- **Die Verzögerung von 500 ms ist Absicht.** Blazor wartet etwa eine halbe Sekunde, bevor es das Modal zeigt, damit ein kurzer Aussetzer die Oberfläche nicht aufblitzen lässt. Verlängern Sie sie mit CSS, `transition: visibility 0s linear 1000ms`, nicht mit JavaScript.
- **`Reconnection failed` und `Could not reconnect` sind verschiedene Zustände.** Beim ersten sollte `Blazor.reconnect()` aufgerufen werden, beim zweiten muss `location.reload()` folgen. Beides auf denselben Handler zu legen, ergibt entweder eine Endlosschleife an Versuchen oder ein Neuladen, das wiederherstellbaren Zustand wegwirft.
- **Ein 404 oder 400 auf `_blazor` ist nicht dieser Fehler.** Das ist ein nicht gemappter Hub-Endpunkt oder ein Proxy, der die Upgrade-Header entfernt, und dann wird kein Reconnect jemals gelingen.
- **Der Fall des geparkten Tabs lässt sich jetzt per Upgrade lösen.** Einen zwei Stunden alten Tab wieder zu verbinden, war mit reinen In-Memory-Circuits nie möglich. Ab .NET 10 ist es das, mit `[PersistentState]`.

## Verwandte Beiträge

- [Blazor Server vs. Blazor WebAssembly vs. Blazor United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) behandelt den Kompromiss beim Hosting-Modell, der Sie überhaupt erst auf Circuits bringt.
- [Zustand über die statisch-zu-interaktiv-Rendergrenze von Blazor in .NET 11 hinweg persistieren](/de/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) ist die vollständige Behandlung von `[PersistentState]` und `PersistentComponentState`.
- [HybridCache in ASP.NET Core 11 mit Redis als L2-Cache verwenden](/de/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) richtet den verteilten Cache ein, der die Circuit-Persistenz über Instanzen hinweg trägt.
- [Lösung: JavaScript interop calls cannot be issued at this time (Blazor-Prerendering)](/de/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) ist der andere Blazor-Fehler, der aus einer falschen Annahme über den aktuellen Renderdurchlauf entsteht.
- [Eine Blazor-Server-Anwendung nach Blazor United (Blazor Web App) in .NET 11 migrieren](/de/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) ist der Weg zu dem Template, das die anpassbare `ReconnectModal`-Komponente mitbringt.

## Quellen

- Microsoft Learn, [ASP.NET Core Blazor SignalR guidance](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/signalr?view=aspnetcore-11.0) (Reconnect-CSS-Klassen, die Tabelle zum Ereignis `components-reconnect-state-changed`, `MaximumReceiveMessageSize`, Hub-Timeouts, Session-Affinität).
- Microsoft Learn, [ASP.NET Core Blazor server-side state management](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/server?view=aspnetcore-11.0) (Standardwerte der Circuit-Zustandspersistenz, `PersistedCircuitInMemoryRetentionPeriod`, Pausieren und Fortsetzen, `Circuit.RequestCircuitPauseAsync`).
- Microsoft Learn, [CircuitOptions.DisconnectedCircuitRetentionPeriod](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.server.circuitoptions.disconnectedcircuitretentionperiod) (der Standardwert von 3 Minuten).
- dotnet/aspnetcore, [`CircuitStartOptions.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/CircuitStartOptions.ts) (die `maxRetries` von 30 und die Stufen 0 ms / 5 s / 30 s in `computeDefaultRetryInterval`; der .NET-8-Branch hat `maxRetries: 8` und `retryIntervalMilliseconds: 20000`).
- dotnet/aspnetcore, [`DefaultReconnectDisplay.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/DefaultReconnectDisplay.ts) (die genauen Modal-Texte je Zustand, sowohl im .NET-8-Branch als auch im aktuellen).
- dotnet/aspnetcore, [`ReconnectModal.razor.js` im Blazor-Web-App-Template](https://github.com/dotnet/aspnetcore/blob/main/src/ProjectTemplates/Web.ProjectTemplates/content/BlazorWeb-CSharp/BlazorWebCSharp.1/Components/Layout/ReconnectModal.razor.js) (die Abfolge `Blazor.reconnect()`, dann `Blazor.resumeCircuit()`, dann `location.reload()`, und der erneute Versuch bei `visibilitychange`).
