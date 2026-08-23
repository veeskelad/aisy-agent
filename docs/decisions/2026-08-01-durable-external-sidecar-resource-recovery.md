# ADR-0089: Долговечное восстановление внешних ресурсов sidecar

**Статус:** Принято
**Дата:** 2026-08-01
**Теги:** sidecars, durability, safety

## Контекст

Runtime-liveness fence из ADR-0071 подтверждает завершение Node runtime, а
process-group barrier покрывает только процессы внутри одной OS-группы. Docker
контейнеры и сети принадлежат daemon: они могут пережить аварийное завершение
runtime. Поэтому новый runtime не вправе начинать внешнее действие, опираясь
только на отсутствие прежнего PID или process group.

Whisper и restricted clone сейчас удаляют свои одноразовые ресурсы на обычном
пути возврата. Между успешным созданием ресурса в daemon и ответом Docker CLI
остаётся неопределённое окно. После аварии локальные флаги процесса теряются, а
текущее имя ресурса само по себе не доказывает, что Aisy имеет право его менять.

## Решение

Перед первой mutating-командой Docker Aisy устойчиво публикует exact operation
record во внешнем resource ledger. Запись привязана к установке, подтверждённой
runtime-liveness identity, к authenticated supervisor epoch, ledger-owned
монотонному номеру операции, sidecar kind и policy hash. Ledger сам вычисляет
одноразовый 64-символьный operation binding из database ID, epoch и sequence;
caller не передаёт operation ID, имена ресурсов, request, turn, project или
session ID. Имена и labels детерминированы этой привязкой.

Каждый planned resource проходит долговечные фазы `prepared → attempted →
bound`. `attempted` публикуется и синхронизируется на диск непосредственно
перед отправкой create-запроса Docker. После перезапуска отсутствие объекта в
одном scan доказывает безопасную отмену только для `prepared`: для
`attempted`, который ещё не получил immutable object ID, оно неоднозначно,
потому что daemon мог принять запрос и материализовать объект позже. Общего
cross-connection barrier у Docker не предполагается. Такой operation остаётся
в ledger и переводит весь supervised runtime в quarantine, пока объект не
появится и не будет точно reconciled либо отдельная doctor/manual процедура не
даст более сильное доказательство.

Каждый созданный контейнер и сеть получает закрытый набор `com.aisy.*` labels:
версию, installation, owner, operation, kind, role и policy hash. Ledger не
содержит путь к аудио, URL clone, содержимое сообщений или вывод sidecar.

До чтения recovery state и до каждого следующего spawn parent, удерживая child
fence, выполняет installation-wide reconcile. Reconciler:

1. проверяет exact private activation manifest и ledger;
2. проверяет доступность и совместимость закреплённого Docker endpoint;
3. перечисляет ресурсы exact installation label;
4. сопоставляет каждый объект с ledger, labels, именем и разрешённым хешем
   канонической inspect-проекции, затем устойчиво привязывает immutable Docker
   object ID к заранее опубликованному planned resource;
5. непосредственно перед изменением повторно проверяет exact object ID и
   inspect-проекцию, повторно подтверждает удержание supervisor authority, а
   команду адресует по ID, не по переиспользуемому имени;
6. останавливает и удаляет только точно доказанные owned resources;
7. повторно доказывает их отсутствие и лишь затем очищает operation record.

Missing, corrupt или unsafe manifest/ledger, недоступный daemon, неоднозначный
ответ команды, неизвестный owned object либо любое несовпадение дают
fail-closed quarantine без нового child и без внешнего действия. Отсутствие
объекта идемпотентно; crash между proof of absence и очисткой ledger безопасно
повторяет reconciliation.

Объекты другой installation всегда остаются нетронутыми. Исчезновение объекта
между inspect и командой безопасно повторяется; замена имени новым object ID
никогда не наследует прежнюю authority и приводит к quarantine.

После открытия новый parent получает только recovery handle. Он не умеет
готовить операции. Эксклюзивный ledger writer lease аутентифицирует manager
этого ledger; LIVE parent дополнительно обязан удерживать manager lease и child
fence из ADR-0071. Reconciler сначала закрывает все прежние records и доказывает
installation-wide zero owned resources; затем без промежуточного внешнего await
атомарно увеличивает authority generation и переводит ledger в active epoch.
Только capability этого epoch умеет `prepare`. Dormant-модуль не становится
LIVE, пока эта capability не создаётся внутри указанного parent barrier.

Operation binding одноразовый без per-operation tombstones: `operation_seq`
увеличивается в той же `BEGIN IMMEDIATE` транзакции, которая публикует
operation, и никогда не уменьшается после terminal clear. Завершённые
operations/resources удаляются, поэтому рабочий объём зависит от пикового
числа одновременных операций, а не от общего числа запусков. Старый epoch
capability после restart или rotation всегда получает conflict до Docker I/O.

Schema/activation v4 устойчиво хранит exact endpoint identity: binding hash,
daemon server ID, server version и закреплённую API version. Identity входит в
manager integrity и в производные owner/session/operation bindings. Runtime не
мигрирует v1–v3: exact activation и raw SQLite `user_version` отвергаются как
offline-only. Простое открытие v4 ledger не меняет manager state или epoch;
переход в recovery разрешён только после проверки live endpoint в reconcile.

