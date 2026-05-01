---
title: "Expression Blend 4 が動かなくなった？こちらが FIX です。"
description: "Visual Studio 11 Dev Preview や .NET Framework 4.5 をインストールした後に Expression Blend 4 がクラッシュする問題の対処法と、必要な ngen コマンドを紹介します。"
pubDate: 2012-01-01
updatedDate: 2023-11-04
tags:
  - "expression-blend"
lang: "ja"
translationOf: "2012/01/expression-blend-4-has-stopped-working-heres-your-fix"
translatedBy: "claude"
translationDate: 2026-05-01
---
これは私には既に 2 回起きており、どちらも Visual Studio 11 Dev Preview をインストールした後に動かなくなりました。Expression Blend が動かなくなった PC が 2 台になったので少し調べてみたのですが、幸い、本当に少し調べるだけで済みました。このクラッシュは実は既知の問題で、.NET Framework 4.5 または Visual Studio 11 Dev Preview のインストールが原因です。解決方法はかなり簡単で、数分で済みます。

やることは、管理者権限で command prompt を開き、下記のコマンドを実行するだけです。32 ビット OS の方は `%ProgramFiles(x86)%` の代わりに `%ProgramFiles%` を使ってください。

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Framework.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Blend.dll" 
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.Project.dll"
```

お使いの Expression Blend に Service Pack 1 が入っている場合は、次のコマンドも実行してください。

```plaintext
C:\> %windir%\Microsoft.NET\Framework\v4.0.30319\ngen uninstall "%ProgramFiles(x86)%\Microsoft Expression\Blend 4\Microsoft.Expression.WindowsPhone.dll"
```
