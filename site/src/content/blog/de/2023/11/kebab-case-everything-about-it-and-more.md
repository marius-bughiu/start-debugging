---
title: "Kebab Case: alles dazu und noch mehr"
description: "Kebab Case ist eine Namenskonvention in der Programmierung, bei der Wörter in Variablen-, Funktions- oder Dateinamen durch Bindestriche ('-') getrennt werden. Sie ist auch unter den Namen 'kebab-case', 'hyphen-case' oder 'spinal-case' bekannt. Wenn Sie zum Beispiel eine Variable für den Vornamen einer Person haben, würden Sie sie in Kebab Case so schreiben: In Kebab Case sind alle..."
pubDate: 2023-11-03
updatedDate: 2023-11-17
tags:
  - "informational"
lang: "de"
translationOf: "2023/11/kebab-case-everything-about-it-and-more"
translatedBy: "claude"
translationDate: 2026-05-01
---
Kebab Case ist eine Namenskonvention in der Programmierung, bei der Wörter in Variablen-, Funktions- oder Dateinamen durch Bindestriche ('-') getrennt werden. Sie ist auch unter den Namen 'kebab-case', 'hyphen-case' oder 'spinal-case' bekannt.

Wenn Sie zum Beispiel eine Variable haben, die den Vornamen einer Person darstellt, würden Sie sie in Kebab Case so schreiben:

```
first-name
```

In Kebab Case sind alle Buchstaben kleingeschrieben und die Wörter werden mit Bindestrichen getrennt. Das macht den Code besser lesbar und stellt sicher, dass Namen keine Leerzeichen oder Sonderzeichen enthalten, die in bestimmten Programmiersprachen oder Dateisystemen Probleme verursachen könnten.

Kebab Case wird häufig in HTML und CSS für die Benennung von Eigenschaften, Klassen und Variablen verwendet.

## Eine kurze Geschichte

Der Begriff 'Kebab Case' als Namenskonvention für die Programmierung wurde Ende des 20. und Anfang des 21. Jahrhunderts populär, vor allem wegen seiner Bedeutung in der Webentwicklung.

In den frühen Tagen der Webentwicklung wurden in HTML und CSS verschiedene Namenskonventionen genutzt, etwa Underscores, Leerzeichen oder Camel Case. Das führte zu Inkonsistenzen zwischen verschiedenen Browsern. Diese Inkonsistenz machte deutlich, dass eine standardisiertere Art der Benennung von Elementen in Webdokumenten nötig war.

Die Einführung von Uniform Resource Identifiers (URIs) für Web-Ressourcen in den frühen 2000er Jahren betonte zusätzlich, wie wichtig eine konsistente Benennung ist. Leerzeichen oder Sonderzeichen in URLs konnten zu Encoding-Problemen führen und Links zerstören. Daher etablierte sich Kebab Case als bevorzugte Konvention für die Benennung von Ressourcen in URLs.

Im Laufe der 2010er Jahre setzte sich Kebab Case in der Webentwicklungs-Community für HTML-Attribute sowie für CSS-Klassen- und Variablennamen weitgehend durch. Es fand auch in andere Programmiersprachen und in Konventionen für Dateinamen Eingang, weil es für klare und konsistente Namen sorgt.

Auch wenn Kebab Case keine so lange Geschichte hat wie andere Namenskonventionen, haben seine Einfachheit, Konsistenz und Eignung für die Webentwicklung es in der heutigen Zeit zu einer beliebten Wahl gemacht. Wichtig ist: Namenskonventionen können sich zwischen Programmiersprachen und Communities unterscheiden, daher empfiehlt es sich, den im jeweiligen Projekt oder in der jeweiligen Sprache etablierten Konventionen zu folgen.

## Anwendungsbeispiele

Kebab Case wird in vielen modernen Programmierkontexten verwendet, vor allem in der Webentwicklung. Hier einige Beispiele:

### HTML und CSS

```html
<div class="user-profile">
```

In HTML und CSS wird Kebab Case oft für Klassennamen verwendet, um bestimmte Elemente zu stylen.

### URLs und Routing

```javascript
// Express.js route definition
app.get('/user-profile', (req, res) => {
  // Route handling logic
});
```

Kebab Case wird häufig zum Definieren von Routen in Web-Frameworks wie Express.js verwendet. Auch in URLs ist es verbreitet.

### Kommandozeilenoptionen

```bash
my-script --option-name value
```

In Kommandozeilen-Tools und Skripten wird Kebab Case manchmal für die Benennung von Optionen und Argumenten verwendet.

### Dateinamen (Webentwicklung)

```
header-styles.css
analytics-script.js
privacy-policy.html
```

In der Webentwicklung wird Kebab Case manchmal für Dateinamen verwendet, um die Konsistenz mit den HTML- und CSS-Konventionen zu wahren.

### Paketnamen (Node.js)

```
npm install my-package-name
```

In Node.js wird Kebab Case oft für Paketnamen verwendet, wenn Pakete über npm veröffentlicht oder installiert werden.

### Attributnamen in HTML und XML

```xml
<button data-toggle-modal="my-modal">Open Modal</button>
```

Kebab Case wird für benutzerdefinierte Datenattribute in HTML und XML verwendet, damit sie für Menschen besser lesbar sind und konsistent bleiben.

### CSS-Variablen

```css
--primary-color: #3498db;
```

Kebab Case wird häufig für die Benennung von CSS-Variablen verwendet, weil es die Lesbarkeit und Wartbarkeit verbessert.

### Frontend-Frameworks

```xml
<MyComponent prop-name="value" />
```

Einige Frontend-Frameworks und -Bibliotheken wie Angular und React empfehlen Kebab Case für die Benennung von Properties in JSX-Komponenten.

_Bearbeitet am 17.11.2023: Eine frühere Version dieses Artikels behauptete fälschlicherweise, dass kebab-case eine gültige Namenskonvention für Variablen und Funktionen in JavaScript und Python sei. Danke an @Art für den Hinweis auf den Fehler._
