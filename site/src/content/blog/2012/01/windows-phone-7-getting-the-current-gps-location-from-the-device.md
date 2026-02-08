---
title: "Windows Phone 7: Getting the current GPS location from the device"
description: "Getting the current GPS location on a Windows Phone device is rather easy. In order to start you will need to add a reference to System.Device in your project and then a using statement inside the class that you want to get the geo-location. Next we would need to declare an object of type GeoCoordinateWatcher…."
pubDate: 2012-01-15
updatedDate: 2023-11-04
tags:
  - "windows-phone"
---
Getting the current GPS location on a Windows Phone device is rather easy. In order to start you will need to add a reference to **System.Device** in your project and then a using statement inside the class that you want to get the geo-location.

```cs
using System.Device.Location;
```

Next we would need to declare an object of type **GeoCoordinateWatcher**. For better access I will declare it as a class member and not as a local variable inside some method.

```cs
GeoCoordinateWatcher geoWatcher = null;
```

Next to do is: create an instance of GeoCoordinateWatcher, create an event handler for the position changed event and then start reading the data. So, to create an instance of GeoCoordinateWatcher go to the class constructor and copy the following code:

```cs
geoWatcher = new GeoCoordinateWatcher();
```

This will create a GeoCoordinateWatcher object in the variable we previously declared. In case the location you need has to have a certain accuracy, the class provides you with an overload for the contructor which takes your desired accuracy as a parameter.

```cs
 geoWatcher = new GeoCoordinateWatcher(GeoPositionAccuracy.High);
```

Next create an event handler for the **PositionChanged** event. You can do this by typing **geoWatcher.PositionChanged +=** and then press the TAB key twice; this will automatically create the event handler for you. After creating the event handler, all you need to do is use **geoWatcher.Start()** to start reading coordinates. Now your code should look like this:

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

Next we want to get the coordinates for our location. That is really simple. You can get them in a **GeoCoordinate** object by accesing **e.Position.Location** in the event handler, or if you want to get them as individual values you can save **e.Position.Location.Latitude**, **e.Position.Location.Longitude** and **e.Position.Location.Altitude** in three double variables. Example below:

```cs
void geoWatcher_PositionChanged(object sender, GeoPositionChangedEventArgs<GeoCoordinate> e)
{ 
    GeoCoordinate currentLocation = e.Position.Location; 
    double currentAltitude = e.Position.Location.Altitude; 
    double currentLongitude = e.Position.Location.Longitude; 
    double currnetLatitude = e.Position.Location.Latitude; 
}
```

That’s it. Now if you want to get rid of the object and stop reading the current location after reading the first set of values you can simply add the following lines of code to the event handler. Otherwise you can create a method for it and call it whenever you wish.

```cs
geoWatcher.Stop(); 
geoWatcher.Dispose(); 
geoWatcher = null;
```

In order to test the code I just wrote I will add three textboxes to my application in which I will write the data I read in them. You can do the same. Anyways that’s it. If you got any questions leave a comment and I’ll answer them asap.

You can get the project from [here](https://www.dropbox.com/s/rt1k190mor3c2g0/LocationSample.zip?dl=0).
