# Предложение решения: воспроизводимый образ Whisper

**Дата проверки:** 2026-07-28  
**Статус:** рекомендация для согласования; это не принятый ADR  
**Publish/live activation:** запрещены в рамках предложения

## Контекст

Offline worker и Docker supervisor уже требуют локальную модель
`/models/whisper`, exact digest-qualified image, `--pull=never`, отсутствие
сети, read-only rootfs, non-root user и обязательный cleanup. Однако production
образа пока нет: `packages/sidecars-py/pyproject.toml` не содержит runtime
dependencies, `uv.lock` фиксирует только dev graph, а model files не имеют
репозиторного supply-chain manifest.

Это архитектурное решение, а не тактический Dockerfile: оно выбирает ASR model,
native runtime, лицензии, multi-arch distribution и новый публикуемый артефакт,
тем самым частично пересматривая ADR-0056, где Python voice image был отложен.

## Проверенные факты

- `faster-whisper 1.2.1` — текущий stable PyPI release, MIT; SHA-256 wheel:
  `79a66ad50688c0b794dd501dc340a736992a6342f7f95e5811be60b5224a26a7`.
- Его metadata требует `ctranslate2>=4,<5`, `av>=11`,
  `onnxruntime>=1.14,<2`, `huggingface-hub>=0.21`, `tokenizers>=0.13,<1` и
  `tqdm`.
- Временный `uv lock` для Python 3.12 с exact
  `faster-whisper==1.2.1`, `ctranslate2==4.8.1`, `av==18.0.0` разрешился в
  26 exact packages; для Linux amd64 и arm64 доступны native wheels
  CTranslate2 4.8.1, PyAV 18.0.0 и ONNX Runtime 1.28.0.
- CTranslate2 4.8.1 — MIT; release исправляет heap overflow при model load и
  process-killing divide-by-zero в Whisper align path.
- PyAV 18.0.0 — BSD-3-Clause и включает FFmpeg libraries в wheels; отдельный
  host `ffmpeg` для этого backend не нужен.
- `Systran/faster-whisper-small` revision
  `2ec96c5472da50d38d40c0cfe0602af2e94b4c8a` — multilingual model с русским
  языком, MIT, около 486 MiB. Exact LFS SHA-256 `model.bin`:
  `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671`.
- Официальный benchmark для `small`, CPU/int8 показывает около 1477 MiB RAM;
  текущий лимит 2 GiB оставляет слишком малый запас для PyAV, VAD и allocator.

## Варианты

| Вариант | Качество/языки | Supply chain | Runtime cost | Вывод |
|---|---|---|---|---|
| A. `faster-whisper-small`, CPU/int8, модель внутри image | multilingual, включая русский; приемлемый default для voice | exact model revision + file hashes + exact wheels | ~486 MiB model, baseline RAM выше 1.5 GiB | **Рекомендуется** |
| B. `faster-whisper-base`, CPU/int8 | легче и быстрее, но ниже точность на шумной/русской речи | такой же | меньше image/RAM | допустимый будущий low-resource profile |
| C. Host-mounted model | качество A | image digest больше не аттестует model bytes; mount расширяет runtime policy | меньше image | отклонить |
| D. Download model при первом запросе | качество A | floating remote state, сеть и partial cache в runtime | непредсказуемо | отклонить |
| E. GPU/CUDA image | выше throughput | CUDA/cuDNN base и driver compatibility | существенно больше image/VRAM | отложить отдельным ADR |
| F. Только provider transcription | без локального image | аудио покидает host и зависит от provider | проще локально | оставить отдельной opt-in capability, не заменять private local path |

## Рекомендация

Принять вариант A со следующими обязательными границами.

1. **Profile:** CPU-only, Python 3.12, `faster-whisper-small`, `device=cpu`,
   `compute_type=int8`, multilingual. GPU и model switching не входят в первый
   production image.
2. **Exact model:** repository + commit выше; в build context попадают только
   allowlisted files. Для каждого файла публикуется committed SHA-256 manifest;
   commit id без file digests недостаточен.
3. **Exact dependencies:** отдельная runtime dependency group и `uv.lock`.
   Production build использует только wheels с lock hashes и запрещает source
   builds. Первые кандидаты — faster-whisper 1.2.1, CTranslate2 4.8.1,
   PyAV 18.0.0; весь resolved graph фиксируется exact versions/hashes.
4. **Exact base:** официальный CPython 3.12 slim/glibc image только как
   `name@sha256:<manifest-digest>`; platform image digests для `linux/amd64` и
   `linux/arm64` записываются в build manifest. Floating tags запрещены.
