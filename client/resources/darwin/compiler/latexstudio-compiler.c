/*
 * latexstudio-compiler: sandboxed TeX session helper for LatexStudio on macOS.
 *
 * The app (not sandboxed) starts this program, which is signed with the App Sandbox entitlement and nothing else.
 * The project snapshot arrives over stdin, is written into a private work directory inside this program's own sandbox
 * container, the pinned TeX tools run there as children (which inherit the sandbox), and the results go back over
 * stdout. No directory of the user is ever granted to the sandbox.
 *
 * Fail closed: every protocol or policy violation ends the session; TeX never runs when this process is not
 * sandboxed; losing stdin (the app crashed or was killed) kills the running tool's process group at once.
 *
 * Protocol 1. Every frame starts with one ASCII header line; payload lengths are given in the header.
 *   app -> helper   MKDIR <pathlen>              + path
 *                   PUT <pathlen> <datalen>      + path + data      (only before the first RUN)
 *                   RUN <tool> <argslen>         + NUL-terminated arguments
 *                   GET <namelen>                + name             (a file of the fixed output folder)
 *                   PROBE <kind> <arglen>        + argument         (read | write | connect | exec-read)
 *                   CANCEL                                          (only while a tool runs)
 *                   CLOSE
 *   helper -> app   READY <protocol> <sandboxed> <pathlen> + snapshot root as the tools see it
 *                   OK | ERR <code> (then the helper exits) | STARTED <pgid> | OUT <1|2> <len> + data | EXIT <code>
 *                   FILE <len> + data | NONE | PROBE <allowed|denied> <errno> | CLOSED <0|1>
 *   EXIT codes: 124 time limit, 125 canceled, 126 output or disk limit, 127 could not start, 128+n killed by signal n.
 *
 * One helper at a time owns the container: a lock is taken before READY and work folders left behind by a session
 * that ended abnormally are removed first, so a later document can never read an earlier project's snapshot.
 */
#include <sys/types.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define PROTOCOL 1
#define MAX_HEADER 256
#define MAX_PATH_BYTES 1024
#define MAX_FILE_BYTES (64LL << 20)
#define MAX_TOTAL_BYTES (192LL << 20)
#define MAX_ENTRIES 20000
#define MAX_ARGS 64
#define MAX_ARG_BYTES 2048
#define MAX_OUTPUT_BYTES (2LL << 20)
/* Everything in the work folder (snapshot + whatever the tools wrote), checked while a tool runs. */
#ifndef MAX_WORK_BYTES /* lowered only by the logic check, to reach the limit quickly */
#define MAX_WORK_BYTES (512LL << 20)
#endif
#define MAX_WORK_ENTRIES 40000
#define LOCK_WAIT_TENTHS 300
#define OUTPUT_DIR ".paperstudio-output"
#define TOOL_DIR "bin/universal-darwin"
#define ENV_SLOTS 32
/* Only acceptance testing overrides this, to get a helper with identical behaviour but a different signature. */
#ifndef PAPERSTUDIO_VARIANT
#define PAPERSTUDIO_VARIANT 1
#endif

/* libsystem_sandbox: non-zero when the process runs inside a sandbox. Weak, so a system without it still loads. */
extern int sandbox_check(pid_t pid, const char *operation, int type, ...) __attribute__((weak_import));

static char g_tex[PATH_MAX], g_overlay[PATH_MAX], g_work[PATH_MAX], g_source[PATH_MAX + 16], g_home[PATH_MAX + 16];
/* Short stand-ins (links in the work folder) for the two TeX trees. XeTeX writes each font's absolute path into its
 * output with a ONE-BYTE length, so under a long install path (measured: a freshly packaged app, 277 bytes) the
 * converter is handed a cut-off name. Paths built from these stay short wherever the app is installed. */
static char g_tex_alias[PATH_MAX + 16], g_overlay_alias[PATH_MAX + 16];
static char g_env_text[ENV_SLOTS][PATH_MAX * 2 + 64];
static char *g_env[ENV_SLOTS + 1];
static char g_pending[MAX_HEADER]; /* a request line read so far; shared by the idle reader and the run loop */
static size_t g_pending_used;
static long long g_deadline_ms, g_timeout_ms, g_put_bytes, g_output_bytes, g_usage_bytes;
static int g_sandboxed, g_ran, g_entries, g_close_requested, g_usage_entries;
static volatile pid_t g_child;

