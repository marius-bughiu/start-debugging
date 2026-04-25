---
title: "Flutter: Droido 1.2.0 é um inspetor de rede só em debug com impacto zero no release"
description: "Droido 1.2.0 chegou em 8 de fevereiro de 2026 como um inspetor de rede só em debug para Flutter. A parte interessante não é a UI. É a história de empacotamento: manter um inspetor moderno em builds de debug enquanto garante que builds de release permaneçam limpos, pequenos e não afetados."
pubDate: 2026-02-08
tags:
  - "flutter"
  - "dart"
  - "debugging"
  - "networking"
lang: "pt-br"
translationOf: "2026/02/flutter-droido-1-2-0-debug-only-network-inspector-with-zero-release-impact"
translatedBy: "claude"
translationDate: 2026-04-25
---

Droido **1.2.0** foi entregue hoje (8 de fevereiro de 2026) como um inspetor de rede **só em debug** para **Flutter 3.x**. Ele afirma suporte ao **Dio**, ao pacote `http`, e clientes estilo Retrofit, além de uma notificação de debug persistente e uma UI moderna.

A parte que vale a pena escrever é a restrição: tornar o debugging mais fácil sem pagar por ele em builds de release. Se você está entregando apps Flutter em escala, "é só uma ferramenta de dev" não é desculpa para dependências acidentais em produção, inicialização extra, ou binários maiores.

## O único contrato aceitável: ferramentas de debug devem desaparecer em release

No Flutter, o padrão mais limpo é inicializar código só de dev dentro de um bloco `assert`. `assert` é removido no modo release, então o caminho de código (e geralmente os imports transitivos) se torna irrelevante para o build de release.

Aqui está um template mínimo que você pode usar em qualquer app Flutter 3.x, independente de qual inspetor você plugar:

```dart
import 'package:dio/dio.dart';

// Keep this in a separate file if you want even stronger separation.
void _enableDebugNetworkInspector(Dio dio) {
  // Add your debug-only interceptors or inspector initialization here.
  // Example (generic):
  // dio.interceptors.add(LogInterceptor(requestBody: true, responseBody: true));
  //
  // For Droido specifically, replace this comment with the package's setup call.
}

Dio createDio() {
  final dio = Dio();

  assert(() {
    _enableDebugNetworkInspector(dio);
    return true;
  }());

  return dio;
}
```

Isso te compra três coisas:

- **Sem efeitos colaterais em produção**: o inspetor não é inicializado em release.
- **Menos risco durante refatorações**: é difícil acidentalmente manter um hook só de dev habilitado.
- **Um lugar previsível para conectar clientes**: você pode aplicar isto ao `Dio`, `http.Client`, ou um wrapper Retrofit gerado, contanto que você seja dono da factory.

## O que eu verificaria antes de adotar o Droido

A promessa "impacto zero em builds de release" é específica o suficiente para você poder validar:

- **Saída do build**: compare o tamanho do `flutter build apk --release` e a árvore de dependências antes e depois.
- **Runtime**: confirme que o código do inspetor nunca é referenciado quando `kReleaseMode` é true (o padrão `assert` força isto).
- **Pontos de intercepção**: verifique que ele se acopla onde seu app realmente envia tráfego (Dio vs `http` vs clientes gerados).

Se o Droido se sustentar, este é o tipo de ferramenta que melhora o debugging do dia a dia sem se tornar um imposto de manutenção a longo prazo.

Fontes:

- [Droido no pub.dev](https://pub.dev/packages/droido)
- [Repositório do Droido](https://github.com/kapdroid/droido)
- [Thread no Reddit](https://www.reddit.com/r/FlutterDev/comments/1qz40ye/droido_a_debugonly_network_inspector_for_flutter/)
