---
title: "WPF Evitar que a seleção do file dialog vá para os recentes"
description: "Evite que as seleções do file dialog em WPF apareçam nos recentes do Windows Explorer e no Menu Iniciar definindo AddToRecent como false no .NET 8."
pubDate: 2023-10-18
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "pt-br"
translationOf: "2023/10/wpf-prevent-file-dialog-selection-from-being-added-to-recents"
translatedBy: "claude"
translationDate: 2026-05-01
---
Os arquivos abertos ou salvos pelos file dialogs do WPF (`OpenFileDialog`, `SaveFileDialog` ou `OpenFolderDialog`) são, por padrão, adicionados à lista de arquivos recentes do Windows Explorer e também podem aparecer na seção Recomendado do Menu Iniciar do Windows 11.

Para desabilitar esse comportamento, defina `AddToRecent` como `false` no seu dialog antes de chamar o método `ShowDialog()`. Observação: essa propriedade foi adicionada no .NET 8, então, se ela não estiver disponível, garanta que seu projeto esteja mirando .NET 8 ou mais recente.

Um exemplo rápido:

```cs
var dialog = new OpenFileDialog 
{
    AddToRecent = false
};
 
dialog.ShowDialog();
```

Pronto. Agora os arquivos escolhidos pelo usuário usando o `OpenFileDialog` não aparecerão mais na lista de arquivos recentes nem no Menu Iniciar.

Observação: `AddToRecent` tem valor padrão `true`. Ou seja, a menos que você defina explicitamente como `false`, os arquivos escolhidos pelos dialogs continuarão aparecendo nos recentes.