static long long now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (long long)t.tv_sec * 1000LL + t.tv_nsec / 1000000;
}

static int remove_entry(const char *path, const struct stat *info, int type, struct FTW *walk) {
  (void)info; (void)type; (void)walk;
  remove(path); /* keep walking after a failure; the caller checks that the root is really gone */
  return 0;
}

/* Returns 1 only when the whole work directory is gone. */
static int remove_work(void) {
  struct stat info;
  if (!g_work[0]) return 1;
  nftw(g_work, remove_entry, 32, FTW_DEPTH | FTW_PHYS);
  return lstat(g_work, &info) != 0 && errno == ENOENT;
}

static void kill_tool(void) {
  if (g_child > 0) kill(-g_child, SIGKILL);
}

/* Ends the helper without a CLOSED frame: the app must treat cleanup as unconfirmed. */
static void terminate(int code) {
  kill_tool();
  if (g_child > 0) waitpid(g_child, NULL, 0);
  remove_work();
  _exit(code);
}

static void write_full(int fd, const void *data, size_t length) {
  const char *bytes = data;
  while (length > 0) {
    ssize_t written = write(fd, bytes, length);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) terminate(3);
    bytes += written; length -= (size_t)written;
  }
}

static void sendf(const char *format, ...) {
  char line[MAX_HEADER];
  va_list args;
  va_start(args, format);
  int length = vsnprintf(line, sizeof line, format, args);
  va_end(args);
  if (length < 0 || length >= (int)sizeof line) terminate(2);
  write_full(STDOUT_FILENO, line, (size_t)length);
}

static void fatal(const char *code) {
  sendf("ERR %s\n", code);
  terminate(2);
}

/* Reads exactly `length` bytes of stdin. End of input means the app is gone. */
static void read_full(void *data, size_t length) {
  char *bytes = data;
  while (length > 0) {
    ssize_t received = read(STDIN_FILENO, bytes, length);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) terminate(3);
    bytes += received; length -= (size_t)received;
  }
}

/* Waits for one header line; the session time limit also bounds an idle helper. */
static void read_header(char *line, size_t size) {
  for (;;) {
    struct pollfd input = { STDIN_FILENO, POLLIN, 0 };
    long long left = g_deadline_ms + 30000 - now_ms();
    if (left <= 0) terminate(4);
    int ready = poll(&input, 1, left > 1000 ? 1000 : (int)left);
    if (ready < 0 && errno != EINTR) terminate(3);
    if (ready <= 0) continue;
    char byte;
    read_full(&byte, 1);
    if (byte == '\n') {
      memcpy(line, g_pending, g_pending_used);
      line[g_pending_used] = '\0'; g_pending_used = 0;
      return;
    }
    if (g_pending_used + 1 >= size || g_pending_used + 1 >= sizeof g_pending ||
        (unsigned char)byte < 0x20 || (unsigned char)byte > 0x7e) fatal("protocol");
    g_pending[g_pending_used++] = byte;
  }
}

static int safe_relative(const char *path, size_t length) {
  if (length < 1 || length > MAX_PATH_BYTES || strlen(path) != length || path[0] == '/') return 0;
  const char *part = path;
  for (size_t i = 0; i <= length; i++) {
    unsigned char c = (unsigned char)path[i];
    if (i < length && (c < 0x20 || c == 0x7f)) return 0;
    if (i < length && c != '/') continue;
    size_t size = (size_t)(path + i - part);
    if (size == 0 || (size == 1 && part[0] == '.') || (size == 2 && part[0] == '.' && part[1] == '.')) return 0;
    part = path + i + 1;
  }
  return 1;
}

