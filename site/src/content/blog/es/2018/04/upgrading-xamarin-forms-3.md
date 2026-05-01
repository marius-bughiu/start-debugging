---
title: "Actualizar a Xamarin Forms 3"
description: "Una guía rápida para actualizar a Xamarin Forms 3, incluyendo errores comunes de compilación y cómo solucionarlos."
pubDate: 2018-04-07
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "es"
translationOf: "2018/04/upgrading-xamarin-forms-3"
translatedBy: "claude"
translationDate: 2026-05-01
---
Actualizar entre versiones mayores de Xamarin tiende a romper cosas y a hacer que los proyectos dejen de compilar por errores raros. En su inocencia, la mayoría de los devs tomarán estos errores como reales, intentarán entenderlos, arreglarlos, y cuando fracasen, los googlearán; cuando, la mayoría de las veces, el fix es cerrar Visual Studio, abrirlo de nuevo y hacer una compilación limpia de la solución. Veamos Xamarin Forms 3 (ten en cuenta que es una versión pre-release, así que esto puede estar resuelto para el lanzamiento real).

Abre tu proyecto existente o crea uno nuevo Master Detail usando .NET Standard. Compila el proyecto y verifica que se ejecute. Ahora, gestiona los paquetes NuGet de tu solución. Si trabajas con una versión pre-release como yo, marca la casilla "Include prerelease".

Selecciona todos los paquetes y Update. Si pruebas a compilar ahora, deberías estar recibiendo algunos errores sobre GenerateJavaStubs fallando y el parámetro XamlFiles no estando soportado por XamlGTask. Ignóralos, cierra Visual Studio (VS puede lanzar un error sobre que se canceló alguna tarea; ignóralo también), abre VS de nuevo, limpia tu solución y vuelve a compilar -- ya sabes, como un verdadero developer.

Tras esto, si trabajas con un proyecto nuevo y compilas para Android, te aparecerá el error de Java max heap size.

Ve a Properties en tu proyecto Android, elige Android Options y haz clic en Advanced abajo. Luego escribe "1G" en la opción Java Max Heap Size. Me pregunto cuándo decidirán convertir esto en un valor por defecto en los nuevos proyectos...

Compila de nuevo y ¡voilà! Ya funciona.
