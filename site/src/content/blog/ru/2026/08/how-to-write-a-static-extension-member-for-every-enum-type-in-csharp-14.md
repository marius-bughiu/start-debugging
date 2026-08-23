---
title: "Как написать статический член расширения, применимый ко всем типам enum в C# 14"
description: "Объявите обобщённый блок extension с ограничением struct, Enum и получите Status.Values, Status.Count и Status.Parse для каждого enum в решении. Форма получателя, ловушки CS0704 и CS0428 и почему Enum.GetValues нужно кешировать."
pubDate: 2026-08-23
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
  - "enums"
lang: "ru"
translationOf: "2026/08/how-to-write-a-static-extension-member-for-every-enum-type-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-08-23
---

C# 14 позволяет написать один блок `extension`, который добавляет статические члены сразу *всем* типам enum. Форма такова: `extension<TEnum>(TEnum) where TEnum : struct, Enum`, объявленная внутри необобщённого статического класса, причём имя параметра-получателя опускается, потому что члены статические. Это даёт `Status.Values`, `Status.Count` и `Status.Parse("active")` для каждого enum в решении без единой строки на каждый enum. Всё описанное ниже было скомпилировано и запущено на .NET SDK 10.0.201 и среде выполнения 10.0.5.

Загвоздка в том, что вас подстерегают три отдельные проблемы: параметр типа недостижим изнутри обобщённого метода, любое имя члена, которое уже занято `System.Enum`, молча скрывается, а очевидная реализация выделяет новый массив при каждом вызове.

## Почему получателем должен быть `TEnum`, а не `Enum`

Первым делом хочется написать `extension(Enum)` и на этом закончить, ведь любой enum наследуется от `System.Enum`. Это компилируется и даже разрешается по имени конкретного типа enum:

```csharp
// .NET 10, C# 14 -- compiles and runs, but is a dead end
public static class B
{
    extension(Enum)
    {
        public static string Label => "Label:System.Enum";
    }
}

// both of these print "Label:System.Enum"
Console.WriteLine(Status.Label);
Console.WriteLine(Enum.Label);
```

Статические члены расширения, объявленные на базовом типе, действительно достижимы через имя производного enum. Но в этом блоке нет параметра типа, поэтому вызвать обобщённые API `Enum` не получится. `Enum.GetValues<TEnum>()`, `Enum.Parse<TEnum>` и `Enum.TryParse<TEnum>` являются именно теми API, которые вам нужны, и всем им требуется `TEnum`. Без него вы возвращаетесь к рефлексии через `typeof` с упаковкой каждого значения в `object`.

Значит, получатель обязан нести параметр типа. Следующая мысль это `where TEnum : Enum`, что тоже компилируется, пока вы этим не воспользуетесь:

```csharp
extension<TEnum>(TEnum) where TEnum : Enum
{
    public static TEnum[] Values => Enum.GetValues<TEnum>();
}
```

```
error CS0453: The type 'TEnum' must be a non-nullable value type in order to use it
as parameter 'TEnum' in the generic type or method 'Enum.GetValues<TEnum>()'
```

`Enum` как ограничение допускает и сам `System.Enum`, который является абстрактным ссылочным типом. Обобщённые вспомогательные методы `Enum` все ограничены `struct, Enum`, поэтому ваш блок должен этому соответствовать. Остаётся ровно одна рабочая форма.

## Объявляем блок в три шага

1. **Создайте необобщённый `static class` верхнего уровня.** Блоки `extension` допустимы только там. Имя класса никогда не появляется в месте вызова, поэтому выберите что-то описательное вроде `EnumExtensions`.
2. **Напишите `extension<TEnum>(TEnum) where TEnum : struct, Enum` и опустите имя параметра-получателя.** MS Learn формулирует это прямо: "the extension parameter doesn't need to include the parameter name if the only members are static". Отсутствие имени и есть сигнал, что блок содержит статические члены; именованный получатель нужен для членов экземпляра.
3. **Объявите члены `public static` внутри блока.** Они связываются с конкретным enum, который вы называете в месте вызова, поэтому `TEnum` выводится как `Status`, когда вы пишете `Status.Values`.

