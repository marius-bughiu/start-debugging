---
title: "Windows Phone 7: obtener la ubicación GPS actual desde el dispositivo"
description: "Cómo obtener la ubicación GPS actual en un dispositivo Windows Phone 7 usando GeoCoordinateWatcher y el evento PositionChanged."
pubDate: 2012-01-15
updatedDate: 2023-11-04
tags:
  - "windows-phone"
lang: "es"
translationOf: "2012/01/windows-phone-7-getting-the-current-gps-location-from-the-device"
translatedBy: "claude"
translationDate: 2026-05-01
---
Obtener la ubicación GPS actual en un dispositivo Windows Phone es bastante sencillo. Para empezar tendrás que añadir una referencia a **System.Device** en tu proyecto y luego un using dentro de la clase en la que quieras obtener la geolocalización.

```cs
using System.Device.Location;
```

Ahora necesitamos declarar un objeto de tipo **GeoCoordinateWatcher**. Para tener mejor acceso lo declararé como miembro de la clase y no como variable local dentro de algún método.

```cs
GeoCoordinateWatcher geoWatcher = null;
```

Lo siguiente es: crear una instancia de GeoCoordinateWatcher, crear un manejador de evento para position changed y luego empezar a leer los datos. Para crear la instancia de GeoCoordinateWatcher, ve al constructor de la clase y copia el siguiente código:

```cs
geoWatcher = new GeoCoordinateWatcher();
```

Esto creará un objeto GeoCoordinateWatcher en la variable que declaramos antes. En caso de que la ubicación necesite cierta precisión, la clase ofrece una sobrecarga del constructor que toma la precisión deseada como parámetro.

```cs
 geoWatcher = new GeoCoordinateWatcher(GeoPositionAccuracy.High);
```

A continuación, crea un manejador de evento para **PositionChanged**. Puedes hacerlo escribiendo **geoWatcher.PositionChanged +=** y pulsando la tecla TAB dos veces; eso te creará el manejador de evento automáticamente. Después de crear el manejador, solo necesitas usar **geoWatcher.Start()** para empezar a leer coordenadas. Ahora tu código debería verse así:

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

Ahora queremos obtener las coordenadas para nuestra ubicación. Es realmente sencillo. Las puedes obtener en un objeto **GeoCoordinate** accediendo a **e.Position.Location** en el manejador, o si prefieres obtenerlas como valores individuales puedes guardar **e.Position.Location.Latitude**, **e.Position.Location.Longitude** y **e.Position.Location.Altitude** en tres variables double. Ejemplo abajo:

```cs
void geoWatcher_PositionChanged(object sender, GeoPositionChangedEventArgs<GeoCoordinate> e)
{ 
    GeoCoordinate currentLocation = e.Position.Location; 
    double currentAltitude = e.Position.Location.Altitude; 
    double currentLongitude = e.Position.Location.Longitude; 
    double currentLatitude = e.Position.Location.Latitude; 
}
```

Eso es todo. Ahora, si quieres deshacerte del objeto y dejar de leer la ubicación actual tras la primera lectura, puedes añadir las siguientes líneas al manejador del evento. Si no, créate un método para ello y llámalo cuando quieras.

```cs
geoWatcher.Stop(); 
geoWatcher.Dispose(); 
geoWatcher = null;
```

Para probar el código que acabo de escribir, añadiré tres textboxes a mi aplicación donde mostraré los datos. Puedes hacer lo mismo. En cualquier caso, eso es todo. Si tienes preguntas, deja un comentario y las responderé lo antes posible.

Puedes descargar el proyecto desde [aquí](https://www.dropbox.com/s/rt1k190mor3c2g0/LocationSample.zip?dl=0).
