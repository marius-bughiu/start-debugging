---
title: "Wie Sie eigene Code-Snippets in Visual Studio erstellen"
description: "Schritt-für-Schritt-Anleitung zum Erstellen eigener Code-Snippets in Visual Studio 2010, einschließlich einfacher Snippets und der Verwendung von Literals für ersetzbare Parameter."
pubDate: 2012-01-14
updatedDate: 2023-11-04
tags:
  - "visual-studio"
lang: "de"
translationOf: "2012/01/how-to-create-your-own-code-snippet"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hier zeige ich Ihnen, wie Sie eigene Code-Snippets für Visual Studio 2010 erstellen, ohne Add-Ins für Snippet-Design zu verwenden. Einen Beitrag zu Snippet-Designern/-Explorern und wie Sie damit schneller bessere Snippets bauen, gibt es vermutlich nächste Woche -- diesmal versprechen kann ich es aber nicht.

## Teil 1: Ein einfaches Code-Snippet erstellen

Legen wir los. Öffnen Sie Visual Studio und gehen Sie zu **File - New File** (oder Ctrl + N) und erstellen Sie eine neue XML-Datei. Den Dateinamen müssen Sie sich noch keine Gedanken machen, das ist im Moment nicht so wichtig. Es wird automatisch eine XML-Datei mit einer Codezeile erzeugt. Als Erstes fügen Sie in dieser brandneuen Datei den **CodeSnippets**-Namespace und ein **CodeSnippet**-Element direkt nach der ersten Zeile hinzu; kopieren Sie dazu den folgenden Code:

```xml
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
   </CodeSnippet>
</CodeSnippets>
```

Jetzt können wir wirklich am Snippet arbeiten. Als Erstes richten wir den Header ein. Der Header kann verschiedene Informationen enthalten: **Title, Description, Author, Keywords** (falls Sie das Snippet online bereitstellen möchten), einen **Shortcut** für Ihr Snippet und außerdem eine **HelpUrl**, an die Nutzer sich wenden können, falls etwas nicht wie erwartet funktioniert. Ich empfehle, immer einen Title und eine Description hinzuzufügen, auch wenn sie nicht zwingend sind.

Hier ein Beispiel-Header mit allen möglichen Elementen:

```xml
<Header>
   <Title>MessageBox</Title>
   <Description>Opens up a message box displaying "Hello World!".</Description>
   <Author>StartDebugging.net</Author>
   <Keywords>
      <Keyword>messagebox</Keyword>
      <Keyword>helloworld</Keyword>
   </Keywords>
   <Shortcut>hellobox</Shortcut>
   <HelpUrl>http://startdebugging.net</HelpUrl>
</Header>
```

Mit fertigem Header können wir den Code schreiben. Erstellen Sie zuerst direkt nach dem Ende des Header-Elements das eigentliche **Snippet**-Element. Ihr Code sollte nun so aussehen:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
      <Header>
         ...
      </Header>
      <Snippet>
      </Snippet>
   </CodeSnippet>
</CodeSnippets>
```

Den Code, den das Snippet einfügen soll, schreiben Sie in das **Code**-Element des **Snippet**, eingerahmt von `<![CDATA[` und `]]>`. In diesem Beispiel zeigt unser Code-Snippet -- wie Sie der Description vermutlich entnommen haben -- einfach eine MessageBox mit dem Text "Hello World!" an. Unten sehen Sie, wie das **Code**-Element nach dem Hinzufügen des Codes aussieht.

```xml
<Snippet>
   <Code Language="CSharp">
      <![CDATA[MessageBox.Show("Hello World!");]]>
   </Code>
</Snippet>
```

Wie Sie sehen, hat mein **Code**-Element eine Eigenschaft **Language**, die auf **CSharp** gesetzt ist. Achten Sie darauf, das Language entsprechend zu setzen. Sie können Code-Snippets für VB, CSharp, VJSharp und XML schreiben.

Ein weiteres Element, das Sie zum **Snippet** hinzufügen können, ist **References**. Leider wird das für C# nicht unterstützt, daher müssen Sie sie in unserem Fall manuell hinzufügen. Andernfalls fügen Sie eine Reference so hinzu:

```xml
<Snippet>
   <References>
      <Reference>
         <Assembly>System.Windows.Forms.dll</Assembly>
      </Reference>
   </References>
   <Code Language="VB">
      ...
   </Code>
