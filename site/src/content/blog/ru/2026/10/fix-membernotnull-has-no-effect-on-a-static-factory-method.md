---
title: "Решение: [MemberNotNull] не работает на статическом фабричном методе, и CS8618 никуда не уходит"
description: "CS8618 проверяется при выходе из конструктора, а [MemberNotNull] на статическом методе молча игнорируется для членов экземпляра. Передайте значения в приватный конструктор."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "nullable"
lang: "ru"
translationOf: "2026/10/fix-membernotnull-has-no-effect-on-a-static-factory-method"
translatedBy: "claude"
translationDate: 2026-10-28
---

`[MemberNotNull]` на статическом фабричном методе не может убрать `CS8618`, потому что предупреждение выдаётся на конструкторе, в момент выхода из конструктора, а что фабрика делает потом, компилятор вообще не смотрит. Кроме того, у статического метода нет `this`, поэтому когда его `[MemberNotNull]` указывает член экземпляра, компилятор молча игнорирует атрибут: ни предупреждения на методе, ни эффекта для вызывающего кода. Решение в том, чтобы вернуть присваивание в конструктор: пусть фабрика вычисляет значения и передаёт их в приватный конструктор, либо пометьте члены как `required` и задавайте их в инициализаторе объекта внутри фабрики. Проверено на .NET 10 SDK 10.0.302 (C# 14); поведение не менялось с тех пор, как `[MemberNotNull]` появился в C# 9.

## Ошибка в контексте

Вывод сборки указывает на приватный конструктор, а не на фабрику, которую вы аннотировали:

```
Widget.cs(8,13): warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor. Consider adding the 'required' modifier or declaring the property as nullable.
```

Второй диагностики о том, что атрибут проигнорирован, нет. Именно эта тишина и сбивает с толку: `[MemberNotNull(nameof(Name))]` выглядит так, будто должен что-то делать, и ничто в сборке не говорит обратного.

## Почему так происходит

Здесь сходятся два отдельных правила.

**`CS8618` проверяется для каждого конструктора, на его выходе.** Компилятор выполняет анализ потока null-состояний по телу каждого конструктора (плюс инициализаторы полей и свойств) и на закрывающей скобке задаёт один вопрос: каждому ли ссылочному члену, не допускающему null, точно присвоено ненулевое значение? За объектом после возврата из конструктора он не следит. Фабрика, которая делает `var w = new Widget(); w.Name = name; return w;`, присваивает `Name` уже после того, как конструктор завершился с `Name`, равным `null`, и именно на этом выходе живёт предупреждение. Команда Roslyn с самого начала решила не отслеживать инициализацию через вызовы методов ("We've decided not to track initialization interprocedurally for now" в [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358)). `[MemberNotNull]` это явный обходной путь ровно для одного случая: вспомогательного метода, вызванного *внутри* конструктора на `this`.

**`[MemberNotNull]` на статическом методе имеет смысл только для статических членов.** Атрибут является постусловием: "когда этот метод возвращает управление, эти члены получателя не равны null". Для метода экземпляра получатель это `this` (или объект, на котором вы его вызвали). У статического метода получателя нет, поэтому ручаться он может только за статические поля и свойства. Если указать член экземпляра, Roslyn принимает `nameof` (код компилируется, потому что `nameof(Name)` допустим в любом месте класса), а затем просто отбрасывает аннотацию. Обе половины я проверил на SDK 10.0.302: статический метод с `[MemberNotNull(nameof(Nick))]`, который никогда не присваивает `Nick`, не вызывает `CS8774`, а метод экземпляра, который его вызывает, всё равно получает `CS8602` при последующем разыменовании `Nick`. Тот же атрибут, указывающий статическое поле, проверяется и учитывается.

Так что статическая фабрика проваливается по обоим пунктам: она не конструктор, а её аннотация называет члены, которые она описать не может.

## Минимальное воспроизведение

```csharp
// .NET 10 SDK 10.0.302, C# 14, <Nullable>enable</Nullable>
using System.Diagnostics.CodeAnalysis;

public class Widget
{
    public string Name { get; set; }

    private Widget() { }                     // CS8618 is reported here

    [MemberNotNull(nameof(Name))]            // silently ignored: static method, instance member
    public static Widget Create(string name)
    {
        var w = new Widget();
        w.Name = name;
        return w;
    }
}
```

Вторая форма той же ошибки: статический вспомогательный метод, который принимает экземпляр параметром и вызывается из конструктора. Он похож на документированный шаблон, но им не является:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public class Gadget
{
    public string Name { get; set; }

    public Gadget(string name) => Init(this, name);   // CS8618 still fires here

    [MemberNotNull(nameof(Name))]
    private static void Init(Gadget g, string name) => g.Name = name;
}
```

`[MemberNotNull]` описывает получателя вызова, а у `Init(this, name)` получателя нет. Передача `this` аргументом не считается. Единственный работающий статический вариант тот, где и вспомогательный метод, и члены статические, например статический конструктор, вызывающий статический загрузчик:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public static class Config
{
    public static string ConnectionString;

    static Config() => Load();                 // no CS8618: static helper, static member

    [MemberNotNull(nameof(ConnectionString))]
    private static void Load() => ConnectionString = "Server=.;Database=app";
}
```

## Исправление в деталях

Все исправления ниже возвращают присваивание туда, где его видит `CS8618`: внутрь конструктора или за контракт, который понимает компилятор. Они расположены в порядке предпочтения.

### 1. Передайте вычисленные значения в приватный конструктор

Это правильная форма почти для любой фабрики. Фабрика выполняет работу (валидацию, разбор, ввод-вывод), а затем отдаёт готовые значения конструктору, который только присваивает:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Widget
{
    public string Name { get; }

    private Widget(string name) => Name = name;

    public static Widget Create(string raw)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(raw);
        return new Widget(raw.Trim());
    }
}
```

Ни атрибута, ни подавления, и `Name` может стать свойством только для чтения, чего фабрика в стиле "сначала создать, потом присвоить" никогда бы не дала. Если членов несколько, у конструктора просто становится больше параметров. [Record](/ru/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) с приватным позиционным конструктором это компактная версия той же идеи.

### 2. Превратите статический вспомогательный метод в функцию, возвращающую значение

Для формы `Init(this, ...)` измените вспомогательный метод так, чтобы он возвращал вычисленное, а присваивание выполнял конструктор:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Gadget
{
    public string Name { get; }

    public Gadget(string raw) => Name = Normalize(raw);

    private static string Normalize(string raw) => raw.Trim().ToLowerInvariant();
}
```

