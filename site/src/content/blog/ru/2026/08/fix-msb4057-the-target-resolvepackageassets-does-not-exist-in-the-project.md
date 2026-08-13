---
title: "Решение: MSB4057 The target \"ResolvePackageAssets\" does not exist in the project в .NET MAUI"
description: "MSB4057 означает, что цель выполнялась во внешней cross-targeting сборке мульти-таргет проекта MAUI. Укажите TFM или добавьте цели условие по TargetFramework."
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "dotnet-maui"
  - "msbuild"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/08/fix-msb4057-the-target-resolvepackageassets-does-not-exist-in-the-project"
translatedBy: "claude"
translationDate: 2026-08-13
---

`ResolvePackageAssets` не пропала, и с вашими пакетами всё в порядке. Цель выполнялась во **внешней (cross-targeting) сборке** мульти-таргет проекта, а .NET SDK не импортирует туда `ResolvePackageAssets`. Либо зафиксируйте один фреймворк (`dotnet build -f net10.0-android -t:ResolvePackageAssets`), либо, если её вызывает файл `.targets` из пакета NuGet, добавьте этой цели `Condition="'$(TargetFramework)' != ''"`, чтобы она выполнялась только во внутренних сборках. Удаление `bin` и `obj` не поможет.

Всё изложенное ниже проверено на .NET SDK 10.0.201 (MSBuild 18.3.0) с workload-ами `maui-android` / `maui-ios` / `maui-maccatalyst` 10.0.20. Механизм cross-targeting в .NET 11 не изменился.

## Ошибка в контексте

```text
C:\src\MauiApp1\MauiApp1.csproj : error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

Build FAILED.
    0 Warning(s)
    1 Error(s)
```

Когда причиной служит пакет NuGet, ошибка указывает файл и колонку вместо пути к проекту, и это верный признак того, что цель запросил файл `.targets`, а не вы:

```text
C:\Users\me\.nuget\packages\ikvm.maven.sdk\1.9.2\buildTransitive\IKVM.Maven.Sdk.targets(37,64):
  error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

## Почему MSB4057 возникает в мульти-таргет проекте

У приложения MAUI указано `TargetFrameworks` (во множественном числе):

```xml
<!-- .NET 10, MAUI 10 app csproj, from dotnet new maui -->
<TargetFrameworks>net10.0-android</TargetFrameworks>
<TargetFrameworks Condition="!$([MSBuild]::IsOSPlatform('linux'))">$(TargetFrameworks);net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
<TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net10.0-windows10.0.19041.0</TargetFrameworks>
```

MSBuild собирает такой проект **дважды**: один внешний проход, который только распределяет работу, и по одному внутреннему проходу на каждый фреймворк. То, в каком из них вы находитесь, SDK определяет одним свойством, заданным в `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets`:

```xml
<!-- .NET SDK 10.0.201, Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets -->
<PropertyGroup Condition="'$(TargetFrameworks)' != '' and '$(TargetFramework)' == ''">
  <IsCrossTargetingBuild>true</IsCrossTargetingBuild>
</PropertyGroup>

<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.CrossTargeting.targets"
        Condition="'$(IsCrossTargetingBuild)' == 'true'"/>
<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.targets"
        Condition="'$(IsCrossTargetingBuild)' != 'true'"/>
