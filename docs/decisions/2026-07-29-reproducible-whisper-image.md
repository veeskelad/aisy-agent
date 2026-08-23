# ADR-0072: Воспроизводимый CPU-образ Whisper для голосового ввода

**Статус:** Принято
**Дата:** 2026-07-29
**Теги:** media, supply-chain, security

## Контекст

Offline-worker и одноразовый Docker-supervisor уже требуют локальную модель
`/models/whisper`, digest-qualified образ, `--pull=never`, отсутствие сети,
read-only rootfs, non-root пользователя и обязательный cleanup. Самого
production-образа при этом нет: `packages/sidecars-py/pyproject.toml` не
содержит runtime-зависимостей, `uv.lock` фиксирует только dev-граф, а файлы
модели не имеют supply-chain manifest в репозитории.

Это архитектурное решение, а не тактический Dockerfile: выбираются ASR-модель,
native runtime, лицензии, multi-arch дистрибуция и новый публикуемый артефакт —
тем самым частично пересматривается ADR-0056, где Python voice image был
отложен.

Проверенные факты: `faster-whisper 1.2.1` (MIT) требует `ctranslate2>=4,<5`,
`av>=11`, `onnxruntime>=1.14,<2`, `huggingface-hub>=0.21`, `tokenizers>=0.13,<1`
и `tqdm`; временный `uv lock` для Python 3.12 разрешается в 26 exact-пакетов с
native wheels для amd64 и arm64. Модель `Systran/faster-whisper-small` (MIT,
~486 MiB) поддерживает русский язык. Официальный benchmark `small` на CPU/int8
показывает около 1477 MiB RAM, поэтому текущий лимит 2 GiB оставляет слишком
малый запас.

## Решение

Принимается профиль **CPU-only `faster-whisper-small`, модель внутри образа**
со следующими обязательными границами.

1. **Профиль:** Python 3.12, `device=cpu`, `compute_type=int8`, multilingual.
   GPU и переключение моделей в первый production-образ не входят.
2. **Точная модель:** exact repository и commit; в build context попадают только
   allowlisted файлы, и для каждого публикуется committed SHA-256 manifest —
   commit id без file digests недостаточен.
3. **Точные зависимости:** отдельная runtime-группа и `uv.lock`; production
   build использует только wheels с lock hashes и запрещает source builds.
4. **Точная база:** официальный CPython 3.12 slim только как
   `name@sha256:<manifest-digest>`; platform digests для `linux/amd64` и
   `linux/arm64` фиксируются в build manifest, floating tags запрещены.
5. **Двухфазная supply chain:** networked fetch job складывает wheels и модель в
   staging и проверяет hashes; сам build идёт с `--network=none` и
   `--pull=false` из уже проверенных байтов. Secrets, Hub-токены и credentials
   в build args и слоях запрещены.
6. **Минимальный финальный образ:** только Python runtime, locked wheels,
   worker-скрипты и файлы модели; без компилятора, Git, curl и кэшей.
   `huggingface-hub` остаётся как транзитивная зависимость, но без токена и
   кэша, при `HF_HUB_OFFLINE=1` и `TRANSFORMERS_OFFLINE=1`. Пользователь —
   `65532:65532`, entrypoint — прямой one-shot worker, `OMP_NUM_THREADS`
   ограничен политикой образа и runtime.
7. **Multi-arch:** amd64 и arm64 собираются независимо из одного source/model
   manifest; общий OCI index публикуется только после равных conformance gates.
8. **Provenance:** BuildKit provenance `mode=max`, SBOM и OCI labels для
   source revision, lock digest, model repository/revision/manifest digest и
   лицензий. Release принимает только digest-qualified reference; tag не
   является authority.
9. **Ресурсы:** стартовый baseline — 3 GiB RAM, 2 CPU, 64 PID и wall timeout до
   600 с. Снижение лимитов допустимо только по measured peak с запасом, а не по
   успешному короткому fixture.
10. **Дистрибуция:** npm остаётся основным каналом Aisy; образ Whisper —
    опциональный companion-артефакт. Сам ADR ничего не публикует.

## Обязательные проверки до публикации

`uv lock --check` и offline-установка из wheelhouse для обеих архитектур; сверка
model manifest по путям, размерам и SHA-256 до `COPY`; загрузка модели только из
`/models/whisper` без outbound-сети; golden-фикстура русской речи с bounded
quality assertion в обоих образах; доказательство non-root, отсутствия secrets и
build-инструментов; реальные Docker-тесты timeout, OOM, abort, ambiguous create,
обязательного cleanup и single-flight на Linux; SBOM, license- и
vulnerability-скан без нерешённых critical/high; `aisy doctor` при выключенном
голосе не мутирует Docker.

## Последствия

- **Положительные:** байты модели аттестуются digest образа; сборка
  воспроизводима и не зависит от сети; приватная локальная транскрипция не
  требует отправки аудио наружу.
- **Нейтральные:** появляется второй публикуемый артефакт со своим жизненным
  циклом и multi-arch сборкой; baseline памяти вырастает до 3 GiB.
- **Отрицательные:** образ тяжёлый (~486 MiB только модель), а обновление
  модели или зависимостей требует полного повторения supply-chain процедуры.

## Рассмотренные альтернативы

**`faster-whisper-base`.** Легче и быстрее, но заметно хуже на шумной и русской
речи; остаётся допустимым будущим low-resource профилем.

**Модель, примонтированная с хоста.** Меньше образ, но digest перестаёт
аттестовать байты модели, а mount расширяет runtime policy — отклонено.

**Скачивание модели при первом запросе.** Вносит floating remote state, сеть и
частичный кэш в runtime — отклонено.

**GPU/CUDA-образ.** Выше пропускная способность ценой CUDA/cuDNN базы и
совместимости драйверов — отложено отдельным решением.

**Только provider-транскрипция.** Проще локально, но аудио покидает хост;
остаётся отдельной opt-in возможностью, а не заменой приватного пути.

## Ссылки

- Предложение: [Воспроизводимый образ Whisper](../reviews/2026-07-28-whisper-image-supply-decision-proposal.md)
- Спецификация: [02-gateway-connectivity.md](../specs/02-gateway-connectivity.md)
- Дополняет: [ADR-0056](./2026-06-24-npm-package-distribution.md) — npm остаётся основным каналом, образ Whisper публикуется отдельно
- Связано: [ADR-0066](./2026-07-27-one-shot-sandbox-for-public-clone.md) — та же модель одноразового изолированного sidecar
