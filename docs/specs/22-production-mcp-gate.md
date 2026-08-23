# Компонент 22: Production gate MCP

**Статус:** stdio MCP LIVE: durable allowlist, startup connect gauntlet,
pre-HookGate policy resolution, bounded prompt menu, invocation и Telegram
controls подключены в production composition. Streamable HTTP выключен; real
target stdio E2E остаётся эксплуатационным gate

**Связанные ADR:** ADR-0013, ADR-0027, ADR-0028, ADR-0014
**Зависит от:** MCP (07), Tools & Hooks (04), Safety (05), Agent DNA (20)

## 1. Назначение

MCP считается доступным агенту только после трёх независимых code-owned gates:

1. durable manifest прошёл строгий разбор и локальную проверку approved state;
2. сервер прошёл startup connect gauntlet по live pin и descriptor hash;
3. тот же процесс непосредственно перед `tools/call` повторно подтвердил pin и
   descriptors.

Успешный startup connect не является долговременным разрешением на вызов.
Raw descriptor, endpoint, token reference, pin и schema не входят в prompt.
Annotations сервера считаются подсказками, а не security authority.

## 2. Durable manifest

Файл `~/.aisy/mcp-allowlist.json` имеет `schemaVersion: 1` и не больше 1 MiB.
Каждая запись содержит:

- безопасное уникальное имя server;
- `stdio` с абсолютным executable и фиксированными arguments либо
  `streamable-http` с credential-free HTTPS URL;
- exact `pin` вида `<identity>@<version-or-digest>` без wildcard/`latest`;
- lowercase SHA-256 approved descriptor set и сами approved descriptors;
- только имя переменной scoped credential, но не credential value;
- human-owned policy каждого exposed tool: `tier`, `outboundSink`,
  `riskClass` (`readOnly`, `idempotent`, `destructive`) и короткий summary;
- status `active` или `archived`.

Неизвестные поля, duplicate server/tool/descriptor, неоднозначное
`server.tool`, policy без descriptor, multiline summary, read-only sink,
destructive non-sink, invalid URL/command/pin/hash блокируются до process/network
I/O. Approved descriptors ограничены по размеру; hash пересчитывается из
канонического JSON с deep-sorted keys.

## 3. Durable quarantine и restart

`~/.aisy/mcp-quarantine.json` публикуется атомарно через temporary file,
`fsync`, `rename`, `fsync(directory)`, с mode `0600`; каталог — `0700`.
Quarantine хранит только server name, reason и timestamp — без descriptors,
endpoint или credential metadata.

Quarantined server после restart принудительно представляется archived.
Возврат прежнего manifest не снимает quarantine автоматически. Повреждённый или
слишком большой manifest закрывает весь MCP registry через запись
`__manifest__`, но не мешает запуску базового агента без MCP.

## 4. Startup catalog

`connectActiveMcpCatalog` получает defensive snapshot валидированного allowlist,
создаёт manager только из этого snapshot и последовательно запускает connect
gauntlet. В frozen catalog попадают только server и menu tools с результатом
`connected` и непустым безопасным menu.

- hash mismatch и live pin mismatch сохраняют durable quarantine;
- missing credential, egress block и временная недоступность оставляют server
  неактивным на этот startup, но не создают вечный quarantine;
- вызов разрешён только для exact namespaced tool из frozen menu;
- menu line обязана принадлежать exact server, быть уникальной и иметь те же
  `rw/tier`, что и human-owned policy; несовпадение карантинирует server;
- скрытый, отказавший или появившийся после startup tool отклоняется до manager.

## 5. Per-call gauntlet

После policy resolution и narrowed/outbound checks manager:

1. отклоняет missing pin/hash до process/network I/O;
2. повторно проверяет egress и scoped credential availability;
3. создаёт отдельный server handle;
4. на этом же handle получает live pin и `tools/list`;
5. сравнивает canonical descriptor hash;
6. только после совпадения передаёт human-owned `tier`, `outboundSink` и
   `riskClass` в resolved call и выполняет `tools/call`;
7. всегда завершает handle в `finally`;
8. возвращает result только с `provenance: untrusted`.

Изменение pin или descriptors между startup и call блокирует invocation. Hash
mismatch выдаёт old/live diff event и не вызывает tool.

## 6. Pre-HookGate capability runtime

