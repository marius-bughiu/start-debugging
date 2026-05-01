---
title: "Expression Blend 4 перестал работать? Вот ваш FIX."
description: "Решение проблемы с падением Expression Blend 4 после установки Visual Studio 11 Dev Preview или .NET Framework 4.5 - с командами ngen, нужными для исправления."
pubDate: 2012-01-01
updatedDate: 2023-11-04
tags:
  - "expression-blend"
lang: "ru"
translationOf: "2012/01/expression-blend-4-has-stopped-working-heres-your-fix"
translatedBy: "claude"
translationDate: 2026-05-01
---
У меня это случалось уже дважды, и в обоих случаях всё переставало работать после установки Visual Studio 11 Dev Preview. Имея уже два ПК, на которых Expression Blend перестал работать, я решил немного покопаться, и, к счастью, понадобилось совсем чуть-чуть. Этот crash - известная проблема, вызванная установкой .NET Framework 4.5 или Visual Studio 11 Dev Preview, а решение довольно простое и занимает всего пару минут.

Что нужно сделать: открыть command prompt с правами администратора и выполнить указанные ниже команды. Тем, у кого 32-битная ОС, использовать `%ProgramFiles%` вместо `%ProgramFiles(x86)%`.

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Framework.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Blend.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Project.dll"
```

Если у вас установлен Service Pack 1 для Expression Blend, нужно также выполнить эту команду:

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.WindowsPhone.dll"
```
