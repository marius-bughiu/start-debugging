---
title: "Wie Sie ein zweispaltiges Flexbox-Layout in React Native erstellen"
description: "Erfahren Sie, wie Sie mit flex-wrap ein zweispaltiges Flexbox-Layout in React Native bauen, mit anpassbarer Spaltenanzahl und Abständen zwischen den Elementen."
pubDate: 2023-11-07
updatedDate: 2023-11-15
tags:
  - "react-native"
lang: "de"
translationOf: "2023/11/2-column-react-native"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ein zweispaltiges Layout in React Native für eine Liste von Elementen zu erstellen, ist eine recht häufige Aufgabe. Dieses zweispaltige Layout in react native lässt sich mit flex sehr leicht umsetzen. Das folgende Beispiel zeigt, wie Sie das zweispaltige Layout mit Abständen zwischen den Elementen erreichen.

Das ist unsere View:

```jsx
<View style={styles.container}>
    <View style={styles.itemContainer}><View style={styles.item}><Text>{'item1'}</Text></View></View>
    <View style={styles.itemContainer}><View style={styles.item}><Text>{'item2'}</Text></View></View>
    <View style={styles.itemContainer}><View style={styles.item}><Text>{'item3'}</Text></View></View>
    <View style={styles.itemContainer}><View style={styles.item}><Text>{'item4'}</Text></View></View>
    <View style={styles.itemContainer}><View style={styles.item}><Text>{'item5'}</Text></View></View>
    <View style={styles.itemContainer}><View style={styles.item}><Text>{'item6'}</Text></View></View>
    <View style={styles.itemContainer}><View style={styles.item}><Text>{'item7'}</Text></View></View>

</View>
```

Und das ist unser Style:

```typescript
const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-start'
  },
  itemContainer: {
    width: '50%', // 50% -> 2 columns | 33% -> 3 columns | 25% -> 4 columns
    height: '100px'
  },
  item: {
    padding: '8px',
    margin: '8px',
    backgroundColor: '#EEEEEE',
    height: "calc(100% - 8px)"
  }
})
```

Das Ergebnis sieht so aus:

[![Ein zweispaltiges Flexbox-Layout in React Native.](/wp-content/uploads/2023/11/image.png)](/wp-content/uploads/2023/11/image.png)

Um die Anzahl der Spalten anzupassen, ändern Sie einfach die Eigenschaft `width` des `itemContainer`. `50%` ergibt 2 Spalten, `33%` ergibt 3 Spalten, `25%` ergibt 4 Spalten, `20%` ergibt 5 Spalten und so weiter.

Sie können [hier live mit diesem Code experimentieren](https://snack.expo.dev/GCz9-diFD).
