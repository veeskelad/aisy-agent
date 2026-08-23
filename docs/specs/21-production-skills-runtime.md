# Компонент 21: Production runtime Skills

**Статус:** LIVE для hash-pinned чтения, prompt-композиции, CLI install/remove и
Telegram-каталога/управления; automatic Skill drafting и verification-probe
promotion не входят в LIVE path  
**Связанные ADR:** ADR-0015, ADR-0017, ADR-0019, ADR-0027, ADR-0029  
**Зависит от:** Agent Loop (01), Skills (06), Safety (05), Agent DNA (20)

## 1. Назначение

Production runtime должен давать модели только активные, явно проверенные и
закреплённые по хешу Skills. Краткое меню входит в замороженный префикс сессии,
а полное тело добавляется в рабочий контекст только при детерминированном
совпадении trigger. Повреждение файла или манифеста закрывает конкретный Skill,
но не делает базового агента недоступным.

Этот компонент не разрешает модели публиковать Skill. Он только читает уже
принятое оператором состояние. Staging, approval, git promotion и живое
выполнение verification probes остаются в компонентах 06, 10 и 12.

## 2. Durable contract

`~/.aisy/skills-manifest.json` имеет schema version 1:

```json
{
  "schemaVersion": 1,
  "skills": [{
    "name": "inspect",
    "version": 1,
    "sha256": "<64 lowercase hex>",
    "trustSource": "user",
    "traceVerified": true,
    "status": "active",
    "touchedPaths": ["reports/result.json"]
  }]
}
```

Тело читается только из фиксированного пути
`~/.aisy/skills/<name>/SKILL.md`; манифест не может передать произвольный путь.
`name` соответствует `^[a-z0-9][a-z0-9-]*$`, файл не больше 256 KiB, SHA-256
совпадает с манифестом, frontmatter повторяет `name` и `version`, а тело содержит
`## verification`. Duplicate name и неизвестные значения закрываются.

`touchedPaths` — уже проверенная code-owned граница для делегации. Допускаются
только непустые относительные POSIX-пути без absolute root, `.`/`..`, пустых
сегментов, обратной косой черты и NUL. Runtime выдаёт эти пути только для Skill,
который прошёл все проверки и остался активным.

## 3. Trust и quarantine

В активный каталог попадает только запись одновременно со статусом `active` и
`traceVerified: true`. `trustSource` принимает `builtin`, `trusted-repo`,
`community` или `user`; сам Skill не может изменить source grade.

Причины quarantine: `invalid-manifest`, `invalid-skill`, `hash-mismatch`,
`identity-mismatch`, `unverified`. Node adapter атомарно публикует
`skills-quarantine.json` через временный файл, `fsync`, `rename` и `fsync`
каталога; каталог имеет mode `0700`, quarantine-файл — `0600`.

Quarantine переживает restart. Даже если оператор вернул исходные байты Skill,
он не активируется автоматически: сначала требуется осознанное восстановление
durable state. Исходный Skill не удаляется и остаётся доступен для post-mortem.

## 4. Prompt-композиция

При первом обращении к session в Agent Loop:

1. каталог сортирует `name + description`;
2. меню добавляется к frozen memory prefix;
3. для объединённых байтов пересчитывается `prefixHash`;
4. этот snapshot больше не меняется внутри живой session.

На каждом turn runtime собирает только operator-owned user spans, сопоставляет
их с trigger phrases и добавляет тела совпавших Skills как system spans. Тело не
попадает в prefix и не загружается в prompt без trigger. Ошибка необязательного
menu extension оставляет доступным базового агента.

## 5. Production wiring

- основной Telegram runner и goal runner используют общий активный каталог;
- Telegram-кнопка «Навыки» показывает то же активное меню;
- UI-проекция замораживается при композиции, содержит только
  `name + description` и при заданной main AgentCard фильтруется по её
  capability matrix;
- Telegram-рендерер не получает `SKILL.md` body, нормализует
  управляющие символы и ограничивает текст 4096 символами;
- subagent сначала проходит `resolveAgentCapabilityMatrix`, затем видит только
  Skills из своей immutable AgentCard;
- `touchedPaths` разрешаются из того же проверенного snapshot;
- неизвестная или неактивная ссылка на Skill блокирует AgentCard до model I/O;
- каталог формируется один раз при startup, поэтому изменение manifest требует
  контролируемого restart и не меняет frozen session незаметно.

MCP registry, promotion UI, telemetry результата Skill и выполнение
verification probes этим компонентом пока не объявляются готовыми.
Main-agent capability matrix доступна в live binary только через
opt-in настройку; её default cutover требует отдельного согласования.

## 6. Критерии приёмки

1. **AC-21-1:** активный hash-pinned и trace-verified Skill присутствует в меню.
2. **AC-21-2:** archived/unverified/tampered/malformed Skill отсутствует в меню и
   получает durable quarantine.
3. **AC-21-3:** quarantine сохраняется после restart и не снимается возвратом
   прежних байтов.
4. **AC-21-4:** manifest не управляет filesystem path; traversal отклоняется до
   чтения.
5. **AC-21-5:** menu заморожено один раз на session, body входит только в
   совпавший turn.
6. **AC-21-6:** child получает только Skills своей capability matrix.
7. **AC-21-7:** небезопасный `touchedPaths` не расширяет делегационный scope.
8. **AC-21-8:** пустой или сломанный optional catalog не выводит базового агента
   из строя.
9. **AC-21-9:** UI-проекция замораживает точное main-AgentCard пересечение
   при композиции и не удерживает Skill body.
10. **AC-21-10:** без main AgentCard UI показывает все записи из уже
    проверенного active catalog, но не читает/не публикует body.
11. **AC-21-11:** Telegram-меню имеет явное empty state, сортирует metadata,
    удаляет управляющие символы и не превышает 4096 символов.

## 7. Трассировка тестов

- `runtime/active-skill-catalog.spec.ts`: AC-21-1, 2, 4, 7;
- `runtime/skill-prompt-runtime.spec.ts`: AC-21-5, 8;
- `runtime/agent-runner.spec.ts`: AC-21-5;
- `runtime/sub-agent-runner.spec.ts` и `runtime/agent-capabilities.spec.ts`:
  AC-21-6;
- `app/active-skill-store.spec.ts`: AC-21-2, 3, 4;
- `app/skill-menu-runtime.spec.ts`: AC-21-9, 10;
- `telegram-gw/skill-catalog-view.spec.ts`: AC-21-11;
- `app/bot-skill-menu.spec.ts`: AC-21-1, 11.
