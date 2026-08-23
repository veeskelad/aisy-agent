# Security review: scoped monitoring/digests

**Дата:** 2026-07-27  
**Режим:** focused diff review (`monitoring`, daily confidence gate 8/10)  
**Статус:** два подтверждённых finding, remediation реализована и проверена

## Модель поверхности

Проверенный поток:

```text
operator source config → persisted binding/source → external HTTP collector
→ untrusted evidence → SQLite/FTS5 → provider scorer без tools
→ ranked digest → delivery receipt
```

Поверхность включает пять внешних connector families, один background tick,
один прямой model-scoring путь, локальный SQLite и будущий delivery adapter.
Live scheduler/delivery в `aisy.ts` не активирован.

## Findings

### F-1 — default Node HTTP transport допускает DNS-rebinding SSRF

- **Severity:** HIGH
- **Confidence:** 9/10
- **Status:** VERIFIED, self-verified (независимый subtask недоступен по правилам задачи)
- **Категория:** OWASP A10 / LLM external integration
- **Код до исправления:** `packages/app/src/monitoring-runtime.ts:56` выбирал
  `isPublicHttpUrl` как default authorizer, после чего строка 65 передавала тот же
  hostname в обычный `fetch`.
- **Exploit:** атакующий/скомпрометированный source config указывает публичное
  доменное имя. Проверка видит допустимый hostname, но DNS отвечает внутренним IP
  при фактическом `fetch`; collector читает внутренний HTTP endpoint и сохраняет
  ответ как evidence.
- **Impact:** чтение internal metadata/admin endpoints с правами процесса Aisy.
- **Remediation:** удалить прямой default fetch из production composition.
  Runtime обязан получить `MonitoringHttpPort`, уже реализованный через
  DNS-pinned/allowlisted egress boundary; без него composition fail-closed.

### F-2 — failed scorer calls не списываются из global call budget

- **Severity:** HIGH
- **Confidence:** 9/10
- **Status:** VERIFIED, self-verified
- **Категория:** LLM cost amplification
- **Код до исправления:** `packages/core-ts/src/monitoring/index.ts:708`
  увеличивал только `scored` после успешного ответа; `tick` на строке 797 вычитал
  из остатка именно `result.scored`.
- **Exploit:** scorer падает/возвращает invalid JSON для первого source. Попытка
  уже потратила provider request, но budget остаётся прежним; каждый следующий
  due source получает ещё один вызов, несмотря на `maxScoringCalls=1`.
- **Impact:** число платных model calls растёт до числа due sources за tick.
- **Remediation:** отдельно учитывать `scoringCalls` до await и уменьшать global
  остаток по попыткам, а не по успешно сохранённым scores.

## Проверенные инварианты без finding

- SQL использует placeholders; найденного injection path нет.
- External evidence остаётся user/untrusted span; scorer не имеет executor и
  отклоняет любые model tool calls.
- Project route участвует во всех source/evidence/digest запросах; тесты
  подтверждают A/B isolation и quarantine unscoped digest.
- Redirect проверяется до следующего запроса на уровне ранее добавленного
  адаптера, но этот адаптер удаляется из default composition из-за DNS gap.
- Events содержат только IDs/scope/counts, без locator, content и criteria.
- Database mode `0600`; secrets не должны входить в public locator.

## Remediation verification

После исправлений требуются:

1. type-level test: Node composition без explicit authorized HTTP port не
   компилируется/не имеет runtime fallback;
2. budget test: два due sources, scorer первого падает,
   `maxScoringCalls=1`, фактический scorer call ровно один;
3. полный monitoring и repository regression.

### Результат исправления

- **F-1 resolved:** `makeNodeMonitoringRuntime` теперь требует explicit
  `MonitoringHttpPort`; direct/global fetch implementation и default fallback
  удалены. Контракт порта прямо требует DNS/IP allowlisting, redirect validation
  и `maxBytes`. До появления проверенного egress adapter live polling остаётся
  fail-closed.
- **F-2 resolved:** `MonitoringPollResult.scoringCalls` считается до provider
  await и включает failed/invalid ответы. Global tick уменьшает остаток по
  `scoringCalls`, а не `scored`. Тест с двумя due sources, падающим scorer и
  `maxScoringCalls=1` подтверждает ровно один фактический вызов.
- Targeted verification: 23 core monitoring/security tests и 1 app composition
  test зелёные; полный repository regression указан отдельным финальным gate.

Этот автоматизированный review не заменяет профессиональный аудит. Для
production-системы с внешней сетью, secrets и персональными данными нужен
отдельный pentest egress boundary и deployment configuration.

## Дополнительный review exact-domain authority (2026-08-11)

Оператор одобрил узкую модель: добавление source выдаёт read-only grant только
на его exact HTTPS domain до удаления source. Реализованный additive-срез:

- сохраняет grant рядом с exact source и не повышает legacy rows без grant;
- сохраняет grant при pause/resume, но исключает paused source из due poll;
- tombstone удаления атомарно очищает grant; domain/locator нельзя изменить
  через update, поэтому смена требует remove + новой регистрации;
- передаёт `sourceId` в каждый collector request и повторно сверяет authority
  до DNS, на каждом redirect и после transport await;
- разрешает только HTTPS/443 GET без userinfo, credential-like query,
  wildcard/subdomain inheritance или ambient fetch;
- проверяет все DNS answers, закрепляет public IP и TLS hostname, ограничивает
  размер/тип/UTF-8 ответа; cross-domain redirect даёт zero second-hop I/O;
- отбрасывает body, если source удалён во время awaited transport.

Доказательства: Core registry/collector 38/38, App exact-egress/runtime 17/17,
связанный App network/monitoring corpus 87/87. Полный Core regression после
обновления общего DB consumer: 135 files, 2215 passed, 1 skipped. Оба package
typecheck и App build зелёные. Scheduler, source-management UI, scoring и
delivery этим решением не активированы, поэтому monitoring остаётся DORMANT.
