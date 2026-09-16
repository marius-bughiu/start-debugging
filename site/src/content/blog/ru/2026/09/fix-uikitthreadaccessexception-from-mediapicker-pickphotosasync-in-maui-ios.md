---
title: "Исправление: UIKitThreadAccessException в MediaPicker.PickPhotosAsync при выборе нескольких фотографий в .NET MAUI iOS"
description: "Выбор 2 и более фотографий в iOS вызывает UIKitThreadAccessException в MAUI 10.0.100 и 10.0.101. MAUI читает PHPickerResult.ItemProvider после await, вне главного потока. Зафиксируйте 10.0.90, обновитесь до 10.0.110 или вызовите PHPicker сами."
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "csharp"
  - "async"
lang: "ru"
translationOf: "2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios"
translatedBy: "claude"
translationDate: 2026-09-16
---

Если `MediaPicker.PickPhotosAsync` в iOS выбрасывает `UIKit.UIKitThreadAccessException` каждый раз, когда пользователь выбирает 2 или более элементов, вы столкнулись с регрессией .NET MAUI, появившейся в 10.0.100. MAUI читает `PHPickerResult.ItemProvider`, свойство под защитой UIKit, внутри цикла, который ожидает с `ConfigureAwait(false)`, поэтому каждая итерация после первой выполняется в потоке пула. Со стороны вызывающего кода это не лечится. Зафиксируйте `<MauiVersion>10.0.90</MauiVersion>`, перейдите на 10.0.110 (SR11) или MAUI 11.0.0-rc.2, когда они выйдут, либо вызовите `PHPickerViewController` самостоятельно и прочитайте item providers до первого await. Выбор ровно одной фотографии работает всегда, из-за чего проблема выглядит плавающей, пока не заметишь закономерность.

## Ошибка в контексте

```text
UIKit.UIKitThreadAccessException: UIKit Consistency error: you are calling a UIKit method that can only be invoked from the UI thread.
   at UIKit.UIApplication.EnsureUIThread()
   at PhotosUI.PHPickerResult.get_ItemProvider()
   at Microsoft.Maui.Media.MediaPickerImplementation.PickerResultsToMediaFiles(PHPickerResult[] results, MediaPickerOptions options)
   at Microsoft.Maui.Media.MediaPickerImplementation.CompletePickerResultsAsync(PHPickerResult[] results, MediaPickerOptions options, TaskCompletionSource`1 tcs)
```

Затронутые версии, проверенные по release-веткам `dotnet/maui`:

| Версия MAUI | Выпущена | `PickPhotosAsync` с 2+ элементами |
| --- | --- | --- |
| 10.0.90 (SR9) | 2026-07-22 | работает |
| 10.0.100 (SR10) | 2026-08-20 | выбрасывает исключение |
| 10.0.101 | 2026-09-07 | выбрасывает исключение |
| 11.0.0-rc.1 | 2026-09-08 | выбрасывает исключение |
| 10.0.110 (SR11) | не выпущена | исправлено |
| 11.0.0-rc.2 | не выпущена | исправлено |

`PickPhotosAsync` и `PickVideosAsync` появились только в .NET MAUI 10 ([dotnet/maui#6903](https://github.com/dotnet/maui/issues/6903)), поэтому откатиться на более раннюю мажорную версию нельзя. Android и Windows не затронуты: сломанный код находится только в `MediaPicker.ios.cs`.

## Почему это происходит

`PickPhotosAsync` в iOS показывает `PHPickerViewController`. Когда пользователь подтверждает выбор, `PhotoPickerDelegate.DidFinishPicking` из MAUI закрывает контроллер и вызывает свой обработчик завершения из колбэка закрытия, который выполняется в главном потоке. Этот обработчик вызывает `PickerResultsToMediaFiles`, и в 10.0.100 метод выглядел так:

```csharp
// .NET MAUI 10.0.100 and 10.0.101, src/Essentials/src/MediaPicker/MediaPicker.ios.cs
var fileResults = new List<FileResult>(results.Length);
PHPickerFileResult fileResult = null;

