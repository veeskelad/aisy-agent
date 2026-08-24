# Проверяемое автоматическое обучение приватным навыкам

**Дата:** 2026-08-24  
**Статус:** дизайн одобрен оператором 2026-08-24  
**Связанные решения:** ADR-0015, ADR-0016, ADR-0017, ADR-0025, ADR-0061,
ADR-0103; спецификации компонентов 3, 6, 10 и 12

## 1. Результат

Aisy отвечает на сохранение факта естественной репликой и после двух
проверенных успешных выполнений одного процесса в разных сессиях самостоятельно
создаёт, проверяет и активирует его как приватный навык. Активация происходит
без отдельной карточки, но не выдаёт ни одного нового разрешения: существующие
HARD_DENY, approvals, sandbox, budgets, egress и durable authority продолжают
решаться кодом на каждом исполнении.

Пример пользовательского контракта:

```text
Пользователь: запомни я люблю получать деньги
Aisy: Запомнил, что ты любишь получать деньги
```

Каноническая память при этом хранит нормализованный факт от третьего лица, а
не текст подтверждения для диалога.

## 2. Минимальный scope и не-цели

В этот срез входят:

- раздельные поля `fact` и `acknowledgement` в команде durable remember;
- подтверждение только после реально завершённой записи памяти;
- code-owned fingerprint повторяемого процесса;
- два проверенных успеха в разных durable session id;
- немедленный generator → validators → separate judge → trace replay;
- атомарная активация приватного `SKILL.md` со следующего хода;
- аудит, restart recovery, disable/remove и автоматический rollback новой
  ревизии после проверенного отказа;
- короткое человеко-понятное Telegram-уведомление об активации.

Не входят обучение модели или fine-tuning, публикация пользовательских навыков,
автоматическое расширение approvals/egress, перенос секретов или переписки в
skill, обучение по неподтверждённым ответам модели, а также ослабление порогов
обучаемой автономности ADR-0061. Навык запоминает процедуру; scoped autonomy
grant по-прежнему выдаётся отдельным существующим процессом.

## 3. Естественное подтверждение durable memory

Команда remember получает две разные строки:

- `fact` — канонический факт для durable storage, например
  `Пользователь любит получать деньги`;
- `acknowledgement` — короткая разговорная придаточная часть во втором лице,
  например `ты любишь получать деньги`.

Обе строки формирует модель, но код проверяет их границы: непустая одна строка,
ограниченная длина, без управляющих символов и служебных receipt/status
префиксов. `acknowledgement` не индексируется, не становится evidence и не
влияет на canonical fact. После состояния `COMMITTED` tool возвращает
`Запомнил, что <acknowledgement>`. До durable commit, при `BLOCKED`, ambiguous
result или ошибке слово «Запомнил» не выводится.

Если разговорная форма отсутствует или невалидна, команда отклоняется до
mutation с машинным кодом коррекции. Модель получает возможность повторить
вызов с корректными двумя полями. Это исключает ложное подтверждение и не
пытается ненадёжно переписывать третье лицо регулярными выражениями.

## 4. Что считается повторением процесса

Evidence создаётся только после terminal success, для которого каждый
обязательный effect имеет проверенный postcondition. Код строит fingerprint из
упорядоченной последовательности `autonomyWorkflowStep`/`similarDescriptor`,
типа проверки и стабильной границы project/tool/resource. Сырые аргументы,
ответы инструментов и текст переписки в fingerprint не входят.

Счётчик принимает один успех на durable session id. Retry, replay, восстановление
того же turn, повтор внутри одной сессии и одинаковый receipt не увеличивают
счётчик. Неуспех, ambiguous effect, пропущенный postcondition, отмена оператора
или изменившаяся scope-boundary не считаются демонстрацией.

На втором успехе в другом session id создаётся одна idempotent candidate job.
Её ключ связывает fingerprint, две evidence identity и текущую базовую ревизию
навыка. Повтор после crash не создаёт второго кандидата или второй активации.

## 5. Очищенное evidence и генерация

Для generator строится bounded redacted trace:

- последовательность разрешённых tool/capability descriptors;
- абстрактные placeholders вместо конкретных значений;
- типы postcondition и факт их успешной проверки;
- project/resource scope как категориальная граница, без абсолютных домашних
  путей, chat/user id и содержимого пользовательской памяти.

Из кандидата детерминированно запрещаются credentials, tokens, environment
values, персональные факты, raw transcript, raw tool output, hostnames/IP,
домашние пути, поля authority/trust и инструкции обхода проверок. При
невозможности безопасно обобщить процесс job карантинится без активации.

