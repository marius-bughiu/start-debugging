---
title: "Provider vs Riverpod vs Bloc para gerenciamento de estado no Flutter em 2026"
description: "Escolha Riverpod para a maioria dos apps Flutter novos em 2026. Opte por Bloc quando uma equipe grande quer uma estrutura baseada em eventos, e mantenha Provider apenas para código legado."
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "bloc"
lang: "pt-br"
translationOf: "2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026"
translatedBy: "claude"
translationDate: 2026-06-04
---

Se você vai começar um app Flutter novo em 2026 e não consegue decidir entre Provider, Riverpod e Bloc, a resposta curta é Riverpod. Com o Riverpod 3.3.1 (a linha 3.0 saiu em 2025-09-10) ele é seguro em tempo de compilação, testável sem um `BuildContext`, e o caminho de geração de código elimina quase todo o boilerplate que costumava ser o principal argumento contra ele. Recorra ao Bloc (`flutter_bloc` 9.1.1) quando você tiver uma equipe grande que se beneficia de um contrato estrito baseado em eventos e de um histórico de estado rastreável. Mantenha o Provider (6.1.5) apenas se você já o tem em uma base de código ou se está ensinando a alguém o modelo subjacente de `InheritedWidget`. Todos os exemplos aqui usam Flutter 3.44 e Dart 3.12.

## Os três pacotes não são o mesmo tipo de ferramenta

Antes de compará-los, ajuda perceber que essas bibliotecas resolvem problemas que se sobrepõem, mas são diferentes.

Provider é um wrapper fino e bem-feito sobre o próprio `InheritedWidget` do Flutter. Ele faz injeção de dependência e propagação de reconstruções, e é basicamente isso. A classe de estado costuma ser um `ChangeNotifier` que você escreve à mão. É o pacote que a documentação oficial do Flutter usou quando precisou de um exemplo didático, razão pela qual tantos tutoriais o utilizam.

Riverpod é o que o autor do Provider construiu em seguida, especificamente para corrigir os problemas estruturais do Provider: a `ProviderNotFoundException` em tempo de execução, a dependência da posição do widget na árvore e a impossibilidade de ler o estado a partir de Dart puro. Os providers do Riverpod vivem fora da árvore de widgets, então são alcançáveis de qualquer lugar e resolvidos em tempo de compilação.

Bloc é um padrão primeiro e um pacote depois. Ele empurra você a modelar cada mudança como um evento explícito que flui para um componente e produz um novo estado imutável. Essa cerimônia é justamente o ponto: em uma equipe grande, um pipeline forçado `Event -> Bloc -> State` torna o comportamento previsível e revisável.

## Matriz de recursos

| Recurso | Provider 6.1.5 | Riverpod 3.3.1 | Bloc 9.1.1 |
| --- | --- | --- | --- |
| Modelo mental | `InheritedWidget` + `ChangeNotifier` | Providers fora da árvore | Baseado em eventos, estados imutáveis |
| Segurança em tempo de compilação | Não (busca em tempo de execução) | Sim | Sim |
| Precisa de `BuildContext` para ler | Sim | Não | Não (via `context.read` ou direto) |
| Boilerplate | Baixo | Baixo com codegen | Alto |
| Testabilidade | Requer montar o widget | Dart puro, sem árvore de widgets | Dart puro, helpers `bloc_test` |
| Estado async / de carregamento | Manual | `AsyncValue`, integrado | Estados manuais ou `emit` |
| Retentativa automática em falhas | Não | Sim (desde a 3.0) | Não |
| Rastreabilidade do estado | Fraca | Média | Forte (cada transição observável) |
| Curva de aprendizado | Suave | Moderada | Íngreme |
| Melhor encaixe | Legado, tutoriais | Maioria dos apps novos | Equipes grandes, fluxos complexos |

A linha mais importante é "segurança em tempo de compilação". Um Provider mal configurado lança `ProviderNotFoundException` em tempo de execução, frequentemente só na tela onde ele está faltando. Riverpod e Bloc trazem à tona essa classe de erro antes de o app rodar.

## O mesmo contador nos três

Um contador é pequeno o suficiente para comparar a ergonomia diretamente. Repare em quanto código cada um precisa e onde o estado vive.

### Provider

