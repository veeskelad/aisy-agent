#define _GNU_SOURCE
#include <node_api.h>

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef __linux__
#include <fcntl.h>
#include <pthread.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

#define AISY_MAX_REQUEST (64U * 1024U)
#define AISY_MAX_RESPONSE ((1024U * 1024U) + 4096U)

static napi_value fail(napi_env env, const char *code) {
  napi_throw_error(env, code, code);
  return NULL;
}

#ifndef __linux__
static napi_value unsupported(napi_env env, napi_callback_info info) {
  (void)info;
  return fail(env, "VOICE_BRIDGE_LINUX_REQUIRED");
}
#else

typedef struct {
  int fd;
  pid_t owner_pid;
  pid_t broker_pid;
  uid_t broker_uid;
  pthread_mutex_t lock;
  int busy;
  int closed;
} aisy_session;

typedef struct {
  napi_env env;
  napi_async_work work;
  napi_deferred deferred;
  aisy_session *session;
  char *request;
  size_t request_len;
  int media_fd;
  size_t max_response;
  char *response;
  size_t response_len;
  const char *error_code;
} exchange_work;

static int cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  return flags >= 0 && (flags & FD_CLOEXEC) != 0;
}

static void close_session(aisy_session *session) {
  pthread_mutex_lock(&session->lock);
  if (!session->closed && session->fd >= 0) close(session->fd);
  session->fd = -1;
  session->closed = 1;
  pthread_mutex_unlock(&session->lock);
}

static void finalize_session(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  aisy_session *session = data;
  close_session(session);
  pthread_mutex_destroy(&session->lock);
  free(session);
}

static int exact_int32(napi_env env, napi_value value, int32_t *out) {
  napi_valuetype type;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_number &&
    napi_get_value_int32(env, value, out) == napi_ok;
}

static char *exact_string(napi_env env, napi_value value, size_t maximum, size_t *length) {
  napi_valuetype type;
  size_t bytes = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, &bytes) != napi_ok ||
      bytes == 0 || bytes > maximum) return NULL;
  char *text = calloc(bytes + 1, 1);
  if (text == NULL || napi_get_value_string_utf8(env, value, text, bytes + 1, length) != napi_ok ||
      *length != bytes || memchr(text, '\0', bytes) != NULL) {
    free(text);
    return NULL;
  }
  return text;
}

static int receive_private_fd(int bootstrap, uid_t expected_uid, pid_t expected_pid,
                              pid_t *broker_pid, int *private_fd) {
  char payload = 0;
  struct iovec iov = { .iov_base = &payload, .iov_len = 1 };
  char control[CMSG_SPACE(sizeof(int))];
  memset(control, 0, sizeof(control));
  struct msghdr message = {0};
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  message.msg_control = control;
  message.msg_controllen = sizeof(control);
  ssize_t received = recvmsg(bootstrap, &message, MSG_CMSG_CLOEXEC);
  if (received != 1 || payload != 'A' || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) != 0) return -1;
  int count = 0;
  int received_fd = -1;
  for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header != NULL;
       header = CMSG_NXTHDR(&message, header)) {
    if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS) {
      size_t fd_count = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int);
      int *fds = (int *)CMSG_DATA(header);
      if (fd_count == 1 && count == 0) {
        received_fd = fds[0];
        count = 1;
      } else {
        for (size_t index = 0; index < fd_count; index++) close(fds[index]);
        if (received_fd >= 0) close(received_fd);
        return -1;
      }
    } else {
      if (received_fd >= 0) close(received_fd);
      return -1;
    }
  }
  if (count != 1 || received_fd < 0 || !cloexec(received_fd)) {
    if (received_fd >= 0) close(received_fd);
    return -1;
  }
  struct ucred peer;
  socklen_t peer_len = sizeof(peer);
  if (getsockopt(received_fd, SOL_SOCKET, SO_PEERCRED, &peer, &peer_len) != 0 ||
      peer_len != sizeof(peer) || peer.uid != expected_uid ||
      (expected_pid > 0 && peer.pid != expected_pid)) {
    close(received_fd);
    return -1;
  }
  int enabled = 1;
  if (setsockopt(received_fd, SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0) {
    close(received_fd);
    return -1;
  }
  int socket_type = 0;
  socklen_t option_len = sizeof(socket_type);
  if (getsockopt(received_fd, SOL_SOCKET, SO_TYPE, &socket_type, &option_len) != 0 ||
      option_len != sizeof(socket_type) || socket_type != SOCK_SEQPACKET ||
      getsockopt(received_fd, SOL_SOCKET, SO_PASSCRED, &enabled, &option_len) != 0 ||
      option_len != sizeof(enabled) || enabled != 1) {
    close(received_fd);
    return -1;
  }
  *broker_pid = peer.pid;
  *private_fd = received_fd;
  return 0;
}

