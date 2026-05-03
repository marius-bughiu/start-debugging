---
title: "Как правильно поддержать тёмную тему в приложении .NET MAUI"
description: "Тёмная тема от и до в .NET MAUI 11: AppThemeBinding, SetAppThemeColor, RequestedTheme, переопределение через UserAppTheme с сохранением, событие RequestedThemeChanged и платформенные нюансы Info.plist и MainActivity, о которых документация умалчивает."
pubDate: 2026-05-03
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "dark-mode"
  - "theming"
  - "how-to"
lang: "ru"
translationOf: "2026/05/how-to-support-dark-mode-correctly-in-a-maui-app"
translatedBy: "claude"
translationDate: 2026-05-03
---

Короткий ответ: в .NET MAUI 11.0.0 привязывайте каждое значение, чувствительное к теме, через расширение разметки `AppThemeBinding`, организуйте светлые и тёмные цвета как ключи `StaticResource` в `App.xaml`, устанавливайте `Application.Current.UserAppTheme = AppTheme.Unspecified` при запуске, чтобы приложение следовало за операционной системой, и сохраняйте любое пользовательское переопределение через `Preferences`. На Android вам также нужен `ConfigChanges.UiMode` на `MainActivity`, чтобы activity не уничтожалась при смене темы системы; на iOS нужно либо отсутствие ключа `UIUserInterfaceStyle` в `Info.plist`, либо значение `Automatic`, чтобы система могла передавать как светлую, так и тёмную тему. Обращайтесь к `Application.Current.RequestedThemeChanged` только тогда, когда нужно императивно что-то изменить, потому что расширение разметки уже переоценивает привязки.

Эта статья проходит по всему интерфейсу поддержки системной темы в .NET MAUI 11.0.0 на .NET 11, включая места, которые кусают в production: сохранение между перезапусками приложения, платформенная конфигурация `Info.plist` и `MainActivity`, динамическое обновление ресурсов при переключении `Application.Current.UserAppTheme`, цвета строки состояния и заставки, а также событие `RequestedThemeChanged`, которое, как известно, перестаёт срабатывать, если вы забыли флаг манифеста. Каждый сниппет проверен на `dotnet new maui` из .NET 11 SDK с `Microsoft.Maui.Controls` 11.0.0.

## Что на самом деле дают вам операционные системы

Тёмная тема — это не одна возможность, а объединение трёх различных видов поведения, которые поставляются на уровне операционной системы, и подключаться к каждому из них нужно отдельно:

1. Операционная система сообщает текущую тему. iOS 13+ предоставляет `UITraitCollection.UserInterfaceStyle`, Android 10 (API 29)+ предоставляет `Configuration.UI_MODE_NIGHT_MASK`, macOS 10.14+ предоставляет `NSAppearance`, Windows 10+ предоставляет `UISettings.GetColorValue(UIColorType.Background)` плюс ключ реестра `app-mode`. MAUI нормализует все четыре в перечисление `Microsoft.Maui.ApplicationModel.AppTheme`: `Unspecified`, `Light`, `Dark`.

2. ОС уведомляет приложение, когда пользователь переключает тему. На iOS это приходит через `traitCollectionDidChange:`, на Android через `Activity.OnConfigurationChanged` (только если вы подписались, об этом ниже), на Windows через `UISettings.ColorValuesChanged`. MAUI выставляет это объединение как статическое событие `Application.RequestedThemeChanged`.

3. ОС позволяет приложению переопределить отображаемую тему. iOS использует `UIWindow.OverrideUserInterfaceStyle`, Android использует `AppCompatDelegate.SetDefaultNightMode`, Windows использует `FrameworkElement.RequestedTheme`. MAUI выставляет переопределение как свойство для чтения и записи `Application.Current.UserAppTheme`.

Пропуск любого из этих слоёв даёт вам версию тёмной темы "выглядит хорошо в симуляторе и сломано на телефоне пользователя". Остальная часть этой статьи — о том, как правильно соединить все три слоя, чтобы приложение MAUI реагировало так, как этого ожидают конвенции платформы.

## Определите светлые и тёмные ресурсы один раз в App.xaml

