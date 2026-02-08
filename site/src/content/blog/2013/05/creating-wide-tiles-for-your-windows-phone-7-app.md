---
title: "Creating wide tiles for your Windows Phone 7 app"
description: "I’ve recently come across an article in the Nokia Developer Wiki about creating live tiles (including wide tile) for both Windows Phone 7 and Windows Phone 8 by writing a single piece of code that works in both versions of the OS. To do this you will need to use the MangoPollo library which you…"
pubDate: 2013-05-05
updatedDate: 2023-11-05
tags:
  - "c-sharp"
  - "windows-phone"
---
I’ve recently come across an article in the Nokia Developer Wiki about creating live tiles (including wide tile) for both Windows Phone 7 and Windows Phone 8 by writing a single piece of code that works in both versions of the OS.

To do this you will need to use the MangoPollo library which you can easily get from NuGet. The library uses reflection to create your live tiles depending on the OS version the app is running in. Creating your tiles is easy:

```cs
var tile = ShellTile.ActiveTiles.FirstOrDefault(); 
if (tile != null) 
{ 
    var tileData = new FlipTileData(); 
    tileData.Title = "Start Debugging"; 
    tileData.BackContent = "switch to windows phone, we've got candy"; 
    tileData.BackgroundImage = new Uri("Assets/tileBackground.png", UriKind.Relative); 
    tileData.BackBackgroundImage = new Uri("Assets/tileBackBackground.png", UriKind.Relative); 
    tileData.WideBackContent = "switch to windows phone, we've got candy"; 
    tileData.WideBackgroundImage = new Uri("Assets/wideTileBackground.png", UriKind.Relative); 
    tileData.WideBackBackgroundImage = new Uri("Assets/wideTileBackBackground.png", UriKind.Relative);
    tile.Update(tileData); 
}
```

That’s all you need to do. Both the normal and wide live tiles should now be available when resizing the tile of your app. Now all that’s left for you to do is to update it.

Also, one thing that wasn’t so obvious for me – you can use absolute URIs for the tile images. eaning that you can give as a source a image directly from the internet and the OS will download and cache it for you.

```cs
tileData.WideBackgroundImage = new Uri("http://cdn.marketplaceimages.windowsphone.com/v8/images/0a539106-8940-4898-99c2-744cbc7a6097?imageType=ws_icon_small", UriKind.Absolute);
```
