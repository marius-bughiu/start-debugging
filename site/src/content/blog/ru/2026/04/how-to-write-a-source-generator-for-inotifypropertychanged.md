---
title: "Как написать генератор исходного кода для INotifyPropertyChanged"
description: "Полное руководство по созданию собственного инкрементального генератора исходного кода для INotifyPropertyChanged в C# 14 и .NET 11: пайплайн IIncrementalGenerator, маркерные атрибуты, вывод partial class, паттерн SetProperty и как оставаться совместимым с AOT."
pubDate: 2026-04-30
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "source-generators"
  - "mvvm"
lang: "ru"
translationOf: "2026/04/how-to-write-a-source-generator-for-inotifypropertychanged"
translatedBy: "claude"
translationDate: 2026-04-30
---

Чтобы самостоятельно генерировать `INotifyPropertyChanged` (INPC), напишите `IIncrementalGenerator`, который находит классы, помеченные пользовательским атрибутом, читает их поля, аннотированные `[ObservableProperty]`, и испускает `partial class`, реализующий интерфейс, выставляющий свойства-обёртки и поднимающий `PropertyChanged` через помощник `SetProperty`. Генератор работает во время компиляции, не вносит никаких затрат во время выполнения сверх стандартной обвязки INPC и убирает каждую строку рукописного шаблонного кода с резервным полем и сеттером. Это руководство строит генератор от начала до конца на .NET 11 (preview 3) и C# 14, но тот же код работает с любым потребителем, нацеленным на `netstandard2.0` для анализатора, поскольку это всё ещё контракт, который Roslyn требует для генераторов исходного кода.

## Зачем писать свой, когда есть CommunityToolkit.Mvvm

Известный ответ -- `CommunityToolkit.Mvvm`, который поставляет `[ObservableObject]`, `[ObservableProperty]`, `[NotifyPropertyChangedFor]` и небольшую гору хорошо протестированных генераторов. Для большинства приложений берите его. Это руководство для случаев, когда нельзя:

- Вам нужен генератор, испускающий другой интерфейс, такой как `IObservableObject` из домашнего фреймворка или контракт уведомлений конкретного поставщика.
- Вы хотите комбинировать INPC с дополнительным поведением, которое тулкит не покрывает (журналирование аудита, отслеживание изменений, приведение через доменное правило).
- Вы строите учебный артефакт, внутренний домашний фреймворк или генератор, который должен жить рядом с `CommunityToolkit.Mvvm`, не сталкиваясь по именам атрибутов.
- Вы хотите понять тулкит до того, как ему доверять.

Генераторы исходного кода также один из самых чистых мест, где можно из первых рук потрогать API Roslyn, и INPC -- канонический "маленький, чётко определённый, дающий большое плечо" целевой пример. Если вы никогда не писали такой, это лучшая стартовая точка, чем пытаться генерировать код регистрации внедрения зависимостей или конфигурации EF Core.

## Какие части нужно поставить

Полный INPC-генератор имеет три части, каждая в своём проекте или внедрении `<None>`:

1. **Маркерный атрибут**, который потребители применяют к `partial class`. Соглашение: `[Observable]` или `[GenerateInpc]`.
2. **Атрибут уровня поля**, который помечает базовое состояние, которое генератор должен выставить как свойство. Соглашение: `[ObservableProperty]`.
3. Сам **инкрементальный генератор**, упакованный так, чтобы MSBuild загружал его как анализатор.

Маркерный атрибут проще всего поставлять через `RegisterPostInitializationOutput`, что позволяет генератору внедрить исходный код атрибута в компиляцию потребителя. Так потребители добавляют `<ProjectReference>` (или `<PackageReference>` с `OutputItemType="Analyzer"`) и сразу имеют атрибуты, без отдельной runtime-DLL.

## Структура проекта

Проект анализатора должен быть нацелен на `netstandard2.0`, потому что это единственный TFM, который Roslyn загружает в IDE и в MSBuild на .NET Framework, который используют старые установки Visual Studio:

```xml
<!-- src/Inpc.SourceGenerator/Inpc.SourceGenerator.csproj -->
<!-- .NET 11 SDK, generator targets netstandard2.0 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <IsRoslynComponent>true</IsRoslynComponent>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp"
                      Version="4.13.0"
                      PrivateAssets="all" />
  </ItemGroup>
</Project>
```

`IsRoslynComponent` заставляет Visual Studio относиться к проекту как к генератору для загрузки во время разработки. `EnforceExtendedAnalyzerRules` -- набор правил в стиле анализатора, помечающий ошибки вроде `string.Format` с проблемами культуры внутри генераторов, где важна воспроизводимость.

Проект-потребитель ссылается на него как на анализатор:

```xml
<!-- consumer .csproj -->
<ItemGroup>
  <ProjectReference Include="..\Inpc.SourceGenerator\Inpc.SourceGenerator.csproj"
                    OutputItemType="Analyzer"
                    ReferenceOutputAssembly="false" />
</ItemGroup>
```

`ReferenceOutputAssembly="false"` критично: вам **не** нужна DLL анализатора в runtime-пути потребителя. Если забудете, потребитель тащит Roslyn в runtime, что составляет несколько мегабайт мёртвого веса и ломает Native AOT.

## Маркерный атрибут, внедряемый в post-init

Внутри генератора зарегистрируйте источник атрибута до того, как побежит какой-либо анализ. Это гарантирует, что потребители смогут использовать атрибуты без отдельного пакета:

```csharp
// .NET 11, C# 14, generator-side code (netstandard2.0)
using Microsoft.CodeAnalysis;

[Generator]
public sealed class InpcGenerator : IIncrementalGenerator
{
    private const string AttributeSource = """
        // <auto-generated/>
        #nullable enable
        namespace Inpc;

        [global::System.AttributeUsage(
            global::System.AttributeTargets.Class, Inherited = false)]
        internal sealed class ObservableAttribute : global::System.Attribute { }

        [global::System.AttributeUsage(
            global::System.AttributeTargets.Field, Inherited = false)]
        internal sealed class ObservablePropertyAttribute : global::System.Attribute
        {
            public string? PropertyName { get; init; }
        }
        """;

    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        context.RegisterPostInitializationOutput(ctx =>
            ctx.AddSource("Inpc.Attributes.g.cs", AttributeSource));

        // pipeline registration follows in the next section
    }
}
```

Несколько неочевидных решений:

- Атрибуты `internal`. Каждая потребляющая сборка получает свою копию через post-init. Это значит, две сборки могут обе использовать `[Observable]` без игр с `TypeForwardedTo` или конфликтов версий. Цена в том, что атрибуты не выживают через границы сборок, что нормально, потому что генератору они нужны только во время компиляции.
- Каждая ссылка на тип использует префикс `global::`. Сгенерированный код приземляется в произвольных пространствах имён, включая те, что случайно называются `System` или `Inpc`. Без `global::` разрешение имён может выбрать неправильный тип, и сгенерированный файл не скомпилируется.
- Заголовочный комментарий `// <auto-generated/>` подавляет предупреждения анализатора от правил `EditorConfig` и StyleCop.

## Инкрементальный пайплайн

Теперь свяжите фактический анализ. API инкрементального генератора Roslyn состоит из двух половин: `SyntaxProvider`, который выполняет дешёвую синтаксическую фильтрацию при каждом нажатии клавиши, и трансформации, которая делает дорогую семантическую работу только когда меняется синтаксический снимок:

```csharp
// .NET 11, C# 14, generator-side
public void Initialize(IncrementalGeneratorInitializationContext context)
{
    context.RegisterPostInitializationOutput(ctx =>
        ctx.AddSource("Inpc.Attributes.g.cs", AttributeSource));

    var classes = context.SyntaxProvider
        .ForAttributeWithMetadataName(
            "Inpc.ObservableAttribute",
            predicate: static (node, _) => node is ClassDeclarationSyntax c
                && c.Modifiers.Any(SyntaxKind.PartialKeyword),
            transform: static (ctx, ct) => Extract(ctx, ct))
        .Where(static x => x is not null)
        .Select(static (x, _) => x!.Value);

    context.RegisterSourceOutput(classes,
        static (spc, model) => Emit(spc, model));
}
```

