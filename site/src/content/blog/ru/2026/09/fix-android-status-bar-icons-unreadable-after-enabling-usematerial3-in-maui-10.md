---
title: "Исправление: значки строки состояния Android нечитаемы после включения UseMaterial3 в .NET MAUI 10"
description: "MAUI 10.0.100 выбирает цвет значков строки состояния по colorPrimary, а его яркость противоположна яркости поверхности Material 3, поэтому получается белое на белом или чёрное на чёрном. Обновите Microsoft.Maui.Controls до 10.0.101 или новее либо сбросьте AppearanceLightStatusBars в MainActivity."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "android"
  - "material-3"
  - "csharp"
lang: "ru"
translationOf: "2026/09/fix-android-status-bar-icons-unreadable-after-enabling-usematerial3-in-maui-10"
translatedBy: "claude"
translationDate: 2026-09-29
---

Если ваше приложение на .NET MAUI 10 показывает белые значки часов и батареи на белой строке состояния в светлой теме и чёрные значки на чёрной строке состояния в тёмной теме сразу после того, как вы задали `<UseMaterial3>true</UseMaterial3>`, значит, у вас `Microsoft.Maui.Controls` 10.0.100. В этом релизе цвет значков строки состояния стали выбирать по яркости `colorPrimary` темы. Material 3 рисует `colorSurface` под прозрачной строкой состояния в режиме edge-to-edge, а основной цвет и цвет поверхности в Material 3 всегда имеют противоположную яркость, поэтому значки получаются инвертированными. Исправление: обновиться до 10.0.101 или новее (актуальная версия 10.0.110, выпущена 2026-09-22). Если обновиться пока нельзя, задайте `AppearanceLightStatusBars` самостоятельно в `MainActivity` после `base.OnCreate`. В .NET 11 RC 1 главное окно отображается нормально, но модальные страницы всё ещё страдают от бага; в RC 2 он исправлен.

## Ошибка в контексте

Исключения нет, в журнале тоже ничего. Симптом визуальный, и выглядит он так на Android 15, 16 и 17 с edge-to-edge (который .NET MAUI 10 включает для API 30+):

```text
// .NET 10, Microsoft.Maui.Controls 10.0.100, <UseMaterial3>true</UseMaterial3>
Light mode: status bar background near-white (Material 3 surface), icons and clock white
Dark mode:  status bar background near-black (Material 3 surface), icons and clock black
```

