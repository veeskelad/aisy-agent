FROM ubuntu@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea

ENV container=docker
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update -qq \
    && apt-get install -y -qq systemd python3.12 \
    && useradd --system --user-group --home-dir /nonexistent \
       --shell /usr/sbin/nologin aisy-voice-proxy

COPY packages/sidecars-py /usr/lib/aisy/voice-proxy/current
COPY packages/sidecars-py/tests/systemd/voice-proxy.json /etc/aisy/voice-proxy.json
COPY packages/sidecars-py/systemd/aisy-voice-broker.service /etc/systemd/system/
COPY packages/sidecars-py/systemd/aisy-voice-worker.socket /etc/systemd/system/
COPY packages/sidecars-py/systemd/aisy-voice-worker@.service /etc/systemd/system/

RUN chown -R root:root /usr/lib/aisy /etc/aisy /etc/systemd/system/aisy-voice-* \
    && chmod 0755 /usr/lib/aisy/voice-proxy/current/voice_proxy_service.py \
    && chmod 0644 /etc/aisy/voice-proxy.json /etc/systemd/system/aisy-voice-* \
    && mkdir -p -m 0700 /var/lib/aisy/voice \
    && printf 'disposable-test-value\n' \
       | systemd-creds encrypt --name=aisy-deepgram-cloud-primary - \
         /var/lib/aisy/voice/deepgram-cloud.primary.cred \
    && systemctl enable aisy-voice-broker.service aisy-voice-worker.socket

STOPSIGNAL SIGRTMIN+3
CMD ["/usr/lib/systemd/systemd"]
