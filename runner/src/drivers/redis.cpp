#include "redis.hpp"

#include <hiredis/hiredis.h>
#include <sys/socket.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <mutex>
#include <unordered_set>

#include "../log.hpp"

namespace dbui {
namespace redis {

namespace {

std::string upper(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::toupper(c); });
  return s;
}

int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

}  // namespace

std::vector<std::string> tokenize(std::string_view line) {
  std::vector<std::string> out;
  std::size_t i = 0;
  const std::size_t n = line.size();
  while (i < n) {
    while (i < n && std::isspace(static_cast<unsigned char>(line[i]))) ++i;
    if (i >= n) break;
    std::string tok;
    bool inDouble = false, inSingle = false;
    for (; i < n; ++i) {
      char c = line[i];
      if (inDouble) {
        if (c == '\\' && i + 1 < n) {
          char e = line[++i];
          switch (e) {
            case 'n': tok += '\n'; break;
            case 'r': tok += '\r'; break;
            case 't': tok += '\t'; break;
            case 'x':
              if (i + 2 < n && hexValue(line[i + 1]) >= 0 && hexValue(line[i + 2]) >= 0) {
                tok += static_cast<char>(hexValue(line[i + 1]) * 16 + hexValue(line[i + 2]));
                i += 2;
              } else {
                tok += 'x';
              }
              break;
            default: tok += e;
          }
        } else if (c == '"') {
          inDouble = false;
        } else {
          tok += c;
        }
      } else if (inSingle) {
        if (c == '\\' && i + 1 < n && line[i + 1] == '\'') {
          tok += '\'';
          ++i;
        } else if (c == '\'') {
          inSingle = false;
        } else {
          tok += c;
        }
      } else if (c == '"') {
        inDouble = true;
      } else if (c == '\'') {
        inSingle = true;
      } else if (std::isspace(static_cast<unsigned char>(c))) {
        break;
      } else {
        tok += c;
      }
    }
    if (inDouble || inSingle) throw DriverError("BAD_COMMAND", "unbalanced quotes in command");
    out.push_back(std::move(tok));
  }
  return out;
}

