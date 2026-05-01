---
title: "Die von Hybrid Apps in Visual Studio 2013 verwendete Cordova-Version ändern"
description: "Wie Sie die in Visual Studio 2013 von Hybrid Apps verwendete Cordova-Version aktualisieren, indem Sie die Datei platforms.js bearbeiten."
pubDate: 2014-11-08
updatedDate: 2023-11-05
tags:
  - "android"
  - "visual-studio"
lang: "de"
translationOf: "2014/11/changing-cordova-version-used-hybrid-apps-visual-studio-2013"
translatedBy: "claude"
translationDate: 2026-05-01
---
Um die Cordova-Version zu aktualisieren, müssen Sie die Datei **platforms.js** unter folgendem Pfad bearbeiten:

`%APPDATA%\Roaming\npm\node_modules\vs-mda\node_modules\cordova\node_modules\cord‌​ova-lib\src\cordova`

Sie können die Version pro Plattform individuell ändern, ich empfehle aber, für alle dieselbe Version zu verwenden.
Möglicherweise wollen Sie auch nur wegen der Google-Play-Warnung zu der Cross-Application-Scripting (XAS)-Schwachstelle hoher Schwere in Cordova 3.5.0 aktualisieren. In diesem Fall finden Sie hier die aktualisierte Datei, die auf Version 3.5.1 verweist, welche die genannte Schwachstelle behebt: [platforms.js](https://www.dropbox.com/s/c475yechp5crd2p/platforms.js?dl=0 "Download platforms.js") (Hinweis: dieser Dropbox-Link ist möglicherweise nicht mehr verfügbar).

Hinweis: Falls Sie CTP 1 der Hybrid Apps verwenden, lautet der Pfad anders:
`%APPDATA%\npm\node_modules\vs-mda\node_modules\cordova\`
