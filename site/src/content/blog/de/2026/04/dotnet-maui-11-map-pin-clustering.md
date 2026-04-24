---
title: "Pin-Clustering landet in .NET MAUI 11 Maps"
description: ".NET MAUI 11 Preview 3 fügt dem Map-Control eingebautes Pin-Clustering auf Android und iOS hinzu, mit ClusteringIdentifier-Gruppen und einem ClusterClicked-Event."
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "maps"
  - "mobile"
lang: "de"
translationOf: "2026/04/dotnet-maui-11-map-pin-clustering"
translatedBy: "claude"
translationDate: 2026-04-24
---

Wer jemals ein paar Hundert Pins auf eine `Map` in .NET MAUI abgeworfen hat, weiß, was bei Zoom-Level 6 passiert: ein Klumpen überlappender Marker, auf die niemand tippen kann. Das Community-Plugin-Ökosystem füllt diese Lücke seit Jahren, aber eine Third-Party-Maps-Library nur für Clustering auszuliefern, hat sich immer schwer angefühlt. [.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/pin-clustering-in-dotnet-maui-maps/) behebt das mit einer First-Party-Clustering-Implementierung, die in `Microsoft.Maui.Controls.Maps` eingebacken ist.

## Anschalten

Clustering ist Opt-in über einen einzigen Boolean auf dem `Map`-Control. Kippen Sie `IsClusteringEnabled`, und die vorhandene `Pins`-Collection wird automatisch in Cluster-Marker gruppiert, während Sie hinauszoomen:

```xml
<maps:Map x:Name="StoresMap"
          IsClusteringEnabled="True"
          MapType="Street" />
```

Auf Android nutzt die zugrunde liegende Implementierung einen Custom-Grid-basierten Algorithmus, der Cluster-Buckets bei jeder Kameraänderung neu berechnet. Auf iOS und Mac Catalyst übergibt es an `MKClusterAnnotation` von nativem MapKit, sodass das Clustering-Verhalten zu dem passt, was Nutzer schon in Apple Maps und Find My sehen. Windows wird noch nicht unterstützt, was der Plattform-Matrix des `Map`-Controls generell entspricht.

## Pin-Typen mit ClusteringIdentifier trennen

Echte Apps wollen selten jeden Pin im selben Bucket. Eine Delivery-App muss Warehouses getrennt von Drop-off-Points clustern, und eine Travel-App will, dass Hotels und Restaurants unterschiedlich bleiben, wenn sie sich überlappen. Die `ClusteringIdentifier`-Property auf `Pin` steuert, welche Pins zusammen clustern: Pins, die einen Identifier teilen, bekommen einen Bucket, Pins mit einem anderen Identifier bilden einen unabhängigen.

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

Damit rendert eine dichte Stadtansicht zwei Cluster-Marker am selben Ort, statt unverwandte Pins in einen einzigen Count zu kollabieren.

## Auf Cluster-Taps reagieren

Das Standard-Tap-Verhalten ist, in den Cluster hineinzuzoomen, was üblicherweise das ist, was Sie wollen. Wenn Sie etwas Reichhaltigeres brauchen, etwa ein Sheet mit Ergebnissen in der Nähe oder das Laden detaillierter Daten, abonnieren Sie `ClusterClicked`. Die Event-Argumente geben Ihnen die volle Liste der Pins, das geografische Zentrum des Clusters und ein `Handled`-Flag, das den Standard-Zoom unterdrückt:

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

`e.Handled = true` zu setzen, ist das, was Sie die Kamera, wo sie ist, halten lässt und stattdessen eine Custom-UI präsentiert.

## Warum das das Upgrade ist, auf das Sie gewartet haben

Vor Preview 3 waren die pragmatischen Optionen, einen Clustering-Algorithmus von Hand auf `CameraChanged` zu schreiben oder das `Map`-Control gegen einen plattformspezifischen Wrapper wie MPowerKit.GoogleMaps zu tauschen. Beides hatte Nachteile: Der erste kämpfte mit dem eigenen Koordinaten-Snapping von MapKit, der zweite umging `Microsoft.Maui.Controls.Maps` komplett. `IsClusteringEnabled`, `ClusteringIdentifier` und `ClusterClicked` in der Box zu haben, heißt, Sie können Ihre bestehenden Bindings und Data Templates behalten, eine Property hinzufügen und ausliefern.

Das Feature ist Teil des umfassenderen [Maps Control Improvements Epics](https://github.com/dotnet/maui/issues/33787) für .NET 11, also erwarten Sie mehr Politur rund um Styling und Interaktion vor dem GA später dieses Jahr. Für jetzt: Installieren Sie das [.NET 11 Preview 3 SDK](https://dotnet.microsoft.com/download/dotnet/11.0), aktualisieren Sie Ihren MAUI-Workload und lassen Sie die Plattform den Pile-up handhaben.