bool isWriteCommand(const std::vector<std::string>& argv) {
  if (argv.empty()) return false;
  // Commands flagged "write" in COMMAND INFO, plus admin and scripting commands that can write
  // or change server state. Unknown names are allowed; the server rejects real typos.
  static const std::unordered_set<std::string> writes = {
      // keys
      "DEL", "UNLINK", "EXPIRE", "EXPIREAT", "PEXPIRE", "PEXPIREAT", "PERSIST", "RENAME", "RENAMENX", "MOVE", "COPY",
      "RESTORE", "RESTORE-ASKING", "MIGRATE", "SORT",
      // strings
      "SET", "SETNX", "SETEX", "PSETEX", "MSET", "MSETNX", "APPEND", "SETRANGE", "INCR", "INCRBY", "INCRBYFLOAT",
      "DECR", "DECRBY", "GETSET", "GETDEL", "GETEX", "SETBIT", "BITOP", "BITFIELD",
      // hashes
      "HSET", "HSETNX", "HMSET", "HDEL", "HINCRBY", "HINCRBYFLOAT", "HEXPIRE", "HPEXPIRE", "HEXPIREAT", "HPEXPIREAT",
      "HPERSIST", "HGETDEL", "HGETEX", "HSETEX",
      // lists
      "LPUSH", "RPUSH", "LPUSHX", "RPUSHX", "LPOP", "RPOP", "LSET", "LREM", "LTRIM", "LINSERT", "RPOPLPUSH", "LMOVE",
      "BLPOP", "BRPOP", "BRPOPLPUSH", "BLMOVE", "LMPOP", "BLMPOP",
      // sets
      "SADD", "SREM", "SPOP", "SMOVE", "SINTERSTORE", "SUNIONSTORE", "SDIFFSTORE",
      // sorted sets
      "ZADD", "ZREM", "ZINCRBY", "ZPOPMIN", "ZPOPMAX", "BZPOPMIN", "BZPOPMAX", "ZMPOP", "BZMPOP", "ZREMRANGEBYRANK",
      "ZREMRANGEBYSCORE", "ZREMRANGEBYLEX", "ZUNIONSTORE", "ZINTERSTORE", "ZDIFFSTORE", "ZRANGESTORE",
      // streams
      "XADD", "XDEL", "XTRIM", "XGROUP", "XACK", "XCLAIM", "XAUTOCLAIM", "XREADGROUP", "XSETID",
      // geo / hyperloglog
      "GEOADD", "GEORADIUS", "GEORADIUSBYMEMBER", "GEOSEARCHSTORE", "PFADD", "PFMERGE", "PFCOUNT",
      // json / modules commonly found
      "JSON.SET", "JSON.DEL", "JSON.FORGET", "JSON.MSET", "JSON.MERGE", "JSON.NUMINCRBY", "JSON.STRAPPEND",
      "JSON.ARRAPPEND", "JSON.ARRINSERT", "JSON.ARRPOP", "JSON.ARRTRIM", "JSON.CLEAR", "JSON.TOGGLE",
      // server / db
      "FLUSHDB", "FLUSHALL", "SWAPDB", "SELECT", "SAVE", "BGSAVE", "BGREWRITEAOF", "SHUTDOWN", "REPLICAOF", "SLAVEOF",
      "FAILOVER", "DEBUG", "MODULE", "ACL", "CLUSTER", "MONITOR", "SYNC", "PSYNC",
      // scripting / transactions: scripts can write, and MULTI would bypass the per-command check
      "EVAL", "EVALSHA", "FCALL", "MULTI", "EXEC", "DISCARD", "WATCH", "PUBLISH", "SPUBLISH",
  };
  const std::string cmd = upper(argv[0]);
  if (writes.count(cmd)) return true;
  const std::string sub = argv.size() > 1 ? upper(argv[1]) : "";
  if (cmd == "CONFIG") return sub != "GET" && sub != "HELP";
  if (cmd == "SCRIPT") return sub == "FLUSH" || sub == "LOAD" || sub == "KILL";
  if (cmd == "FUNCTION") return sub != "LIST" && sub != "DUMP" && sub != "STATS" && sub != "HELP";
  if (cmd == "CLIENT") return sub == "KILL" || sub == "PAUSE" || sub == "UNPAUSE" || sub == "NO-EVICT";
  if (cmd == "MEMORY") return sub == "PURGE";
  if (cmd == "LATENCY" || cmd == "SLOWLOG") return sub == "RESET";
  // SORT … STORE writes; plain SORT is already refused above to be safe (use SORT_RO).
  return false;
}

}  // namespace redis

namespace {

struct ReplyHolder {
  redisReply* r;
  explicit ReplyHolder(void* r_) : r(static_cast<redisReply*>(r_)) {}
  ~ReplyHolder() {
    if (r) freeReplyObject(r);
  }
  ReplyHolder(const ReplyHolder&) = delete;
  ReplyHolder& operator=(const ReplyHolder&) = delete;
};

std::string upper(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::toupper(c); });
  return s;
}

json scalar(const redisReply* r) {
  switch (r->type) {
    case REDIS_REPLY_STRING:
    case REDIS_REPLY_STATUS:
    case REDIS_REPLY_VERB:
    case REDIS_REPLY_BIGNUM:
      return std::string(r->str, r->len);
    case REDIS_REPLY_INTEGER:
      return r->integer;
    case REDIS_REPLY_DOUBLE:
      return r->dval;
    case REDIS_REPLY_BOOL:
      return r->integer != 0;
    case REDIS_REPLY_NIL:
      return nullptr;
    case REDIS_REPLY_ERROR:
      return "(error) " + std::string(r->str, r->len);
    default: {
      json arr = json::array();
      for (std::size_t i = 0; i < r->elements; ++i) arr.push_back(scalar(r->element[i]));
      return arr;
    }
  }
}

