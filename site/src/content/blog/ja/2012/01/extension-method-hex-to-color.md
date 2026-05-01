---
title: "C#: Hex を Color に変換する"
description: "Hex のカラーコード (RGB と ARGB の両形式) を Color オブジェクトに変換する C# の拡張メソッドです。"
pubDate: 2012-01-21
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2012/01/extension-method-hex-to-color"
translatedBy: "claude"
translationDate: 2026-05-01
---
任意の hex カラーコードを `Color` オブジェクトに変換するのに役立つ拡張メソッドです。

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

上のメソッドは 8 文字の ARGB カラーコードしか変換できません。
シンプルな RGB コードも変換するため、文字列の長さを確認し (9 = ARGB、7 = RGB)、7 の場合は alpha を FF (255 -- 不透明) として文字列に追加してから色を返すようにします。

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

入力された hex カラーコードが実は正しい hex カラーコードでない場合の処理も入れるべきでしょう。先に追加した if のあとにもう 1 つ if を加え、再度文字列の長さを確認します。9 でなければ不正なので、好きな色を返してかまいません (ここでは透明を返します)。最終的なメソッドは次のようになります。

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

使い方:

```cs
string myHexString = "#78196DFD";
Color myColor = new Color();
myColor = myHexString.ToColor();
```
