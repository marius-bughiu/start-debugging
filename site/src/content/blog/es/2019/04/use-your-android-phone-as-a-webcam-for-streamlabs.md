---
title: "Usa tu teléfono Android como webcam para Streamlabs"
description: "Convierte tu viejo teléfono Android en una webcam para Streamlabs OBS usando DroidCam, con instrucciones de configuración paso a paso."
pubDate: 2019-04-30
updatedDate: 2020-08-06
tags:
  - "android"
lang: "es"
translationOf: "2019/04/use-your-android-phone-as-a-webcam-for-streamlabs"
translatedBy: "claude"
translationDate: 2026-05-01
---
¿Necesitas una webcam para hacer streaming? ¿Por qué no usar uno de los teléfonos rotos u obsoletos que tienes por casa?

La mayoría de los teléfonos pueden hacer fotos y grabar a una resolución más alta y con mejor calidad que una webcam típica. Eso los convierte en un sustituto ideal de la webcam al hacer streaming, especialmente cuando tienes uno olvidado por ahí.

Hace poco acabé con un Google Pixel 2 XL con la pantalla defectuosa. Resumiendo: rompí la pantalla, la reemplacé y 8 meses después la pantalla de reemplazo falló. Y por el coste y la falta de garantía decidí poner el límite y no volver a cambiar la pantalla. Así que me quedé con un smartphone defectuoso pero con una cámara perfectamente funcional y excelente.

Vamos al grano. Para usar tu teléfono Android como webcam vas a necesitar dos cosas:

-   [DroidCam Wireless Webcam](https://play.google.com/store/apps/details?id=com.dev47apps.droidcam) para Android
-   y la aplicación cliente para Windows o Linux, que puedes [descargar desde aquí](http://www.dev47apps.com/)

Primero, descarga e instala la app en tu teléfono Android. Una vez instalada, pasa por el asistente de configuración, dale a la app los permisos necesarios (para grabar audio y video) y listo. Ahora la app debería mostrar información como la dirección IP y el puerto en el que está emitiendo el video. Tenlo a mano, lo necesitaremos en el siguiente paso.

![](/wp-content/uploads/2019/04/image-7.png)

A continuación, descarga e instala el cliente para Windows o Linux. Una vez instalado, lanza la app y completa la dirección IP y el puerto tal cual aparecen en la aplicación de Android.

![](/wp-content/uploads/2019/04/image-8.png)

Cuando estés listo, pulsa Start. Y voilà, ¡tu nueva webcam!

![](/wp-content/uploads/2019/04/image-9.png)

El último paso es añadir la fuente de video en Streamlabs. Para ello, abre Streamlabs OBS y haz clic en + para añadir una nueva Source.

![](/wp-content/uploads/2019/04/image-5-1024x555.png)

En el popup que se abre, selecciona Video Capture Device y haz clic en Add Source. En la siguiente pantalla, simplemente haz clic en Add New Source. Ahora puedes jugar con la configuración del dispositivo. Primero, selecciona DroidCam en el desplegable Device; en mi caso se llama DroidCam Source. Luego ajusta los parámetros hasta conseguir el resultado deseado; en mi caso los valores por defecto fueron perfectos. Cuando termines, haz clic en Done.

![](/wp-content/uploads/2019/04/image-10.png)

Ahora puedes arrastrar la fuente de video por tu escena y redimensionarla como quieras. Cuando estés listo, puedes empezar a hacer streaming.

![](/wp-content/uploads/2019/04/image-11-1024x555.png)

## Consejo

Uno de los problemas al usar teléfonos como webcam es lograr que se mantengan en una posición estable, preferiblemente a cierta altura y ángulo. Puedes resolverlo con un trípode para smartphone.

Acabé eligiendo un Huawei AF14, ya que era la opción más barata que cumplía mis necesidades. Cuando tengas el trípode, ponlo en un ángulo que te resulte cómodo y a una altura cercana a la de tus ojos.
