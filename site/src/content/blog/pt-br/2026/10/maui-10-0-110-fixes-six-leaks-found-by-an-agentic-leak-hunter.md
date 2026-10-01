---
title: ".NET MAUI 10.0.110 corrige seis vazamentos de memória encontrados por um caçador de vazamentos agêntico"
description: "O MAUI 10.0.110 traz seis correções de vazamento para BackButtonBehavior, SwipeItemView, ListView.RefreshCommand, IndicatorView, GeometryGroup e TableView. A maioria foi reportada e corrigida por workflows gh-aw, e elas importam mais se você usa RelayCommand do CommunityToolkit.Mvvm."
pubDate: 2026-10-01
tags:
  - "maui"
  - "dotnet"
  - "memory-leaks"
  - "mvvm"
lang: "pt-br"
translationOf: "2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter"
translatedBy: "claude"
translationDate: 2026-10-01
---

O [.NET MAUI 10.0.110](https://github.com/dotnet/maui/releases/tag/10.0.110) foi lançado em 22 de setembro de 2026 com 181 commits. Leia as notas da versão e um padrão salta aos olhos: seis entradas com o prefixo `[leak-fix]`, cinco delas criadas por `github-actions[bot]`. A equipe do MAUI agora executa dois workflows agênticos, um "Daily Memory Leak Hunter" que abre issues `[leak-scan]` e um "Memory Leak Fixer" que abre PRs contra elas, e a 10.0.110 é a primeira versão de serviço em que a produção deles chega em volume.

## Os seis vazamentos

- `BackButtonBehavior.Command` (Shell), [#36345](https://github.com/dotnet/maui/issues/36345)
- `SwipeItemView.Command`, [#36343](https://github.com/dotnet/maui/issues/36343)
- `ListView.RefreshCommand`, [#36344](https://github.com/dotnet/maui/issues/36344)
- `IndicatorView` vinculado a uma `ObservableCollection` compartilhada, [#35775](https://github.com/dotnet/maui/issues/35775)
- `GeometryGroup.Children` com uma `GeometryCollection` compartilhada, [#36365](https://github.com/dotnet/maui/issues/36365)
- `TableView.Root` com um `TableRoot` compartilhado, [#36355](https://github.com/dotnet/maui/issues/36355)

Os seis têm o mesmo formato de bug: um controle assina um evento de algo que vive mais que ele, com um delegate forte e sem desassinar ao descarregar.

## Por que seu app pode ter sido afetado mesmo que os testes do MAUI não

Os três vazamentos de comando são os mais interessantes. O `BackButtonBehavior` fazia isto:

```csharp
newCommand.CanExecuteChanged += CanExecuteChanged;
```

e só cancelava a assinatura quando a propriedade `Command` mudava de novo. A própria classe `Command` do MAUI dispara `CanExecuteChanged` por meio de um `WeakEventManager`, então nunca vazou. Mas `CommunityToolkit.Mvvm.Input.RelayCommand`, e qualquer `ICommand` escrito à mão com um `event EventHandler` simples, mantém uma referência forte. Se esse comando vive em um serviço singleton ou em um view model reutilizado, toda página que o vinculou a um botão de voltar continuava enraizada após a navegação:

```text
ICommand (singleton / DI / static / reused VM)
  -> CanExecuteChanged (strong delegate)
     -> BackButtonBehavior
        -> attached page context
```

A correção, no [PR #36370](https://github.com/dotnet/maui/pull/36370), direciona a assinatura pelo helper interno `WeakCommandSubscription` que `Button`, `ImageButton` e `RefreshView` já usavam:

```csharp
WeakCommandSubscription _commandSubscription;

void OnCommandChanged(ICommand oldCommand, ICommand newCommand)
{
    _commandSubscription?.Dispose();
    _commandSubscription = null;

    if (newCommand != null)
    {
        _commandSubscription = new WeakCommandSubscription(this, newCommand, CanExecuteChanged);
        IsEnabledCore = Command.CanExecute(CommandParameter);
    }
    else
    {
        IsEnabledCore = true;
    }
}
```

O `WeakCommandSubscription` usa um `DependentHandle`, então o comando referencia o controle apenas de forma fraca. Nenhuma API pública mudou.

## Como os bots provaram o vazamento

Cada issue `[leak-scan]` traz um repro independente contra o pacote publicado `Microsoft.Maui.Controls` em um `net10.0` simples, sem emulador. Ele instala um `IDispatcherProvider` stub via `[ModuleInitializer]` para que os controles possam ser construídos sem interface, aloca 30 controles carregando 1 MB de payload cada, descarta todos, força vários ciclos de GC e conta os `WeakReference`s que sobreviveram. O PR do fixer então estende a theory existente `CommandsSubscribedToCanExecuteCollect` em `CommandTests.cs` e publica uma execução vermelha (sem a correção, comportamento ainda vivo) ao lado de uma verde. Esse é um rastro de evidências melhor do que a maioria das correções de vazamento escritas por humanos recebe.

O mesmo harness é um bom modelo para seus próprios controles: se você escreve uma view personalizada que assina um `ICommand` vinculável ou um `INotifyCollectionChanged`, um teste xunit de 40 linhas detecta o vazamento antes mesmo de você precisar de um heap snapshot.

## O que fazer

Atualize o pacote:

```xml
<PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
```

Se você contornava esses problemas com um `Command = null` manual em `OnDisappearing`, pode remover esse código após atualizar. Se você usa `RelayCommand` em view models de vida longa com `SwipeView`, pull-to-refresh do `ListView` ou botões de voltar do Shell, atualize primeiro e meça depois: parte dos seus relatos de "o MAUI vaza memória na navegação" provavelmente era isto.

Para a versão de serviço anterior do MAUI 10, veja [MAUI 10.0.100 e UsePlatformHandler](/pt-br/2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends/).
