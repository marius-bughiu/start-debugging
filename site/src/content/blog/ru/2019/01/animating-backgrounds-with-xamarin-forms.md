---
title: "Анимация фона с помощью Xamarin Forms"
description: "Создайте плавный анимированный фон в Xamarin Forms с помощью анимаций ScaleTo на наложенных BoxView."
pubDate: 2019-01-02
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "xamarin"
  - "xamarin-forms"
lang: "ru"
translationOf: "2019/01/animating-backgrounds-with-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
Я только недавно начал играть с анимациями в Xamarin Forms и сделал крутую анимацию фона для одного из своих приложений (Charades for Dota 2), которой решил поделиться. Без долгих вступлений - вот итоговый результат:

![](/wp-content/uploads/2019/01/animations3.gif)

GIF немного дёргается, но это лишь потому, что мой ПК не справляется как следует с эмулятором. На устройстве анимации плавные.

Итак, как мы это сделали: сначала выбираем цвета. В нашем случае нужно 5 цветов: один как фон приложения и 4 для разных слоёв, которые мы хотим анимировать. Чтобы упростить - выберите [материальный цвет](https://material-ui.com/style/color/); мы будем использовать оттенки от 500 до 900. Добавьте эти цвета как ресурсы в приложение или страницу.

```xml
<ContentPage.Resources>
        <Color x:Key="Color500">#2196F3</Color>
        <Color x:Key="Color600">#1E88E5</Color>
        <Color x:Key="Color700">#1976D2</Color>
        <Color x:Key="Color800">#1565C0</Color>
        <Color x:Key="Color900">#0D47A1</Color>
</ContentPage.Resources>
```

Затем настройте страницу так, чтобы у вас было 4 слоя фона - каждый слой это `BoxView` со своим цветом. Обратите внимание, как мы располагаем цвета от самого тёмного к самому светлому.

```xml
<Grid x:Name="LayoutRoot" BackgroundColor="{StaticResource Color900}">
        <BoxView x:Name="BackgroundLayer1" BackgroundColor="{StaticResource Color800}" />
        <BoxView x:Name="BackgroundLayer2" BackgroundColor="{StaticResource Color700}" />
        <BoxView x:Name="BackgroundLayer3" BackgroundColor="{StaticResource Color600}" />
        <BoxView x:Name="BackgroundLayer4" BackgroundColor="{StaticResource Color500}" />
</Grid>
```

Когда страница готова, осталось анимировать отдельные слои. В нашем случае мы масштабируем каждый слой вниз и вверх с помощью метода `ScaleTo`, принимающего три параметра: масштаб, к которому анимировать, длительность анимации в миллисекундах и функцию easing для анимации; последние два параметра необязательные. Так мы уменьшаем один слой:

```cs
await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
```

Когда слой уменьшен - и обратите внимание, как мы делаем `await`, ожидая завершения анимации, - нам нужно сделать обратную анимацию и увеличить его. И всё это нужно делать в цикле:

```cs
while (true)
{
    await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
    await BackgroundLayer1.ScaleTo(1.2, 1750, Easing.SinInOut);
}
```

Сделайте то же для всех 4 слоёв в разных циклах - и получите тот же эффект, что и в GIF выше. Ниже полный код для анимации всех 4 слоёв.

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

Вот и всё. Если что-то не работает и нужна помощь - оставьте комментарий ниже. Полный пример изначально жил на GitHub, но репозиторий больше не доступен.