```csharp
// .NET 10, C# 14
public static class EnumExtensions
{
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static TEnum[] Values => Enum.GetValues<TEnum>();
        public static int Count => Enum.GetValues<TEnum>().Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status { Draft = 1, Active = 2, Archived = 4 }
public enum Color { Red, Green, Blue }

Console.WriteLine(Status.Count);              // 3
Console.WriteLine(string.Join(",", Status.Values));  // Draft,Active,Archived
Console.WriteLine(Color.Parse("green"));      // Green
Console.WriteLine(Color.TryParse("BLUE", out var c));  // True
```

Один блок, и каждый enum в компиляции получил четыре статических члена. В этом вся выгода, и именно это по-настоящему нельзя было выразить до C# 14. Если нужно освежить в памяти саму возможность, [обзор членов расширения C# 14](/ru/2026/02/csharp-14-extension-members/) охватывает операторы и необобщённые случаи, а [объявление свойств расширения](/ru/2026/06/how-to-declare-extension-properties-in-csharp-14/) глубже разбирает правила, специфичные для свойств.

## Что компилятор выдаёт на самом деле

Блоки `extension` не являются возможностью среды выполнения. Всё сводится к обычным статическим методам объемлющего статического класса плюс сгенерированный компилятором тип-маркер, который несёт метаданные расширения. Рефлексия по классу во время выполнения это показывает:

```
--- emitted members on EnumExtensions ---
  NestedType <G>$1AEBB925A470955AA56007A9C9196757`1
  Method   get_Count
  Method   get_Values
  Method   Parse
  Method   TryParse
```

Вложенный тип `<G>$<hash>` это группирующий тип, которым компилятор фиксирует получателя и его ограничения. Сами члены являются плоскими статическими методами, поэтому блоки `extension` двоично совместимы со старыми методами расширения с параметром `this` и поэтому во время выполнения нет затрат на диспетчеризацию.

У такой плоской генерации есть прямое следствие, и оно удивляет первым.

## Блок `extension` не является областью видимости

MS Learn формулирует правило без обиняков: "An extension doesn't introduce a scope for member declarations. All members declared in a single class, even if in multiple extensions, must have unique signatures." Поэтому член экземпляра и статический член с одинаковым именем конфликтуют, даже находясь в разных блоках:

```csharp
public static class E2
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Tag => "instance";
    }
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static string Tag => "static";   // CS0102
    }
}
```

```
error CS0102: The type 'E2' already contains a definition for 'Tag'
```

Разнесите их по двум статическим классам, и конфликт переедет в место вызова, где у C# 14 есть отдельная диагностика:

```
error CS9339: The extension resolution is ambiguous between the following members:
'C1.extension<Status>(Status).Count' and 'C2.extension<Status>(Status).Count'
```

CS9339 стоит узнавать с первого взгляда, потому что обобщённый блок для enum применяется ко всем enum в области видимости. Две библиотеки, каждая из которых поставляет расширение `Values`, столкнутся на каждом вашем enum, и виноватой не будет ни одна. То же семейство проблем возникает, когда вы переносите метод расширения старого стиля в блок и забываете удалить оригинал, что порождает [неоднозначность CS0121 после перехода на члены расширения](/ru/2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members/).

## `TEnum.Values` не компилируется внутри обобщённого метода

Эта ловушка стоит больше всего времени. Член расширения прекрасно разрешается по конкретному имени enum, но не по параметру типа:

```csharp
public static int CountOf<TEnum>() where TEnum : struct, Enum
{
    return TEnum.Values.Length;   // CS0704
}
```

```
error CS0704: Cannot do non-virtual member lookup in 'TEnum' because it is a type parameter
```

Статические члены расширения разрешаются поиском имени по типу, а параметр типа для этой цели типом не является. Только `static` *abstract* члены интерфейсов участвуют в поиске членов через параметр типа, а члены расширения членами интерфейса не являются. Синтаксиса, который бы это исправил, не существует.

Практический ответ состоит в том, чтобы держать настоящую реализацию в обычном обобщённом вспомогательном классе, а блок `extension` оставить тонким фасадом над ним. Обобщённый код обращается к помощнику напрямую, прикладной код вызывает красивый член расширения. Это же разделение решает и проблему выделения памяти ниже, так что вы получаете его бесплатно.

## `Enum.GetValues<TEnum>()` выделяет новый массив при каждом вызове

`Enum.GetValues<TEnum>()` каждый раз возвращает новый `TEnum[]`, потому что выдача закешированного изменяемого массива позволила бы любому вызывающему коду его испортить. Свойство, вызывающее его при каждом обращении, превращает поиск в выделение памяти. Замерено на среде выполнения 10.0.5, сборка Release, миллион обращений к enum из пяти членов, с индексацией результата, чтобы JIT не мог вынести вызов из цикла:

| Реализация | Время | Выделено | На операцию |
| --- | --- | --- | --- |
| `Enum.GetValues<TEnum>()` при каждом обращении | 27.8 мс | 48 000 832 байт | 48 Б |
| статический обобщённый кеш | 0.7 мс | 0 байт | 0 Б |

48 байт на операцию это заголовок массива плюс пять четырёхбайтовых значений, округлённые до выравнивания. Число растёт вместе с enum, поэтому enum из 30 членов обойдётся дороже. За три запуска версия без кеша показала от 26.8 мс до 29.5 мс, а версия с кешем неизменно 0.7 мс.

Решение это статический обобщённый класс. CLR даёт по одному экземпляру его статических полей на каждый закрытый обобщённый тип, поэтому `EnumInfo<Status>` и `EnumInfo<Color>` получают раздельное хранилище, каждое инициализируется ровно один раз при первом использовании:

```csharp
// .NET 10, C# 14
internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();
}
```

`ImmutableArray<TEnum>` здесь важен вместо `TEnum[]`: закешированный массив, выданный из свойства, изменяем любым вызывающим кодом, и одно `Values[0] = ...` тихо отравляет кеш на весь процесс. `FrozenSet` подходит по форме для проверок принадлежности, так как один раз платит повышенную цену построения в обмен на более быстрое чтение, а это ровно тот компромисс, который нужен статическому кешу на тип. [Бенчмарк Dictionary против FrozenDictionary](/ru/2024/04/net-8-performance-dictionary-vs-frozendictionary/) содержит числа, стоящие за этим выбором.

## Имена, уже занятые `System.Enum`, оказываются скрыты

Члены расширения являются запасным вариантом. Поиск имени сначала находит настоящие члены и обращается к расширениям, только когда ничего применимого нет. `System.Enum` уже объявляет `IsDefined`, поэтому член расширения с таким именем вообще не рассматривается:

```csharp
extension<TEnum>(TEnum value) where TEnum : struct, Enum
{
    public bool IsDefined => Enum.IsDefined(value);
    public bool IsKnown => Enum.IsDefined(value);
}

