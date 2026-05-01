---
title: "Xamarin Forms - Usando OnPlatform"
description: "Aprenda a usar OnPlatform no Xamarin Forms para definir valores de propriedade específicos por plataforma, tanto em XAML quanto em C#."
pubDate: 2019-07-27
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2019/07/xamarin-forms-using-onplatform"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ao desenvolver aplicações Xamarin Forms você frequentemente vai se deparar com situações em que precisa definir valores diferentes para uma propriedade dependendo do sistema operacional.

OnPlatform permite fazer exatamente isso e pode ser usado tanto em código C# quanto em XAML. Vamos a alguns exemplos. Para este artigo, vamos trabalhar com um novo projeto master-detail.

## Usando OnPlatform com XAML

Na página About há um botão Learn More. Vamos deixar a cor dele dependente de plataforma: verde no Android, laranja no iOS e roxo no UWP.

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
    BackgroundColor="{OnPlatform Android=Green, iOS=Orange, UWP=Purple}"
    Command="{Binding OpenWebCommand}"
    TextColor="White" />
```

E vejamos o resultado:

![](/wp-content/uploads/2019/07/xamarin-forms-on-platform.png)

Como alternativa, você pode usar a seguinte sintaxe, que é mais conveniente ao lidar com tipos de dado mais elaborados.

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
        Command="{Binding OpenWebCommand}"
        TextColor="White">
    <Button.BackgroundColor>
        <OnPlatform x:TypeArguments="Color">
            <On Platform="Android" Value="Green"/>
            <On Platform="iOS" Value="Orange"/>
            <On Platform="UWP" Value="Purple"/>
        </OnPlatform>
    </Button.BackgroundColor>
</Button>
```

## Usando OnPlatform com C# (obsoleto)

Mesmos requisitos do anterior, mas dessa vez em C# em vez de XAML. Primeiro vamos dar ao nosso botão um x:Name="LearnMoreButton" e, em seguida, no code-behind, escrever o seguinte:

```cs
Device.OnPlatform(
    Android: () => this.LearnMoreButton.BackgroundColor = Color.Green, 
    iOS: () => this.LearnMoreButton.BackgroundColor = Color.Orange, 
    WinPhone: () => this.LearnMoreButton.BackgroundColor = Color.Purple,
    Default: () => this.LearnMoreButton.BackgroundColor = Color.Black);
```

Mesmo resultado de antes. WinPhone mapeia para UWP e você ainda pode especificar um valor padrão para o restante das plataformas. Esse método está obsoleto desde o XF 2.3.4, e recomenda-se que você escreva seu próprio switch case em cima de Device.RuntimePlatform.

## Usando Device.RuntimePlatform

O código acima pode ser traduzido para:

```cs
switch (Device.RuntimePlatform)
{
    case Device.Android:
        LearnMoreButtonSwitch.BackgroundColor = Color.Green;
        break;
    case Device.iOS:
        LearnMoreButtonSwitch.BackgroundColor = Color.Orange;
        break;
    case Device.UWP:
        LearnMoreButtonSwitch.BackgroundColor = Color.Purple;
        break;
     default:
         LearnMoreButtonSwitch.BackgroundColor = Color.Black;
         break;
}
```

Os valores de plataforma suportados atualmente são: iOS, Android, UWP, macOS, GTK, Tizen e WPF.

O código-fonte do projeto de exemplo ficava originalmente no GitHub, mas o repositório não está mais disponível.
