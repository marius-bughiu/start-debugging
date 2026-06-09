---
title: "Zustand über die statisch-zu-interaktiv-Renderinggrenze in Blazor unter .NET 11 persistieren"
description: "Eine vorgerenderte Blazor-Komponente führt ihre Initialisierung zweimal aus und verliert den Zustand beim Übergang zu interaktiv. Beheben Sie das mit dem Attribut [PersistentState] oder dem Dienst PersistentComponentState in .NET 11."
pubDate: 2026-06-09
template: how-to
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "ssr"
lang: "de"
translationOf: "2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-09
---

Eine Blazor-Komponente auf dem Blazor-Web-App-Template führt ihre Initialisierung zweimal aus: einmal während des Vorrenderings (statisches serverseitiges Rendering) und erneut, wenn die Komponente interaktiv rendert. Alles, was Sie beim ersten Mal in `OnInitializedAsync` abgerufen oder berechnet haben, ist beim zweiten Mal verloren, also ruft die Komponente die Daten erneut ab, und der Benutzer sieht, wie die vorgerenderte UI beim Austausch flackert. Die Lösung besteht darin, diesen Zustand während des Vorrenderings zu erfassen und über die Grenze hinweg zu übergeben. In .NET 11 haben Sie dafür zwei Möglichkeiten: das deklarative Attribut `[PersistentState]` (der einfache Weg, verfügbar seit .NET 10) und den imperativen Dienst `PersistentComponentState` (verfügbar seit .NET 8, für alles, was das Attribut nicht ausdrücken kann). Dieser Beitrag bezieht sich auf .NET 11 (zum Zeitpunkt des Schreibens als Preview, GA für November 2026 geplant) und das Paketset `Microsoft.AspNetCore.Components` 11.0.x.

## Warum die Komponente zweimal initialisiert

Das Blazor-Web-App-Template rendert eine Seite in zwei Durchläufen. Der erste Durchlauf ist das Vorrendering: Der Server führt Ihre Komponente als statisches HTML aus, führt `OnInitialized` / `OnInitializedAsync` aus und liefert das resultierende Markup aus, damit die Seite schnell gezeichnet und gut indexiert wird. Der zweite Durchlauf ist die Interaktivität: Sobald die Laufzeit startet (ein SignalR-Circuit für `InteractiveServer`, die heruntergeladene WASM-Nutzlast für `InteractiveWebAssembly` oder eines von beiden für `InteractiveAuto`), instanziiert Blazor eine frische Kopie der Komponente und führt die Initialisierung ein zweites Mal aus.

Diese zweite Instanz erbt kein Feld, das Sie während des Vorrenderings gesetzt haben. Sie startet mit den Standardwerten. Wenn Ihre Initialisierung so aussah:

```razor
@* PrerenderedCounter1.razor *@
@* .NET 11, Blazor Web App, any interactive render mode *@
@page "/prerendered-counter-1"
@inject ILogger<PrerenderedCounter1> Logger

<p role="status">Current count: @currentCount</p>

@code {
    private int currentCount;

    protected override void OnInitialized()
    {
        currentCount = Random.Shared.Next(100);
        Logger.LogInformation("currentCount set to {Count}", currentCount);
    }
}
```

sehen Sie `currentCount set to 41` während des Vorrenderings und `currentCount set to 92` einen Moment später, wenn die Komponente interaktiv wird, mit einem sichtbaren Wechsel von 41 zu 92 im Browser. Bei einer Zufallszahl ist das nur eine Kuriosität. Bei einem Datenbankaufruf ist es eine doppelte Abfrage, eine langsamere Time-to-Interactive und ein echtes Flackern zwischen dem vorgerenderten und dem erneut abgerufenen Wert.

Dies ist speziell die Vorrendering-zu-interaktiv-Grenze. Wenn Ihre `Routes`-Komponente keinen Render Mode definiert und Sie die Seite über eine interne [Enhanced Navigation](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing) erreichen, findet kein Vorrendering statt, also läuft die Initialisierung einmal, und es gibt nichts zu persistieren. Um die doppelte Initialisierung zu reproduzieren, benötigen Sie einen vollständigen Seitenneulade.

