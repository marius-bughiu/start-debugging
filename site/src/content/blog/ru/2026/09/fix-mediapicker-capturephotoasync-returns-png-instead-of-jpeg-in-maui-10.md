---
title: "Исправление: MediaPicker.CapturePhotoAsync возвращает PNG вместо JPEG в .NET MAUI 10"
description: "На iOS MAUI 10 перекодирует снимки с камеры в PNG, если CompressionQuality равно 90 или выше и не задан MaximumWidth/Height, что включает значение по умолчанию. Установите CompressionQuality на 89 или ниже либо добавьте MaximumWidth только для iOS."
pubDate: 2026-09-27
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "android"
  - "csharp"
lang: "ru"
translationOf: "2026/09/fix-mediapicker-capturephotoasync-returns-png-instead-of-jpeg-in-maui-10"
translatedBy: "claude"
translationDate: 2026-09-27
---

Если `MediaPicker.Default.CapturePhotoAsync()` в .NET MAUI 10 отдаёт вам `3f2c9a....png` с `ContentType` `image/png`, то PNG создала не камера. Это сделал MAUI. На iOS путь через камеру передаёт MAUI декодированный `UIImage`, и MAUI 10 перекодирует его через `AsPNG()` всякий раз, когда `CompressionQuality` равно 90 или выше и не задан ни `MaximumWidth`, ни `MaximumHeight`. Качество по умолчанию равно 100, поэтому вызов без параметров всегда возвращает PNG. Исправление, которое работает на всех платформах и во всех сборках 10.x и 11, выглядит так: `new MediaPickerOptions { CompressionQuality = 85 }` (подойдёт любое значение от 0 до 89). Если вместо этого нужен JPEG максимального качества на iOS, оставьте качество 100 и задайте заведомо большой `MaximumWidth` только для iOS. На Android и Windows качество от 95 до 99 тоже даёт байты PNG, а на Windows они к тому же сохраняют имя `.jpg`.

## Ошибка в контексте

Исключения здесь нет. Симптом в том, что вы получаете файл, о котором не просили:

```text
// .NET 10, Microsoft.Maui.Essentials 10.0.110, iPhone, CapturePhotoAsync() with no options
FileName:    6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png
ContentType: image/png
First bytes: 89 50 4E 47 0D 0A 1A 0A
```

Поисковые запросы по этой теме обычно начинаются где-то дальше по конвейеру: конечная точка загрузки, принимающая только `image/jpeg`, отклоняет файл с кодом 415, хранилище blob-объектов заполняется PNG-файлами по несколько мегабайт, серверный сервис масштабирования изображений спотыкается на входных данных RGBA или пропадают данные EXIF, которые ожидал бэкенд (время съёмки, GPS). Все четыре случая восходят к одной и той же строке кода MAUI.

Вот что возвращает каждый вызов `CapturePhotoAsync`, по исходникам `MediaPicker` на теге каждого релиза:

| Параметры | iOS, MAUI с 10.0.0 по 10.0.51 | iOS, MAUI с 10.0.60 по 10.0.110 и 11.0 RC 1/RC 2 | Android, все 10.x и 11 RC | Windows, все 10.x и 11 RC |
| --- | --- | --- | --- | --- |
| нет (качество 100) | PNG | PNG | JPEG камеры без изменений | JPEG камеры без изменений |
| `CompressionQuality` от 95 до 99 | PNG | PNG | PNG | байты PNG с именем `.jpg` |
| `CompressionQuality` от 90 до 94 | JPEG, качество 0.9 | PNG | JPEG, перекодированный | JPEG, перекодированный |
| `CompressionQuality` от 0 до 89 | JPEG, качество q/100 | JPEG, качество q/100 | JPEG, перекодированный | JPEG, перекодированный |
| качество 100 + `MaximumWidth` | JPEG, качество 0.95 | JPEG, качество 0.95 | PNG | байты PNG с именем `.jpg` |
| качество от 95 до 99 + `MaximumWidth` | JPEG, качество 0.9 | JPEG, качество 0.9 | PNG | байты PNG с именем `.jpg` |

Бросаются в глаза две вещи. Единственная настройка, дающая JPEG в каждом столбце, это качество 89 или ниже. А правило для iOS стало строже в 10.0.60 (SR6), поэтому приложение, которое использовало `CompressionQuality = 90`, чтобы получать JPEG на 10.0.51, после рутинного обновления MAUI начало получать PNG.

## Почему MAUI 10 превращает снимок с камеры в PNG

