---
title: "Wide Tiles für Ihre Windows-Phone-7-App erstellen"
description: "Erstellen Sie mit der MangoPollo-Bibliothek wide Live Tiles sowohl für Windows Phone 7 als auch 8 mit einem einzigen Codeausschnitt."
pubDate: 2013-05-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "de"
translationOf: "2013/05/creating-wide-tiles-for-your-windows-phone-7-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Vor Kurzem bin ich auf einen Artikel im Nokia Developer Wiki gestoßen, der zeigt, wie man mit einem einzigen Codeausschnitt Live Tiles (inklusive Wide Tile) sowohl für Windows Phone 7 als auch Windows Phone 8 erstellt.

Dafür brauchen Sie die MangoPollo-Bibliothek, die Sie einfach über NuGet beziehen können. Die Bibliothek verwendet Reflection, um Ihre Live Tiles je nach OS-Version zu erstellen, in der die App läuft. Das Anlegen der Tiles ist einfach:

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

Mehr ist nicht nötig. Sowohl die normale als auch die Wide Live Tile sollten nun verfügbar sein, wenn Sie die Tile Ihrer App vergrößern. Es bleibt nur noch, sie zu aktualisieren.

Außerdem etwas, das für mich nicht so offensichtlich war: Sie können absolute URIs für die Tile-Bilder verwenden. Sie können also als Source ein Bild direkt aus dem Internet angeben, und das OS lädt und cached es für Sie.

```cs
tileData.WideBackgroundImage = new Uri("http://cdn.marketplaceimages.windowsphone.com/v8/images/0a539106-8940-4898-99c2-744cbc7a6097?imageType=ws_icon_small", UriKind.Absolute);
```