/* Creates `relative` (and its parents) below the snapshot root; an existing entry must be a real directory. */
static void make_directories(const char *relative, int include_last) {
  char path[PATH_MAX * 2];
  size_t base = (size_t)snprintf(path, sizeof path, "%s/", g_source);
  size_t length = strlen(relative);
  if (base + length + 1 >= sizeof path) fatal("bad-path");
  for (size_t i = 0; i <= length; i++) {
    path[base + i] = relative[i];
    if (relative[i] != '/' && !(relative[i] == '\0' && include_last)) continue;
    path[base + i] = '\0';
    struct stat info;
    if (mkdir(path, 0700) == 0) { if (++g_entries > MAX_ENTRIES) fatal("limit"); }
    else if (errno != EEXIST || lstat(path, &info) != 0 || !S_ISDIR(info.st_mode)) fatal("bad-path");
    path[base + i] = relative[i];
  }
}

static void read_path(char *path, long long length) {
  if (length < 1 || length > MAX_PATH_BYTES) fatal("bad-path");
  read_full(path, (size_t)length);
  path[length] = '\0';
  if (!safe_relative(path, (size_t)length)) fatal("bad-path");
}

static void command_mkdir(long long length) {
  char relative[MAX_PATH_BYTES + 1];
  if (g_ran) fatal("state");
  read_path(relative, length);
  make_directories(relative, 1);
  sendf("OK\n");
}

static void command_put(long long path_length, long long data_length) {
  char relative[MAX_PATH_BYTES + 1], path[PATH_MAX * 2], chunk[65536];
  if (g_ran) fatal("state");
  if (data_length < 0 || data_length > MAX_FILE_BYTES) fatal("limit");
  read_path(relative, path_length);
  g_put_bytes += data_length;
  if (g_put_bytes > MAX_TOTAL_BYTES || ++g_entries > MAX_ENTRIES) fatal("limit");
  make_directories(relative, 0);
  snprintf(path, sizeof path, "%s/%s", g_source, relative);
  int file = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (file < 0) fatal("io");
  while (data_length > 0) {
    size_t size = data_length > (long long)sizeof chunk ? sizeof chunk : (size_t)data_length;
    read_full(chunk, size);
    write_full(file, chunk, size);
    data_length -= (long long)size;
  }
  if (close(file) != 0) fatal("io");
  sendf("OK\n");
}