5. **Двухфазная supply chain:** networked fetch job получает exact wheels и
   model revision во временный staging area и проверяет hashes. Docker build
   затем идёт с `--network=none`, `--pull=false` из уже проверенных bytes.
   Secrets, Hub tokens и package credentials в build args/layers запрещены.
6. **Минимальный final image:** только Python runtime, locked wheels,
   `whisper_worker.py`, `confinement_worker.py` и model files; без compiler,
   Git/curl и uv/pip cache. Нужный faster-whisper transitive
   `huggingface-hub` остаётся установлен, но без token/config/cache, при
   `network=none`, `HF_HUB_OFFLINE=1` и `TRANSFORMERS_OFFLINE=1`. User —
   `65532:65532`; entrypoint — direct one-shot worker. Bounded
   `OMP_NUM_THREADS` закрепляется кодом image/runtime policy.
7. **Multi-arch:** amd64 и arm64 строятся независимо из одного source/model
   manifest. Каждый platform image получает свой immutable digest; общий OCI
   index публикуется только после равных conformance gates.
8. **Provenance:** BuildKit provenance `mode=max`, SBOM и OCI labels для source
   revision, lock digest, model repository/revision/manifest digest и licenses.
   Release принимает только digest-qualified reference; tag не является
   authority.
9. **Resource baseline:** до реального Linux benchmark начать с 3 GiB RAM,
   2 CPU, 64 PID и wall timeout до 600 s. Активация требует benchmark на
   целевом host; уменьшение лимитов возможно только по measured peak + запасу,
   а не по успешному короткому fixture.
10. **Distribution:** npm остаётся primary distribution Aisy. Whisper image —
    optional companion artifact. Его workflow/publish и registry выбираются
    отдельно; никакой image не публикуется самим ADR.

## Обязательные проверки до publish

1. `uv lock --check` и offline install из wheelhouse проходят для amd64/arm64;
   source distribution либо незахэшированный файл блокируют build.
2. Model manifest проверяет exact набор путей, size и SHA-256 до `COPY`; лишний,
   отсутствующий или изменённый файл блокирует build.
3. Внутри final image импортируются faster-whisper/PyAV/ONNX Runtime, model
   загружается только из `/models/whisper`, а outbound network не требуется.
4. Golden Russian voice fixture транскрибируется в обоих platform images с
   bounded quality assertion; malformed/media fuzz остаются code-only errors.
5. Inspect/history доказывают non-root, отсутствие secrets, downloader/build
   tools и writable model path; runtime supervisor повторно доказывает
   `network=none`, read-only rootfs и exact image digest до stdin.
6. Реальные Docker tests на Linux доказывают timeout, OOM, abort, ambiguous
   create, mandatory cleanup и single-flight; gVisor проверяется отдельно там,
   где host его поддерживает.
7. SBOM/license scan и vulnerability scan не имеют unresolved critical/high
   findings либо содержат отдельно согласованное exception с expiry.
8. `aisy doctor` при disabled voice работает без Docker mutation; при будущем
   enablement проверяет локальный exact RepoDigest и model/lock provenance без
   раскрытия image reference в публичный diagnostic output.

## Rollback и не-цели

- До activation rollback равен отсутствию voice composition в `aisy.ts`; image
  build artifacts не дают runtime authority.
- После activation rollback должен выключать feature gate и сохранять inbox
  objects/recovery evidence; удаление image или media данных не выполняется.
- В это решение не входят live wiring, registry credentials, publish, GPU,
  provider audio upload, queue semantics и выбор `reject|text-only` default.

## Запрашиваемое решение

Согласовать либо отклонить вариант A. После согласования следует создать
русский MADR 3.0 ADR, обновить `docs/decisions/INDEX.md`, затем реализовать
lock/model manifest/Dockerfile/offline build tests. Publish и live activation
останутся отдельными подтверждениями.

## Официальные источники

- [faster-whisper 1.2.1](https://pypi.org/project/faster-whisper/1.2.1/)
- [faster-whisper benchmark и CPU/int8](https://github.com/SYSTRAN/faster-whisper)
- [CTranslate2 4.8.1 changelog](https://github.com/OpenNMT/CTranslate2/blob/master/CHANGELOG.md)
- [CTranslate2 wheels](https://pypi.org/project/ctranslate2/)
- [PyAV 18.0.0](https://pypi.org/project/av/)
- [exact faster-whisper-small revision](https://huggingface.co/Systran/faster-whisper-small/tree/2ec96c5472da50d38d40c0cfe0602af2e94b4c8a)
