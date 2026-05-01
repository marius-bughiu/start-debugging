---
title: ".NET core でスクリーンショットを撮る方法"
description: "System.Windows.Forms を使って、.NET コンソールアプリケーションからデスクトップ全体のスクリーンショットを撮る方法を解説します。Windows 限定の方法で、すべてのディスプレイをカバーします。"
pubDate: 2023-11-04
tags:
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/how-to-take-a-screenshot-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
この記事では、.NET core を使ったコンソールアプリケーションから、デスクトップ全体、つまりプライマリだけでなくすべてのディスプレイのスクリーンショットを撮る方法を見ていきます。この方法は Windows 専用の依存関係に依存しているため、クロスプラットフォームでは動作せず、Windows でしか動きません。

まずはプロジェクトを少し準備するところから始めます。画面の情報を取得するには `System.Windows.Forms` へのアクセスが必要で、それを .NET コンソールアプリケーションで使うには、`.csproj` に以下の参照を追加する必要があります。

```xml
<ItemGroup>
  <FrameworkReference Include="Microsoft.WindowsDesktop.App.WindowsForms" />
</ItemGroup>
```

`System.Windows.Forms` への参照ができたので、画面のサイズを取得できます。必要なのは開始座標 (`x` と `y`) と、サイズ (`w` と `h`) です。これらの情報は `SystemInformation.VirtualScreen` から取得します。

```cs
var screen = SystemInformation.VirtualScreen;
int x = screen.Left;
int y = screen.Top;
int w = screen.Width;
int h = screen.Height;
```

次に Bitmap を作成し、そこに画面情報をコピーします。これでメモリ上にスクリーンショットができたことになります。

```cs
var image = new Bitmap(w, h);
using var graphics = Graphics.FromImage(image);
graphics.CopyFromScreen(x, y, 0, 0, new Size(w, h));
```

最後のステップは、メモリ上のスクリーンショットをディスクのファイルとして書き出すことです。Snipping Tool と同じ動きを真似て、画像を **Pictures** フォルダーに保存し、ファイル名にはタイムスタンプを含めます。

```cs
string picturesDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
string fileName = $"Screenshot {DateTime.Now:yyyy-MM-dd HHmmss}.png";
string filePath = Path.Combine(picturesDirectory, fileName);
image.Save(filePath, ImageFormat.Png);
```

完全に動くサンプルが欲しい場合は、[GitHub のコード](https://github.com/Start-Debugging/dotnet-samples/blob/main/screenshot/Screenshot/Program.cs)をチェックしてみてください。