/* Sends one regular file of the fixed output folder; links and anything outside that folder are never followed. */
static void command_get(long long length) {
  char name[129], directory[PATH_MAX * 2];
  if (length < 1 || length > 128) fatal("bad-path");
  read_full(name, (size_t)length);
  name[length] = '\0';
  if (strlen(name) != (size_t)length || name[0] == '.' || strspn(name, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-") != (size_t)length)
    fatal("bad-path");
  snprintf(directory, sizeof directory, "%s/%s", g_source, OUTPUT_DIR);
  int folder = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  int file = folder < 0 ? -1 : openat(folder, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  struct stat info;
  if (folder >= 0) close(folder);
  if (file < 0 || fstat(file, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size > MAX_FILE_BYTES) {
    if (file >= 0) close(file);
    sendf("NONE\n");
    return;
  }
  char *bytes = malloc((size_t)info.st_size + 1);
  if (!bytes) fatal("io");
  long long total = 0;
  for (;;) {
    ssize_t received = read(file, bytes + total, (size_t)(info.st_size - total));
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) break;
    total += received;
  }
  close(file);
  sendf("FILE %lld\n", total);
  write_full(STDOUT_FILENO, bytes, (size_t)total);
  free(bytes);
}

static void env_add(int *count, const char *format, ...) {
  va_list args;
  if (*count >= ENV_SLOTS) fatal("io");
  va_start(args, format);
  int length = vsnprintf(g_env_text[*count], sizeof g_env_text[0], format, args);
  va_end(args);
  if (length < 0 || length >= (int)sizeof g_env_text[0]) fatal("io");
  g_env[*count] = g_env_text[*count];
  g_env[++*count] = NULL;
}

/* A rebuilt environment: nothing of the app's (tokens, HOME, DYLD_*, user TeX or font configuration) is inherited. */
static void build_environment(void) {
  static const char *work_keys[] = { "HOME", "TMPDIR", "TMP", "TEMP", "TEXMFVAR", "TEXMFCONFIG", "TEXMFCACHE", "TEXMFHOME" };
  int count = 0;
  env_add(&count, "PATH=%s/%s:/usr/bin:/bin", g_tex, TOOL_DIR);
  env_add(&count, "LANG=en_US.UTF-8");
  for (size_t i = 0; i < sizeof work_keys / sizeof work_keys[0]; i++) env_add(&count, "%s=%s", work_keys[i], g_home);
  env_add(&count, "TEXMFOUTPUT=%s", g_source);
  env_add(&count, "TEXMFROOT=%s", g_tex_alias);
  env_add(&count, "TEXMFCNF=%s/texmf-dist/web2c", g_tex_alias);
  /* Formats come only from the pinned runtime: no '.', no writable tree, no default path. */
  env_add(&count, "TEXFORMATS=%s/texmf-var/web2c/pdftex:%s/texmf-var/web2c/xetex", g_tex_alias, g_tex_alias);
  /* Project first, then the pinned app package tree, then kpathsea's default path (trailing ':').
   * BibTeX runs inside the output folder (see command_run), so its project entry is the absolute path. */
  if (g_overlay[0]) {
    env_add(&count, "TEXINPUTS=.:%s/tex//:", g_overlay_alias);
    env_add(&count, "BIBINPUTS=%s:%s/bibtex/bib//:", g_source, g_overlay_alias);
    env_add(&count, "BSTINPUTS=%s:%s/bibtex/bst//:", g_source, g_overlay_alias);
  } else {
    env_add(&count, "TEXINPUTS=.:");
    env_add(&count, "BIBINPUTS=%s:", g_source);
    env_add(&count, "BSTINPUTS=%s:", g_source);
  }
  env_add(&count, "openin_any=p");
  env_add(&count, "openout_any=p");
  env_add(&count, "shell_escape=f");
  env_add(&count, "MKTEXPK=0");
  env_add(&count, "MKTEXTFM=0");
  env_add(&count, "MKTEXFMT=0");
}

/* The stand-ins sit in a folder the tools can write to. Each run starts only while they still point at the pinned
 * trees, so a document cannot swap the tree (or its formats) under a later pass. */
static int alias_intact(const char *alias, const char *target) {
  char found[PATH_MAX];
  ssize_t length = readlink(alias, found, sizeof found - 1);
  if (length < 0) return 0;
  found[length] = '\0';
  return !strcmp(found, target);
}

static const char *tool_binary(const char *tool) {
  if (!strcmp(tool, "pdflatex")) return "pdftex";
  if (!strcmp(tool, "xelatex")) return "xetex";
  if (!strcmp(tool, "xdvipdfmx")) return "xdvipdfmx";
  if (!strcmp(tool, "bibtex")) return "bibtex";
  return NULL;
}

static void child_exec(const char *path, char **argv, const char *directory, int out, int err) {
  struct rlimit cpu = { (rlim_t)(g_timeout_ms / 1000 + 5), (rlim_t)(g_timeout_ms / 1000 + 10) };
  struct rlimit size = { (rlim_t)MAX_FILE_BYTES, (rlim_t)MAX_FILE_BYTES };
  struct rlimit none = { 0, 0 };
  struct rlimit files = { 256, 256 };
  setpgid(0, 0);
  signal(SIGPIPE, SIG_DFL);
  int null = open("/dev/null", O_RDONLY);
  if (null < 0 || dup2(null, STDIN_FILENO) < 0 || dup2(out, STDOUT_FILENO) < 0 || dup2(err, STDERR_FILENO) < 0) _exit(127);
  for (int fd = 3; fd < 256; fd++) close(fd);
  setrlimit(RLIMIT_CPU, &cpu);
  setrlimit(RLIMIT_FSIZE, &size);
  setrlimit(RLIMIT_CORE, &none);
  setrlimit(RLIMIT_NOFILE, &files);
  /* Checked once more as late as possible before the tool starts (the app-side check ran before the fork). */
  if (!alias_intact(g_tex_alias, g_tex) || (g_overlay[0] && !alias_intact(g_overlay_alias, g_overlay))) _exit(127);
  if (chdir(directory) != 0) _exit(127);
  execve(path, argv, g_env);
  _exit(127);
}

/* While a tool runs the app may only cancel or close; anything else, or losing the app, ends everything.
 * A line cut off by the tool's exit stays in g_pending and is completed by read_header. */
static void control_during_run(int *verdict) {
  char byte;
  ssize_t received = read(STDIN_FILENO, &byte, 1);
  if (received < 0 && (errno == EINTR || errno == EAGAIN)) return;
  if (received <= 0) terminate(3);
  if (byte != '\n') {
    if (g_pending_used >= 6) fatal("protocol"); /* the longest allowed word is CANCEL */
    g_pending[g_pending_used++] = byte;
    return;
  }
  g_pending[g_pending_used] = '\0'; g_pending_used = 0;
  if (!strcmp(g_pending, "CLOSE")) g_close_requested = 1;
  else if (strcmp(g_pending, "CANCEL")) fatal("protocol");
  if (*verdict < 0) *verdict = 125;
  kill_tool();
}

static void forward(int fd, int stream, int *open_flag, short events, int verdict) {
  char chunk[4096];
  if (!*open_flag || !(events & (POLLIN | POLLHUP | POLLERR))) return;
  ssize_t received = read(fd, chunk, sizeof chunk);
  if (received < 0 && (errno == EINTR || errno == EAGAIN)) return;
  if (received <= 0) { *open_flag = 0; return; }
  g_output_bytes += received;
  if (verdict >= 0 || g_output_bytes > MAX_OUTPUT_BYTES) return;
  sendf("OUT %d %zd\n", stream, received);
  write_full(STDOUT_FILENO, chunk, (size_t)received);
}

static int count_entry(const char *path, const struct stat *info, int type, struct FTW *walk) {
  (void)path; (void)walk;
  g_usage_entries++;
  if (type == FTW_F) g_usage_bytes += info->st_size;
  return 0;
}

/* The tools' own writes are otherwise bounded only per file; this bounds the folder as a whole. */
static int over_quota(void) {
  g_usage_bytes = 0; g_usage_entries = 0;
  nftw(g_work, count_entry, 32, FTW_PHYS);
  return g_usage_bytes > MAX_WORK_BYTES || g_usage_entries > MAX_WORK_ENTRIES;
}

/* Pumps output until the tool has exited and its pipes are drained; returns the EXIT code. */
static int run_loop(int out, int err) {
  int open_out = 1, open_err = 1, status = 0, exited = 0, verdict = -1;
  long long exit_at = 0, killed_at = 0, measured_at = now_ms();
  pid_t tool = g_child;
  for (;;) {
    struct pollfd fds[3] = { { STDIN_FILENO, POLLIN, 0 }, { open_out ? out : -1, POLLIN, 0 }, { open_err ? err : -1, POLLIN, 0 } };
    if (poll(fds, 3, 100) < 0 && errno != EINTR) terminate(3);
    if (fds[0].revents) control_during_run(&verdict);
    forward(out, 1, &open_out, fds[1].revents, verdict);
    forward(err, 2, &open_err, fds[2].revents, verdict);
    if (!exited && waitpid(tool, &status, WNOHANG) == tool) {
      exited = 1; exit_at = now_ms();
      kill_tool(); /* stragglers of the tool's own process group */
      g_child = 0; /* the id may be reused from now on: never signal it again */
    }
    if (!exited && verdict < 0 && now_ms() > g_deadline_ms) { verdict = 124; kill_tool(); }
    if (!exited && verdict < 0 && g_output_bytes > MAX_OUTPUT_BYTES) { verdict = 126; kill_tool(); }
    if (!exited && verdict < 0 && now_ms() - measured_at > 500) {
      measured_at = now_ms();
      if (over_quota()) { verdict = 126; kill_tool(); }
    }
    if (!exited && verdict >= 0) {
      if (!killed_at) killed_at = now_ms();
      else if (now_ms() - killed_at > 10000) terminate(5); /* a killed tool that never ends: cleanup unknown */
    }
    if (exited && ((!open_out && !open_err) || now_ms() - exit_at > 500)) break;
  }
  g_child = 0;
  if (verdict >= 0) return verdict;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

static int split_arguments(char *text, long long length, char **argv, int first) {
  int count = first;
  char *end = text + length;
  for (char *item = text; item < end; ) {
    size_t size = strnlen(item, (size_t)(end - item));
    if (item + size >= end || size > MAX_ARG_BYTES || count >= MAX_ARGS + first) return -1;
    argv[count++] = item;
    item += size + 1;
  }
  argv[count] = NULL;
  return count;
}

static void command_run(const char *tool, long long length) {
  static char text[MAX_ARGS * (MAX_ARG_BYTES + 1) + 1];
  char path[PATH_MAX * 2], output[PATH_MAX * 2], *argv[MAX_ARGS + 2];
  const char *binary = tool_binary(tool);
  struct stat info;
  int out[2], err[2];
  if (!g_sandboxed) fatal("not-sandboxed");
  if (!binary || length < 0 || length > (long long)sizeof text - 1) fatal("bad-tool");
  read_full(text, (size_t)length);
  if (split_arguments(text, length, argv, 1) < 0) fatal("bad-tool");
  snprintf(path, sizeof path, "%s/%s/%s", g_tex, TOOL_DIR, binary);
  if (lstat(path, &info) != 0 || !S_ISREG(info.st_mode) || !(info.st_mode & 0111)) fatal("bad-tool");
  if (!alias_intact(g_tex_alias, g_tex) || (g_overlay[0] && !alias_intact(g_overlay_alias, g_overlay))) fatal("io");
  argv[0] = path;
  snprintf(output, sizeof output, "%s/%s", g_source, OUTPUT_DIR);
  if (mkdir(output, 0700) != 0 && errno != EEXIST) fatal("io");
  g_ran = 1;
  if (pipe(out) != 0 || pipe(err) != 0) fatal("io");
  g_child = fork();
  if (g_child < 0) { g_child = 0; fatal("io"); }
  /* kpathsea's paranoid mode refuses output names with a dot-directory in them, and BibTeX has no
   * -output-directory: it runs inside the output folder and is given the bare job name. */
  if (g_child == 0) child_exec(path, argv, strcmp(tool, "bibtex") ? g_source : output, out[1], err[1]);
  setpgid(g_child, g_child);
  close(out[1]); close(err[1]);
  sendf("STARTED %d\n", (int)g_child);
  int code = run_loop(out[0], err[0]);
  close(out[0]); close(err[0]);
  sendf("EXIT %d\n", code);
}

static int probe_connect(const char *text) {
  struct sockaddr_in address;
  struct timeval limit = { 2, 0 };
  int port = atoi(text);
  if (port < 1 || port > 65535) { errno = EINVAL; return -1; }
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &limit, sizeof limit);
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_port = htons((unsigned short)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int result = connect(fd, (struct sockaddr *)&address, sizeof address);
  int saved = errno;
  close(fd);
  errno = saved;
  return result;
}

/* Reads a file through a child process (/bin/cat), which proves what a program started here may reach.
 * The reason comes from cat's own message, so "refused by the sandbox" is told apart from any other failure. */
static int probe_exec_read(const char *path) {
  char text[256];
  int report[2], status = 0, timed_out = 0;
  if (pipe(report) != 0) return -1;
  pid_t child = fork();
  if (child < 0) { close(report[0]); close(report[1]); return -1; }
  if (child == 0) {
    int null = open("/dev/null", O_WRONLY);
    setpgid(0, 0);
    if (null < 0 || dup2(null, STDOUT_FILENO) < 0 || dup2(report[1], STDERR_FILENO) < 0) _exit(126);
    for (int fd = 3; fd < 256; fd++) close(fd);
    execl("/bin/cat", "cat", "--", path, (char *)NULL);
    _exit(127);
  }
  close(report[1]);
  long long started = now_ms();
  while (waitpid(child, &status, WNOHANG) != child) {
    if (now_ms() - started > 5000) { kill(-child, SIGKILL); kill(child, SIGKILL); waitpid(child, &status, 0); timed_out = 1; break; }
    usleep(20000);
  }
  ssize_t length = timed_out ? 0 : read(report[0], text, sizeof text - 1);
  close(report[0]);
  text[length > 0 ? length : 0] = '\0';
  if (!timed_out && WIFEXITED(status) && WEXITSTATUS(status) == 0) return 0;
  errno = timed_out ? ETIMEDOUT : strstr(text, "Operation not permitted") ? EPERM : strstr(text, "Permission denied") ? EACCES :
    strstr(text, "No such file") ? ENOENT : EIO;
  return -1;
}

static void command_probe(const char *kind, long long length) {
  char argument[MAX_PATH_BYTES + 1];
  int result = -1;
  if (length < 1 || length > MAX_PATH_BYTES) fatal("bad-path");
  read_full(argument, (size_t)length);
  argument[length] = '\0';
  errno = 0;
  if (!strcmp(kind, "read")) {
    char byte;
    int fd = open(argument, O_RDONLY | O_NONBLOCK);
    result = fd < 0 ? -1 : (read(fd, &byte, 1) < 0 ? -1 : 0);
    int saved = errno;
    if (fd >= 0) close(fd);
    errno = saved;
  } else if (!strcmp(kind, "write")) {
    int fd = open(argument, O_WRONLY | O_CREAT | O_EXCL, 0600);
    int saved = errno;
    if (fd >= 0) { close(fd); unlink(argument); }
    errno = saved;
    result = fd < 0 ? -1 : 0;
  } else if (!strcmp(kind, "connect")) result = probe_connect(argument);
  else if (!strcmp(kind, "exec-read")) result = probe_exec_read(argument);
  else fatal("protocol");
  if (result == 0) sendf("PROBE allowed 0\n");
  else sendf("PROBE denied %d\n", errno);
}

static void command_close(void) {
  int clean = remove_work();
  sendf("CLOSED %d\n", clean);
  _exit(clean ? 0 : 6);
}

static void resolve_directory(char *target, const char *value) {
  struct stat info;
  if (!value || value[0] != '/' || !realpath(value, target) || stat(target, &info) != 0 || !S_ISDIR(info.st_mode)) {
    fprintf(stderr, "latexstudio-compiler: invalid directory argument\n");
    _exit(64);
  }
}

static void parse_arguments(int argc, char **argv) {
  g_timeout_ms = 120000;
  for (int i = 1; i + 1 < argc; i += 2) {
    if (!strcmp(argv[i], "--tex-root")) resolve_directory(g_tex, argv[i + 1]);
    else if (!strcmp(argv[i], "--overlay-root")) resolve_directory(g_overlay, argv[i + 1]);
    else if (!strcmp(argv[i], "--timeout-ms")) g_timeout_ms = atoll(argv[i + 1]);
    else _exit(64);
  }
  if (!(argc & 1) || !g_tex[0] || g_timeout_ms < 100 || g_timeout_ms > 600000) _exit(64);
}

/* The per-user temporary folder; inside the App Sandbox this is a folder of the helper's own container. */
static size_t temp_base(char *base, size_t size) {
#ifdef __APPLE__
  return confstr(_CS_DARWIN_USER_TEMP_DIR, base, size);
#else /* logic checks of this file on other POSIX systems only; the product is built for macOS */
  return (size_t)snprintf(base, size, "/tmp/") + 1;
#endif
}

/* One live helper per container. Waits a while for an earlier session to finish, then gives up. */
static void lock_container(const char *base, const char *slash) {
  char path[PATH_MAX * 2];
  snprintf(path, sizeof path, "%s%spaperstudio.lock", base, slash);
  int fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
  if (fd < 0) _exit(70);
  for (int attempt = 0; flock(fd, LOCK_EX | LOCK_NB) != 0; attempt++) {
    if (errno != EWOULDBLOCK && errno != EINTR) _exit(70);
    if (attempt >= LOCK_WAIT_TENTHS) { sendf("ERR busy\n"); _exit(75); }
    usleep(100000);
  }
  /* Kept open until exit. Tools close it (child_exec), so it is released the moment this helper is gone. */
}

/* With the lock held no other session exists: every earlier work folder is residue and is removed. */
static void sweep_stale(const char *base, const char *slash) {
  char path[PATH_MAX * 2];
  struct dirent *entry;
  DIR *directory = opendir(base);
  if (!directory) return;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, "paperstudio-", 12)) continue;
    snprintf(path, sizeof path, "%s%s%s", base, slash, entry->d_name);
    nftw(path, remove_entry, 32, FTW_DEPTH | FTW_PHYS);
  }
  closedir(directory);
}

static void create_work(void) {
  char base[PATH_MAX], pattern[PATH_MAX * 2];
  size_t length = temp_base(base, sizeof base);
  if (length == 0 || length > sizeof base) _exit(70);
  const char *slash = base[strlen(base) - 1] == '/' ? "" : "/";
  /* Only inside the sandbox is this folder the helper's own; outside it nothing is locked, swept or run. */
  if (g_sandboxed) { lock_container(base, slash); sweep_stale(base, slash); }
  snprintf(pattern, sizeof pattern, "%s%spaperstudio-XXXXXX", base, slash);
  if (!mkdtemp(pattern) || !realpath(pattern, g_work)) _exit(70);
  snprintf(g_source, sizeof g_source, "%s/source", g_work);
  snprintf(g_home, sizeof g_home, "%s/home", g_work);
  if (mkdir(g_source, 0700) != 0 || mkdir(g_home, 0700) != 0) terminate(70);
  snprintf(g_tex_alias, sizeof g_tex_alias, "%s/t", g_work);
  snprintf(g_overlay_alias, sizeof g_overlay_alias, "%s/p", g_work);
  if (symlink(g_tex, g_tex_alias) != 0 || (g_overlay[0] && symlink(g_overlay, g_overlay_alias) != 0)) terminate(70);
}

static void dispatch(char *line) {
  char kind[32];
  long long first = -1, second = -1;
  if (!strcmp(line, "CLOSE")) command_close();
  else if (!g_sandboxed) fatal("not-sandboxed"); /* outside the sandbox the only thing left to do is close */
  else if (!strcmp(line, "CANCEL")) return; /* nothing is running */
  else if (sscanf(line, "MKDIR %lld", &first) == 1) command_mkdir(first);
  else if (sscanf(line, "PUT %lld %lld", &first, &second) == 2) command_put(first, second);
  else if (sscanf(line, "GET %lld", &first) == 1) command_get(first);
  else if (sscanf(line, "RUN %31s %lld", kind, &first) == 2) command_run(kind, first);
  else if (sscanf(line, "PROBE %31s %lld", kind, &first) == 2) command_probe(kind, first);
  else fatal("protocol");
}

/* Killed from outside: take the tool along. The work folder is removed by the next helper's sweep. */
static void on_signal(int number) {
  if (g_child > 0) kill(-g_child, SIGKILL);
  _exit(128 + number);
}

int main(int argc, char **argv) {
  char line[MAX_HEADER];
  if (argc == 2 && !strcmp(argv[1], "--version")) { printf("latexstudio-compiler protocol %d build %d\n", PROTOCOL, PAPERSTUDIO_VARIANT); return 0; }
  signal(SIGPIPE, SIG_IGN);
  signal(SIGTERM, on_signal); signal(SIGHUP, on_signal); signal(SIGINT, on_signal);
  parse_arguments(argc, argv);
  /* Exactly 1 means sandboxed. An error, a missing symbol or anything else counts as NOT sandboxed. */
  g_sandboxed = sandbox_check != NULL && sandbox_check(getpid(), NULL, 0) == 1;
  create_work();
  build_environment();
  g_deadline_ms = now_ms() + g_timeout_ms;
  sendf("READY %d %d %zu\n", PROTOCOL, g_sandboxed, strlen(g_source));
  write_full(STDOUT_FILENO, g_source, strlen(g_source));
  for (;;) {
    read_header(line, sizeof line);
    dispatch(line);
    if (g_close_requested) command_close();
  }
}