`ForAttributeWithMetadataName` -- правильная точка входа для любого атрибутно-управляемого генератора начиная с Roslyn 4.3. Он использует индекс атрибутов компилятора, поэтому `predicate` запускается только на синтаксисе, у которого уже есть подходящее имя атрибута. Это драматически дешевле, чем старый паттерн `CreateSyntaxProvider` плюс `Where`, и это самая большая отдельная победа в производительности из доступных.

`predicate` навязывает `partial` на уровне синтаксиса, до того как существует какая-либо семантическая модель. Это ловит самую распространённую ошибку потребителя (забыли `partial`) самой дешёвой возможной проверкой.

## Извлечение стабильной модели

Трансформация должна возвращать значение, структурно сравнимое. Слой кеширования Roslyn сравнивает значения модели между прогонами, чтобы пропустить повторное испускание, когда ничего не изменилось. Если возвращать символы (`INamedTypeSymbol`, `IFieldSymbol`), каждое нажатие клавиши инвалидирует кеш, потому что символы равны по ссылке только внутри одной компиляции.

Используйте `record` (или `readonly record struct`) из обычных строк:

```csharp
// .NET 11, C# 14, generator-side
internal readonly record struct ClassModel(
    string Namespace,
    string ClassName,
    EquatableArray<PropertyModel> Properties);

internal readonly record struct PropertyModel(
    string FieldName,
    string PropertyName,
    string TypeName);
```

`EquatableArray<T>` -- тонкая обёртка вокруг `ImmutableArray<T>`, реализующая структурный `Equals`. Roslyn такой не поставляет, но каждый проект-генератор копирует одни и те же шесть строк из тулкита:

```csharp
// .NET 11, C# 14, generator-side
internal readonly record struct EquatableArray<T>(ImmutableArray<T> Items)
    : IEnumerable<T> where T : IEquatable<T>
{
    public bool Equals(EquatableArray<T> other) =>
        Items.AsSpan().SequenceEqual(other.Items.AsSpan());

    public override int GetHashCode()
    {
        var hash = new HashCode();
        foreach (var item in Items) hash.Add(item);
        return hash.ToHashCode();
    }

    public IEnumerator<T> GetEnumerator() =>
        ((IEnumerable<T>)Items).GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() =>
        ((IEnumerable)Items).GetEnumerator();
}
```

Забыть это и вернуть сырой `ImmutableArray<T>` -- второй по распространённости баг производительности генератора после неправильного использования `CreateSyntaxProvider`. `ImmutableArray<T>.Equals` основан на ссылке, так что каждый снимок выглядит новым.

Сама функция `Extract` тянет поля из символа:

```csharp
// .NET 11, C# 14, generator-side
private static ClassModel? Extract(
    GeneratorAttributeSyntaxContext ctx,
    CancellationToken ct)
{
    if (ctx.TargetSymbol is not INamedTypeSymbol type) return null;

    var properties = ImmutableArray.CreateBuilder<PropertyModel>();
    foreach (var member in type.GetMembers())
    {
        ct.ThrowIfCancellationRequested();
        if (member is not IFieldSymbol field) continue;

        var attr = field.GetAttributes().FirstOrDefault(a =>
            a.AttributeClass?.ToDisplayString() == "Inpc.ObservablePropertyAttribute");
        if (attr is null) continue;

        string property = attr.NamedArguments
            .FirstOrDefault(kv => kv.Key == "PropertyName")
            .Value.Value as string
            ?? Capitalize(field.Name.TrimStart('_'));

        properties.Add(new PropertyModel(
            FieldName: field.Name,
            PropertyName: property,
            TypeName: field.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)));
    }

    return new ClassModel(
        Namespace: type.ContainingNamespace.IsGlobalNamespace
            ? string.Empty
            : type.ContainingNamespace.ToDisplayString(),
        ClassName: type.Name,
        Properties: new EquatableArray<PropertyModel>(properties.ToImmutable()));
}

private static string Capitalize(string name) =>
    name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];
```

