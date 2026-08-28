---
title: "Aspire 13.5 coloca um terminal de verdade dentro do dashboard"
description: "WithTerminal() dá a um recurso uma sessão PTY interativa na qual você pode digitar pelo dashboard ou à qual pode se conectar pelo seu próprio shell. É experimental, desanexa o depurador e a opção Shell contra a qual você talvez tenha escrito código não existe mais."
pubDate: 2026-08-28
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "tooling"
lang: "pt-br"
translationOf: "2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard"
translatedBy: "claude"
translationDate: 2026-08-28
---

[O Aspire 13.5 chegou em 18 de agosto de 2026](https://devblogs.microsoft.com/aspire/whats-new-aspire-13-5/) com um dashboard redesenhado, AppHosts em TypeScript entrando em GA e uma dúzia de breaking changes. O que de fato muda o ciclo de desenvolvimento é menor do que todos eles: `WithTerminal()`, que dá a um recurso um pseudo-terminal ao vivo no qual você pode digitar pelo dashboard, em vez de apenas ler o log de console.

## Uma chamada, e o recurso ganha um PTY

```csharp
#pragma warning disable ASPIRETERMINAL001
var agent = builder.AddExecutable("agent", "my-agent", ".")
    .WithTerminal();
#pragma warning restore ASPIRETERMINAL001
```

A API é experimental, então a chamada emite `ASPIRETERMINAL001` e seu AppHost não compila até você reconhecer o aviso, seja com o pragma acima, seja adicionando o ID ao `<NoWarn>`. Uma vez ligado, a página Console Logs do recurso no dashboard ganha uma visão de terminal ao lado do fluxo de logs de sempre, e recursos em execução abrem nessa visão por padrão.

A sobrecarga com opções cobre a geometria da grade:

```csharp
.WithTerminal(options =>
{
    options.Columns = 200;  // padrão 120
    options.Rows = 50;      // padrão 30
});
```

Ambos precisam ser 1 ou maior; zero ou negativo lança `ArgumentOutOfRangeException`. A terceira opção, `ShowTerminalHost` (padrão `false`), revela a implementação de um jeito útil: ela controla "se os recursos ocultos de host de terminal, um por réplica, aparecem no dashboard e nas listas de recursos da CLI". Cada réplica ganha sua própria sessão independente atrás do seu próprio recurso host oculto, então `.WithReplicas(3).WithTerminal()` dá três, e você alterna entre elas no dashboard. A ordem dessas duas chamadas não importa. Chamar `WithTerminal()` duas vezes no mesmo recurso lança exceção.

## Conectando pelo seu próprio shell

A metade de CLI fica atrás de um feature flag:

```bash
aspire config set features.terminalCommandsEnabled true
aspire terminal ps
aspire terminal attach agent --replica 1
```

As sessões aceitam vários espectadores simultâneos, então uma aba do navegador e um shell local podem conduzir o mesmo processo sem que nenhum dos dois derrube a sessão.

## Duas arestas afiadas

A primeira é o depurador. Segundo a documentação, "quando você aplica `WithTerminal`, o Aspire executa o recurso como um processo comum e não anexa o depurador automaticamente". Isso o torna a ferramenta errada para o projeto que você está depurando passo a passo, e a certa para uma TUI, um REPL ou um script de migração que você quer conduzir na mão. O Aspire descreve isso como uma limitação temporária.

A segunda morde quem experimentou isso durante os previews do 13.4: não há como escolher qual shell é iniciado. A opção `Shell` foi removida "porque nunca esteve conectada ao pseudo-terminal subjacente e não tinha efeito algum". Código que atribuía `TerminalOptions.Shell` para de compilar no 13.5, depois de não ter feito nada no 13.4.

Uma observação de atualização antes de testar qualquer coisa: as notas de versão avisam que misturar pacotes 13.4 e 13.5 falha em tempo de execução com `MissingMethodException` ou `TypeLoadException`. Mova o SDK e todos os pacotes `Aspire.Hosting.*` para versões correspondentes no mesmo commit. Se você roda vários AppHosts lado a lado, isso combina bem com [a flag `--isolated` do 13.2](/pt-br/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/): cada execução isolada ganha suas próprias sessões de terminal junto com suas próprias portas.
