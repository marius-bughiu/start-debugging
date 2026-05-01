---
title: "Solucionar las pestañas de Firefox con colores extraños en Windows 8"
description: "Cómo solucionar el glitch de color en las pestañas de Firefox en Windows 8 con tarjetas gráficas nVidia desactivando la aceleración por hardware."
pubDate: 2012-11-01
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "es"
translationOf: "2012/11/fix-firefox-tabs-having-strange-colors-in-windows-8"
translatedBy: "claude"
translationDate: 2026-05-01
---
Este glitch gráfico es un bug conocido de Firefox ejecutándose en Windows 8. Parece manifestarse solo en máquinas con tarjetas gráficas nVidia y está causado por el uso de aceleración por hardware en el navegador.

La solución es simple: **desactivar la aceleración por hardware** desde el menú de configuración del navegador. Los colores extraños desaparecerán; lamentablemente, también desaparecerá la aceleración por hardware. Pero eso es todo lo que podemos hacer hasta que se corrija el bug.

Puedes seguir el issue en bugzilla aquí: [https://bugzilla.mozilla.org/show_bug.cgi?id=686782](https://bugzilla.mozilla.org/show_bug.cgi?id=686782)

Y por si no encuentras la opción: abre la ventana de opciones (Firefox > Options o Tools > Options) > Advanced > General. Una vez allí, desmarca la casilla "Use hardware acceleration when available". Eso es todo.

Actualización: 8 años después, actualizando esto por SEO, el bug no se ha corregido, pero bueno... ¿quién sigue usando Windows 8 a estas alturas?
