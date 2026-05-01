---
title: "React Native で2カラムの Flexbox レイアウトを作る方法"
description: "flex-wrap を使って React Native で2カラムの Flexbox レイアウトを作る方法を紹介します。カラム数や要素間の間隔も簡単に調整できます。"
pubDate: 2023-11-07
updatedDate: 2023-11-15
tags:
  - "react-native"
lang: "ja"
translationOf: "2023/11/2-column-react-native"
translatedBy: "claude"
translationDate: 2026-05-01
---
アイテムのリストから React Native で2カラムのレイアウトを作るのは、よくあるタスクです。この react native の2カラムレイアウトは、flex を使えばかなり簡単に実現できます。下の例は、要素間にスペースを設けた2カラムレイアウトの作り方を示しています。

これがビューです。

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

そしてこちらがスタイルです。

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

結果はこのようになります。

[![React Native の2カラム Flexbox レイアウト。](/wp-content/uploads/2023/11/image.png)](/wp-content/uploads/2023/11/image.png)

カラム数を調整したい場合は、`itemContainer` の `width` プロパティを変えるだけです。`50%` で2カラム、`33%` で3カラム、`25%` で4カラム、`20%` で5カラムというように設定できます。

[こちらでこのコードをライブで試せます](https://snack.expo.dev/GCz9-diFD)。
