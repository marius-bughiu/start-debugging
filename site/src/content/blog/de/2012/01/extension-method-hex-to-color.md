---
title: "C#: Hex in Color konvertieren"
description: "Eine C#-Erweiterungsmethode, die Hex-Farbcodes (RGB- und ARGB-Format) in Color-Objekte konvertiert."
pubDate: 2012-01-21
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2012/01/extension-method-hex-to-color"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hier eine Erweiterungsmethode, mit der Sie jeden Hex-Farbcode in ein `Color`-Objekt umwandeln können.

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

Die obige Methode kann nur 8-stellige ARGB-Farbcodes konvertieren.
Um auch einfache RGB-Codes umzuwandeln, prüfen wir die Länge des Strings (9 = ARGB und 7 = RGB) und fügen, falls 7, den Alpha-Wert als FF (255 -- opak) an unseren String an, bevor wir die Farbe zurückgeben.

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

Wir sollten zudem etwas tun, falls der übergebene Hex-Farbcode tatsächlich keiner ist. Fügen Sie nach dem bereits vorhandenen if eine weitere Bedingung hinzu und prüfen Sie erneut die Länge des Strings; ist sie nicht 9, ist der Wert ungültig und Sie können beliebig zurückgeben (ich nehme transparent). Die finale Methode sieht so aus:

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

Verwendung:

```cs
string myHexString = "#78196DFD";
Color myColor = new Color();
myColor = myHexString.ToColor();
```
