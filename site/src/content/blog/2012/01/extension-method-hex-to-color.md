---
title: "C# Convert Hex To Color"
description: "Below you have an extension method that can help you convert any hex color code to a Color object. The method above can only convert 8 characters ARGB color codes.In order to convert simple RGB codes too we will check for the length of the string (9 = ARGB and 7 = RGB) and in…"
pubDate: 2012-01-21
updatedDate: 2023-11-05
tags:
  - "c-sharp"
---
Below you have an extension method that can help you convert any hex color code to a `Color` object.

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

The method above can only convert 8 characters ARGB color codes.  
In order to convert simple RGB codes too we will check for the length of the string (9 = ARGB and 7 = RGB) and in case it’s 7 we will add the alpha to our string as FF ( 255 – opaque) and only then return the color.

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

We should also do something in case the hex color code is not actually a hex color code. So add another if statement after the one we added already and check again for the length of the string; if it’s not equal to 9 then it’s not good so feel free to return any color you want (I will return transparent). The final method looks like this:

```cs
public static Color ToColor(this string hexColor)
{
   string tempHexColor = string.Empty;
   if (tempHexColor.Length == 7)
      tempHexColor = "#FF" + hexColor.Substring(1,6);
   if (tempHexColor.Length != 9)
      tempHexColor = "#00000000";
   return Color.FromArgb(
      Convert.ToByte(tempHexColor.Substring(1, 2), 16),
      Convert.ToByte(tempHexColor.Substring(3, 2), 16),
      Convert.ToByte(tempHexColor.Substring(5, 2), 16),
      Convert.ToByte(tempHexColor.Substring(7, 2), 16));
}
```

How to use it:

```cs
string myHexString = "#78196DFD";
Color myColor = new Color();
mycolor = myHexString.ToColor();
```
