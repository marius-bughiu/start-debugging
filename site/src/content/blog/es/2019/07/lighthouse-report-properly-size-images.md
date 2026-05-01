---
title: "Informe de Lighthouse: dimensiona correctamente las imágenes"
description: "Mejora tu puntuación de rendimiento en Lighthouse dimensionando y optimizando correctamente las imágenes para la web con herramientas como Squoosh."
pubDate: 2019-07-28
updatedDate: 2023-11-15
tags:
  - "lighthouse"
lang: "es"
translationOf: "2019/07/lighthouse-report-properly-size-images"
translatedBy: "claude"
translationDate: 2026-05-01
---
Dimensionar correctamente las imágenes puede mejorar drásticamente los tiempos de carga de tu página. Aquí miramos dos categorías distintas:

-   imágenes no optimizadas para la web (sin compresión, formatos inadecuados)
-   imágenes con una resolución mayor a la necesaria (por ejemplo, una imagen de 800px de ancho mostrada a 300px)

![Informe de Lighthouse sobre dimensionar correctamente las imágenes](/wp-content/uploads/2019/07/properly-size-images.jpg)

En nuestro caso tenemos tres imágenes en la portada no optimizadas o mal dimensionadas. Para optimizarlas usaré [Squoosh](https://squoosh.app/).

Primera imagen, el logo de Outworld Apps: tenía 887px de ancho y se mostraba en un contenedor de 263px. Tras redimensionar y optimizar con OptiPNG, su tamaño bajó de 29.2 KB a 9.13 KB.

Segunda imagen, una imagen mía. 200px por 200px mostrada en un contenedor de 86px. Redimensionar y optimizar dio como resultado una imagen un 76% más pequeña.

La última, una imagen de uno de los artículos. Aquí es importante conocer el ancho del contenedor de tus posts. En mi blog es 523px. La imagen ya tiene ese tamaño, pero la pegué desde la herramienta de recortes, así que no estaba optimizada en absoluto, y además era un PNG cuando en este caso no me importa la transparencia, así que podría ser tranquilamente un JPEG.

Actualizamos las imágenes y listo.