Ответы Docker semantic port имеют жёсткий лимит cardinality и exact shape;
исключения, malformed значения и переполнение нормализуются в стабильный
code-only fail-closed результат.

Private root `0700` и файлы `0600` задают trust boundary текущего OS uid.
Обычные checksums строк обнаруживают случайную либо несогласованную порчу, но
не объявляются защитой от процесса с тем же uid, способного согласованно
переписать SQLite. Расширение threat model до hostile same-uid writer потребует
ключевого MAC из отдельного защищённого anchor и отдельного ADR.

Контракт обязателен для restricted clone, локального Whisper и
`lease-bound-docker-bash`. Direct run не получает supervised owner identity и
не может активировать эти Docker sidecars. Ресурсы прежнего формата без
installation-bound labels автоматически не меняются: их удаляет только
отдельная doctor/manual процедура после явного доказательства ownership.

До появления parent-owned broker legacy activators `AISY_SANDBOX_IMAGE`,
`AISY_WHISPER_IMAGE` и enabled restricted clone дают стабильный
`OWNED_DOCKER_PARENT_BROKER_REQUIRED` до supervisor state, child spawn,
provider и Telegram I/O. Supervised child не наследует Docker-настройки, а
parent повторно удаляет `DOCKER_*` и legacy Aisy Docker knobs непосредственно
на spawn boundary. Live child composition не создаёт Bash/Whisper Docker port;
не-Docker direct run остаётся rollback-путём, а read-only `doctor` не
блокируется этим guard.

Process group не заменяет этот ledger, а ledger не доказывает завершение
обычных OS descendants. Live activation разрешается только после обоих
независимых real-fault корпусов и platform service-manager self-test.

До LIVE exact attested binding Docker endpoint, daemon ID и совместимой server
version должен быть устойчиво связан с activation/ledger и проверяться до
reconcile/create/use. Совместимый, но другой пустой daemon нельзя трактовать как
доказательство отсутствия ресурсов прежнего endpoint.

Статическое поле с ожидаемой identity не считается attestation. Каждый вызов
semantic transport обязан доказать, что проверка daemon identity и конкретная
Docker-команда выполнены на одном закреплённом соединении и в одной endpoint
generation. Проверка resources layer выполняется до и после каждого await;
разрыв закреплённого соединения, смена generation или несовпадение identity
нормализуются в fail-closed результат до изменения ledger. Схема из отдельных
CLI-процессов `probe → inspect/remove` имеет неустранимое TOCTOU-окно, поэтому
CLI adapter не разрешён для LIVE mutations. Production-путь использует прямой
Engine HTTP transport с exact API version, без negotiation и fallback; typed
`404` берётся из HTTP status, а удаление адресуется только по immutable ID.

Dormant `DockerEnginePinnedSession` реализует read-only часть этого контракта.
Factory принимает только exact plain-object options и identity, снимает их
descriptor snapshot без accessor/Proxy/coercion и привязывает сессию к
каноническому Unix socket anchor. Symlink, world-writable socket, смена inode,
несовместимый daemon и API range без `1.54` дают code-only отказ. Сессия
открывает ровно одно физическое соединение, на нём последовательно выполняет
`/v1.54/version → /v1.54/info → inspect`, допускает ровно одну proof-команду и
никогда не reconnect/retry. Response headers, trailers, body и JSON ограничены;
abort, timeout, `Connection: close`, truncation или смена endpoint делают весь
результат неоднозначным. Бренд сессии нельзя подделать структурным объектом.
Эта read-only сессия по-прежнему умеет только container/network inspect.

Отдельный dormant `NodeOwnedDockerEngineRecoveryBroker` реализует только
parent-owned atomic `removeExact`. Factory принимает не произвольный callback,
а настоящий `OwnedDockerRecoveryLedger`, подтверждённый private `WeakMap`, и
фиксирует exact recovery epoch и endpoint identity. На время всей операции
ledger-owned dispatch token запрещает activation, повторный вход в recovery и
закрытие ledger. До socket I/O ожидаемый объект обязан совпасть ровно с одной
`bound` row по installation, owner/session/operation binding, sidecar kind,
policy, role, resource kind, имени, projection hash и immutable object ID.
Пустой, чужой, `prepared` или `attempted` ledger не даёт mutation authority.

На одном физическом соединении broker выполняет строгую последовательность
`/v1.54/version → /v1.54/info → inspect immutable ID → DELETE immutable ID
→ post-inspect 404`. Перед и после каждого await повторно проверяются recovery
epoch и endpoint generation; lost authority доминирует над transport error.
Первичный typed `404` означает `absent` без DELETE. После отправки DELETE любой
abort, timeout, разрыв, неожиданный status или отсутствие post-inspect `404`
означают `REMOVAL_AMBIGUOUS` без retry/reconnect. Network удаляется только при
нулевом числе endpoints. Hostile expected/options и `AbortSignal` проверяются
descriptor-only; для signal используются захваченные platform intrinsics и
broker-owned composite без вызова caller getters/methods/traps.

