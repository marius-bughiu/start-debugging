---
title: ".NET 11 RC 2 permite que o CborReader processe um payload um pedaço por vez"
description: "System.Formats.Cbor 11.0.0-rc.2 adiciona isFinalBlock, NeedsMoreData e SlideData ao CborReader, para que você decodifique CBOR direto de um stream sem armazenar o documento inteiro em buffer. Verificado no SDK 11.0.100-rc.2."
pubDate: 2026-10-14
tags:
  - "dotnet-11"
  - "csharp"
  - "cbor"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally"
translatedBy: "claude"
translationDate: 2026-10-14
---

O [.NET 11 Release Candidate 2](https://github.com/dotnet/core/discussions/10644) foi lançado em 2026-10-13, o segundo e último RC com licença go-live. As notas de bibliotecas abrem com uma mudança que importa para quem decodifica CBOR vindo de um socket, de um pipe ou de um arquivo grande: o `CborReader` em `System.Formats.Cbor` agora consegue ler um payload entregue em pedaços, em vez de exigir o documento inteiro em um único `ReadOnlyMemory<byte>` contíguo ([dotnet/runtime#134374](https://github.com/dotnet/runtime/pull/134374), um backport de [#133602](https://github.com/dotnet/runtime/pull/133602)).

## Por que o leitor antigo exigia o buffer completo

Até agora, o `CborReader` assumia que era dono do documento completo. Se uma attestation WebAuthn, uma mensagem COSE ou uma resposta CTAP2 chegava pela rede, você lia tudo para um array de bytes primeiro. Para algumas centenas de bytes isso é aceitável. Para logs CBOR de vários megabytes ou um stream longo de registros CBOR, significa uma alocação do tamanho do payload e nenhuma forma de começar o trabalho antes de o último byte chegar.

## As três peças novas

O pacote do RC 2 (`System.Formats.Cbor` 11.0.0-rc.2.26504.105) adiciona:

- Uma sobrecarga de construtor `CborReader(ReadOnlyMemory<byte> data, CborReaderOptions? options, bool isFinalBlock)`.
- Um novo valor `CborReaderState.NeedsMoreData`, retornado por `PeekState()` quando o próximo item está cortado.
- `SlideData(ReadOnlyMemory<byte> data, bool isFinalBlock)` para entregar ao leitor o próximo buffer, além de `Reset(data, isFinalBlock)` e dos métodos `TrySkipValue` / `TrySkipToParent`, que não lançam exceção.

Há um requisito rígido: o modo incremental só funciona com `CborConformanceMode.Lax`. Passar `isFinalBlock: false` com `Strict` lança `ArgumentException: Reading CBOR data incrementally is only supported in the 'Lax' conformance mode.`

## Lendo de um Stream

O exemplo oficial para em "buffer management omitted". A parte que você precisa fornecer é que `SlideData` substitui o buffer, então os bytes que o leitor ainda não consumiu precisam ser levados para o próximo. `BytesRemaining` diz quantos são:

```csharp
static async Task<int> ReadAllStringsAsync(Stream stream)
{
    var options = new CborReaderOptions { ConformanceMode = CborConformanceMode.Lax };
    byte[] chunk = new byte[4096];
    ReadOnlyMemory<byte> buffer = ReadOnlyMemory<byte>.Empty;
    var reader = new CborReader(buffer, options, isFinalBlock: false);
    int count = 0;

    while (true)
    {
        switch (reader.PeekState())
        {
            case CborReaderState.NeedsMoreData:
                int read = await stream.ReadAsync(chunk);
                // Keep the bytes the reader has not consumed yet, then append the new chunk.
                ReadOnlyMemory<byte> unread = buffer[^reader.BytesRemaining..];
                byte[] next = new byte[unread.Length + read];
                unread.CopyTo(next);
                chunk.AsSpan(0, read).CopyTo(next.AsSpan(unread.Length));
                buffer = next;
                reader.SlideData(buffer, isFinalBlock: read == 0);
                break;
            case CborReaderState.StartArray: reader.ReadStartArray(); break;
            case CborReaderState.EndArray: reader.ReadEndArray(); break;
            case CborReaderState.TextString: reader.ReadTextString(); count++; break;
            case CborReaderState.Finished: return count;
            default: reader.SkipValue(); break;
        }
    }
}
```

Executei isso no SDK 11.0.100-rc.2.26504.105 contra um array de 10.003 bytes com 1.000 strings de texto. Ele retornou as 1.000. Reduzir o chunk para 7 bytes ainda decodificou todos os itens, com 1.428 chamadas a `SlideData` pelo caminho. Começar de um buffer vazio também funciona: o primeiro `PeekState()` simplesmente reporta `NeedsMoreData`. Em produção, você alugaria `next` de `ArrayPool<byte>` em vez de alocar a cada chunk.

## Sempre faça peek antes de ler

O sinal de retomada vem apenas de `PeekState()`. Se você chamar `ReadTextString()` diretamente em um item truncado, recebe `CborContentException: Declared definite length of CBOR data item exceeds available buffer size`, e não um educado "preciso de mais dados". Trate `PeekState()` como a porta de entrada de toda leitura no modo incremental, ou use `TrySkipValue` quando você só quer passar por cima dos itens.

O RC 2 tem licença go-live, então já dá para usar em produção hoje, com a GA esperada para novembro. Se você está acompanhando o release, a mudança anterior em bibliotecas que cobri foi [os sinais de Process no RC 1](/pt-br/2026/09/dotnet-11-rc-1-process-signal-exit-status/).
