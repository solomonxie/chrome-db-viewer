// dbui-runner: native messaging host for dbui. Chrome starts it per connection tab and talks
// to it over stdin/stdout with 4-byte length-prefixed JSON (extension/src/core/runner-protocol.ts).
//
// Threads (design/DESIGN.md §3.4):
//   - main thread:   reads frames from stdin, routes requests, handles `hello` and `cancel`
//   - "main" worker: connect / execute / apply on the primary connection, one job at a time
//   - "meta" worker: listObjects / describe on a second, read-only connection
//   - "svc" worker:  Keychain calls and backup files, so they don't block either connection
//   - writer:        the only code that touches stdout
// EOF on stdin → cancel running work, close connections, exit 0.

#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <future>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include "backup.hpp"
#include "drivers/driver.hpp"
#include "framing.hpp"
#include "log.hpp"
#include "pager.hpp"
#include "secret_store.hpp"
#include "session.hpp"

#ifndef DBUI_RUNNER_VERSION
#define DBUI_RUNNER_VERSION "0.0.0"
#endif

namespace dbui {
namespace {

constexpr int kProtocolVersion = 1;
constexpr std::size_t kMaxErrorMessage = 16 * 1024;
/** Raw bytes per backup.read chunk. JSON-escaping can roughly double it; still under 1 MB. */
constexpr std::size_t kBackupChunkBytes = 300 * 1024;

/** Serializes every outbound message onto the private copy of stdout. */
class Writer {
 public:
  explicit Writer(int fd) : fd_(fd), thread_([this] { loop(); }) {}
  ~Writer() { close(); }

  void send(std::string msg) {
    if (msg.size() >= framing::kMaxOutboundFrame) {
      log::error("dropping oversized message (" + std::to_string(msg.size()) + " bytes)");
      json j = json::parse(msg, nullptr, false);
      long long id = j.is_object() && j.contains("id") && j["id"].is_number() ? j["id"].get<long long>() : 0;
      msg = dumpJson(json{{"id", id}, {"type", "error"}, {"code", "RESPONSE_TOO_LARGE"},
                          {"message", "The response is larger than the 1 MB native messaging limit"}});
    }
    {
      std::lock_guard lock(mu_);
      if (closed_) return;
      queue_.push_back(std::move(msg));
    }
    cv_.notify_one();
  }
  void send(const json& j) { send(dumpJson(j)); }

  /** Flushes queued messages and stops the thread. */
  void close() {
    {
      std::lock_guard lock(mu_);
      if (closed_) return;
      closed_ = true;
    }
    cv_.notify_one();
    if (thread_.joinable()) thread_.join();
  }

 private:
  void loop() {
    for (;;) {
      std::string msg;
      {
        std::unique_lock lock(mu_);
        cv_.wait(lock, [this] { return closed_ || !queue_.empty(); });
        if (queue_.empty()) return;
        msg = std::move(queue_.front());
        queue_.pop_front();
      }
      if (!broken_ && !framing::writeFrame(fd_, msg)) {
        log::warn("stdout closed; dropping further messages");
        broken_ = true;
      }
    }
  }

  int fd_;
  std::mutex mu_;
  std::condition_variable cv_;
  std::deque<std::string> queue_;
  bool closed_ = false;
  bool broken_ = false;
  std::thread thread_;
};

json errorMsg(long long id, const std::string& code, std::string message) {
  if (message.size() > kMaxErrorMessage) message = message.substr(0, kMaxErrorMessage) + "…";
  json j{{"id", id}, {"type", "error"}, {"message", message}};
  if (!code.empty()) j["code"] = code;
  return j;
}

long long msSince(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
}

std::unique_ptr<Driver> makeDriver(const std::string& name) {
  if (name == "postgres") return makePostgresDriver();
  if (name == "redis") return makeRedisDriver();
  if (name == "duckdb") throw DriverError("UNSUPPORTED_DRIVER", "Native DuckDB is not available in this runner build yet");
  throw DriverError("UNSUPPORTED_DRIVER", "Unknown driver: " + name);
}

class Router {
 public:
  explicit Router(Writer& out)
      : out_(out),
        main_("main", [this](long long id) { out_.send(errorMsg(id, "CANCELLED", "Cancelled before it started")); }),
        meta_("meta", [this](long long id) { out_.send(errorMsg(id, "CANCELLED", "Cancelled before it started")); }),
        svc_("svc") {
    main_.start();
    meta_.start();
    svc_.start();
  }

  void shutdown() {
    main_.stop();
    meta_.stop();
    svc_.stop();
  }