```

Эта последняя пара объясняет всё. `ResolvePackageAssets` определена в `Microsoft.PackageDependencyResolution.targets`, которая импортируется из `Microsoft.NET.Sdk.targets`, а та импортируется **только тогда, когда `IsCrossTargetingBuild` не равно true**. Во внешней сборке вместо неё подключается `Microsoft.NET.Sdk.CrossTargeting.targets`, и полный набор доступных целей сокращается до следующего:

- Из `Microsoft.Common.CrossTargeting.targets`: `Build`, `Clean`, `Rebuild`, `DispatchToInnerBuilds`, `GetTargetFrameworks`, `GetTargetFrameworksWithPlatformFromInnerBuilds`, `InitializeSourceControlInformation`
- Из `Microsoft.NET.Sdk.CrossTargeting.targets`: `Publish`, `GetAllRuntimeIdentifiers`, `GetPackagingOutputs`
- Из `Microsoft.NET.Sdk.Workloads.CrossTargeting.targets`: `_GetRequiredWorkloads`

Запросите во внешней сборке что-либо за пределами этого списка, и MSBuild выдаст MSB4057. `ResolvePackageAssets`, `GetTargetPath`, `GetCopyToOutputDirectoryItems` и `ComputeFilesToPublish` в него не входят. По этой же причине тот же текст ошибки появляется как `The target "GetTargetPath" does not exist in the project`, когда AppHost из .NET Aspire пытается оркестрировать проект MAUI: механизм тот же, имя цели другое.

## Минимальное воспроизведение

Чтобы увидеть это, MAUI не нужен. Любой проект с `TargetFrameworks` во множественном числе ведёт себя точно так же, что сводит воспроизведение к двум файлам:

```xml
<!-- MultiLib/MultiLib.csproj, .NET SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net10.0;net9.0</TargetFrameworks>
  </PropertyGroup>
</Project>
```

```bash
# .NET SDK 10.0.201
# outer build: no -f, so TargetFramework is empty
dotnet build -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

# inner build: -f selects one framework
dotnet build -t:ResolvePackageAssets -f net10.0
# Build succeeded.
```

Те же две команды на свежесозданном приложении `dotnet new maui` завершаются точно так же, с `-f net10.0-android`.

## Как убедиться, что я во внешней сборке?

Прежде чем править файлы проекта, установите, в какой сборке вы находитесь. Ключ `-getProperty` вычисляет проект без сборки, поэтому отрабатывает мгновенно даже на приложении MAUI:

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:IsCrossTargetingBuild -getProperty:TargetFramework
```

На приложении MAUI без выбранного фреймворка:

```json
{
  "Properties": {
    "IsCrossTargetingBuild": "true",
    "TargetFramework": ""
  }
}
```

Значение `IsCrossTargetingBuild: true` подтверждает, что MSB4057 вызвана cross-targeting, а не опечаткой. Добавьте `-p:TargetFramework=net10.0-android`, и та же команда вернёт пустой `IsCrossTargetingBuild`, что означает: внутренняя сборка располагает полным набором целей SDK. Чтобы увидеть, из каких фреймворков можно выбирать, запросите их напрямую:

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:TargetFrameworks
# net10.0-android;net10.0-ios;net10.0-maccatalyst;net10.0-windows10.0.19041.0
```

Если `IsCrossTargetingBuild` возвращается пустым, а MSB4057 всё равно возникает, переходите к разделу о проектах не в стиле SDK: это другая первопричина с тем же кодом ошибки.

## Как не дать файлу .targets из пакета NuGet сломать внешнюю сборку?

Это решение для подавляющего большинства сообщений в MAUI, потому что именно на него вы наткнётесь, не запрашивая ни одной цели по имени. Пакет NuGet (или ваш собственный `Directory.Build.targets`) цепляется к `AfterTargets="Build"` и объявляет зависимость от `ResolvePackageAssets`. Во внутренних сборках это работает. Затем выполняется внешняя цель `Build`, `AfterTargets="Build"` срабатывает снова, и зависимость не разрешается:

```xml
<!-- Directory.Build.targets, broken on a multi-targeted project -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

Обычный `dotnet build` на приведённом выше `MultiLib` выдаёт ровно это, и порядок строк выдаёт причину:

```text
ran for TF=[net9.0]
ran for TF=[net10.0]
Directory.Build.targets(4,11): error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
Build FAILED.
```

Обе внутренние сборки прошли, и *затем* упал внешний проход. Если в вашем журнале сборки работа по каждому фреймворку завершается, а *после* появляется MSB4057, это ваш случай. Добавьте условие:

