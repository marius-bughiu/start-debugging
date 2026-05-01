---
title: "Xamarin Forms - использование OnPlatform"
description: "Узнайте, как использовать OnPlatform в Xamarin Forms, чтобы задавать значения свойств, специфичные для платформы, как в XAML, так и в C#."
pubDate: 2019-07-27
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ru"
translationOf: "2019/07/xamarin-forms-using-onplatform"
translatedBy: "claude"
translationDate: 2026-05-01
---
При разработке приложений Xamarin Forms часто возникают ситуации, когда нужно задать разные значения для одного свойства в зависимости от операционной системы.

OnPlatform позволяет именно это и может использоваться как из C#-кода, так и из XAML. Рассмотрим несколько примеров. В этой статье будем работать с новым master-detail проектом.

## Использование OnPlatform с XAML

На странице About есть кнопка Learn More. Сделаем её цвет зависимым от платформы: зелёный для Android, оранжевый для iOS и фиолетовый для UWP.

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
    BackgroundColor="{OnPlatform Android=Green, iOS=Orange, UWP=Purple}"
    Command="{Binding OpenWebCommand}"
    TextColor="White" />
```

Посмотрим на результат:

![](/wp-content/uploads/2019/07/xamarin-forms-on-platform.png)

В качестве альтернативы можно использовать следующий синтаксис, более удобный при работе с более сложными типами данных.

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

## Использование OnPlatform с C# (устарело)

Те же требования, что и выше, но на этот раз из C#, а не из XAML. Сначала зададим кнопке x:Name="LearnMoreButton", а затем в code-behind напишем следующее:

```cs
Device.OnPlatform(
    Android: () => this.LearnMoreButton.BackgroundColor = Color.Green, 
    iOS: () => this.LearnMoreButton.BackgroundColor = Color.Orange, 
    WinPhone: () => this.LearnMoreButton.BackgroundColor = Color.Purple,
    Default: () => this.LearnMoreButton.BackgroundColor = Color.Black);
```

Результат тот же. WinPhone мапится на UWP, и вы также можете задать значение по умолчанию для остальных платформ. Этот метод устарел начиная с XF 2.3.4, и рекомендуется писать собственный switch case по Device.RuntimePlatform.

## Используем вместо этого Device.RuntimePlatform

Код выше можно переписать так:

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

Поддерживаемые сейчас значения платформ: iOS, Android, UWP, macOS, GTK, Tizen и WPF.

Исходный код примерного проекта изначально находился на GitHub, но репозиторий больше не доступен.
