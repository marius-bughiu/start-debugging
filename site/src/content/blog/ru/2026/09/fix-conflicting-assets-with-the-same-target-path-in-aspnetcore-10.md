---
title: "Исправляем: Conflicting assets with the same target path после перехода на .NET 10 SDK"
description: "В .NET 10 SDK каждый проект Microsoft.NET.Sdk.Web получает StaticWebAssetBasePath=/, поэтому веб-приложение, ссылающееся на другое веб-приложение, вызывает конфликт. Задайте базовый путь в проекте, на который ссылаются. Отключение сжатия не помогает."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "aspnet-core"
  - "blazor"
  - "dotnet-10"
  - "msbuild"
  - "static-web-assets"
lang: "ru"
translationOf: "2026/09/fix-conflicting-assets-with-the-same-target-path-in-aspnetcore-10"
translatedBy: "claude"
translationDate: 2026-09-24
---

Добавьте `<StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>` в проект, **на который ссылаются**, то есть в тот, чей `wwwroot` раньше появлялся под `/_content/...`. Начиная с .NET 10 SDK каждый проект `Microsoft.NET.Sdk.Web` получает базовый путь `/`, поэтому, когда одно веб-приложение ссылается на другое, оба публикуют `css/site.css` по одному и тому же URL, и конвейер статических веб-ресурсов отказывается собирать проект. Отключение сжатия ничего не даёт, потому что проверка выполняется до сжатия. Всё, что описано ниже, измерено на SDK 10.0.302 и SDK 9.0.318 под macOS.

## Ошибка в контексте

Полное сообщение длинное, потому что в него выводятся обе записи о ресурсах. Если сократить до того, что действительно нужно прочитать:

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'css/site#[.{fingerprint}]?.css'. For assets
'Identity: .../Common/wwwroot/css/site.css, SourceType: Project, SourceId: Common, ContentRoot: .../Common/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' and
'Identity: .../Main/wwwroot/css/site.css, SourceType: Discovered, SourceId: Main, ContentRoot: .../Main/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' from different projects.
```

Три поля показывают, с каким случаем вы имеете дело:

- **`SourceId`** называет два проекта, которые создают ресурс. Два разных идентификатора означают конфликт между проектами.
- **`SourceType`** равен `Discovered` для собираемого проекта, `Project` для ссылки на проект и `Package` для пакета NuGet.
- **`BasePath`** это префикс URL. Если у проекта, на который ссылаются, указано `BasePath: /` вместо `_content/<Name>`, перед вами изменение .NET 10, описанное ниже.

Целевой путь иногда заканчивается на `.gz` или `.br`, поэтому обычно в этой ошибке винят сжатие во время сборки, появившееся в .NET 9. В текущем SDK настоящая причина редко в нём.

## Почему это происходит в .NET 10 SDK

Статические веб-ресурсы на этапе сборки решают, какой файл отвечает на какой URL, а манифест может сопоставить маршруту только один файл. До .NET 10 веб-проект, на который *ссылался* другой веб-проект, вёл себя как библиотека классов: SDK по умолчанию задавал его `StaticWebAssetBasePath` как `_content/$(PackageId)`, так что его `wwwroot/css/site.css` превращался в хосте в `/_content/Common/css/site.css`, и ничего не конфликтовало.

В .NET 10 SDK изменился `Sdk.Server.props`, файл props, который импортирует каждый проект `Microsoft.NET.Sdk.Web`, и теперь он безусловно задаёт следующее:

```xml
<!-- SDK 10.0.302: Sdks/Microsoft.NET.Sdk.Web/Targets/Sdk.Server.props -->
<PropertyGroup>
  <DebugSymbols Condition="'$(DebugSymbols)' == ''">true</DebugSymbols>
  <StaticWebAssetProjectMode>Root</StaticWebAssetProjectMode>
  <StaticWebAssetBasePath>/</StaticWebAssetBasePath>
