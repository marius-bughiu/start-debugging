---
title: "Перевод решения .NET на Central Package Management с Directory.Packages.props"
description: "Перенесите все версии пакетов из файлов csproj в один Directory.Packages.props. Разбираем скрипт-генератор, который сводит конфликтующие версии с настоящей semver-сортировкой, diff графа зависимостей до и после, доказывающий, что именно изменилось, NU1008/NU1010/NU1013/NU1507, транзитивное закрепление, GlobalPackageReference, VersionOverride и почему вложенный Directory.Packages.props незаметно перекрывает корневой."
pubDate: 2026-08-28
template: migration
tags:
  - "migration"
  - "dotnet"
  - "nuget"
  - "csharp"
lang: "ru"
translationOf: "2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props"
translatedBy: "claude"
translationDate: 2026-08-28
---

Central Package Management переносит все атрибуты `Version` из файлов `.csproj` в один `Directory.Packages.props` в корне репозитория. Включите его через `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`, объявите `<PackageVersion Include="..." Version="..." />` для каждого пакета, который использует решение, и удалите атрибут `Version` из каждого `<PackageReference>`. Сама миграция механическая и легко скриптуется. Человек нужен там, где надо свести пакеты, закреплённые на разных версиях в разных проектах, потому что их объединение — это реальное изменение поведения, а не изменение форматирования. Всё изложенное ниже проверено на .NET 10 SDK 10.0.302 со встроенным NuGet 7.6.0.

## Что на самом деле меняется

До этого каждый проект владеет своими версиями:

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
</ItemGroup>
```

После — проект объявляет только то, *от чего* он зависит, а корневой файл решает, *какая версия*:

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" />
</ItemGroup>
```

```xml
<!-- Directory.Packages.props -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
```

`Directory.Packages.props` обнаруживается подъёмом *вверх* от каталога каждого проекта — так же, как `Directory.Build.props`. Он не обязан лежать рядом с файлом решения, и ничто не импортирует его явно. Обратите внимание: переезжает только версия. `PrivateAssets`, `IncludeAssets` и `ExcludeAssets` остаются на `PackageReference` в том проекте, которому они нужны, потому что это решения уровня проекта.

## Шаги

1. Создайте `Directory.Packages.props` в корне репозитория с `ManagePackageVersionsCentrally` равным `true`.
2. Соберите версию каждого `PackageReference` из каждого проекта и выпустите по одному элементу `PackageVersion` на идентификатор пакета.
3. Разберитесь с пакетами, которые встречаются более чем в одной версии. Это единственный шаг, который не механический.
4. Удалите атрибут `Version` из каждого `PackageReference` в каждом проекте.
5. Выполните восстановление и сравните разрешённый граф зависимостей с тем, что вы зафиксировали перед началом.

## Генерируем файл из того, что уже есть

Файловое C#-приложение здесь удобно: один файл, никакого проекта, и `dotnet run` выполняет его напрямую. Собрать версии, сообщить о конфликтах, записать props-файл, а затем убрать атрибуты.

```csharp
// migrate-to-cpm.cs -- запуск: dotnet run migrate-to-cpm.cs .
#:property ManagePackageVersionsCentrally=false
#:package NuGet.Versioning@6.*

using System.Xml.Linq;
using NuGet.Versioning;

var root = args.Length > 0 ? args[0] : ".";
var projects = Directory.GetFiles(root, "*.csproj", SearchOption.AllDirectories);
var versions = new Dictionary<string, SortedSet<NuGetVersion>>(StringComparer.OrdinalIgnoreCase);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        var id = (string?)reference.Attribute("Include") ?? (string?)reference.Attribute("Update");
        var version = (string?)reference.Attribute("Version") ?? (string?)reference.Element("Version");
        if (id is null || version is null) continue;
        if (!versions.TryGetValue(id, out var set))
            versions[id] = set = new SortedSet<NuGetVersion>();
        if (NuGetVersion.TryParse(version, out var parsed)) set.Add(parsed);
    }
}

foreach (var (id, set) in versions.Where(v => v.Value.Count > 1))
    Console.WriteLine($"conflict: {id} -> {string.Join(", ", set)}");

var props = new XElement("Project",
    new XElement("PropertyGroup",
        new XElement("ManagePackageVersionsCentrally", true),
        new XElement("CentralPackageTransitivePinningEnabled", true)),
    new XElement("ItemGroup",
        versions.OrderBy(v => v.Key, StringComparer.OrdinalIgnoreCase)
                .Select(v => new XElement("PackageVersion",
                    new XAttribute("Include", v.Key),
                    new XAttribute("Version", v.Value.Max()!)))));

File.WriteAllText(Path.Combine(root, "Directory.Packages.props"), props + Environment.NewLine);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    var changed = false;
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        if (reference.Attribute("Version") is { } attribute) { attribute.Remove(); changed = true; }
        if (reference.Element("Version") is { } element) { element.Remove(); changed = true; }
    }
    if (changed) doc.Save(project);
}

Console.WriteLine($"wrote {versions.Count} PackageVersion entries from {projects.Length} projects");
```

