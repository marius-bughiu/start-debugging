---
title: "Correção: Unhandled Exception: FormatException: Unexpected character ao fazer parse de JSON em Dart"
description: "A correção em 30 segundos: o corpo da resposta não é o JSON que você acha. Imprima os bytes brutos, decodifique com utf8.decode(response.bodyBytes) e nunca passe uma página HTML de erro ou uma string com BOM para jsonDecode."
pubDate: 2026-05-17
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "json"
  - "http"
lang: "pt-br"
translationOf: "2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart"
translatedBy: "claude"
translationDate: 2026-05-17
---

A correção em uma frase: `jsonDecode` não falhou no seu JSON. Falhou em algo que não é JSON, dentro do corpo que você passou. Nove em cada dez vezes, o corpo é uma página HTML de erro da sua API, um BOM UTF-8 antes de um JSON válido, uma resposta HTTP decodificada com o charset errado, ou uma string `null` ou vazia de uma requisição que o servidor já rejeitou. Imprima os primeiros 80 bytes do corpo, decodifique os bytes com `utf8.decode(response.bodyBytes)` em vez de deixar o `package:http` adivinhar o charset, e adicione uma verificação de status code antes de chamar `jsonDecode`.

```text
Unhandled Exception: FormatException: Unexpected character (at character 1)
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Error</title>...
^

#0      _ChunkedJsonParser.fail (dart:convert-patch/convert_patch.dart:1452:5)
#1      _ChunkedJsonParser.parseNumber (dart:convert-patch/convert_patch.dart:1319:9)
#2      _ChunkedJsonParser.parse (dart:convert-patch/convert_patch.dart:907:22)
#3      _parseJson (dart:convert-patch/convert_patch.dart:41:10)
#4      JsonDecoder.convert (dart:convert/json.dart:613:36)
#5      JsonCodec.decode (dart:convert/json.dart:175:41)
#6      jsonDecode (dart:convert/json.dart:96:10)
```

