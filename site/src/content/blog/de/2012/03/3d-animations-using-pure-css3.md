---
title: "3D-Animationen nur mit CSS3"
description: "Erfahren Sie, wie Sie mit reinem CSS3 (perspective und transform-Transitions) 3D-Animationen erstellen, mit browserübergreifender Unterstützung für WebKit und Firefox."
pubDate: 2012-03-04
updatedDate: 2023-11-05
tags:
  - "css"
lang: "de"
translationOf: "2012/03/3d-animations-using-pure-css3"
translatedBy: "claude"
translationDate: 2026-05-01
---
Was mich zu diesem und einigen weiteren Beiträgen inspiriert hat, war [diese Seite](http://demo.marcofolio.net/3d_animation_css3/ "CSS3 3D Animations") (funktioniert nur in Chrome und Safari). Es ist erstaunlich, was sich allein mit CSS umsetzen lässt. Schauen wir unter die Haube -- das CSS für diesen Effekt sieht so aus:

```css
#movieposters li { 
    display:inline; float:left;
    -webkit-perspective: 500; -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective; -webkit-transition-duration: 0.5s; 
}

#movieposters li:hover { 
    -webkit-perspective: 5000; 
}

#movieposters li img { 
    border:10px solid #fcfafa; 
    -webkit-transform: rotateY(30deg);
    -moz-box-shadow:0 3px 10px #888; 
    -webkit-box-shadow:0 3px 10px #888;
    -webkit-transition-property: transform; 
    -webkit-transition-duration: 0.5s; 
}

#movieposters li:hover img { 
    -webkit-transform: rotateY(0deg); 
}
```

Etwas unübersichtlich. Wenn wir die Borders und Shadows entfernen und den Code etwas aufräumen, sehen Sie, dass es eigentlich gar nicht so kompliziert ist.

```css
#movieposters li {
    display:inline; float:left;
    -webkit-perspective: 500;
    -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective;
    -webkit-transition-duration: 0.5s;
}

#movieposters li:hover {
    -webkit-perspective: 5000;
}

#movieposters li img {
    -webkit-transform: rotateY(30deg);
    -webkit-transition-property: transform;
    -webkit-transition-duration: 0.5s;
}

#movieposters li:hover img {
    -webkit-transform: rotateY(0deg);
}
```

Wie Sie sehen, passieren im Grunde zwei Übergänge:

-   ein Perspective-Übergang am List-Item, beim Hover von 500 auf 5000, mit einer Dauer von 0.5s
-   und ein Rotate-Transform-Übergang am Bild im List-Item, mit derselben Dauer, von 30 Grad auf 0 Grad

Sie können mit den Werten spielen und sehen, welche weiteren netten Effekte Sie erzielen. Vielleicht hinterlassen Sie einen Kommentar mit einem Link zu Ihrem Ergebnis.

## Damit es im Firefox funktioniert

Was mich wirklich neugierig gemacht hat, war, dass es im Firefox nicht funktioniert. Warum? Nach ein paar Suchen bei Google war die Antwort klar: -webkit--Befehle sind für WebKit-basierte Browser gedacht, während Firefox Befehle mit dem -moz--Präfix erwartet. Das hätte ich eigentlich wissen müssen ...

Also habe ich für jeden Befehl eine neue Zeile hinzugefügt und -webkit- durch -moz- ersetzt, in der Annahme, dass es funktioniert. Tat es auch -- bis auf die fehlende Animation. Einige Suchen später immer noch keine Antwort, also habe ich im wahren Entwickler-Stil stackoverflow.com aufgerufen und meine Frage gestellt. Ein paar Stunden später hatte ich die erste Antwort und glücklicherweise auch die Lösung meines Problems ([hier nachlesen](http://stackoverflow.com/questions/9549624/moz-transition-duration-not-working "Firefox Transitions not working")). Die transition-property musste ebenfalls eine -moz--Eigenschaft sein. Einfache Eigenschaften wie transform oder perspective funktionieren nicht so wie in WebKit, daher musste ich stattdessen -moz-transform und -moz-perspective verwenden.

Hier der vollständige CSS-Code, den ich am Ende verwendet habe:

```css
#movieposters li {
    display:inline; float:left;
    -webkit-perspective: 500;
    -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective;
    -webkit-transition-duration: 0.5s;
    -moz-transition-duration: 0.5s;
    -moz-perspective: 500;
    -moz-transform-style: preserve-3d;
    -moz-transition-property: -moz-perspective;
}

#movieposters li:hover {
    -webkit-perspective: 5000;
    -moz-perspective: 5000;
}

#movieposters li img {
    -webkit-transform: rotateY(30deg);
    -webkit-transition-property: transform;
    -webkit-transition-duration: 0.5s;
    -moz-transition-duration: 0.5s;
    -moz-transform: rotateY(30deg);
    -moz-transition-property: -moz-transform;
    width: 210px;
}

#movieposters li:hover img {
    -webkit-transform: rotateY(0deg);
    -moz-transform: rotateY(0deg);
}
```

Eine Demo finden Sie hier: [3D CSS Animation](http://startdebugging.net/demos/3dcssanimation.html "3D CSS Animation")