Две детали в этом скрипте несущие.

Первая — `NuGetVersion` вместо обычных строк. Сортировать версии как текст неправильно, причём неправильно именно в ту сторону, которая тихо вас понижает:

```text
string  max: 13.0.3
semver  max: 13.0.10
```

Вторая — директива `#:property ManagePackageVersionsCentrally=false` в первой строке. Без неё скрипт ломает сам себя ровно в тот момент, когда отрабатывает успешно. Директива `#:package` файлового приложения разворачивается в `PackageReference` *с* `Version`, а только что записанный скриптом `Directory.Packages.props` лежит в том же дереве каталогов, так что следующий запуск падает, не дойдя до `Main`:

```text
migrate-to-cpm.cs.csproj : error NU1008: The following PackageReference items cannot define a value for
Version: NuGet.Versioning. Projects using Central Package Management must define a Version value on a
PackageVersion item.
```

Это стоит запомнить и вне контекста этого скрипта: включение CPM в корне репозитория распространяется и на все файловые `.cs`-приложения в нём, а `#:package` с этим несовместим. Выводите каждое из них через `#:property` или держите скрипты вне дерева.

## Конфликты и есть миграция

Запустите скрипт на решении, где три проекта расходятся, и вы получите настоящий список задач:

```text
conflict: Serilog -> 4.1.0, 4.2.0
conflict: Newtonsoft.Json -> 13.0.1, 13.0.3
wrote 3 PackageVersion entries from 3 projects
```

Брать самую высокую версию, как делает скрипт, — правильное *значение по умолчанию* и неправильная *политика*. Правильное, потому что решение, которое поставляет две версии одной библиотеки, обычно случайность, а не решение, и потому что нижнее закрепление чаще всего то самое устаревшее, к которому никто не возвращался. Неправильная политика, потому что «побеждает старшая» — это ровно тот способ, которым вы незаметно пересекаете границу мажорной версии в одном проекте, пока всего лишь наводили порядок в файлах сборки. Прочитайте список и всё, что перескакивает мажорную версию, мигрируйте в этом проекте осознанно, а не руками скрипта.

## Докажите, что именно сдвинулось

CPM — не пустая операция, и способ узнать, что он реально сделал, — сравнить разрешённый граф. Зафиксируйте его до начала, из результата восстановления каждого проекта:

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); [print(k) for t in d['targets'].values() for k in sorted(t)]" src/Domain/obj/project.assets.json
```

До и после для решения из трёх проектов выше:

```text
            BEFORE                       AFTER
Api       Newtonsoft.Json/13.0.3      Newtonsoft.Json/13.0.3
          Polly/8.5.0                 Polly/8.5.0
          Serilog/4.2.0               Serilog/4.2.0
Domain    Newtonsoft.Json/13.0.1  ->  Newtonsoft.Json/13.0.3
Workers   Serilog/4.1.0           ->  Serilog/4.2.0
          Polly/8.5.0                 Polly/8.5.0
