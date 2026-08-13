---
title: "Blazor-Server-Circuits pausieren sich jetzt selbst, wenn der Tab untätig ist"
description: ".NET 11 Preview 7 bringt ein optionales Paket, das interaktive Server-Circuits pausiert, sobald der Browser-Tab ausgeblendet ist. Das gibt Speicher und SignalR-Verbindungen frei, die von gar nicht anwesenden Benutzern belegt werden."
pubDate: 2026-08-13
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "signalr"
lang: "de"
translationOf: "2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-13
---

.NET 11 Preview 7 ist am 2026-08-11 erschienen, und im ASP.NET-Core-Abschnitt steckt die Lösung für eines der ältesten Kapazitätsprobleme von Blazor Server: Ein Circuit, den niemand ansieht, kostet genau so viel wie ein Circuit, den jemand benutzt. Die [Release Notes zu ASP.NET Core Preview 7](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/aspnetcore.md) führen die automatische Pause ein, angestoßen durch [dotnet/aspnetcore#64886](https://github.com/dotnet/aspnetcore/issues/64886).

## Ausgeblendete Tabs sind keine getrennten Tabs

Blazor Server hält den Zustand pro Benutzer in einem Circuit auf dem Server, und dieser Circuit lebt so lange wie die SignalR-Verbindung. Wechselt ein Benutzer in einen anderen Tab und vergisst Ihren, wird der WebSocket nicht geschlossen. Desktop-Browser halten ihn stundenlang offen. Der Circuit behält seinen Komponentenbaum, seinen DI-Scope, seine Renderwarteschlange und seinen Platz in Ihrem Parallelitätsbudget, und das für einen Benutzer, der in der Mittagspause gegangen ist.

Die automatische Pause hängt sich stattdessen an das Sichtbarkeitssignal des Browsers. Ist der Tab für eine konfigurierbare Dauer ausgeblendet, bittet der Client den Server, den Circuit zu pausieren, wodurch dieser freigegeben wird. Kommt der Benutzer zurück, wird der Circuit fortgesetzt.

## Aktivierung

Die Funktion ist optional und liegt in einem eigenen Paket:

```xml
<PackageReference Include="Microsoft.AspNetCore.Components.Server.AutoPause" />
```

Die Konfiguration hängt an der Registrierung des Rendermodus:

```csharp
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .WithBrowserOptions(options =>
    {
        options.AddAutoPause(pause =>
        {
            pause.Enabled = true; // default
            pause.HiddenDelay = TimeSpan.FromSeconds(30); // default is 2 minutes
        });
    });
```

`HiddenDelay` liegt standardmäßig bei zwei Minuten. Ein Wert von 30 Sekunden gibt Speicher schneller frei, kostet aber mehr Fortsetzungs-Roundtrips bei Benutzern, die ständig zwischen Tabs hin und her springen.

## Die Fälle, in denen nicht pausiert wird

Der interessante Teil ist, was die automatische Pause bewusst unterlässt. Sie verschiebt die Pause, wenn ein Textfeld oder ein `contenteditable`-Element den Fokus hat, wenn nicht stummgeschaltetes Audio oder Video läuft, wenn ein Picture-in-Picture-Fenster geöffnet ist, wenn ein Web Lock gehalten wird und solange noch Circuit-Aktivität unterwegs ist, etwa ein `IJSRuntime`-Aufruf oder eine Stream-Übertragung. Ein ausgeblendeter Tab, der weiterhin im Auftrag des Benutzers arbeitet, wird also nicht abgeräumt.

Eigene Verschiebungslogik lässt sich über einen JavaScript-Initialisierer ergänzen:

```javascript
// wwwroot/{ASSEMBLY NAME}.lib.module.js
export function beforeWebStart(options) {
  options.circuit ??= {};
  options.circuit.circuitHandlers ??= [];

  options.circuit.circuitHandlers.push({
    onCircuitPausing: async (signal) => {
      await savePendingWork(signal);
    },
  });
}
```

Das `signal` bricht ab, wenn die Pause abgebrochen wird, etwa weil der Tab wieder sichtbar wurde, während Ihr Handler noch gespeichert hat. Auf Serverseite gibt `Circuit.RequestCircuitPauseAsync` jetzt `Task<bool>` zurück und akzeptiert ein optionales Cancellation Token, sodass die Verschiebungsarbeit beim Verbindungsabbruch abgebrochen werden kann.

## Was Sie vor dem Aktivieren prüfen sollten

Die automatische Pause setzt auf der in .NET 10 eingeführten Pause-und-Fortsetzen-Mechanik auf. Das Fortsetzen baut den Circuit also aus dem persistierten Komponentenzustand neu auf. Alles, was eine Komponente in einem gewöhnlichen Feld hält und nie als persistent deklariert, ist nach einer Pause weg. Prüfen Sie Ihre zustandsbehafteten Komponenten, bevor Sie das in Produktion einschalten, und beobachten Sie Ihre Reconnect-Telemetrie: Das Fehlerbild sieht hier stark aus wie [ein Circuit, der sich von selbst getrennt hat](/de/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/).

Preview 7 ist ein volles Release. Auf der C#-Seite kam im selben Schub [break und continue mit Label](/de/2026/08/csharp-15-labeled-break-and-continue-dotnet-11-preview-7/) dazu.
