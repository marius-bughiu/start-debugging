---
title: "Windows Phone 7: aktuelle GPS-Position vom Gerät auslesen"
description: "Wie Sie auf einem Windows-Phone-7-Gerät mit GeoCoordinateWatcher und dem PositionChanged-Event die aktuelle GPS-Position auslesen."
pubDate: 2012-01-15
updatedDate: 2023-11-04
tags:
  - "windows-phone"
lang: "de"
translationOf: "2012/01/windows-phone-7-getting-the-current-gps-location-from-the-device"
translatedBy: "claude"
translationDate: 2026-05-01
---
Die aktuelle GPS-Position auf einem Windows-Phone-Gerät auszulesen ist ziemlich einfach. Zunächst müssen Sie in Ihrem Projekt eine Referenz auf **System.Device** hinzufügen und in der Klasse, in der Sie die Geo-Position abrufen möchten, einen using-Eintrag setzen.

```cs
using System.Device.Location;
```

Anschließend deklarieren wir ein Objekt vom Typ **GeoCoordinateWatcher**. Für besseren Zugriff deklariere ich es als Klassenmember und nicht als lokale Variable in einer Methode.

```cs
GeoCoordinateWatcher geoWatcher = null;
```

Als Nächstes: eine Instanz von GeoCoordinateWatcher erzeugen, einen Event-Handler für das PositionChanged-Event erstellen und dann mit dem Auslesen der Daten beginnen. Gehen Sie für das Erzeugen der Instanz in den Konstruktor der Klasse und kopieren Sie folgenden Code:

```cs
geoWatcher = new GeoCoordinateWatcher();
```

Damit wird ein GeoCoordinateWatcher-Objekt in der zuvor deklarierten Variable erstellt. Wenn die Position eine bestimmte Genauigkeit benötigt, bietet die Klasse einen Konstruktor-Overload, der die gewünschte Genauigkeit als Parameter entgegennimmt.

```cs
 geoWatcher = new GeoCoordinateWatcher(GeoPositionAccuracy.High);
```

Erstellen Sie als Nächstes einen Event-Handler für **PositionChanged**. Tippen Sie dazu **geoWatcher.PositionChanged +=** und drücken Sie zweimal die TAB-Taste -- der Event-Handler wird automatisch angelegt. Anschließend müssen Sie nur noch **geoWatcher.Start()** aufrufen, um Koordinaten auszulesen. Ihr Code sollte dann so aussehen:

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

Nun wollen wir die Koordinaten der aktuellen Position abrufen. Das ist sehr einfach. Sie können sie als **GeoCoordinate**-Objekt erhalten, indem Sie im Handler auf **e.Position.Location** zugreifen, oder Sie speichern die Einzelwerte **e.Position.Location.Latitude**, **e.Position.Location.Longitude** und **e.Position.Location.Altitude** in drei double-Variablen. Beispiel unten:

```cs
void geoWatcher_PositionChanged(object sender, GeoPositionChangedEventArgs<GeoCoordinate> e)
{ 
    GeoCoordinate currentLocation = e.Position.Location; 
    double currentAltitude = e.Position.Location.Altitude; 
    double currentLongitude = e.Position.Location.Longitude; 
    double currentLatitude = e.Position.Location.Latitude; 
}
```

Das war's. Wenn Sie das Objekt loswerden und das Auslesen der Position nach den ersten Werten stoppen möchten, fügen Sie einfach die folgenden Zeilen in den Event-Handler ein. Andernfalls können Sie eine Methode dafür anlegen und sie bei Bedarf aufrufen.

```cs
geoWatcher.Stop(); 
geoWatcher.Dispose(); 
geoWatcher = null;
```

Zum Testen des Codes füge ich meiner Anwendung drei Textboxen hinzu, in denen ich die Daten anzeige. Sie können dasselbe tun. Mehr ist es nicht. Wenn Sie Fragen haben, hinterlassen Sie einen Kommentar, ich antworte so bald wie möglich.

Das Projekt können Sie [hier](https://www.dropbox.com/s/rt1k190mor3c2g0/LocationSample.zip?dl=0) herunterladen.
