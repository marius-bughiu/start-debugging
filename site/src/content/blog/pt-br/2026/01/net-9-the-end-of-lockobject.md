---
title: ".NET 9: o fim do lock(object)"
description: "O .NET 9 introduz System.Threading.Lock, uma primitiva de sincronização leve e dedicada que substitui lock(object) com melhor desempenho e intenção mais clara."
pubDate: 2026-01-02
tags:
  - "dotnet"
  - "dotnet-9"
lang: "pt-br"
translationOf: "2026/01/net-9-the-end-of-lockobject"
translatedBy: "claude"
translationDate: 2026-05-01
---
Por quase duas décadas, desenvolvedores C# contaram com um padrão simples para sincronização de threads: criar uma instância privada de `object` e passá-la para a instrução `lock`. Embora eficaz, essa abordagem carrega custos ocultos de desempenho que o .NET 9 finalmente elimina com a introdução de `System.Threading.Lock`.

## O custo oculto de `Monitor`

Quando você escreve `lock (myObj)`, o compilador traduz isso em chamadas para `System.Threading.Monitor.Enter` e `Monitor.Exit`. Esse mecanismo depende do object header word, um pedaço de metadado anexado a cada tipo de referência no heap gerenciado.

Usar um `object` padrão para travamento força o runtime a:

1.  Alocar um objeto no heap apenas pela identidade.
2.  Inflar o cabeçalho do objeto para acomodar informações de sincronização (o "sync block") quando há contenção.
3.  Adicionar pressão à coleta de lixo (GC), mesmo se o objeto nunca escapar da classe.

Em cenários de alto throughput, essas micro-alocações e manipulações de cabeçalho se acumulam.

## Chega `System.Threading.Lock`

O .NET 9 introduz um tipo dedicado: `System.Threading.Lock`. Isso não é apenas um wrapper em torno de `Monitor`; é uma primitiva de sincronização leve projetada especificamente para exclusão mútua.

Quando o compilador C# 13 encontra uma instrução `lock` apontando para uma instância de `System.Threading.Lock`, ele gera código diferente. Em vez de `Monitor.Enter`, ele chama `Lock.EnterScope()`, que retorna uma struct `Lock.Scope`. Essa struct implementa `IDisposable` para liberar o lock, garantindo segurança de thread mesmo que ocorram exceções.

### Antes vs. depois

Aqui está a abordagem tradicional que estamos deixando para trás:

```cs
public class LegacyCache
{
    // The old way: allocating a heap object just for locking
    private readonly object _syncRoot = new();
    private int _count;

    public void Increment()
    {
        lock (_syncRoot) // Compiles to Monitor.Enter(_syncRoot)
        {
            _count++;
        }
    }
}
```

E aqui está o padrão moderno no .NET 9:

```cs
using System.Threading;

public class ModernCache
{
    // The new way: a dedicated lock instance
    private readonly Lock _sync = new();
    private int _count;

    public void Increment()
    {
        // C# 13 recognizes this type and optimizes the IL
        lock (_sync) 
        {
            _count++;
        }
    }
}
```

## Por que isso importa

As melhorias são estruturais:

1.  **Intenção mais clara**: o nome do tipo `Lock` declara explicitamente seu propósito, diferentemente de um `object` genérico.
2.  **Desempenho**: `System.Threading.Lock` evita a sobrecarga do sync block do cabeçalho do objeto. Ele usa uma implementação interna mais eficiente que reduz os ciclos de CPU durante a aquisição e liberação do lock.
3.  **Compatibilidade futura**: usar o tipo dedicado permite ao runtime otimizar ainda mais a mecânica de travamento sem quebrar o comportamento legado de `Monitor`.

## Boas práticas

Esse recurso exige tanto o **.NET 9** quanto o **C# 13**. Se você está atualizando um projeto existente, pode substituir mecanicamente `private readonly object _lock = new();` por `private readonly Lock _lock = new();`. O compilador cuida do resto.

Não exponha a instância de `Lock` publicamente. Assim como no antigo padrão com `object`, o encapsulamento é fundamental para evitar deadlocks causados por código externo travando em suas primitivas internas de sincronização.

Para desenvolvedores que constroem sistemas de alta concorrência, essa pequena mudança representa um passo significativo na redução da sobrecarga do runtime.
