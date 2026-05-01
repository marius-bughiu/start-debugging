---
title: "Wie Sie unter .NET core einen Screenshot erstellen"
description: "Erfahren Sie, wie Sie aus einer .NET-Konsolenanwendung mit System.Windows.Forms einen Screenshot Ihres gesamten Desktops aufnehmen. Eine reine Windows-Lösung, die alle Monitore abdeckt."
pubDate: 2023-11-04
tags:
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2023/11/how-to-take-a-screenshot-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
In diesem Artikel sehen wir uns an, wie Sie aus einer Konsolenanwendung mit .NET core einen Screenshot Ihres gesamten Desktops aufnehmen können, also aller Monitore und nicht nur des primären. Diese Lösung basiert auf Windows-spezifischen Abhängigkeiten und funktioniert daher nicht plattformübergreifend, sondern nur unter Windows.

Wir beginnen mit einem kleinen Projekt-Setup. Um die Bildschirminformationen abzugreifen, benötigen wir Zugriff auf `System.Windows.Forms`. Damit dies in einer .NET-Konsolenanwendung verfügbar ist, fügen wir die folgende Referenz in unsere `.csproj` ein.

```xml
<ItemGroup>
  <FrameworkReference Include="Microsoft.WindowsDesktop.App.WindowsForms" />
</ItemGroup>
```

Nachdem wir nun eine Referenz auf `System.Windows.Forms` haben, können wir die Abmessungen des Bildschirms ermitteln. Uns interessieren die Startkoordinaten (`x` und `y`) sowie die Größe (`w` und `h`). Diese Informationen erhalten wir aus `SystemInformation.VirtualScreen`.

```cs
var screen = SystemInformation.VirtualScreen;
int x = screen.Left;
int y = screen.Top;
int w = screen.Width;
int h = screen.Height;
```

Als Nächstes legen wir ein Bitmap an und kopieren die Bildschirminformationen hinein. Damit erstellen wir unseren Screenshot im Arbeitsspeicher.

```cs
var image = new Bitmap(w, h);
using var graphics = Graphics.FromImage(image);
graphics.CopyFromScreen(x, y, 0, 0, new Size(w, h));
```

Im letzten Schritt schreiben wir den Screenshot aus dem Speicher in eine Datei auf der Festplatte. Um das Verhalten des Snipping Tools nachzuahmen, speichern wir das Bild im Ordner **Bilder** und fügen einen Zeitstempel in den Dateinamen ein.

```cs
string picturesDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
string fileName = $"Screenshot {DateTime.Now:yyyy-MM-dd HHmmss}.png";
string filePath = Path.Combine(picturesDirectory, fileName);
image.Save(filePath, ImageFormat.Png);
```

Wenn Sie an einem voll funktionsfähigen Beispiel interessiert sind, können Sie sich [den Code auf GitHub ansehen](https://github.com/Start-Debugging/dotnet-samples/blob/main/screenshot/Screenshot/Program.cs).
