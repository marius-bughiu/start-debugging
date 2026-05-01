---
title: "Исправляем странные цвета вкладок Firefox в Windows 8"
description: "Как устранить графический баг с цветами вкладок Firefox в Windows 8 на видеокартах nVidia, отключив аппаратное ускорение."
pubDate: 2012-11-01
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "ru"
translationOf: "2012/11/fix-firefox-tabs-having-strange-colors-in-windows-8"
translatedBy: "claude"
translationDate: 2026-05-01
---
Этот графический глюк - известный баг Firefox в Windows 8. По всей видимости, проявляется только на машинах с видеокартами nVidia и вызван аппаратным ускорением в браузере.

Решение простое - **отключите аппаратное ускорение** в меню настроек браузера. Странные цвета исчезнут - и, к сожалению, аппаратное ускорение в браузере тоже. Но это всё, что мы можем сделать, пока баг не исправят.

Следить за issue на bugzilla можно здесь: [https://bugzilla.mozilla.org/show_bug.cgi?id=686782](https://bugzilla.mozilla.org/show_bug.cgi?id=686782)

И на случай, если вы не найдёте нужную настройку: откройте окно опций (Firefox > Options или Tools > Options) > Advanced > General. Там снимите галочку "Use hardware acceleration when available". Готово.

Обновление: 8 лет спустя, обновляю это ради SEO; баг не исправлен, но - кто вообще ещё пользуется Windows 8?
