---
title: "MudBlazor 9.12: las búsquedas lentas de ServerData y Autocomplete ya no sobrescriben resultados más recientes"
description: "MudBlazor 9.12.0 corrige una condición de carrera de larga data en MudAutocomplete, MudDataGrid y MudTable: ganaba el resultado de la búsqueda que terminaba al final, no el de la que se iniciaba al final. Así funciona la corrección y qué cambia para tu código de ServerData y SearchFunc."
pubDate: 2026-10-29
tags:
  - "blazor"
  - "mudblazor"
  - "aspnet-core"
  - "dotnet"
  - "async"
lang: "es"
translationOf: "2026/10/mudblazor-9-12-ignores-stale-serverdata-and-autocomplete-results"
translatedBy: "claude"
translationDate: 2026-10-29
---

[MudBlazor 9.12.0](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0) se publicó el 29 de octubre de 2026, y el cambio que justifica la actualización es una condición de carrera abierta, de una forma u otra, desde el [issue #3722](https://github.com/MudBlazor/MudBlazor/issues/3722). `MudAutocomplete`, `MudDataGrid` con `ServerData` y `MudTable` con `ServerData` conservaban el resultado de la solicitud que *terminaba* al final, no el de la que el usuario *iniciaba* al final.

## Por qué suele ganar la búsqueda más amplia

Escribe "App" en un autocompletado, espera a que pase el debounce y sigue escribiendo "le Pie". Ahora hay dos búsquedas en curso. La consulta corta coincide con más filas, así que normalmente es la lenta. En 9.11 y versiones anteriores, primero se muestran los resultados de "Apple Pie", luego llegan los de "App" y los reemplazan. El usuario ve una lista que ya no coincide con el texto del cuadro.

Lo mismo ocurría con los filtros y la paginación de la cuadrícula: si cambias un filtro dos veces rápidamente, la llamada anterior y más lenta a `ServerData` podía sobrescribir la página más reciente.

## Cómo decide 9.12 qué resultado está obsoleto

El [PR #13944](https://github.com/MudBlazor/MudBlazor/pull/13944) usa dos estrategias distintas. En `MudAutocomplete`, cada búsqueda recibe un número de versión, y una búsqueda que fue reemplazada por otra más nueva termina antes de tocar los elementos, el conteo de elementos devueltos o el popover:

```csharp
var searchVersion = ++_searchVersion;
// ... await SearchFunc(text, token) ...
if (searchVersion != _searchVersion)
{
    return;
}
```

La comprobación se ejecuta dos veces, la segunda después de `ReturnedItemsCountChanged`, porque tu controlador puede ceder el control y dejar que una búsqueda más nueva termine entre medias. Esto importa porque muchas implementaciones de `SearchFunc` ignoran por completo el `CancellationToken`, así que la cancelación por sí sola nunca habría podido resolver esto.

`MudDataGrid` se apoya en el token que ya pasa a `ServerData`. Si una carga más nueva lo canceló, la carga anterior retorna sin asignar datos ni limpiar `Loading`, incluso si lanzó una excepción:

```csharp
catch (Exception) when (token.IsCancellationRequested)
{
    // A newer load cancelled this one, and it owns the data and the loading state.
    return;
}
```

El tipo de excepción se ignora deliberadamente porque las fuentes de datos suelen informar una solicitud cancelada como un fallo propio (una `HttpRequestException`, una `DbException` específica del proveedor, etc.). El [PR #14053](https://github.com/MudBlazor/MudBlazor/pull/14053) aplica la misma regla a `MudTable`, y los seguimientos mantienen activo el indicador de carga durante un reinicio de página e impiden que una búsqueda tardía vuelva a abrir un menú de autocompletado que ya estaba cerrado, con una selección hecha o limpiado.

## Qué cambia para tu código

El PR señala dos cambios de comportamiento:

- Una búsqueda de autocompletado reemplazada ya no dispara `ReturnedItemsCountChanged`.
- `ReloadServerData()` ya no lanza una excepción cuando una carga más nueva lo reemplaza.

Si envolviste `ReloadServerData()` en un `try/catch` para tragarte la `TaskCanceledException`, ese código ahora es código muerto. Aun así, deberías seguir pasando el token, ya que una solicitud cancelada que realmente se detiene es más barata que una que MudBlazor descarta en silencio:

```csharp
private async Task<GridData<Order>> LoadOrders(GridState<Order> state, CancellationToken ct)
{
    var page = await Http.GetFromJsonAsync<PagedResult<Order>>(
        $"api/orders?page={state.Page}&size={state.PageSize}", ct);
    return new GridData<Order> { Items = page!.Items, TotalItems = page.Total };
}
```

Las rutas de `VirtualizeServerData` no están cubiertas por esta corrección, ya que cada solicitud virtualizada ya tiene su propio token.

## Otras notas de actualización en 9.12.0

Las columnas de enumeraciones en `MudDataGrid` ahora ofrecen un filtro "is any of" cuyo `Value` es una colección, así que un controlador de `ServerData` que haga un switch sobre los operadores necesita un nuevo caso, o `Column.FilterOperators` para ocultarlo. Leer `MudStep.Title`, `MudDatePicker.MinDate` y algunas otras propiedades a través de una referencia de componente ahora genera el diagnóstico del analizador `MUD0012`; usa `GetState(x => x.Title)` en su lugar. La lista completa, que incluye los puntos nulos en los gráficos de líneas y `MudText.Truncate`, está en las [notas de la versión](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0).

```bash
dotnet add package MudBlazor --version 9.12.0
```
