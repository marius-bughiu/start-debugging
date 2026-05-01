---
title: "Windows Phone 7: obtendo a localização GPS atual do dispositivo"
description: "Como obter a localização GPS atual em um dispositivo Windows Phone 7 usando GeoCoordinateWatcher e o evento PositionChanged."
pubDate: 2012-01-15
updatedDate: 2023-11-04
tags:
  - "windows-phone"
lang: "pt-br"
translationOf: "2012/01/windows-phone-7-getting-the-current-gps-location-from-the-device"
translatedBy: "claude"
translationDate: 2026-05-01
---
Obter a localização GPS atual em um dispositivo Windows Phone é bem simples. Para começar, você precisa adicionar uma referência a **System.Device** no projeto e depois um using na classe em que quiser pegar a geolocalização.

```cs
using System.Device.Location;
```

Em seguida, declaramos um objeto do tipo **GeoCoordinateWatcher**. Para um acesso melhor, vou declará-lo como membro da classe e não como variável local dentro de algum método.

```cs
GeoCoordinateWatcher geoWatcher = null;
```

O próximo passo: criar uma instância de GeoCoordinateWatcher, criar um event handler para position changed e começar a ler os dados. Para criar a instância, vá ao construtor da classe e copie o seguinte código:

```cs
geoWatcher = new GeoCoordinateWatcher();
```

Isso cria um objeto GeoCoordinateWatcher na variável que declaramos antes. Caso a localização precise ter certa precisão, a classe oferece um overload do construtor que recebe a precisão desejada como parâmetro.

```cs
 geoWatcher = new GeoCoordinateWatcher(GeoPositionAccuracy.High);
```

Agora crie um event handler para o evento **PositionChanged**. Você pode digitar **geoWatcher.PositionChanged +=** e pressionar TAB duas vezes; isso vai criar o handler automaticamente. Depois disso, basta usar **geoWatcher.Start()** para começar a ler coordenadas. Seu código deve ficar assim:

```cs
GeoCoordinateWatcher geoWatcher = null; 

public MainPage() 
{ 
    InitializeComponent(); 
    geoWatcher = new GeoCoordinateWatcher(GeoPositionAccuracy.High); 
    geoWatcher.PositionChanged += new EventHandler<GeoPositionChangedEventArgs<GeoCoordinate>>(geoWatcher_PositionChanged);
    geoWatcher.Start(); 
} 

void geoWatcher_PositionChanged(object sender, GeoPositionChangedEventArgs<GeoCoordinate> e) 
{ 
    throw new NotImplementedException(); 
}
```

Em seguida queremos obter as coordenadas da nossa localização. É bem simples. Você pode pegá-las em um objeto **GeoCoordinate** acessando **e.Position.Location** no handler, ou, se preferir como valores individuais, salvar **e.Position.Location.Latitude**, **e.Position.Location.Longitude** e **e.Position.Location.Altitude** em três variáveis double. Exemplo abaixo:

```cs
void geoWatcher_PositionChanged(object sender, GeoPositionChangedEventArgs<GeoCoordinate> e)
{ 
    GeoCoordinate currentLocation = e.Position.Location; 
    double currentAltitude = e.Position.Location.Altitude; 
    double currentLongitude = e.Position.Location.Longitude; 
    double currentLatitude = e.Position.Location.Latitude; 
}
```

É isso. Agora, se você quiser se livrar do objeto e parar de ler a localização atual depois de obter a primeira leitura, é só adicionar as seguintes linhas no event handler. Caso contrário, crie um método para isso e chame quando quiser.

```cs
geoWatcher.Stop(); 
geoWatcher.Dispose(); 
geoWatcher = null;
```

Para testar o código que escrevi, vou adicionar três textboxes na aplicação para exibir os dados. Você pode fazer o mesmo. Enfim, é isso. Se tiver dúvidas, deixe um comentário que respondo o quanto antes.

Você pode pegar o projeto [aqui](https://www.dropbox.com/s/rt1k190mor3c2g0/LocationSample.zip?dl=0).
