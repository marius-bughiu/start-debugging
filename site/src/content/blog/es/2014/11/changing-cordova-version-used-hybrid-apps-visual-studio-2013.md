---
title: "Cambiar la versión de Cordova usada por las Hybrid Apps en Visual Studio 2013"
description: "Cómo actualizar la versión de Cordova usada por las Hybrid Apps en Visual Studio 2013 editando el archivo platforms.js."
pubDate: 2014-11-08
updatedDate: 2023-11-05
tags:
  - "android"
  - "visual-studio"
lang: "es"
translationOf: "2014/11/changing-cordova-version-used-hybrid-apps-visual-studio-2013"
translatedBy: "claude"
translationDate: 2026-05-01
---
Actualizar la versión de Cordova requiere editar el archivo **platforms.js** que se encuentra en:

`%APPDATA%\Roaming\npm\node_modules\vs-mda\node_modules\cordova\node_modules\cord‌​ova-lib\src\cordova`

Puedes cambiar la versión individualmente para cada plataforma, aunque sugiero que uses la misma versión para todas.
También puede que solo busques actualizar por la advertencia de Google Play sobre la vulnerabilidad de high severity cross-application scripting (XAS) encontrada en Cordova 3.5.0. Si es así, aquí tienes el archivo actualizado para apuntar a la versión 3.5.1 que corrige la vulnerabilidad mencionada: [platforms.js](https://www.dropbox.com/s/c475yechp5crd2p/platforms.js?dl=0 "Download platforms.js") (nota: este enlace de Dropbox puede que ya no esté disponible).

Nota: si estás usando la CTP 1 de las Hybrid Apps, la ruta será distinta:
`%APPDATA%\npm\node_modules\vs-mda\node_modules\cordova\`
