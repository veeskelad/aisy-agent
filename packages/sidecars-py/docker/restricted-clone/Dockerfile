# syntax=docker/dockerfile:1

ARG PYTHON_BASE_IMAGE
ARG CLONE_BASE_IMAGE
FROM ${PYTHON_BASE_IMAGE} AS gateway
COPY aisy_sidecars/restricted_clone_egress.py /opt/aisy/restricted_clone_egress.py
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    PYTHONSAFEPATH=1
USER 65532:65532
ENTRYPOINT ["python3", "/opt/aisy/restricted_clone_egress.py"]
CMD ["serve"]

FROM ${CLONE_BASE_IMAGE} AS worker
COPY aisy_sidecars/restricted_clone_worker.py /opt/aisy/restricted_clone_worker.py
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    PYTHONSAFEPATH=1
USER 65532:65532
ENTRYPOINT ["python3", "/opt/aisy/restricted_clone_worker.py"]