bool isAggregate(const redisReply* r) {
  return r->type == REDIS_REPLY_ARRAY || r->type == REDIS_REPLY_SET || r->type == REDIS_REPLY_MAP ||
         r->type == REDIS_REPLY_PUSH;
}

std::string ttlText(long long ttl) {
  if (ttl < 0) return "";
  if (ttl < 120) return std::to_string(ttl) + "s";
  if (ttl < 7200) return std::to_string(ttl / 60) + "m";
  if (ttl < 172800) return std::to_string(ttl / 3600) + "h";
  return std::to_string(ttl / 86400) + "d";
}

class RedisDriver : public Driver {
 public:
  ~RedisDriver() override { disconnect(); }

  json connect(const ConnectOptions& opts) override {
    disconnect();
    opts_ = opts;
    readOnly_ = opts.readOnly || opts.metadata;
    open();
    ReplyHolder info(command({"INFO", "server"}));
    std::string version;
    if (info.r && info.r->type == REDIS_REPLY_STRING) {
      std::string s(info.r->str, info.r->len);
      auto pos = s.find("redis_version:");
      if (pos != std::string::npos) {
        auto end = s.find_first_of("\r\n", pos);
        version = s.substr(pos + 14, end - pos - 14);
      }
    }
    log::info("redis connected, server " + version + (readOnly_ ? " (read-only)" : ""));
    return json{{"server", "Redis " + version}};
  }

  void disconnect() override {
    std::lock_guard lock(mu_);
    if (ctx_) redisFree(ctx_);
    ctx_ = nullptr;
  }

  void cancel() override {
    // hiredis has no cancel; shutting the socket down unblocks a blocking command (BLPOP …).
    // The worker reconnects before the next job.
    std::lock_guard lock(mu_);
    if (ctx_ && ctx_->fd >= 0) {
      cancelled_ = true;
      ::shutdown(ctx_->fd, SHUT_RDWR);
    }
  }

  json listObjects(const json& parentJ, CancelToken& token) override {
    auto parent = parentJ.get<std::vector<std::string>>();
    // parent []          → keys matching "*"
    // parent [pattern]   → keys matching that glob (a plain prefix like "session:" gets a "*")
    std::string pattern = parent.empty() ? "*" : parent[0];
    if (pattern.find_first_of("*?[") == std::string::npos) pattern += "*";
    constexpr std::size_t kMaxKeys = 5000;

    std::vector<std::string> keys;
    std::string cursor = "0";
    do {
      if (token.isCancelled()) throw DriverError("CANCELLED", "cancelled");
      ReplyHolder r(command({"SCAN", cursor, "MATCH", pattern, "COUNT", "1000"}));
      if (!r.r || r.r->type != REDIS_REPLY_ARRAY || r.r->elements != 2) throw DriverError("REDIS", "bad SCAN reply");
      cursor.assign(r.r->element[0]->str, r.r->element[0]->len);
      const redisReply* batch = r.r->element[1];
      for (std::size_t i = 0; i < batch->elements && keys.size() < kMaxKeys; ++i) {
        keys.emplace_back(batch->element[i]->str, batch->element[i]->len);
      }
    } while (cursor != "0" && keys.size() < kMaxKeys);
    std::sort(keys.begin(), keys.end());

    // TYPE and TTL for every key, pipelined.
    for (auto& k : keys) {
      appendCommand({"TYPE", k});
      appendCommand({"TTL", k});
    }
    json nodes = json::array();
    for (auto& k : keys) {
      ReplyHolder type(nextReply());
      ReplyHolder ttl(nextReply());
      std::string meta = type.r && type.r->type == REDIS_REPLY_STATUS ? std::string(type.r->str, type.r->len) : "?";
      if (ttl.r && ttl.r->type == REDIS_REPLY_INTEGER && ttl.r->integer >= 0) meta += " · ttl " + ttlText(ttl.r->integer);
      nodes.push_back({{"path", {k}}, {"name", k}, {"type", "key"}, {"hasChildren", false}, {"meta", meta}});
    }
    return nodes;
  }

