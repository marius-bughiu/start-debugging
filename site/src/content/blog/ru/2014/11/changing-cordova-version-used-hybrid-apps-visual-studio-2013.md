---
title: "Смена версии Cordova, используемой Hybrid Apps в Visual Studio 2013"
description: "Как обновить версию Cordova, используемую Hybrid Apps в Visual Studio 2013, отредактировав файл platforms.js."
pubDate: 2014-11-08
updatedDate: 2023-11-05
tags:
  - "android"
  - "visual-studio"
lang: "ru"
translationOf: "2014/11/changing-cordova-version-used-hybrid-apps-visual-studio-2013"
translatedBy: "claude"
translationDate: 2026-05-01
---
Чтобы обновить версию Cordova, нужно отредактировать файл **platforms.js**, находящийся по пути:

`%APPDATA%\Roaming\npm\node_modules\vs-mda\node_modules\cordova\node_modules\cord‌​ova-lib\src\cordova`

Версию можно менять отдельно для каждой платформы, хотя я советую использовать одну и ту же версию для всех.
Возможно, вы хотите обновиться только из-за предупреждения Google Play о уязвимости high severity cross-application scripting (XAS) в Cordova 3.5.0. Если так, вот файл, обновлённый до версии 3.5.1, в которой указанная уязвимость исправлена: [platforms.js](https://www.dropbox.com/s/c475yechp5crd2p/platforms.js?dl=0 "Download platforms.js") (примечание: эта ссылка на Dropbox может быть уже недоступна).

Примечание: если вы используете CTP 1 Hybrid Apps, путь будет иным:
`%APPDATA%\npm\node_modules\vs-mda\node_modules\cordova\`