## Die deklarative Lösung: das Attribut `[PersistentState]`

Der sauberste Weg, den Zustand in .NET 11 über die Grenze zu tragen, besteht darin, ihn auf eine öffentliche Eigenschaft zu legen und sie mit `[PersistentState]` zu annotieren. Blazor serialisiert die Eigenschaft in das vorgerenderte HTML und deserialisiert sie dann vor der Initialisierung wieder in die interaktive Instanz. Ihre Aufgabe ist es nur, zu erkennen, ob der Wert wiederhergestellt wurde:

```razor
@* PrerenderedCounter2.razor *@
@* .NET 11 / .NET 10. [PersistentState] requires aspnetcore 10.0+ *@
@page "/prerendered-counter-2"
@inject ILogger<PrerenderedCounter2> Logger

<p role="status">Current count: @CurrentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int? CurrentCount { get; set; }

    protected override void OnInitialized()
    {
        if (CurrentCount is null)
        {
            CurrentCount = Random.Shared.Next(100);
            Logger.LogInformation("CurrentCount set to {Count}", CurrentCount);
        }
        else
        {
            Logger.LogInformation("CurrentCount restored to {Count}", CurrentCount);
        }
    }

    private void IncrementCount() => CurrentCount++;
}
```

Jetzt zeigt das Log `CurrentCount set to 96` während des Vorrenderings und `CurrentCount restored to 96`, wenn die Interaktivität einsetzt. Derselbe Wert, kein zweites `Random.Shared.Next`, kein Flackern.

Drei Regeln lassen das funktionieren, und über sie stolpert man leicht:

1. **Die Eigenschaft muss `public` sein.** Das Framework verwendet Reflection darauf für Serialisierung, Trimming-Analyse und Source Generation. Ein `private`-Feld mit dem Attribut wird nicht erfasst.
2. **Verwenden Sie einen nullbaren oder per Standardwert erkennbaren Typ.** Sie müssen "wiederhergestellt" von "nie gesetzt" unterscheiden. Ein nullbarer Typ (`int?`, `WeatherForecast[]?`) ist das idiomatische Signal. Bei Referenztypen bedeutet `null`, dass das Vorrendering ihn befüllen muss.
3. **Befüllen Sie nur, wenn null.** Die Prüfung `if (CurrentCount is null)` hält die teure Arbeit im Vorrendering-Durchlauf und überspringt sie im interaktiven Durchlauf.

Die realistische Variante ist ein Datenladevorgang. Beim Vorrendering abrufen, beim interaktiven Durchlauf wiederverwenden:

```razor
@* ContactList.razor -- .NET 11, InteractiveAuto render mode *@
@page "/contacts"
@inject IContactService Contacts

@if (Items is null)
{
    <p>Loading...</p>
}
else
{
    <ul>@foreach (var c in Items) { <li>@c.Name</li> }</ul>
}

@code {
    [PersistentState]
    public IReadOnlyList<Contact>? Items { get; set; }

    protected override async Task OnInitializedAsync()
    {
        // Runs the query on the prerender pass; the interactive pass
        // gets Items back already populated and skips the call.
        Items ??= await Contacts.GetAllAsync();
    }
}
```

### Den Zustand der richtigen Instanz zuordnen

Wenn eine Seite mehrere Komponenten desselben Typs in einer Schleife rendert, muss der persistierte Zustand wieder der richtigen Instanz zugeordnet werden. Verwenden Sie die Direktive `@key`, damit Blazor die serialisierten Blobs der richtigen Komponente zuordnen kann:

```razor
@* Parent.razor -- .NET 11 *@
@page "/parent"

@foreach (var element in elements)
{
    <PersistentChild @key="element.Name" />
}
```

Innerhalb von `PersistentChild` wird die `[PersistentState]`-Eigenschaft pro Key wiederhergestellt. Ohne `@key` können zwei Instanzen ihren Zustand vertauschen oder verlieren.

### Schreibgeschützte Daten und Enhanced Navigation