  void handle(const std::string& frame) {
    json req = json::parse(frame, nullptr, false);
    if (!req.is_object()) {
      log::warn("ignoring a frame that is not a JSON object");
      out_.send(errorMsg(0, "BAD_REQUEST", "Request is not a JSON object"));
      return;
    }
    long long id = req.contains("id") && req["id"].is_number() ? req["id"].get<long long>() : 0;
    std::string op = req.value("op", "");
    log::info("request " + std::to_string(id) + " " + op);

    if (op == "hello") {
      out_.send(json{{"id", id}, {"type", "hello"}, {"runner", DBUI_RUNNER_VERSION}, {"protocol", kProtocolVersion},
                     {"drivers", {"postgres", "redis"}}, {"features", {"backup"}}});
    } else if (op == "cancel") {
      long long target = req.value("target", -1LL);
      bool found = main_.cancel(target) || meta_.cancel(target);
      out_.send(json{{"id", id}, {"type", "ok"}, {"cancelled", found}});
    } else if (op == "connect") {
      main_.submit(id, [this, id, req](CancelToken&) { guarded(id, [&] { connect(id, req.value("conn", json::object())); }); });
    } else if (op == "disconnect") {
      main_.submit(id, [this, id](CancelToken&) {
        metaReady_ = false;
        std::promise<void> done;
        meta_.submit(-1, [&](CancelToken&) {
          meta_.setDriver(nullptr);
          done.set_value();
        });
        main_.setDriver(nullptr);
        done.get_future().wait();
        out_.send(json{{"id", id}, {"type", "ok"}});
      });
    } else if (op == "execute") {
      main_.submit(id, [this, id, req](CancelToken& token) { guarded(id, [&] { execute(id, req, token); }); });
    } else if (op == "apply") {
      main_.submit(id, [this, id, req](CancelToken& token) {
        guarded(id, [&] {
          auto t0 = std::chrono::steady_clock::now();
          json extra = requireDriver(main_)->apply(req.value("statements", json::array()), token);
          extra["id"] = id;
          extra["type"] = "ok";
          extra["ms"] = msSince(t0);
          out_.send(extra);
        });
      });
    } else if (op == "listObjects" || op == "describe") {
      Session& s = metaReady_ ? meta_ : main_;
      s.submit(id, [this, id, op, req, &s](CancelToken& token) {
        guarded(id, [&] {
          Driver* d = requireDriver(s);
          if (op == "listObjects") {
            out_.send(json{{"id", id}, {"type", "objects"}, {"nodes", d->listObjects(req.value("parent", json::array()), token)}});
          } else {
            out_.send(json{{"id", id}, {"type", "schema"}, {"schema", d->describe(req.value("path", json::array()), token)}});
          }
        });
      });
    } else if (op == "secret.set" || op == "secret.get" || op == "secret.delete") {
      svc_.submit(id, [this, id, op, req](CancelToken&) {
        guarded(id, [&] {
          std::string ref = req.value("ref", "");
          if (op == "secret.set") {
            secrets::set(ref, req.value("value", ""));
            out_.send(json{{"id", id}, {"type", "ok"}});
          } else if (op == "secret.get") {
            auto v = secrets::get(ref);
            out_.send(json{{"id", id}, {"type", "secret"}, {"value", v ? json(*v) : json(nullptr)}});
          } else {
            bool removed = secrets::remove(ref);
            out_.send(json{{"id", id}, {"type", "ok"}, {"deleted", removed}});
          }
        });
      });
    } else if (op == "backup.write" || op == "backup.read") {
      svc_.submit(id, [this, id, op, req](CancelToken&) { guarded(id, [&] { handleBackup(id, op, req); }); });
    } else {
      out_.send(errorMsg(id, "UNKNOWN_OP", "Unknown op: " + op));
    }
  }

 private:
  template <typename F>
  void guarded(long long id, F&& f) {
    try {
      f();
    } catch (const DriverError& e) {
      log::warn("request " + std::to_string(id) + " failed: " + e.code + " " + e.what());
      out_.send(errorMsg(id, e.code, e.what()));
    } catch (const std::exception& e) {
      log::error("request " + std::to_string(id) + " crashed: " + e.what());
      out_.send(errorMsg(id, "INTERNAL", e.what()));
    }
  }

  /** backup.write {json} → ok {mtime, size}; backup.read → chunk… then backup {exists, mtime, size, chunks}. */
  void handleBackup(long long id, const std::string& op, const json& req) {
    const char* dirEnv = std::getenv("DBUI_BACKUP_DIR");  // tests only
    std::filesystem::path dir = dirEnv && *dirEnv ? std::filesystem::path(dirEnv) : backup::defaultDir();
    if (op == "backup.write") {
      if (!req.contains("json") || !req["json"].is_string()) throw DriverError("BAD_REQUEST", "backup.write needs a json string");
      backup::Info info = backup::write(dir, req["json"].get_ref<const std::string&>());
      out_.send(json{{"id", id}, {"type", "ok"}, {"mtime", info.mtimeMs}, {"size", info.size}});
      return;
    }
    backup::Info info;
    auto data = backup::read(dir, &info);
    std::size_t n = 0;
    if (data) {
      for (auto piece : backup::chunkUtf8(*data, kBackupChunkBytes)) {
        out_.send(json{{"id", id}, {"type", "chunk"}, {"seq", n++}, {"data", std::string(piece)}});
      }
    }
    out_.send(json{{"id", id}, {"type", "backup"}, {"exists", data.has_value()}, {"mtime", data ? json(info.mtimeMs) : json(nullptr)},
                   {"size", info.size}, {"chunks", n}});
  }

