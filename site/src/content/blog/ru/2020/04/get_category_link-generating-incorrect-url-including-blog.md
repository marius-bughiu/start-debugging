---
title: "get_category_link генерирует неверные URL с /blog/"
description: "Решение для WordPress get_category_link, который генерирует неверные URL с /blog/ в пути, что приводит к 404 на страницах категорий."
pubDate: 2020-04-04
updatedDate: 2023-11-05
tags:
  - "wordpress"
lang: "ru"
translationOf: "2020/04/get_category_link-generating-incorrect-url-including-blog"
translatedBy: "claude"
translationDate: 2026-05-01
---
Недавно я прогнал по блогу инструмент SEO-аудита и обнаружил, что все ссылки на категории ведут на 404. При ближайшем рассмотрении оказалось, что в URL появляется /blog/, тогда как рабочие URL идут без него. Смотрите:

`https://startdebugging.net/blog/category/opinion/` -- не работает
`https://startdebugging.net/category/opinion/` -- работает

Очевидно, проблема была в том, что я использовал кастомный формат permalink для постов с /blog/ в качестве базы, и его подхватывали также URL категорий.

## Как это исправить?

Обязательно укажите "Category base" в настройках permalinks (Settings > Permalink); в моём случае я просто поставил "category".

![Wordpress, Settings > Permalinks > Category base](/wp-content/uploads/2020/04/image-1.png)
