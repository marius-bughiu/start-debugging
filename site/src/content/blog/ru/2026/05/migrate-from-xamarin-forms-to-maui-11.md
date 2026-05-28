---
title: "Миграция с Xamarin.Forms 5.0 на .NET MAUI 11: полный чек-лист"
description: "Сквозная миграция с Xamarin.Forms 5.0 на .NET MAUI 11 GA на net11.0: переписывание csproj, преобразование пользовательских рендереров в хендлеры, подключение AppShell, удаление DependencyService, отказ от MessagingCenter, ресурсы Resizetizer и подводные камни, которые бьют по реальной продакшен-кодовой базе."
pubDate: 2026-05-28
updatedDate: 2026-05-28
tags:
  - "migration"
  - "xamarin"
  - "xamarin-forms"
  - "maui"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/migrate-from-xamarin-forms-to-maui-11"
translatedBy: "claude"
translationDate: 2026-05-28
---

Xamarin.Forms вышел из поддержки 2024-05-01, и с тех пор Microsoft не выпустила ни одного исправления. .NET MAUI 11 — это LTS-точка приземления для каждого приложения на Xamarin.Forms 5.0, живущего в долг по времени, и с релиза MAUI 11.0 GA в ноябре 2025 года платформа наконец-то получила инфраструктуру рендеринга, производительность `RecyclerView` и поддержку iOS 18 / Android 15, которых не хватало ранним выпускам MAUI. Сфокусированная миграция одним разработчиком среднего приложения, от десяти до двадцати экранов с горсткой пользовательских рендереров, занимает от одной до трёх недель. Сложные части — это не XAML и не система сборки; это пользовательские рендереры, `DependencyService` и любой код, напрямую обращавшийся к платформенным проектам. Этот пост фиксирует `Xamarin.Forms 5.0.0.2622` как источник и `.NET MAUI 11.0.0` на `net11.0` как цель, с `net11.0-android35.0`, `net11.0-ios18.0` и `net11.0-maccatalyst18.0` как активными TFM.

Откат нетривиален: как только `.csproj` переключится на SDK-стиль с `Microsoft.NET.Sdk` и `UseMaui=true`, вы не вернётесь к Xamarin.Forms-проекту-обёртке без восстановления исходного csproj и `packages.config` из системы контроля версий. Относитесь к миграции как к поездке в один конец и формируйте ветки соответственно.

## Зачем мигрировать сейчас

