---
title: "Metro TimeBlock"
description: "Metro TimeBlock - настраиваемый контрол отображения времени для Windows Phone, позволяющий задать любой цвет, фон и размер."
pubDate: 2012-02-08
updatedDate: 2023-11-05
tags:
  - "metro"
  - "windows-phone"
lang: "ru"
translationOf: "2012/02/metro-timeblock"
translatedBy: "claude"
translationDate: 2026-05-01
---
Metro TimeBlock - это контрол отображения времени, который я сделал и который позволяет показывать время в любом цвете и с любым фоном. Размер тоже регулируется, и можно выбрать показ текущего времени или собственного.

[![Metro TimeBlock](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)

Свойства контрола:

**Time** -- принимает любой объект DateTime. Контрол покажет Time, переданный в этом DateTime. Оставьте пустым, чтобы показать текущее время.

**Spacer** -- строка, отображаемая между часами и минутами и между минутами и секундами. Используйте разделители вроде ":" или " ".

**Size** -- можно выбрать **Small, Normal, Medium, MediumLarge, Large, ExtraLarge, ExtraExtraLarge** и **Huge**. Я сделал именно так вместо FontSize, потому что так можно ещё и контролировать вид фоновых блоков.

**Foreground** -- задаёт контролу цвет, которым отображать время.

**Fill** -- задаёт цвет фона контрола (квадратных блоков).

Вот, собственно, и всё. Если возникнут проблемы или понадобится помощь - оставьте комментарий ниже. Код можно скачать по [этой ссылке](https://www.dropbox.com/s/mjiba8cugtj8fdz/StartDebugging.zip?dl=0); там и сам контрол, и пара примеров.
