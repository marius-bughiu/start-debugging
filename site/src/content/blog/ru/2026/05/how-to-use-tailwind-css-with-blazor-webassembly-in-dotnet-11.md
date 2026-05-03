---
title: "Как использовать Tailwind CSS с Blazor WebAssembly в .NET 11"
description: "Полная настройка Tailwind CSS v4 в приложении Blazor WebAssembly на .NET 11: standalone CLI (без Node), цель MSBuild, директивы @source для файлов Razor и CSS-изоляции, и конвейер публикации, который выживает после Native AOT."
pubDate: 2026-05-03
tags:
  - "blazor"
  - "blazor-webassembly"
  - "tailwind-css"
  - "dotnet-11"
  - "csharp"
  - "msbuild"
lang: "ru"
translationOf: "2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-03
---

Минимально жизнеспособная настройка Tailwind v4 для приложения Blazor WebAssembly на .NET 11 состоит из трёх движущихся частей: standalone-бинарника Tailwind CLI (без Node, без npm), цели MSBuild `BeforeBuild`, которая его запускает, и файла `Styles/app.css`, директивы `@source` которого указывают на ваши файлы `.razor` и `.razor.css`. CLI компилирует в `wwwroot/css/app.css`, вы ссылаетесь на этот файл из `wwwroot/index.html`, и сборка добавляет примерно одну секунду на холодном запуске и от 50 до 150 мс на инкрементальных пересборках. Тот же конвейер выживает после `dotnet publish`, тримминга и Native AOT, ни один из которых не трогает CSS, но все из которых ломают наивные настройки на основе Node.

Это руководство показывает полную интеграцию на `Microsoft.AspNetCore.Components.WebAssembly` 11.0.0 с Tailwind CSS 4.0.x, C# 14 и SDK, закреплённым в `global.json` на `9.0.100` или новее (SDK .NET 11 поставляется как `9.0.100` до GA). Каждое утверждение ниже было проверено на пустом проекте `dotnet new blazorwasm-empty` на Windows 11 и Ubuntu 24.04.

## Почему шаблоны на основе Node не выживают сборку Blazor

Большинство туториалов "Tailwind в Blazor" по-прежнему советуют установить Node, запустить `npm install -D tailwindcss`, написать `tailwind.config.js` и вызвать `npx tailwindcss` из цели сборки. Эта настройка работает на ноутбуке разработчика и взрывается при первом же запуске в чистом контейнере или образе CI без Node:

- Цель MSBuild вызывает `npx`, который сразу падает с `'npx' is not recognized`. Шаг `dotnet publish` завершается с кодом 1 и трассировкой стека, указывающей в MSBuild, а не в ваш код.
- `package.json` и `node_modules` оказываются в системе контроля версий рядом с `.csproj`, удваивая время восстановления и раздувая репозиторий сотнями мегабайт транзитивных npm-пакетов, единственная задача которых -- скомпилировать один CSS-файл.
- PostCSS-путь Tailwind v4 использует [Lightning CSS](https://lightningcss.dev/), который поставляет нативные бинарники для каждой ОС и CPU. `package-lock.json`, испечённый на Windows, падает на Linux-агенте сборки, и в качестве обходного пути приделывается шаг `npm rebuild`.

[Tailwind v4](https://tailwindcss.com/blog/tailwindcss-v4) выпустил standalone CLI явно для того, чтобы обойти весь этот стек. Это один бинарник, около 80 МБ, содержащий полный компилятор и сканер контента Oxide. Вы кладёте его рядом с репозиторием (или устанавливаете системно), вызываете его из MSBuild, и единственная зависимость, которая нужна образу CI, -- это сам файл.

## Получите standalone Tailwind v4 CLI

Tailwind публикует бинарники для каждой платформы при каждом релизе. Выберите тот, который соответствует вашим агентам сборки и машинам разработчиков:

- Windows x64: `tailwindcss-windows-x64.exe`
- Linux x64: `tailwindcss-linux-x64`
- macOS arm64: `tailwindcss-macos-arm64`

Скачайте со [страницы релизов Tailwind CSS](https://github.com/tailwindlabs/tailwindcss/releases) и либо положите файл в `tools/tailwindcss.exe` внутри вашего репозитория (закоммиченный, ~80 МБ), либо установите системно через `winget install --id TailwindLabs.Tailwind` на Windows или `brew install tailwindcss` на macOS.

Подход с закоммиченным бинарником -- тот, который выдерживает CI без сюрпризов, потому что сборке не нужен сетевой доступ, и каждый участник получает ровно ту же версию Tailwind. Компромисс -- ~80 МБ в истории Git. Если это вас беспокоит, храните его в [Git LFS](https://git-lfs.com/) или загружайте на лету в цели `Restore`. В оставшейся части этого поста я буду предполагать, что бинарник лежит в `tools/tailwindcss.exe`.

```text
MyBlazorApp/
├── MyBlazorApp.csproj
├── Styles/
│   └── app.css
├── tools/
│   └── tailwindcss.exe   <-- standalone v4 binary
└── wwwroot/
    ├── index.html
    └── css/
        └── app.css        <-- generated, gitignored
```

Добавьте сгенерированный файл в `.gitignore`:

```text
# .gitignore
wwwroot/css/app.css
```

Сгенерированный CSS -- чистый артефакт сборки; его коммит порождает шумные диффы каждый раз, когда кто-то меняет имя класса в компоненте.

## Подключите CLI к вашему `.csproj`

Откройте `MyBlazorApp.csproj` и добавьте цель `BeforeBuild`. Задача `Exec` вызывает standalone CLI с правильным входом, выходом и (в `Release`) флагом `--minify`.

```xml
<!-- MyBlazorApp.csproj  (.NET 11, Tailwind CSS 4) -->
<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TailwindCli>$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
    <TailwindInput>$(MSBuildProjectDirectory)/Styles/app.css</TailwindInput>
    <TailwindOutput>$(MSBuildProjectDirectory)/wwwroot/css/app.css</TailwindOutput>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="11.0.0" />
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly.DevServer" Version="11.0.0" PrivateAssets="all" />
  </ItemGroup>

  <Target Name="TailwindBuild" BeforeTargets="BeforeBuild">
    <Exec Command="&quot;$(TailwindCli)&quot; -i &quot;$(TailwindInput)&quot; -o &quot;$(TailwindOutput)&quot; $(TailwindArgs)"
          ConsoleToMSBuild="true" />
  </Target>

  <Target Name="TailwindBuildRelease" BeforeTargets="TailwindBuild" Condition="'$(Configuration)' == 'Release'">
    <PropertyGroup>
      <TailwindArgs>--minify</TailwindArgs>
    </PropertyGroup>
  </Target>
</Project>
```

Две вещи стоит знать об этой цели. Во-первых, команда `Exec` экранирует кавычками каждый путь, так что сборка по-прежнему работает, когда проект находится по адресу `C:\Users\you\Documents\My Apps\Blazor`. Во-вторых, флаг `--minify` срабатывает только в `Release`, что сохраняет сборки `Debug` быстрыми и даёт вам читаемый CSS в инструментах разработчика браузера во время разработки.

На Linux и macOS вы можете заменить специфичный для Windows путь условием для каждой ОС:

```xml
<TailwindCli Condition="'$(OS)' == 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
<TailwindCli Condition="'$(OS)' != 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss</TailwindCli>
```

Оба бинарника имеют один и тот же интерфейс CLI; единственная разница -- имя файла и бит исполняемости в Unix.

## Скажите Tailwind, где живут ваши классы

Самое большое изменение Tailwind v4 для пользователей Blazor -- исчезновение `tailwind.config.js`. Фреймворк теперь делает CSS-first конфигурацию: вы помещаете блоки `@theme`, `@source` и `@layer` прямо во входной CSS-файл, и никакого JavaScript-конфига вообще нет. Это хорошая новость для проектов .NET, у которых не было никаких причин тащить JS-тулчейн ради определения цветовой палитры.

Создайте `Styles/app.css` и скажите Tailwind, где искать имена классов. По умолчанию v4 сканирует только файловую систему относительно входного CSS, поэтому без явных директив `@source` он ничего не найдёт в ваших файлах Razor.

```css
/* Styles/app.css -- Tailwind CSS 4.0 */
@import "tailwindcss";

@source "../**/*.razor";
@source "../**/*.razor.cs";
@source "../**/*.razor.css";
@source "../**/*.cshtml";
@source "../wwwroot/index.html";

@theme {
  --color-brand-50:  oklch(96% 0.02 260);
  --color-brand-500: oklch(64% 0.18 260);
  --color-brand-900: oklch(28% 0.10 260);

  --font-sans: "Inter", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", monospace;
}

@layer components {
  .btn-primary {
    @apply inline-flex items-center gap-2 rounded-md
           bg-brand-500 px-4 py-2 text-sm font-medium text-white
           hover:bg-brand-900 focus-visible:outline-2 focus-visible:outline-offset-2
           focus-visible:outline-brand-500 transition-colors;
  }
}
```

Несколько деталей стоит выделить. Глоб `../**/*.razor.cs` ловит файлы code-behind, где вы можете собирать имена классов динамически, например `var classes = active ? "bg-brand-500" : "bg-gray-100";`. Сканер контента Tailwind -- это экстрактор на основе регулярных выражений ([движок Oxide](https://tailwindcss.com/blog/tailwindcss-v4#new-high-performance-engine)), поэтому пока литеральная строка появляется где угодно в просканированном файле, она окажется в выводе. Блок `@theme` определяет токены дизайна как пользовательские свойства CSS, которые Tailwind затем выставляет как утилиты (`bg-brand-500`, `text-brand-900`). Это полностью заменяет JavaScript-блок `theme: { extend: { colors: ... } }` из v3.

Подключите сгенерированный файл в `wwwroot/index.html`:

```html
<!-- wwwroot/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MyBlazorApp</title>
  <base href="/" />
  <link rel="stylesheet" href="css/app.css" />
  <link rel="stylesheet" href="MyBlazorApp.styles.css" />
</head>
<body>
  <div id="app">Loading...</div>
  <script src="_framework/blazor.webassembly.js"></script>
</body>
</html>
```

Ссылка `MyBlazorApp.styles.css` -- это бандл CSS-изоляции Blazor, который SDK генерирует из каждого файла `Component.razor.css` в проекте. Порядок имеет значение: загружайте `app.css` первым, чтобы стили с областью видимости компонентов могли переопределить значения по умолчанию Tailwind.

## Заставьте CSS-изоляцию хорошо работать

CSS-изоляция Blazor добавляет атрибут области видимости для каждого компонента (например, `b-9pdypsqo3w`) к каждому селектору и переписывает элементы, чтобы они несли этот атрибут. Утилиты Tailwind, применяемые напрямую к элементам в разметке, наследуют область видимости автоматически, но директивы `@apply` внутри файла `Component.razor.css` требуют момента внимания.

Это работает:

```razor
@* Pages/Counter.razor *@
<button class="btn-primary" @onclick="IncrementCount">
  Count: @currentCount
</button>
```

`btn-primary` пришёл из вашего блока `@layer components` в `Styles/app.css`, поэтому определение класса живёт в глобальном `app.css`. Кнопка по-прежнему получает атрибут области видимости, но селектор Tailwind -- это `.btn-primary` (без области видимости), который совпадает.

Это тоже работает и является правильным способом написания приватных для компонента утилит:

```css
/* Pages/Counter.razor.css */
@reference "../../Styles/app.css";

.danger {
  @apply rounded-md bg-red-600 px-3 py-1 text-white;
}
```

Директива `@reference` (новая в v4) сообщает Tailwind, токены дизайна какого входного файла использовать, без дублирования их CSS в бандле компонента. Без `@reference` `@apply red-600` не может разрешиться, потому что у CSS-файла с областью видимости компонента нет собственного `@import "tailwindcss";`. С ней только байты утилиты `red-600` подтягиваются в бандл с областью видимости, а атрибут области видимости сохраняется проходом CSS-изоляции Blazor.

Добавьте файлы изоляции к вашим шаблонам `@source` (уже показано выше), чтобы любые классы, которые вы пишете встроенно в файлах `.razor.css`, извлекались вместе с остальными. Если вы помещаете утилиты только в разметку и никогда не ссылаетесь на них в `.razor.css`, вы можете убрать этот глоб.

## Реальный компонент от начала до конца

Вот страница `Pages/Home.razor` и её CSS с областью видимости, построенные на токенах дизайна, определённых выше. Она использует утилиты напрямую в разметке, вызывает пользовательский класс компонента из `app.css` и добавляет одну приватную для компонента утилиту через `@apply`.

```razor
@* Pages/Home.razor *@
@page "/"

<section class="mx-auto max-w-3xl px-6 py-12">
  <h1 class="font-sans text-4xl font-semibold text-brand-900">
    Tailwind on Blazor WebAssembly
  </h1>
  <p class="mt-3 text-base text-slate-600">
    Built with the standalone CLI, no Node toolchain required.
  </p>

  <div class="mt-8 flex items-center gap-3">
    <button class="btn-primary" @onclick="Refresh">Refresh</button>
    <span class="status">Last refresh: @lastRefresh.ToLocalTime():T</span>
  </div>
</section>

@code {
    private DateTime lastRefresh = DateTime.UtcNow;

    private void Refresh() => lastRefresh = DateTime.UtcNow;
}
```

```css
/* Pages/Home.razor.css */
@reference "../../Styles/app.css";

.status {
  @apply text-sm font-mono text-slate-500;
}
```

Запустите `dotnet build`. Цель `TailwindBuild` срабатывает до того, как SDK начинает компилировать C#, бинарник сканирует каждый файл Razor и CSS, который соответствует глобам `@source`, и `wwwroot/css/app.css` приземляется только с теми утилитами, которые вы действительно использовали. На свежесозданном проекте `blazorwasm-empty` вывод падает с теоретических 3.5 МБ неминифицированного Tailwind до примерно 18 КБ минифицированного для приведённой выше страницы. Это число масштабируется в зависимости от того, сколько различных утилит вы используете во всём приложении, что и является смыслом движка по требованию.

## Production-сборки, `dotnet publish` и Native AOT

`dotnet publish -c Release` запускает ту же цель `BeforeBuild` с включённым `--minify`. Опубликованный вывод в `bin/Release/net11.0/publish/wwwroot/css/app.css` -- это минифицированный файл, готовый к сжатию Brotli конвейером публикации Blazor (`BlazorEnableCompression`, включён по умолчанию).

Есть несколько шероховатостей, о которых стоит знать:

- **Native AOT для Blazor WebAssembly**: шаг компиляции AOT (`<RunAOTCompilation>true</RunAOTCompilation>`) работает с .NET-сборками, никогда с CSS. Tailwind полностью находится за пределами этого конвейера, поэтому AOT ничего не меняет для этой настройки. Время холодной публикации растягивается с 30 секунд до нескольких минут, но Tailwind остаётся стоимостью менее секунды в этой смеси.
- **Тримминг**: триммер также не имеет ничего общего с CSS. Однако он время от времени будет жаловаться на рефлексию внутри JavaScript-библиотек, смежных с Tailwind, которые вы можете добавить (например, helper-ы headless UI). Держите их изолированными в JS-файлах, на которые ссылается `index.html`, а не в бандле через какой-либо слой C# interop.
- **Бандлинг статических веб-ресурсов**: если вы устанавливаете `<BlazorWebAssemblyLoadAllGlobalizationData>` или используете [опции сжатия Blazor на этапе публикации](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/webassembly), `wwwroot/css/app.css` включается автоматически. Никакой дополнительной настройки не требуется.
- **Режим watch**: `dotnet watch` перезапускает цель `BeforeBuild` при каждом изменении файла Razor, поэтому добавление класса в компонент запускает перекомпиляцию Tailwind, и браузер горячо перезагружает новую таблицу стилей в течение секунды. Если вы хотите истинное наблюдение только за CSS (дешевле полной перекомпиляции Razor), запустите `tools/tailwindcss.exe --watch` в отдельном терминале параллельно с `dotnet watch run`.

## Ловушки, о которых стоит знать

Приведённая выше настройка устойчива, но три вещи постоянно кусают людей на входе.

Во-первых, классы, сконструированные во время выполнения, которые сканер не может увидеть в исходном коде, не выживут чистку Tailwind. `var c = $"bg-{color}-500";` производит `bg-red-500` во время выполнения, но Tailwind никогда не видит литерал в исходниках и выбрасывает его из вывода. Решение -- явно занести полный набор в белый список через комментарий:

```csharp
// .NET 11, C# 14: Tailwind scanner sees these literals
// bg-red-500 bg-green-500 bg-blue-500
private static string ColorClass(string color) => $"bg-{color}-500";
```

Экстрактор Tailwind на основе регулярных выражений находит эти литералы в комментарии и сохраняет их в бандле. Конкатенация во время выполнения затем разрешается в класс, который действительно существует в CSS.

Во-вторых, преренденные страницы Blazor (гибридная конфигурация Blazor United, где хост серверно рендерит WASM-клиент) требуют, чтобы и `app.css`, и `MyBlazorApp.styles.css` были доступны из конвейера статических файлов сервера. Если вы разделяете проект на хост `Server` плюс WASM-проект `Client`, [схема разделения валидации, которую я разобрал ранее на этой неделе](/ru/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) -- это та же схема: проект `Client` владеет сборкой Tailwind, а `Server` ссылается на `Client`, чтобы его `wwwroot` публиковался вместе с хостом.

В-третьих, интеграция с IDE. Официальное расширение [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) для VS Code читает ваш `Styles/app.css` и даёт вам автодополнения внутри файлов `.razor`, как только вы добавите `razor` в настройку `tailwindCSS.includeLanguages`. Rider и Visual Studio оба поставляют плагины Tailwind с релизов 2025.1, оба работают одинаково: укажите им на входной CSS-файл, и они автоматически подхватят токены дизайна из `@theme`.

## По теме

- [Как разделить логику валидации между сервером и Blazor WebAssembly](/ru/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) -- схема расположения проекта, которая естественно сочетается с этим CSS-конвейером.
- [dotnet new webworker: первоклассные Web Workers для Blazor в .NET 11 Preview 2](/ru/2026/04/dotnet-11-preview-2-blazor-webworker-template/) -- для разгрузки CPU-работы без поломки вашей раскладки Tailwind.
- [Blazor Virtualize наконец справляется с элементами переменной высоты в .NET 11](/ru/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/) -- поскольку строки переменной высоты плохо сочетаются с утилитами Tailwind, которые запекают фиксированные размеры.
- [Blazor SSR наконец получает TempData в .NET 11](/ru/2026/04/blazor-ssr-tempdata-dotnet-11/) -- для шаблонов стилизации flash-сообщений, которые вы можете построить на токенах дизайна выше.

## Источники

- [Заметки о релизе Tailwind CSS v4.0](https://tailwindcss.com/blog/tailwindcss-v4)
- [Релизы standalone CLI Tailwind CSS](https://github.com/tailwindlabs/tailwindcss/releases)
- [Справочник директив `@source` и `@theme`](https://tailwindcss.com/docs/functions-and-directives)
- [Обзор CSS-изоляции Blazor на MS Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/css-isolation)
- [Заметки о релизе .NET 11](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md)
