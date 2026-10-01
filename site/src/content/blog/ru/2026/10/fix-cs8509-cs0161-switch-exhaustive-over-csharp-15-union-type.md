---
title: "Исправление: CS8509 или CS0161 на switch, который исчерпывающий для типа union из C# 15"
description: "Делайте switch по самому union, а не по .Value, и используйте switch-выражение или добавьте case null в оператор switch. Операторам нужно покрытие null, а выражения лишь выдают предупреждение."
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "pattern-matching"
lang: "ru"
translationOf: "2026/10/fix-cs8509-cs0161-switch-exhaustive-over-csharp-15-union-type"
translatedBy: "claude"
translationDate: 2026-10-01
---

Делайте switch по самому значению union, а не по его свойству `.Value`, и отдавайте предпочтение switch-выражению. Если вам нужен оператор switch в методе, который возвращает значение, добавьте ветку `case null:` (или `throw` после switch): компилятор считает оператор switch по union полным только тогда, когда покрыт null в `Value` у `default` union. Всё поведение ниже измерено на .NET 11 RC1 SDK (`11.0.100-rc.1.26425.128`, C# 15, переопределять `LangVersion` не нужно).

## Ошибка в контексте

Вы объявили union, сопоставили все типы вариантов, а компилятор всё равно говорит, что это не так:

```text
warning CS8509: The switch expression does not handle all possible values of its input type (it is not exhaustive). For example, the pattern '_' is not covered.
error CS0161: 'Pets.Describe(Pet)': not all code paths return a value
error CS0165: Use of unassigned local variable 's'
warning CS8655: The switch expression does not handle some null inputs (it is not exhaustive). For example, the pattern 'null' is not covered.
error CS8780: A variable may not be declared within a 'not' or an 'or' pattern or a union matching involving matching against either the instance, or its underlying value.
```

Это пять разных симптомов одного и того же недопонимания: исчерпываемость union в C# 15 является свойством **сопоставления union**, а оно включается только при определённых условиях. Выйдите за эти условия, и вы вернётесь к обычному сопоставлению с образцом для `object`, где два образца типов никогда не бывают исчерпывающими.

## Почему компилятор не считает ваш switch исчерпывающим

[Спецификация unions](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#union-exhaustiveness) в C# 15 говорит об этом одной строкой: считается, что тип union "исчерпывается" своими типами вариантов, поэтому выражение `switch` исчерпывающее, если обрабатывает все типы вариантов union. Всё остальное следует из деталей.

1. **На входе должно быть значение union.** Сопоставление union происходит только "when the input value of a pattern is of a union type or of a nullable of a union type". Если вы делаете switch по `pet.Value` (типа `object?`) или по union, упакованному в `object`, у компилятора нет списка вариантов, и он требует `_`.
2. **Операторы switch строже, чем switch-выражения.** Switch-выражение с необработанным `null` компилируется с предупреждением CS8655. Оператор switch, используемый для анализа определённого присваивания или путей возврата, считается полным, только если покрыт и `null`, поэтому конец `switch` остаётся достижимым, и вы получаете CS0161 или CS0165.
3. **`Value` у union всегда может быть null.** `public union Pet(Cat, Dog)` преобразуется в структуру с `public object? Value { get; }`. В `default(Pet)` лежит `null`, как и в `new Pet((Cat)null!)`. Спецификация перечисляет это в разделе [well-formedness](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#well-formedness): `Value` это "null or a value of a case type".
4. **Параметры типа не разворачиваются.** Тип варианта `T` в `union Result<T>(T, Exception)` нельзя сопоставить с образцом с обозначением (designation), потому что компилятор не может доказать, должен ли `T v` проверять экземпляр union или его содержимое. Это CS8780.

## Минимальный пример

```csharp
// .NET 11 RC1 SDK 11.0.100-rc.1.26425.128, C# 15, <Nullable>enable</Nullable>
public record Cat(string Name);
public record Dog(string Name);
public union Pet(Cat, Dog);
public union MaybePet(Cat?, Dog);
public union Result<T>(T, Exception);

static class Pets
{
    // OK: no diagnostics
    static string A(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: pattern '_' is not covered
    static string B(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

    // CS0161: not all code paths return a value
    static string Describe(Pet p)
    {
        switch (p)
        {
            case Cat c: return c.Name;
            case Dog d: return d.Name;
        }
    }

    // CS8655: pattern 'null' is not covered (Cat? is a nullable case type)
    static string D(MaybePet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: a union boxed into object is just an object
    static string E(object o) => o switch { Cat c => c.Name, Dog d => d.Name };

    // CS8655: Nullable<Pet> can be null
    static string F(Pet? p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8780 on 'TV v'
    static string I<TV>(Result<TV> r) => r switch { TV v => v!.ToString()!, Exception e => e.Message };
}
```

Метод `A` служит точкой отсчёта: значение union напрямую передаётся в switch-выражение, у каждого типа варианта есть ветка, и компилятор молчит. Каждый из остальных методов нарушает одно из четырёх правил выше.

## Исправление по шагам

Проходите шаги по порядку. Первый исправляет большинство реальных случаев.

### 1. Сопоставляйте union, а не `.Value`

`Value` объявлено как `object?`. Как только вы обращаетесь к нему, вы теряете тип union и его список вариантов. Сопоставление с образцом по union уже разворачивает содержимое за вас: `p is Cat c` компилируется как проверка `p.Value`, так что обращаться к `.Value` самостоятельно незачем.

```csharp
// .NET 11 RC1, C# 15
// Before: CS8509
static string Name(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

// After: exhaustive, no default arm
static string Name(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };
```

То же относится к union, который передаётся через `object`, `IUnion` или параметр обобщённого типа `T`. Согласно [решённому вопросу](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#resolved-confirm-that-a-type-parameter-is-never-a-union-type-even-when-constrained-to-one) из спецификации, параметр типа никогда не является типом union, даже если он ограничен union. В RC1 код `static string L<TU>(TU u) where TU : struct, IUnion => u switch { Cat c => ..., Dog d => ... }` даже не доходит до исчерпываемости: он падает с CS8121, "An expression of type 'TU' cannot be handled by a pattern of type 'Cat'". Оставляйте в сигнатуре конкретный тип union.

Одно частичное исключение: property-образцы по `Value` в RC1 учитывают знание о union. `r switch { { Value: TV v } => ..., { Value: Exception e } => ... }` дало только CS8655, а не CS8509. Но в спецификации вопрос "Should direct Value property matching follow Union rules?" по-прежнему числится открытым, так что не стройте на этом код.

### 2. Предпочитайте switch-выражение, а оператору switch добавляйте `case null`

Это случай CS0161 / CS0165, и он самый неожиданный, ведь те же самые ветки работают в виде выражения. Я измерил три варианта на RC1:

```csharp
// .NET 11 RC1, C# 15
public union Pet(Cat, Dog);
public closed class Shape;
public sealed class Sq : Shape;
public sealed class Ci : Shape;

// error CS0161
static string S1(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; } }

// compiles
static string S2(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; case null: return "none"; } }

// compiles: bool is exhaustive for statements
static int S3(bool b) { switch (b) { case true: return 1; case false: return 0; } }

// error CS0161: closed hierarchies behave like unions here
static int S4(Shape s) { switch (s) { case Sq: return 1; case Ci: return 0; } }
```

`S3` доказывает, что компилятор проверяет исчерпываемость и для операторов switch. Чего он не делает, так это не игнорирует непокрытый `null`. Switch-выражение понижает отсутствие `null` до предупреждения о nullable (а для union, у которого все типы вариантов не допускают null, до полного отсутствия сообщений). Оператор switch использует полный ответ об исчерпываемости для анализа достижимости, и этот ответ включает `null`. Включение `#nullable disable` ничего не меняет: компилятор RC1 всё равно сообщает CS0161 и для union, и для closed-класса.

Есть три чистых способа исправления, в порядке предпочтения:

```csharp
// .NET 11 RC1, C# 15
using System.Diagnostics;

// a) Use an expression. Most switch statements that only return can be one.
static string Describe(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

// b) Cover null explicitly. Use this when a default union is a legitimate state.
static string Describe2(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
        case null: return "no pet";
    }
}

// c) Keep the statement and declare the end unreachable.
static string Describe3(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
    }
    throw new UnreachableException();
}
```

Не используйте `default:` как исправление. Оно компилируется, но заодно скрывает следующий тип варианта, который вы добавите в union, а ведь именно эту диагностику вы и хотели сохранить.

Вариант CS0165 это та же проблема в форме присваивания: `string s; switch (p) { case Cat c: s = ...; break; case Dog d: s = ...; break; } return s;` не компилируется, потому что конец switch достижим при неприсвоенной `s`. Применимы те же три исправления.

### 3. Обрабатывайте null там, где тип допускает null

CS8655 это тот случай, когда компилятор прав. Вы получаете его в двух ситуациях:

- Один из типов вариантов допускает null, как в `union MaybePet(Cat?, Dog)`. Правило спецификации: состояние null по умолчанию у `Value` равно "maybe null", если любой тип варианта "maybe null".
- На входе `Pet?` (то есть `Nullable<Pet>`), который сам по себе может быть `null`.

Добавьте ветку `null`. Для union `null` совпадает и с нулевым экземпляром, и с union, у которого `Value` равно null:

```csharp
// .NET 11 RC1, C# 15
static string D(MaybePet p) => p switch
{
    Cat c => c.Name,
    Dog d => d.Name,
    null => "none",
};
```

Если nullable у типа варианта получился случайно, лучше уберите `?` из объявления union.

### 4. Уберите designation у типов вариантов, являющихся параметрами типа

Для `union Result<T>(T, Exception)` ветка `T v` даёт CS8780 независимо от ограничения. Я проверил без ограничений, `where T : notnull`, `where T : class` и `where T : struct`: во всех четырёх случаях RC1 сообщает CS8780. Работает образец типа без переменной или обработка обобщённого варианта последним через `var`:

```csharp
// .NET 11 RC1, C# 15
public union Result<T>(T, Exception);

// Exhaustive and clean with notnull: prints "v:5" for new Result<int>(5)
static string W4<TV>(Result<TV> r) where TV : notnull =>
    r switch { TV => "v:" + r.Value, Exception => "e" };

// Match the concrete case first, let var take the rest
static string W3<TV>(Result<TV> r) =>
    r switch { Exception e => e.Message, var other => other.Value!.ToString()! };
```

Без ограничения `notnull` форма `TV =>` всё ещё компилируется, но добавляет CS8655, потому что `TV` может быть типом, допускающим null. Заметьте, что `var` не разворачивает union: `other` это `Result<TV>`, а не его содержимое, поэтому `.Value` читается именно из него.

## Часть про среду выполнения: default union всё равно выбрасывает исключение

Заставить компилятор замолчать не значит обработать все значения. Union, у которого все типы вариантов не допускают null, не даёт предупреждения при switch по `default`:

```csharp
// .NET 11 RC1, C# 15
public union Result2(int, Exception);

static string Show(Result2 r) => r switch { int v => v.ToString(), Exception e => e.Message };

Show(default); // System.Runtime.CompilerServices.SwitchExpressionException at runtime
```

Разрешённый в спецификации вопрос "Default nullable state of `Value` property" признаёт, что `default(U).Value` равно `null`, тогда как анализ nullable смотрит только на типы вариантов. На практике default union появляется, когда это поле, которому так и не присвоили значение, элемент массива, возврат `default` в обобщённом коде или десериализованные данные, не заполнившие union. Если такие пути существуют, добавьте ветку `null`, даже если компилятор её не требует, или проверяйте значение на границе. Те же соображения применимы к [свойствам, не допускающим null и не установленным в конструкторе](/ru/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/): аннотация описывает намерение, а не гарантию во время выполнения.

## Подводные камни и похожие ошибки

- **CS8846** ("However, a pattern with a 'when' clause might successfully match this value") означает, что один тип варианта покрыт только под защитой `when`. Добавьте для этого типа ветку без условия. Это не ошибка union.
- **CS8509 с названием конкретного типа**, например "the pattern 'Dog' is not covered", это честная версия ошибки: вам действительно не хватает типа варианта. Эта диагностика срабатывает везде, когда кто-то добавляет вариант в общий union, и это причина избегать веток `default` и `_`.
- **Типы вариантов, являющиеся интерфейсами или базовыми классами**, исчерпываются этим типом, а не его подтипами. Для `union Shape(IShape, string)` ветки для `Circle` и `Square` не покрывают `IShape`. Если вам нужна исчерпываемость по подтипам, сделайте базу [closed-иерархией классов](/ru/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/) и добавьте её как тип варианта.
- **Старые предварительные версии.** Если вы всё ещё на .NET 11 Preview 2 с вручную объявленными типами `UnionAttribute` и `IUnion`, как описано в [первоначальном анонсе типов union](/ru/2026/04/csharp-15-union-types-dotnet-11-preview-2/), диагностика исчерпываемости менялась между предварительными версиями. Обновитесь до RC1, прежде чем разбираться с любой из ошибок выше.
- **Анализаторы и сгенерированный код.** Код, который получает union как `object`, например JSON-конвертер или связыватель моделей, подпадает под правило 1. Поведение сериализации и привязки описано в статьях [сериализация типов union C# с System.Text.Json](/ru/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) и [где работает привязка union в ASP.NET Core 11](/ru/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/).

## Связанные материалы

- [Типы union в C# 15 уже здесь](/ru/2026/04/csharp-15-union-types-dotnet-11-preview-2/): синтаксис объявления и неявные преобразования.
- [Closed-иерархии классов в C# 15](/ru/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/), у которых то же поведение switch-операторов, что измерено выше.
- [Сериализация типов union C# с System.Text.Json](/ru/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) для union, пересекающих границу передачи данных.
- [Возврат нескольких значений из метода в C#](/ru/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/), если вы выбираете между union `Result<T>`, кортежами и параметрами out.
- [Исправление CS8618 для свойств, не допускающих null](/ru/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/): сторона анализа nullable в той же истории.

## Источники

- [Спецификация unions в C# 15 (csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md): сопоставление union, исчерпываемость, nullability, преобразование и разрешённые вопросы, процитированные выше.
- [Справочник по типам union на Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/union).
- [Предупреждения сопоставления с образцом, включая CS8509, CS8655 и CS8846](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/pattern-matching-warnings).
- Все диагностические сообщения и результаты выполнения воспроизведены локально на .NET 11 RC1 SDK `11.0.100-rc.1.26425.128` под macOS, `net11.0`, `<Nullable>enable</Nullable>`.