</Snippet>
```

Hier der gesamte Code des Snippets:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
      <Header>
         <Title>MessageBox</Title>
         <Description>Opens up a message box displaying "Hello World!".</Description>
         <Author>StartDebugging.net</Author>
         <Keywords>
            <Keyword>messagebox</Keyword>
            <Keyword>helloworld</Keyword>
         </Keywords>
         <Shortcut>hellobox</Shortcut>
         <HelpUrl>http://startdebugging.net</HelpUrl>
      </Header>
      <Snippet>
         <Code Language="CSharp">
            <![CDATA[MessageBox.Show("Hello World");]]>
         </Code>
      </Snippet>
   </CodeSnippet>
</CodeSnippets>
```

Nun, da das Snippet fertig ist, geht es an das Speichern. Also **File - Save as** in folgenden Pfad:

```plaintext
Drive:\...\Documents\Visual Studio Version\Code Snippets\Language\
```

was in unserem Fall

```plaintext
Drive:\...\Documents\Visual Studio 2010\Code Snippets\Visual C#\
```

ist, mit der Dateiendung **.snippet** -- zum Beispiel **messagebox.snippet**.

Nach dem Speichern fügen Sie es Ihrem Visual Studio 2010 hinzu. Gehen Sie zu **Tools - Code Snippets Manager** (oder Ctrl + K, Ctrl + B), klicken Sie auf **Import** und öffnen Sie das soeben gespeicherte Snippet. Anschließend werden Sie gefragt, zu welchen Languages es hinzugefügt werden soll; in unserem Fall haken Sie einfach **Visual C#** an.

Erstellen Sie ein neues C#-Projekt oder öffnen Sie ein bestehendes und gehen Sie an eine Stelle, an der Sie C#-Code schreiben können. Snippets einfügen geht auf zwei Arten: Erstens -- Ctrl + K, Ctrl + X drücken, Visual C# (oder ein beliebiges anderes Language) wählen und das Snippet auswählen, das Sie einfügen möchten (unseres heißt MessageBox -- gesetzt über das **Title**-Tag); zweitens -- den Shortcut tippen (unserer ist **hellobox** -- über das **Shortcut**-Tag im Header gesetzt) und doppelt **TAB** drücken. Schon ist Ihr Snippet eingefügt.

## Teil 2: Literals verwenden

Da Sie nun ein Code-Snippet erstellen, speichern und nutzen können, ist es Zeit, etwas komplexere zu lernen -- ich spreche von **Literals**.

Da mir keine bessere Definition für Literals einfiel, hier die, die ich auf msdn gefunden habe:

> Das **Literal**-Element wird verwendet, um eine Ersetzung für ein Stück Code zu kennzeichnen, das vollständig im Snippet enthalten ist, aber nach dem Einfügen in den Code wahrscheinlich angepasst wird.

Angenommen, Sie haben ein Code-Snippet, in dem ein Variablenname zehnmal vorkommt. Sie fügen das Snippet ein und beschließen, den Variablennamen zu ändern; also ersetzen Sie den alten in allen zehn Stellen durch den neuen. Mit Literals können Sie ein Stück Code im Snippet definieren, das mehrfach verwendet wird; wenn Sie nach dem Einfügen das Stück an einer Stelle ändern, ändert es sich an allen anderen mit. Sie können sie sich wie Variablen vorstellen.

Setzen wir das in die Praxis um. Wir erstellen ein Code-Snippet zum Einfügen von Dependency Properties in unsere Silverlight-Projekte. Der Code, um eine Dependency Property mit einem Property-Changed-Event-Handler zu registrieren, sieht so aus:

```cs
public bool IsSelected
{
   get { return (bool)GetValue(IsSelectedProperty); }
   set { SetValue(IsSelectedProperty, value); }
}
public static readonly DependencyProperty IsSelectedProperty = DependencyProperty.Register("IsSelected", typeof(Boolean), typeof(Page), new PropertyMetadata(OnIsSelectedPropertyChanged));
private static void OnIsSelectedPropertyChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
{
   Page control = d as Page;
}
```

