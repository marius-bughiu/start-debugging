---
title: "Исправление: MAUIR0001 MissingMethodException в .NET MAUI Resizetizer на SVG с <filter> или <text>"
description: "MAUI 10.0.101 и 10.0.110 Resizetizer поставляются с несовпадающими ссылками на System.Memory, поэтому SVG с фильтрами или текстом падают с ошибкой. Зафиксируйте Resizetizer на версии 10.0.100 или уберите filter и text."
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "msbuild"
  - "csharp"
lang: "ru"
translationOf: "2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text"
translatedBy: "claude"
translationDate: 2026-09-28
---

Если сборка вашего .NET MAUI 10 начала падать с `error MAUIR0001: There was an exception processing the image` и `System.MissingMethodException` для `SKImageFilter.CreateMatrixConvolution`, `SKTextBlobBuilder.AddPositionedRun` или `SKTypeface.Clone`, причина в самом пакете Resizetizer, а не в вашем SVG. `Microsoft.Maui.Resizetizer` версий 10.0.101 и 10.0.110 содержит сборку SkiaSharp 4.150.1, которая запрашивает `System.Memory` 4.0.5.0, рядом с `Svg.Skia`, которая запрашивает 4.0.2.0, и MSBuild загружает два разных типа `ReadOnlySpan<T>`. Любой SVG с элементом `<filter>` или `<text>` приводит к падению. Самое быстрое решение - зафиксировать `Microsoft.Maui.Resizetizer` на версии 10.0.100, оставив остальную часть MAUI на 10.0.110; надёжное решение - убрать фильтры и преобразовать текст в пути (paths) в SVG-файлах `MauiIcon`, `MauiSplashScreen` и `MauiImage`.

## Ошибка в контексте

В апстриме сообщили о двух вариантах этой ошибки. Вариант с фильтром, из [dotnet/maui#38319](https://github.com/dotnet/maui/issues/38319):

```text
error MAUIR0001: There was an exception processing the image '...\Resources\AppIcon\appicon.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKImageFilter SkiaSharp.SKImageFilter.CreateMatrixConvolution(
    SkiaSharp.SKSizeI, System.ReadOnlySpan`1<Single>, Single, Single,
    SkiaSharp.SKPointI, SkiaSharp.SKShaderTileMode, Boolean, SkiaSharp.SKImageFilter)'.
   at Svg.Skia.SkiaModel.ToSKImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.GetRenderImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.CreateRenderPaint(SKPaint paint)
   at Svg.Skia.SKSvg.Load(String path)
   at Microsoft.Maui.Resizetizer.SkiaSharpSvgTools..ctor(...)
```

Текстовый вариант на 10.0.101, из [dotnet/maui#38507](https://github.com/dotnet/maui/issues/38507):

```text
error MAUIR0001: There was an exception processing the image '.../Resources/Images/place_capsule.svg'.
System.MissingMethodException: Method not found: 'Void SkiaSharp.SKTextBlobBuilder.AddPositionedRun
(System.ReadOnlySpan`1<UInt16>, SkiaSharp.SKFont, System.ReadOnlySpan`1<SkiaSharp.SKPoint>)'.
```

В 10.0.110 текстовый вариант переместился на другой метод, потому что 10.0.110 поднял `Svg.Skia` с 5.1.1 до 5.2.3, и новая версия по-другому разрешает шрифты. Вот что я получаю на 10.0.110 с обычным элементом `<text>`:

```text
error MAUIR0001: There was an exception processing the image '.../text.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKTypeface SkiaSharp.SKTypeface.Clone(System.ReadOnlySpan`1<SkiaSharp.SKFontVariationPositionCoordinate>)'.
   at Svg.Skia.SkiaModel.ApplyVariableFontWeight(SKTypeface typeface, SKFontStyle style)
   at Svg.Skia.SkiaModel.ResolveSKTypeface(SKTypeface typeface)
   at Svg.Skia.SkiaModel.ToSKFont(SKPaint paint)