`SymbolDisplayFormat.FullyQualifiedFormat` производит имена в стиле `global::System.Collections.Generic.List<global::Foo.Bar>`, что обходит каждую проблему разрешения пространства имён, на которую испущенный файл иначе мог бы наткнуться.

`ct.ThrowIfCancellationRequested()` внутри цикла важнее, чем можно было бы ожидать. IDE агрессивно отменяет прогоны генератора, пока пользователь печатает; генератор, игнорирующий токен, блокирует IntelliSense.

## Испускание partial class

Шаг испускания -- одиночный проход по `StringBuilder`. Генераторы склонны выращивать построители на основе `Roslyn.SyntaxFactory`, которые красиво выглядят и медленно работают; строковый шаблон годится для столь регулярного кода и его гораздо проще отлаживать:

```csharp
// .NET 11, C# 14, generator-side
private static void Emit(SourceProductionContext ctx, ClassModel model)
{
    var sb = new StringBuilder(1024);
    sb.AppendLine("// <auto-generated/>");
    sb.AppendLine("#nullable enable");
    if (model.Namespace.Length > 0)
    {
        sb.Append("namespace ").Append(model.Namespace).AppendLine(";");
        sb.AppendLine();
    }

    sb.Append("partial class ").Append(model.ClassName)
      .AppendLine(" : global::System.ComponentModel.INotifyPropertyChanged");
    sb.AppendLine("{");
    sb.AppendLine("    public event global::System.ComponentModel.PropertyChangedEventHandler? PropertyChanged;");
    sb.AppendLine();
    sb.AppendLine("    private bool SetProperty<T>(ref T storage, T value, string propertyName)");
    sb.AppendLine("    {");
    sb.AppendLine("        if (global::System.Collections.Generic.EqualityComparer<T>.Default.Equals(storage, value))");
    sb.AppendLine("            return false;");
    sb.AppendLine("        storage = value;");
    sb.AppendLine("        PropertyChanged?.Invoke(this,");
    sb.AppendLine("            new global::System.ComponentModel.PropertyChangedEventArgs(propertyName));");
    sb.AppendLine("        return true;");
    sb.AppendLine("    }");
    sb.AppendLine();

    foreach (var p in model.Properties)
    {
        sb.Append("    public ").Append(p.TypeName).Append(' ').Append(p.PropertyName)
          .AppendLine();
        sb.AppendLine("    {");
        sb.Append("        get => this.").Append(p.FieldName).AppendLine(";");
        sb.Append("        set => SetProperty(ref this.").Append(p.FieldName)
          .Append(", value, nameof(").Append(p.PropertyName).AppendLine("));");
        sb.AppendLine("    }");
        sb.AppendLine();
    }

    sb.AppendLine("}");

    string hint = string.IsNullOrEmpty(model.Namespace)
        ? $"{model.ClassName}.Inpc.g.cs"
        : $"{model.Namespace}.{model.ClassName}.Inpc.g.cs";
    ctx.AddSource(hint, sb.ToString());
}
```

На что стоит обратить внимание:

- `SetProperty` аллоцирует свежий `PropertyChangedEventArgs` на каждое изменение. Это приемлемо для типичных нагрузок UI. Если вы привязываете к INPC высокочастотный поток (состояние игры, данные сенсоров), кешируйте по одному `PropertyChangedEventArgs` на свойство в статическом поле; `[ObservableProperty]` тулкита делает это, когда вы это включаете.
- Имя hint (первый аргумент `AddSource`) должно быть уникальным внутри компиляции. Включение пространства имён предотвращает коллизии, когда два класса в разных пространствах имён имеют одинаковое имя.
- `EqualityComparer<T>.Default` корректно обрабатывает `null` для ссылочных типов и является правильным сравнивателем также для свойств-значений. Использование `==` закоротило бы пользовательское равенство.

## Код потребителя

Смысл всего упражнения:

```csharp
// .NET 11, C# 14, consumer code
using Inpc;

[Observable]
public partial class PersonViewModel
{
    [ObservableProperty]
    private string _firstName = "";

    [ObservableProperty]
    private string _lastName = "";

    [ObservableProperty(PropertyName = "Age")]
    private int _ageYears;
}
```

