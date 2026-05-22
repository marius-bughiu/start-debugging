---
title: "C# 16 transforma unsafe em um contrato para quem chama"
description: "C# 16 redesenha a palavra-chave unsafe para que ela propague uma obrigação a quem chama em vez de abrir silenciosamente um contexto unsafe, e agora os blocos unsafe internos são obrigatórios."
pubDate: 2026-05-22
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "memory-safety"
lang: "pt-br"
translationOf: "2026/05/csharp-16-unsafe-keyword-caller-contract"
translatedBy: "claude"
translationDate: 2026-05-22
---

Richard Lander [apresentou um redesenho](https://devblogs.microsoft.com/dotnet/improving-csharp-memory-safety/) da palavra-chave `unsafe` que muda o seu significado depois de 25 anos. Hoje `unsafe` marca um detalhe de implementação: você transforma um método ou bloco em um contexto unsafe, escreve seu código de ponteiros e ninguém que chama esse método faz ideia de que está mexendo em código não seguro quanto à memória. O novo modelo, voltado para o **C# 16** como versão prévia no **.NET 11** e produção no **.NET 12**, transforma `unsafe` em um contrato voltado a quem chama. A motivação é em parte a ascensão do código gerado por IA: uma obrigação de segurança que existe apenas como convenção é invisível para quem revisa e para o modelo que escreve o código.

## O que a palavra-chave significa agora

Sob as regras atuais, marcar um método como `unsafe` faz duas tarefas não relacionadas ao mesmo tempo: permite que você escreva operações com ponteiros dentro dele e não exige nada de quem chama. O redesenho separa as duas.

`unsafe` na assinatura de um membro passa a ser um contrato que se propaga. Quem chama precisa envolver a invocação em um bloco `unsafe { }`, do mesmo jeito que você precisa envolver a desreferência de um `pointer`. E dentro de um método `unsafe`, as próprias operações unsafe ainda precisam de um bloco interno explícito. Não há mais passe livre:

```csharp
/// <safety>
/// The sum of <paramref name="ptr"/> and <paramref name="ofs"/> must address
/// a byte the caller is permitted to read.
/// </safety>
public static unsafe byte ReadByte(IntPtr ptr, int ofs)
{
    // SAFETY: relies on caller obligation.
    unsafe { return ((byte*)ptr)[ofs]; }
}
```

O bloco de documentação `/// <safety>` é o lugar formal para anotar a obrigação, e um analisador sinaliza membros `unsafe` que não a tenham.

## Cumprindo a obrigação

Um método que chama uma API `unsafe` tem duas escolhas: continuar propagando ao ser `unsafe` ele mesmo, ou se tornar um limite seguro validando a precondição e então envolvendo a chamada.

```csharp
void Caller2()
{
    if (!ObligationSatisfied()) throw new InvalidOperationException();
    unsafe { ReadByte(ptr, ofs); } // the guard discharges the contract
}
```

É exatamente esse o ponto: o bloco `unsafe` é onde você afirma "verifiquei a precondição", então ele deve ser pequeno e deliberado, não envolver um método inteiro.

## Menor superfície, padrão mais rígido

Algumas outras regras tornam o modelo mais rígido. O modificador de tipo `unsafe` deixou de existir, então a condição unsafe vive apenas em métodos, propriedades e campos. Tipos ponteiro não tornam mais uma assinatura unsafe por si só; passar um `byte*` é aceitável, desreferenciá-lo é o ato unsafe. E as declarações `extern` ganham um novo modificador `safe` para atestar que uma P/Invoke é segura de chamar:

```csharp
[LibraryImport("libc")]
internal static safe partial int getpid();
```

A configuração do projeto também se divide. A propriedade existente `<AllowUnsafeBlocks>` continua controlando se a palavra-chave `unsafe` sequer compila, enquanto uma nova propriedade de adesão seleciona o modelo do C# 16 sobre o que conta como unsafe. Omita ambas e você terá a postura mais rígida.

Nada disso torna o código de ponteiros seguro por si só. Como Lander coloca, as palavras-chave "não são a segurança; são o andaime que leva os desenvolvedores a articulá-la e honrá-la". Se você mantém uma biblioteca com caminhos críticos cheios de ponteiros, a versão prévia é a hora de começar a escrever blocos `<safety>`, porque no .NET 12 serão os seus chamadores que serão forçados a envolver suas APIs.
