---
title: "Cómo crear un diseño Flexbox de dos columnas en React Native"
description: "Ejemplo Expo ejecutable de un diseño React Native de dos columnas con ajuste de línea, dimensiones numéricas y espaciado, sin px ni calc()."
pubDate: 2023-11-07
updatedDate: 2026-11-02
tags:
  - "react-native"
lang: "es"
translationOf: "2023/11/2-column-react-native"
translatedBy: "claude"
translationDate: 2026-05-01
---
Un diseño pequeño de dos columnas puede usar `flexDirection: 'row'`, `flexWrap: 'wrap'` y anchura `50%` en el contenedor de cada elemento. React Native acepta dimensiones numéricas y cadenas porcentuales; valores CSS como `'100px'` y `calc()` no son sustitutos válidos en estilos nativos de layout.

**Corrección — 2 de noviembre de 2026:** el Snack desaparecido se sustituyó por un proyecto Expo completo. Se corrigieron las cadenas `px` y la altura con `calc()`. El proyecto restaurado se exportó y comprobó en web; no se afirma una ejecución en dispositivo Android/iOS.

## Descargar el ejemplo completo

[Descarga el código Expo en ZIP](/examples/react-native-two-columns.zip). Incluye `App.js`, configuración del proyecto, dependencias fijadas y lockfile npm, con las versiones React/React Native compatibles con Expo SDK 58.0.22.

```sh
npm ci
npm run web
```

Usa `npm run build` para una exportación web estática o `npm start` para el entorno de desarrollo de plataforma admitido por el SDK.

## Filas con ajuste y espaciado

El ejemplo muestra siete elementos para hacer visible la última fila incompleta:

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

Los estilos relevantes son:

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

El padding queda dentro de cada contenedor de media anchura, y la tarjeta interior llena la altura restante. No es necesario restarlo con una expresión CSS. Las dimensiones numéricas usan unidades de layout de React Native, no cadenas literales de píxeles CSS.

Para cambiar el número de columnas, modifica el porcentaje, por ejemplo `'25%'` para cuatro. Para conjuntos grandes usa una lista virtualizada como [`FlatList` con `numColumns`](https://reactnative.dev/docs/flatlist#numcolumns), en vez de renderizar todos los elementos en un `View` con wrap.

Fuentes: [altura y anchura en React Native](https://reactnative.dev/docs/height-and-width), [diseño Flexbox](https://reactnative.dev/docs/flexbox).