```dart
// Flutter 3.44, provider 6.1.5
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class CounterModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  void increment() {
    _count++;
    notifyListeners();
  }
}

// Register it above the widgets that need it.
ChangeNotifierProvider(
  create: (_) => CounterModel(),
  child: const CounterPage(),
);

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    final count = context.watch<CounterModel>().count;
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.read<CounterModel>().increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

Repare na dependência de `context`. Se `CounterPage` for renderizado sem um `ChangeNotifierProvider` acima dele, `context.watch<CounterModel>()` lança em tempo de execução.

### Riverpod

```dart
// Flutter 3.44, flutter_riverpod 3.3.1, riverpod_annotation
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => ref.read(counterProvider.notifier).increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

O `counterProvider` é gerado e acessível globalmente. Não há posição na árvore para errar, e `ref` é resolvido em tempo de compilação. Envolva o app uma vez em `ProviderScope` e pronto.

### Bloc

```dart
// Flutter 3.44, flutter_bloc 9.1.1, equatable
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

// Events
sealed class CounterEvent {}
class Increment extends CounterEvent {}

// Bloc: Event in, int state out.
class CounterBloc extends Bloc<CounterEvent, int> {
  CounterBloc() : super(0) {
    on<Increment>((event, emit) => emit(state + 1));
  }
}

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => CounterBloc(),
      child: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: BlocBuilder<CounterBloc, int>(
              builder: (context, count) => Text('$count'),
            ),
          ),
          floatingActionButton: FloatingActionButton(
            onPressed: () => context.read<CounterBloc>().add(Increment()),
            child: const Icon(Icons.add),
          ),
        ),
      ),
    );
  }
}
```

Bloc é o mais verboso para um contador, e essa comparação é injusta com ele: o valor do Bloc aparece quando há vinte eventos e dez estados, não um. O evento `Increment` é um registro no histórico do seu app. Com um `BlocObserver` anexado você pode registrar cada transição, que é exatamente o que você quer ao depurar uma tela complexa.

## Quando escolher Riverpod

- **Um app novo em 2026 sem restrições de legado.** Esta é a opção padrão. Riverpod te dá segurança em tempo de compilação, testes sem `pumpWidget` e tratamento de async através de `AsyncValue` já de fábrica. Veja nosso passo a passo sobre [estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) para ver como o async fica limpo.
- **Você lê o estado fora dos widgets.** Uma sincronização em segundo plano, uma camada de repositório ou um serviço que precisa do token de auth atual podem chamar `ref.read` sem um `BuildContext`. Provider não consegue fazer isso de forma limpa.
- **Você quer resiliência para providers de rede instáveis.** O Riverpod 3.0 adicionou retentativa automática com backoff exponencial (200ms dobrando até 6.4s) para providers que falham durante a inicialização, além da pausa automática dos listeners quando um widget sai da tela.
- **Você está migrando do GetX ou similar.** Riverpod é o destino habitual. Nosso [guia de migração do GetX para o Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) cobre as peças em movimento.

Uma ressalva: no Riverpod 3.0, `StateProvider`, `StateNotifierProvider` e `ChangeNotifierProvider` foram movidos para `package:riverpod/legacy.dart`. Código novo deve usar as classes `Notifier` e `AsyncNotifier` mostradas acima, idealmente com geração de código via `@riverpod`.

## Quando escolher Bloc

- **Uma equipe grande que quer um contrato forçado.** Quando cinco pessoas mexem no mesmo recurso, o fluxo rígido `Event -> Bloc -> State` impede que cada uma invente seu próprio padrão. A estrutura é o que se entrega.
- **Você precisa de um histórico de estado auditável.** Um `BlocObserver` vê cada transição. Para fluxos como checkout, onboarding ou um formulário de várias etapas, reproduzir a sequência exata de eventos que produziu um bug vale o boilerplate.
- **Lógica async complexa e ramificada.** Os transformadores de eventos do Bloc (debounce, throttle, `droppable`, `concurrent`) te dão controle fino sobre como eventos sobrepostos são tratados. Isso é mais difícil de expressar nos outros dois.
- **Você quer `Cubit` para os casos simples.** Nem toda tela precisa de eventos completos. Um `Cubit` é um Bloc sem a camada de eventos: você chama métodos que fazem `emit` de novo estado diretamente, então pode misturar Cubits leves e Blocs completos no mesmo app.

## Quando escolher Provider

