---
title: "Como tirar um screenshot no .NET core"
description: "Aprenda a capturar um screenshot de toda a área de trabalho a partir de uma aplicação de console .NET usando System.Windows.Forms. Solução só para Windows que cobre todos os monitores."
pubDate: 2023-11-04
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/how-to-take-a-screenshot-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
Neste artigo vamos ver como capturar um screenshot de toda a sua área de trabalho (ou seja, de todos os seus monitores, não só do principal) a partir de uma aplicação de console usando .NET core. Esta solução depende de bibliotecas exclusivas do Windows, então ela não funciona de forma multiplataforma, só funciona no Windows.

Começamos com um pouco de configuração do projeto. Para conseguir as informações da tela vamos precisar de acesso a `System.Windows.Forms`, e para ter isso disponível em uma aplicação de console .NET é preciso adicionar a referência abaixo no nosso `.csproj`.

```xml
<ItemGroup>
  <FrameworkReference Include="Microsoft.WindowsDesktop.App.WindowsForms" />
</ItemGroup>
```

Agora que temos uma referência a `System.Windows.Forms`, conseguimos obter as dimensões da tela. Estamos interessados nas coordenadas iniciais (`x` e `y`) e no tamanho dela (`w` e `h`). Pegamos essas informações em `SystemInformation.VirtualScreen`.

```cs
var screen = SystemInformation.VirtualScreen;
int x = screen.Left;
int y = screen.Top;
int w = screen.Width;
int h = screen.Height;
```

Em seguida, criamos um bitmap e copiamos as informações da tela para ele, criando efetivamente o nosso screenshot em memória.

```cs
var image = new Bitmap(w, h);
using var graphics = Graphics.FromImage(image);
graphics.CopyFromScreen(x, y, 0, 0, new Size(w, h));
```

O último passo é gravar o screenshot que está em memória em um arquivo em disco. Para imitar o que a Ferramenta de Captura já faz, salvamos a imagem na pasta **Imagens** e incluímos um timestamp no nome do arquivo.

```cs
string picturesDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
string fileName = $"Screenshot {DateTime.Now:yyyy-MM-dd HHmmss}.png";
string filePath = Path.Combine(picturesDirectory, fileName);
image.Save(filePath, ImageFormat.Png);
```

Se você quiser um exemplo totalmente funcional, pode [conferir o código no GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/screenshot/Screenshot/Program.cs).
