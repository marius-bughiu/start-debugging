---
title: "get_category_link genera URLs incorrectas que incluyen /blog/"
description: "Solución para get_category_link de WordPress que genera URLs incorrectas con /blog/ en la ruta, provocando errores 404 en las páginas de categoría."
pubDate: 2020-04-04
updatedDate: 2023-11-05
tags:
  - "wordpress"
lang: "es"
translationOf: "2020/04/get_category_link-generating-incorrect-url-including-blog"
translatedBy: "claude"
translationDate: 2026-05-01
---
Recientemente pasé una herramienta de auditoría SEO por el blog y descubrí que todos los enlaces de categoría llevaban a 404. Al inspeccionarlo de cerca, las URLs parecían contener un /blog/ en ellas, mientras que las URLs que realmente funcionan no lo tienen. Mira abajo:

`https://startdebugging.net/blog/category/opinion/` -- no funciona
`https://startdebugging.net/category/opinion/` -- funciona

Aparentemente, todo el problema venía de que estaba usando un formato de permalink personalizado para las entradas que usaba /blog/ como base, y eso lo estaban heredando también las URLs de categoría.

## ¿Cómo solucionarlo?

Asegúrate de especificar un "Category base" en la configuración de permalinks (Settings > Permalink); en mi caso simplemente lo puse como "category".

![Wordpress, Settings > Permalinks > Category base](/wp-content/uploads/2020/04/image-1.png)