Status s = Status.Active;
bool a = s.IsKnown;     // fine
bool b = s.IsDefined;   // CS0428
```

```
error CS0428: Cannot convert method group 'IsDefined' to non-delegate type 'bool'.
Did you intend to invoke the method?
```

Компилятор нашёл группу методов `Enum.IsDefined` и прекратил поиск. Сообщение об ошибке активно вводит в заблуждение, потому что намекает на забытые скобки, тогда как настоящая проблема в том, что ваше свойство расширения недостижимо под этим именем. То же самое происходит со статическими членами расширения: `Status.IsDefined`, объявленный как статическое свойство расширения, даёт точно такой же CS0428.

Обратите внимание, что речь про имена, а не про сигнатуры. `GetValues` как *метод* расширения работает нормально:

```csharp
extension<TEnum>(TEnum) where TEnum : struct, Enum
{
    public static TEnum[] GetValues() => Enum.GetValues<TEnum>();  // compiles
}

Status[] all = Status.GetValues();   // resolves to your extension
```

`Enum.GetValues` существует, но ни одна его перегрузка неприменима с нулём аргументов, поэтому поиск проваливается до расширения. Полагаться на это хрупко. Безопасное правило состоит в том, чтобы избегать всех имён, уже имеющихся у `System.Enum`: `IsDefined`, `Parse`, `TryParse`, `GetName`, `GetNames`, `GetValues`, `GetUnderlyingType`, `Format`, `ToObject`, `HasFlag` и `CompareTo`. Выбор `Values`, `Count`, `Names` и `IsKnown` обходит всю категорию стороной.

`Parse` и `TryParse` являются неудобными исключениями, потому что именно этих имён ждут вызывающие. Сейчас они действительно разрешаются, по той же причине нулевого числа применимых перегрузок, что и у `GetValues`. Если хотите перестраховаться, назовите их `ParseName` и `TryParseName`.

## Ловушка разложения `[Flags]`

Если вы добавите член, разбивающий значение флагов на составляющие, очевидная реализация окажется неверной для любого enum с нулевым членом:

```csharp
[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Admin = Read | Write }

