---
title: "C#: converter Hex para Color"
description: "Um extension method em C# que converte códigos de cor em hex (formatos RGB e ARGB) em objetos Color."
pubDate: 2012-01-21
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2012/01/extension-method-hex-to-color"
translatedBy: "claude"
translationDate: 2026-05-01
---
Abaixo, um extension method que pode te ajudar a converter qualquer código de cor em hex em um objeto `Color`.

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

O método acima só consegue converter códigos ARGB de 8 caracteres.
Para converter também códigos RGB simples, vamos verificar o tamanho da string (9 = ARGB e 7 = RGB) e, se for 7, adicionar o alpha à string como FF (255 -- opaco) e só então retornar a cor.

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

Devemos também tratar o caso em que o código hex não é realmente um código de cor hex válido. Adicione outro if depois do que já incluímos e cheque de novo o tamanho da string; se não for 9, não está ok, então retorne a cor que quiser (vou retornar transparente). O método final fica assim:

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

Como usar:

```cs
string myHexString = "#78196DFD";
Color myColor = new Color();
myColor = myHexString.ToColor();
```