  static Driver* requireDriver(Session& s) {
    Driver* d = s.driver();
    if (!d) throw DriverError("NOT_CONNECTED", "Not connected; send connect first");
    return d;
  }

  void connect(long long id, const json& conn) {
    if (conn.contains("ssh") && !conn["ssh"].is_null()) {
      throw DriverError("SSH_NOT_IMPLEMENTED", "SSH tunnels are not implemented in this runner build yet");
    }
    ConnectOptions opts;
    opts.conn = conn;
    opts.readOnly = conn.value("readOnly", false);
    // A password typed for this session comes inline and is never stored or logged;
    // otherwise secretRef names a Keychain item.
    std::string inlinePassword = conn.value("password", "");
    std::string ref = conn.value("secretRef", "");
    if (!inlinePassword.empty()) {
      opts.password = inlinePassword;
    } else if (!ref.empty()) {
      auto pw = secrets::get(ref);
      if (!pw) throw DriverError("SECRET_NOT_FOUND", "No Keychain item for secretRef " + ref);
      opts.password = *pw;
    }
    const std::string name = conn.value("driver", "");

    metaReady_ = false;
    auto driver = makeDriver(name);
    json extra = driver->connect(opts);
    main_.setDriver(std::move(driver));

    // Second, read-only connection for the tree and describe, so they don't queue behind a
    // long query. If it can't be opened (connection limit …) those ops use the main one.
    std::promise<void> done;
    meta_.submit(-1, [&](CancelToken&) {
      try {
        auto meta = makeDriver(name);
        ConnectOptions mo = opts;
        mo.metadata = true;
        meta->connect(mo);
        meta_.setDriver(std::move(meta));
        metaReady_ = true;
      } catch (const std::exception& e) {
        meta_.setDriver(nullptr);
        log::warn(std::string("metadata connection failed, using the main one: ") + e.what());
      }
      done.set_value();
    });
    done.get_future().wait();

    extra["id"] = id;
    extra["type"] = "ok";
    out_.send(extra);
  }

  void execute(long long id, const json& req, CancelToken& token) {
    Driver* d = requireDriver(main_);
    auto t0 = std::chrono::steady_clock::now();
    std::size_t pageSize = req.contains("pageSize") && req["pageSize"].is_number_unsigned() ? req["pageSize"].get<std::size_t>() : 0;
    Pager pager(id, pageSize, [this](std::string m) { out_.send(std::move(m)); });
    ExecResult r = d->execute(req, pager, token);
    pager.flush();
    json done{{"id", id}, {"type", "done"}, {"rowCount", pager.rowCount()}, {"ms", msSince(t0)}};
    if (r.affectedRows) done["affectedRows"] = *r.affectedRows;
    out_.send(done);
  }

  Writer& out_;
  Session main_;
  Session meta_;
  Session svc_;
  std::atomic<bool> metaReady_{false};
};

}  // namespace
}  // namespace dbui

int main(int argc, char** argv) {
  using namespace dbui;
  if (argc > 1 && std::string(argv[1]) == "--version") {
    std::printf("dbui-runner %s (protocol %d)\n", DBUI_RUNNER_VERSION, kProtocolVersion);
    return 0;
  }
  signal(SIGPIPE, SIG_IGN);
  log::init();

  // Keep a private copy of stdout for frames, then point fd 1 at /dev/null so nothing a
  // library prints can corrupt the protocol stream. stderr goes to the log file.
  int protocolFd = dup(STDOUT_FILENO);
  int devnull = open("/dev/null", O_WRONLY);
  if (devnull >= 0) {
    dup2(devnull, STDOUT_FILENO);
    close(devnull);
  }
  if (const char* home = std::getenv("HOME")) {
    std::string logPath = std::getenv("DBUI_RUNNER_LOG") ? std::getenv("DBUI_RUNNER_LOG") : std::string(home) + "/Library/Logs/dbui/runner.log";
    int errFd = open(logPath.c_str(), O_WRONLY | O_APPEND | O_CREAT, 0600);
    if (errFd >= 0) {
      dup2(errFd, STDERR_FILENO);
      close(errFd);
    }
  }
  // Chrome passes the caller origin (and on Windows a window handle) as arguments.
  log::info(std::string("start, version ") + DBUI_RUNNER_VERSION + (argc > 1 ? std::string(", origin ") + argv[1] : ""));

  int code = 0;
  {
    Writer writer(protocolFd);
    Router router(writer);
    try {
      for (;;) {
        auto frame = framing::readFrame(STDIN_FILENO);
        if (!frame) break;
        router.handle(*frame);
      }
      log::info("stdin closed, shutting down");
    } catch (const std::exception& e) {
      log::error(std::string("fatal: ") + e.what());
      code = 1;
    }
    router.shutdown();
    writer.close();
  }
  log::info("exit " + std::to_string(code));
  return code;
}