```

В одном из комментариев к #38507 также сообщается о варианте того же исключения с `HarfBuzzSharp.Font.SetVariations(ReadOnlySpan<Variation>)` на шаге `GenerateSplashStoryboard` для iOS. Каким бы ни было имя метода, посмотрите на сигнатуру: каждый из них принимает `ReadOnlySpan<T>`. В этом и есть вся суть бага.

## Почему Resizetizer не может найти существующий метод

Первое, что делает каждый, - открывает `SkiaSharp.dll` в декомпиляторе и находит метод прямо на месте. Автор отчёта в #38507 сделал именно это и подтвердил через рефлексию, что `AddPositionedRun(ReadOnlySpan<ushort>, SKFont, ReadOnlySpan<SKPoint>)` присутствует. Я сделал то же самое с помощью `System.Reflection.Metadata` для папки `buildTransitive` каждой версии пакета, и всё сходится: методы существуют в 10.0.100, 10.0.101 и 10.0.110.

Разница - в ссылках на сборки. Вот что запрашивает каждая встроенная сборка:

| Resizetizer | SkiaSharp.dll (TFM) | SkiaSharp хочет System.Memory | Svg.Skia хочет System.Memory | Поставляемый System.Memory.dll |
|---|---|---|---|---|
| 10.0.100 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |
| 10.0.101 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 10.0.110 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 11.0.0-rc.1 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |

Обновление SkiaSharp пришло через [dotnet/maui#37731](https://github.com/dotnet/maui/pull/37731) ("Update SkiaSharp to 4.150.1"), которое было портировано обратно в ветку обслуживания 10.0.1xx и вошло в 10.0.101.

Теперь посмотрим, как `dotnet build` загружает зависимости задачи. MSBuild на .NET помещает каждую сборку задачи в собственный `MSBuildLoadContext`. Когда запрашивается зависимость, он проверяет папку задачи, и в [`MSBuildLoadContext.Load`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs) пропускает локальный файл, если его версия ниже запрошенной:

```csharp
// dotnet/msbuild main, src/Framework/Loader/MSBuildLoadContext.cs (abridged)
AssemblyName candidateAssemblyName = AssemblyLoadContext.GetAssemblyName(candidatePath);
if (candidateAssemblyName.Version < assemblyName.Version)
{
    continue;
}
return LoadFromAssemblyPath(candidatePath);
```

Итак, в 10.0.101 и 10.0.110:

1. `Svg.Skia` запрашивает `System.Memory` 4.0.2.0. В папке задачи есть 4.0.2.0, поэтому MSBuild загружает этот файл в контекст плагина. Этот `System.Memory.dll` - это отдельно поставляемая сборка пакета netstandard2.0, которая **определяет собственный** тип `System.ReadOnlySpan<T>`.
2. `SkiaSharp` запрашивает `System.Memory` 4.0.5.0. Локальная версия 4.0.2.0 слишком старая, поэтому поиск переходит в контекст по умолчанию, который разрешает фасад `System.Memory` общей платформы (shared framework). Этот фасад перенаправляет (type-forward) `ReadOnlySpan<T>` в `System.Private.CoreLib`.
3. `Svg.Skia` компилирует вызов `SKImageFilter.CreateMatrixConvolution(..., ReadOnlySpan<float> [из System.Memory.dll], ...)`. `SkiaSharp` предоставляет `CreateMatrixConvolution(..., ReadOnlySpan<float> [из CoreLib], ...)`. Одинаковое имя, одинаковый текст, разная идентичность типа. Среда выполнения не может связать вызов и выбрасывает `MissingMethodException` при JIT-компиляции вызывающего метода.

Это также объясняет, почему трассировка в #38319 упоминает `CreateMatrixConvolution`, хотя SVG в репродукции использует только `feGaussianBlur`: исключение срабатывает при JIT-компиляции `Svg.Skia.SkiaModel.ToSKImageFilter`, а этот метод содержит вызов для каждого примитива фильтра. Любой SVG с любым `<filter>` доходит до него. SVG без фильтров или текста никогда не обращаются к API SkiaSharp, принимающему span, во время растеризации - поэтому иконка из шаблона по умолчанию по-прежнему собирается.

Чтобы доказать механизм, я скопировал папку `buildTransitive` из 10.0.110, удалил только `System.Memory.dll` и направил задачу на эту копию. Оба падавших SVG растеризовались нормально, потому что теперь каждый запрос `System.Memory` попадает на фасад платформы, и существует только один `ReadOnlySpan<T>`. Не используйте этот хак в продакшене, но он подтверждает диагноз.

## Минимальный репродукт

Вам не нужен ворклоад MAUI, чтобы воспроизвести это, потому что Resizetizer - это обычная задача MSBuild. Извлеките `microsoft.maui.resizetizer.10.0.110.nupkg` и запустите задачу напрямую:

```xml
<!-- .NET SDK 10.0.302, Microsoft.Maui.Resizetizer 10.0.110 (extracted nupkg), run.proj -->
<Project>
  <UsingTask AssemblyFile="$(RzDir)/Microsoft.Maui.Resizetizer.dll"
             TaskName="Microsoft.Maui.Resizetizer.ResizetizeImages" />
  <Target Name="Build">
    <ItemGroup><Img Include="$(Svg)" BaseSize="128,128" /></ItemGroup>
    <ResizetizeImages PlatformType="android"
                      IntermediateOutputPath="$(MSBuildThisFileDirectory)out/"
                      InputsFile="$(MSBuildThisFileDirectory)out/inputs.txt"
                      Images="@(Img)" />
  </Target>
