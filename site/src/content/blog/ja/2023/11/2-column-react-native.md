---
title: "React Native で2列の Flexbox レイアウトを作る"
description: "数値の寸法と余白を使う、折り返し付き2列 React Native レイアウトの実行可能な Expo 例。px 文字列や calc() は使いません。"
pubDate: 2023-11-07
updatedDate: 2026-11-02
tags:
  - "react-native"
lang: "ja"
translationOf: "2023/11/2-column-react-native"
translatedBy: "claude"
translationDate: 2026-05-01
---
小規模な2列レイアウトには、`flexDirection: 'row'`、`flexWrap: 'wrap'`、各要素ラッパーの幅 `50%` を使えます。React Native は数値の寸法とパーセント文字列を受け付けますが、`'100px'` や `calc()` などの CSS 値をネイティブのレイアウトスタイルの代わりには使えません。

**2026年11月2日訂正:** 利用できなくなった Snack を完全な Expo プロジェクトで置き換えました。以前の `px` 文字列と `calc()` による高さを修正しています。復元したプロジェクトは Web にエクスポートして確認しましたが、Android/iOS 実機での実行は主張していません。

## 完全な例をダウンロード

[Expo ソース ZIP](/examples/react-native-two-columns.zip)には `App.js`、プロジェクト設定、固定した依存関係、npm lockfile が含まれます。Expo SDK 58.0.22 に対応する React/React Native の版を使っています。

```sh
npm ci
npm run web
```

静的な Web エクスポートには `npm run build`、SDK が対応する各プラットフォームの開発環境には `npm start` を使います。

## 折り返す行と余白

最後の不完全な行も確認できるよう、例では7項目を表示します。

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

対応するスタイルは次のとおりです。

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

padding は半分幅の各ラッパーの内側に入り、内側のカードが残りの高さを埋めます。CSS 式で padding を引く必要はありません。数値は React Native のレイアウト単位であり、CSS のピクセル文字列ではありません。

列数を変えるには幅の割合を変えます。4列なら `'25%'` です。大量のデータでは全項目を折り返し `View` に描画せず、[`numColumns` を指定した `FlatList`](https://reactnative.dev/docs/flatlist#numcolumns)などの仮想化リストを使ってください。

出典: [React Native の高さと幅](https://reactnative.dev/docs/height-and-width)、[Flexbox レイアウト](https://reactnative.dev/docs/flexbox)。
