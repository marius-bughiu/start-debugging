---
title: "Windows Phone 7 アプリに wide tiles を作る"
description: "MangoPollo ライブラリと 1 つのコード片で、Windows Phone 7 と 8 の両方の wide live tiles を作成する方法を解説します。"
pubDate: 2013-05-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "ja"
translationOf: "2013/05/creating-wide-tiles-for-your-windows-phone-7-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
最近 Nokia Developer Wiki で、1 つのコード片で Windows Phone 7 と Windows Phone 8 の両方で動く live tiles (wide tile を含む) を作る方法に関する記事を見つけました。

そのためには MangoPollo ライブラリが必要で、NuGet から簡単に入手できます。このライブラリはアプリが動作している OS バージョンに応じて、reflection を用いて live tiles を作成します。tiles の作成は簡単です。

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

これだけで完了です。アプリの tile をリサイズすると、通常の live tile と wide のものが両方利用できるようになります。あとはそれを更新するだけです。

また、私にとってあまり自明ではなかった点として、tile 画像には絶対 URI を使えるということがあります。つまり source としてインターネット上の画像を直接指定できて、OS がダウンロードしてキャッシュしてくれます。

```cs
tileData.WideBackgroundImage = new Uri("http://cdn.marketplaceimages.windowsphone.com/v8/images/0a539106-8940-4898-99c2-744cbc7a6097?imageType=ws_icon_small", UriKind.Absolute);
```
