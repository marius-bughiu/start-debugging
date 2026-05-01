---
title: "UWP - Usando um Acrylic Brush no menu MasterDetail do Xamarin Forms"
description: "Aplique o Acrylic Brush do UWP em um menu MasterDetail do Xamarin Forms usando um native renderer específico de plataforma, sem bibliotecas de terceiros."
pubDate: 2018-01-16
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2018/01/using-acrylic-brush-xamarin-forms-masterdetail"
translatedBy: "claude"
translationDate: 2026-05-01
---
Beleza, então você é um daqueles que miram em UWP com app Xamarin Forms e quer usar o novo Acrylic Brush para destacar a sua aplicação. Sem mais, vamos lá.

![Menu Acrylic Gazeta no UWP](https://image.ibb.co/fTPyrm/gazeta_acrylic.gif)

Não vamos usar nenhuma biblioteca / pacote de terceiros para isso e vamos trabalhar no projeto específico de plataforma; abra seu **MainPage.xaml.cs** dentro do projeto UWP. Primeiro, precisamos pegar uma referência à página Master do MasterDetail. No meu caso, o MasterDetail é o MainPage, então fica bem direto.

```cs
var masterPage = (app.MainPage as Xamarin.Forms.MasterDetailPage).Master;
```

Em seguida, é preciso obter o native renderer da página Master. É ele que vai nos permitir alterar o Background brush.

```cs
var renderer = Platform.GetRenderer(masterPage) as PageRenderer;
```

Agora crie o brush e atribua ao renderer. Isso vai sobrescrever qualquer BackgroundColor que você possa ter setado no ContentPage no XAML -- o que é bom: Android e iOS continuarão usando o valor definido no XAML, enquanto no UWP usaremos o novo AcrylicBrush.

```cs
var acrylicBrush = new Windows.UI.Xaml.Media.AcrylicBrush();
acrylicBrush.BackgroundSource = Windows.UI.Xaml.Media.AcrylicBackgroundSource.HostBackdrop;
acrylicBrush.TintColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.FallbackColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.TintOpacity = 0.8;

renderer.Background = acrylicBrush;
```

Defini TintColor e FallbackColor para combinarem com a cor que setei no XAML, e para a opacidade escolhi 80%. Brinque com esses valores até obter o efeito desejado. Sobre o que cada propriedade faz exatamente:

> -   **TintColor**: a camada de cor/tinte sobreposta. Considere especificar tanto o valor RGB quanto a opacidade do canal alfa.
> -   **TintOpacity**: a opacidade da camada de tinte. Recomendamos 80% como ponto de partida, embora cores diferentes possam ficar melhores em outras transparências.
> -   **BackgroundSource**: a flag para indicar se você quer acrylic de fundo ou in-app.
> -   **FallbackColor**: a cor sólida que substitui o acrylic no modo de bateria baixa. Para background acrylic, a fallback color também substitui o acrylic quando o app não está na janela de desktop ativa ou quando ele roda em phone e Xbox.

Você pode ler [isto](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic) para mais informações sobre como o material Acrylic funciona. Caso algo não funcione, segue o MainPage inteiro:

```cs
public sealed partial class MainPage
{
    public MainPage()
    {
        this.InitializeComponent();
        var app = new GazetaSporturilor.App();
        LoadApplication(app);

        var masterPage = (app.MainPage as Xamarin.Forms.MasterDetailPage).Master;
        var renderer = Platform.GetRenderer(masterPage) as PageRenderer;

        var acrylicBrush = new Windows.UI.Xaml.Media.AcrylicBrush();
        acrylicBrush.BackgroundSource = Windows.UI.Xaml.Media.AcrylicBackgroundSource.HostBackdrop;
        acrylicBrush.TintColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
        acrylicBrush.FallbackColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
        acrylicBrush.TintOpacity = 0.8;

        renderer.Background = acrylicBrush;
    }
}
```
