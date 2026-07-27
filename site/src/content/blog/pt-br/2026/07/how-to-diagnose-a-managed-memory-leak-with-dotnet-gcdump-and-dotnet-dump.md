---
title: "Como diagnosticar um vazamento de memória gerenciada com dotnet-gcdump e dotnet-dump"
description: "Um fluxo de trabalho completo para encontrar um vazamento de memória gerenciada no .NET 11: confirme o crescimento com dotnet-counters, tire dois gcdumps e compare-os, depois colete um dump e use dumpheap, gcroot e objsize no dotnet-dump analyze para descobrir o que ainda está segurando a referência."
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "diagnostics"
  - "memory"
  - "performance"
lang: "pt-br"
translationOf: "2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump"
translatedBy: "claude"
translationDate: 2026-07-27
---

Para diagnosticar um vazamento de memória gerenciada no .NET, confirme que o crescimento é real com `dotnet-counters monitor`, capture dois snapshots de `dotnet-gcdump collect` com alguns minutos de diferença para ver qual contagem de tipo está subindo, e então tire um `dotnet-dump collect` e execute `dumpheap -stat`, `dumpheap -type <Name>` e `gcroot <address>` dentro do `dotnet-dump analyze` para encontrar a cadeia de referências que mantém esses objetos vivos. O gcdump diz *o que* está crescendo com quase nenhuma sobrecarga; o dump diz *quem está segurando*. Você precisa dos dois, nessa ordem. Este artigo usa `dotnet-gcdump` e `dotnet-dump` 10.0 sobre .NET 11 (Preview 6 no momento em que este texto foi escrito, GA em novembro de 2026), mas todos os comandos aqui são estáveis desde o .NET Core 3.1.

## Por que o GC não vai te salvar aqui

Um vazamento de memória gerenciada não é um vazamento no sentido do C. Nada fica sem ser liberado. O coletor de lixo faz exatamente o que foi projetado para fazer: ele não vai coletar um objeto que seja alcançável a partir de uma raiz, e o seu código tornou alcançáveis por acidente algumas centenas de milhares de objetos. Uma raiz é um campo estático, uma variável local ou um argumento vivo na pilha de alguma thread, um handle forte do GC, ou a fila de finalização. Todo o resto é alcançável transitivamente a partir daí.

Isso significa que a pergunta de diagnóstico nunca é "por que o GC não rodou?". É "qual cadeia de raízes ainda aponta para este objeto?". Todas as ferramentas abaixo existem para responder essa única pergunta. Os suspeitos clássicos em uma aplicação ASP.NET Core:

- Uma coleção estática ou singleton que só cresce: um `ConcurrentDictionary` usado como cache sem despejo, uma `List<T>` de "requisições recentes".
- Uma assinatura de evento que nunca é cancelada. O publicador segura um delegate, o delegate segura o assinante, e se o publicador é um singleton ou um estático, cada assinante vive para sempre.
- Um serviço com escopo capturado por um singleton, que arrasta junto todo o grafo de objetos do escopo. Esse normalmente aparece primeiro como [uma ObjectDisposedException em um DbContext já descartado](/pt-br/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/), porque a captura também é [um bug de tempo de vida de serviço com escopo dentro de um singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- Um `Timer` ou um `CancellationTokenSource` de vida longa cujo callback captura um grafo grande de objetos.

## Passo 0: prove que existe mesmo um vazamento

Não colete nada até ter observado o heap gerenciado crescer ao longo do tempo. Crescimento do working set sozinho não é um vazamento gerenciado; pode ser alocação nativa, fragmentação, ou simplesmente o GC não devolvendo memória ao sistema operacional porque nada está pressionando.

Instale as ferramentas uma vez e encontre o PID:

```bash
# Verified with the .NET 11 SDK, July 2026
dotnet tool install --global dotnet-counters
dotnet tool install --global dotnet-gcdump
dotnet tool install --global dotnet-dump

dotnet-counters ps
# 4807  MyApi  /srv/myapi/MyApi
```

Depois observe o heap, não o processo:

```bash
dotnet-counters monitor --refresh-interval 5 --process-id 4807 \
  --counters System.Runtime[dotnet.gc.last_collection.heap.size,dotnet.process.memory.working_set]
```

No .NET 9 e posteriores, `System.Runtime` é um `Meter` e os nomes dos contadores são os no estilo OpenTelemetry mostrados acima. No .NET 8 e anteriores, o `dotnet-counters` volta para os EventCounters antigos e o que você quer é `GC Heap Size (MB)`.

O número que importa é `dotnet.gc.last_collection.heap.size` separado por geração. Duas leituras dizem com o que você está lidando:

- **gen2 subindo de forma monotônica entre as coletas**: um vazamento gerenciado real. Objetos estão sobrevivendo até a geração mais antiga e nunca morrem. Continue com este artigo.
- **gen0/gen1 girando muito mas gen2 estável, working set alto**: não é um vazamento. Isso é pressão de alocação ou fragmentação. Use [o dotnet-trace com o profile gc-verbose](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) para encontrar o ponto quente de alocação.
- **tamanho do heap estável mas working set subindo**: o vazamento é nativo. gcdump e SOS não vão te mostrar nada útil. Olhe para interop nativo, tempos de vida de `SafeHandle`, ou o LOH sendo comprometido mas não descomprometido.

## Uma reprodução mínima que vaza

Este é o menor serviço ASP.NET Core que vaza de um jeito que as duas ferramentas conseguem encontrar. É um singleton que assina um evento em outro singleton e nunca cancela a assinatura:

```csharp
// .NET 11, C# 14
public sealed class TelemetryBus
{
    public event EventHandler<string>? MetricRecorded;
    public void Record(string metric) => MetricRecorded?.Invoke(this, metric);
}

public sealed class ReportSession
{
    private readonly byte[] _buffer = new byte[64 * 1024];
    private readonly List<string> _log = [];

    public ReportSession(TelemetryBus bus)
    {
        // Nothing ever removes this handler, so `bus` roots every ReportSession
        // ever created, and each one roots 64 KB plus a growing List<string>.
        bus.MetricRecorded += OnMetric;
    }

    private void OnMetric(object? sender, string metric) => _log.Add(metric);
}

app.MapPost("/reports", (TelemetryBus bus) =>
{
    _ = new ReportSession(bus);   // per-request, never released
    return Results.Accepted();
});
```

`TelemetryBus` é um singleton, então sua lista de invocação fica enraizada por toda a vida do processo. Cada `ReportSession` é alcançável a partir desse delegate, e portanto cada `byte[64*1024]` também é. Martele `/reports` e o heap de gen2 sobe para sempre.

## O procedimento completo

1. **Confirme que o heap gerenciado está crescendo** com `dotnet-counters monitor --counters System.Runtime[dotnet.gc.last_collection.heap.size]`, olhando especificamente para gen2.
2. **Capture um gcdump de referência** com `dotnet-gcdump collect --process-id <PID> --output baseline.gcdump`.
3. **Deixe a aplicação rodar sob carga** por tempo suficiente para o vazamento ficar inequívoco, tipicamente de cinco a quinze minutos.
4. **Capture um segundo gcdump** com `dotnet-gcdump collect --process-id <PID> --output after.gcdump`, e compare as contagens de tipos dos dois para descobrir qual está crescendo.
5. **Colete um dump completo** com `dotnet-dump collect --process-id <PID> --type Heap --output leak.dmp` assim que souber o que está procurando.
6. **Abra o dump** com `dotnet-dump analyze leak.dmp` e confirme o tipo com `dumpheap -stat` ou `dumpheap -type <TypeName> -stat`.
7. **Pegue o endereço de uma instância** em `dumpheap -type <TypeName>` e execute `gcroot <address>` para imprimir a cadeia de referências de uma raiz até aquele objeto.
8. **Conserte a cadeia**, não o objeto. O último salto antes do seu tipo na saída do `gcroot` é o que está segurando a referência.

## Passos 2 a 4: gcdump, a primeira olhada barata

O `dotnet-gcdump` não escreve um dump de processo. Ele induz uma coleta de gen2, liga eventos de sobrevivência do heap do GC, e reconstrói o grafo de objetos a partir do fluxo do [EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe). O resultado é um arquivo `.gcdump` contendo tipos, contagens, tamanhos e arestas, mas nenhum valor de campo e nenhuma pilha de thread. Normalmente tem poucos megabytes, enquanto um dump completo do mesmo processo teria centenas.

```bash
dotnet-gcdump collect --process-id 4807 --output baseline.gcdump
# Writing gcdump to './baseline.gcdump'...
#     Finished writing 5763432 bytes.

# ... let it run under load ...

dotnet-gcdump collect --process-id 4807 --output after.gcdump
```

Você não precisa de uma interface gráfica para compará-los. O verbo `report` imprime uma tabela de estatísticas do heap direto no stdout, o que funciona no Linux, onde nada consegue abrir um arquivo `.gcdump`:

```bash
dotnet-gcdump report ./after.gcdump
#           Size (Bytes) Count       Type
#         ============== =====       ====
#          1,603,588,000 22,000,000  System.String
#            201,096,000  2,010,000  System.Byte[]
#             25,000,000    250,000  MyApi.Reports.ReportSession
```

Rode `report` nos dois arquivos e compare as contagens. No Windows você também pode abrir os dois arquivos `.gcdump` ao mesmo tempo no Visual Studio e ter uma visão de comparação lado a lado de verdade, com coluna de diferença, o que vale a viagem se você tiver uma máquina Windows por perto. O PerfView também os lê. Atualmente não há como abrir um `.gcdump` no Linux ou macOS, então lá o `dotnet-gcdump report` é sua única opção.

O `report` também aceita `--process-id` diretamente, o que coleta e imprime de uma vez só quando você não quer o arquivo:

```bash
dotnet-gcdump report --process-id 4807
```

No fim desse passo você deve ter um nome de tipo. É tudo o que o gcdump te deve.

## Passos 5 a 7: dotnet-dump, onde você encontra a raiz

Um gcdump não consegue dizer qual *campo* de qual *objeto* segura a referência, e não consegue mostrar as pilhas de thread. Para isso você precisa de um dump de verdade e do SOS.

```bash
dotnet-dump collect --process-id 4807 --type Heap --output leak.dmp
```

O padrão de `--type` é `Full`, que inclui as imagens dos módulos mapeados e normalmente é bem maior do que o necessário. `Heap` te dá listas de módulos, listas de threads, todas as pilhas, informação de exceções e handles, e toda a memória exceto as imagens mapeadas, o que cobre tudo neste fluxo de trabalho. Use `Mini` apenas para triagem de crash; ele não carrega o heap do GC.

Depois abra o shell interativo do SOS:

```bash
dotnet-dump analyze leak.dmp
```

Comece pela visão estatística. Adicione `-live` para que a fase de marcação do GC seja usada para excluir objetos que já são lixo mas ainda não foram varridos, o que remove bastante ruído:

```console
> dumpheap -stat -live

Statistics:
              MT    Count    TotalSize Class Name
00007f6c1dc014c0      467       416464 System.Byte[]
00007f6c20a67498   250000     16000000 MyApi.Reports.ReportSession
00007f6c1dc00f90   206770     19494060 System.String
```

Variantes úteis do mesmo comando:

- `dumpheap -stat -bycount` ordena por contagem de instâncias em vez de tamanho total, o que traz à tona vazamentos do tipo "um milhão de objetos minúsculos" que os totais em bytes escondem.
- `dumpheap -type MyApi.Reports -stat` filtra por uma substring do nome do tipo, então você pode limitar a tabela a um namespace e ignorar o ruído do framework.
- `dumpheap -gen loh -stat` restringe ao heap de objetos grandes. Aceita `gen0`, `gen1`, `gen2`, `loh`, `poh` e `foh`.
- `dumpheap -min 100000 -stat` ignora qualquer coisa abaixo de 100.000 bytes.

Agora pegue um endereço concreto e encontre sua raiz:

```console
> dumpheap -type MyApi.Reports.ReportSession
         Address               MT     Size
00007f6ad09421f8 00007f6c20a67498       32
...

> gcroot 00007f6ad09421f8

HandleTable:
    00007F6C98BB15F8 (pinned handle)
    -> 00007F6BDFFFF038 System.Object[]
    -> 00007F69D0033570 MyApi.Telemetry.TelemetryBus
    -> 00007F69D0033588 System.EventHandler`1[[System.String, System.Private.CoreLib]]
    -> 00007F69D00335A0 System.Object[]
    -> 00007F6AD0942258 MyApi.Reports.ReportSession

Found 1 root.
```

Leia essa cadeia de baixo para cima. O objeto que vaza está embaixo; a raiz está em cima. O salto imediatamente acima do seu tipo é o culpado, e aqui ele é inconfundível: um delegate multicast `EventHandler<string>` cuja lista de invocação (`System.Object[]`) segura todas as sessões. Isso mapeia diretamente para a linha `bus.MetricRecorded += OnMetric` sem um `-=` correspondente.

O `gcroot` imprime apenas raízes únicas por padrão. Passe `-all` quando quiser todos os caminhos, e `-nostacks` para restringir a busca a handles e objetos alcançáveis quando a varredura de pilha estiver produzindo falsos positivos vindos de registradores obsoletos.

Mais dois comandos que vale conhecer nesse ponto. `objsize <address>` informa o tamanho retido de um objeto incluindo tudo o que ele segura transitivamente, que é como você transforma "essa coisa tem 32 bytes" em "essa coisa está mantendo 68 KB vivos". E `dumpobj <address>` imprime o layout campo a campo para você confirmar qual campo do detentor é o que aponta para você:

```console
> dumpobj 00007F69D0033570
Name:        MyApi.Telemetry.TelemetryBus
MethodTable: 00007f6c20a67498
Size:        24(0x18) bytes
Fields:
              MT    Field   Offset                 Type VT     Attr            Value Name
00007f6c1dc00f90  4000001        8 ...EventHandler`1  0 instance 00007F69D0033588 MetricRecorded
```

## Armadilhas que custam uma tarde

**O gcdump dispara uma coleta de gen2 completa e bloqueante.** É assim que ele percorre o heap. Em um processo com heap grande isso pode suspender o runtime por bastante tempo. Não rode isso em um laço apertado contra uma instância de produção sensível a latência, e espere um pico visível de pausa nas suas métricas quando rodar.

**O gcdump pode falhar silenciosamente em um heap enorme.** O buffer de eventos pertence à aplicação alvo e pode crescer até 256 MB. Se o heap for grande o suficiente para eventos serem descartados, você recebe `System.ApplicationException: ETL file shows the start of a heap dump but not its completion`, ou um `.gcdump` que contém silenciosamente só parte do heap. Quando isso acontecer, pule o gcdump e vá direto para `dotnet-dump collect`.

**As duas ferramentas precisam do mesmo usuário e do mesmo `TMPDIR`.** No Linux e no macOS, `--process-id` e `--name` funcionam conectando a um socket de domínio Unix que o runtime cria dentro do `TMPDIR`. Se a sua ferramenta roda como outro usuário, ou sob um `TMPDIR` diferente, o comando simplesmente expira depois de 30 segundos sem nenhum erro útil. Rode como o mesmo usuário do processo alvo ou como root.

**Em contêineres você precisa de `ptrace`.** O `dotnet-dump collect` exige capacidades de `ptrace`, geralmente concedidas com `--cap-add=SYS_PTRACE`. Separadamente, coletar um dump de heap ou completo força o sistema operacional a paginar muita memória virtual do processo alvo, o que pode empurrar um contêiner com limite de memória para além do seu limite de cgroup e fazer com que ele seja morto por OOM no meio da coleta. Aumente ou remova temporariamente o limite se a sua plataforma permitir.

**Linhas `Free` não são objetos.** Uma contagem alta de `Free` no `dumpheap -stat` significa fragmentação, não vazamento. É espaço entre objetos vivos que o GC não compactou, tipicamente no LOH. Problema diferente, solução diferente (pooling, `ArrayPool<T>`, ou `GCSettings.LargeObjectHeapCompactionMode`).

**Vazamentos com cara de cache podem ser bug de configuração, não de código.** Se o tipo que cresce é um DTO seu dentro de um `IMemoryCache`, o "vazamento" normalmente é um limite de tamanho ou uma política de expiração faltando, e não uma referência rebelde. Essa decisão pertence [à comparação entre HybridCache, IMemoryCache e IDistributedCache](/pt-br/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/), não a um depurador.

**Cheque a fila de finalização antes de culpar o seu código.** O `finalizequeue` no shell de análise lista os objetos registrados para finalização. Uma fila entupida significa que objetos finalizáveis estão sendo promovidos para gen2 e retidos por um ciclo de coleta extra, o que parece exatamente um vazamento lento em um gráfico. Ali a solução quase sempre é descartar de forma determinística, que é justamente para o que serve [implementar IAsyncDisposable e usar await using](/pt-br/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/).

**Máquinas de estado assíncronas escondem as próprias raízes.** Se os tipos que crescem são structs geradas pelo compilador do tipo `<SomeMethod>d__12`, use `dumpasync -roots` em vez de `gcroot`. Ele entende cadeias de continuação e vai mostrar qual tarefa aguardando está segurando a máquina, algo que um percurso cru de `gcroot` apresenta como uma pilha ilegível de objetos `Task` e `Action`.

## O que fazer com a resposta

Assim que o `gcroot` nomeia o detentor, a correção é código comum. Cancele a assinatura em um `Dispose`. Coloque um limite de tamanho e uma expiração no cache. Pare de capturar um serviço com escopo dentro de um singleton e, em vez disso, [crie um escopo por unidade de trabalho dentro do BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/). Depois repita os passos 1 a 4: rode sob carga, tire dois gcdumps e confirme que a contagem do tipo está estável. Um vazamento só está corrigido quando o segundo gcdump prova isso.

Fontes: [referência do dotnet-gcdump](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-gcdump), [referência do dotnet-dump](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dump), [tutorial de depuração de vazamento de memória](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-memory-leak), [extensão de depuração SOS](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/sos-debugging-extension) e [referência do dotnet-counters](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-counters).