Wie Sie sehen, kommen Property-Name und Property-Typ mehrfach vor; wir definieren also für jeden ein Literal -- plus eines für den Klassennamen. Sie sehen so aus:

```xml
<Snippet>
   <Declarations>
      <Literal>
         <ID>PropertyName</ID>
         <Default>PropertyName</Default>
         <ToolTip>The name of the dependency property.</ToolTip>
      </Literal>
      <Literal>
         <ID>PropertyType</ID>
         <Default>PropertyType</Default>
         <ToolTip>The type of the dependency property.</ToolTip>
      </Literal>
      <Literal>
         <ID>ClassName</ID>
         <Default>ClassName</Default>
         <ToolTip>The name of the owner class.</ToolTip>
      </Literal>
   </Declarations>
</Snippet>
```

Wie Sie sehen, hat jedes Literal drei Felder: **ID** -- zur Identifikation der ersetzbaren Codeteile, **Default** -- der Standardwert des Literals beim Einfügen und **ToolTip** -- eine kurze Beschreibung, die beim MouseOver erscheint.

Mit den definierten Literals ersetzen wir nun die fest verdrahteten Namen und Typen im Code durch sie. Das geschieht mit **$ID$** anstelle des vordefinierten Werts (z. B. $PropertyName$, $PropertyType$, $ClassName$).

So sollte Ihr Code im Snippet nach dem Einbau der Literals aussehen:

```xml
<Code Language="CSharp">
   <![CDATA[// Defines a DependencyProperty named $PropertyName$ of type $PropertyType$ for the $ClassName$ class.
   public $PropertyType$ $PropertyName$
   {
      get { return ($PropertyType$)GetValue($PropertyName$Property); }
      set { SetValue($PropertyName$Property, value); }
   }
   public static readonly DependencyProperty $PropertyName$Property = DependencyProperty.Register("$PropertyName$", typeof($PropertyType$), typeof($ClassName$), new PropertyMetadata(On$PropertyName$PropertyChanged));
   private static void On$PropertyName$PropertyChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
   {
      $ClassName$ control = d as $ClassName$;
   }]]>
</Code>
```

Und hier der vollständige Code:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
      <Header>
         <Title>sldp</Title>
         <Description>Defines a dependency property to use in Silverlight.</Description>
         <Author>StartDebugging.net</Author>
         <Keywords>
            <Keyword>silverlight</Keyword>
            <Keyword>dependencyproperty</Keyword>
         </Keywords>
         <Shortcut>sldp</Shortcut>
         <HelpUrl>http://startdebugging.net</HelpUrl>
      </Header>
      <Snippet>
         <Declarations>
            <Literal>
               <ID>PropertyName</ID>
               <Default>PropertyName</Default>
               <ToolTip>The name of the dependency property.</ToolTip>
            </Literal>
            <Literal>
               <ID>PropertyType</ID>
               <Default>PropertyType</Default>
               <ToolTip>The type of the dependency property.</ToolTip>
            </Literal>
            <Literal>
               <ID>ClassName</ID>
               <Default>ClassName</Default>
               <ToolTip>The name of the owner class.</ToolTip>
            </Literal>
         </Declarations>
         <Code Language="CSharp">
            <![CDATA[// Defines a DependencyProperty named $PropertyName$ of type $PropertyType$ for the $ClassName$ class.
            public $PropertyType$ $PropertyName$
            {
               get { return ($PropertyType$)GetValue($PropertyName$Property); }
               set { SetValue($PropertyName$Property, value); }
            }
            public static readonly DependencyProperty $PropertyName$Property = DependencyProperty.Register("$PropertyName$", typeof($PropertyType$), typeof($ClassName$), new PropertyMetadata(On$PropertyName$PropertyChanged));
            private static void On$PropertyName$PropertyChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
            {
               $ClassName$ control = d as $ClassName$;
            }]]>
         </Code>
      </Snippet>
   </CodeSnippet>
</CodeSnippets>
```
