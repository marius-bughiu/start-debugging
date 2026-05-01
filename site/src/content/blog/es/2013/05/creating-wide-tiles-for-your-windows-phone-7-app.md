---
title: "Crear wide tiles para tu app de Windows Phone 7"
description: "Crea wide live tiles tanto para Windows Phone 7 como para 8 usando la librería MangoPollo con una única pieza de código."
pubDate: 2013-05-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "es"
translationOf: "2013/05/creating-wide-tiles-for-your-windows-phone-7-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hace poco di con un artículo en la Nokia Developer Wiki sobre cómo crear live tiles (incluida la wide tile) para Windows Phone 7 y Windows Phone 8 escribiendo una única pieza de código que funciona en ambas versiones del SO.

Para hacerlo necesitarás la librería MangoPollo, que puedes obtener fácilmente desde NuGet. La librería usa reflection para crear tus live tiles dependiendo de la versión del SO en la que se ejecute la app. Crear las tiles es fácil:

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

Eso es todo lo que necesitas hacer. Ahora deberían estar disponibles tanto la live tile normal como la wide al redimensionar la tile de tu app. Lo único que te queda por hacer es actualizarla.

Además, algo que no me resultó tan obvio: puedes usar URIs absolutas para las imágenes de la tile. Es decir, puedes dar como source una imagen directamente desde internet y el SO la descargará y la cacheará por ti.

```cs
tileData.WideBackgroundImage = new Uri("http://cdn.marketplaceimages.windowsphone.com/v8/images/0a539106-8940-4898-99c2-744cbc7a6097?imageType=ws_icon_small", UriKind.Absolute);
```
