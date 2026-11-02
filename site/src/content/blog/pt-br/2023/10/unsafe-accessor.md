---
title: "C# UnsafeAccessor: membros privados sem reflexão (.NET 8)"
description: "Acesse construtores, métodos, propriedades e campos privados conhecidos com UnsafeAccessor do .NET 8, com exemplos testados e limites de versão."
pubDate: 2023-10-31
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
`UnsafeAccessorAttribute`, introduzido no .NET 8, permite vincular um método `static extern` a um membro conhecido e inacessível. O runtime fornece a implementação. É útil quando o tipo declarante e a assinatura são conhecidos na compilação; não substitui reflexão para descoberta em execução.

**Correção — 2 de novembro de 2026:** o artigo original descartava incorretamente sobrecargas e exigia uma instância para acesso estático. Essas afirmações foram corrigidas abaixo. O exemplo restaurado foi executado no .NET 8.0.33; o desempenho é discutido separadamente, sem alegar overhead zero universal.

## Baixar o exemplo completo

[Baixe o código executável em ZIP](/examples/unsafe-accessor.zip) ou veja as [instruções do exemplo](/examples/#unsafe-accessor). Ele inclui projeto, tipos declarantes, imports e verificações de todos os padrões abaixo.

```sh
dotnet run -c Release
```

O programa verifica os valores esperados e termina com falha se forem diferentes. Uma execução bem-sucedida imprime:

```text
PASS: constructors, instance/static members, field access, readonly accessor observation
```

## Construtores privados e sobrecargas

Uma classe auxiliar permite sobrecargas comuns de métodos C#. Um accessor de construtor retorna o tipo declarante e recebe os parâmetros do construtor de destino:

```cs
using System.Runtime.CompilerServices;

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create();

    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create(string value);
}
```

Essas declarações vinculam-se a `Foo()` e `Foo(string)`. O ZIP contém o tipo `Foo` completo. Funções locais de nível superior têm regras de nomes C# diferentes das de métodos em uma classe auxiliar; isso não é uma restrição de `UnsafeAccessor`.

## Métodos de instância e propriedades

O primeiro parâmetro identifica o tipo declarante e fornece a instância. Os outros tipos de parâmetros e o retorno devem corresponder ao destino. Propriedades são acessadas por seus métodos accessor:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
internal static extern string CallInstance(Foo instance, int value);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
internal static extern string GetProperty(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
internal static extern void SetProperty(Foo instance, string value);
```

O exemplo verifica o resultado do método privado, lê o valor inicial da propriedade, grava e lê novamente. Para membros de instância em structs, o primeiro parâmetro deve ser passado por `ref`.

## Membros estáticos

Use `StaticMethod` ou `StaticField`. O primeiro parâmetro ainda identifica o tipo declarante, mas **seu valor não é usado** e pode ser null:

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
internal static extern string CallStatic(Foo? typeMarker, int value);

var result = Accessors.CallStatic(null, 42);
```

O tipo declarante usado aqui não é uma classe estática. C# não permite uma classe estática como tipo de parâmetro; não conclua que esse padrão do .NET 8 acessa qualquer API de classe estática.

## Campos

Um accessor de campo retorna uma referência. O exemplo lê e grava campos de instância e estáticos:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
internal static extern ref int InstanceField(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
internal static extern ref int StaticField(Foo? typeMarker);
```

Para campos readonly, veja o [exemplo específico](/pt-br/2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor/). Acesso por referência não transforma mutação arbitrária de estado imutável em um design suportado.

## Limites e desempenho

A busca ocorre apenas no tipo declarante indicado; o runtime não percorre sua hierarquia de herança. Vínculos ausentes com campos ou métodos lançam erro quando usados. Assinaturas e restrições incorretas podem causar outras falhas de vinculação. Suporte a parâmetros genéricos foi adicionado no .NET 9, portanto esses exemplos exigem verificação separada de versão.

Um accessor pode evitar a busca por reflexão e o processamento de argumentos de `Invoke`, mas a operação de destino e o código gerado continuam relevantes. O [benchmark restaurado](/pt-br/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) inclui acesso direto, reflexão em cache e delegado em cache, com trabalho observável.

Fonte: [referência UnsafeAccessorAttribute da Microsoft](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute).
