---
title: "Animando fundos com Xamarin Forms"
description: "Crie um efeito de fundo animado e suave no Xamarin Forms usando animações ScaleTo em BoxViews sobrepostos."
pubDate: 2019-01-02
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "xamarin"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2019/01/animating-backgrounds-with-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
Comecei a brincar com animações no Xamarin Forms recentemente e criei uma animação de fundo legal para um dos meus apps (Charades for Dota 2) que achei que valia compartilhar. Sem mais delongas, este é o resultado final:

![](/wp-content/uploads/2019/01/animations3.gif)

O GIF está um pouco engasgado, mas é só porque o meu PC não dá conta direito do emulador. Em um dispositivo, as animações ficam suaves.

Vamos lá. Primeiro, escolhemos as cores. No nosso caso, precisamos de 5 cores: uma como fundo do app e 4 para as diferentes camadas que queremos animar. Para facilitar -- escolha uma [cor do Material Design](https://material-ui.com/style/color/); vamos usar as tonalidades de 500 a 900. Adicione essas cores como recursos no seu app ou na página.

```xml
<ContentPage.Resources>
        <Color x:Key="Color500">#2196F3</Color>
        <Color x:Key="Color600">#1E88E5</Color>
        <Color x:Key="Color700">#1976D2</Color>
        <Color x:Key="Color800">#1565C0</Color>
        <Color x:Key="Color900">#0D47A1</Color>
</ContentPage.Resources>
```

Em seguida, monte sua página de modo a ter 4 camadas de fundo, cada uma sendo um `BoxView` com a sua própria cor. Note como ordenamos as cores da mais escura para a mais clara.

```xml
<Grid x:Name="LayoutRoot" BackgroundColor="{StaticResource Color900}">
        <BoxView x:Name="BackgroundLayer1" BackgroundColor="{StaticResource Color800}" />
        <BoxView x:Name="BackgroundLayer2" BackgroundColor="{StaticResource Color700}" />
        <BoxView x:Name="BackgroundLayer3" BackgroundColor="{StaticResource Color600}" />
        <BoxView x:Name="BackgroundLayer4" BackgroundColor="{StaticResource Color500}" />
</Grid>
```

Com a página pronta, só nos resta animar as camadas individuais. No nosso caso, escalamos cada camada para mais e para menos usando o método `ScaleTo`, que recebe três parâmetros: a escala alvo da animação, a duração da animação em milissegundos e a função de easing a ser usada; os dois últimos parâmetros são opcionais. É assim que encolhemos uma camada:

```cs
await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
```

Uma vez que a camada esteja encolhida -- e veja como usamos `await` para aguardar a animação terminar -- temos que fazer a animação inversa e aumentá-la. E precisamos fazer isso em um loop:

```cs
while (true)
{
    await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
    await BackgroundLayer1.ScaleTo(1.2, 1750, Easing.SinInOut);
}
```

Faça o mesmo para todas as 4 camadas em loops separados e você obtém o mesmo efeito do GIF acima. Abaixo está o código completo para animar todas as 4 camadas.

```cs
public partial class MainPage : ContentPage
{
    public MainPage()
    {
        InitializeComponent();
        AnimateBackground();
    }

    private void AnimateBackground()
    {
        AnimateBackgroundLayer1();
        AnimateBackgroundLayer2();
        AnimateBackgroundLayer3();
        AnimateBackgroundLayer4();
    }

    private async void AnimateBackgroundLayer1()
    {
        while (true)
        {
            await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
            await BackgroundLayer1.ScaleTo(1.2, 1750, Easing.SinInOut);
        }
    }

    private async void AnimateBackgroundLayer2()
    {
        while (true)
        {
            await BackgroundLayer2.ScaleTo(0.8, 2750, Easing.SinOut);
            await BackgroundLayer2.ScaleTo(1, 2250, Easing.SinInOut);
        }
    }

    private async void AnimateBackgroundLayer3()
    {
        while (true)
        {
            await BackgroundLayer3.ScaleTo(0.7, 3000, Easing.SinInOut);
            await BackgroundLayer3.ScaleTo(0.9, 2500, Easing.SinOut);
        }
    }

    private async void AnimateBackgroundLayer4()
    {
        while (true)
        {
            await BackgroundLayer4.ScaleTo(0.6, 1750, Easing.SinOut);
            await BackgroundLayer4.ScaleTo(0.8, 2000, Easing.SinInOut);
        }
    }
}
```

É isso. Se algo não estiver funcionando e precisar de ajuda, deixe um comentário abaixo. O exemplo completo ficava originalmente no GitHub, mas o repositório não está mais disponível.
