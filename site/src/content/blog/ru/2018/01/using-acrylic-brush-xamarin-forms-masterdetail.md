---
title: "UWP - Используем Acrylic Brush в меню MasterDetail Xamarin Forms"
description: "Примените UWP Acrylic Brush к меню MasterDetail Xamarin Forms с помощью native renderer на стороне платформы без сторонних библиотек."
pubDate: 2018-01-16
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
lang: "ru"
translationOf: "2018/01/using-acrylic-brush-xamarin-forms-masterdetail"
translatedBy: "claude"
translationDate: 2026-05-01
---
Хорошо, значит, вы из тех, кто целится в UWP вашим Xamarin Forms приложением и хочет использовать новый Acrylic Brush, чтобы выделить приложение. Тогда не будем тянуть.

![Меню Acrylic Gazeta на UWP](https://image.ibb.co/fTPyrm/gazeta_acrylic.gif)

Никаких сторонних библиотек/пакетов использовать не будем; работать будем в платформозависимом проекте; откройте **MainPage.xaml.cs** в вашем UWP-проекте. Сначала нужно получить ссылку на Master-страницу вашего MasterDetail. В моём случае MasterDetail - это и есть MainPage, так что всё прямолинейно.

```cs
var masterPage = (app.MainPage as Xamarin.Forms.MasterDetailPage).Master;
```

Далее нужен native renderer для Master-страницы. Именно он позволит изменить Background brush.

```cs
var renderer = Platform.GetRenderer(masterPage) as PageRenderer;
```

Теперь создайте кисть и присвойте её renderer'у. Это перезапишет любой BackgroundColor, заданный в XAML на ContentPage - и это хорошо: Android и iOS будут продолжать использовать заданное в XAML значение, а в UWP вы будете использовать новый AcrylicBrush.

```cs
var acrylicBrush = new Windows.UI.Xaml.Media.AcrylicBrush();
acrylicBrush.BackgroundSource = Windows.UI.Xaml.Media.AcrylicBackgroundSource.HostBackdrop;
acrylicBrush.TintColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.FallbackColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.TintOpacity = 0.8;

renderer.Background = acrylicBrush;
```

TintColor и FallbackColor я задал так, чтобы они совпадали с цветом из XAML, а для прозрачности выбрал 80%. Поэкспериментируйте со значениями, пока не получите нужный эффект. Что именно делает каждое свойство:

> -   **TintColor**: цветовой/тонировочный слой поверх. По возможности задавайте и RGB-цвет, и прозрачность альфа-канала.
> -   **TintOpacity**: прозрачность тонировочного слоя. Рекомендуем 80% как точку отсчёта, хотя другие цвета могут лучше смотреться при иной прозрачности.
> -   **BackgroundSource**: флаг, указывающий, нужен ли вам background или in-app acrylic.
> -   **FallbackColor**: однотонный цвет, который заменяет acrylic в режиме экономии заряда. Для background acrylic fallback color также заменяет acrylic, когда ваше приложение не находится в активном desktop-окне или когда оно работает на phone и Xbox.

Подробнее о работе материала Acrylic читайте [здесь](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic). На случай, если что-то не работает, вот вся MainPage:

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