Este guia foi escrito contra Dart 3.7 (canal estável em maio de 2026), Flutter 3.27 e `package:http` 1.5.0. O comportamento descrito aqui é o mesmo desde Dart 2.12 e a introdução do null safety. A API `jsonDecode` vive em `dart:convert`; o parser que lança a exceção é `_ChunkedJsonParser` no SDK em [sdk/lib/_internal/vm/lib/convert_patch.dart](https://github.com/dart-lang/sdk/blob/main/sdk/lib/_internal/vm/lib/convert_patch.dart).

## Por que esse erro quase sempre é diagnosticado errado

`FormatException: Unexpected character` do `dart:convert` é uma mensagem precisa. O parser encontrou um byte que não conseguiu combinar com nenhum token JSON válido em um offset específico, e lançou a exceção com esse offset no campo `offset` do [FormatException](https://api.dart.dev/stable/dart-core/FormatException-class.html). O offset é o único número que importa na mensagem, e a maioria dos desenvolvedores o ignora.

- `at character 0` ou `at character 1`: o primeiro byte está errado. Você está olhando para `<!DOCTYPE html>` (uma página de erro), um BOM UTF-8 (`0xEF 0xBB 0xBF`), uma string vazia, ou um envelope JSON entre aspas ("\"{...}\"").
- `at character 2` até `at character 5` em um corpo que parece bom no depurador: incompatibilidade de codificação. O `package:http` decodificou os bytes como Latin-1 porque o servidor não enviou `charset=utf-8` no `Content-Type`, e o primeiro byte não-ASCII explodiu.
- `at character N` com N no meio do corpo: JSON realmente malformado vindo do servidor, ou uma string concatenada com lixo (muito comum com proxies de log que prefixam um banner).

Você não pode diagnosticar isso sem olhar para os bytes. Recorrer a `try / catch` em torno de `jsonDecode` é correto como camada final, mas esconde a falha real: você está deixando entrada não validada chegar ao parser.

## Um repro mínimo que você pode colar em um arquivo Dart

```dart
// Dart 3.7, package:http 1.5.0
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<Map<String, dynamic>> fetchUser(String id) async {
  final response = await http.get(Uri.parse('https://api.example.com/users/$id'));
  return jsonDecode(response.body) as Map<String, dynamic>;
}
```

Essa é a forma do código que lança o erro em 90% dos relatos de bug reais. Existem quatro modos de falha independentes escondidos nessas três linhas:

1. O servidor retornou `404` com um corpo HTML. `jsonDecode("<!DOCTYPE...")` falha no caractere 0.
2. O servidor retornou `200` mas com `Content-Type: application/json; charset=utf-8` e um BOM no início. `jsonDecode("﻿{...}")` falha no caractere 0.
3. O servidor retornou `200` com `Content-Type: application/json` (sem charset). O `package:http` cai para `latin-1`, então o nome acentuado do usuário vira mojibake e o decodificador JSON ainda funciona, até que seus dados tenham uma sequência de bytes que pareça um caractere de controle, e aí ele lança a exceção.
4. O servidor retornou um corpo vazio em `204 No Content`, mas o ponto de chamada tratou como JSON.

Mesmo tipo de exceção, quatro causas raiz, quatro correções diferentes.

## A correção, em ordem de quão frequentemente é a resposta

### 1. Imprima o corpo antes de decodificar

Isso não é opcional. Antes de mudar qualquer código, imprima os primeiros 200 caracteres e o tamanho:

```dart
// Dart 3.7
import 'dart:convert';
import 'package:http/http.dart' as http;

final response = await http.get(uri);
final preview = response.body.length > 200
    ? '${response.body.substring(0, 200)}...'
    : response.body;
print('status=${response.statusCode} '
      'len=${response.bodyBytes.length} '
      'content-type=${response.headers['content-type']}');
print('body[0..200]=$preview');
print('first-bytes=${response.bodyBytes.take(8).toList()}');
```

Os primeiros oito bytes contam tudo. `[60, 33, 68, 79, 67, 84, 89, 80]` é `<!DOCTYP` e você está olhando para uma página HTML de erro. `[239, 187, 191, 123, ...]` começa com o BOM UTF-8. `[123, 34, ...]` (`{"`) é JSON real. Imprima isso uma vez e você saberá qual correção abaixo aplicar.

### 2. Verifique o status code antes de decodificar

```dart
// Dart 3.7, package:http 1.5.0
final response = await http.get(uri);

if (response.statusCode != 200) {
  throw HttpException(
    'GET $uri returned ${response.statusCode}: ${response.body}',
  );
}
if (response.bodyBytes.isEmpty) {
  throw const FormatException('Empty body where JSON was expected');
}

final data = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
```

Isso lida com os casos 1 e 4 da lista do repro. Um `404` com corpo HTML nunca chega a `jsonDecode`, e um `204` sem corpo lança um erro mais claro apontando para o problema real.

### 3. Decodifique os bytes com `utf8.decode`, não `response.body`

`response.body` no `package:http` passa os bytes pelo charset que o servidor declarou, e cai para `latin-1` quando nada é declarado. Esse fallback é a origem da maioria dos bugs do tipo "o JSON parecia bem no Postman, mas meu app crasha". Sempre vá por `utf8.decode(response.bodyBytes)` se você sabe que a API fala JSON:

```dart
// Dart 3.7
final text = utf8.decode(response.bodyBytes);
final data = jsonDecode(text) as Map<String, dynamic>;
```

Para APIs que realmente variam sua codificação, faça parse do header `Content-Type` e escolha o codec certo, mas o padrão correto para JSON sobre HTTP é UTF-8: a [RFC 8259 seção 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1) exige isso. O getter `body` existe porque a especificação HTTP permite outras codificações; JSON não.

### 4. Remova o BOM se seu servidor enviar um

Um BOM no início de um stream UTF-8 é legal na especificação Unicode e proibido na [RFC 8259 seção 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1), então os parsers JSON estão certos em rejeitar. Algumas configurações de IIS e um punhado de funções edge de CDN ainda prefixam `0xEF 0xBB 0xBF` em respostas JSON. A correção é de uma linha:

```dart
// Dart 3.7
String stripBom(String s) =>
    s.startsWith('﻿') ? s.substring(1) : s;

final text = stripBom(utf8.decode(response.bodyBytes));
final data = jsonDecode(text);
```

Ou use `utf8.decoder` com `allowMalformed: false` diretamente sobre os bytes depois de cortar o BOM:

```dart
// Dart 3.7
final bytes = response.bodyBytes;
final start = (bytes.length >= 3 &&
        bytes[0] == 0xEF &&
        bytes[1] == 0xBB &&
        bytes[2] == 0xBF)
    ? 3
    : 0;
final data = jsonDecode(utf8.decode(bytes.sublist(start)));
```

A versão em nível de bytes é mais rápida em payloads grandes porque pula a etapa de alocação de string.

### 5. Pare de fazer dupla codificação no servidor

A outra forma comum desse erro é o offset cair profundo em uma string que parece válida:

```text
Unhandled Exception: FormatException: Unexpected character (at character 2)
"{\"id\":42,\"name\":\"Ana\"}"
 ^
```

O corpo é uma string JSON cujo conteúdo é JSON. Em algum lugar no servidor, o objeto JSON foi serializado para string e depois a string foi serializada de novo (`JSON.stringify(JSON.stringify(obj))` em um handler Node Express, ou retornar `Json(json)` em vez de retornar o objeto em ASP.NET Core). A correção em Dart tem a forma certa:

```dart
// Dart 3.7
final outer = jsonDecode(text);
final data = outer is String ? jsonDecode(outer) : outer;
```

Mas marque um TODO para corrigir o servidor. JSON duplamente codificado quebra todo cliente, não só Dart, e a próxima pessoa a chamar esse endpoint vai pagar o mesmo imposto de depuração.

## Como ler o offset e o preview da fonte

A `FormatException` que o Dart lança carrega três propriedades úteis: `message`, `source` e `offset`. Quando você capturar, registre as três:

```dart
// Dart 3.7
try {
  final data = jsonDecode(text);
} on FormatException catch (e) {
  print('JSON parse failed at offset ${e.offset}.');
  if (e.source is String) {
    final src = e.source as String;
    final start = (e.offset ?? 0) - 20;
    final end = (e.offset ?? 0) + 20;
    final window = src.substring(start.clamp(0, src.length), end.clamp(0, src.length));
    print('context: "$window"');
  }
  rethrow;
}
```

Esse é o nível certo de log em qualquer app que consome JSON externo. O `toString()` padrão trunca `source` em cerca de 78 caracteres com `^` abaixo do byte ofensor, o que geralmente basta em payloads pequenos e é inútil em uma resposta de 200KB.

## Armadilhas que parecem um bug de JSON mas não são

### `response.body` retorna `String` mesmo quando o corpo é binário

O getter `body` do `package:http` chama `latin1.decode` quando não há charset, e então seu código chama `jsonDecode` em uma string que não é o que chegou pela rede. Se você realmente precisa do texto bruto, use `response.bodyBytes` e decodifique você mesmo. O mesmo se aplica ao `package:dio`: configure `ResponseType.bytes` ou `ResponseType.plain` se quiser controlar a decodificação.

### `compute(jsonDecode, ...)` engole o offset

No Flutter você frequentemente vê `final data = await compute(jsonDecode, text);` para empurrar o parse para um isolate. Quando o parse falha, a `FormatException` é relançada através do limite do isolate e o campo `source` é descartado. Você verá a mensagem mas não o snippet. Decodifique no isolate principal primeiro para aprender o que está errado, depois volte ao `compute` quando a entrada estiver limpa.

### Um `String?` anulável decodificado com `!` esconde o caso vazio

```dart
final body = response.body;
final data = jsonDecode(body!); // unsafe
```

Se o servidor retornou `204 No Content`, `body` é `''` e `jsonDecode('')` lança `Unexpected end of input`. Use uma verificação explícita `isEmpty`; não confie só no null safety.

### `json.decoder.bind(stream)` reporta offsets relativos ao chunk

Se você faz parse de uma resposta em streaming via `response.stream.transform(utf8.decoder).transform(json.decoder)`, o offset na `FormatException` resultante é local ao chunk que falhou, não ao corpo completo. O issue do Dart [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264) acompanha as arestas aqui. Para JSON em streaming, mude para `package:json_stream_parser` ou faça buffer do corpo antes de decodificar.

### Flutter web no Firefox reporta o erro de forma diferente

No Flutter web, o `JSON.parse` subjacente do JS é chamado. O Firefox lança `SyntaxError: JSON.parse: unexpected character` enquanto o Chrome lança `SyntaxError: Unexpected token`, e o Flutter canaliza ambos via `FormatException`. A correção é a mesma deste guia, mas se você está depurando falhas só na web, reproduza no console do devtools do navegador com a string de resposta crua para ver o erro nativo do navegador primeiro.

## Relacionados

- [Correção: TaskCanceledException: A task was canceled em HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) é o primo .NET de "sua camada HTTP está mentindo para seu parser". Aplica-se a mesma disciplina de diagnóstico.
- [Correção: The JSON value could not be converted to System.DateTime](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) cobre o caso onde o corpo realmente é JSON mas o formato está errado.
- [Correção: A RenderFlex overflowed by N pixels em Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) é o outro erro de Flutter que iniciantes diagnosticam errado; a disciplina de "imprima o estado real primeiro" se aplica do mesmo jeito.
- [Como escrever um isolate Dart para trabalho intensivo em CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) se torna relevante quando seu JSON é grande o bastante para justificar `compute`, depois que você já limpou a entrada.

## Fontes

- [Referência da biblioteca dart:convert](https://api.dart.dev/stable/dart-convert/dart-convert-library.html), que documenta `jsonDecode`, `utf8.decode` e o contrato `JsonDecoder`.
- [Referência da classe FormatException](https://api.dart.dev/stable/dart-core/FormatException-class.html), a doc de API que define `message`, `source` e `offset`.
- [RFC 8259, seção 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1), o texto da especificação JSON que exige UTF-8 na rede e proíbe um BOM.
- [Tratamento de resposta em package:http](https://pub.dev/documentation/http/latest/http/Response/body.html), que detalha o fallback de charset que surpreende a maioria dos chamadores.
- [dart-lang/sdk#46959](https://github.com/dart-lang/sdk/issues/46959), o issue canônico com exemplos da mesma exceção lançada por diferentes entradas do mundo real.
- [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264), acompanhando o comportamento de offset do decoder em chunks citado acima.
