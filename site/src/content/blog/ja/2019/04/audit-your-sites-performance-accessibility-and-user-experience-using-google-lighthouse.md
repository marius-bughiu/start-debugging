---
title: "Google Lighthouse でサイトのパフォーマンス、アクセシビリティ、ユーザー体験を監査する"
description: "Chrome DevTools から直接 Google Lighthouse を使って、Web サイトのパフォーマンス、アクセシビリティ、ユーザー体験を監査する方法を学びます。"
pubDate: 2019-04-29
updatedDate: 2023-11-05
tags:
  - "lighthouse"
  - "seo"
lang: "ja"
translationOf: "2019/04/audit-your-sites-performance-accessibility-and-user-experience-using-google-lighthouse"
translatedBy: "claude"
translationDate: 2026-05-01
---
Lighthouse は、任意の Web ページのパフォーマンス、アクセシビリティ、全体的なユーザー体験を監査する自動化ツールです。当初は PWA (Progressive Web Apps) を監査するためのものでしたが、それ以上の用途があります。

サイトを監査するもっとも簡単な方法は、最新版の [Chrome](https://www.google.com/chrome/b/) を使うことです。サイトに移動し、F12 を押すか、ページを右クリックして Inspect (Ctrl + Shift + I) で Dev Tools を開きます。次に Audits タブに移動し、Run audits をクリックします。これでサイトに対して一連のテストが実行され、次のようなレポートが得られます。

![Google Lighthouse - レポート概要](/wp-content/uploads/2019/04/image.png)

ご覧のとおり、このブログはあまり良い結果になっていません。幸い Lighthouse は非常に詳細なレポートを提供し、スコアの理由を説明してくれます。各項目には Learn more リンクがあり、その問題の詳細と評価を改善する方法を確認できます。

![Google Lighthouse - Opportunities レポート](/wp-content/uploads/2019/04/image-1.png)

設定をいじったり、モバイルデバイスでテストしたり、ターゲットオーディエンスに合った接続速度を使ったりして、さまざまなレポートを生成できます。ベースラインが取れたら、いよいよそれらの問題を改善していきましょう。

完璧なスコアにたどり着けるでしょうか？
