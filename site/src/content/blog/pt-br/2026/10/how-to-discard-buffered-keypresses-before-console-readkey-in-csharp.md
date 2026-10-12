---
title: "Como descartar teclas em buffer antes de Console.ReadKey em um loop de jogo de console em C#"
description: "Esvazie o buffer de entrada do console com while (Console.KeyAvailable) Console.ReadKey(true) antes de aguardar uma nova tecla, e esvazie-o a cada frame em um loop de jogo para que a repetição de teclas não se acumule. Como o buffer funciona no Windows e no Unix no .NET 10, por que teclas mantidas pressionadas causam atraso, a armadilha do eco no Unix e FlushConsoleInputBuffer."
pubDate: 2026-10-12
template: how-to
tags:
  - "csharp"
  - "dotnet-10"
  - "console"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-discard-buffered-keypresses-before-console-readkey-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-12
---

**Resposta curta:** não existe um `Console.ClearInputBuffer()` no .NET, então você mesmo esvazia o buffer: `while (Console.KeyAvailable) Console.ReadKey(intercept: true);`. Coloque isso logo antes de qualquer `ReadKey` de "pressione uma tecla para continuar", para que as teclas digitadas durante uma cutscene ou uma pausa de carregamento não pulem o prompt. Em um loop de jogo, execute o mesmo esvaziamento uma vez por frame e aja sobre a última tecla (ou sobre todas as teclas que lhe interessam) em vez de ler uma tecla por frame; caso contrário, a repetição automática de uma tecla mantida pressionada se acumula na fila e o jogador continua se movendo depois de soltar a tecla. Proteja o código com `Console.IsInputRedirected`, porque tanto `KeyAvailable` quanto `ReadKey` lançam `InvalidOperationException` quando o stdin é um pipe ou um arquivo.