  json describe(const json& pathJ, CancelToken&) override {
    auto path = pathJ.get<std::vector<std::string>>();
    if (path.empty()) throw DriverError("BAD_REQUEST", "describe needs [key]");
    const std::string& key = path.back();
    ReplyHolder typeR(command({"TYPE", key}));
    std::string type = typeR.r && typeR.r->type == REDIS_REPLY_STATUS ? std::string(typeR.r->str, typeR.r->len) : "none";
    if (type == "none") throw DriverError("NOT_FOUND", "key " + key + " does not exist");
    ReplyHolder ttl(command({"TTL", key}));
    ReplyHolder enc(command({"OBJECT", "ENCODING", key}));
    ReplyHolder mem(command({"MEMORY", "USAGE", key}));

    auto col = [](const char* name, const char* t, bool pk = false) {
      json c{{"name", name}, {"type", t}, {"nullable", false}};
      if (pk) c["primaryKey"] = true;
      return c;
    };
    json columns = json::array();
    if (type == "string") columns = {col("value", "string")};
    else if (type == "hash") columns = {col("field", "string", true), col("value", "string")};
    else if (type == "list") columns = {col("index", "integer", true), col("value", "string")};
    else if (type == "set") columns = {col("member", "string", true)};
    else if (type == "zset") columns = {col("member", "string", true), col("score", "double")};
    else if (type == "stream") columns = {col("id", "string", true), col("fields", "json")};

    json info{{"type", type}};
    if (ttl.r && ttl.r->type == REDIS_REPLY_INTEGER) info["ttl"] = ttl.r->integer < 0 ? "none" : std::to_string(ttl.r->integer) + "s";
    if (enc.r && enc.r->type == REDIS_REPLY_STRING) info["encoding"] = std::string(enc.r->str, enc.r->len);
    if (mem.r && mem.r->type == REDIS_REPLY_INTEGER) info["memory"] = std::to_string(mem.r->integer) + " bytes";
    return json{{"path", pathJ}, {"columns", columns}, {"indexes", json::array()}, {"info", info}};
  }

  ExecResult execute(const json& req, PageSink& sink, CancelToken& token) override {
    std::vector<std::string> argv = redis::tokenize(req.value("sql", ""));
    if (auto it = req.find("params"); it != req.end() && it->is_array()) {
      for (auto& p : *it) argv.push_back(cellToText(p).value_or(""));
    }
    if (argv.empty()) throw DriverError("BAD_COMMAND", "empty command");
    if (readOnly_ && redis::isWriteCommand(argv)) {
      throw DriverError("READ_ONLY", "This connection is read-only; " + upper(argv[0]) + " is a write command");
    }
    const std::string cmd = upper(argv[0]);
    if (cmd == "SUBSCRIBE" || cmd == "PSUBSCRIBE" || cmd == "SSUBSCRIBE" || cmd == "MONITOR") {
      throw DriverError("UNSUPPORTED", cmd + " is not supported in the query editor");
    }

    ReplyHolder r(command(argv, &token));
    ExecResult result;
    if (r.r->type == REDIS_REPLY_ERROR) throw DriverError("REDIS", std::string(r.r->str, r.r->len));

    auto colsOf = [](std::initializer_list<std::pair<const char*, const char*>> list) {
      json cols = json::array();
      for (auto& [n, t] : list) cols.push_back({{"name", n}, {"type", t}, {"nullable", true}});
      return cols;
    };

    const bool pairs = r.r->type == REDIS_REPLY_MAP || cmd == "HGETALL" || cmd == "CONFIG" ||
                       ((cmd == "ZRANGE" || cmd == "ZREVRANGE" || cmd == "ZRANGEBYSCORE" || cmd == "ZREVRANGEBYSCORE" ||
                         cmd == "ZPOPMIN" || cmd == "ZPOPMAX" || cmd == "ZRANDMEMBER") &&
                        hasArg(argv, "WITHSCORES"));
    if (isAggregate(r.r) && pairs) {
      const bool z = cmd[0] == 'Z';
      sink.columns(z ? colsOf({{"member", "string"}, {"score", "double"}}) : colsOf({{"field", "string"}, {"value", "string"}}));
      for (std::size_t i = 0; i + 1 < r.r->elements; i += 2) {
        json score = scalar(r.r->element[i + 1]);
        if (z && score.is_string()) {
          try {
            score = std::stod(score.get<std::string>());
          } catch (...) {
          }
        }
        sink.row(json::array({scalar(r.r->element[i]), score}));
      }
    } else if (isAggregate(r.r)) {
      bool nested = false;
      for (std::size_t i = 0; i < r.r->elements; ++i) nested = nested || isAggregate(r.r->element[i]);
      sink.columns(colsOf({{"#", "integer"}, {"value", nested ? "json" : "string"}}));
      for (std::size_t i = 0; i < r.r->elements; ++i) {
        sink.row(json::array({static_cast<long long>(i), scalar(r.r->element[i])}));
      }
    } else {
      sink.columns(colsOf({{"value", r.r->type == REDIS_REPLY_INTEGER ? "integer" : "string"}}));
      sink.row(json::array({scalar(r.r)}));
      if (r.r->type == REDIS_REPLY_INTEGER && redis::isWriteCommand(argv)) result.affectedRows = r.r->integer;
    }
    return result;
  }