- **Você já o tem.** Um app que funciona com Provider não precisa de uma reescrita. Não há nada de errado com `ChangeNotifier` para estado de app que não seja crítico em desempenho.
- **Você está ensinando os fundamentos.** Provider mapeia quase um para um sobre `InheritedWidget`, então é a forma mais clara de mostrar a alguém como o Flutter propaga estado sem uma abstração de terceiros.
- **Um app genuinamente minúsculo.** Uma única tela de configurações com um interruptor não justifica geração de código nem um pipeline de eventos.

O que o Provider não deveria ser em 2026 é a opção padrão para um app novo e não trivial. O modelo de busca em tempo de execução é exatamente o problema que o Riverpod foi construído para eliminar.

## As pegadinhas que decidem por você

Algumas restrições se sobrepõem à preferência pessoal.

**Ler o estado a partir de código que não é widget.** Se a sua arquitetura tem uma camada de serviço ou repositório que precisa ler o estado do app diretamente, o Provider está praticamente fora. Ele precisa de um `BuildContext`. Riverpod e Bloc permitem ler o estado a partir de Dart puro, o que geralmente resolve a decisão sozinho.

**Tamanho da equipe e cultura de revisão.** Em um projeto solo ou em uma equipe pequena, a cerimônia do Bloc é atrito com pouco retorno, e o Riverpod ganha em velocidade. Em uma equipe de 15 pessoas onde a consistência entre recursos importa mais que linhas de código, a rigidez do Bloc é um recurso, não um custo.

**Disciplina de estado imutável.** Tanto o Bloc quanto o Riverpod moderno empurram você para objetos de estado imutáveis. Se a sua equipe está confortável com classes seladas e igualdade por valor (veja [Dart records vs classes Freezed](/pt-br/2026/05/dart-records-vs-freezed-classes/) para as opções de modelagem), ambos encaixam. Se você tem uma base de código grande construída sobre objetos `ChangeNotifier` mutáveis, o caminho mais barato pode ser ficar no Provider até que um recurso realmente precise de mais.

**Padrões async existentes.** O `AsyncValue` do Riverpod é a forma de menor esforço para renderizar carregamento, dados e erro a partir de uma única fonte da verdade. Se as suas telas são em sua maioria buscas de dados async, isso sozinho já é uma razão forte para escolhê-lo.

## A recomendação, repetida

Para a maioria dos apps Flutter novos em 2026, use Riverpod 3.3.1 com geração de código. Você obtém segurança em tempo de compilação, leituras sem contexto, async de primeira classe e os recursos de resiliência da 3.0, a um custo de boilerplate que o codegen aproxima do Provider.

Escolha Bloc 9.1.1 quando uma estrutura forçada baseada em eventos e um histórico de estado totalmente rastreável valerem mais para a sua equipe do que a concisão, o que costuma ser verdade em equipes grandes e fluxos complexos. Use Cubits dentro de um app Bloc para as telas que não precisam de eventos completos.

Mantenha o Provider 6.1.5 para apps legados, ensino e telas triviais, mas não o escolha por padrão em um projeto novo e não trivial. A pergunta decisiva raramente é "qual tem o contador mais bonito", é "eu leio estado fora dos widgets, qual o tamanho da minha equipe e quanto async eu tenho?". Responda essas três e a escolha geralmente se faz sozinha. Se você está pesando o Flutter contra outras stacks por completo, nossa [comparação de Flutter vs React Native vs MAUI](/pt-br/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) afasta a câmera um nível. E qualquer que seja a sua escolha, lembre-se de [liberar os seus controllers](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/), porque nenhuma biblioteca de gerenciamento de estado vai limpá-los por você.

## Fontes

- [Riverpod: novidades da 3.0](https://riverpod.dev/docs/whats_new) - APIs legadas, retentativa automática, pausa/retomada, persistência offline, mutações.
- [flutter_riverpod no pub.dev](https://pub.dev/packages/flutter_riverpod) e [changelog](https://pub.dev/packages/flutter_riverpod/changelog) - versão 3.3.1, 3.0.0 lançada em 2025-09-10.
- [flutter_bloc no pub.dev](https://pub.dev/packages/flutter_bloc) - versão 9.1.1, BlocProvider / BlocBuilder / BlocListener, Cubit vs Bloc.
- [provider no pub.dev](https://pub.dev/packages/provider) - versão 6.1.5, ChangeNotifierProvider, Flutter Favorite.
- [Notas de versão do Flutter](https://docs.flutter.dev/release/release-notes) - Flutter 3.44 estável, Dart 3.12.
