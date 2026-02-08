---
title: "How to take a screenshot in .NET core"
description: "Learn how to capture a screenshot of your entire desktop from a .NET console application using System.Windows.Forms. Windows-only solution covering all displays."
pubDate: 2023-11-04
tags:
  - "csharp"
  - "dotnet"
---
In this article we’re going to look at how you can grab a screenshot of your entire desktop – that means all your displays, not just the primary one – from a console application using .NET core. This solution relies on Windows-only dependencies, so it will not work cross-platform, it will only work on Windows.

We start with a bit of project setup. In order to grab the screen information, we will need access to `System.Windows.Forms`, and in order to have that in a .NET Console application, we’ll need to add the following reference in our `.csproj`.

```xml
<ItemGroup>
  <FrameworkReference Include="Microsoft.WindowsDesktop.App.WindowsForms" />
</ItemGroup>
```

Now that we have a reference to `System.Windows.Forms`, we can get hold of the screen's dimensions – we're interested in the starting coordinates (`x` and `y`) and its size (`w` and `h`). We get this information from `SystemInformation.VirtualScreen`.

```cs
var screen = SystemInformation.VirtualScreen;
int x = screen.Left;
int y = screen.Top;
int w = screen.Width;
int h = screen.Height;
```

Next, we create a bitmap and copy the screen information into it – effectively creating our screenshot in memory.

```cs
var image = new Bitmap(w, h);
using var graphics = Graphics.FromImage(image);
graphics.CopyFromScreen(x, y, 0, 0, new Size(w, h));
```

Last step is to write the in-memory screenshot to a file on disk. To mimic what Snipping Tool is already doing, we’re saving the image to the **Pictures** folder and include a timestamp in the file’s name.

```cs
string picturesDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
string fileName = $"Screenshot {DateTime.Now:yyyy-MM-dd HHmmss}.png";
string filePath = Path.Combine(picturesDirectory, fileName);
image.Save(filePath, ImageFormat.Png);
```

If you are interested in a fully working sample, you can [check out the code on GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/screenshot/Screenshot/Program.cs).