  json apply(const json& statements, CancelToken& token) override {
    if (readOnly_) throw DriverError("READ_ONLY", "This connection is read-only");
    if (!statements.is_array()) throw DriverError("BAD_REQUEST", "statements must be an array");
    // Each statement is a typed command: {"sql": "HSET", "params": ["key", "field", "value"]}.
    // A full command line in "sql" also works for simple values.
    std::vector<std::vector<std::string>> cmds;
    for (auto& s : statements) {
      std::vector<std::string> argv = redis::tokenize(s.value("sql", ""));
      if (auto it = s.find("params"); it != s.end() && it->is_array()) {
        for (auto& p : *it) argv.push_back(cellToText(p).value_or(""));
      }
      if (argv.empty()) throw DriverError("BAD_COMMAND", "empty command in apply");
      const std::string cmd = upper(argv[0]);
      if (cmd == "MULTI" || cmd == "EXEC" || cmd == "DISCARD" || cmd == "WATCH") {
        throw DriverError("BAD_COMMAND", cmd + " is not allowed inside apply");
      }
      cmds.push_back(std::move(argv));
    }
    appendCommand({"MULTI"});
    for (auto& c : cmds) appendCommand(c);
    appendCommand({"EXEC"});
    ReplyHolder multi(nextReply(&token));
    std::string queueError;
    for (std::size_t i = 0; i < cmds.size(); ++i) {
      ReplyHolder q(nextReply(&token));
      if (q.r->type == REDIS_REPLY_ERROR && queueError.empty()) {
        queueError = "command " + std::to_string(i + 1) + ": " + std::string(q.r->str, q.r->len);
      }
    }
    ReplyHolder exec(nextReply(&token));
    if (!queueError.empty()) throw DriverError("REDIS", queueError + " (transaction discarded)");
    if (exec.r->type == REDIS_REPLY_ERROR) throw DriverError("REDIS", std::string(exec.r->str, exec.r->len));
    if (exec.r->type == REDIS_REPLY_NIL) throw DriverError("REDIS", "transaction aborted");
    std::string runtimeErrors;
    for (std::size_t i = 0; i < exec.r->elements; ++i) {
      const redisReply* e = exec.r->element[i];
      if (e->type == REDIS_REPLY_ERROR) runtimeErrors += "command " + std::to_string(i + 1) + ": " + std::string(e->str, e->len) + "; ";
    }
    // Redis has no rollback: a command that fails at run time doesn't undo the others.
    if (!runtimeErrors.empty()) throw DriverError("REDIS", "some commands failed (others were applied): " + runtimeErrors);
    return json{{"applied", static_cast<int>(cmds.size())}};
  }

