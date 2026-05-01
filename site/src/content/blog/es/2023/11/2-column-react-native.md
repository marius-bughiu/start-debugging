---
title: "Cómo crear un layout Flexbox de 2 columnas en React Native"
description: "Aprende a crear un layout Flexbox de 2 columnas en React Native usando flex-wrap, con número de columnas y espaciado entre elementos ajustables."
pubDate: 2023-11-07
updatedDate: 2023-11-15
tags:
  - "react-native"
lang: "es"
translationOf: "2023/11/2-column-react-native"
translatedBy: "claude"
translationDate: 2026-05-01
---
Crear un layout de dos columnas en React Native, dada una lista de elementos, es una tarea bastante común. Este layout de 2 columnas en react native se puede lograr fácilmente usando flex. El ejemplo a continuación muestra cómo conseguir un layout de dos columnas con espaciado entre los elementos.

Esta es nuestra vista:

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

Y este es nuestro estilo:

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

El resultado se ve así:

[![Un layout flexbox de dos columnas en React Native.](/wp-content/uploads/2023/11/image.png)](/wp-content/uploads/2023/11/image.png)

Para ajustar la cantidad de columnas, simplemente cambia la propiedad `width` del `itemContainer`. `50%` dará como resultado 2 columnas, `33%` serán 3 columnas, `25%` serán 4 columnas, `20%` serán 5 columnas, y así sucesivamente.

Puedes [jugar con este código en vivo, aquí](https://snack.expo.dev/GCz9-diFD).
