---
title: "Solución al error de Xamarin: Csc.exe exited with code -1073741790. (MSB6006)"
description: "Soluciona el error MSB6006 de Csc.exe en Xamarin ejecutando como Administrador o limpiando las carpetas bin y obj de la solución."
pubDate: 2015-08-28
updatedDate: 2023-11-05
tags:
  - "xamarin"
lang: "es"
translationOf: "2015/08/fix-xamarin-error-csc-exe-exited-with-code-1073741790-msb6006"
translatedBy: "claude"
translationDate: 2026-05-01
---
Simplemente ejecuta Xamarin Studio como Administrador.

El error normalmente significa que el proceso no puede acceder a un determinado recurso. En mi caso era falta de permisos; pero también puede significar que algún archivo ya está en uso. En ese caso, haz Clean en la solución y Rebuild, y si eso tampoco funciona, haz una limpieza manual de la solución eliminando las carpetas "bin" y "obj" de cada proyecto.