Standardmäßig wird der persistierte Zustand nur geladen, wenn eine interaktive Komponente erstmals auf der Seite erscheint. Das ist Absicht: Es verhindert, dass eine spätere Enhanced Navigation zur selben Seite den lebenden Zustand überschreibt, etwa ein halb bearbeitetes Formular. Wenn Ihr Zustand schreibgeschützt ist und es für einen Moment unkritisch ist, ihn falsch zu haben (zwischengespeicherte Daten, die sich selten ändern), aktivieren Sie Aktualisierungen während der Enhanced Navigation mit `AllowUpdates`:

```csharp
// .NET 11 -- allow the value to refresh on enhanced navigation
[PersistentState(AllowUpdates = true)]
public WeatherForecast[]? Forecasts { get; set; }

protected override async Task OnInitializedAsync()
{
    Forecasts ??= await ForecastService.GetForecastAsync();
}
```

Beachten Sie, dass die Persistenz über Enhanced Navigations hinweg eine Funktion von .NET 10+ ist. Unter .NET 8 und .NET 9 lieferte der Dienst `PersistentComponentState` den Zustand nur beim ersten Seitenladen, niemals über eine Enhanced Navigation auf einem bereits laufenden Circuit. Wenn Sie auf dieses Verhalten angewiesen sind, funktioniert es unter .NET 11 sauber.

### Wiederherstellung in bestimmten Situationen überspringen

.NET 10 gab `[PersistentState]` eine zweite Aufgabe: den Zustand zu persistieren, wenn ein `InteractiveServer`-Circuit entfernt wird, und ihn beim Reconnect wiederherzustellen, sodass eine abgebrochene Verbindung den Komponentenzustand nicht mehr löscht. Das führt zu zwei Fällen, in denen Sie auf eine Wiederherstellung verzichten möchten. `RestoreBehavior` steuert sie:

```csharp
// Do not restore the prerendered value (start fresh on interactivity)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipInitialValue)]
public string? NoPrerenderedData { get; set; }

// Do not restore the last snapshot on reconnection (force fresh data after a reconnect)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipLastSnapshot)]
public int CounterNotRestoredOnReconnect { get; set; }
```

## Die imperative Lösung: der Dienst `PersistentComponentState`

Das Attribut deckt die meisten Fälle ab, aber manchmal müssen Sie etwas persistieren, das keine einzelne Eigenschaft ist: einen aus mehreren Feldern abgeleiteten Wert, einen zur Laufzeit berechneten Key oder einen Zustand, den Sie nur unter bestimmten Bedingungen persistieren. Injizieren Sie den Dienst `PersistentComponentState` und registrieren Sie einen Callback. Dies ist der ursprüngliche .NET-8-Mechanismus, und er funktioniert unter .NET 11 genau wie zuvor:

```razor
@* PrerenderedCounter3.razor -- .NET 11, PersistentComponentState service *@
@page "/prerendered-counter-3"
@implements IDisposable
@inject ILogger<PrerenderedCounter3> Logger
@inject PersistentComponentState ApplicationState

<p role="status">Current count: @currentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    private int currentCount;
    private PersistingComponentStateSubscription persistingSubscription;

    protected override void OnInitialized()
    {
        if (!ApplicationState.TryTakeFromJson<int>(
            nameof(currentCount), out var restoredCount))
        {
            currentCount = Random.Shared.Next(100);
            Logger.LogInformation("currentCount set to {Count}", currentCount);
        }
        else
        {
            currentCount = restoredCount!;
            Logger.LogInformation("currentCount restored to {Count}", currentCount);
        }

        // Register LAST to avoid a race condition at app shutdown.
        persistingSubscription = ApplicationState.RegisterOnPersisting(PersistCount);
    }

    private Task PersistCount()
    {
        ApplicationState.PersistAsJson(nameof(currentCount), currentCount);
        return Task.CompletedTask;
    }

    private void IncrementCount() => currentCount++;

    void IDisposable.Dispose() => persistingSubscription.Dispose();
}
```

Die Form ist immer dieselbe:

1. Zuerst `TryTakeFromJson<T>("key", out var value)`. Gibt es `true` zurück, befinden Sie sich im interaktiven Durchlauf, und der Wert wurde wiederhergestellt. Ist es `false`, befinden Sie sich im Vorrendering-Durchlauf und müssen den Wert erzeugen.
2. Registrieren Sie einen Persistierungs-Callback mit `RegisterOnPersisting` und rufen Sie darin `PersistAsJson("key", value)` auf. Registrieren Sie ihn am **Ende** der Initialisierung, um eine Race Condition beim Herunterfahren der Anwendung zu vermeiden.
3. Geben Sie die `PersistingComponentStateSubscription` frei, damit der Callback nicht leckt. `IDisposable` zu implementieren ist hier nicht optional.

Wenn Sie die Wiederherstellung genauso imperativ steuern möchten, wie `RegisterOnPersisting` die Persistenz steuert, hat .NET 10 `RegisterOnRestoring` hinzugefügt, womit Sie sich in den Wiederherstellungsschritt einklinken können. Das passt natürlich zu den obigen Circuit-Reconnect-Szenarien.

## Zustand persistieren, der in einem Dienst lebt, nicht in einer Komponente

Zustand gehört nicht immer zu einer Komponente. Wenn ein scoped DI-Dienst die Daten hält, können Sie auch dessen Eigenschaften persistieren. Markieren Sie die Eigenschaft mit `[PersistentState]` und registrieren Sie den Dienst mit `RegisterPersistentService` für die Persistenz, wobei Sie Blazor mitteilen, für welchen Render Mode er gilt (der Render Mode kann nicht aus dem Diensttyp abgeleitet werden):

```csharp
// CounterTracker.cs -- .NET 11
public class CounterTracker
{
    [PersistentState]
    public int CurrentCount { get; set; }

    public void IncrementCount() => CurrentCount++;
}
```

```csharp
// Program.cs -- .NET 11
using Microsoft.AspNetCore.Components.Web;

builder.Services.AddScoped<CounterTracker>();

builder.Services.AddRazorComponents()
    .RegisterPersistentService<CounterTracker>(RenderMode.InteractiveAuto);
```

Es werden nur scoped Dienste unterstützt. Das Render-Mode-Argument (`RenderMode.Server`, `RenderMode.Webassembly` oder `RenderMode.InteractiveAuto`) entscheidet, welche interaktiven Kontexte den deserialisierten Zustand erhalten. Da die Serialisierung von der tatsächlichen Instanz ausgeht, können Sie eine Abstraktion als persistenten Dienst markieren und die konkrete Implementierung internal halten, was praktisch ist, wenn der Vorrendering-Server und der WebAssembly-Client ein Interface, aber nicht die Implementierung teilen.

## Was über die Leitung geht und die Sicherheitsgrenze, die Sie nicht überschreiten dürfen

Der persistierte Zustand wird in das HTML eingebettet und an den Client übertragen. Wo er landet, hängt vom Render Mode ab, und dies ist der eine Fehler, der eine Bequemlichkeit in ein Leck verwandelt:

- **`InteractiveServer`**: Der Zustand wandert über den Browser hin und zurück, ist aber durch [ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/introduction) geschützt, also bei der Übertragung verschlüsselt.
- **`InteractiveWebAssembly` und `InteractiveAuto`**: Der Zustand wird dem Browser im Klartext offengelegt, weil WebAssembly-Code auf dem Client läuft und ihn lesen muss. Der Modus `Auto` kann zu WebAssembly aufgelöst werden, behandeln Sie ihn also wie den CSR-Fall.

Die Regel: Legen Sie niemals etwas Privates in den persistierten Zustand einer WebAssembly- oder Auto-Komponente. Persistieren Sie die Kontaktliste, nicht das Access-Token. Wenn Sie serverseitige Geheimnisse benötigen, halten Sie sie serverseitig und rufen Sie sie nach der Interaktivität ab, oder bleiben Sie bei `InteractiveServer`.

## Serialisierung, Trimming und Native AOT

Standardmäßig serialisieren `[PersistentState]` und `PersistAsJson` mit `System.Text.Json` unter Verwendung der Standardeinstellungen. Das hat zwei Konsequenzen, die man einplanen sollte.