foreach (var file in results)
{
    fileResult = new PHPickerFileResult(file.ItemProvider);   // UIKit call
    await fileResult.LoadFileRepresentationAsync().ConfigureAwait(false);
    fileResults.Add(fileResult);
    fileResult = null;
}
```

`PHPickerResult.ItemProvider` связан с проверкой `UIApplication.EnsureUIThread()`. Первая итерация проходит нормально, потому что колбэк делегата оставил нас в главном потоке. Затем `LoadFileRepresentationAsync` ожидается с `ConfigureAwait(false)`, что отбрасывает захваченный контекст, и вторая итерация читает `file.ItemProvider` в том потоке, куда попало продолжение.

Детерминированным, а не случайным, это делает код внутри `PHPickerFileResult`:

```csharp
// .NET MAUI 10.0.100, PHPickerFileResult.LoadFileRepresentationAsync
loadTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
```

`RunContinuationsAsynchronously` означает, что продолжение никогда не выполняется встроенно тем потоком, который завершает `TaskCompletionSource`. Вместе с `ConfigureAwait(false)` пути обратно в главный поток нет, поэтому второе чтение всегда происходит в пуле. Именно поэтому сбой воспроизводится идеально: 1 элемент работает всегда, 2 и более падают всегда. Если вы раньше ловили плавающие асинхронные баги, здесь обратный случай, и стоит понимать, [что именно отбрасывает ConfigureAwait(false)](/ru/2026/05/configureawait-false-vs-default-in-dotnet-11/), прежде чем искать несуществующее состояние гонки.

Это регрессия из [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805) (".NET 10 SR10"), где исправляли пустой `FullPath` для результатов PHPicker. До того PR все провайдеры материализовались за один проход:

```csharp
// .NET MAUI 10.0.90 and earlier
var fileResults = results?
    .Select(file => (FileResult)new PHPickerFileResult(file.ItemProvider))
    .ToList() ?? [];
```

Каждый `ItemProvider` читался до первого `await`, поэтому проверка UIKit никогда не видела поток пула. Замена на цикл с `await` внутри и сломала это. Баг отслеживается как [dotnet/maui#37878](https://github.com/dotnet/maui/issues/37878), с меткой `regressed-in-10.0.100` и вехой .NET 10 SR11.

## Минимальное воспроизведение

```csharp
// .NET MAUI 10.0.100, net10.0-ios, iOS 26.4 simulator
private async void OnPickClicked(object sender, EventArgs e)
{
    try
    {
        var files = await MediaPicker.Default.PickPhotosAsync(new MediaPickerOptions
        {
            SelectionLimit = 5
        });

        StatusLabel.Text = $"Picked {files.Count}";
    }
    catch (Exception ex)
    {
        StatusLabel.Text = ex.ToString();   // UIKitThreadAccessException with 2+ items
    }
}
```

На симуляторе сначала наполните медиатеку, иначе средство выбора откроется пустым:

```bash
xcrun simctl addmedia booted photo1.png photo2.png photo3.png
```

Выберите одну фотографию: вы получите `FileResult`. Выберите две: вы получите исключение. Обработчик `async void` здесь допустим только потому, что все пути находятся внутри `try`, и это единственная форма, в которой [async void оправдан](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Исправление 1: обновиться поверх регрессии

Исправление сделано в [dotnet/maui#37879](https://github.com/dotnet/maui/pull/37879), влитом 2026-08-27, портированном в `release/10.0.1xx-sr11` как [#38481](https://github.com/dotnet/maui/pull/38481) и перенесённом в `main` как [#38488](https://github.com/dotnet/maui/pull/38488), оба 2026-09-12. Выпущенный код теперь читает все провайдеры до первого await:

```csharp
// .NET MAUI 10.0.110 and 11.0.0-rc.2, MediaPicker.ios.cs
// PHPickerResult.ItemProvider is a UIKit call and must be read on the main thread.
var pickerResults = new List<PHPickerFileResult>(results.Length);
foreach (var file in results)
{
    pickerResults.Add(new PHPickerFileResult(file.ItemProvider));
}

var fileResults = new List<FileResult>(pickerResults.Count);
foreach (var pickerResult in pickerResults)
{
    await pickerResult.LoadFileRepresentationAsync().ConfigureAwait(false);
    fileResults.Add(pickerResult);
}
```

`NSItemProvider` относится к Foundation и не имеет проверки потока UI, поэтому держать провайдеры между await безопасно. Тот же PR закрыл и утечку памяти в ветке ошибки: результаты, созданные после упавшей итерации, оставались без освобождения.

По состоянию на 2026-09-16 ни 10.0.110, ни 11.0.0-rc.2 на NuGet нет. Когда 10.0.110 выйдет, правка займёт одну строку:

```xml
<!-- Directory.Build.props or the app .csproj -->
<PropertyGroup>
  <MauiVersion>10.0.110</MauiVersion>
</PropertyGroup>
```

## Исправление 2: зафиксировать 10.0.90

Пока SR11 не вышел, фиксация версии остаётся вариантом с наименьшим риском, если вы не зависите ни от чего другого из SR10:

```xml
<!-- app .csproj, .NET 10 SDK -->
<PropertyGroup>
  <MauiVersion>10.0.90</MauiVersion>
