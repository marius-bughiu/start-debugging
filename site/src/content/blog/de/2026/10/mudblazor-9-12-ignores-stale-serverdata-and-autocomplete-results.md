---
title: "MudBlazor 9.12: Langsame ServerData- und Autocomplete-Suchen überschreiben neuere Ergebnisse nicht mehr"
description: "MudBlazor 9.12.0 behebt eine alte Race Condition in MudAutocomplete, MudDataGrid und MudTable: Das Ergebnis der Suche, die zuletzt fertig wurde, setzte sich durch, nicht das der zuletzt gestarteten. So funktioniert der Fix und das ändert sich für Ihren ServerData- und SearchFunc-Code."
pubDate: 2026-10-29
tags:
  - "blazor"
  - "mudblazor"
  - "aspnet-core"
  - "dotnet"
  - "async"
lang: "de"
translationOf: "2026/10/mudblazor-9-12-ignores-stale-serverdata-and-autocomplete-results"
translatedBy: "claude"
translationDate: 2026-10-29
---

[MudBlazor 9.12.0](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0) ist am 29. Oktober 2026 erschienen. Das Update lohnt sich vor allem wegen einer Race Condition, die in der einen oder anderen Form seit [Issue #3722](https://github.com/MudBlazor/MudBlazor/issues/3722) offen war. `MudAutocomplete`, `MudDataGrid` mit `ServerData` und `MudTable` mit `ServerData` behielten alle das Ergebnis der Anfrage, die zuletzt *fertig wurde*, nicht das der Anfrage, die der Benutzer zuletzt *gestartet* hat.

## Warum meist die breite Suche gewinnt

Geben Sie "App" in ein Autocomplete ein, warten Sie über die Debounce-Zeit hinaus und tippen Sie dann weiter "le Pie". Jetzt laufen zwei Suchen gleichzeitig. Die kurze Abfrage trifft mehr Zeilen und ist deshalb typischerweise die langsamere. Unter 9.11 und früher erscheinen zuerst die Ergebnisse für "Apple Pie", dann treffen die Ergebnisse für "App" ein und ersetzen sie. Der Benutzer sieht eine Liste, die nicht mehr zum Text im Eingabefeld passt.

Dasselbe passierte bei Grid-Filtern und Paging: Ändert man einen Filter schnell zweimal, konnte der ältere, langsamere `ServerData`-Aufruf die neuere Seite überschreiben.

## Wie 9.12 veraltete Ergebnisse erkennt

[PR #13944](https://github.com/MudBlazor/MudBlazor/pull/13944) verwendet zwei verschiedene Strategien. In `MudAutocomplete` erhält jede Suche eine Versionsnummer, und eine Suche, die von einer neueren ersetzt wurde, steigt aus, bevor sie die Elemente, die Anzahl der zurückgegebenen Elemente oder das Popover anfasst:

```csharp
var searchVersion = ++_searchVersion;
// ... await SearchFunc(text, token) ...
if (searchVersion != _searchVersion)
{
    return;
}
```

Die Prüfung läuft zweimal, das zweite Mal nach `ReturnedItemsCountChanged`, weil Ihr Handler die Kontrolle abgeben kann und in der Zwischenzeit eine neuere Suche fertig werden kann. Das ist wichtig, weil viele `SearchFunc`-Implementierungen das `CancellationToken` komplett ignorieren, sodass eine Abbruchlogik allein das Problem nie hätte lösen können.

`MudDataGrid` stützt sich auf das Token, das es bereits an `ServerData` übergibt. Wurde es von einem neueren Ladevorgang abgebrochen, kehrt der alte Ladevorgang zurück, ohne Daten zuzuweisen oder `Loading` zurückzusetzen, selbst wenn er eine Ausnahme geworfen hat:

```csharp
catch (Exception) when (token.IsCancellationRequested)
{
    // A newer load cancelled this one, and it owns the data and the loading state.
    return;
}
```

Der Ausnahmetyp wird bewusst ignoriert, weil Datenquellen eine abgebrochene Anfrage oft als eigenen Fehler melden (eine `HttpRequestException`, eine anbieterspezifische `DbException` und so weiter). [PR #14053](https://github.com/MudBlazor/MudBlazor/pull/14053) wendet dieselbe Regel auf `MudTable` an, und Folge-Änderungen halten die Ladeanzeige über einen Seitenreset hinweg am Leben und verhindern, dass eine verspätete Suche ein Autocomplete-Menü wieder öffnet, das bereits geschlossen, ausgewählt oder geleert wurde.

## Was sich für Ihren Code ändert

Der PR nennt zwei Verhaltensänderungen:

- Eine überholte Autocomplete-Suche löst `ReturnedItemsCountChanged` nicht mehr aus.
- `ReloadServerData()` wirft keine Ausnahme mehr, wenn ein neuerer Ladevorgang es ersetzt.

Wenn Sie `ReloadServerData()` in ein `try/catch` gepackt haben, um `TaskCanceledException` zu verschlucken, ist dieser Code jetzt toter Code. Das Token sollten Sie trotzdem weiterreichen, denn eine Anfrage, die tatsächlich abbricht, ist günstiger als eine, die MudBlazor stillschweigend verwirft:

```csharp
private async Task<GridData<Order>> LoadOrders(GridState<Order> state, CancellationToken ct)
{
    var page = await Http.GetFromJsonAsync<PagedResult<Order>>(
        $"api/orders?page={state.Page}&size={state.PageSize}", ct);
    return new GridData<Order> { Items = page!.Items, TotalItems = page.Total };
}
```

Die `VirtualizeServerData`-Pfade sind von diesem Fix nicht betroffen, da jede virtualisierte Anfrage bereits ein eigenes Token hat.

## Weitere Hinweise zum Upgrade auf 9.12.0

Enum-Spalten in `MudDataGrid` bieten jetzt einen Filter "is any of" an, dessen `Value` eine Collection ist. Ein `ServerData`-Handler, der nach Operatoren unterscheidet, braucht daher einen neuen Fall oder `Column.FilterOperators`, um ihn auszublenden. Das Lesen von `MudStep.Title`, `MudDatePicker.MinDate` und einigen weiteren Eigenschaften über eine Komponentenreferenz löst jetzt die Analyzer-Diagnose `MUD0012` aus; verwenden Sie stattdessen `GetState(x => x.Title)`. Die vollständige Liste, einschließlich Null-Punkten in Liniendiagrammen und `MudText.Truncate`, steht in den [Release Notes](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0).

```bash
dotnet add package MudBlazor --version 9.12.0
```
