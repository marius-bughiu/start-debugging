---
title: "Mejora tu productividad usando code snippets"
description: "Aprende cómo los code snippets de Visual Studio pueden mejorar tu productividad permitiéndote insertar piezas de código reutilizables mediante un alias corto."
pubDate: 2012-01-06
updatedDate: 2023-11-04
tags:
  - "csharp"
  - "visual-studio"
lang: "es"
translationOf: "2012/01/improve-productivity-by-using-code-snippets"
translatedBy: "claude"
translationDate: 2026-05-01
---
Los code snippets son una gran forma de mejorar tu productividad porque te permiten definir piezas de código que luego puedes insertar en tus proyectos usando un alias corto.

Aunque están en Visual Studio desde hace bastante tiempo, no mucha gente sabe lo que son, qué hacen exactamente y cómo usarlos en su beneficio. Una cosa es haber oído hablar de ellos, y otra es usarlos. Casi todos nosotros (los que escribimos código) los hemos usado al menos una vez en la vida, y el mejor ejemplo que se me ocurre al decir esto es: foreach. Es decir, ¿cuántas veces has tecleado foreach y luego pulsado TAB dos veces para que apareciera código mágicamente en la posición de tu cursor? Sí, ¡eso es un code snippet! Y hay muchísimo más de donde vino ese. Hay code snippets para cosas como definición de clase, constructors, destructors, structures, for, do-while, etc., y la lista completa (para C#) la puedes encontrar aquí: [Visual C# Default Code Snippets](http://msdn.microsoft.com/en-US/library/z41h7fat%28v=VS.100%29.aspx "Visual C# Default Code Snippets").

Pero esos son solo una pequeña parte de lo que los code snippets pueden ofrecer; esos son los code snippets por defecto que vienen con Visual Studio. Lo realmente bueno de los code snippets es que puedes definir los tuyos y luego usarlos para insertar código en tus proyectos donde y cuando quieras. Intentaré hacer un tutorial sencillo sobre cómo crear tu propio code snippet la próxima semana; hasta entonces puedes [echar un vistazo a esta página](http://msdn.microsoft.com/en-us/library/ms165393.aspx "can check out this page").

Para quienes busquen un par de snippets generales que añadir a los que ya tienen, hay un [bonito proyecto en codeplex](http://vssnippets.codeplex.com/ "C# Code Snippets") que contiene exactamente 38 code snippets de C# listos para añadirse a tu colección. Añadirlos a tu Visual Studio es fácil: descarga el zip desde el enlace mencionado y extráelo. Luego ve a Tools -> Code Snippet Manager o pulsa Ctrl + K, Ctrl + B y haz clic en Import. Navega hasta la carpeta donde extrajiste el zip, selecciona todos los code snippets de dentro y pulsa Open; luego elige a qué carpeta / categoría añadirlos (My Code Snippets por defecto) y haz clic en finish. ¡Y listo!, están preparados para usarse. Para probarlos y ver si funcionan, prueba por ejemplo a escribir task o thread en algún sitio y pulsar TAB dos veces: el código debería insertarse automáticamente.

Y eso es todo por ahora. Como prometí, la próxima semana llegará cómo crear tus propios code snippets y quizá también algo sobre snippet designers.