`CapturePhotoAsync` на iOS показывает `UIImagePickerController` с камерой в качестве источника. Только что сделанного снимка ещё нет в фотобиблиотеке, поэтому нет и `PHAsset`, из которого можно было бы прочитать исходные байты HEIC или JPEG. MAUI откатывается к элементу `UIImagePickerController.OriginalImage`, то есть к декодированному `UIImage`, и оборачивает его во внутренний `CompressedUIImageFileResult`. Этот класс должен выбрать формат файла, не имея никакого исходного имени файла, на которое можно опереться, и делает это в `ShouldUsePngFormat`:

```csharp
// .NET MAUI 10.0.110, src/Essentials/src/MediaPicker/MediaPicker.ios.cs
bool ShouldUsePngFormat()
{
    bool originalWasPng = !string.IsNullOrEmpty(originalFileName) &&
        Path.GetExtension(originalFileName).Equals(".png", StringComparison.OrdinalIgnoreCase);

    return originalWasPng || (compressionQuality >= 90 && !maximumWidth.HasValue && !maximumHeight.HasValue);
}
```

При съёмке с камеры `originalFileName` равно `null`, поэтому всё решает вторая половина выражения. `MediaPickerOptions.CompressionQuality` по умолчанию равно 100, а значит, вариант "без параметров" попадает в `workingImage.AsPNG()`. Имя файла состоит из `Guid` и `.png`, а `FileResult.ContentType` выводится из этого расширения, поэтому весь последующий код сходится на том, что это PNG.

