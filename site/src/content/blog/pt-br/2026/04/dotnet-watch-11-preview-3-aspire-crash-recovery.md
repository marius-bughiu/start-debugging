---
title: "dotnet watch no .NET 11 Preview 3: hosts Aspire, crash recovery, e Ctrl+C mais são"
description: "dotnet watch ganha integração com Aspire app host, relançamento automático depois de crashes, e tratamento de Ctrl+C consertado para apps desktop Windows no .NET 11 Preview 3."
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "aspire"
  - "dotnet-watch"
lang: "pt-br"
translationOf: "2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery"
translatedBy: "claude"
translationDate: 2026-04-24
---

`dotnet watch` sempre foi o cavalo de trabalho silencioso do inner loop do .NET. Recarrega sua app quando arquivos mudam, aplica hot reload onde consegue, e fica fora do caminho quando não consegue. .NET 11 Preview 3 (lançado em 14 de abril de 2026) empurra a ferramenta pra frente em três pontos de dor específicos: rodar apps distribuídas, sobreviver a crashes, e lidar com Ctrl+C em targets desktop Windows.

## App hosts Aspire agora vigiam limpos

Até o Preview 3, rodar um Aspire app host sob `dotnet watch` era esquisito. Aspire orquestra múltiplos projetos filhos, e o watcher não entendia esse modelo, então mudanças de arquivo ou rebuildavam só o host ou forçavam a topologia inteira a reiniciar do zero.

Preview 3 fia o `dotnet watch` no app model do Aspire diretamente:

```bash
cd src/MyApp.AppHost
dotnet watch
```

Edite um arquivo em `MyApp.ApiService` e o watcher agora aplica a mudança só naquele serviço, mantendo o resto da topologia Aspire viva. O dashboard fica em pé, os contêineres dependentes continuam rodando, e você perde segundos de boot time a cada mudança em vez de segundos por projeto.

Pra soluções microservice-heavy essa é a diferença entre `dotnet watch` ser um nice-to-have e ser a forma padrão de trabalhar.

## Relançamento automático depois de um crash

A segunda manchete é crash recovery. Antes, quando sua app vigiada lançava uma exceção não tratada e morria, `dotnet watch` parava na mensagem de crash e esperava restart manual. Se sua próxima tecla salvasse um fix, nada acontecia até você bater Ctrl+R.

No Preview 3 esse comportamento inverte. Pegue um endpoint que explode:

```csharp
app.MapGet("/", () =>
{
    throw new InvalidOperationException("boom");
});
```

Deixe a app crashar uma vez, salve um fix, e `dotnet watch` relança automaticamente na próxima mudança relevante de arquivo. Você não perde o feedback loop só porque a app decidiu sair non-zero. O mesmo comportamento cobre crashes no startup, que costumavam deixar o watcher preso antes que hot reload pudesse sequer se anexar.

Isso compõe bem com o tratamento "rude edit" watch-wide que já existe: hot reload tenta primeiro, cai pra um restart em edits não suportados, e agora cai pra um restart depois de um crash também. Três caminhos, um resultado consistente: a app volta.

## Ctrl+C em apps desktop Windows

O terceiro fix é pequeno mas era crônico: Ctrl+C no `dotnet watch` pra apps WPF e Windows Forms. Antes podia deixar o processo desktop órfão, desconectado do watcher, ou preso dentro de uma janela modal. Preview 3 re-encana o tratamento de sinais pra que Ctrl+C derrube tanto o watcher quanto o processo desktop em ordem, sem entradas zumbi de `dotnet.exe` empilhando no Task Manager.

Se você roda um shell WPF sob `dotnet watch`:

```bash
dotnet watch run --project src/DesktopShell
```

Bata Ctrl+C uma vez e tanto o shell quanto o watcher saem limpos. Soa básico, e é, mas o comportamento anterior era a razão principal de muitos times evitarem `dotnet watch` em projetos desktop por completo.

## Por que esses três juntos importam

Cada mudança sozinha é modesta. Combinadas, movem `dotnet watch` de um helper por projeto pra um arnês de sessão inteira que pode hospedar uma topologia Aspire o dia todo, absorver o crash ocasional, e se limpar quando você termina. O inner loop ficou consideravelmente menos frágil.

Release notes estão no [Blog do .NET](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) e a seção do SDK vive em [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk).