Генератор испускает публичные свойства `FirstName`, `LastName` и `Age`, событие `PropertyChanged` и помощник `SetProperty`. Файл потребителя остаётся ровно таким, как видно выше, без обвязки `OnPropertyChanged` и без жёстко синхронизированных резервных полей.

## Native AOT и тримминг

Генераторы запускаются во время сборки, поэтому во время выполнения они ничего не стоят. Интересный вопрос -- что *сгенерированный* код стоит в AOT- или триммированном приложении:

- `INotifyPropertyChanged` распознаётся триммером как часть контракта привязки данных. Интерфейс и событие `PropertyChanged` не будут отрезаны от наблюдаемых типов.
- `EqualityComparer<T>.Default` полностью безопасен для трима и AOT; никакой рефлексии.
- Конструктор `PropertyChangedEventArgs` не отрезается, потому что сигнатура события его укореняет.

За чем стоит следить -- XAML-привязка. WPF и Avalonia используют рефлексию для обнаружения свойств INPC, поэтому конфигурации трима для этих фреймворков уже исключают наблюдаемые типы view-model из тримминга через дескрипторы. Скомпилированные привязки MAUI устраняют эту необходимость целиком, и генератор вроде этого естественным образом сочетается с кодогенерацией в стиле `[BindableProperty]`, если вы хотите оба мира.

## Подводные камни, в порядке частоты

- **Забыли `partial` у класса**: `predicate` отфильтровывает его, и ничего не генерируется. Потребитель видит ошибку "определение не найдено" или нереализованный интерфейс и решает, что генератор сломан. Добавьте диагностику в путь predicate, выводящую дружелюбное сообщение через `RegisterSourceOutput` на ветке `Where(x => x is null)`.
- **Возврат символов из трансформации**: убивает инкрементальность. Каждое нажатие клавиши перетрансформирует и переиспускает. Генератор выглядит "достаточно быстро" на репро из одного класса, затем ползёт на реальном решении.
- **Забыли `global::` в испускаемых именах типов**: пространство имён потребителя с именем `System.Foo` затеняет `System`, и сгенерированный файл не компилируется в этом одном проекте, без ошибки в самом проекте генератора. Всегда квалифицируйте полностью.
- **Испускание атрибутов в отдельной runtime-DLL**: возможно, но post-init инъекция проще и избегает любого риска расхождения версий NuGet между анализатором и контрактом времени выполнения.
- **Не обрабатываете соглашение о префиксе `_`**: `string _firstName` должен производить `FirstName`, а не `_FirstName`. Шаг `Capitalize(name.TrimStart('_'))` обрабатывает стандартное соглашение; задокументируйте, какое соглашение вы выберете.
- **Генерация повторяющихся имён hint**: `AddSource("Class.g.cs", ...)` из двух пространств имён сталкивается. Всегда включайте пространство имён в hint.

Генератор, построенный таким образом, состоит примерно из 200 строк кода, работает за микросекунды на изменение и заменяет сотни строк рукописного шаблонного кода на каждого потребителя. Как только вы выпустили один, следующий (команды, регистрация внедрения зависимостей, конечные автоматы) -- копия того же скелета.

## Связанное

- [Как написать пользовательский JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) -- ещё одна "малая, прилегающая к Roslyn точка расширения" с похожими подводными камнями.
- [Как использовать Channels вместо BlockingCollection в C#](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- асинхронные паттерны, сочетающиеся с view-model.
- [Как использовать Native AOT с минимальными API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) -- как trim и AOT видят ваш сгенерированный код.
- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) -- ещё один паттерн, часто сочетающийся со сгенерированным шаблонным кодом.

## Источники

- MS Learn: [Source generators overview](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview)
- Roslyn cookbook: [Incremental generators](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.md)
- Roslyn API: [`IIncrementalGenerator`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.iincrementalgenerator), [`ForAttributeWithMetadataName`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.csharpgeneratorextensions.forattributewithmetadataname)
- CommunityToolkit.Mvvm reference implementation: [CommunityToolkit/dotnet on GitHub](https://github.com/CommunityToolkit/dotnet)
