---
title: "Создаём wide tiles для приложения Windows Phone 7"
description: "Создавайте wide live tiles одновременно для Windows Phone 7 и 8 с помощью библиотеки MangoPollo и одного фрагмента кода."
pubDate: 2013-05-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "ru"
translationOf: "2013/05/creating-wide-tiles-for-your-windows-phone-7-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Недавно мне попалась статья в Nokia Developer Wiki про создание live tiles (в том числе wide tile) сразу для Windows Phone 7 и Windows Phone 8 с помощью одного фрагмента кода, работающего на обеих версиях ОС.

Для этого вам понадобится библиотека MangoPollo, которую легко поставить через NuGet. Библиотека использует reflection, чтобы создавать live tiles в зависимости от версии ОС, на которой запущено приложение. Создать tiles просто:

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

Это всё, что нужно. И обычная, и wide live tile теперь должны быть доступны при изменении размера tile вашего приложения. Осталось только обновлять её.

Ещё одна вещь, не самая очевидная для меня: для изображений tile можно использовать абсолютные URI. То есть в качестве source можно дать изображение прямо из интернета, и ОС скачает и закэширует его сама.

```cs
tileData.WideBackgroundImage = new Uri("http://cdn.marketplaceimages.windowsphone.com/v8/images/0a539106-8940-4898-99c2-744cbc7a6097?imageType=ws_icon_small", UriKind.Absolute);
```
