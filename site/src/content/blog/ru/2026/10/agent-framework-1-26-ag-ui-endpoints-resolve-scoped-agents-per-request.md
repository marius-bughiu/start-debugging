---
title: "Agent Framework 1.26: конечные точки AG-UI больше не превращают scoped-агентов в синглтоны"
description: "Microsoft Agent Framework 1.26.0 заставляет MapAGUIServer разрешать keyed AIAgent, его AgentSessionStore и провайдер ключа изоляции на каждый запрос, а также добавляет перегрузку с селектором, который выбирает агента по HttpContext."
pubDate: 2026-10-24
tags:
  - "agent-framework"
  - "ag-ui"
  - "dotnet"
  - "aspnetcore"
  - "ai-agents"
lang: "ru"
translationOf: "2026/10/agent-framework-1-26-ag-ui-endpoints-resolve-scoped-agents-per-request"
translatedBy: "claude"
translationDate: 2026-10-24
---

[Microsoft Agent Framework dotnet-1.26.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.26.0) вышел 23 октября 2026 года, а `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` получил версию `1.26.0-preview.261023.1`. Главное для тех, кто размещает агентов за AG-UI, это [PR #9382](https://github.com/microsoft/agent-framework/pull/9382): конечная точка AG-UI теперь учитывает время жизни в DI, с которым вы зарегистрировали агента, и агента можно выбирать на каждый запрос.

## Captive dependency в 1.25 и более ранних версиях

До этого релиза `MapAGUIServer(agentName)` и `MapAGUIServer(IHostedAgentBuilder)` разрешали keyed `AIAgent`, его keyed `AgentSessionStore` и `AgentIsolationKeyProvider` из корневого поставщика служб один раз, в момент сопоставления конечной точки. Зарегистрированное время жизни игнорировалось. Scoped-агент на практике становился синглтоном, как и всё, что он захватил.

Это бьёт по случаям, когда агент зависит от состояния конкретного запроса:

```csharp
builder.Services.AddScoped<TenantContext>();

builder.Services.AddKeyedScoped<AIAgent>("support", (sp, _) =>
{
    var tenant = sp.GetRequiredService<TenantContext>();
    return chatClient.AsAIAgent(
        name: "support",
        instructions: $"You answer support questions for {tenant.Name}.");
});
```

В 1.25 побеждал первый разрешённый `TenantContext`. Каждый следующий запрос от любого арендатора получал того же агента с теми же инструкциями. Это классическая captive dependency, только спрятанная за сопоставлением конечной точки, а не за конструктором.

Начиная с 1.26 эти три службы берутся из `HttpContext.RequestServices` на каждом запросе. Scoped- и Transient-агенты получают новый экземпляр на каждый запрос. Синглтоны, зарегистрированные через `IHostedAgentBuilder`, по-прежнему разрешаются один раз при сопоставлении, так что для типичного случая никаких лишних затрат нет. Отсутствующие регистрации по-прежнему обнаруживаются при запуске: проверка использует `IServiceProviderIsKeyedService`, поэтому она никогда не разрешает scoped-экземпляр из корневого поставщика.

## Выбор агента по запросу

Тот же PR добавляет новую перегрузку:

```csharp
public static IEndpointConventionBuilder MapAGUIServer(
    this IEndpointRouteBuilder endpoints,
    [StringSyntax("route")] string pattern,
    Func<HttpContext, AIAgent?> agentSelector)
```

Селектор выполняется один раз на запрос, поэтому агента можно получать из значения маршрута, заголовка или claim:

```csharp
app.MapAGUIServer("/agents/{agent}", ctx =>
{
    var name = ctx.GetRouteValue("agent") as string;
    return name is null
        ? null
        : ctx.RequestServices.GetKeyedService<AIAgent>(name);
});
```

Возврат `null` даёт `404 Not Found` до загрузки какого-либо состояния сессии. `Name` выбранного агента используется как идентичность в хранилище сессий, поэтому разговор сохраняется, хотя для каждого запроса создаётся новый экземпляр агента. XML-документация прямо говорит, что выбор не является границей авторизации: повесьте на конечную точку политику авторизации (`.RequireAuthorization(...)`), а не возвращайте `null` для пользователей, которым нельзя попадать к агенту.

## Одно изменение поведения, которое стоит проверить

Последующий коммит в PR меняет то, как идентифицируются именованные агенты, сопоставленные по экземпляру. `MapAGUIServer(pattern, AIAgent)` теперь использует имя агента как идентичность, как и сопоставления по имени, hosted-сопоставления и сопоставления с селектором. Раньше один и тот же агент, доступный через именованное сопоставление и через сопоставление по экземпляру, не разделял разговоры. Теперь разделяет. Безымянные агенты по-прежнему используют идентичность экземпляра. Перегрузка с экземпляром теперь тоже разрешает своё хранилище сессий на каждый запрос.

Этот же релиз добавляет `AgentSessionStore.DeleteSessionAsync` как абстрактный метод, так что пользовательское хранилище, унаследованное от `AgentSessionStore`, не скомпилируется, пока вы его не реализуете. Если вы перешли на `MapAGUIServer` после [переименований в AG-UI .NET SDK 1.0](/ru/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/) и регистрируете не только синглтон-агентов, именно это обновление заставляет такие регистрации означать то, что в них написано.