Preview `McpCapabilityRuntime` принимает frozen catalog и MCP server allowlist
из AgentCard. До prompt/HookGate он:

1. пропускает human/generated summary через deterministic defang и InputGuard;
2. исключает suspicious/injection summary и строит byte-stable menu без raw
   descriptor, schema, endpoint, pin и credential metadata;
3. принимает wrapper только с exact `{tool,args}`, plain JSON args ≤64 KiB и
   только для видимого frozen tool;
4. резолвит human-owned `tier`, `outboundSink` и `riskClass` до HookGate;
5. передаёт Safety конкретное имя `mcp:read|write:<server.tool>`, поэтому
   narrowing, Tier-2/3 approval и scoped grant нельзя обойти generic
   `call_mcp`;
6. создаёт только pending binding при resolution; HookGate переводит его в
   one-use authorized binding исключительно после финального `allow`, а
   deny/reject очищает; exact object/fingerprint и policy повторно сверяются
   непосредственно перед invocation;
7. принимает только result с exact untrusted provenance/server, ограничивает
   размер, применяет defang и classifier; suspicious, injection или classifier
   failure возвращают только фиксированный quarantine code без raw текста.

Прямой вызов executor без pre-HookGate binding и повторное использование
одного approval отклоняются.

## 7. Wire negotiation для MCP 2026-07-28

На момент среза 2026-07-28, 18:20 MSK для линии `2026-07-28` в официальном
списке релизов опубликован только pre-release tag `2026-07-28-RC` (`9d700ed`),
а `2025-11-25` остаётся помечен как `Latest`. В официальном `schema/` нет
versioned directory
`2026-07-28`: современная schema всё ещё находится в `schema/draft/`.
Обещанная дата выпуска не доказывает публикацию final release или final schema.

Split-пакеты официального TypeScript SDK v2 опубликованы как stable `2.0.0`,
README называет v2 stable release line, а npm dist-tag `latest` пакетов client,
server и core указывает на `2.0.0`. Отдельные release entries всё ещё содержат
устаревшую changeset-фразу `First beta release of SDK v2`; это несогласованность
release-note текста, а не beta-статус опубликованных пакетов.

SDK v2 по умолчанию сохраняет legacy `initialize`; modern era требует явного
`versionNegotiation`. Опубликованный migration contract задаёт две стратегии:
exact modern pin `2026-07-28` без fallback либо `auto`, который сначала пробует
`server/discover`, а затем допускает legacy `2025-11-25`. SDK отдельно не
считает authentication `401/403`, network failure, HTTP timeout или `5xx`
доказательством legacy era; Aisy сохраняет эту fail-closed границу.

Закреплённый Codex CLI 0.144.5 использует `rmcp = 1.8.0`. В этой зависимости
есть константа `2026-07-28`, но `LATEST` равен `2025-11-25`, а официальный Codex
MCP client path явно выполняет `initialize` и получает `InitializeResult`.
Это наблюдаемые факты. Вывод о несовместимости modern-only с закреплённым
runtime является следствием этих фактов: наличие modern enum само по себе не
доказывает `server/discover` или modern lifecycle.

Реализованный wire adapter не открывает сокет и не запускает процесс сам. Он
принимает инъецированный SDK-port и формирует проверяемый immutable plan:

- `modern-only`: exact pin `2026-07-28`, только одна supported version;
- `dual-era`: `auto`, порядок `2026-07-28` → `2025-11-25`, без третьей версии;
- `maxRetries=0`, bounded probe timeout и `usePriorDiscovery=false` для каждого
  нового one-shot handle;
- после connect требуется authoritative пара `era + version`; отсутствие или
  несовпадение закрывает handle;
- authentication, network, timeout и 5xx сворачиваются в стабильный code-only
  отказ и не считаются доказательством legacy era;
- `tools/list` ограничен числом страниц, tools и bytes, блокирует cursor loop,
  duplicate identity и неизвестные descriptor fields; cache hints принимаются
  только как `ttlMs >= 0` и `cacheScope=public|private`, устаревшее `ttl`
  блокируется;
- hash покрывает все принятые поля 2026 descriptor: `title`, `description`,
  `inputSchema`, `outputSchema`, `annotations`, `execution`, `icons`, `_meta`, а также
  внутренние approved classification inputs;
- annotations и `_meta` хэшируются, но не становятся источником tier,
  `outboundSink` или `riskClass`;