Erstens ist der Standard-Serializer nicht trimmer-sicher. Wenn Sie mit IL-Trimming oder [Native AOT](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) veröffentlichen, müssen Sie die Typen, die Sie persistieren, erhalten, sonst schlägt der Roundtrip zur Laufzeit fehl, sobald die Metadaten weggetrimmt sind. Richten Sie einen `JsonSerializerContext`-Source-Generator für Ihre persistierten Typen ein, dieselbe Disziplin, die Sie beim [Schreiben eines benutzerdefinierten JsonConverter für System.Text.Json](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) anwenden würden.

Zweitens, wenn die Standard-JSON-Form nicht passt (ein kompaktes Binärformat, eine veraltete Kodierung, ein Typ, den System.Text.Json umständlich behandelt), hat .NET 10 `PersistentComponentStateSerializer<T>` eingeführt, damit Sie die Serialisierung für einen bestimmten Typ übernehmen können:

```csharp
// Registered in Program.cs; applies to int? persisted state
builder.Services.AddSingleton<PersistentComponentStateSerializer<int?>,
    CustomIntSerializer>();
```

Der Serializer implementiert `Persist(T value, IBufferWriter<byte> writer)` und `Restore(ReadOnlySequence<byte> data)`. Ohne einen für einen Typ registrierten benutzerdefinierten Serializer greift Blazor auf JSON zurück, Sie implementieren dies also nur für die Typen, die es benötigen.

## In Razor Pages oder MVC eingebettete Komponenten

Ein Detail, das nicht für das Blazor-Web-App-Template gilt, aber Leute beim Einbetten von Blazor in eine bestehende Anwendung erwischt: Wenn Sie interaktive Komponenten in eine Razor-Pages- oder MVC-View einsetzen, benötigt der Persistenzmechanismus den manuell hinzugefügten Tag Helper. Setzen Sie `<persist-component-state />` direkt vor das schließende `</body>` in Ihrem Layout:

```cshtml
@* Pages/Shared/_Layout.cshtml -- only needed for Razor Pages / MVC hosts *@
<body>
    ...
    <persist-component-state />
</body>
```

Reine Blazor-Web-App-Projekte verdrahten dies automatisch; Sie benötigen den Tag Helper nur im Fall von gemischtem Hosting.

## Die Wahl zwischen den beiden Modellen

Greifen Sie zuerst zu `[PersistentState]`. Es ist weniger Code, es bewältigt die Vorrendering-Grenze und den Circuit-Reconnect kostenlos, und `AllowUpdates` plus `RestoreBehavior` decken die häufigen Varianten deklarativ ab. Wechseln Sie zum Dienst `PersistentComponentState`, wenn die Zustandseinheit keine einzelne öffentliche Eigenschaft ist, wenn Sie den Persistenz-Key zur Laufzeit berechnen oder wenn Sie innerhalb des Callbacks bedingt persistieren müssen. Beide können in derselben Anwendung koexistieren, und beide lösen dasselbe zugrunde liegende Problem: sicherzustellen, dass die Arbeit, die Sie während des Vorrenderings geleistet haben, den Sprung zur Interaktivität überlebt, anstatt erneut zu laufen.

Wenn Sie noch entscheiden, welche Render Modes Ihre Seiten verwenden sollten, rahmen die Abwägungen in [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) ein, wo das Vorrendering überhaupt gilt, und wenn Sie eine ältere Anwendung auf dieses Modell umstellen, nennt die [Migrations-Checkliste von Blazor Server zu Blazor Web App](/de/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) die Doppelausführung des Vorrenderings als das Einzige, was beißt. Um Einmalnachrichten zu übergeben, statt den Renderingzustand zu persistieren, ist [die TempData-Unterstützung im Blazor SSR unter .NET 11](/de/2026/04/blazor-ssr-tempdata-dotnet-11/) stattdessen das richtige Werkzeug.

Primärquelle: [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0) auf Microsoft Learn, das das Attribut `[PersistentState]`, den Dienst `PersistentComponentState`, `RegisterPersistentService` und den Erweiterungspunkt `PersistentComponentStateSerializer<T>` für .NET 10 und .NET 11 dokumentiert.
