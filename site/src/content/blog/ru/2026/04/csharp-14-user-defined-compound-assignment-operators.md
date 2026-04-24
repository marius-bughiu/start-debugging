---
title: "Пользовательские операторы составного присваивания в C# 14: += in-place без лишней аллокации"
description: "C# 14 позволяет перегружать +=, -=, *= и компанию как void-методы экземпляра, мутирующие приёмник in-place, сокращая аллокации для крупных хранителей значений вроде буферов в стиле BigInteger и тензоров."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "performance"
  - "operators"
lang: "ru"
translationOf: "2026/04/csharp-14-user-defined-compound-assignment-operators"
translatedBy: "claude"
translationDate: 2026-04-24
---

Одно из самых тихих добавлений C# 14 наконец заасфальтировано в языковой справочнике: пользовательские операторы составного присваивания. До .NET 10 запись `x += y` на пользовательском типе всегда компилировалась в `x = x + y`, и это значило, что ваш `operator +` обязан был аллоцировать и возвращать новый экземпляр даже когда вызывающий собирался выкинуть старый. С C# 14 теперь можно перегружать `+=` напрямую как `void`-метод экземпляра, мутирующий приёмник in-place.

Мотивация проста: для типов, несущих много данных (буфер в стиле `BigInteger`, тензор, пуловый байтовый аккумулятор), создание свежего получателя, его обход и копирование памяти - дорогая часть каждого `+=`. Если исходное значение не используется после присваивания, эта копия - чистая трата. [Спецификация фичи](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/user-defined-compound-assignment) явно это формулирует.

## Как объявляется новый оператор

Оператор составного присваивания в C# 14 не статический. Принимает один параметр, возвращает `void` и живёт на экземпляре:

```csharp
public sealed class Accumulator
{
    private readonly List<int> _values = new();

    public int Sum { get; private set; }

    // Classic binary operator, still required if you want x + y to work.
    public static Accumulator operator +(Accumulator left, int value)
    {
        var result = new Accumulator();
        result._values.AddRange(left._values);
        result._values.Add(value);
        result.Sum = left.Sum + value;
        return result;
    }

    // New in C# 14: instance operator, no allocation, no static modifier.
    public void operator +=(int value)
    {
        _values.Add(value);
        Sum += value;
    }
}
```

Компилятор эмитит метод экземпляра под именем `op_AdditionAssignment`. Когда вызывающий пишет `acc += 5`, язык теперь предпочитает оператор экземпляра, если он доступен; если нет, старая перезапись `x = x + y` остаётся фолбэком. Это значит, существующий код продолжает компилироваться, и вы можете добавить перегрузку `+=` позже, не ломая перегрузку `+`.

## Когда это важно

Выгода проявляется на ссылочных типах, владеющих внутренними буферами, и на struct-типах, используемых через изменяемую ячейку хранения. Наивный `Matrix operator +(Matrix, Matrix)` обязан аллоцировать целую новую матрицу на каждый вызов `m += other` в горячем цикле. Версия экземпляра может прибавлять в `this` и ничего не возвращать:

```csharp
public sealed class Matrix
{
    private readonly double[] _data;
    public int Rows { get; }
    public int Cols { get; }

    public void operator +=(Matrix other)
    {
        if (other.Rows != Rows || other.Cols != Cols)
            throw new ArgumentException("Shape mismatch.");

        var span = _data.AsSpan();
        var otherSpan = other._data.AsSpan();
        for (int i = 0; i < span.Length; i++)
            span[i] += otherSpan[i];
    }
}
```

Префиксные `++` и `--` следуют тому же паттерну с `public void operator ++()`. Постфиксный `x++` всё ещё проходит через статическую версию, когда результат используется, потому что предынкрементное значение нельзя получить после in-place мутации.

## Что стоит знать

Язык не принуждает к согласованности между `+` и `+=`, так что можно поставлять один без другого. LDM [рассмотрел это в апреле 2025](https://github.com/dotnet/csharplang/blob/main/meetings/2025/LDM-2025-04-02.md) и решил против обязательного парного объявления. Варианты `checked` работают так же: объявите `public void operator checked +=(int y)` рядом с обычным. `readonly` разрешён на структурах, но, как отмечает спецификация, редко имеет смысл, ведь весь смысл метода - мутировать экземпляр.

Фича отгружается с C# 14 на .NET 10 и пригодна к использованию уже сегодня в Visual Studio 2026 или .NET 10 SDK. Для существующих библиотек, выставляющих большие data-value-типы, ретроактивное добавление instance `+=` - один из самых дешёвых выигрышей по производительности в этом релизе. Полный обзор - в [Что нового в C# 14](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14).
