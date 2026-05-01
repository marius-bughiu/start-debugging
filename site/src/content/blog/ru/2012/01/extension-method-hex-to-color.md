---
title: "C#: преобразование Hex в Color"
description: "Метод-расширение C#, преобразующий hex-коды цветов (форматы RGB и ARGB) в объекты Color."
pubDate: 2012-01-21
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ru"
translationOf: "2012/01/extension-method-hex-to-color"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ниже приведён метод-расширение, который поможет преобразовать любой hex-код цвета в объект `Color`.

```cs
public static Color ToColor(this string hexColor)
{
   return Color.FromArgb(
      Convert.ToByte(hexColor.ToString().Substring(1, 2), 16),
      Convert.ToByte(hexColor.ToString().Substring(3, 2), 16),
      Convert.ToByte(hexColor.ToString().Substring(5, 2), 16),
      Convert.ToByte(hexColor.ToString().Substring(7, 2), 16));
}
```

Метод выше умеет преобразовывать только 8-символьные ARGB-коды.
Чтобы конвертировать и обычные RGB-коды, проверим длину строки (9 = ARGB и 7 = RGB) и в случае 7 добавим к строке alpha как FF (255 - непрозрачный) и только потом вернём цвет.

```cs
public static Color ToColor(this string hexColor)
{
   string tempHexColor = string.Empty;
   if (hexColor.Length == 7)
      tempHexColor = "#FF" + hexColor.Substring(1,6);
   return Color.FromArgb(
      Convert.ToByte(tempHexColor.Substring(1, 2), 16),
      Convert.ToByte(tempHexColor.Substring(3, 2), 16),
      Convert.ToByte(tempHexColor.Substring(5, 2), 16),
      Convert.ToByte(tempHexColor.Substring(7, 2), 16));
}
```

Имеет смысл также обработать случай, когда hex-код на самом деле не является корректным hex-кодом цвета. Добавьте ещё один if после уже добавленного и снова проверьте длину строки; если она не равна 9, значение невалидно, и можно вернуть любой цвет (я верну прозрачный). Итоговый метод:

```cs
public static Color ToColor(this string hexColor)
{
   string tempHexColor = string.Empty;
   if (hexColor.Length == 7)
      tempHexColor = "#FF" + hexColor.Substring(1,6);
   else
      tempHexColor = hexColor;
   if (tempHexColor.Length != 9)
      tempHexColor = "#00000000";
   return Color.FromArgb(
      Convert.ToByte(tempHexColor.Substring(1, 2), 16),
      Convert.ToByte(tempHexColor.Substring(3, 2), 16),
      Convert.ToByte(tempHexColor.Substring(5, 2), 16),
      Convert.ToByte(tempHexColor.Substring(7, 2), 16));
}
```

Как использовать:

```cs
string myHexString = "#78196DFD";
Color myColor = new Color();
myColor = myHexString.ToColor();
```
