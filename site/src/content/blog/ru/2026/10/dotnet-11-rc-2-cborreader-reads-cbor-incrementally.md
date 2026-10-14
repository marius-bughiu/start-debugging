---
title: ".NET 11 RC 2: CborReader умеет разбирать данные по частям"
description: "System.Formats.Cbor 11.0.0-rc.2 добавляет в CborReader isFinalBlock, NeedsMoreData и SlideData, так что CBOR можно декодировать прямо из потока, не буферизуя весь документ. Проверено на SDK 11.0.100-rc.2."
pubDate: 2026-10-14
tags:
  - "dotnet-11"
  - "csharp"
  - "cbor"
  - "dotnet"
lang: "ru"
translationOf: "2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally"
translatedBy: "claude"
translationDate: 2026-10-14
---

[.NET 11 Release Candidate 2](https://github.com/dotnet/core/discussions/10644) вышел 13 октября 2026 года. Это второй и последний RC с лицензией go-live. Заметки о библиотеках начинаются с изменения, которое важно всем, кто декодирует CBOR из сокета, канала или большого файла: `CborReader` из `System.Formats.Cbor` теперь умеет читать данные, поступающие частями, и больше не требует весь документ одним непрерывным `ReadOnlyMemory<byte>` ([dotnet/runtime#134374](https://github.com/dotnet/runtime/pull/134374), бэкпорт [#133602](https://github.com/dotnet/runtime/pull/133602)).

## Почему старый читатель требовал полный буфер

До сих пор `CborReader` исходил из того, что ему отдан документ целиком. Если WebAuthn attestation, сообщение COSE или ответ CTAP2 приходили по сети, их сначала читали в байтовый массив полностью. Для нескольких сотен байт это нормально. Для многомегабайтных CBOR-журналов или долгоживущего потока CBOR-записей это означает выделение памяти размером с весь payload и невозможность начать обработку, пока не придёт последний байт.

## Три новые части API

Пакет RC 2 (`System.Formats.Cbor` 11.0.0-rc.2.26504.105) добавляет:

- Перегрузку конструктора `CborReader(ReadOnlyMemory<byte> data, CborReaderOptions? options, bool isFinalBlock)`.
- Новое значение `CborReaderState.NeedsMoreData`, которое возвращает `PeekState()`, когда следующий элемент оборван.
- `SlideData(ReadOnlyMemory<byte> data, bool isFinalBlock)` для передачи читателю следующего буфера, а также `Reset(data, isFinalBlock)` и не бросающие исключений `TrySkipValue` / `TrySkipToParent`.

Есть одно жёсткое требование: инкрементальный режим работает только с `CborConformanceMode.Lax`. Передача `isFinalBlock: false` вместе с `Strict` бросает `ArgumentException: Reading CBOR data incrementally is only supported in the 'Lax' conformance mode.`

## Чтение из Stream

Официальный пример заканчивается на "buffer management omitted". Недостающая часть на вашей стороне: `SlideData` заменяет буфер, поэтому байты, которые читатель ещё не обработал, нужно перенести в следующий. Сколько их, говорит `BytesRemaining`:

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

Я запустил этот код на SDK 11.0.100-rc.2.26504.105 с массивом в 10 003 байта, содержащим 1000 текстовых строк. Он вернул все 1000. Уменьшение чанка до 7 байт тоже декодировало все элементы, при этом было сделано 1428 вызовов `SlideData`. Старт с пустого буфера тоже работает: первый `PeekState()` просто сообщает `NeedsMoreData`. В production `next` стоит брать из `ArrayPool<byte>`, а не выделять заново на каждый чанк.

## Всегда вызывайте Peek перед чтением

Сигнал о возможности продолжить даёт только `PeekState()`. Если вызвать `ReadTextString()` напрямую на оборванном элементе, вы получите `CborContentException: Declared definite length of CBOR data item exceeds available buffer size`, а не вежливое "нужно больше данных". В инкрементальном режиме проверяйте `PeekState()` перед каждым чтением, а если нужно просто пропустить элементы, используйте `TrySkipValue`.

У RC 2 есть лицензия go-live, поэтому уже сейчас это можно использовать в production, а GA ожидается в ноябре. Если вы следите за релизом, предыдущее изменение в библиотеках, которое я разбирал, это [сигналы процессов в RC 1](/ru/2026/09/dotnet-11-rc-1-process-signal-exit-status/).
