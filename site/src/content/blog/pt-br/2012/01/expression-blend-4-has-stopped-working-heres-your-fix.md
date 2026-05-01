---
title: "Expression Blend 4 parou de funcionar? Aqui vai o FIX."
description: "Solução para o Expression Blend 4 que crasha após instalar o Visual Studio 11 Dev Preview ou o .NET Framework 4.5, com os comandos ngen necessários para resolver."
pubDate: 2012-01-01
updatedDate: 2023-11-04
tags:
  - "expression-blend"
lang: "pt-br"
translationOf: "2012/01/expression-blend-4-has-stopped-working-heres-your-fix"
translatedBy: "claude"
translationDate: 2026-05-01
---
Isso já me aconteceu duas vezes e, nas duas, parou de funcionar depois de instalar o Visual Studio 11 Dev Preview. Tendo já dois PCs com o Expression Blend não funcionando, resolvi pesquisar um pouco e, por sorte, foi rápido. O crash é, na verdade, um issue conhecido causado pela instalação do .NET Framework 4.5 ou do Visual Studio 11 Dev Preview, e a solução é bem simples, leva só alguns minutos.

O que você precisa fazer é abrir um command prompt com privilégios de administrador e rodar os comandos listados abaixo. Quem usa sistemas operacionais de 32 bits deve usar `%ProgramFiles%` em vez de `%ProgramFiles(x86)%`.

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Framework.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Blend.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Project.dll"
```

Se o seu Expression Blend tem o Service Pack 1, você também vai precisar rodar este comando:

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.WindowsPhone.dll"
```