Tudo abaixo foi executado no .NET 10 (SDK 10.0.302, runtime 10.0.10) no macOS, controlando o app por meio de um pseudo-terminal real, para que as teclas passem pelo mesmo caminho de uma pessoa digitando. O comportamento no Windows é descrito a partir do código-fonte de `System.Console` na [tag `v10.0.0`](https://github.com/dotnet/runtime/tree/v10.0.0/src/libraries/System.Console/src/System); o código relevante (`KeyAvailable`, `ReadKey` e a configuração nativa do terminal no Unix) permanece inalterado na `main`, então a mesma resposta vale para os release candidates do .NET 11.

## Onde as teclas "em buffer" realmente ficam

Uma tecla pressionada não vai direto para a sua chamada de `ReadKey`. Ela é colocada em uma fila pelo sistema operacional e fica lá até que alguém a leia, não importa o que o seu programa estava fazendo quando a tecla foi pressionada. É por isso que um jogador que martela Enter durante uma "intro" com `Thread.Sleep` de dois segundos pula os três prompts seguintes.

A fila fica em um lugar diferente em cada plataforma, o que importa para escolher o flush correto:

- **Windows.** O host do console mantém uma fila de estruturas `INPUT_RECORD`: eventos de tecla pressionada e solta, eventos de mouse, eventos de redimensionamento de janela, eventos de foco. `Console.KeyAvailable` chama `PeekConsoleInput` e, se o registro no início da fila não for um evento de tecla pressionada que `ReadKey` retornaria, ele o lê e o descarta, e então olha de novo. `Console.ReadKey` chama `ReadConsoleInput` no mesmo loop. Um detalhe extra: se um registro de tecla tiver uma contagem de repetição maior que 1, o .NET o guarda em um campo estático privado (`_cachedInputRecord`) e entrega um `ConsoleKeyInfo` por repetição a partir desse cache.
- **Linux e macOS.** Os bytes chegam no descritor de arquivo do terminal. O `StdInReader` do .NET os lê em blocos para o seu próprio buffer `char[]` e interpreta as sequências de escape (`ESC [ A` para a seta para cima e assim por diante) transformando-as em valores `ConsoleKeyInfo`. `Console.KeyAvailable` retorna `true` se esse buffer gerenciado ainda contiver caracteres não interpretados, ou se o `poll()` no stdin indicar que o kernel tem mais bytes esperando.

Portanto, nas duas plataformas existe uma camada que pertence ao sistema operacional e outra que pertence ao .NET. Um flush que limpa apenas a camada do sistema operacional pode deixar teclas para trás na camada do .NET. Esvaziar por meio de `ReadKey` limpa as duas, e é por isso que essa é a resposta portável.

## Um repro mínimo de type-ahead pulando um prompt

```csharp
// .NET 10, C# 14 -- save as typeahead.cs and run with: dotnet run typeahead.cs
Console.WriteLine("Loading level (type some keys now)...");
Thread.Sleep(3000);                       // stands in for a cutscene, a save, a slow load

Console.WriteLine("Press any key to start.");
var key = Console.ReadKey(intercept: true);
Console.WriteLine($"Started by: {key.Key}");
```

Digite `abc` e uma tecla de seta durante a pausa de três segundos. O programa imprime "Press any key to start." e reporta imediatamente `Started by: A`, porque a primeira tecla em buffer satisfez o `ReadKey` antes mesmo de o prompt ficar visível. Se você usa isso como um app baseado em arquivo, o [passo a passo de `dotnet run file.cs`](/pt-br/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) explica como esses programas de arquivo único são compilados e armazenados em cache.

## A correção portável: esvaziar com KeyAvailable e ReadKey

1. Verifique `Console.IsInputRedirected` e pule o esvaziamento quando for `true`.
2. Faça um loop `while (Console.KeyAvailable)` e chame `Console.ReadKey(intercept: true)` dentro dele, descartando o resultado.
3. Só então exiba o prompt e chame `ReadKey` para a tecla que você realmente quer.

```csharp
// .NET 10, C# 14
static class ConsoleInput
{
    /// <summary>Discards every key that is already waiting. Returns how many were dropped.</summary>
    public static int DiscardPendingKeys()
    {
        if (Console.IsInputRedirected) return 0;

        int discarded = 0;
        while (Console.KeyAvailable)
        {
            Console.ReadKey(intercept: true);
            discarded++;
        }
        return discarded;
    }

    /// <summary>Waits for a key pressed after this call, ignoring type-ahead.</summary>
    public static ConsoleKeyInfo ReadFreshKey(bool intercept = true)
    {
        DiscardPendingKeys();
        return Console.ReadKey(intercept);
    }
}
```

O prompt do repro passa a ser:

```csharp
// .NET 10, C# 14
Console.WriteLine("Press any key to start.");
var key = ConsoleInput.ReadFreshKey();
Console.WriteLine($"Started by: {key.Key}");
```

Verifiquei o esvaziamento com este probe, enviando `abc`, seta para cima e seta para baixo a um pseudo-terminal durante o sleep e um `z` alguns segundos depois:

```csharp
// .NET 10, C# 14
Console.WriteLine("busy for 3s, type ahead now...");
Thread.Sleep(3000);
int discarded = 0;
while (Console.KeyAvailable)
{
    var k = Console.ReadKey(intercept: true);
    discarded++;
    Console.WriteLine($"discarded: Key={k.Key} Char={(int)k.KeyChar}");
}
Console.WriteLine($"discarded {discarded} keys; press a key");
var key = Console.ReadKey(intercept: true);
Console.WriteLine($"got: {key.Key}");
```

```text
discarded: Key=A Char=97
discarded: Key=B Char=98
discarded: Key=C Char=99
discarded: Key=UpArrow Char=0
discarded: Key=DownArrow Char=0
discarded 5 keys; press a key
got: Z
```

Dois detalhes que vale notar. As setas saíram como um `ConsoleKeyInfo` cada, e não como três caracteres soltos, porque `ReadKey` executa o interpretador de sequências de escape. Um flush em nível de byte (ler o stdin bruto ou chamar `tcflush`) pode cortar uma sequência de escape ao meio e deixar `[A` para trás, para ser lido como duas teclas imprimíveis. E `intercept: true` importa: com `false`, cada tecla descartada é exibida na tela com eco, que é exatamente a sujeira que você queria esconder.

## Por que teclas mantidas pressionadas continuam movendo o jogador após soltar

O mesmo buffer causa problemas em um loop em tempo real, só que de forma mais sutil. Quando o jogador mantém uma seta pressionada, o terminal ou o host do console gera eventos de repetição automática de tecla pressionada, normalmente cerca de 30 por segundo após um atraso inicial. Um loop típico de iniciante lê no máximo uma tecla por frame:

```csharp
// .NET 10, C# 14 -- one key per frame: input lags behind
while (running)
{
    if (Console.KeyAvailable)
        Handle(Console.ReadKey(intercept: true).Key);

    Update();
    Draw();
    Thread.Sleep(100);   // ~10 fps
}
```

Se as teclas chegam mais rápido que os frames, o acúmulo cresce enquanto a tecla estiver pressionada e depois é consumido a uma tecla por frame após ela ser solta. Eu medi: um loop a 10 frames por segundo, alimentado com 30 sequências de seta para a direita com 33 ms de intervalo (um segundo de repetição automática simulada, começando cerca de um segundo após a inicialização).

```csharp
// .NET 10, C# 14
bool drainAll = args.Length > 0 && args[0] == "drain";
_ = Console.KeyAvailable;
var sw = System.Diagnostics.Stopwatch.StartNew();
int x = 0; long lastMove = 0;
while (sw.ElapsedMilliseconds < 4000)
{
    if (drainAll)
    {
        ConsoleKey? last = null;
        while (Console.KeyAvailable) last = Console.ReadKey(intercept: true).Key;
        if (last == ConsoleKey.RightArrow) { x++; lastMove = sw.ElapsedMilliseconds; }
    }
    else if (Console.KeyAvailable)
    {
        if (Console.ReadKey(intercept: true).Key == ConsoleKey.RightArrow) { x++; lastMove = sw.ElapsedMilliseconds; }
    }
    Thread.Sleep(100); // 10 fps
}
Console.WriteLine($"{(drainAll ? "drain" : "one-per-frame")}: x={x}, last move at {lastMove} ms");
```

```text
one-per-frame: x=30, last move at 3739 ms
drain: x=13, last move at 2268 ms
```

Com uma tecla por frame, o jogador se moveu 30 células e ainda estava se movendo cerca de 1,5 segundo depois de a tecla ter sido "solta". Com o esvaziamento completo a cada frame, o movimento parou dentro de um frame após a última repetição. A versão com esvaziamento move uma célula por frame enquanto a tecla está pressionada, que é o que um jogo normalmente quer: velocidade atrelada à taxa de frames, e não à taxa de repetição do sistema operacional.

O padrão geral é esvaziar a cada frame em um pequeno estado de entrada por frame e deixar o `Update` ler esse estado:

```csharp
// .NET 10, C# 14
sealed class FrameInput
{
    private readonly HashSet<ConsoleKey> _pressed = new();

    public bool WasPressed(ConsoleKey key) => _pressed.Contains(key);

    public void Poll()
    {
        _pressed.Clear();
        if (Console.IsInputRedirected) return;

        while (Console.KeyAvailable)
            _pressed.Add(Console.ReadKey(intercept: true).Key);
    }
}

// game loop
var input = new FrameInput();
while (running)
{
    input.Poll();
    if (input.WasPressed(ConsoleKey.Escape)) break;
    if (input.WasPressed(ConsoleKey.LeftArrow))  player.X--;
    if (input.WasPressed(ConsoleKey.RightArrow)) player.X++;
    if (input.WasPressed(ConsoleKey.Spacebar))   player.Jump();

    Draw();
    Thread.Sleep(16);
}
```

Usar um conjunto em vez de "a última tecla vence" significa que um pulo pressionado no mesmo frame de uma mudança de direção não se perde. Se você precisa de modificadores, guarde o `ConsoleKeyInfo` inteiro ou um par `(ConsoleKey, ConsoleModifiers)`.

O que o console não consegue dizer é se uma tecla está *atualmente pressionada*. `ReadKey` só expõe eventos de tecla pressionada (no Windows, os registros de tecla solta são ignorados, exceto o de uma tecla Alt solta que carrega um caractere composto, e o mesmo vale para pressionamentos isolados de Shift, Ctrl e Alt; no Unix, os terminais simplesmente não enviam tecla solta). "Pressionada" em um jogo de console é inferido pela chegada de eventos de repetição, e é por isso que sempre existe o atraso inicial de repetição do sistema operacional antes de o movimento contínuo começar. Se você precisa do estado real das teclas no Windows, `GetAsyncKeyState` via P/Invoke é a saída de emergência de sempre, e nesse ponto vale considerar um framework de jogos de verdade.

## A armadilha do eco no Unix: o type-ahead aparece na tela

No Linux e no macOS existe um segundo sintoma que o esvaziamento não resolve. No meu primeiro probe, a saída na verdade era assim:

```text
busy for 3s, type ahead now...
abc^[[A^[[Bdiscarded: Key=A Char=97
```

As teclas foram descartadas corretamente, mas o terminal já as tinha exibido com eco enquanto o programa dormia. O motivo está em `pal_console.c`: o .NET coloca o terminal em modo não canônico e sem eco (`ECHO`, `ICANON` e `IEXTEN` desativados) na primeira vez que você faz uma *leitura* do console, e isso inclui `Console.KeyAvailable`, que chama `SystemNative_StdinReady`. Antes dessa primeira leitura, o terminal ainda está no modo cooked padrão e exibe tudo com eco. Depois de configurado, o .NET deixa o terminal nesse modo até o processo terminar, quando restaura as configurações originais.

A correção é tocar o lado da entrada uma vez na inicialização:

```csharp
// .NET 10, C# 14 -- first line of Main, before any long-running work
if (!Console.IsInputRedirected)
    _ = Console.KeyAvailable;   // puts the terminal in no-echo, non-canonical mode
```

Com essa linha primeiro, o mesmo sleep de três segundos com teclas digitadas durante ele produziu uma saída limpa: as teclas ficaram no buffer, nada foi exibido com eco, e o esvaziamento posterior as removeu. No Windows isso não é um problema, porque o type-ahead de um app de console fica como registros de entrada e não é exibido com eco até que algo os leia em modo de linha.

## Somente no Windows: FlushConsoleInputBuffer

O Win32 tem uma chamada direta, [`FlushConsoleInputBuffer`](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), que esvazia a fila de registros de entrada do console de uma só vez. É tentadora porque é O(1) e também limpa registros de mouse e de redimensionamento:

```csharp
// .NET 10, C# 14 -- needs <AllowUnsafeBlocks>true</AllowUnsafeBlocks> for LibraryImport
using System.Runtime.InteropServices;

static partial class WinConsole
{
    private const int StdInputHandle = -10;

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint GetStdHandle(int nStdHandle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool FlushConsoleInputBuffer(nint hConsoleInput);

    public static bool TryFlush()
    {
        if (!OperatingSystem.IsWindows() || Console.IsInputRedirected) return false;
        return FlushConsoleInputBuffer(GetStdHandle(StdInputHandle));
    }
}
```

Compilei isso no .NET 10 (como um app baseado em arquivo com `#:property AllowUnsafeBlocks=true`), mas só consegui executá-lo no macOS, onde `TryFlush` retorna `false` sem chamar `kernel32`. Eu ainda chamaria o esvaziamento gerenciado depois dele, por um motivo visível no código-fonte: `FlushConsoleInputBuffer` não alcança o `_cachedInputRecord` privado do .NET. Se o último registro que `ReadKey` puxou tinha uma contagem de repetição acima de 1, as repetições restantes são servidas a partir desse campo, e `KeyAvailable` retorna `true` para elas antes mesmo de consultar o console. `DiscardPendingKeys()` esvazia o cache também. Se `LibraryImport` e o marshalling gerado por código-fonte são novidade para você, o [post sobre Polars.NET](/pt-br/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/) os explica, e o [post sobre eventos de bloqueio e desbloqueio de sessão do Windows](/pt-br/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/) usa o mesmo padrão de `LibraryImport` com `wtsapi32.dll`, incluindo a configuração de `AllowUnsafeBlocks`.

## Armadilhas e casos extremos

**Entrada redirecionada lança exceção.** Com o stdin vindo de um pipe (`echo abc | dotnet run game.cs`), as duas chamadas lançam exceção. As mensagens exatas do .NET 10:

```text
KeyAvailable threw InvalidOperationException: Cannot see if a key has been pressed when either application does not have a console or when console input has been redirected from a file. Try Console.In.Peek.
ReadKey threw InvalidOperationException: Cannot read keys when either application does not have a console or when console input has been redirected. Try Console.Read.
```

Isso causa problemas em CI, em execuções de `dotnet test` que exercitam o código de console e em alguns consoles de "execução" de IDEs que redirecionam o stdin. Todos os helpers acima retornam cedo em `Console.IsInputRedirected`.

**Não esvazie com Console.In.** `Console.In.Read()` e `Console.In.Peek()` são orientados a linha no Unix: eles leem uma linha inteira para uma pilha separada dentro de `StdInReader` antes de retornar, então bloqueiam até o Enter e puxam as teclas para um lugar que `KeyAvailable` não verifica. Misturar `ReadLine` e `ReadKey` no mesmo programa é aceitável; esvaziar com a API `TextReader` não é.

**Esvaziar não é um debounce.** Se o usuário pressiona uma tecla 5 ms depois do seu esvaziamento, essa é uma tecla nova e `ReadKey` vai retorná-la. Isso está correto, mas se a sua preocupação são toques duplos acidentais em um menu, adicione um pequeno atraso antes do esvaziamento, por exemplo `Thread.Sleep(150)` logo após a ação que disparou o prompt.

**Não faça spin em KeyAvailable.** `while (!Console.KeyAvailable) { }` consome um núcleo inteiro. Em um loop de frames, durma ou espere pelo próximo frame. Se você quer "aguardar uma tecla, mas desistir após N segundos", faça polling de `KeyAvailable` com um `Task.Delay` curto e um prazo limite, ou envolva isso em um token de [`CancellationTokenSource.CancelAfter`](/pt-br/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/). `Console.ReadKey` em si não pode ser cancelado depois que está bloqueado, então a única forma de desistir é nunca chamá-lo até que `KeyAvailable` indique que há algo para ler. Passe o token pela cadeia de chamadas da mesma forma que faria em qualquer [método assíncrono que deva respeitar o cancelamento](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

**Ctrl+C não é uma tecla por padrão.** A menos que você defina `Console.TreatControlCAsInput = true`, Ctrl+C dispara `Console.CancelKeyPress` e nunca entra no buffer, então um esvaziamento nem o vê nem o engole. Se você definir como `true` em um jogo, lembre-se de que o seu esvaziamento agora vai engolir silenciosamente um Ctrl+C pressionado durante uma pausa.

**Leituras com várias threads.** No Windows, `ReadKey` obtém um lock; no Unix, `KeyAvailable` e `ReadKey` passam por um leitor sincronizado. Isso os torna seguros para chamar de threads diferentes, mas sem sentido: uma thread de entrada em segundo plano e um esvaziamento na thread principal vão roubar teclas um do outro. Escolha uma thread para ser dona da entrada do console.

### Leia a seguir

- [Como executar um app C# baseado em arquivo com dotnet run no .NET 11](/pt-br/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/)
- [Como definir um timeout em uma operação assíncrona com CancellationTokenSource.CancelAfter em C#](/pt-br/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [Como propagar um CancellationToken por métodos assíncronos no .NET 11](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Como detectar eventos de bloqueio, desbloqueio, logon e logoff de sessão do Windows em um app C#](/pt-br/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/)

## Fontes

- [Propriedade `Console.KeyAvailable`](https://learn.microsoft.com/en-us/dotnet/api/system.console.keyavailable), Microsoft Learn.
- [Método `Console.ReadKey`](https://learn.microsoft.com/en-us/dotnet/api/system.console.readkey), Microsoft Learn.
- [Função `FlushConsoleInputBuffer`](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), documentação do Windows Console.
- [`ConsolePal.Windows.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/ConsolePal.Windows.cs) na `v10.0.0` (`KeyAvailable`, `ReadKey`, `_cachedInputRecord`).
- [`StdInReader.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/StdInReader.cs) e [`SyncTextReader.Unix.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/SyncTextReader.Unix.cs) na `v10.0.0` (buffer do Unix e `KeyAvailable`).
- [`pal_console.c`](https://github.com/dotnet/runtime/blob/v10.0.0/src/native/libs/System.Native/pal_console.c) na `v10.0.0` (eco do terminal e modo canônico).