Статический метод с возвращаемым значением проще тестировать, чем метод, изменяющий параметр, а компилятор видит в конструкторе обычное присваивание. Если вспомогательный метод выдаёт несколько значений, верните кортеж и деконструируйте его: `(Name, Slug) = Parse(raw);` это гарантированное присваивание обоих членов.

### 3. Сделайте вспомогательный метод методом экземпляра и вызывайте его из конструктора

Если инициализация действительно представляет собой общий блок императивного кода, оставьте его во вспомогательном методе, но сделайте его методом экземпляра, чтобы `[MemberNotNull]` описывал `this`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Report
{
    public string Title { get; private set; }

    private Report(string raw) => Normalize(raw);

    [MemberNotNull(nameof(Title))]
    private void Normalize(string raw) => Title = raw.Trim();

    public static Report Create(string raw) => new(raw);
}
```

Именно этот шаблон описан на [странице Microsoft Learn об атрибутах nullable-анализа](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis#helper-methods-membernotnull-and-membernotnullwhen). В отличие от статического случая, компилятор проверяет вспомогательный метод: если `Normalize` может вернуть управление, не присвоив `Title`, вы получите `CS8774: Member 'Title' must have a non-null value when exiting.`

Одна ловушка: вызов метода экземпляра из фабрики на новом объекте (`var r = new Report(); r.Normalize(raw);`) действительно делает `r.Title` не равным null до конца фабрики, потому что `[MemberNotNull]` применяется к любому получателю, на котором вы его вызвали. Но для `CS8618` это ничего не меняет: конструктор завершился ещё до выполнения этой строки.

### 4. Пометьте члены как `required` и используйте инициализатор объекта в фабрике

Если вам ближе создание в стиле свойств, `required` переносит обязанность с конструктора на выражение создания объекта, а фабрика остаётся единственным местом, где объект можно создать:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Invoice
{
    public required string Number { get; init; }
    public required string Customer { get; init; }

    private Invoice() { }

    public static Invoice Create(string number, string customer) =>
        new() { Number = number.Trim(), Customer = customer.Trim() };
}
```

`CS8618` исчезает, потому что член `required` не входит в ответственность конструктора. Вы также получаете страховку, которой у исходной фабрики не было: забудьте один из членов, и сборка упадёт с `CS9035: Required member 'Invoice.Customer' must be set in the object initializer or attribute constructor.` Это ошибка, а не предупреждение. [Разбор CS9035](/ru/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) описывает сторону вызывающего кода в этом контракте.

### 5. Используйте `[SetsRequiredMembers]` на приватном конструкторе

Если у типа есть члены `required` для публичных вызывающих, а фабрике удобнее передавать значения позиционно, добавьте конструктор, который обещает задать их все:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Tag
{
    public required string Value { get; init; }

    public Tag() { }

    [SetsRequiredMembers]
    private Tag(string value) => Value = value;

    public static Tag Create(string raw) => new(raw.Trim().ToLowerInvariant());
}
```

Как и `[MemberNotNull]`, `[SetsRequiredMembers]` принимается на веру и не проверяется: если этот конструктор забудет член, никто не предупредит. Держите конструктор достаточно коротким, чтобы проверить его глазами.

### 6. Крайняя мера: подавляйте на конструкторе, а не на свойстве

Если тип создаётся фреймворком, которому нужен конструктор без параметров и который заполняет члены позже, ограничьте подавление этим конструктором, чтобы не потерять анализ во всех остальных местах:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class LegacyRow
{
    public string Name { get; private set; }

#pragma warning disable CS8618 // Name is always assigned by Create before the instance escapes
    private LegacyRow() { }
#pragma warning restore CS8618

    public static LegacyRow Create(string name) => new() { Name = name };
}
```

