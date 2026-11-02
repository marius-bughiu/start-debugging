---
title: "How to create a 2 column Flexbox layout in React Native"
description: "A runnable Expo example of a wrapped two-column React Native layout using numeric dimensions and spacing, without CSS px strings or calc()."
pubDate: 2023-11-07
updatedDate: 2026-11-02
tags:
  - "react-native"
---
A small two-column layout can use `flexDirection: 'row'`, `flexWrap: 'wrap'` and a `50%` width on each item wrapper. React Native accepts numeric layout dimensions and percentage strings; CSS values such as `'100px'` and `calc()` are not valid substitutes in native layout styles.

**Correction — November 2, 2026:** The missing Snack has been replaced with a complete Expo project. The original `px` strings and `calc()` height were corrected. The restored project was exported and checked on the web; no Android/iOS device run is claimed.

## Download the complete example

[Download the Expo source ZIP](/examples/react-native-two-columns.zip). It includes `App.js`, project settings, pinned dependencies and an npm lockfile, using Expo SDK 58.0.22's compatible React/React Native versions.

```sh
npm ci
npm run web
```

Use `npm run build` for a static web export, or `npm start` for the platform development environment supported by the SDK.

## Wrapped rows and spacing

The example renders seven items so the incomplete final row is visible:

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

The relevant styles are:

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

The padding belongs inside each half-width wrapper, and the inner card fills the remaining height. There is no need to subtract padding with a CSS expression. Numeric dimensions use React Native layout units, not literal CSS pixel strings.

To change the column count, change the percentage width, such as `'25%'` for four columns. For large data sets use a virtualized list such as [`FlatList` with `numColumns`](https://reactnative.dev/docs/flatlist#numcolumns), rather than rendering every item in a wrapped `View`.

Sources: [React Native height and width](https://reactnative.dev/docs/height-and-width), [Flexbox layout](https://reactnative.dev/docs/flexbox).