</Project>
```

С двумя тестовыми изображениями:

```xml
<!-- filter.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <filter id="blur"><feGaussianBlur stdDeviation="8" /></filter>
  <rect width="456" height="456" fill="#512BD4" filter="url(#blur)" />
</svg>
```

```xml
<!-- text.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <rect width="456" height="456" fill="#512BD4" />
  <text font-family="Arial" font-size="120" fill="#FFFFFF"><tspan x="60 150 240" y="280">SD!</tspan></text>
</svg>
```

Запуск `dotnet build run.proj -nodeReuse:false -p:RzDir=<buildTransitive folder> -p:Svg=<file>` для каждой версии пакета дал мне следующее на macOS с SDK 10.0.302:

| Resizetizer | обычный SVG | `<filter>` | `<text>` |
|---|---|---|---|
| 10.0.100 | OK | OK | OK |
| 10.0.101 | OK | `CreateMatrixConvolution` | `AddPositionedRun` |
| 10.0.110 | OK | `CreateMatrixConvolution` | `SKTypeface.Clone` |
| 11.0.0-rc.1.26451.6 | OK | OK | OK |

Переключение `PlatformType` на `ios` падает так же на 10.0.110, так что 10.0.110 не исправил ни один из вариантов ни на одной платформе в моих тестах. На сегодняшний день #38319 и #38507 открыты, а предложенное исправление, [dotnet/maui#38883](https://github.com/dotnet/maui/pull/38883), - это черновик, который заменяет встроенный SkiaSharp на его сборку netstandard2.0. Его прогон CI выявил несовпадения нативных библиотек, так что не рассчитывайте на то, что оно попадёт в следующий сервисный релиз.

## Решение 1: зафиксировать Microsoft.Maui.Resizetizer на 10.0.100

Resizetizer работает только во время сборки. Он генерирует PNG и файлы ресурсов; ничего из него не попадает в ваше приложение. Это делает безопасным удержание его на одну версию позади, пока остальная часть MAUI остаётся на 10.0.110.

MAUI SDK добавляет `Microsoft.Maui.Resizetizer` как неявную `PackageReference` на `$(MauiVersion)`, но таргеты удаляют неявный элемент, когда вы объявляете явный с тем же именем. `Microsoft.Maui.Controls` 10.0.110 также зависит от `Microsoft.Maui.Resizetizer >= 10.0.110`, поэтому простое понижение версии приводит к ошибке восстановления:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Maui.Resizetizer from 10.0.110 to 10.0.100.
  App -> Microsoft.Maui.Controls 10.0.110 -> Microsoft.Maui.Resizetizer (>= 10.0.110)
  App -> Microsoft.Maui.Resizetizer (>= 10.0.100)
```

