# ADR-0069: Жизненный цикл Agent Cards — scopes, ревизии и публикация

**Статус:** Принято
**Дата:** 2026-07-29
**Последнее уточнение:** 2026-08-12
**Теги:** agents, dna, security

## Контекст

Agent Card задаёт DNA агента и его capability matrix: разрешённые tools, Skills,
MCP-серверы, model policy, budget и scope. На момент принятия решения loader уже
умел читать карту, строго её валидировать и делать неизменяемой на весь run
делегации, но создание, редактирование и архивирование оставались
нереализованными: registry был read-only (спецификация 20, §6).

Причина не в объёме работы, а в том, что CRUD карт — это долговечная security
authority. Пока не зафиксированы правила, любая реализация может незаметно
изменить полномочия уже запущенного агента, дать карте расширить себя через
наследование или молча импортировать legacy `.md` с неизвестным происхождением.

Требуется зафиксировать: допустимые scopes, наследование и shadowing, семантику
revision/hash и поведение активной делегации после edit/archive, model policy и
budget, а также кто и каким подтверждением публикует и архивирует карту.

## Решение

### Scopes и shadowing

Карта живёт ровно в двух scope: **Workspace** и **Project**. Session-scope не
вводится — полномочия не должны меняться внутри уже идущей сессии.

Scope является не строковым флагом, а exact binding: Workspace не несёт
`projectId`, Project обязательно несёт валидный durable `projectId`. Имя и
revision считаются только внутри этого binding. Project-карта одного проекта
никогда не видна другому проекту, даже если имя совпадает.

Наследования полномочий нет. Карта самодостаточна: `matrix` Project-карты **не**
объединяется с Workspace-картой. Одноимённая Project-карта полностью затеняет
Workspace-карту в пределах своего Project. Слияние запрещено, потому что
объединение двух разрешающих списков — это тихое расширение полномочий.

### Revision и hash

Публикация создаёт неизменяемую ревизию. Идентичность карты — `name@revision`,
где `revision` монотонно растёт в пределах scope, а `hash` — sha256 по
канонизированному содержимому (те же правила канонизации, что у descriptor hash:
сортировка ключей, exact byte-stable сериализация).

Ревизии forward-only: опубликованная ревизия не редактируется и не удаляется.
«Откат» — это публикация новой ревизии с содержимым прежней; история сохраняется.
В каждом exact binding одновременно существует не более одной active revision:
новая публикация атомарно переводит предыдущую active revision в
`superseded`. Archive переводит текущую active revision в `archived` и не
реактивирует прежнюю; rollback только публикует новую forward revision.

До вычисления hash registry повторно проверяет полный object-schema карты теми
же ограничениями, что loader: точные поля, допустимые enum/tier/budget,
уникальные capability references, bounded DNA и отсутствие accessor-полей.
Registry хэширует и сохраняет отдельный глубоко неизменяемый snapshot, а не
объект вызывающего кода. Новая authority становится видимой в памяти только
после успешной durable публикации всего следующего состояния; ошибка записи не
создаёт «живую, но не восстановимую» ревизию и не сжигает approval.

Durable schema v2 сохраняет exact binding каждой revision. Legacy schema v1 не
содержала `projectId`: её Workspace revisions можно однозначно восстановить, а
Project revisions нельзя безопасно атрибутировать и поэтому startup отбрасывает
их fail-closed. Они не переносятся в Workspace и не привязываются к текущему
выбранному Project. Следующая успешная запись всегда публикует целый state v2.

### Поведение активной делегации

Уже запущенный run продолжает работать со своей запечатанной ревизией — edit и
archive не влияют на него ретроактивно. Ни одно изменение карты не расширяет
полномочия текущего run: seal остаётся источником authority до его завершения.

Новый запуск всегда берёт текущую активную ревизию. Архивная ревизия не
запускается: попытка старта по ней — fail-closed отказ, а не подстановка
предыдущей или builtin-карты.

### Запечатанная карта при durable resume

Первый запуск делегации до provider/tool I/O сохраняет в immutable authority
seal полную разрешённую карту, `name@revision`, hash, вычисленную capability
matrix, exact binding/session/turn, scope, budgets и policy revision. Resume
принимает только эту sealed ревизию. Текущая active ревизия registry используется
для проверки lifecycle, но не заменяет карту уже начатого run и не расширяет его
полномочия.

Архивирование самой карты после старта не отменяет sealed run ретроактивно. Но
если Project/Session scope архивирован либо сохранённые revision/hash/capability
set/policy revision больше нельзя доказать, recovery останавливается до
provider/tool I/O. Такое расхождение не считается миграцией и не исправляется
silent fallback’ом на предыдущую, Workspace- или builtin-карту.

### Durable approval, решение и execution actor

Approval неоднозначного действия связывается не просто с именем инструмента, а
с exact sealed authority. До отправки execution-card code-owned controller
устойчиво сохраняет:

- одноразовый nonce и action hash;
- operator/chat identity и exact WorkBinding/session/turn;
- run/delegation/task/operation key;
- `name@revision`, hash карты и capability matrix hash;
- policy revision, допустимое решение и состояние остановки.

Callback только проверяет эти поля и атомарно сохраняет решение
`retry-once|cancel`; он не вызывает provider/tool. Продолжение выполняет
supervisor-owned execution actor: под parent recovery lease он одноразово claims
решение и непосредственно перед I/O повторно проверяет карту, binding, policy и
бюджет. Повторная доставка callback возвращает сохранённый результат, но не
создаёт второй consume или dispatch.

