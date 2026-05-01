---
title: "Kebab case: tudo sobre ele e um pouco mais"
description: "Kebab case é uma convenção de nomenclatura usada em programação para formatar nomes de variáveis, funções ou arquivos separando as palavras com hifens ('-'). Também é conhecida como 'kebab-case', 'hyphen-case' ou 'spinal-case'. Por exemplo, se você tem uma variável que representa o primeiro nome de uma pessoa, em kebab case você escreveria: Em kebab case, todas..."
pubDate: 2023-11-03
updatedDate: 2023-11-17
tags:
  - "informational"
lang: "pt-br"
translationOf: "2023/11/kebab-case-everything-about-it-and-more"
translatedBy: "claude"
translationDate: 2026-05-01
---
Kebab case é uma convenção de nomenclatura usada em programação para formatar nomes de variáveis, funções ou arquivos separando as palavras com hifens ('-'). Também é conhecida como 'kebab-case', 'hyphen-case' ou 'spinal-case'.

Por exemplo, se você tem uma variável que representa o primeiro nome de uma pessoa, em kebab case você escreveria:

```
first-name
```

Em kebab case, todas as letras ficam em minúsculas e as palavras são separadas por hifens, o que torna o código mais legível e garante que os nomes não tenham espaços ou caracteres especiais que possam causar problemas em determinadas linguagens de programação ou sistemas de arquivos.

Kebab case é comumente usado em HTML e CSS para nomear propriedades, classes e variáveis.

## Um breve histórico

O termo 'kebab case' como convenção de nomenclatura na programação ganhou popularidade no final do século XX e início do século XXI, principalmente por sua relevância no desenvolvimento web.

Nos primeiros dias do desenvolvimento web, HTML e CSS usavam várias convenções de nomenclatura, como underscores, espaços ou camel case, o que gerava inconsistências entre os diferentes navegadores. Essa inconsistência criou a necessidade de uma forma mais padronizada de nomear elementos em documentos web.

A adoção dos Identificadores Uniformes de Recursos (URIs) para recursos web no início dos anos 2000 reforçou ainda mais a importância de uma nomenclatura consistente. Ter espaços ou caracteres especiais em URLs podia causar problemas de codificação e quebrar links. Como resultado, kebab case acabou se tornando a convenção preferida para nomear recursos em URLs.

Ao longo dos anos 2010, kebab case foi amplamente adotado pela comunidade de desenvolvimento web para atributos HTML, nomes de classes e nomes de variáveis em CSS. Também foi parar em outras linguagens de programação e em convenções de nomenclatura de arquivos como uma forma de criar nomes claros e consistentes.

Embora kebab case possa não ter uma história tão longa quanto outras convenções de nomenclatura, sua simplicidade, consistência e adequação ao desenvolvimento web fizeram dela uma escolha popular nos dias atuais. Vale lembrar que convenções de nomenclatura podem variar entre linguagens de programação e comunidades, então é recomendado seguir as convenções estabelecidas no projeto ou linguagem específicos em que você estiver trabalhando.

## Exemplos de uso

Kebab case é comumente usado em vários contextos modernos de programação, especialmente em desenvolvimento web. Veja alguns exemplos de uso:

### HTML e CSS

```html
<div class="user-profile">
```

Em HTML e CSS, kebab case é frequentemente usado para nomes de classe para estilizar elementos específicos.

### URLs e roteamento

```javascript
// Express.js route definition
app.get('/user-profile', (req, res) => {
  // Route handling logic
});
```

Kebab case é frequentemente usado para definir rotas em frameworks web como Express.js. Também é comum em URLs.

### Opções de linha de comando

```bash
my-script --option-name value
```

Em ferramentas e scripts de linha de comando, kebab case é às vezes usado para nomear opções e argumentos.

### Nomes de arquivo (desenvolvimento web)

```
header-styles.css
analytics-script.js
privacy-policy.html
```

Kebab case é às vezes usado para nomear arquivos em desenvolvimento web, mantendo consistência com as convenções de HTML e CSS.

### Nomes de pacotes (Node.js)

```
npm install my-package-name
```

No Node.js, kebab case é frequentemente usado para nomes de pacotes na hora de publicar ou instalar pacotes via npm.

### Nomes de atributos em HTML e XML

```xml
<button data-toggle-modal="my-modal">Open Modal</button>
```

Kebab case é usado em atributos de dados personalizados em HTML e XML, deixando-os mais legíveis para humanos e mantendo a consistência.

### Variáveis CSS

```css
--primary-color: #3498db;
```

Kebab case é comumente usado para nomear variáveis CSS, melhorando a legibilidade e a facilidade de manutenção.

### Frameworks front-end

```xml
<MyComponent prop-name="value" />
```

Alguns frameworks e bibliotecas front-end, como Angular e React, incentivam o uso de kebab case para nomear propriedades em componentes JSX.

_Editado em 17/11/2023: uma versão anterior deste artigo afirmava incorretamente que kebab-case é uma convenção de nomenclatura válida para variáveis e funções em JavaScript e Python. Obrigado @Art por apontar o erro._