Подавите `NU1605` только для этой одной ссылки, чтобы не скрыть реальные понижения версий в других местах:

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.110, App.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="$(MauiVersion)" />

  <!-- Workaround for dotnet/maui#38319 and #38507. Remove when a fixed Resizetizer ships. -->
  <PackageReference Include="Microsoft.Maui.Resizetizer"
                    Version="10.0.100"
                    PrivateAssets="all"
                    NoWarn="NU1605" />
</ItemGroup>
```

Я проверил, что это восстанавливается без ошибок и что `project.assets.json` разрешает `Microsoft.Maui.Resizetizer/10.0.100`. Если вы используете централизованное управление пакетами (Central Package Management), поместите `Version` в элемент `PackageVersion` и оставьте `NoWarn="NU1605"` на `PackageReference`.

Более грубая альтернатива, которую использовали оба автора отчётов об ошибках, - зафиксировать весь MAUI на более старой версии с помощью `<MauiVersion>10.0.100</MauiVersion>`. Это работает, но вы отказываетесь от всех исправлений в 10.0.110 ради обхода одной задачи сборки. Делайте так, только если у вас уже есть причина удерживать MAUI на старой версии.

## Решение 2: убрать фильтры и текст из SVG, которые обрабатывает Resizetizer

Это решение я бы сохранил даже после того, как апстрим выпустит патч, потому что оно также делает так, что ваши иконки везде отображаются одинаково. Resizetizer растеризует SVG с помощью `Svg.Skia`, которая не является браузером. Текст зависит от шрифтов, установленных на машине сборки (ваш macOS CI-раннер и ваш ноутбук с Windows выберут разные запасные варианты), а фильтры SVG всегда были наименее достоверной частью любого рендерера, не являющегося браузером.

Преобразуйте текст в контуры (outlines). В Inkscape 1.x это можно сделать из командной строки, что удобно для целой папки ассетов:

```bash
# Inkscape 1.x, converts <text> to <path> and drops editor metadata
inkscape design/splash-source.svg --export-text-to-path --export-plain-svg --export-filename=Resources/Splash/splash.svg
```

В Figma используйте "Outline stroke" / "Flatten" для текстового слоя перед экспортом; в Illustrator - "Create Outlines". Держите редактируемый исходный файл где-то за пределами `Resources/`, чтобы Resizetizer никогда его не видел.

Для фильтров у вас есть два варианта:

- Заменить эффект геометрией. Тень (drop shadow) на иконке приложения - это обычно вторая фигура с меньшей непрозрачностью, смещённая на несколько пикселей. Мягкое свечение может быть радиальным градиентом. Ни то, ни другое не требует `<filter>`.
- Растеризовать слой эффекта самостоятельно и использовать PNG. `MauiIcon` и `MauiSplashScreen` принимают PNG, а PNG никогда не проходят через `Svg.Skia`. Экспортируйте в наибольшем нужном вам размере (1024x1024 для иконки приложения iOS). Согласно [документации по иконкам приложений](https://learn.microsoft.com/dotnet/maui/user-interface/images/app-icons), растровое изображение, используемое как основное, изменяет размер только тогда, когда вы задаёте `BaseSize`, поэтому самая простая настройка - оставить SVG в качестве фона и перенести эффект в PNG на переднем плане:

```xml
<!-- .NET 10, MAUI 10.0.110, App.csproj -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg"
            ForegroundFile="Resources\AppIcon\appiconfg.png"
            Color="#512BD4" />
