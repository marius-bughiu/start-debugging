---
title: "C#: convertir Hex a Color"
description: "Un método de extensión en C# que convierte códigos de color en hex (formatos RGB y ARGB) a objetos Color."
pubDate: 2012-01-21
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2012/01/extension-method-hex-to-color"
translatedBy: "claude"
translationDate: 2026-05-01
---
Abajo tienes un método de extensión que puede ayudarte a convertir cualquier código de color en hex a un objeto `Color`.

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

El método anterior solo puede convertir códigos ARGB de 8 caracteres.
Para convertir también códigos RGB simples, comprobaremos la longitud del string (9 = ARGB y 7 = RGB) y, si es 7, añadiremos el alpha al string como FF (255, opaco) y solo entonces devolveremos el color.

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

También deberíamos hacer algo por si el código de color hex no es realmente un código de color hex válido. Añade otra sentencia if después de la que ya añadimos y comprueba de nuevo la longitud del string; si no es 9, no sirve, así que puedes devolver el color que quieras (yo devolveré transparente). El método final queda así:

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

Cómo usarlo:

```cs
string myHexString = "#78196DFD";
Color myColor = new Color();
myColor = myHexString.ToColor();
```
