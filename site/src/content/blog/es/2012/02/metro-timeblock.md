---
title: "Metro TimeBlock"
description: "Metro TimeBlock es un control de visualización de tiempo personalizable para Windows Phone que te permite establecer cualquier color, fondo y tamaño."
pubDate: 2012-02-08
updatedDate: 2023-11-05
tags:
  - "metro"
  - "windows-phone"
lang: "es"
translationOf: "2012/02/metro-timeblock"
translatedBy: "claude"
translationDate: 2026-05-01
---
Metro TimeBlock es un control de visualización de tiempo que he hecho y que te permite mostrar la hora en cualquier color y con el fondo que quieras. El tamaño también es ajustable y puedes elegir entre mostrar la hora actual o una hora propia.

[![Metro TimeBlock](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)

Propiedades del control:

**Time** -- recibe cualquier objeto DateTime. El control mostrará la Time que proporciones dentro de ese DateTime. Déjalo en blanco si quieres mostrar la hora actual.

**Spacer** -- es el string que se muestra entre las horas y los minutos y entre los minutos y los segundos. Usa separadores como ":" o " ".

**Size** -- puedes elegir entre **Small, Normal, Medium, MediumLarge, Large, ExtraLarge, ExtraExtraLarge** y **Huge**. Opté por hacerlo así en lugar de permitir FontSize porque de esta manera también puedo controlar cómo se ven los bloques de fondo.

**Foreground** -- le indica al control qué color usar para mostrar la hora.

**Fill** -- establece el color de fondo del control (los bloques tipo cuadrado).

Y eso es todo. Si tienes algún problema o necesitas ayuda, deja un comentario abajo. Puedes descargar el código desde [este enlace](https://www.dropbox.com/s/mjiba8cugtj8fdz/StartDebugging.zip?dl=0); contiene tanto el control como un par de ejemplos.