</ItemGroup>
```

Чтобы найти все затронутые файлы до того, как это сделает CI, найдите по grep два названия элементов:

```bash
# any shell with grep; lists SVGs the 10.0.101/10.0.110 Resizetizer will choke on
grep -rlE "<(filter|text)[ >]" --include="*.svg" Resources/
```

## Решение 3: перейти на MAUI 11, если вы и так собирались

Resizetizer из .NET MAUI 11 RC 1 (`11.0.0-rc.1.26451.6`) по-прежнему включает SkiaSharp 3.116.1 и соответствующую `Svg.Skia` 2.0.0.4, и все три тестовых SVG растеризовались с ним нормально. Это не повод переходить на релиз-кандидат из-за одной ошибки сборки, но если обновление уже запланировано, эта проблема исчезнет вместе с ним. Учтите, что ветка обслуживания 10.0.1xx получила SkiaSharp 4.150.1 первой, так что более поздняя сборка MAUI 11 может унаследовать ту же пару версий, если проблема не будет исправлена в источнике.

## Подводные камни и похожие случаи

- **Локально всё проходит, а в CI падает.** Resizetizer инкрементальный. Если PNG были сгенерированы более ранней сборкой на 10.0.100, таргет пропускается, и ваша локальная сборка остаётся зелёной после обновления. Чистые сборки на CI регенерируют их и падают. Запустите `dotnet clean` или удалите `obj/` локально, чтобы увидеть реальное состояние.
- **`dotnet build-server shutdown` не помогает.** Это не устаревший узел MSBuild, держащий старый SkiaSharp. Автор отчёта в #38319 подтвердил, что проблема воспроизводится с `-nodeReuse:false`, и мой репродукт тоже использует этот флаг.
- **Добавление `PackageReference` на SkiaSharp в ваше приложение не помогает.** Задача загружает копии из папки `buildTransitive` пакета, а не из графа зависимостей вашего приложения. Именно поэтому обновление не вызвало предупреждения NuGet.
- **Существуют и другие причины MAUIR0001.** `MAUIR0001` - это общий код Resizetizer'а для "exception processing the image". `ArgumentNullException` или `Unable to allocate pixels for the bitmap` под тем же кодом - это другая проблема со своими собственными обращениями в апстрим (например, [dotnet/maui#12109](https://github.com/dotnet/maui/issues/12109)). Только `MissingMethodException` с параметром `ReadOnlySpan` относится к этому багу.
- **Шрифты в `MauiFont` не затронуты.** Сбой происходит только при растеризации SVG. Отрисовка текста во время выполнения, включая пользовательские шрифты, не затрагивает этот код.
- **Сбои загрузки сборок в вашем собственном приложении выглядят похоже, но это не то же самое.** Если вы получаете `MissingMethodException` или `FileLoadException` во время выполнения, а не во время сборки, см. вместо этого [как исправить Could not load file or assembly в опубликованном приложении](/ru/2026/05/fix-could-not-load-file-or-assembly-in-published-app/).

## Связанные материалы

- Если сборка Android также падает сразу после шага Resizetizer, [исправление "Gradle build failed to produce an .apk file" в MAUI Android](/ru/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) описывает следующий по частоте сбой CI.
- Для CI-раннеров iOS, которые тоже перестали собираться после обновления SDK, см. [Unable to find a valid iOS Simulator runtime during a MAUI build](/ru/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/).
- Конвейер ассетов Resizetizer и элементы `MauiIcon` / `MauiSplashScreen` разбираются в статье [миграция с Xamarin.Forms на .NET MAUI 11](/ru/2026/05/migrate-from-xamarin-forms-to-maui-11/).
- Упаковка для стора регенерирует все размеры иконок, поэтому [упаковка приложения .NET MAUI для Microsoft Store](/ru/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) - это то место, где отфильтрованная иконка SVG проявит себя на Windows.

## Источники

- [dotnet/maui#38319: Resizetizer fails on any SVG app icon containing a `<filter>`](https://github.com/dotnet/maui/issues/38319)
- [dotnet/maui#38507: Resizetizer 10.0.101 fails on SVG `<text>` elements](https://github.com/dotnet/maui/issues/38507)
- [dotnet/maui#37731: Update SkiaSharp to 4.150.1](https://github.com/dotnet/maui/pull/37731)
- [dotnet/maui#38883: Fix Resizetizer loading incorrect SkiaSharp assembly (draft)](https://github.com/dotnet/maui/pull/38883)
- [dotnet/msbuild `MSBuildLoadContext.cs`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs)
- [Microsoft.Maui.Resizetizer on NuGet](https://www.nuget.org/packages/Microsoft.Maui.Resizetizer)
- [Add images to a .NET MAUI app project (MS Learn)](https://learn.microsoft.com/dotnet/maui/user-interface/images/images)
</content>