</PropertyGroup>
```

Платой будет отказ от [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805), исправления `FullPath`. В 10.0.90 `FileResult` из ветки PHPicker может вернуться с путём, по которому файла нет, так что `File.Copy(result.FullPath, ...)` падает и нужно идти через `await result.OpenReadAsync()`. Если ваш код загрузки уже работает с потоками, а не копирует по пути, вы этого не заметите.

## Исправление 3: вызвать PHPicker самостоятельно

Если сменить версию нельзя, замените ветку множественного выбора для iOS примерно шестьюдесятью строками interop. Весь приём сводится к тому, чтобы прочитать каждый `ItemProvider` внутри `DidFinishPicking`, до того как что-либо начнёт ожидание.

```csharp
// .NET MAUI 10.0.100, net10.0-ios only
using Foundation;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Storage;
using PhotosUI;
using UIKit;

sealed class PhotoPicker
{
    public static Task<List<string>> PickPhotosAsync(int selectionLimit)
    {
        var tcs = new TaskCompletionSource<List<string>>();

        var config = new PHPickerConfiguration
        {
            Filter = PHPickerFilter.ImagesFilter,
            SelectionLimit = selectionLimit
        };

        var picker = new PHPickerViewController(config)
        {
            Delegate = new PickerDelegate(tcs)
        };

        var vc = WindowStateManager.Default.GetCurrentUIViewController(true);
        vc.PresentViewController(picker, true, null);

        return tcs.Task;
    }

    sealed class PickerDelegate : PHPickerViewControllerDelegate
    {
        readonly TaskCompletionSource<List<string>> _tcs;

        public PickerDelegate(TaskCompletionSource<List<string>> tcs) => _tcs = tcs;

        public override void DidFinishPicking(PHPickerViewController picker, PHPickerResult[] results)
        {
            // Main thread. Read every provider now, before any await can move us off it.
            var providers = new List<NSItemProvider>(results.Length);
            foreach (var result in results)
            {
                providers.Add(result.ItemProvider);
            }

            picker.DismissViewController(true, () => _ = LoadAllAsync(providers));
        }

        async Task LoadAllAsync(List<NSItemProvider> providers)
        {
            try
            {
                var paths = new List<string>(providers.Count);
                foreach (var provider in providers)
                {
                    var identifier = provider.RegisteredTypeIdentifiers?.FirstOrDefault();
                    if (string.IsNullOrEmpty(identifier))
                    {
                        continue;
                    }

                    paths.Add(await CopyToCacheAsync(provider, identifier).ConfigureAwait(false));
                }

                _tcs.TrySetResult(paths);
            }
            catch (Exception ex)
            {
                _tcs.TrySetException(ex);
            }
        }

