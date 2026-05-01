---
title: "Informe de Lighthouse: aplazar imágenes fuera de pantalla en WordPress"
description: "Mejora la puntuación de rendimiento de Lighthouse de tu sitio WordPress aplazando las imágenes fuera de pantalla con lazy loading."
pubDate: 2019-05-01
updatedDate: 2023-11-05
tags:
  - "lighthouse"
lang: "es"
translationOf: "2019/05/lighthouse-report-defer-offscreen-images-in-wordpress"
translatedBy: "claude"
translationDate: 2026-05-01
---
Una de las cosas más importantes cuando hablamos de rendimiento percibido es la rapidez con la que carga una página web la primera vez que se accede, y una de las claves para tener una página web rápida es cargar solo lo necesario y cuando es necesario.

Por supuesto, eso puede sonar a mucho trabajo, pero hay algunos frutos al alcance de la mano, especialmente al mirar las imágenes. Las imágenes suelen ser lo que más ancho de banda consume al cargar un sitio y, tradicionalmente, simplemente cargas todo.

Hay varios inconvenientes en hacer eso:

-   Estás usando recursos para algo que el usuario puede que ni siquiera vea.
-   Posibles implicaciones de coste tanto para el usuario como para ti. El usuario podría estar en una conexión móvil con cuota, mientras que tú podrías estar hosteando en la nube y pagando por el ancho de banda saliente.
-   Mala experiencia de usuario y rendimiento percibido porque estás descargando y procesando contenido inútil (fuera de vista) en vez de centrarte en lo que sí está a la vista.
-   Lo anterior también puede llevar a penalizaciones de page ranking aplicadas por Google, ya que Google favorece páginas web más responsivas.

La solución: aplazar y cargar las imágenes solo cuando entran en vista. Y, como decía, es un fruto al alcance de la mano: hay un plugin que hace justo eso: [Lazy Load Optimizer](https://wordpress.org/support/plugin/lazy-load-optimizer/).

Simplemente añádelo a tu sitio WordPress y listo. Ahora, cuando los usuarios accedan a tu web, solo descargarán las imágenes que estén dentro de su vista. Las demás imágenes se cargarán de forma lazy a medida que el usuario haga scroll.

Solo esto subió el rating de rendimiento del blog 20 puntos, de 41 a 61. Veamos por dónde vamos a continuación.

## Solución de problemas

Personalmente tuve algunos problemas tras instalar el plugin, con un par de imágenes que se rompían así:

![](/wp-content/uploads/2019/04/image-6-1024x490.png)

Esto se debía a algunos estilos hardcodeados que tenía en los propios tags img, lo cual además se considera mala práctica. He movido todo a un par de clases CSS que se cargan por separado y ahora todo está bien.
