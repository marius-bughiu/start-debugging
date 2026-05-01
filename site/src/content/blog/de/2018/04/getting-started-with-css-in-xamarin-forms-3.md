---
title: "Erste Schritte mit CSS in Xamarin Forms 3"
description: "Erfahren Sie, wie Sie Cascading StyleSheets (CSS) in Xamarin Forms 3 einsetzen, einschließlich inline CDATA-Styles und eingebetteter CSS-Dateien."
pubDate: 2018-04-18
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2018/04/getting-started-with-css-in-xamarin-forms-3"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mit dieser neuen Version von Xamarin Forms kommen einige Neuerungen, und eine davon sind Cascading StyleSheets (CSS). Genau, CSS in XAML. Wie nützlich es wird und wie stark es sich durchsetzt, ist noch nicht klar -- es fehlen noch etliche Funktionen --, aber für alle, die aus der Webentwicklung kommen, dürfte es eine willkommene Ergänzung sein.

Direkt zur Sache: Es gibt zwei Wege, CSS in Ihre Anwendung einzubinden:

-   Erstens, indem Sie die Styles direkt in die Resources eines Elements legen und in einen CDATA-Tag wickeln
-   Und zweitens über echte .css-Dateien, die als Embedded Resource in Ihr Projekt aufgenommen werden

Ist das CSS eingebunden, verwenden Sie es, indem Sie an Ihrem XAML-Element entweder die Eigenschaft **StyleClass** oder die Kurzform **class** angeben.

Zur Veranschaulichung nehmen wir einige Änderungen an einem neuen Xamarin-Forms-Projekt vor, das die Master-Detail-Vorlage nutzt. Also los: File > New project und dann auf Xamarin Forms 3 aktualisieren.

Zuerst der CDATA-Weg. Sagen wir, wir wollen die Elemente unserer Liste orange machen. Gehen Sie in die ItemsPage, und im XAML, oberhalb des `<ContentPage.ToolbarItems>`-Tags, fügen Sie das ein:

```xml
<ContentPage.Resources>
    <StyleSheet>
        <![CDATA[

            .my-list-item {
                padding: 20;
                background-color: orange;
                color: white;
            }

        ]]>
    </StyleSheet>
</ContentPage.Resources>
```

Nun müssen wir die neue Klasse .my-list-item verwenden. Suchen Sie das ItemTemplate Ihrer ListView und beachten Sie das StackLayout darin -- das ist unser Ziel. Entfernen Sie das Padding und wenden Sie unsere Klasse so an:

```xml
<StackLayout Padding="10" class="my-list-item">
```

Und das war's.

Schauen wir uns jetzt den zweiten Weg an, mit eingebetteten CSS-Dateien. Erstellen Sie zunächst in Ihrer App einen neuen Ordner namens Styles und darin eine neue Datei namens about.css (in diesem Teil stylen wir die About-Seite). Nach dem Anlegen der Datei klicken Sie sie mit Rechtsklick > Properties an und setzen die **Build action** auf **Embedded resource**; sonst funktioniert es nicht.

In unserer View -- AboutPage.xaml -- fügen Sie nun direkt über dem Element <ContentPage.BindingContext> Folgendes ein. Damit referenzieren wir unsere CSS-Datei in der Page. Dass der Pfad mit einem "/" beginnt, bedeutet, dass er von der Wurzel ausgeht. Sie können auch relative Pfade angeben, indem Sie den führenden Schrägstrich weglassen.

```xml
<ContentPage.Resources>
   <StyleSheet Source="/Styles/about.css" />
</ContentPage.Resources>
```

Was unser CSS angeht: Nehmen wir kleine Änderungen am App-Titel und am Learn-More-Button vor:

```css
.app-name {
    font-size: 48;
    color: orange;
}

.learn-more {
    border-color: orange;
    border-width: 1;
}
```

Achten Sie darauf: font-size und border-width sind einfache (double-)Werte; geben Sie kein "px" an, das funktioniert nicht und führt zu einem Fehler. Vermutlich werden die Werte in DIP (device independent pixels) interpretiert. Dasselbe gilt für andere Eigenschaften wie thickness, margin, padding usw.

Alles sieht hübsch aus, aber bedenken Sie, dass es Einschränkungen gibt:

-   Nicht alle Selektoren werden in dieser Version unterstützt. Die \[attribute\]-Selektoren, die @media- und @supports-Selektoren oder die :- und ::-Selektoren funktionieren noch nicht. Auch das Ansprechen eines Elements mit zwei Klassen wie .class1.class2 funktioniert nach meinen Tests nicht.
-   Nicht alle Eigenschaften werden unterstützt, und vor allem funktionieren nicht alle unterstützten Eigenschaften an allen Elementen. Beispielsweise wird text-align nur für Entry, EntryCell, Label und SearchBar unterstützt, sodass Sie den Text eines Buttons nicht linksbündig ausrichten können. Oder die Eigenschaft border-width: Diese funktioniert nur bei Buttons.
-   Vererbung wird nicht unterstützt

Eine vollständige Übersicht über das, was unterstützt wird und was nicht, finden Sie [im Pull Request zu diesem Feature auf GitHub](https://github.com/xamarin/Xamarin.Forms/pull/1207). Falls etwas schiefgeht oder nicht klappt: Das ursprüngliche Beispiel-Repository ist nicht mehr auf GitHub verfügbar, aber die obigen Snippets reichen für den Einstieg.