Самый чистый шаблон — держать каждое значение, чувствительное к теме, как `StaticResource` в `App.xaml`, а затем привязываться через `AppThemeBinding`. Размещение ресурсов на уровне приложения означает, что каждая страница видит одну и ту же палитру, и вы можете переименовать один ключ при изменении дизайн-системы.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<?xml version = "1.0" encoding = "UTF-8" ?>
<Application xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="HelloDarkMode.App">
    <Application.Resources>
        <ResourceDictionary>

            <!-- Light palette -->
            <Color x:Key="LightBackground">#FFFFFF</Color>
            <Color x:Key="LightSurface">#F5F5F7</Color>
            <Color x:Key="LightText">#0A0A0B</Color>
            <Color x:Key="LightAccent">#0066FF</Color>

            <!-- Dark palette -->
            <Color x:Key="DarkBackground">#0F1115</Color>
            <Color x:Key="DarkSurface">#1A1D23</Color>
            <Color x:Key="DarkText">#F2F2F2</Color>
            <Color x:Key="DarkAccent">#5B9BFF</Color>

            <Style TargetType="ContentPage" ApplyToDerivedTypes="True">
                <Setter Property="BackgroundColor"
                        Value="{AppThemeBinding Light={StaticResource LightBackground},
                                                Dark={StaticResource DarkBackground}}" />
            </Style>

            <Style TargetType="Label">
                <Setter Property="TextColor"
                        Value="{AppThemeBinding Light={StaticResource LightText},
                                                Dark={StaticResource DarkText}}" />
            </Style>

        </ResourceDictionary>
    </Application.Resources>
</Application>
```

`AppThemeBinding` — это форма расширения разметки класса `AppThemeBindingExtension` в `Microsoft.Maui.Controls.Xaml`. Оно предоставляет три значения: `Default`, `Light`, `Dark`. Парсер XAML обрабатывает `Default=` как свойство содержимого, поэтому `{AppThemeBinding Red, Light=Green, Dark=Blue}` — это законная сокращённая форма для "используй красный, если только система не светлая или тёмная". Когда системная тема меняется, MAUI обходит каждую привязку, нацеленную на `AppThemeBindingExtension`, переоценивает её и проталкивает новое значение через конвейер связываемых свойств. Вам не нужно писать никакого кода для обновления.

Для одноразовых значений, которые не заслуживают ключа ресурса, встраивайте цвета прямо в разметку:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Border Stroke="{AppThemeBinding Light=#DDD, Dark=#333}"
        BackgroundColor="{AppThemeBinding Light={StaticResource LightSurface},
                                          Dark={StaticResource DarkSurface}}">
    <Label Text="Hello, theme" />
</Border>
```

Для изображений то же расширение принимает ссылки на файлы:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Image Source="{AppThemeBinding Light=logo_light.png, Dark=logo_dark.png}"
       HeightRequest="48" />
```

## Применяйте темы из code-behind

Когда вы создаёте представления на C# или модифицируете их после конструирования, замените расширение разметки на расширения `SetAppThemeColor` и `SetAppTheme<T>` для `VisualElement`. Они находятся в `Microsoft.Maui.Controls` и ведут себя точно так же, как расширение разметки: они хранят два значения, оценивают текущую тему и переоценивают её при каждой смене темы.

```csharp
// .NET MAUI 11.0.0, .NET 11
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;

var label = new Label { Text = "Hello, theme" };
label.SetAppThemeColor(
    Label.TextColorProperty,
    light: Colors.Black,
    dark: Colors.White);

var image = new Image { HeightRequest = 48 };
image.SetAppTheme<FileImageSource>(
    Image.SourceProperty,
    light: "logo_light.png",
    dark: "logo_dark.png");
