---
title: "¿Expression Blend 4 ha dejado de funcionar? Aquí tienes el FIX."
description: "Solución para Expression Blend 4 que crashea tras instalar Visual Studio 11 Dev Preview o .NET Framework 4.5, con los comandos ngen necesarios para resolverlo."
pubDate: 2012-01-01
updatedDate: 2023-11-04
tags:
  - "expression-blend"
lang: "es"
translationOf: "2012/01/expression-blend-4-has-stopped-working-heres-your-fix"
translatedBy: "claude"
translationDate: 2026-05-01
---
Esto ya me ha pasado dos veces, y en ambos casos dejó de funcionar tras instalar el Visual Studio 11 Dev Preview. Como ya tenía dos PCs en los que Expression Blend había dejado de funcionar, decidí investigar un poco y, por suerte, hizo falta muy poco. El crash es en realidad un issue conocido causado por la instalación de .NET Framework 4.5 o de Visual Studio 11 Dev Preview, y la solución es bastante simple y solo lleva un par de minutos.

Lo que tienes que hacer es abrir una ventana de command prompt con privilegios de administrador y ejecutar los comandos listados abajo. Quienes tengan sistemas operativos de 32 bits, usad `%ProgramFiles%` en lugar de `%ProgramFiles(x86)%`.

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Framework.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Blend.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Project.dll"
```

Si tu Expression Blend tiene Service Pack 1, también tendrás que ejecutar este comando:

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.WindowsPhone.dll"
```
