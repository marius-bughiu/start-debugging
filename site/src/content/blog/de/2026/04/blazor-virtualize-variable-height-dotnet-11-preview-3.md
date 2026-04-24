---
title: "Blazor Virtualize handhabt endlich variable Item-Höhen in .NET 11"
description: "ASP.NET Core in .NET 11 Preview 3 bringt der Virtualize-Komponente bei, Items zur Laufzeit zu messen, und behebt das Spacing- und Scroll-Jitter, das durch Annahmen uniformer Höhen entstand."
pubDate: 2026-04-16
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "virtualize"
lang: "de"
translationOf: "2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

Wer [`Virtualize<TItem>`](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/virtualization) für ein Chat Log, einen Feed von Cards oder ein Benachrichtigungs-Panel verwendet hat, hat denselben Bug gesehen: Items zittern beim Scrollen, der Scrollbar-Thumb springt herum, und man endet mit unbeholfenen Lücken oder Überlappungen. Die Ursache war immer dieselbe. `Virtualize` nahm an, dass jede Row gleich hoch war, und nutzte diese eine Zahl, um das Scroll-Fenster zu berechnen. [.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md) behebt das endlich: Die Komponente misst Items jetzt zur Laufzeit und passt den virtuellen Viewport an die Höhen an, die tatsächlich im DOM landen.

## Warum das alte Verhalten echte UIs brach

Die ursprüngliche API zwang Sie, über `ItemSize` einen Skalar zu wählen. Wenn Ihre Items 48px hoch waren, setzten Sie 48. Blazor multiplizierte dann Item-Count mal 48, um den scrollbaren Bereich zu dimensionieren, und renderte nur die Rows, deren berechnete Top-Position den Viewport schnitt. Sobald Ihre Rows einen Body variabler Länge, ein umbrechendes Zitat oder ein responsives Bild enthielten, stimmte die Mathematik nicht mehr mit der Realität überein, und Browser und Blazor kämpften um die Platzierung.

```razor
<Virtualize Items="messages" Context="message">
    <article class="message-card">
        <h4>@message.Author</h4>
        <p>@message.Text</p>
    </article>
</Virtualize>
```

Genau dieses Snippet ist das Szenario, das früher fehlschlug. Ein kurzer Einzeiler und eine Fünf-Absatz-Antwort teilen denselben Row-Slot, also driften Scroll-Offsets, während Sie sich durch die Liste bewegen.

## Den gerenderten DOM messen

In .NET 11 Preview 3 trackt `Virtualize` jetzt gemessene Item-Dimensionen zur Laufzeit und speist sie zurück in seine Spacer-Berechnungen. Sie müssen `ItemSize` nicht mehr auf einen Wert setzen, der dem Worst Case entspricht, und Sie müssen `overflow: hidden` nicht mehr auf Kindern setzen, um sie in eine feste Box zu zwingen. Die Komponente akzeptiert immer noch einen initialen Size-Hint, behandelt ihn aber als Startschätzung statt als absolute Wahrheit.

Die zweite Änderung ist der `OverscanCount`-Default. `Virtualize` renderte früher drei Items oberhalb und unterhalb des Viewports. In Preview 3 springt dieser Default auf 15, damit genug gemessene Items die Höhenschätzung stabilisieren, bevor der Nutzer in ungemessenes Territorium scrollt.

```razor
<Virtualize Items="messages" Context="message" OverscanCount="30">
    <article class="message-card">
        <h4>@message.Author</h4>
        <p>@message.Text</p>
    </article>
</Virtualize>
```

`OverscanCount` höher zu drehen ist jetzt ein legitimer Tuning-Knopf für Feeds mit wild unterschiedlichen Item-Höhen. Die Kosten sind, mehr Off-Screen-DOM zu rendern, aber im Austausch bekommen Sie sanfteres Scrollen und einen stabilen Scrollbar.

## QuickGrid behält den alten Default

Wenn Sie `QuickGrid` verwenden, ändert sich nichts. Die Komponente fixiert ihren eigenen `OverscanCount` auf 3, weil Grid-Rows absichtlich uniform sind und 30 versteckte Rows pro Scroll-Tick zu rendern die Performance für Tabellen mit Hunderten Spalten verbrennen würde. Das ist bewusst: Die neuen Defaults zielen auf die Komponenten, bei denen die alte Annahme tatsächlich falsch war.

## Was in bestehenden Apps zu ändern ist

Werfen Sie den `ItemSize`-Wert weg, wenn Sie ihn nur gesetzt haben, um variable Höhen zu kaschieren, da der gemessene Pfad dort streng besser ist. Auditieren Sie jedes CSS, das Sie hinzugefügt haben, um Kinder in eine feste Box zu zwingen. Und profilieren Sie Scrolling, bevor Sie `OverscanCount` weiter hochdrehen, denn 15 ist bereits ein großer Sprung von 3.

Die Implementierung lebt in [dotnet/aspnetcore#64964](https://github.com/dotnet/aspnetcore/pull/64964). Holen Sie sich [.NET 11 Preview 3](https://dotnet.microsoft.com/download/dotnet/11.0), und beim nächsten Mal, wenn jemand fragt, warum das Chat-Log seltsam scrollt, haben Sie einen Workaround weniger zu erklären.
