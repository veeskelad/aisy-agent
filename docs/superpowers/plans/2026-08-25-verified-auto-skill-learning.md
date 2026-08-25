# План реализации проверяемого автоматического обучения навыкам

**Связано:** [design](../specs/2026-08-24-verified-auto-skill-learning-design.md),
[ADR-0108](../../decisions/2026-08-25-typed-auto-skills-without-authority.md),
компоненты 6, 10, 12, 21 и 24.

## 1. Evidence и fingerprint

- Добавить в Core закрытые `VerifiedWorkflowEvidence`, `AutoSkillScope`,
  fixed-order canonicalization, domain-separated hashes и code-owned workflow
  fingerprint из descriptor/postcondition registry.
- Agent Loop публикует evidence только после terminal verified success всех
  обязательных effects. Trusted/narrowed predicate, session uniqueness,
  receipt idempotency и scope выводятся кодом.
- Тесты: same-session/retry/replay, untrusted/narrowed, ambiguous/missing
  postcondition, scope drift и concurrent second success.

## 2. Typed recipe pipeline

- Ввести отдельные `SkillRecipeGeneratorPort` и `SkillRecipeJudgePort`; strict
  parser принимает только ordered descriptor, placeholder и postcondition ids.
- Детерминированный renderer создаёт manifest и читаемый `SKILL.md`; validators
  запрещают новые шаги, authority, secrets, personal/raw values, пути и URL.
- Отдельный judge обязан иметь другую exact provider/model/revision identity.
  Artifact-bound shadow replay на двух fixtures проверяет sequence и effects.
- Тесты закрывают malformed/extras, injection, same judge identity, unavailable
  judge, changed/omitted step и postcondition mismatch.

## 3. Durable scoped lifecycle

- Реализовать приватный v2 store под `AISY_HOME`: evidence/job/revision ledger,
  immutable content-addressed manifests, per-scope+skill active/previous
  pointers, CAS и lifecycle от `queued` до `active`.
- Single-writer worker запускается после bounded evidence/reply-release
  transaction. Crash points каждой фазы восстанавливаются идемпотентно.
- Permanent revision-bound failures делают durable rollback на previous;
  transient failures не демоутят. Re-enable повторяет все gates.
- Тесты закрывают races, restart, revision conflict, disable/re-enable/remove,
  activation двух skills одного scope и tombstone повторной revision.

## 4. Forgetting и schema rollback

- Хранить reverse edges `session/project → evidence → job → revision`.
  `claimBySource` сначала снимает overlay/pointer и пишет anti-resurrection
  marker; только receipt claim разрешает purge source state.
- Реализовать idempotent `forget_claimed → purging → tombstoned` и тесты crash
  до/после каждой границы, удаления одной evidence session и несвязанной
  session.
- Managed rollback coordinator под общим lock выдаёт certificate для exact
  state hash/target commit лишь при пустом dependency set; drift или новая edge
  запрещают v2→v1 switch.

## 5. Prompt/runtime composition

- Добавить provenance `learned-procedure` ниже constitution/operator/project и
  binding-aware late overlay со следующего хода. Typed planner разрешает только
  manifest sequence; каждый tool call повторно проходит HookGate.
- Подключить runtime в `aisy run` за explicit `AISY_AUTO_SKILLS=1`, отдельными
  budget/rate limit и kill switch, не переиспользуя nightly generator/judge как
  ложный promotion gate.
- Проверить Project A/B, child exact binding/capabilities и отсутствие новых
  approvals, egress, sandbox или durable authority.

## 6. Уведомление, Doctor и production delivery

- Durable at-most-once outbox отправляет только
  `Я запомнил этот способ работы как навык: <название>.`; внутренние ids/status
  пользователю не показываются. Ambiguous send не повторяется и виден Doctor.
- Doctor показывает bounded lifecycle/ambiguous counts без personal data;
  restart сначала восстанавливает lifecycle, затем собирает skill menu.
- Запустить targeted/package/workspace tests, typecheck/build, adversarial и
  fault corpus, `git diff --check`, provenance/secret/private-reference scan.
- Зафиксировать независимые commits, выполнить independent review, push и
  интеграцию. Canary включается только на target operator instance; acceptance:
  две разные production sessions дают одну revision и одно короткое Telegram-
  уведомление, следующий ход использует skill, restart сохраняет его, managed
  rollback проходит только с certificate.

## Не-цели

Срез не создаёт fine-tuning, публичные skills, новые tools или permissions и не
меняет autonomy grants ADR-0061. Свободные human/agent-authored skills сохраняют
существующий human promotion gate.