Broker не меняет ledger, не создаёт и не запускает ресурсы, не выдаёт capability
child, не импортируется runtime/tool/provider composition и не включает LIVE.
Pinned create/use, authenticated current-child authority и parent wiring ещё не
реализованы, поэтому LIVE authority этим срезом не возникает.

Pinned session также получила отдельный one-shot read-only
`inspectImageRuntime`: только digest-qualified reference, тот же физический
socket и порядок `v1.54/version → info → images/<digest>/json`, ответ не более
256 KiB. Успех выпускает genuine WeakSet-branded, deep-frozen evidence с exact
endpoint identity; typed `404` evidence не создаёт. Per-call options проходят
descriptor-only проверку до расходования session. Сам read-only evidence не
является projection sealing, ledger publication или LIVE.

Поверх genuine image evidence реализован отдельный dormant
`DockerImageRuntimeManifestV1`. Factory не принимает структурную подделку:
источником может быть только WeakSet-branded evidence от pinned session.
Open top-level image response нормализуется в exact runtime Config-контракт
Docker API v1.54; неизвестное поле Config, accessor/Proxy/symbol, лишний
`com.aisy.*` label или inherited environment вне code-owned allowlist дают
fail-closed отказ. Обязательны `Id` формата `sha256`, ровно одно вхождение
запрошенного RepoDigest, `linux` и `amd64|arm64`; image ID и manifest digest
сохраняются как разные Docker identity.

Отсутствующие допустимые defaults переводятся в явные пустые значения,
runtime Config и endpoint identity глубоко замораживаются. Хеши Config и всего
manifest считаются ручной scalar-only канонизацией в раздельных доменах, без
вызова унаследованного `toJSON`. Лимиты: 256 KiB cumulative UTF-8, 256 KiB
cumulative canonical form, 16 384 узла, depth 32, строка 16 KiB и конечная
cardinality массивов/maps. Этот manifest ничего не пишет в ledger, не строит
Docker create request, не выдаёт `prepare`/mutation capability и не подключён к
LIVE composition.

До реализации pinned create/use введён отдельный dormant слой code-owned
семантических планов. Общая factory принимает только exact граф одного из трёх
sidecar: Whisper, lease-bound Bash или restricted clone. Она снимает
descriptor-only snapshot, отклоняет Proxy, accessor, symbol, неизвестные поля и
не-JSON значения, проверяет точную per-sidecar схему commitment и выпускает
genuine draft только через private `WeakSet`. Хеш draft вычисляется в домене
`aisy.owned-docker.semantic-draft.v1` ручной канонизацией без object coercion;
лимиты составляют 1 MiB UTF-8/canonical JSON, 50 000 узлов и depth 32.

Commitment не содержит raw clone hostname/IP, аудио, instruction, filesystem
locator или Docker request. Динамические значения представлены только
SHA-256, размерами и ограниченными enum. Для Whisper до появления отдельного
measurement evidence зафиксирован baseline ADR-0072: не менее 3 GiB RAM,
2000 millicores и 64 PID. Restricted clone фиксирует безопасный порядок
attestation/membership/start/wait/terminal/archive и конечные пределы stream,
extraction, entry и entry count.

Draft перечисляет обязательные будущие доказательства: image runtime,
Engine create→inspect, а для clone также IPAM reservation, endpoint membership
и archive stream. Он намеренно не содержит `prepareInput`, финальный
`projectionHash`/`policyHash`, Docker wire request или mutation capability.
Поэтому этот слой не является sealing, ledger publication, create/use broker,
real-Docker evidence или LIVE activation.

Raw Engine inspect и диагностический CLI обязаны вычислять один и тот же
ownership proof. Общий read-only normalizer выбирает из container/network
inspect только code-owned семантическую проекцию, отдельно и строго разбирает
восемь ownership labels, считает canonical bounded hash и возвращает
deep-frozen `OwnedDockerObservedResourceV1`. Proxy, accessor, symbols,
неограниченная глубина/cardinality, лишняя `com.aisy.*` label и malformed IPAM
отклоняются без coercion. CLI adapter делегирует ему ту же нормализацию; отдельная
CLI-копия правил больше не может незаметно разойтись с Engine broker.

Normalizer имеет собственные cumulative limits на UTF-8 ключей/строк и
canonical JSON по 1 MiB, а также 50 000 узлов, depth 32 и не более 4096 network
endpoints. Targeted normalization/CLI/coordinator gate 43/43; App
typecheck/build и полный App regression 1189 passed / 17 skipped; fixture
process leak не обнаружен. Независимый review: P0=0, P1=0.

Dormant evidence parent-only `removeExact`: broker 27/27, объединённый
broker/pinned/normalizer/Engine/ledger/coordinator gate 131/131, App
typecheck/build и полный App regression 1216 passed / 17 skipped зелёные;
`git diff --check` чистый, fixture process leak не обнаружен. Независимый
повторный review: P0=0, P1=0. Это fake Unix Engine evidence, не real-Docker, не
ledger cleanup и не LIVE activation.

