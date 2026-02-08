---
title: "Expression Blend 4 has stopped working? Here’s your FIX."
description: "Fix for Expression Blend 4 crashing after installing Visual Studio 11 Dev Preview or .NET Framework 4.5, with the ngen commands needed to resolve it."
pubDate: 2012-01-01
updatedDate: 2023-11-04
tags:
  - "expression-blend"
---
Okay, so this happened to me twice already and in both cases it stopped working after installing the Visual Studio 11 Dev Preview. Having already two PCs on which Expression Blend stopped working I decided to do a little bit of digging and fortunately for me it really took just a bit. The crash is actually a known issue caused by the installation of .NET Framework 4.5 or Visual Studio 11 Dev Preview and the solution for it is rather simple and only takes a couple of minutes.

So what you need to do is open up a command prompt window with administrative privileges and run the commands listed below. Those of you running 32-bit operating systems use `%ProgramFiles%` instead of `%ProgramFiles(x86)%`.

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Framework.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Blend.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Project.dll"
```

If your Expression Blend has Service Pack 1 you'll need to run this command as well:

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.WindowsPhone.dll"
```