public ImmutableArray<TEnum> NaiveFlags =>
    [.. EnumInfo<TEnum>.Values.Where(f => value.HasFlag(f))];
```

```
naive : [None, Read, Write, Admin]
```

`HasFlag` является проверкой на подмножество, поэтому `x.HasFlag(None)` истинно для любого `x`, а составные члены вроде `Admin` тоже совпадают. Фильтрация по членам с одним установленным битом решает обе проблемы сразу:

```csharp
// .NET 10, C# 14 -- add to EnumInfo<TEnum>; needs using System.Numerics;
public static readonly ImmutableArray<TEnum> SingleBitFlags =
    [.. Enum.GetValues<TEnum>().Where(v =>
        BitOperations.PopCount(Convert.ToUInt64(v)) == 1)];

public ImmutableArray<TEnum> Flags =>
    [.. EnumInfo<TEnum>.SingleBitFlags.Where(f => value.HasFlag(f))];
```

```
fixed : [Read, Write]
none  : []
read  : [Read]
```

`Convert.ToUInt64` выполняет упаковку, но отрабатывает один раз на тип enum внутри статического инициализатора, а не на каждый вызов.

## Версия, которую стоит выпускать

Собираем всё вместе: обобщённый помощник с кешами, один статический блок для членов уровня типа, один блок экземпляра для членов уровня значения и ни одного имени, уже занятого `System.Enum`.

```csharp
// .NET 10, C# 14
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.ComponentModel;
using System.Reflection;

internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();

    public static readonly FrozenDictionary<TEnum, string> Descriptions =
        Enum.GetValues<TEnum>()
            .DistinctBy(v => v)
            .ToFrozenDictionary(
                v => v,
                v => typeof(TEnum).GetField(v.ToString())
                        ?.GetCustomAttribute<DescriptionAttribute>()?.Description
                     ?? v.ToString());
}

public static class EnumExtensions
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Description => EnumInfo<TEnum>.Descriptions[value];
        public bool IsKnown => EnumInfo<TEnum>.Defined.Contains(value);
    }

    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static ImmutableArray<TEnum> Values => EnumInfo<TEnum>.Values;
        public static int Count => EnumInfo<TEnum>.Values.Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status
{
    [Description("Not yet published")] Draft,
    [Description("Live")]              Active,
    Archived,
}
```

```
Status.Count      : 3
Status.Values     : [Draft, Active, Archived]
Description       : Not yet published
Description (none): Archived
IsKnown           : True / False
Parse             : Active
TryParse bad input: False
```

`DistinctBy(v => v)` при построении словаря не является украшением. `Enum.GetValues` возвращает по одной записи на *член*, а два члена могут делить одно значение (`Alias = Active`), что без этого вызова привело бы к исключению о дублирующемся ключе. Это та же деталь с псевдонимами, которая усложняет сохранение enum, разобранная в статье [хранение enum в виде строки в EF Core 11](/ru/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/).

Рефлексия в `Descriptions` означает, что этому шаблону понадобится аннотация для обрезки, если вы публикуете с включённой обрезкой или Native AOT. Уберите член `Description`, если целитесь в любой из этих режимов, либо подавайте строки из генератора исходного кода.

Стоит обозначить границу: члены расширения разрешаются на этапе компиляции по имени, которое вы пишете в исходном коде. Если ваш тип enum известен во время выполнения только как `Type`, ничего из этого не применимо и вы возвращаетесь к необобщённым API рефлексии. Блоки `extension` делают работу с enum приятнее в коде, который вы компилируете, а не в коде, который вы обнаруживаете.

## Источники

- [Extension member declarations, C# reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/extension) на MS Learn, обновлено 2026-08-13
- [C# 14: Exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/) в блоге .NET
- Справочник API [Enum.GetValues&lt;TEnum&gt;()](https://learn.microsoft.com/en-us/dotnet/api/system.enum.getvalues)
- Справочник API [FrozenSet&lt;T&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.collections.frozen.frozenset-1)