- Xamarin.Forms не поддерживается. Нет патчей под подъём target SDK Android 15, который Google Play начал требовать с 2025-08-31, а Apple теперь отклоняет в App Store Connect сборки, слинкованные со старым SDK iOS 17.
- MAUI 11 по умолчанию запускается на CoreCLR для Android и iOS, а не на Mono. Холодный старт на Pixel 8 падает примерно с 1.6 s до 0.9 s на типовом Shell-приложении, а аллокации в установившемся режиме снижаются, потому что GC — генерационный, а не `SGen`. Переключение описано в [нашей статье про CoreCLR по умолчанию в MAUI](/ru/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- Архитектура хендлеров заменяет пользовательские рендереры на более узкий API и избавляет от навесных конструкций `Effect` плюс `PlatformEffect`, которые накопились в Xamarin.Forms за годы.
- Resizetizer встроен. Конвейер `Resources/Images/*.svg` генерирует платформенные PNG на этапе сборки, так что вы наконец удаляете зоопарк из `drawable-xhdpi`, `drawable-xxhdpi`, `Assets.xcassets` и `LaunchScreen.storyboard`.

## Что ломается

| Область                  | Изменение                                                                       | Серьёзность |
| ------------------------ | ------------------------------------------------------------------------------- | ----------- |
| Структура проекта        | Общий проект плюс три head-проекта сжимаются в один csproj SDK-стиля            | высокая     |
| Пространство `Xamarin.Forms` | Заменено на `Microsoft.Maui.Controls`, `Microsoft.Maui.Graphics` и др.      | высокая     |
| Пользовательские рендереры | `ExportRenderer` и `IVisualElementRenderer` удалены. Используйте хендлеры     | высокая     |
| `DependencyService`      | Удалён. Используйте `Microsoft.Extensions.DependencyInjection`                  | высокая     |
| `MessagingCenter`        | Помечен устаревшим и запланирован к удалению. Используйте [`IMessenger` из CommunityToolkit.Mvvm](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) | высокая |
| `Application.Properties` | Удалён. Используйте `Microsoft.Maui.Storage.Preferences`                        | средняя     |
| `ListView`               | Обёртка над `CollectionView`. Лучше мигрировать, см. [руководство по переходу с ListView на CollectionView](/ru/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) | средняя |
| `MasterDetailPage`       | Переименован в `FlyoutPage`. XAML нужно обновить                                | низкая      |
| `Frame`                  | Мягко устарел. Используйте `Border` плюс `StrokeShape`                          | низкая      |
| `OpenGLView`             | Полностью удалён                                                                | низкая      |
| `MainActivity` Android   | Делится на `MainActivity.cs` плюс `MainApplication.cs`, оба partial             | средняя     |
| `AppDelegate` iOS        | Заменяет `FormsApplicationDelegate` на `MauiUIApplicationDelegate`              | средняя     |
| `App.xaml.cs`            | `Application.MainPage` работает в MAUI 11, но Shell-first — новый дефолт        | низкая      |
| Таргетинг                | `MonoAndroid12.0`, `Xamarin.iOS10` ушли. Только `net11.0-android35.0`           | высокая     |

Upstream upgrade assistant поставляется как `dotnet tool` и покрывает заметную часть переписывания пространств имён и конвертации файла проекта. Он не справляется с пользовательскими рендерерами и регистрациями `DependencyService`, а именно там и уходит реальное время.

## Предполётный чек-лист

1. Установите SDK .NET 11 и workloads MAUI. Проверьте через `dotnet workload list`. Вам нужны `maui`, `maui-android`, `maui-ios` и `maui-maccatalyst`, все версии `11.0.x`.

   ```bash
   # .NET 11.0
   dotnet workload install maui
   dotnet workload list
   ```

2. Зафиксируйте SDK в `global.json`, чтобы ветка миграции не поползла вперёд посреди PR:

   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```

3. Пометьте текущую сборку Xamarin.Forms в системе контроля версий. `git tag pre-maui-migration` достаточно. Если миграция уйдёт не туда на второй неделе, вы хотите чистую точку восстановления.
4. Сделайте снимок платформенных ресурсов. Пройдитесь по папкам `Drawable*`, `Assets.xcassets`, storyboard-ам splash и записям Info.plist / AndroidManifest.xml. Resizetizer перестраивает всё это дерево, и вам нужна опись «до» на случай, если какой-то ресурс потеряется.
5. Соберите инвентарь регистраций `DependencyService`. `grep -rn "DependencyService\\|Dependency(typeof" .` вернёт исчерпывающий список. Каждый превратится в вызов `services.AddSingleton` или `services.AddTransient`.
6. Соберите инвентарь пользовательских рендереров. Грепните `ExportRenderer` и прочитайте каждый. Часть можно удалить как есть (дефолты MAUI лучше дефолтов Xamarin.Forms), часть станет хендлерами, часть — `Behaviors`.
7. Запустите `dotnet test` на дереве Xamarin.Forms и сохраните зелёную базу. Миграция, добавляющая три тестовые регрессии, диагностируется куда проще, чем миграция, приземляющаяся на кодовую базу с пятью flaky-тестами.

## Шаги миграции

1. **Сначала прогоните upgrade assistant по общему проекту.** Он переписывает csproj в SDK-стиль, обновляет самые очевидные пространства имён (`Xamarin.Forms` → `Microsoft.Maui.Controls`) и помечает места рендереров и `DependencyService`, с которыми не справился.

   ```bash
   # .NET 11
   dotnet tool install -g upgrade-assistant
   upgrade-assistant upgrade ./src/MyApp/MyApp.csproj --target-tfm net11.0
   ```

   Проверка: `dotnet restore` успешно отрабатывает на новом csproj, а `git status` показывает ожидаемые переписывания. Пока не запускайте на head-проектах; вы их сейчас удалите.

2. **Сожмите head-проекты в один csproj SDK-стиля.** Xamarin.Forms поставляется как один общий проект плюс `MyApp.Android`, `MyApp.iOS` и опционально `MyApp.UWP` head-проекты. MAUI поставляется одним csproj с мульти-таргетингом. Перенесите Android-специфичный код в `Platforms/Android/`, iOS-специфичный — в `Platforms/iOS/` и удалите head-csproj-ы. Заголовок нового csproj выглядит так:

   ```xml
   <!-- src/MyApp/MyApp.csproj, .NET MAUI 11, net11.0 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFrameworks>net11.0-android35.0;net11.0-ios18.0;net11.0-maccatalyst18.0</TargetFrameworks>
       <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
       <OutputType>Exe</OutputType>
       <UseMaui>true</UseMaui>
       <SingleProject>true</SingleProject>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
       <RootNamespace>MyApp</RootNamespace>
       <ApplicationId>net.mycompany.myapp</ApplicationId>
       <ApplicationDisplayVersion>1.0</ApplicationDisplayVersion>
       <ApplicationVersion>1</ApplicationVersion>
     </PropertyGroup>
   </Project>
   ```

   Проверка: `dotnet build -t:Restore` успешен, и проект загружается в Visual Studio 2026 17.14 или Rider 2026.1 без предупреждений «unsupported project type».

3. **Перепишите `App.xaml.cs` под использование `MauiProgram.CreateMauiApp`.** Xamarin.Forms стартовал в `MainActivity.OnCreate` через `LoadApplication(new App())`. MAUI передаёт это `MauiAppBuilder`. Точка входа становится такой:

   ```csharp
   // MauiProgram.cs, .NET MAUI 11, C# 14
   using Microsoft.Extensions.Logging;
   using Microsoft.Maui.Hosting;

   namespace MyApp;

   public static class MauiProgram
   {
       public static MauiApp CreateMauiApp()
       {
           var builder = MauiApp.CreateBuilder();
           builder
               .UseMauiApp<App>()
               .ConfigureFonts(fonts =>
               {
                   fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                   fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
               });

           builder.Services.AddSingleton<IAuthService, AuthService>();
           builder.Services.AddTransient<MainPageViewModel>();

           return builder.Build();
       }
   }
   ```

   Проверка: `dotnet build -f net11.0-android35.0` выходит с 0, IDE разрешает `MauiProgram` из любого конструктора страницы.

4. **Конвертируйте каждую регистрацию `DependencyService` в `IServiceCollection`.** Это механика, но обязательная; `DependencyService.Get<T>()` в MAUI 11 исчез. Замена:

   ```csharp
   // Before, Xamarin.Forms 5.0
   DependencyService.Register<IAuthService, AuthService>();
   var auth = DependencyService.Get<IAuthService>();

   // After, .NET MAUI 11
   // Registration moves to MauiProgram.CreateMauiApp (step 3).
   // Resolution moves to the constructor or to IPlatformApplication.Current.Services.
   public partial class MainPage : ContentPage
   {
       public MainPage(IAuthService auth) // injected
       {
           InitializeComponent();
       }
   }
   ```

   Там, где внедрение через конструктор непрактично (статический хелпер, хендлер `AppShell`), `IPlatformApplication.Current!.Services.GetRequiredService<IAuthService>()` — это аварийный выход.

   Проверка: `grep -rn "DependencyService" src/` возвращает ноль совпадений. CI падает, если это не так.

5. **Замените пользовательские рендереры на хендлеры.** Это самый трудоёмкий шаг. Пользовательский рендерер Xamarin.Forms, переопределявший `OnElementPropertyChanged`, превращается в [MAUI-хендлер со словарём `Mapper`](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize). Пример — рендерер, убирающий подчёркивание из Android-`Entry`:

   ```csharp
   // .NET MAUI 11, C# 14
   // Platforms/Android/EntryHandlerCustomization.cs
   using Microsoft.Maui.Handlers;

   public static class EntryHandlerCustomization
   {
       public static void Apply()
       {
           EntryHandler.Mapper.AppendToMapping("NoUnderline", (handler, entry) =>
           {
               handler.PlatformView.BackgroundTintList =
                   Android.Content.Res.ColorStateList.ValueOf(
                       Android.Graphics.Color.Transparent);
           });
       }
   }
   ```

   Зарегистрируйте кастомизацию в `MauiProgram.CreateMauiApp` через `builder.ConfigureMauiHandlers(...)` или вызовите `Apply()` из `partial void` в `MauiProgram`, чтобы он запускался только на Android. Тот же шаблон сохраните для iOS в `Platforms/iOS/`.

   Проверка: каждая страница, зависевшая от старого рендерера, корректно рисуется в `dotnet build -t:Run -f net11.0-android35.0`. Визуальный smoke-тест, а не только успешная сборка.

6. **Откажитесь от `MessagingCenter` в пользу messenger из CommunityToolkit.** `MessagingCenter` помечен устаревшим в MAUI 11 и запланирован к удалению в MAUI 12. Возьмите `CommunityToolkit.Mvvm` 8.4.0 или выше:

   ```bash
   # .NET MAUI 11
   dotnet add package CommunityToolkit.Mvvm --version 8.4.0
   ```

   Смена шаблона:

   ```csharp
   // Before, Xamarin.Forms 5.0
   MessagingCenter.Subscribe<LoginViewModel>(this, "LoggedIn", _ => RefreshUi());
   MessagingCenter.Send(this, "LoggedIn");

   // After, .NET MAUI 11 with CommunityToolkit.Mvvm 8.4.0
   public sealed record LoggedInMessage;
   WeakReferenceMessenger.Default.Register<LoggedInMessage>(this, (r, m) => RefreshUi());
   WeakReferenceMessenger.Default.Send(new LoggedInMessage());
   ```

   `WeakReferenceMessenger` устраняет баги жизненного цикла, из-за которых `MessagingCenter` тёк в долгоживущих shell-приложениях.

7. **Переведите ресурсы на Resizetizer.** Удалите `Resources/drawable-*`, `Assets.xcassets` и продублированные splash-экраны. Положите один `appicon.svg` и один `splash.svg` в `Resources/AppIcon/` и `Resources/Splash/`. csproj уже знает о них через элементы `MauiIcon` и `MauiSplashScreen`, которые сгенерировал upgrade assistant. Ресайз на этапе сборки заменяет всю лестницу плотностей.

   ```xml
   <!-- src/MyApp/MyApp.csproj fragment -->
   <ItemGroup>
     <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
     <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
     <MauiImage Include="Resources\Images\*" />
     <MauiFont Include="Resources\Fonts\*" />
   </ItemGroup>
   ```

   Проверка: `dotnet build -f net11.0-android35.0` производит `bin/Debug/net11.0-android35.0/Resources/drawable-xxhdpi/appicon.png` без вашего ручного вмешательства.

8. **Обновите Android `MainActivity` и `MainApplication`.** В Xamarin.Forms был один `MainActivity`, наследовавший `FormsAppCompatActivity`. MAUI делит это на `MainActivity` плюс `MainApplication`:

   ```csharp
   // Platforms/Android/MainActivity.cs, .NET MAUI 11
   using Android.App;
   using Android.Content.PM;
   using Android.OS;

   namespace MyApp;

   [Activity(Theme = "@style/Maui.SplashTheme",
             MainLauncher = true,
             ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation |
                                    ConfigChanges.UiMode | ConfigChanges.ScreenLayout |
                                    ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity { }

   // Platforms/Android/MainApplication.cs, .NET MAUI 11
   [Application]
   public class MainApplication : MauiApplication
   {
       public MainApplication(IntPtr handle, Android.Runtime.JniHandleOwnership ownership)
           : base(handle, ownership) { }

       protected override MauiApp CreateMauiApp() => MyApp.MauiProgram.CreateMauiApp();
   }
   ```

   На iOS эквивалент — один `AppDelegate`, наследующий `MauiUIApplicationDelegate`. Шаблон тот же: переопределите `CreateMauiApp` и вызовите общий `MauiProgram`.

9. **Конвертируйте XAML-пространства имён.** Каждый `xmlns="http://xamarin.com/schemas/2014/forms"` становится `xmlns="http://schemas.microsoft.com/dotnet/2021/maui"`. Upgrade assistant обрабатывает большую часть, но файлы со смешанными пространствами имён (библиотеки пользовательских контролов, подтягивавшие `xamarin.toolkit`) требуют ручного обхода. `Frame` ещё один релиз работает, но выдаёт предупреждение сборки. Запланируйте замену на `Border` плюс `StrokeShape="RoundRectangle 12"` и `BackgroundColor`. `MasterDetailPage` нужно переименовать в `FlyoutPage` и в XAML, и в code-behind, включая любые `x:TypeArguments`.

10. **Проведите аудит перехода с `Application.Properties` на `Preferences`.** Любой код, писавший `Application.Current.Properties["key"] = value`, должен перейти на `Preferences.Set("key", value)` из `Microsoft.Maui.Storage`. Форма похожа, но бэкенд хранилища отличается, поэтому при первом запуске может понадобиться разовая копия. Сделайте копирование идемпотентным с флагом `"migrated_to_preferences"`, чтобы оно не запускалось повторно.

11. **Зафиксируйте каждую зависимость NuGet на MAUI-совместимой версии.** После апгрейда запустите `dotnet list package --vulnerable` и `dotnet list package --outdated`. Типичные подозреваемые: `Xamarin.Essentials` (исчез, влит в MAUI), `Xamarin.Forms.Maps` (заменён на `Microsoft.Maui.Controls.Maps`), `Xamarin.Forms.Visual.Material` (заменён стилями Material 3 из MAUI, см. [статью про Material 3 в MAUI 10](/ru/2026/05/maui-10-material-3-android-usematerial3-flag/)).

## Проверка

После шагов выше:

- `dotnet restore` выходит с 0 на чистом клоне миграционной ветки.
- `dotnet build -f net11.0-android35.0` и `-f net11.0-ios18.0` оба выходят с 0.
- Проект юнит-тестов, перенацеленный на `net11.0`, запускает `dotnet test` в чистый зелёный.
- `dotnet build -t:Run -f net11.0-android35.0` запускает приложение в эмуляторе и доходит до первой страницы без необработанного исключения.
- Ручной smoke-тест на реальном устройстве каждой страницы, содержавшей пользовательский рендерер в дереве Xamarin.Forms.
- Сравните время холодного старта до и после, замеряя секундомером от касания иконки лаунчера до первого кадра. CoreCLR плюс AOT должны увести среднее приложение под секунду на среднестатистическом Android-устройстве 2024 года. Если просели — перепроверьте шаг 5; чаще всего виноват хендлер, делающий layout-работу синхронно в UI-потоке.

## План отката

После переписывания csproj автоматизированного отката нет. Реалистичный план:

1. Сохраните git-тег `pre-maui-migration` из предполётного чек-листа.
2. Держите миграцию в отдельной ветке до тех пор, пока проверка не станет зелёной и на Android, и на iOS.
3. Если придётся откатывать уже после слияния в main, безопасный путь — `git revert` коммита слияния, затем чистое восстановление дерева Xamarin.Forms и редеплой. Никакого in-place «даунгрейда» csproj SDK-стиля обратно в legacy-схему общего проекта не существует.

Если ваше окно релиза не терпит миграции в один конец, выкатите MAUI-сборку как приложение с параллельным ID (`net.mycompany.myapp.maui`) в магазинах на один цикл, добейтесь crash-free-доли выше 99.5 % на продакшен-трафике и затем переключите bundle ID принудительным обновлением.

## Подводные камни, на которые мы наступили

- **Android resource shrinking уносит ваши шрифты.** `Resources/Fonts/OpenSans-Regular.ttf` после ресайз-переименования оказывается в `Resources/font/opensans_regular.ttf`. Resource shrinker из R8 радостно удаляет шрифты, которые из XAML выглядят неиспользуемыми. Исправляется явным добавлением `<MauiAsset Include="Resources/Fonts/**/*.ttf" />` и отключением shrinking-а до следующего релиза: `<AndroidLinkResources>false</AndroidLinkResources>` только в Debug.
- **`UIRequiredDeviceCapabilities` в iOS `Info.plist` требует `arm64`.** Переход с Mono на CoreCLR поставляет только ARM64-бинарники. Если `Info.plist` всё ещё перечисляет `armv7`, App Store Connect отклонит загрузку.
- **Markup-расширение `OnPlatform` ведёт себя иначе для `Default`**. В Xamarin.Forms неуказанный `Default` падал в платформенное значение. В MAUI 11 `Default` должен быть задан явно, когда используется как markup-расширение. Добавьте значение `Default` или переключитесь на элементную форму `<OnPlatform>`.
- **`Frame` внутри `Grid` схлопывается до нулевой высоты.** Замена `Border` не наследует дефолт `HorizontalOptions="Fill"` от `Frame`. Будьте явны: `HorizontalOptions="Fill" VerticalOptions="Fill"`.
- **`Microsoft.Maui.Controls.Compatibility` не бесплатен.** Он существует и позволяет держать живыми один-два упрямых рендерера, пока вы дотягиваете миграцию, но каждая ссылка на `Compatibility` сохраняет legacy-цепочку рендереров в сборке и съедает часть выигрыша по холодному старту от CoreCLR. Используйте как мостик, не как конечную точку.

## Связанное

- [Миграция высокопроизводительного ListView из Xamarin.Forms на CollectionView в MAUI](/ru/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/)
- [Миграция с .NET 8 на .NET 11: полный чек-лист](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [Миграция с .NET Framework 4.8 на .NET 11 в 2026 году](/ru/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [MAUI vs Avalonia vs Uno в 2026 году](/ru/2026/05/maui-vs-avalonia-vs-uno-in-2026/)
- [Flutter vs React Native vs MAUI для нового мобильного проекта в 2026 году](/ru/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)

## Источники

- [.NET MAUI upgrade from Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) на MS Learn.
- [Документация хендлеров .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) по замене рендереров.
- [Release notes .NET MAUI 11.0](https://github.com/dotnet/maui/releases) на GitHub.
- [`Microsoft.Maui.Storage.Preferences`](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences) в качестве замены `Application.Properties`.
- [Гайд по messenger из CommunityToolkit.Mvvm](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) в качестве замены `MessagingCenter`.