Dormant semantic-plan evidence: три новых корпуса — 29/29; совместно с
существующими Whisper/clone supervisor checks — 49/49; App typecheck/build и
`git diff --check` зелёные; полный App regression — 1245 passed / 17 skipped
(141 test files passed / 5 skipped). Два независимых review обнаружили и закрыли unsafe
clone ordering, inherited `toJSON`, обход generic factory raw-значением и
Whisper ниже baseline ADR-0072. Финальный повторный review: P0=0, P1=0. Этот
evidence не заменяет real Engine manifests и create/use E2E.

Follow-up review перед sealing обнаружил, что shared projection normalizer ещё
вызывал унаследованный `Object/Array.prototype.toJSON` через `JSON.stringify`
целого объекта. Authority-hash переведён на ручную scalar-only канонизацию;
golden container/network hashes подтверждают совместимость уже сохранённых
проекций. Normalizer/CLI gate — 22/22, полный App regression — 1246 passed / 17
skipped; независимый review — P0=0, P1=0.

Pinned image-inspect evidence: собственный корпус 55/55, объединённый
pinned/Engine transport/recovery/normalizer gate 104/104; App typecheck/build и
полный regression 1260 passed / 17 skipped зелёные.

Image-runtime manifest: собственный корпус 13/13, объединённый Docker security
gate 117/117; workspace typecheck/build и полный App regression 1273 passed /
17 skipped зелёные. Это fake Unix Engine evidence без create/use, ledger
publication, sealing и LIVE activation.

Pre-sealing audit закрыл ещё одну связь: container projection теперь включает
top-level `Image` из inspect как exact `sha256` image config ID. Это отдельное
значение от `Config.Image` с digest-qualified create reference; оба входят в
projection hash и обязаны независимо совпасть с будущим image/create plan.
Диагностический CLI читает exact шестипольный envelope с `.Image` и передаёт
его в тот же normalizer. Missing/malformed ID отказывает; наружу по-прежнему
возвращается только opaque hash. Container golden hash намеренно изменён до
LIVE: production importer/create-use отсутствуют, поэтому автоматической
миграции старой dormant projection нет. Gate: normalization/CLI/recovery 50/50,
объединённый Docker security 132/132, workspace typecheck/build и полный App
regression 1274 passed / 17 skipped; независимый review P0=0, P1=0.

Следующий review запретил использовать полную post-inspect projection V1 как
pre-create commitment. Docker daemon и image Config после `create` дополняют
`Hostname`, inherited defaults, runtime/log/cgroup значения и формы
`null|empty`; их байтовое представление нельзя честно предсказать заранее.
Поэтому V1 остаётся recovery/diagnostic proof уже существующего объекта, а для
будущего create broker введён отдельный dormant
`ExpectedOwnedDockerContainerProjectionV2`: только request-deterministic и
security-relevant поля, собственный domain-separated hash и отдельный
post-inspect normalizer. Это новый контракт, а не смена смысла сохранённого
`projectionHash` V1; ledger schema и `prepare` пока не изменены.

V2 связывает sidecar kind/role, image config ID и create reference, effective
user/env/entrypoint/cmd/working directory, stdin/TTY, non-ownership labels,
отключённый healthcheck и stop signal. Host-проекция фиксирует network/runtime,
read-only rootfs, non-root `65532:65532`, capability/security/userns/cgroup
confinement, exact masked/readonly proc/sys paths, пустые sysctls/groups,
IPC/PID/UTS,
RAM/swap/CPU/PID, restart/auto-remove/log/tmpfs/ulimit, отсутствие devices и
ports, OOM/shm/init и максимум один exact bind mount. Непредсказуемые, но
безопасные daemon-generated поля не входят в hash; ослабление выбранного
инварианта либо неизвестный `com.aisy.*` label отказывают. Expected input и
inspect проходят descriptor-only проверку, Proxy/accessor/symbol не
исполняются, а наружу из observed evidence выходят только identity и opaque
hash. Слой не строит request, не вызывает Docker и не выдаёт authority.
Targeted V2 corpus 8/8 и объединённый semantic/image/normalization gate 67/67;
workspace typecheck/build и полный App regression 1282 passed / 17 skipped
зелёные, fixture process leak не обнаружен. Независимый повторный review после
исправления root, proc/sys и kind-scope gaps: P0=0, P1=0.

Поверх V2 добавлен следующий dormant слой genuine create-plan evidence только
для Whisper и lease-bound Bash. Node filesystem factory проверяет canonical
не-root directory без symlink, дважды связывает `device:inode` и выпускает
WeakSet/WeakMap evidence; публично видны только domain-separated root identity
и, для Whisper, relative-name hash. Это не удерживаемый file descriptor и не
quiescence authority: identity обязана повторно совпасть непосредственно на
будущем dispatch boundary.

