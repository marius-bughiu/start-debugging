---
title: "get_category_link erzeugt fehlerhafte URLs mit /blog/"
description: "Lösung für WordPress get_category_link, das fehlerhafte URLs mit /blog/ im Pfad erzeugt und 404-Fehler auf Kategorieseiten verursacht."
pubDate: 2020-04-04
updatedDate: 2023-11-05
tags:
  - "wordpress"
lang: "de"
translationOf: "2020/04/get_category_link-generating-incorrect-url-including-blog"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ich habe kürzlich ein SEO-Audit-Tool über den Blog laufen lassen und festgestellt, dass alle Kategorielinks zu 404 führten. Bei näherem Hinsehen enthielten die URLs ein /blog/, während die tatsächlich funktionierenden URLs ohne das auskommen. Siehe unten:

`https://startdebugging.net/blog/category/opinion/` -- funktioniert nicht
`https://startdebugging.net/category/opinion/` -- funktioniert

Das Problem entstand offenbar dadurch, dass ich für die Beiträge ein eigenes Permalink-Format verwendet habe, das /blog/ als Basis nutzte, und das wurde auch von den Kategorie-URLs übernommen.

## Wie behebt man es?

Stellen Sie in Ihren Permalink-Einstellungen (Settings > Permalink) eine "Category base" ein; in meinem Fall habe ich sie einfach auf "category" gesetzt.

![Wordpress, Settings > Permalinks > Category base](/wp-content/uploads/2020/04/image-1.png)
