---
title: "Pin Clustering Lands in .NET MAUI 11 Maps"
description: ".NET MAUI 11 Preview 3 adds built-in pin clustering to the Map control on Android and iOS, with ClusteringIdentifier groups and a ClusterClicked event."
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "maps"
  - "mobile"
---

If you have ever dropped a few hundred pins on a `Map` in .NET MAUI, you know what happens at zoom level 6: a blob of overlapping markers that no one can tap. The community plugin ecosystem has filled this gap for years, but shipping a third-party maps library just to get clustering has always felt heavy. [.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/pin-clustering-in-dotnet-maui-maps/) fixes that with a first-party clustering implementation baked into `Microsoft.Maui.Controls.Maps`.

## Turning it on

Clustering is opt-in through a single boolean on the `Map` control. Flip `IsClusteringEnabled` and the existing `Pins` collection is automatically grouped into cluster markers as you zoom out:

```xml
<maps:Map x:Name="StoresMap"
          IsClusteringEnabled="True"
          MapType="Street" />
```

On Android the underlying implementation uses a custom grid-based algorithm that recomputes cluster buckets on every camera change. On iOS and Mac Catalyst it hands off to `MKClusterAnnotation` from native MapKit, so clustering behavior matches what users already see in Apple Maps and Find My. Windows is not supported yet, which matches the `Map` control's platform matrix in general.

## Separating pin types with ClusteringIdentifier

Real apps rarely want every pin in the same bucket. A delivery app needs to cluster warehouses separately from drop-off points, and a travel app wants hotels and restaurants to remain distinct when they overlap. The `ClusteringIdentifier` property on `Pin` controls which pins cluster together: pins sharing an identifier get one bucket, pins with a different identifier form an independent one.

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

With that in place, a dense city view will render two cluster markers at the same location instead of collapsing unrelated pins into a single count.

## Reacting to cluster taps

The default tap behavior is to zoom in on the cluster, which is usually what you want. If you need something richer, like showing a sheet of nearby results or loading detailed data, subscribe to `ClusterClicked`. The event arguments give you the full list of pins, the cluster's geographic center, and a `Handled` flag that suppresses the default zoom:

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

Setting `e.Handled = true` is what lets you keep the camera where it is and present a custom UI instead.

## Why this is the upgrade you were waiting for

Before Preview 3, the pragmatic options were to write a clustering algorithm by hand on top of `CameraChanged` or to swap the `Map` control for a platform-specific wrapper like MPowerKit.GoogleMaps. Both had downsides: the first fought MapKit's own coordinate snapping, and the second bypassed `Microsoft.Maui.Controls.Maps` entirely. Having `IsClusteringEnabled`, `ClusteringIdentifier`, and `ClusterClicked` in the box means you can keep your existing bindings and data templates, add one property, and ship.

The feature is part of the broader [Maps Control Improvements epic](https://github.com/dotnet/maui/issues/33787) for .NET 11, so expect more polish around styling and interaction before GA later this year. For now, install the [.NET 11 Preview 3 SDK](https://dotnet.microsoft.com/download/dotnet/11.0), update your MAUI workload, and let the platform handle the pile-up.