static napi_value open_bridge(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3) {
    return fail(env, "VOICE_BRIDGE_INVALID_ARGUMENT");
  }
  size_t path_len = 0;
  char *path = exact_string(env, argv[0], sizeof(((struct sockaddr_un *)0)->sun_path) - 1, &path_len);
  int32_t expected_uid = -1;
  int32_t expected_pid = -1;
  if (path == NULL || path[0] != '/' || !exact_int32(env, argv[1], &expected_uid) ||
      !exact_int32(env, argv[2], &expected_pid) || expected_uid < 0 || expected_pid < 0) {
    free(path);
    return fail(env, "VOICE_BRIDGE_INVALID_ARGUMENT");
  }
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    free(path);
    return fail(env, "VOICE_BRIDGE_DUMPABLE_REFUSED");
  }
  int bootstrap = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  if (bootstrap < 0 || !cloexec(bootstrap)) {
    if (bootstrap >= 0) close(bootstrap);
    free(path);
    return fail(env, "VOICE_BRIDGE_CONNECT_FAILED");
  }
  struct timeval timeout = { .tv_sec = 2, .tv_usec = 0 };
  (void)setsockopt(bootstrap, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  (void)setsockopt(bootstrap, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, path, path_len + 1);
  free(path);
  if (connect(bootstrap, (struct sockaddr *)&address,
              (socklen_t)(offsetof(struct sockaddr_un, sun_path) + path_len + 1)) != 0) {
    close(bootstrap);
    return fail(env, "VOICE_BRIDGE_CONNECT_FAILED");
  }
  int private_fd = -1;
  pid_t broker_pid = -1;
  int status = receive_private_fd(bootstrap, (uid_t)expected_uid, (pid_t)expected_pid,
                                  &broker_pid, &private_fd);
  close(bootstrap);
  if (status != 0) return fail(env, "VOICE_BRIDGE_HANDSHAKE_REFUSED");
  aisy_session *session = calloc(1, sizeof(*session));
  if (session == NULL) {
    close(private_fd);
    return fail(env, "VOICE_BRIDGE_ALLOCATION_FAILED");
  }
  session->fd = private_fd;
  session->owner_pid = getpid();
  session->broker_pid = broker_pid;
  session->broker_uid = (uid_t)expected_uid;
  pthread_mutex_init(&session->lock, NULL);
  napi_value external;
  if (napi_create_external(env, session, finalize_session, NULL, &external) != napi_ok) {
    finalize_session(env, session, NULL);
    return fail(env, "VOICE_BRIDGE_ALLOCATION_FAILED");
  }
  return external;
}

static int send_packet(exchange_work *work) {
  if (work->media_fd >= 0 && !cloexec(work->media_fd)) return -1;
  struct iovec iov = { .iov_base = work->request, .iov_len = work->request_len };
  char control[CMSG_SPACE(sizeof(int))];
  struct msghdr message = {0};
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  if (work->media_fd >= 0) {
    memset(control, 0, sizeof(control));
    message.msg_control = control;
    message.msg_controllen = sizeof(control);
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &work->media_fd, sizeof(int));
  }
  return sendmsg(work->session->fd, &message, MSG_NOSIGNAL) == (ssize_t)work->request_len ? 0 : -1;
}

static int receive_packet(exchange_work *work) {
  work->response = calloc(work->max_response + 1, 1);
  if (work->response == NULL) return -1;
  struct iovec iov = { .iov_base = work->response, .iov_len = work->max_response + 1 };
  char control[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(sizeof(int))];
  memset(control, 0, sizeof(control));
  struct msghdr message = {0};
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  message.msg_control = control;
  message.msg_controllen = sizeof(control);
  ssize_t received = recvmsg(work->session->fd, &message, MSG_CMSG_CLOEXEC);
  if (received <= 0 || (size_t)received > work->max_response ||
      (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) != 0) return -1;
  int credentials = 0;
  for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header != NULL;
       header = CMSG_NXTHDR(&message, header)) {
    if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_CREDENTIALS &&
        header->cmsg_len == CMSG_LEN(sizeof(struct ucred))) {
      struct ucred peer;
      memcpy(&peer, CMSG_DATA(header), sizeof(peer));
      if (peer.pid != work->session->broker_pid || peer.uid != work->session->broker_uid) return -1;
      credentials++;
    } else if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS) {
      size_t count = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int);
      int *fds = (int *)CMSG_DATA(header);
      for (size_t index = 0; index < count; index++) close(fds[index]);
      return -1;
    } else return -1;
  }
  if (credentials != 1 || memchr(work->response, '\0', (size_t)received) != NULL) return -1;
  work->response_len = (size_t)received;
  return 0;
}

static void execute_exchange(napi_env env, void *data) {
  (void)env;
  exchange_work *work = data;
  aisy_session *session = work->session;
  pthread_mutex_lock(&session->lock);
  if (session->closed || session->fd < 0 || session->owner_pid != getpid()) {
    work->error_code = "VOICE_BRIDGE_SESSION_LOST";
  } else if (send_packet(work) != 0 || receive_packet(work) != 0) {
    work->error_code = "VOICE_BRIDGE_EXCHANGE_FAILED";
    close(session->fd);
    session->fd = -1;
    session->closed = 1;
  }
  session->busy = 0;
  pthread_mutex_unlock(&session->lock);
}