</PropertyGroup>
```

Тот же файл в SDK 9.0.318 не задаёт ни одного из этих свойств. Значение по умолчанию `_content/$(PackageId)` в `Microsoft.NET.Sdk.StaticWebAssets.targets` применяется, только если `StaticWebAssetBasePath` пусто, а в SDK 10 для веб-проекта оно пустым не бывает никогда. Теперь оба веб-приложения претендуют на `/`, и каждый файл, лежащий по одному и тому же относительному пути в обеих папках `wwwroot`, становится конфликтом.

Позиция команды ASP.NET Core, изложенная в [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138), такова: ссылка веб-приложения на веб-приложение никогда не была поддерживаемой конфигурацией. Официально поддерживается только ссылка веб-приложений на библиотеки классов или приложения Blazor. Задачу закрыли без изменений в коде, и на сегодня это изменение не упомянуто ни на [странице критических изменений .NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10), ни на [странице критических изменений ASP.NET Core 10](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/overview). Поэтому столько обновлений натыкаются на него без предупреждения.

Решает здесь **SDK**, а не целевой фреймворк. Проект `net8.0` или `net9.0` падает точно так же, как только его собирают на SDK 10.x, о чём и сообщалось в [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726) для приложения `netcoreapp8.0`.

## Минимальное воспроизведение

Два пустых веб-приложения, у каждого свой `wwwroot/css/site.css`, одно ссылается на другое:

```bash
# SDK 10.0.302
dotnet new web -o Main -n Main
dotnet new web -o Common -n Common
mkdir -p Main/wwwroot/css Common/wwwroot/css
echo "body{color:red}/*Main*/"   > Main/wwwroot/css/site.css
echo "body{color:red}/*Common*/" > Common/wwwroot/css/site.css
dotnet add Main/Main.csproj reference Common/Common.csproj
dotnet build Main
```

Измеренные результаты для этой пары проектов:

| SDK | TargetFramework | Результат |
| --- | --- | --- |
| 9.0.318 | net9.0 | Сборка успешна. Маршруты: `css/site.css`, `_content/Common/css/site.css` |
| 10.0.302 | net9.0 | `Conflicting assets with the same target path 'css/site#[.{fingerprint}]?.css'` |
| 10.0.302 | net10.0 | Та же ошибка |
| 10.0.302 | net10.0, `-p:DisableBuildCompression=true` | Та же ошибка |
| 10.0.302 | net10.0, `-p:CompressionEnabled=false` | Та же ошибка |
| 10.0.302 | net10.0, после `rm -rf */bin */obj` | Та же ошибка |

Запомнить стоит последние три строки. Первый совет, который выдают поисковики по этой ошибке, это отключить сжатие или удалить `bin` и `obj`. Ни то, ни другое при этой причине ничего не меняет. Конфликт выбрасывает `GenerateStaticWebAssetsManifest` в строке 640 файла targets, и он выполняется независимо от того, включено сжатие или нет.

## Исправление: вернуть проекту, на который ссылаются, прежний базовый путь

Поместите свойство в csproj проекта, на который ссылаются (здесь это `Common`), а не хоста:

```xml
<!-- Common.csproj, SDK 10.0.302 -->
<Project Sdk="Microsoft.NET.Sdk.Web">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>
  </PropertyGroup>

</Project>
```

Задание свойства в файле проекта работает, потому что SDK выставляет `/` в файле props, который вычисляется раньше тела вашего проекта, и ваше значение побеждает. После изменения `dotnet build Main` завершается успешно, а `Main.staticwebassets.endpoints.json` содержит оба набора маршрутов:

```text
_content/Common/css/site.css
_content/Common/css/site.css.gz
css/site.css
css/site.css.gz
(plus the fingerprinted variants of each)
```

Я запустил хост с `app.MapStaticAssets()` и запросил оба URL. `/css/site.css` вернул файл из `Main`, а `/_content/Common/css/site.css` вернул файл из `Common`, каждый с `Content-Encoding: gzip`, если запрос это допускал. Значит, сжатые варианты генерируются для каждого проекта точно так же, как раньше.

Базовый путь действует только для потребителей. Я запустил `Common` отдельно после изменения: `/css/site.css` по-прежнему возвращал 200, а `/_content/Common/css/site.css` возвращал 404. Проект, который одновременно является самостоятельным приложением и ссылкой, продолжает работать в обеих ролях.

### Не используйте здесь `$(PackageId)`

Очевидный способ воссоздать прежнее значение по умолчанию это `_content/$(PackageId)`, ведь именно его раньше вычислял SDK. Из csproj это не работает. `PackageId` присваивается позже, в целевых файлах NuGet, так что в момент вычисления вашего `PropertyGroup` он ещё пуст. Я проверил: сборка прошла успешно, но маршруты стали `_content/css/site.css`. Это молча ломает каждый `<link href="_content/Common/...">` в ваших представлениях, при этом выглядит как исправление. Используйте `$(MSBuildProjectName)` или впишите имя явно, если ваш `AssemblyName` отличается от имени файла проекта, а в разметке используется имя сборки.

### Лучше: перестать ссылаться на веб-приложение

Если `Common` существует только для того, чтобы делиться представлениями Razor, компонентами и файлами `wwwroot`, превратите его в библиотеку классов Razor (`Microsoft.NET.Sdk.Razor`). Это поддерживаемая конфигурация, она по умолчанию получает `_content/{PackageId}`, и именно так [документация по статическим файлам Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) описывает совместное использование ресурсов. Оставьте свойство базового пути для случаев, когда проект, на который ссылаются, действительно должен работать и как приложение, например для хоста интеграционных тестов на `Microsoft.NET.Sdk.Web`, который ссылается на настоящее приложение.

## Один и тот же файл в двух проектах Blazor Web App

Второй частый источник ошибки не связан со ссылками веб-проекта на веб-проект. В Blazor Web App с интерактивным WebAssembly и серверный проект, и проект `.Client` вносят ресурсы в `/`. Так задумано: ресурсы клиента отдаются из корня хоста.

Поэтому файл, существующий в обеих папках `wwwroot`, вызывает конфликт. Я воспроизвёл это на шаблоне `dotnet new blazor -int WebAssembly` в SDK 10.0.302, скопировав `favicon.png` в `W.Client/wwwroot`:

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'favicon#[.{fingerprint}]?.png'. For assets 'Identity: .../W.Client/wwwroot/favicon.png, SourceType: Project, ...
```