```

`SetAppTheme<T>` — это правильный вызов для любого значения, не являющегося `Color`. Оно работает с `FileImageSource`, `Brush`, `Thickness` и любым другим типом, который принимает целевое свойство. Нет отдельных `SetAppThemeBrush` или `SetAppThemeThickness`, потому что generic-версия покрывает их все.

## Определение и переопределение текущей темы

`Application.Current.RequestedTheme` возвращает разрешённое значение `AppTheme` в любой момент, учитывая как ОС, так и любое переопределение `UserAppTheme`. Обращайтесь к нему скупо: одна булевская переменная, хранимая на viewmodel и говорящая "сейчас мы в тёмной теме", почти всегда является признаком того, что вместо этого стоит использовать `AppThemeBinding`.

```csharp
// .NET MAUI 11.0.0, .NET 11
AppTheme current = Application.Current!.RequestedTheme;
bool isDark = current == AppTheme.Dark;
```

Переопределение темы — это внутриприложенческая контрчасть. `Application.Current.UserAppTheme` доступно для чтения и записи и принимает то же перечисление:

```csharp
// .NET MAUI 11.0.0, .NET 11
Application.Current!.UserAppTheme = AppTheme.Dark;     // force dark
Application.Current!.UserAppTheme = AppTheme.Light;    // force light
Application.Current!.UserAppTheme = AppTheme.Unspecified; // follow system
```

Сеттер вызывает `RequestedThemeChanged`, что означает, что каждая активная `AppThemeBinding` немедленно переоценивается. Вам не нужно перестраивать страницы, заменять словари ресурсов или вызывать сброс навигации.

Переопределение не переживает перезапуск приложения. Если вы хотите, чтобы выбор пользователя сохранялся между запусками, сохраняйте его через `Microsoft.Maui.Storage.Preferences`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public static class ThemeService
{
    private const string Key = "user_app_theme";

    public static void Apply()
    {
        var stored = (AppTheme)Preferences.Default.Get(Key, (int)AppTheme.Unspecified);
        Application.Current!.UserAppTheme = stored;
    }

    public static void Set(AppTheme theme)
    {
        Preferences.Default.Set(Key, (int)theme);
        Application.Current!.UserAppTheme = theme;
    }
}
```

Вызывайте `ThemeService.Apply()` из `App.OnStart` (или из конструктора `App` сразу после `InitializeComponent`), чтобы переопределение действовало до того, как отрисуется первое окно. Сохраняйте перечисление как `int`, потому что у `Preferences` нет типизированной перегрузки для произвольных перечислений на каждой платформе, а приведение через `int` переносимо.

## Уведомляйте свои viewmodel при смене темы

Когда вам нужно отреагировать на изменение темы в коде, например, чтобы заменить нарисованный вручную `GraphicsView` или передать другой цвет в `StatusBar`, подпишитесь на `Application.Current.RequestedThemeChanged`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public App()
{
    InitializeComponent();
    Application.Current!.RequestedThemeChanged += OnThemeChanged;
}