`DockerCodeOwnedContainerCreatePlanV1` создаётся только из genuine semantic
draft, genuine pinned image manifest и current genuine filesystem evidence.
Bash дополнительно пересчитывает raw instruction SHA-256/byte length, Whisper
сверяет root/relative commitments. Образ с inherited volumes, exposed ports или
OnBuild отказывается. Runtime больше не приходит строкой от caller: одноразовая
pinned Engine session читает bounded `/version` + `/info`, требует builtin
seccomp и daemon-owned `userns` либо `rootless`, сама выбирает `runsc` или
явный `degraded-no-gvisor`/`runc` и выпускает genuine endpoint-bound evidence.
Factory строит direct Engine request template и selected projection, но хранит
raw command и root только в private WeakMap-хранилищах. Публичный deep-frozen plan содержит
endpoint, runtime/security level, isolation-profile/runtime-evidence и
semantic/image/projection/request hashes; spread/clone не сохраняет provenance.
Для Bash semantic `isolationProfileSha256` обязан совпасть с probe evidence,
поэтому downgrade меняет draft и публично видимый уровень, а не происходит
скрыто внутри opaque hash.

Projection-only verifier повторно проверяет current filesystem identity и V2
inspect parity, но намеренно не подтверждает ownership labels: их exact значения
появятся только после ledger-owned prepare/seal. Слой не выдаёт request наружу,
не вызывает Engine, не публикует ledger, не создаёт capability и не подключён
к LIVE. Allowlist образа дополнен code-owned offline-переменными ADR-0072:
`HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `OMP_NUM_THREADS`.

Dormant evidence этого среза: create-plan + pinned runtime 63/63,
объединённый Docker security/contract gate 130/130, workspace typecheck/build и
полный App regression 1290 passed / 17 skipped. Независимый повторный
kill-matrix review после удаления caller runtime: P0=0, P1=0. Это не
real-Docker и не LIVE evidence.

Pre-seal review обнаружил несовместимость schema v3: её единственный
`projection_hash` уже означает полную post-create inspect projection V1, тогда
как genuine create plan до mutation знает только selected projection V2.
Записывать V2 в старое поле запрещено: это тихо меняет долговечную семантику и
делает первый real create несовместимым с recovery normalizer. Поэтому schema
v4 разделяет два независимых обязательства:

- immutable `create_projection_contract` + `create_projection_hash` публикуются
  в `prepared`; для текущих Whisper/Bash containers контракт равен
  `container-selected-v2`;
- nullable `bound_projection_hash_v1` остаётся `NULL` в `prepared|attempted` и
  записывается одной FULL-sync транзакцией вместе с immutable object ID при
  переходе в `bound`;
- observed container evidence независимо нормализует selected V2 и полный V1:
  attempted discovery сначала подтверждает create contract/hash, а bound/use/
  recovery дополнительно требуют exact сохранённый V1.

До отдельного restricted-clone create plan и network projection contract v4
`prepare` разрешает только одно-контейнерные Whisper/Bash operations. Clone
отказывается до увеличения sequence и до записи строк; подставлять его под
`container-selected-v2` запрещено.

API v4 использует явные имена полей и не оставляет двусмысленного
`projectionHash`. Отдельный SQLite intent journal отвергнут: он не способен
атомарно связать intent с `resources.phase`, создаёт cross-file recovery
cross-product и не исправляет старую семантику discovery/bind.

Все authority/integrity hashes v4 используют собственную scalar-only
канонизацию с разделёнными доменами. `JSON.stringify` обычного объекта не
является границей безопасности: унаследованный `Object.prototype.toJSON` не
должен получать возможность схлопнуть разные database ID, epoch или sequence в
одинаковый hash. Adversarial `toJSON` входит в обязательный corpus.

Offline migration v1–v3 допустима только после exclusive writer lease, exact
endpoint и свежего installation-wide zero proof при `operations=0`. Она создаёт
новый v4 ledger с новым database ID и атомарно публикует новую activation; старые
DB/activation сохраняются до конца rollback window. Non-empty v3 остаётся в
quarantine/manual. Down-migration и перезапись v4 запрещены. Старый binary
fail-closed отвергает activation v4. Rollback возможен только после нового
fresh v4 installation-wide zero proof непосредственно перед атомарным возвратом
к сохранённой паре v3 DB+activation; исходный migration zero proof не покрывает
ресурсы, которые успел создать v4 runtime.

`VACUUM`, физическая compaction, смена database namespace или offline migration
разрешены только в recovery mode после свежего installation-wide zero proof.
Ни одна старая dormant schema не мигрируется в LIVE автоматически: будущий
doctor выполняет только описанную offline zero-only процедуру и публикует новый
database ID с exact activation manifest.

Проверенный dormant gate schema/API v4: объединённый ledger/coordinator/
normalizer/CLI/pinned Engine/recovery broker — 160/160; полный Docker-oriented
корпус — 282 passed / 1 opt-in live smoke skipped; workspace typecheck/build и
полный App regression — 1301 passed / 17 skipped. После gate fixture-процессы
не обнаружены. Независимый security/compatibility review: P0=0, P1=0. Это
fake-port/fake-Engine evidence; real Docker mutation и LIVE activation не
выполнялись.

Следующий dormant слой связывает genuine create plan с genuine active epoch до
любого Docker I/O. Active epoch и выданный им operation handle получили
неподделываемое process-local provenance в private `WeakMap`; структурная
копия, Proxy или handle из другого процесса authority не наследуют. До
увеличения operation sequence проверяется точное совпадение endpoint identity
плана и ledger. Устаревшая epoch остаётся распознаваемым объектом, но не может
изменить ledger.

`DockerCodeOwnedContainerCreateSealV1` выпускается один раз для одного genuine
Whisper/Bash plan. Plan сжигается непосредственно перед единственным
`activeEpoch.prepare`: повтор, в том числе после stale-отказа, не создаёт новую
operation. В v4 ledger публикуется ровно один `worker/container` с контрактом
`container-selected-v2`, hash из plan и `policyHash`, равным `createPlanHash`.
Имя и восемь `com.aisy.*` labels берутся только из ledger descriptor;
code-owned image labels этого namespace запрещены.

Полный create request с ledger labels и именем хранится только в private
`WeakMap`. Его отдельный domain-separated hash считается ручной scalar-only
канонизацией. Публичный deep-frozen seal содержит только kind/role и opaque
hashes: в нём нет raw request, имени контейнера, команды, пути, ledger/database
identity, epoch или callback. Spread/Proxy не сохраняют provenance. На этом
этапе hidden accessor и dispatch намеренно отсутствуют: слой лишь фиксирует
`prepared + sealed`, не вызывает Docker, не выдаёт child capability и не
подключён к LIVE composition.

Следующий dormant срез реализует code-owned create broker для Whisper и
lease-bound Bash. Перед mutation broker на одном закреплённом Unix socket
выполняет `/v1.54/version → /v1.54/info` и повторно подтверждает exact endpoint
и sandbox runtime. Только после этого coordinator устойчиво переводит resource
в `attempted` и выдаёт одноразовый genuine permit, связанный с exact operation,
role, descriptor, epoch и endpoint. Permit нельзя получить до `attempted`,
подделать структурным объектом, скопировать, использовать повторно или сохранить
после завершения dispatch.

Pinned transport принимает одновременно genuine permit и genuine sealed
request. Permit сжигается с повторной проверкой epoch/endpoint непосредственно
перед единственным POST; имя берётся только из ledger descriptor, а platform и
тело обязаны совпасть по identity и sealed hash с private state broker. Затем на
том же физическом socket выполняются
`POST /containers/create → GET /containers/<immutable-id>/json`. Reconnect,
retry и fallback отсутствуют. Нормализованные имя, ownership labels, image и
selected projection V2 должны совпасть до выпуска WeakSet-backed attested
outcome; coordinator принимает только такой outcome и атомарно записывает
`object_id + bound_projection_hash_v1`.

Потерянный `201`, abort/timeout после POST, `404`, `409`, malformed response или
inspect mismatch оставляют resource в `attempted` и возвращают code-only
`CREATE_UNRESOLVED`; повторный POST и discovery в текущем процессе запрещены.
Preflight-отказ до permit сохраняет `prepared`. Публичный broker не возвращает
request, descriptor, permit, bound handle, `use`, `start` или `remove`.

Урок реализации: одной неподделываемой метки успешного inspect недостаточно.
Первая версия raw pinned transport всё ещё принимала произвольное тело и могла
создать контейнер вне durable intent. Безопасная граница требует двух независимых
одноразовых доказательств до POST: ledger-owned permit после `attempted` и
code-owned seal точного wire request. Низкоуровневый transport не должен быть
самостоятельным mutation API даже при отсутствии текущего LIVE-импортера.

Dormant fake-Engine/SQLite gate этого среза: create-plan/broker, pinned session,
pinned create transport, ledger и coordinator — 161/161. Доказаны один socket,
один POST, отсутствие retry, forged/replay/cross-endpoint отказы и exact
inspect-to-bind. Это не real-Docker evidence, не запуск worker, не cleanup и не
LIVE activation.

Следующий dormant срез добавляет genuine `bound-container use` authority.
`OwnedDockerBoundResourceHandle` выпускает одноразовый permit только после
повторного exact inspect уже связанного immutable ID и удерживает active-epoch
dispatch barrier до завершения use. Permit связан с ledger, epoch, operation,
endpoint identity, role, object ID и обеими projection; структурная копия,
Proxy, replay,
неиспользованный или переживший callback permit не принимаются.

Parent-only pinned use broker сначала на одном Unix socket повторяет
`/v1.54/version → /v1.54/info`, затем сжигает genuine permit и выполняет
`inspect immutable ID → POST start → POST wait?condition=not-running →
terminal inspect → bounded logs`. До `start` контейнер обязан иметь exact
ownership/projection и состояние `created`; после `wait` состояние `exited`,
exit code и отсутствие OOM/error подтверждаются отдельным inspect. Logs
принимаются только как bounded Docker raw multiplex stream, разделяются на
stdout/stderr и обязаны быть корректным UTF-8.

После возможной отправки `POST start` любой abort, timeout, разрыв socket,
неожиданный status, terminal mismatch или смена endpoint даёт только
`EXECUTION_UNRESOLVED`; reconnect/retry/start по имени отсутствуют. После
доказанного terminal состояния ошибка logs даёт `OUTPUT_UNRESOLVED`. В обоих
случаях durable `bound` остаётся для restart cleanup. Broker не удаляет объект,
не очищает ledger, не выдаётся child и не подключён к LIVE composition:
active cleanup, parent IPC/current-child authority, real-Docker fault corpus и
production importer остаются обязательными следующими воротами. LIVE importer
также обязан получать `wallTimeMs` и `maxOutputBytes` только из code-owned
execution plan, связанного с тем же `policyHash`; произвольные параметры из
tool/model input не являются authority.

Следующий parent-only recovery срез закрывает durable cleanup для операции из
одного worker-контейнера (`lease-bound-docker-bash` и совместимый одно-контейнерный
sidecar). Recovery ledger выдаёт genuine одноразовый cleanup permit только для
exact `bound` row и удерживает destructive dispatch barrier на всю installation.
Pinned broker после `version → info` сжигает permit, сверяет immutable-ID inspect,
делает не более одного `DELETE`, доказывает ID-404 и затем на той же socket
generation получает exact empty списки containers и networks по installation
label. Только genuine outcome после этого разрешает FULL-sync удаление operation
из ledger.

Crash после DELETE, но до durable clear, оставляет row `bound`: следующий parent
видит ID-404, повторяет installation-wide zero proof без второго DELETE и очищает
row. Непустой/невалидный final list, forged permit/outcome, replay, cross-endpoint,
потеря authority или concurrent cleanup сохраняют durable intent и дают code-only
ambiguity. Срез намеренно не активирует child/LIVE: multi-resource restricted
clone cleanup, active-path handoff, parent IPC/current-child binding и real-Docker
fault rehearsal остаются следующими воротами.

Fake Unix Engine/SQLite evidence: recovery broker 32/32, вместе с ledger
coordinator 84/84; workspace typecheck/build и полный серийный App regression
1652 passed / 17 skipped. Реальная сеть/Docker не использовались, LIVE importer
не добавлялся.

Финальный recovery→active переход больше не может опираться только на
структурный `scanInstallation()`. Старый reconciler теперь способен лишь
закончить очистку и оставляет ledger в recovery. Для активации caller передаёт
самому ledger genuine WeakSet-branded pinned broker, но никогда не получает
activation permit. Ledger проверяет brand и exact метод broker, внутренне
выпускает одноразовый permit и удерживает отдельный installation-wide barrier.
Pinned broker на одной socket generation выполняет `version → info → empty
containers (all=1) → empty networks`. После валидации последнего ответа broker
синхронно, без timer/reconnect или caller-controlled await, выпускает genuine
outcome и вызывает ledger-owned commit. Commit повторно проверяет recovery
epoch, endpoint, пустой ledger и в одной SQLite-транзакции увеличивает
generation и переводит manager в active.

Structural broker copy, forged/copy/Proxy/replay outcome, cross-ledger consume,
endpoint drift, pre-abort, непустой или malformed list оставляют manager в
recovery. Close, обычный reconcile и второй activation блокируются до terminal
результата. Успешный SQLite commit является точкой истины и только после него
ledger возвращает active epoch.

Этот срез по-прежнему dormant. Возвращённый active epoch сохраняет legacy
semantic command port только для совместимости существующего coordinator API;
он не является production authority Docker-команд. LIVE требует parent-owned
composition внутри manager/runtime fence ADR-0071, genuine active-path
inspect/cleanup authority, current-child IPC и real-Docker fault rehearsal.
Отдельный LIVE-gate обязан также доказать единственность canonical ledger/manager
lease для пары installation+endpoint между процессами: текущий in-process
activation barrier не объявляется cross-process lock для двух разных ledger.
Targeted fake-Engine/SQLite gate: recovery broker 43/43, вместе с ledger
coordinator 95/95; полный затронутый Docker/ledger gate 187/187; workspace
typecheck/build и полный последовательный App regression — 1663 passed / 17
skipped.

Следующий dormant-срез связывает уже принятые recovery-примитивы с жизненным
циклом parent supervisor, но ещё не выдаёт Docker authority child. Genuine
`NodeOwnedDockerParentRecoveryManager` открывает exact v4 ledger только внутри
удерживаемых manager lease и child-liveness fence ADR-0071. До чтения recovery
state он выполняет read-only preflight через pinned Docker session: на одной
socket generation проверяет exact `version`, `info` и bounded inspect, дожидается
drain и лишь затем сужает ledger из active в recovery. Этот переход сам не даёт
Docker authority. До первого child spawn manager последовательно закрывает
только поддержанный single-worker-container граф: безопасно отменяет полностью
`prepared` operation, для `attempted`
использует genuine pinned exact-inspect broker, для `bound` — genuine pinned
cleanup broker, затем genuine installation-zero activation broker. Каждый broker
одноразовый и создаётся заново из exact endpoint identity ledger; структурные
ports, CLI и caller-provided callbacks не становятся mutation authority.

Manager удерживает active ledger до своего terminal `close`, но не возвращает
наружу active epoch, raw ledger, Docker descriptor или endpoint path. Parent
supervisor принимает только genuine branded manager, вызывает recovery после
захвата обоих fence и до первого spawn, а при отказе/abort/lost authority
переходит в quarantine с нулём child spawn. `not-yet-visible`, неизвестный
resource graph, multi-resource operation, malformed ledger/Engine response и
любая неоднозначность не очищают соответствующий durable intent. Остановка
supervisor сначала гарантирует отсутствие child, затем закрывает manager и
ledger, после чего освобождает parent fences. Ошибка закрытия не маскируется
успешным `stopped`: parent завершается ошибкой, сохраняя fail-closed поведение
для следующего supervised restart.

Parent recovery manager теперь подключён к `bin/aisy.ts` через отдельный
code-owned production adapter с явным exact opt-in. Bootstrap отделён от LIVE:
оператор сначала выполняет `aisy docker enroll`, который создаёт private v4
ledger без child runtime и Docker mutation; `aisy supervise` после этого только
read-only загружает exact activation. Missing enrollment, partial config,
installation/daemon/socket drift и direct `aisy run` дают стабильный отказ до
child spawn. Все `AISY_OWNED_DOCKER_*` и `DOCKER_*` удаляются на child boundary.
`aisy doctor --only=sidecars` выполняет только read-only exact ledger load и
pinned `version → info → inspect` probe: он не enroll'ит, не ремонтирует, не
берёт writer lease и не отправляет Docker mutation.

LIVE здесь означает только startup recovery barrier: manager по-прежнему не
возвращает active epoch, child не получает Docker-команд, create/use и active
cleanup не подключены. Активация sidecar остаётся dormant до current-child
operation protocol, multi-resource recovery и real-Docker SIGKILL/restart
rehearsal. Снятие opt-in является rollback и не удаляет durable ledger.

Production activation gate: ledger load/enrollment, adapter, startup policy,
manager, supervisor и CLI doctor — 101/101; Core onboarding/doctor — 93/93;
полный Core — 2333 passed / 1 skipped, полный App — 2400 passed / 18
contract-defined skipped. App/Core typecheck и build зелёные. Канонический Vitest pool
исправлен на уже предусмотренные конфигурацией 1–4 forks: полный threads-прогон
проходил все тесты, но терял worker RPC на 10 000-operation CPU fixture, тогда
как два последовательных forks-прогона завершились без unhandled errors.

Проверка среза: manager/supervisor/recovery/IPC fault corpus — 205/205;
workspace typecheck/build зелёные; полный последовательный App regression —
1778 passed / 18 skipped. Первый полный прогон дал один timing timeout старого
orphan-child fixture; изолированный кейс, весь файл 10/10 и повторный полный
regression прошли без ошибок.

## Последствия

- **Положительные:** replacement не пересекается с daemon-owned effect старого
  runtime; ambiguous create и повторный reconcile становятся идемпотентными.
- **Нейтральные:** появляется отдельный private manifest/ledger и обязательный
  startup probe даже при пустом ledger.
- **Отрицательные:** после activation недоступность Docker блокирует весь
  supervised runtime до доказанной external quiescence, а неизвестный объект
  требует ручного расследования вместо auto-delete.

## Рассмотренные альтернативы

**Только process group или service-manager scope.** Docker daemon не входит в
эту OS-группу, поэтому вариант не закрывает внешний effect.

**Только `--rm` и cleanup в `finally`.** Клиент может завершиться до cleanup, а
работающий контейнер не обязан останавливаться при исчезновении Docker CLI.

**Отдельный durable intent journal рядом с ledger v3.** Два файла нельзя
атомарно перевести из intent в resource attempt одной SQLite-транзакцией;
авария создаёт неоднозначную комбинацию состояний, поэтому выбран единый v4.

**Удалять всё по префиксу имени.** Имя не является authority и допускает
удаление чужого либо переиспользованного объекта.

**Best-effort startup sweep.** Продолжение после неоднозначного inspect/remove
нарушает no-overlap, поэтому принято fail-closed поведение.

**Permanent per-operation tombstones.** Они запрещают replay, но линейно растут
всю жизнь установки и превращают list/recovery в availability risk.

**Retirement только по session generation.** Внутри одной generation прежний
operation ID всё ещё можно повторить; для надёжности снова требуются tombstones
либо rotation после каждой операции.

**Bounded tombstone epochs.** Безопасны только с периодическим stop-the-world,
drain и installation-wide zero proof. Ledger-owned sequence даёт те же свойства
без периодической остановки.

## Ссылки

- [ADR-0071 — Parent supervisor](./2026-07-29-execution-recovery-parent-supervisor.md)
- [ADR-0066 — Одноразовый sidecar для публичного clone](./2026-07-27-one-shot-sandbox-for-public-clone.md)
- [ADR-0085 — Провайдеры транскрипции](./2026-07-29-transcription-providers.md)
- [Docker Engine API reference](https://docs.docker.com/reference/api/engine/)