Здесь исправление не в базовом пути. Переносить файлы клиента под `_content/` вам не нужно. Держите каждый файл ровно в одном из двух проектов. Полезное правило: ресурсы, нужные только разметке, отрисованной на сервере, живут в серверном проекте; ресурсы, которые код WebAssembly загружает во время выполнения, живут в `.Client`. Если вы мигрировали со старого шаблона hosted Blazor WebAssembly, где клиентскому проекту принадлежали `index.html`, `favicon` и CSS, это типичный остаток. [Сравнение моделей хостинга Blazor](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) объясняет, почему два проекта делят один корень.

## Когда причина действительно в сжатии

Сжатие во время сборки появилось в .NET 9, и в предварительных версиях .NET 9 оно действительно вызывало эту ошибку. Пакеты вроде `Z.Blazor.Diagrams` 3.0.2 и некоторые конфигурации бандлеров поставляли собственные файлы `.gz` в `wwwroot`. SDK затем пытался сгенерировать `app.js.gz` для того же ресурса и конфликтовал с уже существующим ([dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512), [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413)).

Это исправили в [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518), закрытой в ноябре 2024 года. Текущий SDK выполняет задачу `DiscoverPrecompressedAssets`, которая распознаёт уже существующий соседний `.gz` или `.br` и считает его сжатым вариантом, а не создаёт собственный. Я проверил оба случая на SDK 10.0.302:

- Веб-приложение с закоммиченными `wwwroot/js/app.js`, `app.js.gz` и `app.js.br`: сборка и публикация проходят без единого предупреждения. Манифест конечных точек сопоставляет `js/app.js` с `js/app.js.gz` через селектор `gzip`, а опубликованный `app.js.gz` побайтово совпадает с созданным мной файлом. Отдаётся ваш файл, а не сгенерированный заново.
- Веб-приложение, ссылающееся на `Z.Blazor.Diagrams` 3.0.2, пакет из #57512: собирается без ошибок.

Так что если вы на предварительной версии SDK 9.0.1xx, обновите SDK. Если вам по-прежнему нужно исключить определённые файлы из сжатия, например потому, что бандлер уже записывает собственный `.br` с лучшими настройками, используйте список исключений, а не отключайте функцию целиком. Это я тоже проверил на SDK 10.0.302: после публикации у `app.bundle.js` не было соседних `.gz` и `.br`, а у `other.js` в той же папке были оба.

```xml
<!-- Host .csproj, SDK 9.0.100 and later -->
<PropertyGroup>
  <CompressionExcludePatterns>$(CompressionExcludePatterns);**/*.bundle.js</CompressionExcludePatterns>
</PropertyGroup>
```

`DisableBuildCompression=true` пропускает сжатие только для `dotnet build` (публикация всё равно сжимает), а `CompressionEnabled=false` полностью убирает целевые объекты сжатия. Оба варианта разумны ради скорости сборки. Ни один не исправляет конфликт базовых путей, что и видно из таблицы выше. Сжатие ответов во время выполнения это ещё одна, отдельная функция; об этой стороне читайте в статье [о добавлении сжатия ответов в API на ASP.NET Core](/ru/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/).

## Подводные камни и похожие ошибки