private void OnThemeChanged(object? sender, AppThemeChangedEventArgs e)
{
    AppTheme theme = e.RequestedTheme;
    UpdateStatusBar(theme);
    UpdateMapStyle(theme);
}
```

Обработчик события выполняется в главном потоке. `AppThemeChangedEventArgs.RequestedTheme` — это новая разрешённая тема, поэтому вам не нужно повторно считывать `Application.Current.RequestedTheme` внутри обработчика.

Если событие никогда не срабатывает на Android, у вашей `MainActivity` отсутствует флаг `UiMode`. Стандартный шаблон Visual Studio включает его, но я видел проекты, сделанные вручную, которые теряют его при миграции с Xamarin.Forms. Добавьте его:

```csharp
// .NET MAUI 11.0.0, .NET 11, Platforms/Android/MainActivity.cs
[Activity(
    Theme = "@style/Maui.SplashTheme",
    MainLauncher = true,
    LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges =
        ConfigChanges.ScreenSize |
        ConfigChanges.Orientation |
        ConfigChanges.UiMode |       // load-bearing for dark mode
        ConfigChanges.ScreenLayout |
        ConfigChanges.SmallestScreenSize |
        ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity { }
```

Без `ConfigChanges.UiMode` Android уничтожает и пересоздаёт activity при каждой смене темы системы, что означает, что MAUI видит свежую activity вместо обновления конфигурации, и событие `RequestedThemeChanged` не срабатывает из той же экземпляра `Application`. Видимый симптом — первое переключение работает, а последующие переключения ничего не делают, пока приложение не будет убито.

## Платформенная настройка, о которой никто не рассказывает

Поверхность MAUI в основном кроссплатформенная, но у тёмной темы есть маленькие платформо-специфичные ручки, которые легко пропустить.

**iOS / Mac Catalyst.** Если `Info.plist` содержит `UIUserInterfaceStyle` со значением `Light` или `Dark`, ОС жёстко блокирует приложение в этом режиме, и `Application.RequestedTheme` навсегда возвращает заблокированное значение. Стандартный шаблон MAUI не содержит этого ключа, что означает, что приложение следует за системой. Если вам нужно явно отказаться, используйте `Automatic`:

```xml
<!-- Platforms/iOS/Info.plist or Platforms/MacCatalyst/Info.plist -->
<key>UIUserInterfaceStyle</key>
<string>Automatic</string>
```

`Automatic` также является правильным значением, если предыдущий разработчик установил ключ в `Light`, чтобы что-то "починить", а затем забыл. Полное удаление ключа имеет тот же эффект.

**Android.** Помимо флага `ConfigChanges.UiMode`, единственное, что вам нужно проверить, — это что тема приложения наследуется от базы DayNight в `Platforms/Android/Resources/values/styles.xml`. Стандартный шаблон MAUI использует `Maui.SplashTheme` и `Maui.MainTheme`, оба из которых расширяют `Theme.AppCompat.DayNight.NoActionBar`. Если вы кастомизировали тему заставки, держите родителя на предке `DayNight`, иначе ваша заставка останется светлой навсегда, даже когда остальное приложение перейдёт в тёмную тему.

Для drawables, которым нужен тёмный вариант, помещайте их в `Resources/values-night/colors.xml` или используйте папки квалификаторов ресурсов `-night`. Всё, что проходит через `AppThemeBinding`, в этом не нуждается, но нативная графика заставки и иконки уведомлений — да.

**Windows.** Никаких изменений в `Package.appxmanifest` не требуется. Хост Windows-приложения читает тему системы через свойство `Application.RequestedTheme` приложения WinUI, и механика `AppThemeBinding` MAUI автоматически проходит через неё. Если вы найдёте только-Windows поверхность, которая не обновляется, вы можете принудительно сделать это, установив `MauiWinUIApplication.Current.MainWindow.Content` в свежий корень, но в 11.0.0 мне это не понадобилось.

## Строка состояния, заставка и другие нативные поверхности

Две вещи не покрываются `AppThemeBinding` и спотыкают почти каждый проект в первый раз:

- **Цвет текста и иконок строки состояния на Android и iOS** контролируется платформой, а не фоном страницы. На iOS установите `UIViewController.PreferredStatusBarStyle` для каждой страницы; на Android установите `Window.SetStatusBarColor` из `MainActivity`. Самый простой кроссплатформенный шаблон — поместить платформо-специфичный код за блок `ConditionalCompilation` в показанном выше обработчике `RequestedThemeChanged`.

- **Заставки** отрисовываются ОС до того, как MAUI загрузится, поэтому они не могут потреблять `AppThemeBinding`. Шаблон Android поставляет отдельные светлые и ночные цвета через `values/colors.xml` и `values-night/colors.xml`. iOS использует один storyboard запуска, поэтому вы либо выбираете нейтральный цвет, который работает в обоих режимах, либо предоставляете два storyboard через конфигурацию `LaunchStoryboard`.

Если вам нужно, чтобы пользовательский стиль карты, цветовая палитра графика или содержимое `WebView` следовали теме, делайте переключение в `RequestedThemeChanged`. Для карт в частности, [пошаговое руководство по кластеризации пинов на карте в MAUI 11](/ru/2026/04/dotnet-maui-11-map-pin-clustering/) показывает, как держать состояние элемента управления картой синхронизированным с переходами темы без перестроения рендерера.

## Пять подводных камней, которые съедят полдня

**1. `Page.BackgroundColor` не всегда обновляется при изменении `UserAppTheme`.** Известная проблема в [dotnet/maui#6596](https://github.com/dotnet/maui/issues/6596) означает, что некоторые свойства пропускают проход переоценки, когда вы устанавливаете `UserAppTheme` программно. Надёжный обходной путь — устанавливать фон страницы через `Setter` в `Style` (как в примере `App.xaml` выше), а не напрямую на элементе страницы. Сеттеры на основе стилей надёжно переоцениваются.

**2. `RequestedThemeChanged` срабатывает один раз и затем замолкает.** Это симптом [dotnet/maui#15350](https://github.com/dotnet/maui/issues/15350), и на Android это почти всегда отсутствие флага `ConfigChanges.UiMode`. На iOS эквивалентный симптом появляется, когда модальная страница находится в стеке в момент смены темы системы; закрытие и повторное открытие модального окна восстанавливает события. Подписаться один раз в `App.xaml.cs` и держать подписку живой — безопасный шаблон.

**3. `AppTheme.Unspecified` не всегда сбрасывается на ОС в iOS.** Как отслеживается в [dotnet/maui#23411](https://github.com/dotnet/maui/issues/23411), установка `UserAppTheme = AppTheme.Unspecified` после жёсткого переопределения иногда оставляет окно iOS застрявшим в предыдущем переопределении. Обходной путь в 11.0.0 — установить `UIWindow.OverrideUserInterfaceStyle = UIUserInterfaceStyle.Unspecified` из пользовательского `MauiUIApplicationDelegate` после того, как MAUI установит `UserAppTheme`. Несколько строк, и нужно только если ваше приложение предлагает переключатель "следовать за системой" в настройках.

**4. Пользовательские элементы управления, которые делают снимок цветов в конструкторе, навсегда остаются светлыми.** Если вы кэшируете значение `Color` в конструкторе вашего элемента управления (или в статическом поле), оно никогда не обновится. Считывайте значения темы лениво в `OnHandlerChanged` или связывайте их через конвейер связываемых свойств, чтобы механика `AppThemeBinding` MAUI могла переоценить их.

**5. Hot reload не всегда отражает изменения темы.** Когда вы переключаете симулятор или эмулятор со светлой на тёмную тему, пока приложение приостановлено, hot reload иногда отдаёт закэшированный ресурс. Принудительно делайте полную пересборку после переключения темы системы во время разработки. Это артефакт инструментария, а не баг `AppThemeBinding`, и диагностика реальных проблем становится намного проще, когда вы убираете это как переменную.

## Где тёмная тема встречается с остальной частью фреймворка

Тёмная тема — самая лёгкая возможность темизации, которую поставляет MAUI, и та, которую документация покрывает наиболее полно, но она взаимодействует с двумя другими частями фреймворка, которые вы, вероятно, тронете на той же неделе. Шаблон кастомизации обработчика из [как изменить цвет иконки SearchBar в .NET MAUI](/ru/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) — правильная форма, когда у вас есть элемент управления, чья нативная часть игнорирует `TextColor` в тёмной теме (`UISearchBar` в iOS — канонический нарушитель). Для тура по платформенной настройке статья [что нового в .NET MAUI 10](/ru/2025/04/whats-new-in-net-maui-10/) покрывает дополнения `Window` и `MauiWinUIApplication`, появившиеся в MAUI 10 и остающиеся правильными хуками в 11.0.0. Если вы упаковываете чувствительные к теме элементы управления в библиотеку классов, [как зарегистрировать обработчики в библиотеке MAUI](/ru/2023/11/maui-library-register-handlers/) проходит по механике `MauiAppBuilder`, включая правила порядка операций, которые определяют, когда обработчик видит разрешённую тему. И если ваша работа над тёмной темой происходит внутри сборки только для desktop, [настройка MAUI 11 только для Windows и macOS](/ru/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) показывает, как отбросить цели Android и iOS, чтобы вам нужно было отлаживать только две платформы вместо четырёх.

## Ссылки на источники

- [Respond to system theme changes - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/system-theme-changes?view=net-maui-10.0)
- [AppThemeBindingExtension Class - Microsoft.Maui.Controls.Xaml](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.xaml.appthemebindingextension)
- [Application.UserAppTheme Property - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.application.userapptheme?view=net-maui-9.0)
- [AppTheme Enum - Microsoft.Maui.ApplicationModel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.applicationmodel.apptheme)
- [Preferences - Microsoft.Maui.Storage](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences)
- [MAUI sample: Respond to system theme changes](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/userinterface-systemthemes/)
