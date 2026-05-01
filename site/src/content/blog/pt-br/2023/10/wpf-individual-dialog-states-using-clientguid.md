---
title: "WPF estados individuais de dialog com ClientGuid"
description: "Use a propriedade ClientGuid no .NET 8 para persistir estados individuais por dialog, como tamanho da janela, posição e última pasta usada, entre os file dialogs do WPF."
pubDate: 2023-10-13
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "pt-br"
translationOf: "2023/10/wpf-individual-dialog-states-using-clientguid"
translatedBy: "claude"
translationDate: 2026-05-01
---
Uma nova propriedade `ClientGuid`, introduzida no .NET 8, permite identificar de forma única dialogs como o `OpenFileDialog` e o `OpenFolderDialog`, com o objetivo de armazenar estado, como tamanho da janela, posição e última pasta usada, separadamente por dialog.

Para tirar proveito desse comportamento, configure o `ClientGuid` do seu dialog com um identificador conhecido antes de chamar o método `ShowDialog()`.

```cs
static readonly Guid _id = new Guid("32bc5a4c-e28f-408a-8aca-e0b430fbc17c");

var dialog = new OpenFileDialog 
{
    ClientGuid = _id
};

dialog.ShowDialog();
```

O estado do dialog é mantido entre diferentes execuções da aplicação e até entre aplicações diferentes. O que importa é que o `ClientGuid` seja o mesmo.

**Observação:** garanta usar o mesmo identificador em diferentes instâncias da aplicação. Não gere o `Guid` em tempo de execução usando `Guid.NewGuid()`, porque isso resulta em um novo `Guid` a cada execução, fazendo o estado do dialog ser redefinido. Em vez disso, armazene o `Guid` como no exemplo acima, ou crie uma classe `KnownDialogs` especificamente para guardar identificadores de dialogs.