        static Task<string> CopyToCacheAsync(NSItemProvider provider, string identifier)
        {
            var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

            provider.LoadFileRepresentation(identifier, (url, error) =>
            {
                if (error is not null)
                {
                    tcs.TrySetException(new NSErrorException(error));
                    return;
                }

                try
                {
                    // The URL is only valid inside this callback, so copy synchronously.
                    var destination = Path.Combine(
                        FileSystem.CacheDirectory,
                        Guid.NewGuid().ToString("n") + Path.GetExtension(url.Path));

                    File.Copy(url.Path, destination, overwrite: true);
                    tcs.TrySetResult(destination);
                }
                catch (Exception ex)
                {
                    tcs.TrySetException(ex);
                }
            });

            return tcs.Task;
        }
    }
}
```

Важны две детали. `NSUrl`, который передаётся в колбэк `LoadFileRepresentation`, указывает на файл, удаляемый системой сразу после возврата из колбэка, поэтому копирование должно быть синхронным и внутри колбэка. И `PickerDelegate` должен оставаться достижимым: присваивание типизированному свойству `Delegate` удерживает управляемую ссылку, но при переходе на `WeakDelegate` экземпляр придётся держать самому, иначе его соберёт сборщик мусора прямо посреди выбора.

Теряется всё, что `MediaPickerOptions` делает после выбора: `CompressionQuality`, `MaximumWidth`, `MaximumHeight`, `RotateImage` и `PreserveMetaData` применяет собственный этап постобработки MAUI, а не средство выбора. Если они нужны, меняйте размер через `SkiaSharp` или `Microsoft.Maui.Graphics` после копирования.

## Исправление 4: использовать FilePicker

`FilePicker.PickMultipleAsync` работает через `UIDocumentPickerViewController` и `NSUrl[]`, никогда не трогая `PHPickerResult`, поэтому не затронут:

```csharp
// .NET MAUI 10.0.100, cross-platform
var files = await FilePicker.Default.PickMultipleAsync(new PickOptions
{
    PickerTitle = "Select images",
    FileTypes = FilePickerFileType.Images
});
```

Это другой пользовательский опыт: приложение Файлы вместо сетки Фото, без запроса разрешения на доступ к Фото и без обработки live photos и HEIC. Как временное решение для сценария "приложить несколько изображений" подходит, а для всего, что завязано на плёнку камеры, не подходит.

## Нюансы и похожие случаи

**В сборке Release исключение исчезает, и это не исправление.** `EnsureUIThread` зависит от `ObjCRuntime.Runtime.CheckForIllegalCrossThreadCalls`, который подстановка ILLink отключает в сборках Release. Обращение к UIKit вне потока никуда не девается, вы просто теряете диагностику. Протестировать в Release и объявить победу это и есть тот путь, которым баг уезжает в App Store как плавающий сбой вместо детерминированного исключения.

**Не ставьте `UIApplication.CheckForIllegalCrossThreadCalls = false`.** Это заглушает все проверки потока UI в приложении, а не только эту, и само обращение действительно небезопасно.

**Обёртка вызова в `MainThread.InvokeOnMainThreadAsync` ничего не даёт.** Поток теряется внутри MAUI, после возврата из делегата средства выбора, а тамошний `ConfigureAwait(false)` явно отбрасывает любой контекст, который вы задали на стороне вызова. Правки потоков на стороне вызывающего кода туда не дотягиваются, ровно как не дотягиваются до [взаимной блокировки из-за обращения к .Result глубже по стеку](/ru/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

**`PickVideosAsync` затронут точно так же.** Он идёт через тот же вспомогательный метод `PhotosAsync` и тот же `PickerResultsToMediaFiles`. Если ваше воспроизведение использует видео, а не фотографии, это тот же баг.

**`PickPhotoAsync` (в единственном числе) работает нормально.** Он использует тот же путь в коде, но выдаёт ровно один `PHPickerResult`, поэтому цикл никогда не доходит до второго чтения. Если вы видите `UIKitThreadAccessException` при одиночном выборе, это другая проблема, обычно ваше собственное продолжение, которое трогает элемент управления вне главного потока.

**`SelectionLimit = 1` в `PickPhotosAsync` тоже безопасен.** Это обходной путь лишь в том смысле, что он убирает множественный выбор, то есть именно ту возможность, ради которой вы вызывали этот API.

**Это не то же самое, что [dotnet/maui#33954](https://github.com/dotnet/maui/issues/33954).** Там, исправлено в SR6, `PickPhotosAsync` возвращал меньше изображений, чем было выбрано, если задан `CompressionQuality`. Другой симптом, без исключения, и уже выпущено.

**ANR на Android относятся к другому классу проблем с потоками в MAUI.** Если ваше приложение MAUI блокирует поток UI ещё и на Android, это проявляется как ANR, а не как исключение, и диагностика совершенно другая: смотрите [как найти обработчики async void, вызывающие ANR в приложении .NET MAUI Android](/ru/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/).

## Похожие материалы

- [ConfigureAwait(false) против значения по умолчанию в .NET 11: это ещё важно?](/ru/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [async void против async Task в C#: когда что уместно](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Исправление: взаимная блокировка при вызове .Result или .Wait() на асинхронном методе в C#](/ru/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Как найти обработчики async void, вызывающие ANR в приложении .NET MAUI Android](/ru/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/)
- [Исправление: профиль подготовки не включает выбранное устройство в MAUI iOS](/ru/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)

## Источники

- [dotnet/maui#37878 - MediaPicker.PickPhotosAsync выбрасывает UIKitThreadAccessException при выборе 2 и более элементов](https://github.com/dotnet/maui/issues/37878)
- [dotnet/maui#37879 - исправление](https://github.com/dotnet/maui/pull/37879), портировано как [#38481](https://github.com/dotnet/maui/pull/38481) и [#38488](https://github.com/dotnet/maui/pull/38488)
- [dotnet/maui#35805 - изменение SR10, породившее регрессию](https://github.com/dotnet/maui/pull/35805)
- [dotnet/macios - Runtime.EnsureUIThread и CheckForIllegalCrossThreadCalls](https://github.com/dotnet/macios/blob/main/src/ObjCRuntime/Runtime.cs)
- [Документация для разработчиков Apple - PHPickerViewController](https://developer.apple.com/documentation/photokit/phpickerviewcontroller)
- [Microsoft Learn - Средство выбора медиафайлов в .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/device-media/picker)
