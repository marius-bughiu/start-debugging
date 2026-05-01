---
title: "Windows Phone 7: получение текущей GPS-позиции с устройства"
description: "Как получить текущую GPS-позицию на устройстве Windows Phone 7 с помощью GeoCoordinateWatcher и события PositionChanged."
pubDate: 2012-01-15
updatedDate: 2023-11-04
tags:
  - "windows-phone"
lang: "ru"
translationOf: "2012/01/windows-phone-7-getting-the-current-gps-location-from-the-device"
translatedBy: "claude"
translationDate: 2026-05-01
---
Получить текущую GPS-позицию на устройстве Windows Phone довольно просто. Для начала нужно добавить в проект ссылку на **System.Device** и затем using-выражение в классе, в котором вы хотите получить геолокацию.

```cs
using System.Device.Location;
```

Далее нужно объявить объект типа **GeoCoordinateWatcher**. Для удобства доступа объявим его как член класса, а не как локальную переменную внутри какого-нибудь метода.

```cs
GeoCoordinateWatcher geoWatcher = null;
```

Дальше: создаём экземпляр GeoCoordinateWatcher, заводим обработчик события position changed и затем начинаем читать данные. Для создания экземпляра перейдите в конструктор класса и скопируйте код:

```cs
geoWatcher = new GeoCoordinateWatcher();
```

Это создаст объект GeoCoordinateWatcher в ранее объявленной переменной. Если требуется определённая точность, у класса есть перегрузка конструктора, принимающая нужную точность параметром.

```cs
 geoWatcher = new GeoCoordinateWatcher(GeoPositionAccuracy.High);
```

Затем создайте обработчик для события **PositionChanged**. Можно набрать **geoWatcher.PositionChanged +=** и дважды нажать TAB - обработчик создастся автоматически. После этого достаточно вызвать **geoWatcher.Start()**, чтобы начать чтение координат. Код должен выглядеть так:

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

Теперь хотим получить координаты нашего местоположения. Это очень просто. Их можно получить как объект **GeoCoordinate**, обращаясь к **e.Position.Location** в обработчике, либо как отдельные значения, сохранив **e.Position.Location.Latitude**, **e.Position.Location.Longitude** и **e.Position.Location.Altitude** в три переменные типа double. Пример ниже:

```cs
void geoWatcher_PositionChanged(object sender, GeoPositionChangedEventArgs<GeoCoordinate> e)
{ 
    GeoCoordinate currentLocation = e.Position.Location; 
    double currentAltitude = e.Position.Location.Altitude; 
    double currentLongitude = e.Position.Location.Longitude; 
    double currentLatitude = e.Position.Location.Latitude; 
}
```

Вот и всё. Если хотите избавиться от объекта и прекратить чтение текущей позиции после первого набора значений, просто добавьте следующие строки в обработчик. Иначе оформите это методом и вызывайте, когда захотите.

```cs
geoWatcher.Stop(); 
geoWatcher.Dispose(); 
geoWatcher = null;
```

Чтобы протестировать только что написанный код, я добавлю в приложение три textbox'а, в которых буду отображать данные. Вы можете сделать то же. Вот, собственно, и всё. Если есть вопросы - оставляйте комментарий, отвечу как можно скорее.

Скачать проект можно [здесь](https://www.dropbox.com/s/rt1k190mor3c2g0/LocationSample.zip?dl=0).
