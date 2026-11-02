---
title: "Usa tu teléfono Android como webcam para Streamlabs"
description: "Usa un Android como webcam en Streamlabs Desktop para Windows, con descargas actuales de DroidCam y capturas clásicas claramente identificadas."
pubDate: 2019-04-30
updatedDate: 2026-11-02
tags:
  - "android"
lang: "es"
translationOf: "2019/04/use-your-android-phone-as-a-webcam-for-streamlabs"
translatedBy: "claude"
translationDate: 2026-05-01
---

Un Android con una cámara funcional puede aportar vídeo a una escena de Streamlabs. La calidad depende del teléfono, la luz, la conexión y la configuración; un móvil antiguo no supera automáticamente a una webcam dedicada.

## Elegir la app y el cliente correspondientes

Las capturas muestran **DroidCam Classic y la antigua interfaz de Streamlabs OBS en Windows**. El paquete Android original, `com.dev47apps.droidcam`, devolvió 404 en comprobaciones con parámetros de región de Google Play de Estados Unidos, Rumanía y Alemania el 2 de noviembre de 2026. Eso no demuestra su retirada mundial ni su disponibilidad para todas las cuentas o dispositivos existentes.

Para nuevas instalaciones, [droidcam.app](https://droidcam.app/) enlaza actualmente [DroidCam Webcam & OBS Camera de Dev47Apps](https://play.google.com/store/apps/details?id=com.dev47apps.obsdroidcam), paquete `com.dev47apps.obsdroidcam`. Es una app Android diferente, no un enlace renombrado a la clásica. Las [FAQ oficiales](https://droidcam.app/help/) distinguen la app/cliente nuevos de los clásicos. Usa versiones compatibles entre sí; las capturas clásicas no explican la interfaz nueva.

Este procedimiento es para **Windows**. El [cliente actual de DroidCam](https://droidcam.app/windows/) admite Windows 10/11, pero tu versión de Streamlabs debe cumplir sus [propios requisitos](https://streamlabs.com/content-hub/post/streamlabs-desktop-system-requirements). La existencia de un cliente DroidCam para Linux no convierte esto en una guía de Streamlabs Desktop para Linux. Los procedimientos de macOS y del plugin para OBS Studio son distintos; un plugin de OBS Studio no equivale a una fuente de Streamlabs.

## Configuración actual en Windows

1. Instala la app Android actual de Dev47Apps desde el enlace verificado y concede acceso a la cámara. Activa el micrófono solo si usarás el audio del teléfono.
2. Instala el cliente Windows correspondiente desde la [página oficial de descarga/configuración](https://droidcam.app/windows/).
3. Conecta teléfono y ordenador a la misma red. Abre la app; en el cliente elige **Add > DroidCam**, actualiza la lista y conecta el teléfono. Para USB o problemas de detección, sigue la ayuda del fabricante.
4. Reabre Streamlabs Desktop tras instalar el controlador. Según su [guía de fuentes](https://streamlabs.com/content-hub/post/quick-start-guide-setting-up-streamlabs-desktop-for-streaming), añade **Video Capture Device** y selecciona la cámara expuesta por el cliente. La guía Windows actual la llama **DroidCam Video**; Classic puede mostrar **DroidCam Source 2/3**.
5. Revisa la vista previa, ajusta la fuente y graba una prueba breve. Comprueba el audio por separado; tener vídeo no garantiza que el micrófono esté bien encaminado.

## Procedimiento clásico en Windows: capturas archivadas

Estas imágenes conservan el procedimiento original para quien ya tenga app y cliente Classic correspondientes. La [guía clásica de conexión](https://www.dev47apps.com/droidcam/connect/) usa la misma red y la IP Wi-Fi y el puerto mostrados en el teléfono. Las descargas siguen documentadas en la [página del cliente clásico Windows](https://www.dev47apps.com/droidcam/windows/).

La app clásica de Android muestra la dirección de conexión.

![DroidCam en Android muestra la dirección IP de Wi-Fi y el puerto para conectar el cliente de escritorio.](/wp-content/uploads/2019/04/image-7.png)

Introduce esa dirección y puerto en el cliente clásico Windows.

![Diálogo Wi-Fi de DroidCam Client con la IP y el puerto del dispositivo introducidos y Video y Audio activados.](/wp-content/uploads/2019/04/image-8.png)

Inicia la conexión y comprueba la vista previa.

![DroidCam Client muestra la imagen de la cámara del teléfono conectado.](/wp-content/uploads/2019/04/image-9.png)

La antigua interfaz Streamlabs añade una fuente Video Capture Device.

![Diálogo Add Source de Streamlabs con Video Capture Device subrayado.](/wp-content/uploads/2019/04/image-5-1024x555.png)

Esta instalación usaba DroidCam Source 3; elige el dispositivo que exponga tu cliente.

![Configuración de Video Capture Device en Streamlabs con DroidCam Source 3 seleccionado y una vista previa de la cámara.](/wp-content/uploads/2019/04/image-10.png)

Coloca y redimensiona la cámara dentro de la escena.

![Escena de Streamlabs con la cámara del teléfono como una pequeña superposición en la esquina inferior derecha de la captura de escritorio.](/wp-content/uploads/2019/04/image-11-1024x555.png)

Un soporte estable cerca de la altura de los ojos facilita el encuadre. Elige uno compatible con tu teléfono; la antigua mención del Huawei AF14 era una compra personal, no una recomendación actual de precio o disponibilidad.

Como otro elemento de escena, consulta la [guía de encuestas en Streamlabs](/es/2020/08/polls-for-streamlabs-interact-with-your-viewers/).

**Corrección del 2 de noviembre de 2026:** se distinguieron DroidCam Classic y la app actual, se sustituyó el enlace clásico inaccesible por instrucciones actuales explícitamente identificadas y se limitó la guía Streamlabs a Windows. Se comprobaron enlaces e instrucciones oficiales; esta actualización no incluye una prueba física con teléfono y Windows.