**"Two assets found targeting the same path with incompatible asset kinds" это другая ошибка.** Она возникает внутри *одного* проекта, например когда элемент `<Content Include="shared/app.js" Link="wwwroot/js/app.js" />` указывает на тот же маршрут, что и настоящий `wwwroot/js/app.js`. Я воспроизвёл её на SDK 10.0.302, она выбрасывается в строке 706 того же файла targets. Удалите один из двух элементов.

**`The "DiscoverPrecompressedAssets" task failed unexpectedly` с `An item with the same key has already been added`** это связанная ошибка .NET 10, которая тоже возникает, когда один веб-проект ссылается на другой, и часто ключ указывает на `blazor.web.js` в `microsoft.aspnetcore.app.internal.assets`. Она всё ещё открыта как [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089). Исправление с базовым путём, описанное выше, стоит попробовать первым, потому что оно устраняет дублирующую регистрацию в самом источнике. Если после обновления вы ещё и ищете пропавший скрипт Blazor, этот пакет разобран в [статье о 404 для blazor.server.js](/ru/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/).

**Если ошибка то появляется, то исчезает между сборками**, подозревайте шаг сборки, который пишет в `wwwroot` (TypeScript, LibMan, бандлер JS), пока целевые объекты статических веб-ресурсов его читают. [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014) описывает состояние гонки, которое проявляется этой ошибкой, `No file exists for the asset` или `The asset ... can not be found`. Оно воспроизводится и с одним целевым фреймворком. Надёжное исправление: запускать генератор отдельным шагом до MSBuild (`npm run build && dotnet build` в CI и в профиле запуска), а не из цели `BeforeTargets="Build"`, чтобы файлы уже лежали на диске, когда SDK вычисляет glob `wwwroot`. Binlog (`dotnet build -bl`) показывает порядок выполнения; [MCP-сервер для binlog](/ru/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/) позволяет быстро сделать по нему запрос.

**Закрепление SDK 9 через `global.json` работает, но только как временная мера.** Воспроизведение успешно собирается на 9.0.318 даже при установленном рядом .NET 10 SDK. Но это также означает, что вы не сможете собирать проекты `net10.0`, а сам конфликт просто откладывается на потом. [dotnetup](/ru/2026/06/dotnetup-official-dotnet-sdk-version-manager/) делает переключение SDK дешёвым, если нужно методом бисекции найти SDK, который внёс сбой в ваш репозиторий.

**Старая цель "удалить каждый `.gz` StaticWebAsset" устарела.** Обходной путь из #57512, который удаляет элементы `StaticWebAsset` с расширением `.gz` до `ResolveStaticWebAssetsConfiguration`, предназначался для предварительных версий .NET 9. В SDK 10 он выбрасывает заранее сжатые файлы, которые SDK теперь обрабатывает корректно, и ничего не делает в случае с базовым путём.

## Связанные материалы

- [Исправляем: 404 Not Found для blazor.server.js после установки нового .NET SDK](/ru/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/), ещё одно изменение статических веб-ресурсов, которое приходит вместе с SDK, а не с целевым фреймворком.
- [Blazor Server, Blazor WebAssembly и Blazor United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/), о том, почему серверный проект и проект `.Client` делят `/`.
- [Как добавить сжатие ответов в API на ASP.NET Core 11](/ru/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), аналог сжатия ресурсов во время сборки, но во время выполнения.
- [MCP-сервер для binlog .NET](/ru/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/), чтобы отследить, какая цель создала конфликтующий ресурс.
- [dotnetup, официальный менеджер версий .NET SDK](/ru/2026/06/dotnetup-official-dotnet-sdk-version-manager/), для проверки репозитория на нескольких SDK.

## Источники

- [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138): регрессия в SDK 10 preview 5, обходной путь через `StaticWebAssetBasePath` и решение "не поддерживается".
- [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726): та же ошибка в приложении `netcoreapp8.0` после установки нового SDK.
- [dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512) и [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518): заранее сжатые ресурсы пакетов в .NET 9 и исправление.
- [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413): настройки сжатия (`DisableBuildCompression`, `BuildCompressionFormats`, `CompressionExcludePatterns`).
- [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089) и [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014): открытые ошибки статических веб-ресурсов в .NET 10 с пересекающимися симптомами.
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) на Microsoft Learn.
- Исходники SDK, изученные локально: `Sdk.Server.props`, `Microsoft.NET.Sdk.StaticWebAssets.targets` и `Microsoft.NET.Sdk.StaticWebAssets.Compression.targets` из SDK 10.0.302 и 9.0.318.
