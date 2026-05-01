---
title: "Alterando a versão do Cordova usada pelos Hybrid Apps no Visual Studio 2013"
description: "Como atualizar a versão do Cordova usada pelos Hybrid Apps no Visual Studio 2013 editando o arquivo platforms.js."
pubDate: 2014-11-08
updatedDate: 2023-11-05
tags:
  - "android"
  - "visual-studio"
lang: "pt-br"
translationOf: "2014/11/changing-cordova-version-used-hybrid-apps-visual-studio-2013"
translatedBy: "claude"
translationDate: 2026-05-01
---
Atualizar a versão do Cordova exige editar o arquivo **platforms.js** localizado em:

`%APPDATA%\Roaming\npm\node_modules\vs-mda\node_modules\cordova\node_modules\cord‌​ova-lib\src\cordova`

Você pode alterar a versão individualmente por plataforma, embora eu sugira usar a mesma versão para todas.
Também pode ser que você queira atualizar apenas por causa do aviso do Google Play sobre a vulnerabilidade de high severity cross-application scripting (XAS) no Cordova 3.5.0. Se for o caso, aqui está o arquivo atualizado apontando para a versão 3.5.1, que corrige a vulnerabilidade citada: [platforms.js](https://www.dropbox.com/s/c475yechp5crd2p/platforms.js?dl=0 "Download platforms.js") (observação: esse link do Dropbox pode não estar mais disponível).

Observação: caso você esteja usando o CTP 1 dos Hybrid Apps, o caminho é diferente:
`%APPDATA%\npm\node_modules\vs-mda\node_modules\cordova\`
