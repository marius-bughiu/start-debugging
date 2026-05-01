---
title: "Expression Blend 4 funktioniert nicht mehr? Hier ist Ihr FIX."
description: "Lösung für Abstürze von Expression Blend 4 nach der Installation der Visual Studio 11 Dev Preview oder des .NET Framework 4.5 -- mit den nötigen ngen-Befehlen."
pubDate: 2012-01-01
updatedDate: 2023-11-04
tags:
  - "expression-blend"
lang: "de"
translationOf: "2012/01/expression-blend-4-has-stopped-working-heres-your-fix"
translatedBy: "claude"
translationDate: 2026-05-01
---
Das ist mir bereits zweimal passiert -- und in beiden Fällen funktionierte es nach der Installation der Visual Studio 11 Dev Preview nicht mehr. Da ich bereits zwei PCs hatte, auf denen Expression Blend nicht mehr lief, habe ich ein wenig recherchiert, und glücklicherweise ging es schnell. Der Crash ist tatsächlich ein bekanntes Issue, ausgelöst durch die Installation von .NET Framework 4.5 oder der Visual Studio 11 Dev Preview, und die Lösung ist ziemlich einfach und dauert nur ein paar Minuten.

Sie öffnen ein Command-Prompt-Fenster mit administrativen Rechten und führen die unten aufgeführten Befehle aus. Wer ein 32-Bit-Betriebssystem nutzt, ersetzt `%ProgramFiles(x86)%` durch `%ProgramFiles%`.

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Framework.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Blend.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Project.dll"
```

Falls Ihr Expression Blend Service Pack 1 hat, müssen Sie zusätzlich diesen Befehl ausführen:

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.WindowsPhone.dll"
```
