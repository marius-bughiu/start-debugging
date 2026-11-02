---
title: "Как создать двухколоночную Flexbox-раскладку в React Native"
description: "Исполняемый Expo-пример двух колонок React Native с переносом строк, числовыми размерами и отступами без строк px и calc()."
pubDate: 2023-11-07
updatedDate: 2026-11-02
tags:
  - "react-native"
lang: "ru"
translationOf: "2023/11/2-column-react-native"
translatedBy: "claude"
translationDate: 2026-05-01
---
Для небольшой раскладки в две колонки подойдут `flexDirection: 'row'`, `flexWrap: 'wrap'` и ширина `50%` у обёртки каждого элемента. React Native принимает числовые размеры и процентные строки; CSS-значения вроде `'100px'` и `calc()` не являются допустимой заменой в нативных стилях layout.

**Исправление — 2 ноября 2026 года:** недоступный Snack заменён полным Expo-проектом. Исправлены строки `px` и высота через `calc()`. Восстановленный проект экспортирован и проверен в вебе; запуск на Android/iOS-устройстве не заявляется.

## Скачать полный пример

[ZIP с исходниками Expo](/examples/react-native-two-columns.zip) включает `App.js`, настройки, закреплённые зависимости и npm lockfile с версиями React/React Native, совместимыми с Expo SDK 58.0.22.

```sh
npm ci
npm run web
```

`npm run build` выполняет статический веб-экспорт, а `npm start` запускает поддерживаемое SDK окружение разработки для платформ.

## Перенос строк и отступы

Пример отображает семь элементов, чтобы была видна неполная последняя строка:

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

Соответствующие стили:

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

Padding находится внутри каждой обёртки половинной ширины, а внутренняя карточка занимает оставшуюся высоту. Вычитать padding CSS-выражением не нужно. Числа задают единицы layout React Native, а не буквальные строки CSS-пикселей.

Чтобы изменить число колонок, поменяйте процент ширины, например на `'25%'` для четырёх. Для больших наборов данных используйте виртуализированный список вроде [`FlatList` с `numColumns`](https://reactnative.dev/docs/flatlist#numcolumns), а не вывод всех элементов в переносящемся `View`.

Источники: [высота и ширина React Native](https://reactnative.dev/docs/height-and-width), [Flexbox layout](https://reactnative.dev/docs/flexbox).
