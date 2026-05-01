---
title: "get_category_link gerando URL incorreta com /blog/"
description: "Solução para o get_category_link do WordPress que gera URLs incorretas com /blog/ no caminho, causando 404 nas páginas de categoria."
pubDate: 2020-04-04
updatedDate: 2023-11-05
tags:
  - "wordpress"
lang: "pt-br"
translationOf: "2020/04/get_category_link-generating-incorrect-url-including-blog"
translatedBy: "claude"
translationDate: 2026-05-01
---
Recentemente rodei uma ferramenta de auditoria SEO no blog e descobri que todos os links de categoria estavam levando a 404. Olhando com mais atenção, as URLs pareciam conter um /blog/, enquanto as URLs que realmente funcionam vão sem ele. Veja abaixo:

`https://startdebugging.net/blog/category/opinion/` -- não funciona
`https://startdebugging.net/category/opinion/` -- funciona

Aparentemente, todo o problema vinha do fato de eu estar usando um formato de permalink personalizado para os posts que usava /blog/ como base, e isso estava sendo aplicado também às URLs de categoria.

## Como resolver?

Certifique-se de definir um "Category base" nas configurações de permalink (Settings > Permalink); no meu caso, eu apenas defini como "category".

![Wordpress, Settings > Permalinks > Category base](/wp-content/uploads/2020/04/image-1.png)
