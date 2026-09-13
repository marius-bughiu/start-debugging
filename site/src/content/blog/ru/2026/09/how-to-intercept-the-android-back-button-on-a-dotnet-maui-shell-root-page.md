---
title: "Как перехватить кнопку \"Назад\" в Android на корневой странице .NET MAUI Shell"
description: "Переопределите OnBackButtonPressed на корневой странице и используйте .NET MAUI 10.0.101 или новее. Почему корневые страницы перестали получать нажатия \"Назад\" начиная с 10.0.70 (Android 16) и 10.0.100 (все версии Android), почему .NET 11 RC 1 всё ещё затронут, почему Shell.OnNavigating и BackButtonBehavior.Command не помогают, и обходной путь через MainActivity для сломанных версий."
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "maui-shell"
  - "predictive-back"
  - "dotnet-10"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/09/how-to-intercept-the-android-back-button-on-a-dotnet-maui-shell-root-page"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Коротко:** переопределите `OnBackButtonPressed()` в корневой `ContentPage` (или в своём `AppShell`), верните `true`, чтобы поглотить нажатие, и убедитесь, что используете **.NET MAUI 10.0.101** (выпущен 2026-09-07) или новее. В версиях с 10.0.70 по 10.0.100, а также в .NET MAUI 11 RC 1 (`11.0.0-rc.1.26451.6`) это переопределение на корневой странице никогда не вызывается: MAUI отключает свой Android-колбэк "Назад" всякий раз, когда считает, что извлекать из стека нечего, и Android отправляет пользователя на домашний экран, не спрашивая ваш код. На Android 16 это началось с 10.0.70, на всех остальных версиях Android с 10.0.100. Если обновиться нельзя, зарегистрируйте собственный `OnBackPressedCallback` в `MainActivity` (код ниже). `Shell.OnNavigating` с `ShellNavigationSource.Pop` и `BackButtonBehavior.Command` не перехватывают аппаратную кнопку или жест "Назад" на корневой странице, даже на 10.0.101.

