---
title: "Windows 8 y Secure Boot: ¿qué pasa si tu PC no lo soporta?"
description: "Qué hacer cuando recibes el error 'Secure Boot isn't compatible with your PC' al instalar Windows 8, y qué es realmente Secure Boot."
pubDate: 2012-06-05
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "es"
translationOf: "2012/06/windows-8-and-secure-boot-what-if-your-pc-doesnt-support-it"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hoy, mientras (por error) intentaba actualizar mi Windows 7 a Windows 8, me topé con una comprobación de compatibilidad con 6 errores, entre ellos uno que dice:

> Secure Boot isn't compatible with your PC

Al principio me dio mala espina pensar que no podría instalar Windows 8 aunque la Consumer Preview iba perfectamente (con algunas excepciones), pero después de un par de búsquedas me di cuenta de que esto no será un problema. Secure Boot es una característica que puedes simplemente omitir y todo funcionará igual de bien.

**¿Qué es exactamente Secure Boot?**

Secure Boot es un nuevo proceso de arranque (measured boot) que, junto con UEFI 2.3.1 (Unified Extensible Firmware Interface), aborda un hueco de seguridad existente en el diseño actual de BIOS que permite que software malicioso se cargue antes del sistema operativo. Esto se hace mediante el uso de certificados: básicamente, no se cargará nada que no esté firmado por Microsoft, lo que significa nada de malware.

Esta característica solo está disponible en sistemas relativamente nuevos porque depende de un chip llamado Trusted Platform Module o TPM. Este chip se usa para almacenar los procesos de arranque firmados, protegidos y medidos en los que se basa Secure Boot.

Así que sin TPM, no hay Secure Boot, solo el arranque normal, lo que significa que esto no te impedirá instalar Windows 8 en tu máquina.
