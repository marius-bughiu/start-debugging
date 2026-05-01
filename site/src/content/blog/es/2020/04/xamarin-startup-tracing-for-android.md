---
title: "Startup Tracing en Xamarin para Android"
description: "Mejora el tiempo de arranque de tu app Xamarin Android hasta en un 48% usando startup tracing, que compila AOT solo el código necesario al inicio."
pubDate: 2020-04-04
updatedDate: 2023-11-05
tags:
  - "android"
  - "xamarin"
lang: "es"
translationOf: "2020/04/xamarin-startup-tracing-for-android"
translatedBy: "claude"
translationDate: 2026-05-01
---
El tiempo de arranque de tu app importa porque es la primera impresión que el usuario tiene sobre su rendimiento. Da igual lo que me prometas si la app tarda 10 segundos en cargar cada vez que intento usarla. Incluso podría desinstalarla pensando que en realidad no funciona. Y con Xamarin Android este ha sido un tema candente con el tiempo. Ahora el equipo ha decidido abordar el problema de forma un poco más agresiva introduciendo startup tracing.

## ¿Qué es startup tracing?

Básicamente significa que parte de tus ensamblados se compilarán ahead-of-time (AOT) en lugar de just-in-time (JIT), reduciendo así la sobrecarga al ejecutar el código pero aumentando el tamaño del APK.

En concreto, startup tracing aplicará AOT solo a las cosas que tu app necesita al iniciar, basándose en un perfil personalizado de tu app. Esto significa que el aumento del APK será mínimo mientras que su impacto es máximo.

Algunos números compartidos por el equipo de Xamarin:

| Tipo | Tiempo de arranque | Tamaño del APK |
| --- | --- | --- |
| Normal | 2914 ms | 16.1 MB |
| AOT | 1180 ms (-59%) | 34.6 MB (+115%) |
| Startup Tracing | 1518 ms (-48%) | 20.1 MB (+25%) |

## Activar startup tracing

Activarlo es sencillo: solo ve a la configuración de tu proyecto Xamarin Android (clic derecho > Properties) y marca "Enable Startup Tracing" en "Code Generation and Runtime", como se muestra en la imagen siguiente.

![](/wp-content/uploads/2020/04/Annotation-2020-04-04-122649-3.png)