Отчёт об этой проблеме: [dotnet/maui#37705](https://github.com/dotnet/maui/issues/37705), с метками `i/regression` и `regressed-in-10.0.100`. Откат до 10.0.90 снова делает значки читаемыми, и это первая подсказка, что причина в изменении MAUI, а не в вашей теме.

Вот что делает каждая версия, судя по `WindowExtensions.cs` и обработчику окна на теге каждого релиза:

| Microsoft.Maui.Controls | Как выбирается цвет значков строки состояния | Результат в Material 3 |
| --- | --- | --- |
| 10.0.90 и ранее | День/ночь: светлая тема получает тёмные значки | Читаемо |
| 10.0.100 (2026-08-20) | Яркость `android:colorPrimary` | Инвертировано, нечитаемо |
| 10.0.101 (2026-09-07), 10.0.110 | Яркость `colorSurface` для Material 3, `colorPrimary` для Material 2 | Читаемо |
| 11.0 RC 1 | `colorPrimary`, затем перезапись через `Window.StatusBarTheme` (по умолчанию: день/ночь) только для главного окна | Главное окно читаемо, модальные страницы инвертированы |
| Ветка 11.0 RC 2 | То же, что в 10.0.101 | Читаемо |

## Почему значки инвертируются: colorPrimary и colorSurface

Android не позволяет приложению выбрать точный цвет значков строки состояния. Он предлагает булево значение: `WindowInsetsControllerCompat.AppearanceLightStatusBars`. Когда оно равно `true`, система считает фон строки состояния светлым и рисует тёмные значки. Когда `false`, рисует светлые значки.

До 10.0.90 MAUI выставлял этот флаг только по режиму день/ночь:

```csharp
// .NET MAUI 10.0.90, src/Core/src/Platform/Android/WindowExtensions.cs
var configuration = activity.Resources?.Configuration;
var isLightTheme = configuration is null ||
    (configuration.UiMode & UiMode.NightMask) != UiMode.NightYes;

windowInsetsController.AppearanceLightStatusBars = isLightTheme;
windowInsetsController.AppearanceLightNavigationBars = isLightTheme;
```

Это работает, когда то, что находится под строкой состояния, следует режиму день/ночь, и ломается, когда не следует. [dotnet/maui#32987](https://github.com/dotnet/maui/issues/32987) был вторым случаем: в приложении Material 2 со светлой темой и чёрным `colorPrimary` в панели приложения под строкой состояния значки получались тёмными на тёмной панели. Исправление для него, [dotnet/maui#36214](https://github.com/dotnet/maui/pull/36214), было слито 2026-07-01 и вошло в 10.0.100. Оно получает `android:colorPrimary` из текущей темы и использует его яркость:

```csharp
// .NET MAUI 10.0.100, src/Core/src/Platform/Android/WindowExtensions.cs
if (TryGetThemeColor(activity, global::Android.Resource.Attribute.ColorPrimary, out var statusBarColor))
    windowInsetsController.AppearanceLightStatusBars = IsLightColor(statusBarColor);
else
    windowInsetsController.AppearanceLightStatusBars = isLightTheme;

// ...
static bool IsLightColor(AColor color) =>
    ColorUtils.CalculateLuminance(color.ToArgb()) > 0.5;
```

Для панели приложения Material 2, закрашенной в `colorPrimary`, это правильно. Для Material 3 всё в точности наоборот. Когда включён `UseMaterial3`, MAUI переключает тему активности на `Maui.Material3.Theme.NoActionBar`, родитель которой `Theme.Material3.DayNight`. Собственные стили Material 3 в MAUI не переопределяют основной цвет, поэтому вы получаете базовую палитру Material 3. Material 3 ставит под строку состояния цвет поверхности, а не основной цвет, и палитра спроектирована так, чтобы основной цвет контрастировал с поверхностью:

| Тема | `colorPrimary` | Относительная яркость | 10.0.100 решает | Реальный фон |
| --- | --- | --- | --- | --- |
| Светлая | `#6750A4` | 0.11 (тёмный) | Светлые значки | Почти белая поверхность |
| Тёмная | `#D0BCFF` | 0.57 (светлый) | Тёмные значки | Почти чёрная поверхность |

Фиолетовый `#512BD4` из шаблона в `Platforms/Android/Resources/values/colors.xml` вас не спасает: этот цветовой ресурс используется темой Material 2 `Maui.MainTheme`, а не темой Material 3, и к тому же он тёмный (яркость 0.08). Любая светлая палитра Material 3 с насыщенным основным цветом приводит к тому же результату.

Исправление в 10.0.101, [dotnet/maui#37710](https://github.com/dotnet/maui/pull/37710), перенесённое в ветку SR10 как [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730), сохраняет идею с яркостью, но читает тот атрибут, который действительно находится под панелью:

```csharp
// .NET MAUI 10.0.101 and 10.0.110, src/Core/src/Platform/Android/WindowExtensions.cs
internal static bool GetStatusBarAppearance(Context context, bool isLightTheme, bool isMaterial3)
{
    // Material 3 draws its surface behind the transparent edge-to-edge status bar.
    // The Material 2 app bar uses colorPrimary in the same area.
    var backgroundAttribute = isMaterial3
        ? Resource.Attribute.colorSurface
        : global::Android.Resource.Attribute.ColorPrimary;

    return TryGetThemeColor(context, backgroundAttribute, out var backgroundColor)
        ? IsLightColor(backgroundColor)
        : isLightTheme;
}
```

## Минимальный пример воспроизведения

Начните со шаблона по умолчанию и зафиксируйте затронутый пакет:

```xml
<!-- .NET 10 SDK, dotnet new maui, MyApp.csproj -->
<PropertyGroup>
  <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.100" />
</ItemGroup>
```

Запустите приложение на эмуляторе Android 11 (API 30) или новее. На главной странице в светлой теме значки строки состояния белые. Переключите эмулятор в тёмный режим, перезапустите приложение, и они станут чёрными. Замените `10.0.100` на `10.0.90`, и оба режима будут читаемы. Замените на `10.0.110`, и оба режима снова читаемы.

Если хотите проверить, что именно решил MAUI, а не щуриться на эмулятор, выведите флаг в журнал после запуска:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
protected override void OnResume()
{
    base.OnResume();
    var controller = AndroidX.Core.View.WindowCompat.GetInsetsController(Window!, Window!.DecorView);
    Android.Util.Log.Info("StatusBar", $"AppearanceLightStatusBars={controller.AppearanceLightStatusBars}");
}
```

В светлой теме на 10.0.100 вы увидите `False`, то есть "фон тёмный, рисуй светлые значки", поверх почти белой поверхности.

## Исправление 1: обновите Microsoft.Maui.Controls до 10.0.101 или новее

Это настоящее исправление, и это патч-релиз той же линии .NET 10, поэтому целевой фреймворк менять не нужно. Задайте версию явно, а не полагайтесь на `$(MauiVersion)` из той рабочей нагрузки, которая установлена на сборочной машине:

```xml
<!-- .NET 10, MyApp.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
</ItemGroup>
```

Изменённый код находится в `Microsoft.Maui.Core`, который `Microsoft.Maui.Controls` подтягивает той же версии. Если ваш проект также напрямую ссылается на `Microsoft.Maui.Core` или `Microsoft.Maui.Controls.Compatibility`, поднимите их до той же версии, иначе NuGet может разрешить смешанный набор. Команда `dotnet list package --include-transitive` покажет, что вы получили на самом деле.

Затем выполните очистку и пересборку. Изменения ресурсов и тем Android легко пропустить при инкрементальном развёртывании, поэтому один раз удалите приложение с устройства (`adb uninstall com.companyname.myapp`), прежде чем оценивать результат.

В 10.0.110 также есть исправление для [UIKitThreadAccessException из MediaPicker.PickPhotosAsync](/ru/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/), ещё одной регрессии 10.0.100, так что оставаться на 10.0.100 нет особых причин. Одна оговорка в обратную сторону: в 10.0.101 и 10.0.110 есть проблема Resizetizer со [значками приложения в формате SVG, использующими элементы filter или text](/ru/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/). Проверьте свой значок, прежде чем обновлять релизную ветку.

## Исправление 2: сбросьте AppearanceLightStatusBars в MainActivity

Если вы пока зафиксированы на 10.0.100, переопределите флаг самостоятельно. `MauiAppCompatActivity.OnCreate` вызывает `CreatePlatformWindow`, который подключает `WindowHandler`, а тот запускает `ConfigureTranslucentSystemBars` и записывает неверное значение. Всё это происходит внутри `base.OnCreate`, поэтому всё, что вы зададите после этого вызова, побеждает для главного окна:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
using Android.App;
using Android.Content.PM;
using Android.Content.Res;
using Android.OS;
using AndroidX.Core.View;

namespace MyApp;

[Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                           ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity
{
    protected override void OnCreate(Bundle? savedInstanceState)
    {
        // MAUI sets the status bar appearance inside base.OnCreate. Correct it afterwards.
        base.OnCreate(savedInstanceState);
        ApplyStatusBarIconContrast(Resources?.Configuration);
    }

    public override void OnConfigurationChanged(Configuration newConfig)
    {
        base.OnConfigurationChanged(newConfig);
        ApplyStatusBarIconContrast(newConfig);
    }

    void ApplyStatusBarIconContrast(Configuration? configuration)
    {
        // MAUI only configures edge-to-edge system bars on API 30+, so mirror that.
        if (!OperatingSystem.IsAndroidVersionAtLeast(30) || Window is null)
            return;

        var isNight = configuration is not null &&
            (configuration.UiMode & UiMode.NightMask) == UiMode.NightYes;

        // true means "light background": Android draws dark icons.
        WindowCompat.GetInsetsController(Window, Window.DecorView)
            .AppearanceLightStatusBars = !isNight;
    }
}
```

Это восстанавливает поведение 10.0.90. Переопределение `OnConfigurationChanged` важно, потому что `ConfigurationChanges` в шаблоне включает `ConfigChanges.UiMode`: когда пользователь переключает системную тему, Android не пересоздаёт активность, а MAUI 10 выставляет флаг только при подключении обработчика окна. Без этого переопределения значки сохраняют цвет предыдущего режима до следующего холодного запуска.

Удалите это переопределение, когда перейдёте на 10.0.101 или новее. Встроенное исправление выводит флаг из вашего реального `colorSurface`, что точнее, чем день/ночь, если вы настраиваете цвет поверхности.

## Исправление 3: в .NET 11 используйте Window.StatusBarTheme

В .NET 11 добавили `Window.StatusBarTheme` ([dotnet/maui#34903](https://github.com/dotnet/maui/pull/34903)), перечисление со значениями `Default`, `Light` и `Dark`. В RC 1 `WindowHandler.ConnectHandler` вызывает `ConfigureTranslucentSystemBars` (в котором всё ещё есть логика с `colorPrimary`) и сразу после этого применяет `StatusBarTheme`. `Default` откатывается к режиму день/ночь, поэтому главное окно приложения на .NET 11 RC 1 читаемо без каких-либо ваших действий.

Модальные страницы устроены иначе. `ModalNavigationManager` показывает каждую модальную страницу в собственном окне-диалоге и вызывает для него `ConfigureTranslucentSystemBars`, но после этого не применяет `StatusBarTheme`. Поэтому в RC 1 страница, которую вы открываете через `Navigation.PushModalAsync`, снова получает инвертированные значки. Исправление есть в ветке `release/11.0.1xx-rc2`, так что RC 2 решает обе проблемы.

`StatusBarTheme` также подходит, когда на вашей странице под строкой состояния находится не поверхность, а что-то другое, например тёмное изображение-баннер в светлой теме:

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, App.xaml.cs
protected override Window CreateWindow(IActivationState? activationState)
{
    var window = new Window(new AppShell());

    // Light = light status bar background, so Android draws dark icons.
    window.SetAppTheme(Window.StatusBarThemeProperty, StatusBarTheme.Light, StatusBarTheme.Dark);

    return window;
}
```

Или для отдельной страницы, когда одному экрану нужны светлые значки над тёмным заголовком: задайте значение в окне страницы и верните обратно, когда страница уходит:

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, HeroPage.xaml.cs
protected override void OnAppearing()
{
    base.OnAppearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Dark;
}

protected override void OnDisappearing()
{
    base.OnDisappearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Default;
}
```

Обратите внимание на именование: `StatusBarTheme` описывает панель, а не значки. `Dark` означает "панель тёмная", что даёт светлые значки, по тому же соглашению, что и `AppearanceLightStatusBars`.

## Подводные камни и похожие проблемы

**Приложения Material 2 могут столкнуться с зеркальной проблемой.** 10.0.101 и 10.0.110 по-прежнему определяют строку состояния Material 2 по `colorPrimary`, и это сделано намеренно, потому что панель приложения Material 2 закрашена в этот цвет. Если ваше приложение Material 2 скрывает панель навигации (`Shell.NavBarIsVisible="False"`) и показывает белую страницу под строкой состояния, а `colorPrimary` тёмный, код выберет светлые значки поверх белого. Это следует из того же исходного кода и не отслеживается как баг, поскольку в макете Material 2 по умолчанию панель приложения находится под строкой состояния. Переопределение `MainActivity` из исправления 2 решает и этот случай.

**Значки панели навигации не затронуты.** Все перечисленные выше версии по-прежнему выставляют `AppearanceLightNavigationBars` по режиму день/ночь. Если жестовая полоска или трёхкнопочная панель нечитаемы, это другая проблема, обычно связанная с содержимым, нарисованным под панелью после [изменений edge-to-edge в API 36](/ru/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).

**На Android 10 и старше всё выглядит нормально.** MAUI выполняет этот код только на API 30 и выше. Ниже обработчик окна никогда не вызывает `ConfigureTranslucentSystemBars`, поэтому тестирование на старом эмуляторе баг не воспроизведёт.

**Установка цвета строки состояния ничего не даёт на Android 15+.** Типичная первая реакция: вызвать `Window.SetStatusBarColor(...)` из `MainActivity`. В приложениях с целевым API 35 и выше, работающих на Android 15 и новее, edge-to-edge принудителен, и этот вызов игнорируется. Панель остаётся прозрачной, поэтому единственный рычаг, который здесь имеет значение, это флаг внешнего вида значков.

**Дело не в настройке тёмной темы.** Если значки неверны только после смены `Application.Current.UserAppTheme` во время выполнения и верны после холодного запуска, это отсутствие повторного применения, описанное в исправлении 2, а не данная регрессия. [Правильная поддержка тёмной темы в приложении MAUI](/ru/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) рассматривает остальные нативные поверхности, которые не следуют за `AppThemeBinding`.

## Связанные материалы

- [.NET MAUI 10 SR6 завершает Material 3 на Android за единым флагом UseMaterial3](/ru/2026/05/maui-10-material-3-android-usematerial3-flag/) объясняет, что меняет этот флаг и какие элементы управления он стилизует.
- [Миграция приложения .NET MAUI для Android на целевой уровень API 36](/ru/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/): об изменениях edge-to-edge и безопасной области, которые вообще делают строку состояния прозрачной.
- [Правильная поддержка тёмной темы в приложении MAUI](/ru/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/): о цветах, учитывающих тему, и реакции на `RequestedThemeChanged`.
- [Исправление: .NET MAUI Resizetizer MissingMethodException (MAUIR0001) на SVG-значке приложения](/ru/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/) перед обновлением до 10.0.101 или 10.0.110.

## Источники

- [dotnet/maui#37705: Status bar icons become unreadable when UseMaterial3 is enabled in 10.0.100](https://github.com/dotnet/maui/issues/37705)
- [dotnet/maui#36214: Fix status bar icon contrast with custom colorPrimary](https://github.com/dotnet/maui/pull/36214) (изменение, внёсшее регрессию)
- [dotnet/maui#37710: Fix Material 3 status bar icon contrast](https://github.com/dotnet/maui/pull/37710) и бэкпорт в 10.0.101 [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730)
- [dotnet/maui#34903: Add Window.StatusBarTheme](https://github.com/dotnet/maui/pull/34903)
- [`WindowExtensions.cs` на теге 10.0.100](https://github.com/dotnet/maui/blob/10.0.100/src/Core/src/Platform/Android/WindowExtensions.cs) и [на теге 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/WindowExtensions.cs)
- [`styles-material3.xml` на теге 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/Resources/values/styles-material3.xml)
- [WindowInsetsControllerCompat.setAppearanceLightStatusBars (Android Developers)](https://developer.android.com/reference/androidx/core/view/WindowInsetsControllerCompat#setAppearanceLightStatusBars(boolean))
- [Microsoft.Maui.Controls на NuGet](https://www.nuget.org/packages/Microsoft.Maui.Controls) для дат релизов