static void complete_exchange(napi_env env, napi_status status, void *data) {
  exchange_work *work = data;
  if (status != napi_ok || work->error_code != NULL) {
    napi_value error;
    const char *code = work->error_code != NULL ? work->error_code : "VOICE_BRIDGE_EXCHANGE_FAILED";
    napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &error);
    napi_reject_deferred(env, work->deferred, error);
  } else {
    napi_value response;
    napi_create_string_utf8(env, work->response, work->response_len, &response);
    napi_resolve_deferred(env, work->deferred, response);
  }
  napi_delete_async_work(env, work->work);
  free(work->request);
  free(work->response);
  free(work);
}

static napi_value exchange(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4) {
    return fail(env, "VOICE_BRIDGE_INVALID_ARGUMENT");
  }
  aisy_session *session = NULL;
  int32_t media_fd = -1;
  int32_t maximum = 0;
  size_t request_len = 0;
  char *request = exact_string(env, argv[1], AISY_MAX_REQUEST, &request_len);
  if (napi_get_value_external(env, argv[0], (void **)&session) != napi_ok || session == NULL ||
      request == NULL || !exact_int32(env, argv[2], &media_fd) || media_fd < -1 ||
      !exact_int32(env, argv[3], &maximum) || maximum < 1 || maximum > (int32_t)AISY_MAX_RESPONSE) {
    free(request);
    return fail(env, "VOICE_BRIDGE_INVALID_ARGUMENT");
  }
  pthread_mutex_lock(&session->lock);
  if (session->busy || session->closed || session->fd < 0 || session->owner_pid != getpid()) {
    pthread_mutex_unlock(&session->lock);
    free(request);
    return fail(env, "VOICE_BRIDGE_SESSION_BUSY");
  }
  session->busy = 1;
  pthread_mutex_unlock(&session->lock);
  exchange_work *work = calloc(1, sizeof(*work));
  if (work == NULL) {
    pthread_mutex_lock(&session->lock);
    session->busy = 0;
    pthread_mutex_unlock(&session->lock);
    free(request);
    return fail(env, "VOICE_BRIDGE_ALLOCATION_FAILED");
  }
  work->env = env;
  work->session = session;
  work->request = request;
  work->request_len = request_len;
  work->media_fd = media_fd;
  work->max_response = (size_t)maximum;
  napi_value promise;
  napi_value name;
  napi_create_promise(env, &work->deferred, &promise);
  napi_create_string_utf8(env, "aisyVoiceBrokerExchange", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, NULL, name, execute_exchange, complete_exchange, work,
                             &work->work) != napi_ok) {
    pthread_mutex_lock(&session->lock);
    session->busy = 0;
    pthread_mutex_unlock(&session->lock);
    free(request);
    free(work);
    return fail(env, "VOICE_BRIDGE_ALLOCATION_FAILED");
  }
  if (napi_queue_async_work(env, work->work) != napi_ok) {
    napi_delete_async_work(env, work->work);
    pthread_mutex_lock(&session->lock);
    session->busy = 0;
    pthread_mutex_unlock(&session->lock);
    free(request);
    free(work);
    return fail(env, "VOICE_BRIDGE_ALLOCATION_FAILED");
  }
  return promise;
}

static napi_value held(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  aisy_session *session = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_external(env, argv[0], (void **)&session) != napi_ok || session == NULL) {
    return fail(env, "VOICE_BRIDGE_INVALID_ARGUMENT");
  }
  pthread_mutex_lock(&session->lock);
  int value = !session->closed && session->fd >= 0 && session->owner_pid == getpid();
  pthread_mutex_unlock(&session->lock);
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

static napi_value close_bridge(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  aisy_session *session = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_external(env, argv[0], (void **)&session) != napi_ok || session == NULL) {
    return fail(env, "VOICE_BRIDGE_INVALID_ARGUMENT");
  }
  pthread_mutex_lock(&session->lock);
  if (session->busy) {
    pthread_mutex_unlock(&session->lock);
    return fail(env, "VOICE_BRIDGE_SESSION_BUSY");
  }
  pthread_mutex_unlock(&session->lock);
  close_session(session);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

#endif

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
#ifdef __linux__
    { "open", NULL, open_bridge, NULL, NULL, NULL, napi_default, NULL },
    { "exchange", NULL, exchange, NULL, NULL, NULL, napi_default, NULL },
    { "isHeld", NULL, held, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, close_bridge, NULL, NULL, NULL, napi_default, NULL },
#else
    { "open", NULL, unsupported, NULL, NULL, NULL, napi_default, NULL },
    { "exchange", NULL, unsupported, NULL, NULL, NULL, napi_default, NULL },
    { "isHeld", NULL, unsupported, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, unsupported, NULL, NULL, NULL, napi_default, NULL },
#endif
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