- до отдельного untrusted-media pipeline wire adapter принимает только bounded
  text content; image/audio/resource blocks блокируются; отдельный
  `structuredContent` допускает любой bounded JSON согласно 2026 contract, но
  не смешивается с prompt-текстом.

Временная policy до обновления закреплённого Codex runtime — **dual-era** с
modern-first probe и явным разрешением legacy на уровне human-owned manifest.
Она принята как [ADR-0067](../decisions/2026-07-29-mcp-dual-era-protocol-policy.md)
и остаётся live-off: принятие решения не активирует transport.
Опубликованный stable SDK 2.0.0 ещё не закрывает production gate: modern-only
станет default только после появления final schema, фиксации exact SDK
version/integrity с conformance/negative evidence и доказанного
`server/discover` в закреплённом Codex runtime либо отдельного снятия требования
legacy-совместимости.

Официальные источники:

- [релизы MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/releases);
- [дерево MCP schema](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/schema);
- [текущая draft schema](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/draft/schema.json);
- [официальный TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/releases);
- [README официального TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk);
- [migration guide 2026-07-28](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md);
- [release Codex 0.144.5](https://github.com/openai/codex/releases/tag/rust-v0.144.5);
- [зависимости Codex 0.144.5](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/Cargo.toml);
- [MCP client закреплённого Codex 0.144.5](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/rmcp-client/src/rmcp_client.rs);
- [`rmcp 1.8.0`: protocol versions](https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/rmcp-v1.8.0/crates/rmcp/src/model.rs).

## 8. Текущее production wiring

`aisy run` читает и валидирует durable allowlist, сохраняет quarantine и пишет
только безопасный event с количеством настроенных серверов и
`transportActive: false`. Ни server name, descriptor, endpoint, credential
reference или value в event не попадает.

Для Telegram-кнопки MCP при композиции создаётся неизменяемая проекция
уже валидированной политики. Она содержит только имя с пространством имён,
человеком заданное краткое описание, режим чтения/записи и tier. Endpoint,
command, pin, descriptor hash, raw descriptors, schemas и `tokenEnv` в
проекции нет. Рендерер отдельно показывает «настроен» и «активен»,
удаляет управляющие символы и ограничивает текст 4096 символами.

`activeMcpServers` заполняется ровно теми серверами, которые прошли connect
gauntlet при старте процесса: одобренная запись, живой pin, совпавший
descriptor hash и хотя бы один инструмент с одобренным описанием. Что не
прошло — отсутствует до следующего запуска и попадает в карантин, а не
переподключается молча.

Модель получает один control-tool `call_mcp` и только когда capability
действительно собран. Собственного tier у обёртки нет: tier, признак
outboundSink и идентичность подтверждения берутся из политики названного
инструмента, поэтому карточка подтверждения описывает MCP-вызов, а не обёртку.
Меню в prompt — только `server.tool`, режим, tier и одобренное оператором
краткое описание; schema, endpoint, command и `tokenEnv` в prompt не попадают.
Результат вызова возвращается как untrusted и проходит defang/классификацию;
не прошедший результат заменяется кодом отказа.

HTTP-транспорт по-прежнему не активирован: `isEgressAllowed` в живой композиции
отвечает «нет», поэтому достижимы только stdio-серверы.

Connect gauntlet теперь начинается с валидации transport policy, которая
выполняется до spawn и до любого сетевого контакта. Она проверяет соответствие
объявленного transport фактическим полям записи (stdio — непустой argv без
endpoint; streamable-http — endpoint без command), абсолютный путь бинаря без
traversal и управляющих символов, ограничение argv, `https`-схему без
credentials, query и fragment, exact host в egress allowlist и эру протокола.
Эра выводится только из human-owned поля `legacyProtocol` записи allowlist:
его отсутствие означает `modern-only`, а любое некорректное или расширенное
значение — отказ `legacy-not-approved`, а не понижение. Аргументы читаются один раз и валидируются тем же снимком, который уходит в
spawn, поэтому accessor или собственный итератор не могут подменить argv после
проверок. Одобрение эры читается только как own-поле plain-объекта с ровно тремя
собственными полями, поэтому загрязнение `Object.prototype` не превращает чистую
запись в `dual-era`. Результатом является замороженный план: он не кэшируется и
заново выводится и в `connect`, и в каждом `call`, поэтому после рестарта или
правки allowlist verdict не наследуется. Durable manifest принимает поле
`legacyProtocol` и карантинирует некорректное одобрение с отдельной причиной
`invalid-era-approval`. Отказ возвращает
только стабильный код причины; endpoint, command, pin и credential reference в
событие не попадают. Сама transport-policy валидация не выдаёт activation
authority: `transportActive` в её preview остаётся `false`. Live activation
выполняет отдельный app startup gauntlet только после policy/pin/connect checks;
он публикует executor wrapper и prompt menu лишь при непустом безопасном catalog.

Отдельно реализован только offline production-preview doctor настроенных имён.
Он один раз читает `allowlist.names()`, принимает не более 64 уникальных
безопасных имён, сортирует их по exact UTF-8 bytes и замораживает проекцию.
Любой verdict сохраняет `readyForTransportDecision: false`,
`activeServerCount: 0` и `transportActive: false`. Event содержит только
стабильный code и counts, без имён и connection metadata. Doctor не имеет
операций connect/spawn/invoke/quarantine, не подключён к `aisy run` и не
является connect gauntlet, transport validation или restart policy.

## 9. Критерии приёмки

1. **AC-22-1:** malformed/duplicate/ambiguous manifest не создаёт process и не
   выдаёт capability.
2. **AC-22-2:** stdio принимает только absolute executable; remote принимает
   только credential-free HTTPS.
3. **AC-22-3:** approved descriptors совпадают с stored hash; policy tool обязан
   существовать в approved set.
4. **AC-22-4:** tier/outbound/risk берутся только из human policy.
5. **AC-22-5:** quarantine переживает restart и не снимается silent restore.
6. **AC-22-6:** startup catalog выдаёт только connected menu tools.
7. **AC-22-7:** direct call без pin/hash не создаёт process.
8. **AC-22-8:** live pin/hash проверяются на том же handle до invocation.
9. **AC-22-9:** rug-pull не вызывает tool, выдаёт diff и завершает handle.
10. **AC-22-10:** любой MCP result остаётся `untrusted`.
11. **AC-22-11:** generic `call_mcp` не скрывает concrete tier/outbound от
    HookGate и не получает общий remembered grant.
12. **AC-22-12:** prompt menu содержит только classified safe summary из exact
    AgentCard/frozen catalog intersection.
13. **AC-22-13:** direct/unbound, resolution-only, rejected, mutated, hidden и
    policy-changed call не достигают manager invocation.
14. **AC-22-14:** oversize/invalid/suspicious result не раскрывает raw content.
15. **AC-22-15:** read-only UI-проекция фиксируется при композиции и не
    содержит connection data, raw descriptor, schema и credential metadata.
16. **AC-22-16:** Telegram чётко различает configured/active, не показывает
    raw descriptor prose и не превышает лимит 4096 символов.
17. **AC-22-17:** просмотр Telegram-каталога не вызывает connect/spawn/invocation и
    не добавляет MCP tool в provider prompt.
18. **AC-22-18:** modern-only создаёт exact pin plan `2026-07-28`, запрещает
    prior discovery и negotiation retries.
19. **AC-22-19:** dual-era предлагает только `2026-07-28` и `2025-11-25`,
    принимает legacy только с exact version evidence.
20. **AC-22-20:** missing/mismatched negotiation evidence, auth/network/5xx не
    запускают Aisy-owned fallback и закрывают handle без raw upstream error.
21. **AC-22-21:** изменение любого принятого поля 2026 descriptor меняет
    canonical hash; неизвестное поле блокируется до публикации descriptor.
22. **AC-22-22:** cursor loop, duplicate tool, превышение pages/tools/bytes
    блокируются bounded отказом.
23. **AC-22-23:** wire session допускает один bounded call; до media gate
    нетекстовые content blocks отклоняются; bounded `structuredContent` может
    быть любым JSON и остаётся отдельным от prompt text.
24. **AC-22-24:** наличие wire adapter не меняет `transportActive: false`, не
    заполняет live server set и не добавляет MCP tool в prompt.
25. **AC-22-25:** `tools/list` принимает только `ttlMs >= 0` и
    `cacheScope=public|private`; устаревшее `ttl` и malformed hints блокируются.
26. **AC-22-26:** offline configured-name doctor всегда возвращает readiness
    false, active=0 и transport=false; invalid/duplicate/oversized/throwing
    names дают пустой fail-closed projection. Его event содержит только code и
    counts, а inspect не вызывает connect/spawn/invoke/quarantine и не доказывает
    transport/restart readiness.

27. **AC-22-27:** transport policy отказывает до spawn и до сетевого контакта
    при несоответствии transport полям записи, относительном пути или traversal
    в бинаре, управляющих символах в argv, превышении argv-лимита, схеме кроме
    `https`, credentials в URL, query/fragment, невалидном URL и host вне egress
    allowlist. Отказ содержит только стабильный код причины.
28. **AC-22-28:** эра берётся только из human-owned `legacyProtocol`: отсутствие
    поля даёт `modern-only`, корректное одобрение — `dual-era`, любое иное
    значение — `legacy-not-approved`; серверный ответ на эру не влияет.
29. **AC-22-29:** план подключения заморожен, а verdict выводится заново в
    `connect` и в каждом `call`, поэтому отозванное одобрение и изменённый
    allowlist не переживают restart как действующее разрешение.
30. **AC-22-30:** argv валидируется и замораживается одним снимком: accessor и
    подменённый `Symbol.iterator` не могут отдать одно значение проверке и
    другое в spawn.
31. **AC-22-31:** одобрение эры учитывает только own-поля plain-объекта;
    `Object.create` с одобрением в прототипе и загрязнение `Object.prototype`
    не дают `dual-era`, а `approvedAt` обязан быть реальным моментом времени.
32. **AC-22-32:** durable manifest принимает human-owned `legacyProtocol` и
    карантинирует некорректное одобрение с причиной `invalid-era-approval`, не
    смешивая её с общей `invalid-server`.
33. **AC-22-33:** `call_mcp` объявляется модели только когда connect gauntlet
    оставил хотя бы один видимый инструмент. Пустой allowlist, недостижимый
    сервер, несовпавший pin, чужой набор инструментов и одобрение без описания
    дают одинаковый результат: обёртки нет в схемах провайдера, меню нет в
    prompt, `activeMcpServers` пуст.
34. **AC-22-34:** tier, `outboundSink` и идентичность подтверждения `call_mcp`
    берутся из политики названного инструмента; обёртка своего tier не имеет.
    Вызов без пары resolve/complete из hook gate отклоняется как
    `MCP_CALL_NOT_APPROVED` и не доходит до сервера.
35. **AC-22-35:** описание инструмента, попадающее в prompt, — одна строка
    ≤160 символов без управляющих символов, одобренная оператором на карточке.
    Всё, что не проходит, не получает строки меню, а инструмент без строки меню
    модели не виден.

## 10. Трассировка тестов

- `mcp/mcp.spec.ts`: AC-22-4, 7, 8, 9, 10;
- `runtime/active-mcp-allowlist.spec.ts`: AC-22-1, 2, 3, 4;
- `runtime/active-mcp-catalog.spec.ts`: AC-22-6, 12;
- `runtime/hook-gate.spec.ts`: AC-22-11;
- `runtime/mcp-capability-runtime.spec.ts`: AC-22-11…14;
- `app/mcp-allowlist-store.spec.ts`: AC-22-1, 5;
- `app/mcp-menu-runtime.spec.ts`: AC-22-15;
- `telegram-gw/mcp-catalog-view.spec.ts`: AC-22-16;
- `app/bot-mcp-menu.spec.ts`: AC-22-16, 17;
- `mcp/wire-adapter.spec.ts`: AC-22-18…23, 25;
- `app/bin/aisy.ts` и существующие startup/Telegram tests: AC-22-24;
- `packages/app/src/mcp-connect-gauntlet.spec.ts`: AC-22-26;
- `mcp/transport-policy.spec.ts`: AC-22-2, 27, 28, 29, 30, 31;
- `runtime/active-mcp-allowlist.spec.ts` (legacy-одобрение): AC-22-32;
- `mcp/mcp.spec.ts` (отказ до spawn по каждому инварианту): AC-22-27;
- `app/mcp-capability-composition.spec.ts`: AC-22-33, 34;
- `app/mcp-server-onboarding.spec.ts` (описание инструмента): AC-22-35;
- `runtime/agent-runner.spec.ts` (шов `call_mcp` в hook gate): AC-22-34.
