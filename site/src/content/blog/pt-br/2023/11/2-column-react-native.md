---
title: "Como criar um layout Flexbox de duas colunas no React Native"
description: "Exemplo Expo executável de layout React Native de duas colunas com quebra de linha, dimensões numéricas e espaçamento, sem strings px ou calc()."
pubDate: 2023-11-07
updatedDate: 2026-11-02
tags:
  - "react-native"
lang: "pt-br"
translationOf: "2023/11/2-column-react-native"
translatedBy: "claude"
translationDate: 2026-05-01
---
Um layout pequeno de duas colunas pode usar `flexDirection: 'row'`, `flexWrap: 'wrap'` e largura `50%` no wrapper de cada item. React Native aceita dimensões numéricas e strings percentuais; valores CSS como `'100px'` e `calc()` não são substitutos válidos em estilos de layout nativo.

**Correção — 2 de novembro de 2026:** o Snack ausente foi substituído por um projeto Expo completo. As strings `px` e a altura com `calc()` foram corrigidas. O projeto restaurado foi exportado e verificado na web; não se afirma execução em dispositivo Android/iOS.

## Baixar o exemplo completo

[Baixe o código Expo em ZIP](/examples/react-native-two-columns.zip). Inclui `App.js`, configurações do projeto, dependências fixadas e lockfile npm, com versões de React/React Native compatíveis com Expo SDK 58.0.22.

```sh
npm ci
npm run web
```

Use `npm run build` para exportação web estática ou `npm start` para o ambiente de desenvolvimento de plataforma suportado pelo SDK.

## Linhas com quebra e espaçamento

O exemplo renderiza sete itens para deixar a última linha incompleta visível:

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

Os estilos relevantes são:

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

O padding fica dentro de cada wrapper de meia largura, e o cartão interno preenche a altura restante. Não é necessário subtrair padding com uma expressão CSS. Dimensões numéricas usam unidades de layout do React Native, não strings literais de pixels CSS.

Para mudar o número de colunas, altere a porcentagem, como `'25%'` para quatro colunas. Para conjuntos grandes, use uma lista virtualizada como [`FlatList` com `numColumns`](https://reactnative.dev/docs/flatlist#numcolumns), em vez de renderizar tudo em um `View` com wrap.

Fontes: [altura e largura no React Native](https://reactnative.dev/docs/height-and-width), [layout Flexbox](https://reactnative.dev/docs/flexbox).
