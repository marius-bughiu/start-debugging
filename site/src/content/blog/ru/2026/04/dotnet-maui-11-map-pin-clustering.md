---
title: "Pin clustering приземляется в .NET MAUI 11 Maps"
description: ".NET MAUI 11 Preview 3 добавляет встроенный pin clustering в контрол Map на Android и iOS, с группами ClusteringIdentifier и событием ClusterClicked."
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "maps"
  - "mobile"
lang: "ru"
translationOf: "2026/04/dotnet-maui-11-map-pin-clustering"
translatedBy: "claude"
translationDate: 2026-04-24
---

Если вы когда-нибудь высыпали несколько сотен pin на `Map` в .NET MAUI, знаете, что происходит на уровне зума 6: клякса перекрывающихся маркеров, в которые никто не может попасть тапом. Экосистема community-плагинов закрывала эту дыру годами, но притащить стороннюю maps-библиотеку только ради clustering всегда ощущалось тяжеловесно. [.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/pin-clustering-in-dotnet-maui-maps/) чинит это first-party реализацией clustering, запечённой в `Microsoft.Maui.Controls.Maps`.

## Включение

Clustering - opt-in через один boolean на контроле `Map`. Переключите `IsClusteringEnabled`, и существующая коллекция `Pins` автоматически группируется в cluster-маркеры по мере отдаления:

```xml
<maps:Map x:Name="StoresMap"
          IsClusteringEnabled="True"
          MapType="Street" />
```

На Android лежащая в основе реализация использует кастомный grid-based алгоритм, пересчитывающий cluster-корзины на каждом изменении камеры. На iOS и Mac Catalyst он отдаёт работу нативному `MKClusterAnnotation` из MapKit, так что поведение clustering совпадает с тем, что пользователи уже видят в Apple Maps и Find My. Windows пока не поддерживается, что совпадает с матрицей платформ контрола `Map` в целом.

## Разделение типов pin с ClusteringIdentifier

Реальные приложения редко хотят все pins в одной корзине. Приложению доставки нужно группировать склады отдельно от точек выдачи, а travel-приложение хочет, чтобы отели и рестораны оставались разными, когда они перекрываются. Property `ClusteringIdentifier` на `Pin` контролирует, какие pins группируются вместе: pins, делящие identifier, получают одну корзину, pins с другим identifier формируют независимую.

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

С этим на месте, плотный city-view будет рендерить два cluster-маркера в одном и том же месте вместо схлопывания несвязанных pins в один count.

## Реакция на тап по cluster

Стандартное поведение тапа - сделать zoom in на cluster, что обычно именно то, что вы хотите. Если нужно что-то побогаче, вроде показа sheet с ближайшими результатами или загрузки детальных данных, подпишитесь на `ClusterClicked`. Event arguments дают вам полный список pins, географический центр cluster и флаг `Handled`, подавляющий стандартный zoom:

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

Установка `e.Handled = true` - то, что позволяет оставить камеру на месте и представить кастомный UI вместо этого.

## Почему это апгрейд, которого вы ждали

До Preview 3 прагматичными вариантами были написать алгоритм clustering вручную поверх `CameraChanged` или заменить контрол `Map` на platform-specific wrapper вроде MPowerKit.GoogleMaps. У обоих были минусы: первый боролся с собственным coordinate snapping MapKit, а второй полностью обходил `Microsoft.Maui.Controls.Maps`. Иметь `IsClusteringEnabled`, `ClusteringIdentifier` и `ClusterClicked` в коробке значит, что можно сохранить существующие bindings и data templates, добавить одну property и катить.

Фича - часть более широкого epic [Maps Control Improvements](https://github.com/dotnet/maui/issues/33787) для .NET 11, так что ожидайте больше полировки вокруг styling и interaction до GA позже в этом году. Пока установите [.NET 11 Preview 3 SDK](https://dotnet.microsoft.com/download/dotnet/11.0), обновите свой MAUI workload и пусть платформа разбирается с нагромождением.
