---
title: "Changing the Cordova version used by Hybrid Apps in Visual Studio 2013"
description: "Updating the Cordova version requires you to edit the platforms.js file found in: %APPDATA%\\Roaming\\npm\\node_modules\\vs-mda\\node_modules\\cordova\\node_modules\\cord‌​ova-lib\\src\\cordova You can change the version individually for each platform, tho I suggest you use the same version for all.Also, it might be the case you’re looking to update only because of the Google Play warning regarding the high severity cross-application scripting…"
pubDate: 2014-11-08
updatedDate: 2023-11-05
tags:
  - "android"
  - "visual-studio"
---
Updating the Cordova version requires you to edit the **platforms.js** file found in:

`%APPDATA%\Roaming\npm\node_modules\vs-mda\node_modules\cordova\node_modules\cord‌​ova-lib\src\cordova`

You can change the version individually for each platform, tho I suggest you use the same version for all.  
Also, it might be the case you’re looking to update only because of the Google Play warning regarding the high severity cross-application scripting (XAS) vulnerability found in Cordova 3.5.0. If so here you have the file updated to point to version 3.5.1 which fixes the mentioned vulnerability: [platforms.js](https://www.dropbox.com/s/c475yechp5crd2p/platforms.js?dl=0 "Download platforms.js").

Note: In case you are using CTP 1 of the Hybrid Apps the path will be different:  
`%APPDATA%\npm\node_modules\vs-mda\node_modules\cordova\`
