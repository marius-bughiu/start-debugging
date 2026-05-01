---
title: "Mit Code-Snippets produktiver werden"
description: "Erfahren Sie, wie Code-Snippets in Visual Studio Ihre Produktivität steigern können, indem Sie wiederverwendbare Codestücke per Kurzalias einfügen."
pubDate: 2012-01-06
updatedDate: 2023-11-04
tags:
  - "csharp"
  - "visual-studio"
lang: "de"
translationOf: "2012/01/improve-productivity-by-using-code-snippets"
translatedBy: "claude"
translationDate: 2026-05-01
---
Code-Snippets sind eine großartige Möglichkeit, die Produktivität zu steigern, weil Sie damit Codestücke definieren können, die Sie später per kurzem Alias in Ihre Projekte einfügen.

Obwohl es sie in Visual Studio schon seit einiger Zeit gibt, wissen nicht viele, was sie sind, was sie genau tun und wie man sie zum eigenen Vorteil nutzt. Davon zu hören ist eine Sache, sie zu verwenden eine andere. Fast jede(r) von uns (die wir Code schreiben) hat sie schon einmal benutzt, und das beste Beispiel, das mir einfällt, ist: foreach. Wie oft haben Sie foreach getippt und dann zweimal TAB gedrückt, woraufhin Code wie von Zauberhand an Ihrer Cursorposition erschien? Genau, das ist ein Code-Snippet! Und davon gibt es noch viele mehr. Es gibt Code-Snippets für Dinge wie Klassendefinition, Constructors, Destructors, Structures, for, do-while usw., eine vollständige Liste (für C#) finden Sie hier: [Visual C# Default Code Snippets](http://msdn.microsoft.com/en-US/library/z41h7fat%28v=VS.100%29.aspx "Visual C# Default Code Snippets").

Das sind aber nur ein kleiner Teil dessen, was Code-Snippets bieten -- es sind die mit Visual Studio mitgelieferten Standard-Snippets. Wirklich nett ist, dass Sie eigene definieren und damit überall und jederzeit Code in Ihre Projekte einfügen können. Ich werde nächste Woche ein einfaches Tutorial dazu erstellen; bis dahin können Sie [auf dieser Seite vorbeischauen](http://msdn.microsoft.com/en-us/library/ms165393.aspx "can check out this page").

Wenn Sie ein paar allgemeine Snippets zur bestehenden Sammlung hinzufügen möchten, gibt es ein [nettes Projekt auf codeplex](http://vssnippets.codeplex.com/ "C# Code Snippets") mit genau 38 C#-Snippets, die Sie Ihrer Sammlung hinzufügen können. Das Hinzufügen in Visual Studio ist einfach: Laden Sie die Zip-Datei vom oben genannten Link herunter und entpacken Sie sie. Gehen Sie dann zu Tools -> Code Snippet Manager oder drücken Sie Ctrl + K, Ctrl + B, und klicken Sie auf Import. Navigieren Sie zum Ordner, in dem Sie die Zip entpackt haben, wählen Sie alle Snippets darin aus und klicken Sie auf Open; wählen Sie dann den Ordner/die Kategorie, der/die hinzugefügt werden soll (standardmäßig My Code Snippets), und klicken Sie auf finish. Voilà! Sie sind einsatzbereit. Zum Ausprobieren tippen Sie z. B. task oder thread irgendwo und drücken TAB zweimal -- der Code sollte automatisch eingefügt werden.

Das war's für jetzt. Wie versprochen, nächste Woche dazu, wie man eigene Code-Snippets erstellt, und vielleicht auch etwas zu Snippet-Designern.