```xml
<!-- Directory.Build.targets, fixed. .NET SDK 10.0.201 -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets"
          Condition="'$(TargetFramework)' != ''">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

Теперь та же сборка выводит `ran for TF=[net9.0]`, `ran for TF=[net10.0]`, `Build succeeded.` Это условие является каноничной для SDK формулировкой «только во внутренней сборке», и именно его пакет должен был поставить. Если проблемная цель находится внутри пакета в `~/.nuget/packages/<id>/<ver>/build*/`, не правьте её на месте: следующий restore перезапишет вашу правку. Заведите баг в исходном проекте, а пока отключите импорт локально.

## Как вызвать одну цель из CLI?

Если `-t:` набираете вы сами, укажите фреймворк:

```bash
# .NET SDK 10.0.201, MAUI 10
dotnet build -t:ResolvePackageAssets -f net10.0-android
```

Это важно для скриптов и шагов CI, которые вызывают отдельные цели для анализа сборки. `dotnet build` и `dotnet publish` без `-t:` сами по себе безопасны, потому что `Build` и `Publish` присутствуют в наборе cross-targeting и умеют распределять работу.

## Как вызвать цель в другом проекте через задачу MSBuild?

Когда один проект запускает цель в другом (собственные инструменты, оркестрирующие цели какого-либо SDK, шаг упаковки), задача `MSBuild` подчиняется тому же правилу. Это не работает:

```xml
<!-- broken: no framework selected on the callee -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj" Targets="GetTargetPath">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

```text
MultiLib.csproj : error MSB4057: The target "GetTargetPath" does not exist in the project.
```

Задайте свойство в вызове, и всё разрешается:

```xml
<!-- fixed. .NET SDK 10.0.201 -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj"
           Targets="GetTargetPath"
           Properties="TargetFramework=net10.0">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

Если жёстко задавать фреймворк не хочется, сначала вызовите `GetTargetFrameworks` (она существует во внешней сборке, ровно для этого и предназначена), а затем пройдите по результату.

## Нужно ли менять ProjectReference на мульти-таргет проект?

Обычная `ProjectReference` на мульти-таргет проект **не** приводит к MSB4057. MSBuild автоматически согласует совместимый фреймворк, и консольное приложение `net10.0`, ссылающееся на приведённую выше библиотеку `net10.0;net9.0`, собирается без ошибок. Вмешиваться нужно только тогда, когда согласование не может выбрать победителя, что часто бывает, если тестовый или инструментальный проект ссылается на head приложения MAUI. Используйте `SetTargetFramework`:

```xml
<!-- .NET SDK 10.0.201 -->
<ItemGroup>
  <ProjectReference Include="..\MultiLib\MultiLib.csproj"
                    SetTargetFramework="TargetFramework=net9.0" />
</ItemGroup>
```

Это направляет ссылку в одну конкретную внутреннюю сборку, и `MultiLib.dll` оказывается в выходном каталоге потребителя, как и ожидается. Если вместо MSB4057 вы видите `NETSDK1005: Assets file doesn't have a target for ...`, значит подводит согласование, а не отсутствующая цель, и `SetTargetFramework` по-прежнему является решением.

## Что делать, если проект вообще не в стиле SDK?

Есть второй, не связанный с первым путь к тому же коду ошибки. Устаревший `.csproj`, который напрямую импортирует `Microsoft.CSharp.targets`, никогда не импортирует цели .NET SDK, поэтому `ResolvePackageAssets` не существует **ни в одном** проходе:

```xml
<!-- legacy non-SDK csproj -->
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>
  </PropertyGroup>
  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />
</Project>
```