Это не столько новое поведение, сколько пережиток. В MAUI 9 и более ранних версиях тот же путь через камеру использовал `UIImageFileResult`, который всегда вызывал `AsPNG()` безо всяких параметров (см. [dotnet/maui#11379](https://github.com/dotnet/maui/issues/11379) от 2022 года). MAUI 10 добавил в `MediaPickerOptions` свойства `CompressionQuality`, `MaximumWidth`, `MaximumHeight`, `RotateImage` и `PreserveMetaData` и оставил PNG в качестве вывода "наивысшего качества". До 10.0.51 порог составлял 95. В [dotnet/maui#33119](https://github.com/dotnet/maui/issues/33119) указали, что метод вычислял порог 90, а возвращал порог 95, и [PR #33140](https://github.com/dotnet/maui/pull/33140) (веха .NET 10 SR6, впервые вышел в 10.0.60 на NuGet 2026-04-29) остановился на 90. Тот же код есть в теге `11.0.100-rc.1.26458.5` и в ветке `release/11.0.1xx-rc2`.

Android и Windows идут другим путём. Там камера записывает настоящий файл JPEG (`Guid.jpg` на Android, снимок `CameraCaptureUIPhotoFormat.Jpeg` на Windows), и MAUI трогает его, только когда `ImageProcessor.IsProcessingNeeded` равно true, то есть при качестве ниже 100 или заданном максимальном размере. Затем общий `ImageProcessor.ProcessImageAsync` выбирает формат по собственному правилу, `qualityPercent >= 95 || (qualityPercent >= 90 && originalWasPng)`, которое полностью игнорирует параметры масштабирования. Поэтому на Android качество 97 превращает JPEG камеры в PNG, а на iOS качество 97 с `MaximumWidth` этого не делает. Один и тот же объект параметров, разные форматы файлов. Windows добавляет ещё один поворот: его `ProcessedImageFileResult` называет выходной файл через `ImageProcessor.DetermineOutputExtension(imageData, 75, originalFileName)`, с жёстко заданным 75 вместо вашего качества, поэтому байты PNG получают имя `.jpg` и тип содержимого `image/jpeg`.

## Минимальное воспроизведение

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110, run on a physical iPhone
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync();
if (photo is null) return; // user cancelled

Console.WriteLine($"{photo.FileName} | {photo.ContentType}");
// 6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png | image/png
```

В iOS Simulator нет камеры (`IsCaptureSupported` там равно false), поэтому нужно реальное устройство. Если вы ещё не настраивали его для проекта MAUI, [исправление профиля подготовки для MAUI iOS](/ru/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) описывает обычное первое препятствие.

## Исправление 1: установите CompressionQuality на 89 или ниже

Это рекомендация почти для любого приложения. Это одна строка, она даёт JPEG на iOS, Android и Windows и ведёт себя одинаково во всех сервисных выпусках MAUI 10 и в MAUI 11 RC 1:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync(new MediaPickerOptions
{
    CompressionQuality = 85,
});
```

На iOS это вызывает `UIImage.AsJPEG(0.85f)` для изображения с нормализованной ориентацией. На Android и Windows JPEG камеры загружается через Microsoft.Maui.Graphics и снова сохраняется как JPEG с качеством 0.85. Качество 85 визуально неотличимо от оригинала для фотографий при размерах просмотра на телефоне и существенно уменьшает размер файла по сравнению с PNG без потерь из тех же пикселей. Если вы также хотите ограничить разрешение перед загрузкой, добавьте рядом `MaximumWidth` и `MaximumHeight`. При качестве ниже 90 они ни на одной платформе не меняют формат.

Не "исправляйте" это качеством от 90 до 94. Этот диапазон давал JPEG на iOS до 10.0.51 и стал давать PNG в 10.0.60, и именно такие настройки молча ломаются при следующем обновлении рабочей нагрузки.

## Исправление 2: сохраните максимальное качество на iOS с заведомо большим MaximumWidth

Если нужен JPEG с минимальными потерями, какой только может выдать MAUI, полезно знать одну особенность: на iOS установка любого `MaximumWidth` или `MaximumHeight` отключает ветку PNG, а MAUI никогда не увеличивает изображение (`CalculateResizedDimensions` ограничивает масштаб значением 1). При качестве 100 это даёт `AsJPEG(0.95f)` в полном разрешении. На Android и Windows те же параметры сделали бы обратное и выдали бы PNG, а там нетронутый JPEG камеры от простого вызова уже и есть то, что нужно. Поэтому разветвите код по платформе:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
using Microsoft.Maui.Devices;
using Microsoft.Maui.Media;

static MediaPickerOptions JpegCaptureOptions()
{
    if (DeviceInfo.Platform == DevicePlatform.iOS ||
        DeviceInfo.Platform == DevicePlatform.MacCatalyst)
    {
        // Any maximum dimension disables the PNG branch on iOS.
        // 16384 is larger than any iPhone sensor, so nothing is resized.
        return new MediaPickerOptions
        {
            CompressionQuality = 100, // encoded as AsJPEG(0.95f)
            MaximumWidth = 16384,
            MaximumHeight = 16384,
        };
    }

    // Android and Windows: quality 100 and no limits means MAUI returns
    // the camera's own JPEG file without re-encoding it.
    return new MediaPickerOptions();
}

FileResult? photo = await MediaPicker.Default.CapturePhotoAsync(JpegCaptureOptions());
```

Это опирается на деталь реализации `ShouldUsePngFormat`, поэтому считайте это обходным решением и перепроверяйте таблицу выше при переходе на новый релиз MAUI. У исправления 1 такой зависимости нет.

## Исправление 3: перестаньте доверять расширению на стороне получателя

Даже с исправленными параметрами приложение MAUI остаётся лишь одним из клиентов, а на Windows имя файла может быть неверным в обратную сторону. Всё, что принимает фотографии, должно проверять байты, а не имя файла. JPEG начинается с `FF D8 FF`, PNG с 8-байтовой сигнатуры `89 50 4E 47 0D 0A 1A 0A`:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
using Microsoft.Maui.Storage;

static async Task<string?> DetectImageFormatAsync(FileResult file)
{
    await using var stream = await file.OpenReadAsync();
    var header = new byte[8];
    var read = await stream.ReadAtLeastAsync(header, header.Length, throwOnEndOfStream: false);

    if (read >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF)
        return "image/jpeg";

    if (read >= 8 && header.AsSpan().SequenceEqual(
            new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }))
        return "image/png";

    return null;
}
```

Используйте определённый тип при формировании загрузки, чтобы сервер видел честный `Content-Type` даже для фотографий, сделанных старой версией приложения, которая всё ещё отправляет PNG:

```csharp
// .NET 10, C# 14
static async Task UploadAsync(HttpClient http, FileResult photo)
{
    var contentType = await DetectImageFormatAsync(photo) ?? "application/octet-stream";
    var extension = contentType == "image/png" ? ".png" : ".jpg";

    await using var stream = await photo.OpenReadAsync();
    using var content = new MultipartFormDataContent();
    var file = new StreamContent(stream);
    file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(contentType);
    content.Add(file, "photo", $"capture{extension}");

    using var response = await http.PostAsync("api/photos", content);
    response.EnsureSuccessStatusCode();
}
```

Если сервер сохраняет файл в хранилище blob-объектов рядом со строкой базы данных, [статья о согласованности записи в базу данных и загрузки blob](/ru/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) описывает, что делать, когда одна из двух операций завершается сбоем.

Весь приведённый выше код на C# компилируется с `Microsoft.Maui.Essentials` 10.0.110 на SDK .NET 10.0.302. Таблица форматов составлена по чтению `MediaPicker.ios.cs`, `MediaPicker.android.cs`, `MediaPicker.windows.cs` и `ImageProcessor.shared.cs` на тегах `10.0.0`, `10.0.51`, `10.0.60`, `10.0.110` и `11.0.100-rc.1.26458.5`, а не по матрице устройств, поэтому если ваше устройство ведёт себя иначе, первым делом проверьте, на каком теге вы на самом деле находитесь (`dotnet list package --include-transitive | grep Maui`).

## Подводные камни, которые идут вместе с PNG

**На снимках с камеры iOS нет EXIF, что бы ни говорил `PreserveMetaData`.** `CompressedUIImageFileResult` создаётся только из `UIImage`, а `PreserveMetaData` ему никогда не передаётся. `AsPNG()` и `AsJPEG()` у `UIImage` не записывают метаданные камеры, поэтому времени съёмки, GPS и данных объектива нет в файле ни при одном из исправлений. Если они вам нужны, прочитайте словарь `UIImagePickerController.MediaMetadata` самостоятельно в собственном пикере или сохраните время и местоположение в приложении в момент завершения съёмки. Выбор существующей фотографии (`PickPhotoAsync`) идёт через `PHPicker` и исходный ресурс, а это другой путь. [dotnet/maui#36581](https://github.com/dotnet/maui/issues/36581) отслеживает полноценные API метаданных для .NET 12.

**Повёрнутые фотографии становятся RGBA.** Портретный снимок с камеры iPhone приходит как альбомное растровое изображение с `UIImageOrientation.Right`. MAUI всегда вызывает `NormalizeOrientation()` перед кодированием, и тот перерисовывает изображение через `UIGraphicsImageRenderer`, у формата которого `Opaque = false`. В результате появляется ненужный альфа-канал, и PNG из такого изображения получается ещё больше. Плюс в том, что пиксели уже стоят вертикально, поэтому для снимков с камеры iOS `RotateImage = true` не нужен.

**`SaveToGallery` в MAUI 11 тоже сохраняет PNG.** MAUI 11 добавляет `MediaPickerOptions.SaveToGallery` для вызовов съёмки. На iOS он записывает тот же `FileResult`, который MAUI возвращает вам, во временный файл и передаёт его в `PHAssetChangeRequest.FromImage`. С параметрами по умолчанию это означает, что в фотобиблиотеку пользователя попадает PNG. Установите качество ниже 90, и копия в галерее тоже будет JPEG.

**`PickPhotoAsync` может возвращать PNG по другой причине.** Если пользователь выбирает скриншот, оригинал действительно является PNG, и MAUI намеренно сохраняет его как PNG при качестве 90 или выше (`originalWasPng`). Это не данная ошибка; определяйте формат, как в исправлении 3, и обрабатывайте оба варианта.

**У множественного выбора на iOS своя проблема в 10.0.100.** Если `PickPhotosAsync` выбрасывает исключение, когда пользователь выбирает несколько изображений, это [регрессия UIKitThreadAccessException в MediaPicker.PickPhotosAsync](/ru/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/), исправленная в 10.0.110.

## Связанные материалы

- [Исправление: UIKitThreadAccessException из MediaPicker.PickPhotosAsync в .NET MAUI iOS](/ru/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/) описывает другую регрессию MediaPicker в линейке 10.0.1xx.
- [Что нового в .NET MAUI 10](/ru/2025/04/whats-new-in-net-maui-10/) об остальной части релиза, в котором появились новые параметры пикера.
- [Исправление: provisioning profile doesn't include the currently selected device](/ru/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) о том, как запустить код работы с камерой на реальном iPhone.
- [Согласованность записи в базу данных и загрузки в Azure blob в одном запросе](/ru/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) о серверной стороне загрузки фотографий.

## Источники

- [Media picker для фотографий и видео, документация .NET MAUI (MS Learn)](https://learn.microsoft.com/dotnet/maui/platform-integration/device-media/picker?view=net-maui-10.0)
- [`MediaPicker.ios.cs` на теге 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/MediaPicker.ios.cs)
- [`ImageProcessor.shared.cs` на теге 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/ImageProcessor.shared.cs)
- [dotnet/maui#33119: MediaPicker ShouldUsePngFormat method has conflicting/redundant code](https://github.com/dotnet/maui/issues/33119)
- [dotnet/maui#33140: Refactor image rotation and PNG format logic](https://github.com/dotnet/maui/pull/33140)
- [dotnet/maui#11379: CapturePhotoAsync returns PNG in which the orientation data is lost](https://github.com/dotnet/maui/issues/11379)
- [dotnet/maui#36581: Add image metadata APIs and non-destructive MediaPicker processing](https://github.com/dotnet/maui/issues/36581)