Исправления из 10.0.101 нет в .NET 11 RC 1. С тех пор оно попало в `main` и в ветку `net11.0` (через servicing-слияние SR10, [dotnet/maui#38301](https://github.com/dotnet/maui/pull/38301)), так что ожидайте его в .NET 11 RC 2.

## Почему корневая страница перестала слышать кнопку "Назад"

Android 16 по умолчанию включает predictive back для приложений, нацеленных на API 36. При predictive back система решает *ещё до начала жеста*, нужно ли приложению событие "Назад". Если ни один колбэк не включён, она проигрывает анимацию возврата на домашний экран и переводит задачу в фон. Устаревший `Activity.OnBackPressed()` она никогда не вызывает и `KeyEvent.KEYCODE_BACK` в `OnKeyDown` никогда не отправляет.

Раньше .NET MAUI регистрировал свой колбэк "Назад" безусловно, и это убивало анимацию для каждого приложения на MAUI ([dotnet/maui#34594](https://github.com/dotnet/maui/issues/34594)). Исправление, [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223), заменило его на AndroidX `OnBackPressedCallback`, флаг `Enabled` которого MAUI пересчитывает при каждом изменении навигации. `MauiAppCompatActivity` включает колбэк, только когда `Window.CanConsumeBackNavigation` сообщает, что текущая страница может обработать "Назад":

- в стеке есть модальная страница, или
- в стеке навигации раздела Shell больше одной страницы, или
- в `NavigationPage` больше одной страницы, или
- открыто flyout-меню, которое пользователь может закрыть.

Обычная корневая `ContentPage` не подходит ни под одно из условий, поэтому колбэк отключён, и нажатие уходит прямо в систему. Ваше переопределение `OnBackButtonPressed()` стоит в конце цепочки (`MauiOnBackPressedCallback` -> `AndroidLifecycle.OnBackPressed` -> `IWindow.BackButtonClicked()` -> `Shell.OnBackButtonPressed()` -> `Page.OnBackButtonPressed()`), которая так и не запускается.

Почему первым сломался Android 16? С 10.0.70 по 10.0.90 `MauiAppCompatActivity` всё ещё переопределял устаревший `OnBackPressed()` и оттуда безусловно запускал обработку "Назад" в MAUI. Устройства без predictive back (Android 15 и старше, если вы не включили его явно через `android:enableOnBackInvokedCallback="true"`) по-прежнему доставляли нажатие через это переопределение, так что условие не играло роли. В 10.0.100 переопределение удалили и перенесли всё на `OnBackPressedDispatcher`, поэтому условие действует на всех версиях Android. Разбор задач в точности это подтверждает: [#37657](https://github.com/dotnet/maui/issues/37657) и [#38030](https://github.com/dotnet/maui/issues/38030) помечены `regressed-in-10.0.70` для Android 16, а в [#37706](https://github.com/dotnet/maui/issues/37706) сообщается о сбоях на Android 15 и 17 начиная с 10.0.100.

## Что изменилось в 10.0.101, с замерами

[dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709), перенесённый в [#37729](https://github.com/dotnet/maui/pull/37729), добавляет одну проверку в начало `CanConsumeBackNavigation`: если действующий `OnBackButtonPressed` страницы объявлен в любой сборке, кроме `Microsoft.Maui.Controls`, колбэк включается. MAUI обнаруживает переопределение по `MethodInfo.DeclaringType` делегата, не вызывая ваш код. Результат кешируется для каждого экземпляра страницы.

Мне хотелось увидеть само решение, а не верить описанию PR, поэтому я вызвал внутренний `Window.CanConsumeBackNavigation(Page)` через рефлексию из файлового приложения на .NET 10. Оно использует обычную сборку `net10.0` пакета `Microsoft.Maui.Controls`, так что эмулятор не нужен:

```csharp
// probe.cs -- dotnet run probe.cs (SDK 10.0.302; net11.0 + SDK 11.0.100-rc.1 for the RC 1 run)
#:package Microsoft.Maui.Controls@10.0.101
#:property PublishAot=false
#:property TargetFramework=net10.0
using System.Reflection;
using Microsoft.Maui.Controls;

var canConsume = typeof(Window).GetMethod("CanConsumeBackNavigation",
    BindingFlags.NonPublic | BindingFlags.Static)!;
bool Check(Page p) => (bool)canConsume.Invoke(null, [p])!;

Console.WriteLine($"root page with override        -> {Check(new OverridePage())}");
Console.WriteLine($"Shell override, plain root     -> {Check(MakeShell(new OverrideShell(), new PlainPage()))}");
Console.WriteLine($"Shell OnNavigating only        -> {Check(MakeShell(new NavigatingShell(), new PlainPage()))}");
// ...plus a plain Shell + plain root, and a root with a BackButtonBehavior.Command

static Shell MakeShell(Shell shell, ContentPage root)
{
    shell.Items.Add(new ShellContent { Content = root });
    return shell;
}

class PlainPage : ContentPage { }
class OverridePage : ContentPage { protected override bool OnBackButtonPressed() => true; }
class OverrideShell : Shell { protected override bool OnBackButtonPressed() => true; }
class NavigatingShell : Shell
{
    protected override void OnNavigating(ShellNavigatingEventArgs args)
    {
        base.OnNavigating(args);
        if (args.Source == ShellNavigationSource.Pop) args.Cancel();
    }
}
```

`True` означает, что MAUI включает свой колбэк на этой корневой странице, и ваш код выполняется. `False` означает, что Android переводит приложение в фон, ничего не спрашивая:

| Настройка корневой страницы | 10.0.90 | 10.0.101 | 11.0.0-rc.1.26451.6 |
|---|---|---|---|
| Обычная `ContentPage`, без переопределений | False | False | False |
| `ContentPage`, переопределяющая `OnBackButtonPressed` | False | **True** | False |
| `AppShell`, переопределяющий `OnBackButtonPressed`, обычная корневая страница | False | **True** | False |
| Обычный `Shell`, корневая страница переопределяет `OnBackButtonPressed` | False | **True** | False |
| `AppShell`, переопределяющий только `OnNavigating` (отмена `Pop`) | False | False | False |
| Корневая страница с `Shell.BackButtonBehavior` `Command` | False | False | False |

Эта проба измеряет условие, а не запуск на устройстве. Для результата на устройстве в #37709 есть проверка на эмуляторе Android 16. Команда MAUI также подтвердила исправление на воспроизведении с вкладками Shell из #37657, а автор отчёта в #37706 подтвердил, что сборка из PR исправила его приложение на NavigationPage.

## Пошагово: перехват нажатия "Назад" на корневой странице

1. **Проверьте версию MAUI.** Найдите пакет `Microsoft.Maui.Controls` в своём `.csproj` или выполните `dotnet list package`. Если он разрешается в любую версию с 10.0.70 по 10.0.100, поднимите её до 10.0.101 или новее. На .NET 11 RC 1 используйте обходной путь из шага 4 до выхода RC 2.

   ```xml
   <!-- .NET MAUI 10, MyApp.csproj -->
   <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.101" />
   ```

2. **Переопределите `OnBackButtonPressed` на той странице, которой это нужно.** Метод синхронный, поэтому сразу верните `true`, а диалог подтверждения покажите на следующем такте диспетчера. Не делайте переопределение `async`: переопределение с `async` возвращает `false` на первом `await`, ещё до ответа пользователя.

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- MainPage.xaml.cs (a Shell root page)
   public partial class MainPage : ContentPage
   {
       bool _confirming;

       protected override bool OnBackButtonPressed()
       {
           if (_confirming)
               return true;

           _confirming = true;
           Dispatcher.Dispatch(async () =>
           {
               try
               {
                   bool leave = await DisplayAlertAsync(
                       "Leave the app?", "Unsaved changes will be lost.", "Leave", "Stay");
                   if (leave)
                       LeaveApp();
               }
               finally
               {
                   _confirming = false;
               }
           });
           return true; // swallow this press; the dialog decides what happens next
       }

       static void LeaveApp()
       {
   #if ANDROID
           // Same as Android's own root back since Android 12: background the task, keep the process.
           Platform.CurrentActivity?.MoveTaskToBack(true);
   #endif
       }
   }
   ```

   `MoveTaskToBack(true)` выбран намеренно. `Application.Current.Quit()` на Android вызывает `FinishAndRemoveTask()`, а затем `Environment.Exit(0)`, что убивает процесс и лишает вас тёплого запуска, который Android иначе дал бы при следующем старте.

3. **Для правил на уровне вкладок переопределяйте метод в `AppShell`.** Частое требование звучит так: "'Назад' на корне любой вкладки возвращает на первую вкладку, и только первая вкладка закрывает приложение". Это задача Shell, который видит все корневые страницы:

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- AppShell.xaml.cs
   public partial class AppShell : Shell
   {
       protected override bool OnBackButtonPressed()
       {
           var section = CurrentItem?.CurrentItem;
           bool atTabRoot = section is not null && section.Stack.Count <= 1;

           if (atTabRoot && CurrentItem is TabBar tabs && tabs.CurrentItem != tabs.Items[0])
           {
               tabs.CurrentItem = tabs.Items[0];
               return true;
           }

           return base.OnBackButtonPressed(); // pops pages, then raises Navigating(Pop)
       }
   }
   ```

   Возврат `base.OnBackButtonPressed()` сохраняет обычное поведение Shell. Он вызывает `OnBackButtonPressed` видимой страницы, извлекает страницу из стека раздела, если там есть что извлекать, а иначе вызывает `Navigating` с `ShellNavigationSource.Pop` и возвращает `args.Cancelled`. Это также значит, что задокументированный шаблон отмены через `OnNavigating` *действительно* работает на корневой странице, как только какое-нибудь переопределение включило колбэк. Сам по себе он никогда не выполняется.

4. **На версиях с 10.0.70 по 10.0.100 или на .NET 11 RC 1 добавьте собственный колбэк в `MainActivity`.** Диспетчер AndroidX первым вызывает последний добавленный включённый колбэк. Поэтому колбэк, добавленный после `base.OnCreate`, выполняется раньше колбэка MAUI, в том числе в тех случаях, когда собственный колбэк MAUI отключён:

   ```csharp
   // .NET MAUI 10.0.70-10.0.100 and 11.0.0-rc.1 only -- Platforms/Android/MainActivity.cs
   using Android.App;
   using Android.Content.PM;
   using Android.OS;
   using AndroidX.Activity;

   [Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
       ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                              ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity
   {
       protected override void OnCreate(Bundle? savedInstanceState)
       {
           base.OnCreate(savedInstanceState);
           OnBackPressedDispatcher.AddCallback(this, new RootBackCallback(this));
       }

       sealed class RootBackCallback(MainActivity activity) : OnBackPressedCallback(true)
       {
           public override void HandleOnBackPressed()
           {
               // Runs the same chain MAUI would: modal stack, Shell, then the visible page.
               var window = Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()
                   as Microsoft.Maui.IWindow;
               if (window?.BackButtonClicked() == true)
                   return;

               // Nothing consumed it: step aside and let the system (or MAUI) handle this press.
               Enabled = false;
               try { activity.OnBackPressedDispatcher.OnBackPressed(); }
               finally { Enabled = true; }
           }
       }
   }
   ```

   Это прослойка для совместимости, а не шаблон, который стоит сохранять. Колбэк всегда включён, поэтому анимация возврата на домашний экран никогда не проигрывается. Кроме того, когда собственный колбэк MAUI тоже включён (например, при открытом flyout) и ни одна страница не обрабатывает нажатие, ваше переопределение выполняется дважды. Удалите прослойку при переходе на 10.0.101. Если оставить её на 10.0.101, каждое необработанное нажатие на странице с переопределением будет проходить через `OnBackButtonPressed` дважды. В [#37657](https://github.com/dotnet/maui/issues/37657) есть более короткий вариант, который повторно входит в устаревший `Activity.OnBackPressed()`. Версия выше избегает вызова устаревшего API из нового кода.

5. **Проверьте на реальном устройстве с Android 16 или на эмуляторе с API 36.** Используйте и навигацию жестами, и трёхкнопочную навигацию. Проведите от края и задержите палец на корневой странице, которая переопределяет метод: анимации возврата на домашний экран быть не должно, а после отпускания должен выполниться ваш обработчик. На корневой странице без переопределения анимация по-прежнему должна появляться. Так вы убедитесь, что не отключили predictive back во всём приложении.

## Что выглядит рабочим, но не работает

**`BackButtonBehavior.Command` не является обработчиком аппаратной кнопки "Назад" на Android.** `Shell.OnBackButtonPressed` выполняет команду только под `#if WINDOWS || !PLATFORM`. На Android команда запускается из `ShellToolbarTracker.OnClick`, то есть по стрелке на панели навигации. У корневой страницы нет стрелки "Назад" (во flyout Shell на этом месте кнопка-гамбургер), так что для корневой страницы команда не имеет значения. Проба подтверждает, что колбэк она тоже не включает.

**События жизненного цикла не открывают условие.** `builder.ConfigureLifecycleEvents(e => e.AddAndroid(a => a.OnBackPressed(...)))` регистрирует ещё один делегат `AndroidLifecycle.OnBackPressed`. Условие проверяет лишь, что существует *какой-нибудь* делегат, а MAUI всегда регистрирует собственный `HandleWindowBackButtonPressed`, так что ваш ничего не добавляет. Когда страница не может обработать "Назад", колбэк остаётся отключённым, и ваш делегат никогда не выполняется.

**Переопределения `OnKeyDown(Keycode.Back, ...)` и `OnBackPressed()` в `MainActivity` на Android 16 являются мёртвым кодом.** В руководстве Google по predictive back сказано, что перехват событий "Назад" через `KEYCODE_BACK` "больше не поддерживается". Чеклист миграции в статье о [переходе на Android API level 36 в .NET MAUI](/ru/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) описывает остальные переопределения, которые замолкают при target 36.

**Каждое переопределение стоит вам анимации возврата на домашний экран на этой странице.** MAUI принимает решение по типу, а не по тому, что возвращает ваше переопределение. Как только страница объявляет `OnBackButtonPressed`, колбэк на ней включён, даже если метод просто возвращает `base.OnBackButtonPressed()`. То же относится к переопределениям, унаследованным от базового класса вне `Microsoft.Maui.Controls`: общий `BasePage` с переопределением включает колбэк для всех производных страниц, а переопределение в `AppShell` включает его для всех страниц. Android рекомендует включать колбэки "Назад" только для логики UI (подтверждение несохранённых изменений, закрытие всплывающего окна на странице) и никогда для журналирования или аналитики. Размещайте переопределение на самой узкой странице, которой оно нужно.

**`android:enableOnBackInvokedCallback="false"` не является исправлением.** Оно отключает анимации predictive back и не даёт работать `OnBackInvokedCallback`. Вызовы `OnBackPressedCallback`, которые использует MAUI, продолжают работать. На 10.0.70-10.0.90 оно случайно снова направляет "Назад" на Android 16 через устаревший путь. На 10.0.100 устаревшего переопределения больше нет, так что для условия на корневой странице оно ничего не меняет.

**Модальные страницы никогда не были затронуты.** Непустой модальный стек всегда включает колбэк, поэтому `protected override bool OnBackButtonPressed() => true;` на модальной странице продолжал работать всё это время. См. [показ модального окна в .NET MAUI 11](/ru/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/).

**Не запускайте из переопределения код по принципу fire-and-forget.** Вернуть `true`, а затем ожидать диалог безопасно, потому что `Dispatcher.Dispatch` выполняет лямбду в UI-потоке. Вспомогательный метод `async void`, выбросивший исключение, всё равно уронит процесс. В статье [поиск обработчиков `async void`, вызывающих ANR в Android-приложении на MAUI](/ru/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/) показано, как их отыскать.

## Что почитать дальше

- Навигация назад с передачей данных (`..?saved=true`) и свойства `BackButtonBehavior`, включая `AccessibilityLabel` из .NET MAUI 11, разобраны в статье [параметры маршрутов Shell и свойства запроса в .NET MAUI 11](/ru/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/).
- Шаг про predictive back при миграции на API 36 и исправление в 10.0.90, вернувшее анимацию возврата на домашний экран, описаны в статье [миграция Android-приложения на MAUI на target API level 36](/ru/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).
- Поглощение "Назад" на модальной странице и то, почему модальная страница не является модальным окном, описаны в статье [как показать модальное окно в .NET MAUI 11](/ru/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/).
- Шаблон с диспетчером из шага 2 является безопасной формой fire-and-forget кода, разобранного в статье [поиск обработчиков `async void`, вызывающих ANR](/ru/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/).

## Источники

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation) (Microsoft Learn: `BackButtonBehavior`, `Navigating`, `ShellNavigationSource.Pop`, отложенная навигация)
- [Add support for the predictive back gesture](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture) (Android Developers: когда колбэки отключают анимацию, `KEYCODE_BACK`, `enableOnBackInvokedCallback`)
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223): `OnBackPressedCallback` с условием ради анимации возврата на домашний экран
- [dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709) и перенос в 10.0.101 [#37729](https://github.com/dotnet/maui/pull/37729): `OnBackButtonPressed` на корневых страницах
- Отчёты о регрессиях: [#37657](https://github.com/dotnet/maui/issues/37657) (вкладки Shell), [#37706](https://github.com/dotnet/maui/issues/37706) (корневая `ContentPage`), [#38030](https://github.com/dotnet/maui/issues/38030) (`FlyoutPage`)
- Исходный код на тегах релизов: [`Window.cs` в 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Window/Window.cs), [`MauiAppCompatActivity.cs` в 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Core/src/Platform/Android/MauiAppCompatActivity.cs), [`Shell.cs` в 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Shell/Shell.cs) и [`Window.cs` в 11.0.100-rc.1.26458.5](https://github.com/dotnet/maui/blob/11.0.100-rc.1.26458.5/src/Controls/src/Core/Window/Window.cs)
