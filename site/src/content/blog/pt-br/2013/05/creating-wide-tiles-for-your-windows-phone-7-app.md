---
title: "Criando wide tiles para seu app Windows Phone 7"
description: "Crie wide live tiles para Windows Phone 7 e 8 usando a biblioteca MangoPollo com um único trecho de código."
pubDate: 2013-05-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "pt-br"
translationOf: "2013/05/creating-wide-tiles-for-your-windows-phone-7-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Recentemente me deparei com um artigo na Nokia Developer Wiki sobre criar live tiles (incluindo wide tile) tanto para Windows Phone 7 quanto Windows Phone 8 escrevendo um único trecho de código que funciona nas duas versões do SO.

Para isso, você precisa usar a biblioteca MangoPollo, que dá pra obter facilmente pelo NuGet. A biblioteca usa reflection para criar suas live tiles dependendo da versão do SO em que o app está rodando. Criar as tiles é fácil:

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

É só isso. Tanto a live tile normal quanto a wide já devem estar disponíveis ao redimensionar a tile do seu app. Resta apenas atualizá-la.

Outro ponto que não foi tão óbvio para mim: você pode usar URIs absolutas para as imagens da tile. Ou seja, dá para informar como source uma imagem direto da internet, e o SO baixa e faz cache para você.

```cs
tileData.WideBackgroundImage = new Uri("http://cdn.marketplaceimages.windowsphone.com/v8/images/0a539106-8940-4898-99c2-744cbc7a6097?imageType=ws_icon_small", UriKind.Absolute);
```
