---
title: "MAUI 10.0.120: BlazorWebView наконец принимает перетаскивание файлов в Windows и перетаскивание изображений в Android"
description: ".NET MAUI 10.0.120 включает AllowDrop для BlazorWebView в Windows и регистрирует AndroidX DropDataContentProvider в Android, поэтому зоны drop в Blazor Hybrid работают без платформенного кода. Что изменилось, новый переключатель MauiEnableAndroidWebViewDragDrop и предупреждение MAUI1002."
pubDate: 2026-10-22
tags:
  - "maui"
  - "blazor"
  - "blazor-hybrid"
  - "dotnet"
lang: "ru"
translationOf: "2026/10/maui-10-0-120-blazorwebview-accepts-file-drops-on-windows-and-image-drags-on-android"
translatedBy: "claude"
translationDate: 2026-10-22
---

[.NET MAUI 10.0.120](https://github.com/dotnet/maui/releases/tag/10.0.120) вышел 21 октября 2026 года и содержит 213 коммитов. Большая часть из них это исправления, но два изменения в BlazorWebView убирают обходной путь, который тащит за собой каждое приложение Blazor Hybrid с областью "перетащите сюда файлы" начиная с .NET 6: файл, перетащенный из Проводника на `BlazorWebView` в Windows, теперь доходит до вашей HTML-цели для drop, а перетаскивание изображений внутри `BlazorWebView` в Android теперь создаёт настоящие данные перетаскивания.

## Windows: AllowDrop теперь включён по умолчанию

До сих пор обработчик Windows создавал WinUI `WebView2` с `AllowDrop`, оставленным в `false`. DOM никогда не получал событие `drop` для файлов, приходящих извне приложения, поэтому зона drop в Blazor, которая работала в браузере, в десктопной сборке молча ничего не делала. Обычным решением было собственное сопоставление в обработчике. [PR #37904](https://github.com/dotnet/maui/pull/37904) меняет `BlazorWebViewHandler.CreatePlatformView` так:

```csharp
protected override WebView2Control CreatePlatformView()
{
    return new WebView2Control
    {
        AllowDrop = true,
    };
}
```

Это значит, что обычный `InputFile`, растянутый на область drop, теперь работает в Windows без единой строки платформенного кода:

```razor
<div class="dropzone">
    <InputFile OnChange="OnFilesDropped" multiple />
    <p>Drop files here</p>
</div>

@code {
    async Task OnFilesDropped(InputFileChangeEventArgs e)
    {
        foreach (var file in e.GetMultipleFiles(maxAllowedFiles: 10))
        {
            await using var stream = file.OpenReadStream(maxAllowedSize: 20 * 1024 * 1024);
            // save or process the stream
        }
    }
}
```

Если вы писали mapper, который сам выставлял `AllowDrop = true`, после обновления его можно удалить. Одно ограничение остаётся: нативное перетаскивание элементов и изображений внутри страницы в Windows по-прежнему не работает с текущей зависимостью MAUI от Windows App SDK 1.8. Автор PR проверил Windows App SDK 2.0.1 и обнаружил, что эти сценарии начинают работать там, как только включён `AllowDrop`, так что этот параметр также служит заделом для такого перехода.

## Android: DropDataContentProvider регистрируется за вас

В Android перетаскивание `<img>` в `BlazorWebView` вызывало события drag в DOM, но не несло пригодных данных изображения. Для этого Android WebView требует, чтобы в манифесте был объявлен `DropDataContentProvider` из AndroidX WebKit. [PR #37975](https://github.com/dotnet/maui/pull/37975) делает так, что `Microsoft.AspNetCore.Components.WebView.Maui` для целей Android зависит от `Xamarin.AndroidX.WebKit` 1.16.0.1 и сливает этот provider в ваш манифест через `AndroidManifestOverlay`:

```xml
<provider
  android:name="androidx.webkit.DropDataContentProvider"
  android:authorities="${applicationId}.DropDataProvider"
  android:exported="false"
  android:grantUriPermissions="true" />
```

Если в вашем приложении уже объявлен тот же provider, две записи сольются в одну. Если вы объявляете его с другой конфигурацией, отключите автоматическую регистрацию:

```xml
<PropertyGroup>
  <MauiEnableAndroidWebViewDragDrop>false</MauiEnableAndroidWebViewDragDrop>
</PropertyGroup>
```

Это свойство управляет только записью в манифесте. Ссылка на пакет `Xamarin.AndroidX.WebKit` остаётся в любом случае.

## Обратите внимание на MAUI1002

Проекты, в которых по-прежнему задано `<AndroidManifestMerger>legacy</AndroidManifestMerger>`, теперь увидят предупреждение `MAUI1002`, потому что устаревший merger игнорирует элементы `AndroidManifestOverlay`, и provider никогда не попадает в манифест. Либо переключитесь на `manifestmerger.jar` (значение по умолчанию), либо установите `MauiEnableAndroidWebViewDragDrop` в `false` и объявите provider в `Platforms/Android/AndroidManifest.xml` самостоятельно. Если вы собираете с предупреждениями как ошибками, это единственная строка в 10.0.120, которая может сломать ваш CI.

## Обновление

Поднимите `Microsoft.Maui.Controls` и `Microsoft.AspNetCore.Components.WebView.Maui` до `10.0.120`, оба уже есть в NuGet. Тот же релиз также продолжает очистку утечек, о которой я писал в [посте про 10.0.110](/ru/2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter/), включая утечку `BlazorWebView` в iOS, при которой `DisconnectHandlers()` никогда не доходил до страниц внутри `Shell`.