 private:
  static bool hasArg(const std::vector<std::string>& argv, const char* arg) {
    for (std::size_t i = 1; i < argv.size(); ++i) {
      if (upper(argv[i]) == arg) return true;
    }
    return false;
  }

  void open() {
    const json& c = opts_.conn;
    std::string host = c.value("host", std::string("127.0.0.1"));
    if (host.empty()) host = "127.0.0.1";
    int port = c.contains("port") && c["port"].is_number() ? c["port"].get<int>() : 6379;
    timeval tv{10, 0};
    redisContext* ctx = redisConnectWithTimeout(host.c_str(), port, tv);
    if (!ctx || ctx->err) {
      std::string msg = ctx ? ctx->errstr : "out of memory";
      if (ctx) redisFree(ctx);
      throw DriverError("CONNECT_FAILED", msg);
    }
    {
      std::lock_guard lock(mu_);
      ctx_ = ctx;
      cancelled_ = false;
    }
    std::string user = c.value("user", std::string());
    if (!opts_.password.empty()) {
      ReplyHolder r(user.empty() ? command({"AUTH", opts_.password}) : command({"AUTH", user, opts_.password}));
      if (r.r->type == REDIS_REPLY_ERROR) throw DriverError("AUTH_FAILED", std::string(r.r->str, r.r->len));
    }
    std::string db;
    if (c.contains("database") && !c["database"].is_null()) db = c["database"].is_string() ? c["database"].get<std::string>() : c["database"].dump();
    if (!db.empty() && db != "0") {
      ReplyHolder r(command({"SELECT", db}));
      if (r.r->type == REDIS_REPLY_ERROR) throw DriverError("REDIS", std::string(r.r->str, r.r->len));
    }
  }

  redisContext* ready() {
    bool reconnect;
    {
      std::lock_guard lock(mu_);
      if (!ctx_) throw DriverError("NOT_CONNECTED", "Not connected");
      reconnect = cancelled_ || ctx_->err;
    }
    if (reconnect) {
      log::info("redis: reconnecting after cancel/error");
      disconnect();
      open();
    }
    return ctx_;
  }

  [[noreturn]] void ioError(CancelToken* token) {
    bool wasCancelled;
    std::string msg;
    {
      std::lock_guard lock(mu_);
      wasCancelled = cancelled_ || (token && token->isCancelled());
      msg = ctx_ && ctx_->err ? ctx_->errstr : "connection lost";
      cancelled_ = true;  // force a reconnect before the next command
    }
    if (wasCancelled) throw DriverError("CANCELLED", "Command cancelled");
    throw DriverError("REDIS_IO", msg);
  }

  redisReply* command(const std::vector<std::string>& argv, CancelToken* token = nullptr) {
    redisContext* ctx = ready();
    std::vector<const char*> args;
    std::vector<size_t> lens;
    for (auto& a : argv) {
      args.push_back(a.data());
      lens.push_back(a.size());
    }
    void* r = redisCommandArgv(ctx, static_cast<int>(args.size()), args.data(), lens.data());
    if (!r) ioError(token);
    return static_cast<redisReply*>(r);
  }

  void appendCommand(const std::vector<std::string>& argv) {
    redisContext* ctx = ready();
    std::vector<const char*> args;
    std::vector<size_t> lens;
    for (auto& a : argv) {
      args.push_back(a.data());
      lens.push_back(a.size());
    }
    if (redisAppendCommandArgv(ctx, static_cast<int>(args.size()), args.data(), lens.data()) != REDIS_OK) ioError(nullptr);
  }

  redisReply* nextReply(CancelToken* token = nullptr) {
    void* r = nullptr;
    if (redisGetReply(ctx_, &r) != REDIS_OK || !r) ioError(token);
    return static_cast<redisReply*>(r);
  }

  std::mutex mu_;
  redisContext* ctx_ = nullptr;
  bool cancelled_ = false;
  bool readOnly_ = false;
  ConnectOptions opts_;
};

}  // namespace

std::unique_ptr<Driver> makeRedisDriver() { return std::make_unique<RedisDriver>(); }

}  // namespace dbui