Generator создаёт переносимый `SKILL.md` существующего формата: ограниченные
frontmatter, `provenance: agent-authored`, triggers и обязательный раздел
`verification`. Он не получает authority и не видит секреты или chain-of-thought.

## 6. Gates автоматической активации

Кандидат активируется только при последовательном успехе всех gates:

1. парсер формата и exact artifact hash;
2. `refs_exist`, `no_constitution_conflict`, `has_verification_section` и
   bounded network-none/read-only dry run;
3. code-owned проверка отсутствия authority fields, секретов, персональных
   значений и запрещённых путей;
4. отдельный judge, отличный от generator identity, видит только очищенный
   artifact, diff и результат validators;
5. replay двух закреплённых redacted traces подтверждает verification contract;
6. compare-and-swap проверяет, что base revision навыка не изменилась;
7. atomic private activation записывает новую ревизию и rollback pointer.

Недоступный judge, совпадающий generator/judge identity, invalid output,
validator failure, trace mismatch или revision conflict означает «не
активировать». Fail-open для skill promotion запрещён.

Отдельный human tap не нужен, потому что новый skill не создаёт и не расширяет
grant. Каждый его будущий tool call заново проходит обычный HookGate. Если
процедура требует подтверждения, Aisy продолжает его спрашивать.

## 7. Private state, lifecycle и rollback

Автоматические навыки живут только в приватном runtime state под `AISY_HOME` с
каталогами `0700` и файлами `0600`. Публичный repository хранит лишь реализацию
механизма, ADR, спецификации и обезличенные fixtures. Пользовательский skill,
его evidence, telemetry и audit никогда не коммитятся в source Git.

Активация сохраняет current и previous revision атомарно. Новый процесс сначала
восстанавливает незавершённую activation job, затем собирает menu. Состояние
`prepared` не является authority; после crash source of truth — завершённая
active revision либо предыдущая согласованная revision.

Проверенный постоянный отказ активированной ревизии немедленно выключает её и
возвращает previous. Transient failure записывается в telemetry, но не вызывает
permanent demotion. Повторная генерация той же неудачной revision запрещена
карантинным tombstone. Оператор может посмотреть список, выключить, включить с
повторной проверкой или удалить auto-skill; удаление не удаляет audit/tombstone,
необходимые против replay.

## 8. Пользовательский контракт

Основной ответ задачи не задерживается генерацией skill. Candidate pipeline
запускается после terminal reply и ограничен отдельным бюджетом. При успешной
активации Aisy один раз пишет:

```text
Я запомнил этот способ работы как навык: <короткое название>.
```

Hash, gate, evidence id, внутренний статус и canonical третье лицо пользователю
не показываются. При отказе gates молчаливое отсутствие активации не превращает
успешную задачу в ошибку; причина остаётся в приватном audit и Doctor status.

## 9. Production composition

LIVE runtime переиспользует существующие parser/validators, separate nightly
generator/judge adapters, active skill catalog и атомарное Node persistence.
Новый bounded evidence/job store соединяет post-success observation с immediate
candidate pipeline. Сборка создаётся в `aisy run`, передаёт reload callback в
skill prompt runtime и регистрирует lifecycle status в Doctor.

Default-on допустим, потому что до второго verified success механизм выполняет
только bounded private-state writes, а активированный skill не меняет authority.
Явный kill switch отключает новые observations/jobs и auto-activation, сохраняя
active skills для чтения и ручного управления. Откат binary сохраняет private
state; неизвестная новому/старому binary schema fail-closed не загружается.

## 10. Детерминированная приёмка

Готовность подтверждают тесты:

1. `fact` хранится канонически, а успешный reply равен
   `Запомнил, что ты любишь получать деньги`;
2. invalid/missing acknowledgement не пишет память, а blocked/ambiguous write
   не выводит «Запомнил»;
3. два успеха одной сессии, retry и replay не активируют skill;
4. два verified success разных сессий активируют ровно одну revision;
5. failure/ambiguous/missing postcondition не учитываются;
6. secret/personal/raw-path/authority injection карантинится до judge;
7. judge unavailable или same identity, replay mismatch и revision conflict
   fail-closed;
8. skill доступен со следующего хода, но каждый tool call сохраняет approvals,
   sandbox, budgets, egress и HARD_DENY;
9. crash в каждой durable phase восстанавливается без duplicate candidate,
   commit или activation;
10. verified permanent failure возвращает previous revision, transient failure
    не демоутит;
11. disable/remove/restart сохраняют ожидаемое состояние и replay tombstones;
12. Telegram E2E даёт естественный memory ack, а повторяемый process — одно
    короткое уведомление без внутренних receipt/status;
13. full package tests, workspace typecheck/build, Doctor, managed
    update/restart/rollback и финальный provenance/secret scan зелёные.