Это честно описывает происходящее, а комментарий сообщает следующему читателю, какой метод держит обещание. Предпочитайте этот вариант записи `= null!` на свойстве: `null!` заглушает предупреждение для всех конструкторов, которые когда-либо появятся у типа, включая добавленные позже, которые действительно забудут присвоить значение.

## Подводные камни и варианты

- **Удалите мёртвый атрибут.** После исправления фабрики уберите `[MemberNotNull]` со всех статических методов, которые указывают члены экземпляра. Он ничего не делает, компилятор никогда об этом не скажет, а следующий разработчик его скопирует. Быстрый поиск `MemberNotNull` по всему решению с проверкой каждого совпадения на `static` находит их все.

- **Асинхронные фабрики упираются в `CS8774` по другой причине.** `static async Task<T> CreateAsync()` обычно и есть причина вообще использовать фабрику, ведь конструкторы не умеют `await`. Если же поставить `[MemberNotNull]` на вспомогательный метод экземпляра `async Task InitAsync()`, компилятор проверяет постусловие в точках `await`, где метод может вернуть управление вызывающему коду, а не по завершении задачи, поэтому присваивание члена после `await` всё равно даёт `CS8774`. В Roslyn это считается задуманным поведением ([dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022)). Решение то же, что и в пункте 1: выполните `await` ввода-вывода внутри статической фабрики, а затем передайте результаты в приватный конструктор.

- **Для фабрики `TryCreate` аннотируйте параметр `out`, а не члены.** Вызывающему коду важно, равен ли null возвращённый объект, а это постусловие параметра:

  ```csharp
  // .NET 10 SDK 10.0.302, C# 14
  using System.Diagnostics.CodeAnalysis;

  public sealed class Sku
  {
      public string Code { get; }
      private Sku(string code) => Code = code;

      public static bool TryCreate(string? raw, [NotNullWhen(true)] out Sku? sku)
      {
          sku = string.IsNullOrWhiteSpace(raw) ? null : new Sku(raw.Trim());
          return sku is not null;
      }
  }
  ```

  Сами члены не допускают null и гарантируются приватным конструктором, так что больше никаких атрибутов не нужно.

- **`[MemberNotNull]` нельзя поставить на конструктор.** Атрибут применим только к методам и свойствам. Возможность для производного конструктора поручиться за член базового класса остаётся открытым запросом ([dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526)). Вместо этого передайте значение наверх через `base(...)`.

- **Методы экземпляра, вызванные на другом объекте, работают, но только локально.** `other.Init(); other.Name.Length` проходит без предупреждения, потому что получатель здесь `other`. Внутри тела фабрики это полезно, но конструктор, создавший `other`, задним числом это никогда не удовлетворит.

- **Ленивые члены это другая проблема.** Если у `Name` законно нет значения до первого использования, он допускает null или должен жить за `Lazy<T>`. Сравните варианты в [Lazy&lt;T&gt; vs LazyInitializer vs double-checked locking](/ru/2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp/), вместо того чтобы бороться с `CS8618`.

## Связанные материалы

- [Решение: CS8618 "Non-nullable property must contain a non-null value when exiting constructor"](/ru/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) про само предупреждение и шаблон с вспомогательным методом экземпляра и `[MemberNotNull]`.
- [Решение: CS9035 "Required member 'X' must be set in the object initializer"](/ru/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) про ошибку, которую выдаёт фабрика на основе `required`, если она пропустила член.
- [record vs class vs struct в C#: матрица решений](/ru/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) про выбор формы типа, при которой инициализация в конструкторе становится естественной.
- [Что на самом деле копирует выражение with в C#](/ru/2026/10/what-does-a-csharp-with-expression-actually-copy/) про ещё один случай, когда создание объекта обходит ожидаемый код.
- [Null-условное присваивание в C# 14](/ru/2026/02/csharp-14-null-conditional-assignment/) про то, как ещё компилятор рассуждает о null.

## Источники

- Microsoft Learn, [Attributes interpreted by the compiler: Nullable static analysis](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis) (раздел "Helper methods: MemberNotNull and MemberNotNullWhen" и его пример вспомогательного метода в конструкторе).
- Microsoft Learn, [MemberNotNullAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.membernotnullattribute) (цели атрибута: методы и свойства).
- Microsoft Learn, [Nullable reference type warnings](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) (`CS8618`, `CS8774`).
- GitHub, [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358) (инициализация не отслеживается через вызовы методов).
- GitHub, [dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526) (`[MemberNotNull]` нельзя применять к конструкторам).
- GitHub, [dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022) (`CS8774` на асинхронных методах с `[MemberNotNull]` является задуманным поведением).