```bash
# .NET SDK 10.0.201
dotnet msbuild -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

На это натыкаются те, кто добавляет знающий об SDK пакет NuGet (IKVM.Maven.SDK здесь регулярный пример) в старую библиотеку классов, или те, кто держит binding-проект эпохи Xamarin внутри решения MAUI. Здесь `IsCrossTargetingBuild` пуст, поэтому приведённая выше диагностика различает эти два случая одной командой. Решение состоит в переводе проекта на стиль SDK или в отказе от пакетов, которые рассчитывают на цели SDK. Мигрировать такие остатки обычно правильно в любом случае, если вы и так переходите с Xamarin.Forms 5.0 на .NET MAUI 11.

## Нюансы и похожие ошибки, из-за которых сюда попадают по ошибке

**MSB4018: The "ResolvePackageAssets" task failed unexpectedly.** Другая ошибка, другая причина. Цель существует и *выполнилась*; исключение выбросила сама задача. Обычно виноват повреждённый `project.assets.json` или нечитаемый пакет в глобальном кеше, и это единственный случай, когда удаление `obj/` с последующим `dotnet restore` действительно помогает.

**«The ResolvePackageAssets task was not given a value for the required parameter TargetFramework».** Тоже путаница внутренней и внешней сборки, но здесь до цели дошли с пустым `TargetFramework`, а не не нашли её. Решение то же: выберите фреймворк.

**MSB4057 из `dotnet ef` на .NET 10.** Зарегистрировано как регрессия инструмента `dotnet-ef` 10 в [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230), исправление намечено на веху 10.0.2. Если вы столкнулись с этим, зафиксируйте версию инструмента вместо перестройки проекта:

```bash
# workaround for the dotnet-ef 10 regression
dotnet tool update --global dotnet-ef --version 9.0.10
```

**MSB4057 с именем цели, которую написали вы сами.** Тогда цель действительно отсутствует или написана с опечаткой, то есть это тот случай, который описан в [MSB4057 в документации MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057). Проверьте написание `BeforeTargets`, `AfterTargets`, `DependsOnTargets` и `CallTarget`, а также убедитесь, что никакое `Condition` в определении цели её не исключило.

**Оркестрация MAUI-head через Aspire.** [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043) представляет собой ту же проблему внешней сборки, всплывающая как `The target "GetTargetPath" does not exist`. Чистого решения с вашей стороны нет: приложение MAUI не является обслуживаемым ресурсом Aspire, поэтому уберите его из AppHost и сошлитесь вместо этого на общую библиотеку классов с одним таргетом.

## Какие цели относятся к внутренней сборке?

Всё, что лезет внутрь проекта за входными данными компилятора, ресурсами пакетов или путями вывода, относится к внутренней сборке. Если ваша цель обращается к `ResolvePackageAssets`, `@(ReferencePath)` или `$(TargetPath)`, ей нужно `Condition="'$(TargetFramework)' != ''"`. Эта единственная строка предотвращает большинство сообщений о MSB4057 в репозиториях MAUI и ничего не стоит в проектах с одним таргетом, где `TargetFramework` задан всегда.

О смежных сбоях сборки в том же стеке читайте разборы о том, [почему MSB3027 сообщает, что не смог скопировать файл после десяти попыток](/ru/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/), [что проверять, когда сборка Gradle не создаёт .apk в MAUI Android](/ru/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/), [как устранить ошибку типа или пространства имён после добавления ссылки на проект](/ru/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) и [полный чек-лист миграции с Xamarin.Forms на .NET MAUI 11](/ru/2026/05/migrate-from-xamarin-forms-to-maui-11/).

## Источники

- [Диагностический код MSB4057](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057), документация MSBuild
- `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets` и `Microsoft.Common.CrossTargeting.targets`, .NET SDK 10.0.201
- [ikvmnet/ikvm-maven#76](https://github.com/ikvmnet/ikvm-maven/issues/76), MSB4057 из файла `.targets` пакета в проекте не в стиле SDK
- [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043), вариант с `GetTargetPath` на MAUI-head
- [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230), регрессия `dotnet-ef` 10
