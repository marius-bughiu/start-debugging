# React Native two-column layout

Pinned to Expo SDK 58.0.22, React 19.3.0, React Native 0.88.1 and React Native Web 0.21.4, following Expo's published bundled-module manifest. Use a Node.js version supported by that Expo SDK.

```sh
npm ci
npm run web
```

For a static web export:

```sh
npm run build
```

For Android/iOS development use `npm start` and the development environment supported by this Expo SDK. A successful web export is not a native-device test.

`width: '50%'` applies to each outer wrapper. Numeric `height: 100` and `padding: 8` use React Native layout units. The inner card uses `flex: 1`; it needs neither CSS `px` strings nor `calc()`. Seven items intentionally leave a single final card, making wrapping easy to inspect. Use `FlatList` with `numColumns` for a large, scrolling data set.

Sources: [React Native dimensions](https://reactnative.dev/docs/height-and-width), [Flexbox](https://reactnative.dev/docs/flexbox).
