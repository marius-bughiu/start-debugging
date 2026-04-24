---
title: "Pin clustering aterrissa no .NET MAUI 11 Maps"
description: ".NET MAUI 11 Preview 3 adiciona pin clustering embutido ao controle Map no Android e iOS, com grupos ClusteringIdentifier e um evento ClusterClicked."
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "maps"
  - "mobile"
lang: "pt-br"
translationOf: "2026/04/dotnet-maui-11-map-pin-clustering"
translatedBy: "claude"
translationDate: 2026-04-24
---

Se você já jogou umas centenas de pins num `Map` no .NET MAUI, sabe o que acontece no nível de zoom 6: uma mancha de markers sobrepostos que ninguém consegue tapear. O ecossistema de plugins da comunidade tem preenchido essa lacuna por anos, mas enfiar uma biblioteca de maps de terceiros só pra ter clustering sempre pareceu pesado. [.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/pin-clustering-in-dotnet-maui-maps/) conserta isso com uma implementação de clustering de primeira classe assada no `Microsoft.Maui.Controls.Maps`.

## Ligando

Clustering é opt-in através de um único booleano no controle `Map`. Vire `IsClusteringEnabled` e a coleção `Pins` existente é automaticamente agrupada em markers de cluster conforme você afasta o zoom:

```xml
<maps:Map x:Name="StoresMap"
          IsClusteringEnabled="True"
          MapType="Street" />
```

No Android a implementação subjacente usa um algoritmo custom baseado em grid que recomputa buckets de cluster a cada mudança de câmera. No iOS e Mac Catalyst entrega pro `MKClusterAnnotation` do MapKit nativo, então o comportamento de clustering bate com o que os usuários já veem no Apple Maps e Find My. Windows ainda não é suportado, o que bate com a matriz de plataforma do controle `Map` em geral.

## Separando tipos de pin com ClusteringIdentifier

Apps reais raramente querem todos os pins no mesmo balde. Um app de delivery precisa agrupar warehouses separados de drop-off points, e um app de travel quer que hotéis e restaurantes fiquem distintos quando se sobrepõem. A property `ClusteringIdentifier` no `Pin` controla quais pins agrupam juntos: pins compartilhando um identifier ganham um balde, pins com identifier diferente formam um independente.

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

Com isso no lugar, uma view densa de cidade vai renderizar dois markers de cluster no mesmo local em vez de colapsar pins não relacionados num único count.

## Reagindo a taps de cluster

O comportamento padrão de tap é dar zoom no cluster, que geralmente é o que você quer. Se você precisa de algo mais rico, tipo mostrar um sheet de resultados próximos ou carregar dados detalhados, assine `ClusterClicked`. Os event arguments te dão a lista completa de pins, o centro geográfico do cluster, e uma flag `Handled` que suprime o zoom padrão:

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

Setar `e.Handled = true` é o que te deixa manter a câmera onde está e apresentar uma UI custom no lugar.

## Por que esse é o upgrade que você esperava

Antes do Preview 3, as opções pragmáticas eram escrever um algoritmo de clustering na mão em cima de `CameraChanged` ou trocar o controle `Map` por um wrapper específico de plataforma tipo MPowerKit.GoogleMaps. As duas tinham desvantagens: a primeira brigava com o próprio snapping de coordenadas do MapKit, e a segunda passava por cima de `Microsoft.Maui.Controls.Maps` completamente. Ter `IsClusteringEnabled`, `ClusteringIdentifier`, e `ClusterClicked` na caixa significa que dá pra manter seus bindings e data templates existentes, adicionar uma property, e enviar.

A feature é parte do épico mais amplo de [Maps Control Improvements](https://github.com/dotnet/maui/issues/33787) pro .NET 11, então espere mais polimento em torno de styling e interação antes do GA mais tarde esse ano. Por enquanto, instale o [.NET 11 Preview 3 SDK](https://dotnet.microsoft.com/download/dotnet/11.0), atualize seu workload MAUI, e deixe a plataforma cuidar do amontoado.
