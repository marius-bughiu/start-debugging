---
title: "Pin clustering aterriza en .NET MAUI 11 Maps"
description: ".NET MAUI 11 Preview 3 agrega pin clustering integrado al control Map en Android e iOS, con grupos ClusteringIdentifier y un evento ClusterClicked."
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "maps"
  - "mobile"
lang: "es"
translationOf: "2026/04/dotnet-maui-11-map-pin-clustering"
translatedBy: "claude"
translationDate: 2026-04-24
---

Si alguna vez dejaste caer unos cientos de pins en un `Map` en .NET MAUI, sabes lo que pasa en el nivel de zoom 6: una mancha de markers superpuestos que nadie puede tapear. El ecosistema de plugins de la comunidad ha llenado este hueco por años, pero meter una librería de maps de terceros solo para tener clustering siempre se sintió pesado. [.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/pin-clustering-in-dotnet-maui-maps/) arregla eso con una implementación de clustering de primera clase horneada en `Microsoft.Maui.Controls.Maps`.

## Encenderlo

Clustering es opt-in a través de un único boolean en el control `Map`. Flipea `IsClusteringEnabled` y la colección `Pins` existente se agrupa automáticamente en markers de cluster a medida que alejas el zoom:

```xml
<maps:Map x:Name="StoresMap"
          IsClusteringEnabled="True"
          MapType="Street" />
```

En Android la implementación subyacente usa un algoritmo custom grid-based que recomputa buckets de cluster en cada cambio de cámara. En iOS y Mac Catalyst entrega el trabajo a `MKClusterAnnotation` del MapKit nativo, así que el comportamiento de clustering matchea lo que los usuarios ya ven en Apple Maps y Find My. Windows no está soportado todavía, lo que matchea la matrix de plataforma del control `Map` en general.

## Separar tipos de pin con ClusteringIdentifier

Apps reales rara vez quieren cada pin en el mismo bucket. Una app de delivery necesita agrupar warehouses aparte de drop-off points, y una app de travel quiere que hoteles y restaurantes se mantengan distintos cuando se superponen. La property `ClusteringIdentifier` en `Pin` controla qué pins agrupan juntos: pins compartiendo un identifier obtienen un bucket, pins con un identifier distinto forman uno independiente.

```csharp
foreach (var store in cafes)
{
    StoresMap.Pins.Add(new Pin
    {
        Label = store.Name,
        Location = new Location(store.Lat, store.Lng),
        ClusteringIdentifier = "cafe"
    });
}

foreach (var charger in chargingStations)
{
    StoresMap.Pins.Add(new Pin
    {
        Label = charger.Name,
        Location = new Location(charger.Lat, charger.Lng),
        ClusteringIdentifier = "charger"
    });
}
```

Con eso en su lugar, una vista densa de ciudad renderizará dos markers de cluster en la misma ubicación en lugar de colapsar pins no relacionados en un único count.

## Reaccionar a taps de cluster

El comportamiento default de tap es hacer zoom in en el cluster, que es usualmente lo que quieres. Si necesitas algo más rico, como mostrar un sheet de resultados cercanos o cargar datos detallados, suscríbete a `ClusterClicked`. Los event arguments te dan la lista completa de pins, el centro geográfico del cluster, y una flag `Handled` que suprime el zoom default:

```csharp
StoresMap.ClusterClicked += async (sender, e) =>
{
    var names = string.Join(", ", e.Pins.Select(p => p.Label));
    await Shell.Current.DisplayAlert(
        $"{e.Pins.Count} places nearby",
        names,
        "OK");

    e.Handled = true;
};
```

Setear `e.Handled = true` es lo que te permite mantener la cámara donde está y presentar una UI custom en su lugar.

## Por qué este es el upgrade que esperabas

Antes de Preview 3, las opciones pragmáticas eran escribir un algoritmo de clustering a mano sobre `CameraChanged` o intercambiar el control `Map` por un wrapper platform-specific como MPowerKit.GoogleMaps. Ambos tenían desventajas: el primero peleaba con el snapping de coordenadas propio de MapKit, y el segundo bypassaba `Microsoft.Maui.Controls.Maps` enteramente. Tener `IsClusteringEnabled`, `ClusteringIdentifier`, y `ClusterClicked` en la caja significa que puedes mantener tus bindings y data templates existentes, agregar una property, y enviar.

La feature es parte del épico más amplio de [Maps Control Improvements](https://github.com/dotnet/maui/issues/33787) para .NET 11, así que espera más pulido alrededor de styling e interacción antes del GA más tarde este año. Por ahora, instala el [.NET 11 Preview 3 SDK](https://dotnet.microsoft.com/download/dotnet/11.0), actualiza tu workload MAUI, y deja que la plataforma maneje el pile-up.
