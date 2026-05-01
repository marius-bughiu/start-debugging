---
title: "Como criar um layout Flexbox de 2 colunas no React Native"
description: "Aprenda a criar um layout Flexbox de 2 colunas no React Native usando flex-wrap, com número de colunas e espaçamento entre elementos ajustáveis."
pubDate: 2023-11-07
updatedDate: 2023-11-15
tags:
  - "react-native"
lang: "pt-br"
translationOf: "2023/11/2-column-react-native"
translatedBy: "claude"
translationDate: 2026-05-01
---
Criar um layout de duas colunas no React Native, dada uma lista de itens, é uma tarefa bastante comum. Esse layout de 2 colunas em react native pode ser obtido com facilidade usando flex. O exemplo abaixo mostra como conseguir o layout de duas colunas com espaçamento entre os elementos.

Esta é a nossa view:

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

E este é o nosso estilo:

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

O resultado fica assim:

[![Um layout flexbox de duas colunas no React Native.](/wp-content/uploads/2023/11/image.png)](/wp-content/uploads/2023/11/image.png)

Para ajustar o número de colunas, basta alterar a propriedade `width` do `itemContainer`. `50%` resulta em 2 colunas, `33%` em 3 colunas, `25%` em 4 colunas, `20%` em 5 colunas e assim por diante.

Você pode [brincar com esse código ao vivo, aqui](https://snack.expo.dev/GCz9-diFD).
