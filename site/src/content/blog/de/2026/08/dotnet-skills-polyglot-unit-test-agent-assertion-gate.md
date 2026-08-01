---
title: "Die beste Idee des neuen .NET-Unit-Test-Agenten ist nicht das Schreiben von Tests"
description: "Am 2026-07-31 hat Microsoft einen polyglotten Unit-Test-Agenten in dotnet/skills veröffentlicht. Interessant ist die verpflichtende Prüfung, die Ihre Assertions per Pseudo-Mutation angreift, bevor der Agent sich für fertig erklären darf."
pubDate: 2026-08-01
tags:
  - "dotnet"
  - "ai-agents"
  - "testing"
  - "github-copilot"
  - "agent-skills"
lang: "de"
translationOf: "2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate"
translatedBy: "claude"
translationDate: 2026-08-01
---

Jeder Coding-Agent generiert bereitwillig Unit-Tests. Das Problem ist nicht, dass er sich weigert, sondern dass am Ende 40 grüne Tests stehen, die `Assert.NotNull(result)` prüfen und selbst dann noch bestehen würden, wenn Sie den Methodenrumpf löschen. Am 2026-07-31 veröffentlichte Amaury Levé [From generated code to trusted code with a unit-test agent](https://devblogs.microsoft.com/dotnet/polyglot-unit-testing-agent/) und damit das Plugin `dotnet-test` in [dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-test). Es zielt genau auf dieses Problem, und der Mechanismus lohnt sich auch dann, wenn Sie das Plugin nie installieren.

## Die Installation braucht zwei Zeilen

Das Plugin läuft über den Marketplace der GitHub Copilot CLI, denselben Verteilungsweg, auf den [der modernize-dotnet-Agent Anfang Juli umgezogen ist](/de/2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin/):

```bash
/plugin marketplace add dotnet/skills
/plugin install dotnet-test@dotnet-agent-skills
```

Obwohl es unter `dotnet/` liegt, ist der Agent polyglott: .NET, Python, TypeScript, JavaScript, Java, Go, Ruby, Rust, Swift, Kotlin, PowerShell und C++. Er beschränkt sich auf Unit-Tests, isoliert den zu testenden Code und mockt externe Dienste. Keine Integrations-, E2E- oder Performance-Tests.

## Die Prüfung, die vor der Erfolgsmeldung läuft

Intern ist `code-testing-generator` ein interner Orchestrator (`user-invocable: false`), der an eine Kette von Subagenten verteilt: Researcher, Planner, Implementer, Builder, Tester, Fixer und Linter. Er wählt je nach Umfang einen von drei Arbeitswegen, und die Empfehlung ist erfreulich konservativ: Die meisten Anfragen sollten den Direct-Weg nehmen und die Pipeline ganz überspringen. Vollständige Zyklen aus Research, Plan und Implement bleiben Fällen vorbehalten, deren Umfang über zusammenhanglose Quelldateien reicht.

Entscheidend ist, was passiert, bevor der Agent fertig sein darf. Für jede nicht triviale Ergänzung (ungefähr fünf Tests oder mehr, oder eine aufgezählte Liste von Verhaltensweisen) ist eine Vorabprüfung verpflichtend, die drei Kontrollen ausführt:

1. **Pseudo-Mutationsanalyse** über den Skill `test-gap-analysis`: Würden diese Assertions tatsächlich fehlschlagen, wenn sich die Implementierung ändert?
2. **Prüfung der Assertion-Tiefe** über `assertion-quality`: Sind die Assertions schwach, fehlend oder tautologisch?
3. **Abgleich von Prompt und Szenarien**: Hat jedes angeforderte Verhalten einen eigenen Test und nicht nur einen zufälligen Treffer?

Das ist der Unterschied zwischen einem Test, den der Compiler akzeptiert, und einem Test, der seinen Platz verdient:

```csharp
// Fails the assertion-quality check: green even if Apply() returns input unchanged
Assert.NotNull(cart.Apply(coupon));

// Survives pseudo-mutation: pins the actual behavior
var result = cart.Apply(coupon);
Assert.Equal(90.00m, result.Total);
Assert.Single(result.AppliedDiscounts, d => d.Code == "SAVE10");
```

Erst danach kompiliert er den gesamten Workspace, führt die komplette Suite aus und prüft, ob die Testerkennung des Repositorys die neuen Tests findet.

## Was die Zahlen sagen

Microsoft nennt eine Abschlussquote von 92,1 % (140 von 152 Aufgaben) gegenüber 78,9 % bei Copilot ohne den Agenten, wobei der Abstand bei vagen Prompts wächst: 88,8 % gegenüber 66,3 %. Die durchschnittliche Aufgabendauer lag bei 359 Sekunden, bei 72,4 % Zeilen- und 49,8 % Branch-Abdeckung.

Lesen Sie die Branch-Zahl ehrlich. Die Hälfte Ihrer Branches bleibt unabgedeckt, was ungefähr dem entspricht, was man von einem Agenten erwartet, der aufhört, sobald seine Checkliste abgearbeitet ist, und nicht, sobald ein Abdeckungsziel erreicht ist. Der Wert liegt nicht darin, dass er Sie beim Schreiben von Tests ersetzt. Er liegt darin, dass die Mutations- und Assertion-Prüfung eine kodifizierte Antwort auf die Frage ist, woran man erkennt, ob ein generierter Test es wert ist, behalten zu werden. Diese Idee lässt sich in jeden Agenten übertragen, den Sie ohnehin einsetzen.