`/stop` конкурирует с callback и actor claim одной durable транзакцией. Если
остановка победила, nonce и карточка инвалидируются, позднее решение не может
возобновить run. Если actor уже создал новую `prepared` operation, результат
остановки определяется operation receipt/ambiguity, а не обещанием модели.

Для неоднозначного повтора `canRememberSimilar=false`: разрешения на сессию и
«навсегда» не выдаются. Tier-3 ambiguity внутри прежнего run не получает retry
authority даже по этой карточке; требуется новая явная задача с новым step-up.

### Model policy и budget

Model policy — human-owned allowlist провайдеров и моделей; неизвестный провайдер
или модель блокируют публикацию, а не выбираются в runtime. Budget задаётся
явной схемой (лимит токенов и стоимости на run, ceiling итераций) и наследуется
дочерними run как жёсткий потолок: дочерний бюджет не может превышать
родительский.

### Публикация и архивирование

Create, publish, archive, rollback и explicit legacy import требуют
одноразового step-up approval оператора, привязанного к полному canonical
lifecycle envelope: verb, exact binding/name, expected head, source revision и
результирующие revision/status/hash. Approval нельзя переиспользовать для другой
операции, ревизии, головы или scope. Каждое действие пишет redacted audit-событие
со scope, именем, ревизией и hash prefix — без тела DNA и полного hash.

Registry принимает не структурное утверждение adapter'а, а exact
`ApprovalProof`, выпущенный единственным Gateway confirmer после step-up. Его
`actionId/actionHash` domain-separated связывают lifecycle verb, exact binding,
имя, revision и content hash; `stepUpVerified` обязан быть `true`. Proof от
publish не подходит archive/import и наоборот.

### Миграция legacy `.md`

Silent-миграция запрещена. Импорт legacy `.md` — явная операция оператора,
которая создаёт ревизию 1 с provenance `legacy-import`; исходный файл не
удаляется и не переписывается. Read выполняется только descriptor-relative из
заранее закреплённого `.aisy/agents` root через confinement sidecar с проверкой
root/file `(dev, ino)` до и после bounded UTF-8 read. Symlink, replacement,
необычный файл или отсутствие verified source-checkout worker закрывают import
без path fallback. До выполнения импорта loader остаётся read-only, а
legacy-файл не считается опубликованной картой.

### Production cutover и rollback

Lifecycle registry и Telegram-управление могут готовить ревизии, пока legacy
file loader остаётся authority. Только exact `AISY_AGENT_CARD_REGISTRY=1`
переводит новые main и non-builtin subagent run на durable registry. В этом
режиме отсутствие, архивирование или binding mismatch закрываются до provider
I/O без fallback на `.md`, прежнюю revision или Workspace поверх существующей
Project history. Builtin `general` остаётся code-owned.

Операционный rollback — снять gate и перезапустить runtime: прежний read-only
file loader снова становится authority, а registry не удаляется. Telegram UI
показывает bounded redacted-каталог exact Workspace/current Project histories и
управляет произвольным target, включая non-builtin subagent-карты. Callback и
формы используют process-local one-use tokens, связанные с principal, message,
generation и TTL; restart, replay или Project drift дают zero mutation. Draft
удаляется best-effort, все пять lifecycle verbs требуют отдельный Tier-3 step-up,
а selector не меняет runtime selection/cutover settings или monitoring. UI и
audit не содержат DNA/body, полного hash или локального пути.

## Последствия

- **Положительные:** полномочия агента нельзя изменить задним числом; откат и
  аудит опираются на неизменяемую историю ревизий; отсутствие слияния scope
  исключает тихое расширение прав.
- **Нейтральные:** появляется registry ревизий, требование step-up approval в
  UI/CLI, durable binding approval к sealed revision и отдельная команда
  импорта legacy-карт.
- **Отрицательные:** правка карты всегда порождает новую ревизию, поэтому
  registry растёт; «поправить опечатку в описании» стоит столько же, сколько
  изменение полномочий; drift карты останавливает recovery вместо автоматического
  перехода на новую ревизию.

## Рассмотренные альтернативы

**Слияние Workspace- и Project-карт.** Удобно для повторного использования, но
объединение разрешающих списков расширяет полномочия неявно, а конфликт
tier/budget пришлось бы разрешать эвристикой — отклонено.

**Мутабельная карта без ревизий.** Проще в реализации, но делает невозможным
доказательство того, с какими полномочиями работал завершившийся run, и ломает
seal активной делегации — отклонено.

**Автоматическая миграция legacy `.md` при старте.** Убирает ручной шаг, но
превращает произвольный файл на диске в источник полномочий без подтверждения —
отклонено.

## Ссылки

- Спецификация: [20-agent-dna-and-capability-matrix.md](../specs/20-agent-dna-and-capability-matrix.md), §6
- План: [этап 7](../superpowers/plans/2026-07-26-aisy-production-composition.md)
- Связано: [ADR-0011](./2026-06-11-autonomy-gradient.md) (tiers), [ADR-0013](./2026-06-11-mcp-allowlist-pinning-hashing.md) (канонизация и hash-pin)
- Durable execution: [ADR-0052](./2026-06-19-live-subagent-runner-seam-and-safety.md),
  [ADR-0071](./2026-07-29-execution-recovery-parent-supervisor.md),
  [спецификация 19](../specs/19-durable-subagent-resume.md)
