---
title: "Ein zweispaltiges Flexbox-Layout in React Native erstellen"
description: "Lauffähiges Expo-Beispiel für ein umbrechendes zweispaltiges React-Native-Layout mit numerischen Abmessungen und Abständen statt px-Strings oder calc()."
pubDate: 2023-11-07
updatedDate: 2026-11-02
tags:
  - "react-native"
lang: "de"
translationOf: "2023/11/2-column-react-native"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ein kleines zweispaltiges Layout lässt sich mit `flexDirection: 'row'`, `flexWrap: 'wrap'` und `50%` Breite je Element-Wrapper erstellen. React Native akzeptiert numerische Layoutmaße und Prozent-Strings; CSS-Werte wie `'100px'` und `calc()` sind kein gültiger Ersatz in nativen Layout-Styles.

**Korrektur — 2. November 2026:** Der nicht mehr verfügbare Snack wurde durch ein vollständiges Expo-Projekt ersetzt. Die ursprünglichen `px`-Strings und die `calc()`-Höhe sind korrigiert. Das Projekt wurde für das Web exportiert und dort geprüft; ein Android-/iOS-Gerätetest wird nicht behauptet.

## Vollständiges Beispiel herunterladen

[Expo-Quellcode als ZIP herunterladen](/examples/react-native-two-columns.zip). Enthalten sind `App.js`, Projekteinstellungen, festgelegte Abhängigkeiten und eine npm-Lockdatei mit den zu Expo SDK 58.0.22 passenden React-/React-Native-Versionen.

```sh
npm ci
npm run web
```

`npm run build` erstellt einen statischen Webexport; `npm start` startet die von diesem SDK unterstützte Plattformentwicklungsumgebung.

## Umbruch und Abstände

Das Beispiel zeigt sieben Elemente, damit die unvollständige letzte Zeile sichtbar ist:

```jsx
<View style={styles.container}>
  {items.map((label) => (
    <View key={label} style={styles.itemContainer}>
      <View style={styles.item}>
        <Text>{label}</Text>
      </View>
    </View>
  ))}
</View>
```

Die relevanten Styles sind:

```javascript
const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-start',
  },
  itemContainer: {
    width: '50%',
    height: 100,
    padding: 8,
  },
  item: {
    flex: 1,
    padding: 8,
    backgroundColor: '#dde8f6',
  },
});
```

Das Padding liegt innerhalb jedes Wrappers mit halber Breite; die innere Karte füllt die verbleibende Höhe. Padding muss nicht per CSS-Ausdruck abgezogen werden. Numerische Maße sind React-Native-Layouteinheiten, keine wörtlichen CSS-Pixel-Strings.

Für eine andere Spaltenzahl ändere die Prozentbreite, etwa auf `'25%'` für vier Spalten. Große Datenmengen gehören in eine virtualisierte Liste wie [`FlatList` mit `numColumns`](https://reactnative.dev/docs/flatlist#numcolumns), statt alle Elemente in einem umbrechenden `View` zu rendern.

Quellen: [Höhe und Breite in React Native](https://reactnative.dev/docs/height-and-width), [Flexbox-Layout](https://reactnative.dev/docs/flexbox).