```

Сдвинулись два проекта. Именно это изменение нужно протестировать и вынести в описание пул-реквеста. Если ваш diff пуст, миграция была по-настоящему механической и её можно влить с куда меньшими церемониями.

## Четыре ошибки, с которыми вы столкнётесь

**NU1008** — у `PackageReference` всё ещё есть `Version`. Это ожидаемое состояние на середине миграции, и это ошибка, а не предупреждение, так что наполовину мигрированный репозиторий не собирается.

```text
error NU1008: The following PackageReference items cannot define a value for Version: Serilog.
```

**NU1010** — у `PackageReference` нет соответствующего `PackageVersion`. Обычно это пакет, который встречается только в проекте, не попавшем под сканирование скрипта, например вне переданного ему корня.

```text
error NU1010: The following PackageReference items do not define a corresponding PackageVersion item:
Humanizer.Core.
```

**NU1013** — использован `VersionOverride`, когда `CentralPackageVersionOverrideEnabled` равно `false`. Смотрите аварийные выходы ниже.

**NU1507** — предупреждение, и как раз то, которое игнорируют:

```text
warning NU1507: There are 2 package sources defined in your configuration. When using central package
management, please map your package sources with package source mapping
(https://aka.ms/nuget-package-source-mapping) or specify a single package source.
The following sources are defined: nuget.org, contoso
```

С одним источником ничего не меняется. С приватным фидом рядом с nuget.org централизованно объявленная версия становится разрешимой из любого из них, что расширяет окно для подмены через dependency confusion. Исправляйте это сопоставлением источников пакетов, а не подавлением предупреждения.

## Транзитивное закрепление

Это та возможность, ради которой миграция окупается сама по себе. Включите её через `<CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>`, и любой объявленный вами `PackageVersion` начнёт применяться и к пакетам, приходящим транзитивно.

Возьмите проект, который ссылается на `Newtonsoft.Json.Bson` и больше ни на что. Его зависимость `Newtonsoft.Json >= 12.0.1` разрешается ровно в это, хотя `Directory.Packages.props` объявляет 13.0.3, потому что `PackageVersion` без соответствующего `PackageReference` по умолчанию ничего не делает:

```text
warning NU1903: Package 'Newtonsoft.Json' 12.0.1 has a known high severity vulnerability
```

Включите транзитивное закрепление — и то же восстановление проходит чисто:

```text
Top-level Package           Requested   Resolved
> Newtonsoft.Json.Bson      1.0.2       1.0.2

Transitive Package      Resolved
> Newtonsoft.Json       13.0.3
```

Пакет поднят до 13.0.3 и остаётся классифицированным как транзитивный, то есть не становится частью публичной поверхности зависимостей вашего проекта и не протекает в nuspec пакета, который вы выпускаете. В этом и весь смысл: можно закрыть уязвимую транзитивную зависимость сразу во всех проектах, не добавляя прямую ссылку, которую потом надо не забыть удалить.

## GlobalPackageReference

Пакеты, работающие только во время сборки и нужные в каждом проекте — провайдеры source link, анализаторы, инструменты версионирования, — имеют собственный тип элемента. Объявите его один раз в `Directory.Packages.props` и не трогайте ни один `.csproj`:

```xml
<ItemGroup>
  <GlobalPackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0.0" />
</ItemGroup>
```

Учтите, что `GlobalPackageReference`, в отличие от `PackageReference`, несёт свою `Version` прямо в элементе. Он применяется везде как ссылка верхнего уровня с поведением ресурсов «только для разработки», поэтому будет появляться в `dotnet package list` каждого проекта. Используйте его только для пакетов, которые действительно нужны во всех; пакет, ставший глобальным «пока что», убрать потом очень тяжело.

## Аварийные выходы

Одному проекту нужна другая версия, и у вас есть реальная причина. `VersionOverride` побеждает центральное значение:

```xml
<PackageReference Include="Newtonsoft.Json" VersionOverride="13.0.1" />
```

Если ваша цель при переходе на CPM была в том, чтобы сделать расхождение версий невозможным, закройте эту дверь через `<CentralPackageVersionOverrideEnabled>false</CentralPackageVersionOverrideEnabled>` — любое использование превратится в NU1013.

Целый проект можно вывести из схемы через `<ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>` в его `.csproj`, после чего он снова управляет своими версиями внутри файла. Имейте в виду, что это выводит проект и из транзитивного закрепления, так что уязвимая транзитивная зависимость, поднятая во всём остальном решении, в этом одном проекте возвращается обратно.

## Вложенный Directory.Packages.props перекрывает, а не объединяет

Обход в поисках файла останавливается на первом найденном. Поэтому `Directory.Packages.props` в подкаталоге полностью заменяет корневой, а не дополняет его, и каждый проект под ним немедленно падает с NU1010 на пакетах, которые объявлял корневой файл. Если вам нужны версии по областям, импортируйте родительский файл явно и накладывайте поверх через `Update`:

```xml
<Project>
  <Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Packages.props', '$(MSBuildThisFileDirectory)../'))" />
  <ItemGroup>
    <PackageVersion Update="Newtonsoft.Json" Version="13.0.2" />
  </ItemGroup>
</Project>
```

Именно `Update`, а не `Include`, потому что элемент уже существует. Ошибка здесь даёт два элемента `PackageVersion` на один пакет, что неоднозначно.

## CLI уже всё знает

Править props-файл руками после миграции не нужно. Команды работы с пакетами в .NET 10 SDK знают про CPM и сами пишут в нужный файл.

`dotnet package add Humanizer.Core --project src/Lib1/Lib1.csproj` добавляет в проект `PackageReference` без версии *и* вставляет `PackageVersion` в `Directory.Packages.props` в алфавитном порядке:

```text
info : PackageReference for package 'Humanizer.Core' version '3.0.10' added to file
'/repo/Directory.Packages.props'.
```

`dotnet package update Serilog --project src/App/App.csproj` правит только центральную версию и не трогает файл проекта. `dotnet package list --outdated` по-прежнему отчитывается корректно, включая элементы `GlobalPackageReference`. `dotnet nuget why <project> <package>` остаётся самым быстрым способом выяснить, какая ссылка притащила транзитивный пакет, который вы собираетесь закрепить.

## По теме

- CPM естественно сочетается с очисткой транзитивных зависимостей из [NuGet Package Pruning включён по умолчанию в .NET 10](/ru/2026/05/nuget-package-pruning-default-net-10/), который убирает из графа пакеты, поставляемые фреймворком, ещё до того, как закрепление начнёт о них думать.
- Директивы `#:package` и `#:property`, использованные в скрипте миграции, полностью разобраны в [как запустить файловое C#-приложение через `dotnet run app.cs`](/ru/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/).
- Свести версии между проектами полезно *до* [перехода с .NET 8 на .NET 11](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), чтобы смена фреймворка осталась единственной переменной в diff.
- Если проект перестал компилироваться после того, как вы убрали из него версии, причина обычно в самой ссылке, а не в CPM; смотрите [тип или имя пространства имён не найдены после добавления ссылки на проект](/ru/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/).
- Когда два проекта сходятся на одной версии, узнаёте вы об этом по ошибкам загрузки во время выполнения; [не удалось загрузить файл или сборку в опубликованном приложении](/ru/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) разбирает их диагностику.

## Источники

- [Central Package Management](https://learn.microsoft.com/ru-ru/nuget/consume-packages/central-package-management) в документации NuGet — про `PackageVersion`, `GlobalPackageReference`, `VersionOverride` и транзитивное закрепление.
- [Справочник по ошибкам и предупреждениям NuGet](https://learn.microsoft.com/ru-ru/nuget/reference/errors-and-warnings/) для NU1008, NU1010, NU1013 и NU1507.
- [Сопоставление источников пакетов](https://learn.microsoft.com/ru-ru/nuget/consume-packages/package-source-mapping) — рекомендуемый ответ на NU1507.
- [Настройка сборки с помощью Directory.Build.props](https://learn.microsoft.com/ru-ru/visualstudio/msbuild/customize-by-directory) — про обход каталогов, который управляет и `Directory.Packages.props`.
